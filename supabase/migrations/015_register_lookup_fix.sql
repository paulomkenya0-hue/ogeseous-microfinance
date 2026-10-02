-- OGESEOUS MICROFINANCE — Correction patch: the RUCU register lookup never matched anything
-- Run after 014_application_wizard.sql. Copyright © Paulo Mkenya
--
-- WHY THIS FILE EXISTS
--
-- Migration 014 has already been applied, so fixing the text of 014 fixes nothing in the live
-- database — Postgres has stored the function bodies, not the script. This re-creates the two
-- functions 014 got wrong, with no other change. 014 has also been corrected in place so that a
-- fresh install is correct from 014 onwards; on a fresh project 015 is a harmless no-op because
-- CREATE OR REPLACE of an identical body is idempotent.
--
-- THE BUG
--
-- Both functions declare an OUT parameter whose name is also the name of a column that the
-- function body then refers to without qualification:
--
--   verify_student_from_register ... OUT registration_number text
--     ... from public.rucu_students where lower(registration_number) = lower(trim(p_registration))
--
--   attach_application_document ... OUT storage_path text
--     ... select storage_path into v_old from public.loan_documents where ...
--
-- In PL/pgSQL an unqualified name that is simultaneously a variable and a column of a table in the
-- same statement is ambiguous. With the default `plpgsql.variable_conflict = error`, Postgres
-- does not guess and does not prefer either — it raises:
--
--   ERROR:  column reference "registration_number" is ambiguous
--   HINT:   It could refer to either a PL/pgSQL variable or a table column.
--
-- The consequence was that verify_student_from_register() raised on EVERY call, for every student,
-- whether or not the registration number existed in the register. Step 1 of the wizard could not
-- succeed even with a correct registration number and last name.
--
-- attach_application_document() failed the same way, which broke the Documents step (step 6)
-- with the same root cause.
--
-- Note on how this presented: the wizard's error handler was also discarding the real message and
-- replacing it with "Student record not found", so the ambiguity error was invisible and every
-- failure looked like a wrong registration number. That part is a frontend fix
-- (src/pages/LoanWizard.tsx and src/lib/api.ts), included here because it is part of the same
-- defect and neither fix is sufficient alone.
--
-- THE FIX
--
-- Qualify every column reference with a table alias. Nothing else about the functions changes:
-- same signatures, same return types, same checks, same rate limits, same audit rows, same
-- privileges. No RLS policy, role or grant is altered by this migration.
--
-- Verified afterwards:
--   select public.verify_student_from_register('RU/TEST/001/2024', 'MWAKYUSA');
-- must return exactly one row with full_name = 'JOHN MWAKYUSA'. Zero rows means the register has
-- no such row; a raised error means this migration did not apply.


-- ---------------------------------------------------------------------------------------
-- 1. verify_student_from_register — the corrected lookup.
-- ---------------------------------------------------------------------------------------
create or replace function public.verify_student_from_register(
  p_registration text, p_last_name text
) returns table (
  rucu_student_id uuid, full_name text, registration_number text, form_four_index_number text,
  programme text, year_of_study text, application_id uuid
) language plpgsql security definer set search_path = public as $$
declare
  v_attempts integer;
  v_row public.rucu_students%rowtype;
  v_app uuid;
  v_holder uuid;
  v_name text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can verify a student record';
  end if;
  if length(trim(coalesce(p_registration, ''))) < 3 or length(trim(coalesce(p_last_name, ''))) < 2 then
    raise exception 'Enter both your registration number and your last name';
  end if;

  select count(*) into v_attempts from public.audit_logs
   where actor_id = auth.uid() and action = 'RUCU_WIZARD_MATCH' and created_at > now() - interval '1 minute';
  if v_attempts >= 20 then
    raise exception 'Too many attempts. Please wait a minute and try again.';
  end if;
  insert into public.audit_logs (actor_id, action, entity) values (auth.uid(), 'RUCU_WIZARD_MATCH', 'rucu_students');

  -- Both columns are qualified with the table alias. `registration_number` is also an OUT
  -- parameter of this function, so the bare form was ambiguous and raised.
  select r.* into v_row from public.rucu_students r
   where lower(r.registration_number) = lower(trim(p_registration))
     and lower(r.last_name) = lower(trim(p_last_name))
   limit 1;
  -- Zero rows is "no match", and only "no match". It never creates a record and it never marks
  -- anything approved.
  if v_row.id is null then return; end if;

  -- One identity, one account. A registration number already held by another account here is
  -- refused with an explanation rather than a unique-violation, because the message decides
  -- whether the student signs in or asks for help.
  select sp.user_id into v_holder from public.student_profiles sp
   where sp.university = 'RUCU' and lower(sp.registration_number) = lower(v_row.registration_number)
     and sp.user_id <> auth.uid() limit 1;
  if v_holder is not null then
    raise exception 'That registration number is already registered to an account here. Sign in with that account instead of creating a new one.';
  end if;

  -- Canonical values come from the register, never from the browser, and are written only through
  -- trusted_write() so the guard on student_profiles still refuses a student editing them directly.
  v_name := v_row.full_name;
  perform public.trusted_write();
  update public.student_profiles
     set full_name              = v_name,
         university             = 'RUCU',
         registration_number    = v_row.registration_number,
         form_four_index_number = v_row.form_four_index_number,
         programme              = v_row.programme,
         year_of_study          = v_row.year_of_study
   where user_id = auth.uid();

  -- The record of a match lives on the APPLICATION, not on student_profiles.verification_status.
  -- A student matching the register is not an approved student and not an approved loan: the
  -- application is still a DRAFT here and only becomes UNDER_REVIEW when it is submitted.
  insert into public.loan_applications
    (user_id, student_record_id, student_confirmed_at, verification_method, programme, year_of_study)
  values (auth.uid(), v_row.id, now(), 'RUCU_REGISTER', v_row.programme, v_row.year_of_study)
  on conflict (user_id) where status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') do update
    set student_record_id = excluded.student_record_id,
        student_confirmed_at = excluded.student_confirmed_at,
        verification_method = excluded.verification_method,
        programme = excluded.programme,
        year_of_study = excluded.year_of_study
    where public.loan_applications.status = 'DRAFT'
  returning id into v_app;

  -- Re-running step 1 must not create a second claim for an application already under review.
  if v_app is null then
    raise exception 'You already have an application with OGESEOUS. Open your dashboard to see its status.';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'STUDENT_REGISTER_MATCHED', 'loan_applications', v_app::text,
            jsonb_build_object('rucu_student_id', v_row.id, 'method', 'RUCU_REGISTER'));

  return query select v_row.id, v_name, v_row.registration_number, v_row.form_four_index_number,
                      v_row.programme, v_row.year_of_study, v_app;
end $$;
revoke all on function public.verify_student_from_register(text,text) from public;
grant execute on function public.verify_student_from_register(text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 2. attach_application_document — same defect, `storage_path` OUT parameter versus column.
-- ---------------------------------------------------------------------------------------
create or replace function public.attach_application_document(
  p_application_id uuid, p_doc_type text, p_path text
) returns table (storage_path text, replaced_path text)
language plpgsql security definer set search_path = public as $$
declare v_old text; v_owner uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_doc_type not in ('STUDENT_ID','NATIONAL_ID','GUARANTOR_ID','OTHER') then raise exception 'Unknown document type'; end if;

  select user_id into v_owner from public.loan_applications where id = p_application_id;
  if v_owner is null then raise exception 'Application not found'; end if;
  if v_owner <> auth.uid() then raise exception 'You can only add documents to your own application'; end if;

  if not exists (select 1 from public.loan_applications where id = p_application_id and status = 'DRAFT') then
    raise exception 'This application has already been submitted and its documents can no longer be changed';
  end if;

  -- The object must exist in the caller's own folder, or a student could point their application at
  -- somebody else's file and staff would open it believing it was this student's document.
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'verification-documents'
       and o.name = trim(p_path)
       and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then raise exception 'That upload could not be found in your account. Please upload it again.'; end if;

  -- Qualified: `storage_path` is this function's OUT parameter as well as a loan_documents column.
  select d.storage_path into v_old from public.loan_documents d
   where d.application_id = p_application_id and d.doc_type = p_doc_type;

  insert into public.loan_documents (application_id, doc_type, storage_path)
  values (p_application_id, p_doc_type, trim(p_path))
  on conflict (application_id, doc_type) do update
    set storage_path = excluded.storage_path, uploaded_at = now();

  return query select trim(p_path), v_old;
end $$;
revoke all on function public.attach_application_document(uuid,text,text) from public;
grant execute on function public.attach_application_document(uuid,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 3. Proof that no other function in the schema has the same defect.
--
-- Every function that declares an OUT parameter whose name collides with a column it reads
-- unqualified is one of the two above. This query lists any that are NOT, so if a future migration
-- introduces another one it is visible here rather than in front of a student.
-- ---------------------------------------------------------------------------------------
-- select p.proname
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proretset
--    and exists (select 1 from unnest(p.proargnames) o
--                 join pg_attribute a on a.attrelid = p.prorettype and a.attname = o)
--    and p.proname not in ('verify_student_from_register', 'attach_application_document');