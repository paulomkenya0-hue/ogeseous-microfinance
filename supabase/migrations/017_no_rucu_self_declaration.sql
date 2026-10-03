-- OGESEOUS MICROFINANCE — RUCU details can no longer be self-declared
-- Run after 016_phone_signup.sql. Copyright © Paulo Mkenya
--
-- WHY THIS MIGRATION IS NECESSARY
--
-- Step 1 of the wizard now asks which university the student attends and branches on the answer:
-- Ruaha Catholic University means the RUCU register lookup, anything else means the student types
-- their own details. That is a change to the form, and the form is not the security boundary in
-- this application — RLS and these SECURITY DEFINER functions are.
--
-- public.declare_application_student() accepts p_university in ('RUCU','MKWAWA','IU') and writes
-- student_profiles.university straight from it. So before this migration any signed-in student could
-- call the function directly from the browser console with p_university = 'RUCU', pass a name and
-- registration number of their own choosing, and get:
--
--   - student_profiles.university = 'RUCU' with values the RUCU register never confirmed
--   - verification_method = 'SELF_DECLARED', so the application looked declared rather than matched
--   - a DRAFT application created, with an audit row recording STUDENT_DECLARED
--
-- public.rucu_students is never read on that path. The one authoritative check in the system had a
-- route around it that needed no privilege escalation, only the ordinary execute grant every student
-- already has.
--
-- WHAT CHANGES
--
-- One added check inside declare_application_student(): p_university = 'RUCU' now raises. Everything
-- else is byte-for-byte the function 014 created — same signature, same return type, same role and
-- status check, same duplicate-registration guard, same trusted_write() marker, same
-- student_profiles update, same DRAFT application, same audit row, same revoke and grant.
--
-- WHAT DOES NOT CHANGE
--
--   - RUCU students are not worse off. verify_student_from_register() is untouched and still
--     writes their authoritative fields, including programme and year of study, which a
--     declaration could never supply.
--   - MKWAWA and IU are unaffected. Neither has a register with OGESEOUS, and declaring those
--     details is exactly what the function is for.
--   - No RLS policy, role, grant or table is changed. No row is created, modified or deleted by
--     this file — it changes what a function will accept, not what exists.
--   - Applications already in progress are untouched. A student who had legitimately declared
--     MKWAWA or IU details keeps them and can carry on.
--
-- ALREADY-APPLIED DATABASES
--
-- If any student has already declared university = 'RUCU' by self-declaration, this migration does
-- not clean that up on purpose: the fix belongs in the rows, and which rows are wrong is a decision
-- for OGESEOUS, not a side effect of a schema change. Section 2 below lists them so they can be
-- reviewed by hand.


-- ---------------------------------------------------------------------------------------
-- 1. The corrected function.
-- ---------------------------------------------------------------------------------------
create or replace function public.declare_application_student(
  p_university text, p_full_name text, p_registration text, p_form_four_index text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_app uuid;
  v_holder uuid;
  v_name text := trim(coalesce(p_full_name, ''));
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply for a loan';
  end if;
  if p_university not in ('RUCU','MKWAWA','IU') then raise exception 'Please choose your university'; end if;
  if p_university = 'RUCU' then
    raise exception 'Ruaha Catholic University students are checked against the RUCU register. Use the register lookup rather than entering your details yourself.';
  end if;
  if length(v_name) < 3 then raise exception 'Enter your full name as it appears on your registration'; end if;
  if length(trim(coalesce(p_registration, ''))) < 3 then raise exception 'Enter your registration number'; end if;
  if length(trim(coalesce(p_form_four_index, ''))) < 3 then raise exception 'Enter your Form Four Index Number'; end if;

  select sp.user_id into v_holder from public.student_profiles sp
   where sp.university = p_university and lower(sp.registration_number) = lower(trim(p_registration))
     and sp.user_id <> auth.uid() limit 1;
  if v_holder is not null then
    raise exception 'That registration number is already registered to an account here. Sign in with that account instead of creating a new one.';
  end if;

  perform public.trusted_write();
  update public.student_profiles
     set full_name = v_name, university = p_university,
         registration_number = trim(p_registration),
         form_four_index_number = trim(p_form_four_index)
   where user_id = auth.uid();

  insert into public.loan_applications
    (user_id, student_confirmed_at, verification_method)
  values (auth.uid(), now(), 'SELF_DECLARED')
  on conflict (user_id) where status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') do update
    set student_confirmed_at = excluded.student_confirmed_at,
        verification_method = excluded.verification_method
    where public.loan_applications.status = 'DRAFT'
  returning id into v_app;
  if v_app is null then
    raise exception 'You already have an application with OGESEOUS. Open your dashboard to see its status.';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'STUDENT_DECLARED', 'loan_applications', v_app::text,
            jsonb_build_object('method', 'SELF_DECLARED', 'university', p_university));
  return v_app;
end $$;

revoke all on function public.declare_application_student(text,text,text,text) from public;
grant execute on function public.declare_application_student(text,text,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 2. Confirm the change took effect, and look for rows that need attention by hand.
--
-- Run these after applying.
-- ---------------------------------------------------------------------------------------

-- 2a. The declaration now refuses RUCU. Run this as a signed-in STUDENT:
--
--       select declare_application_student('RUCU', 'ANY NAME', 'ANY/REG/001', 'ANY/INDEX/1');
--
--     Expected: the error above. If it returns an application id instead, this migration did not
--     apply and the self-declaration path is still open.
--
--     MKWAWA and IU must still work. Run the same statement with p_university = 'MKWAWA' and then
--     'IU'. Expected: both return an application id. If either raises "Please choose your
--     university", the NOT IN list was altered by mistake.

-- 2b. Students who claimed RUCU by self-declaration before this migration. These are the rows that
--     the closed path could have created. Expected: zero rows on a database that was never
--     exploited; a short list otherwise, each needing a decision from OGESEOUS.
select sp.user_id, sp.full_name, sp.registration_number, la.status, la.verification_method
from public.student_profiles sp
left join public.loan_applications la on la.user_id = sp.user_id
where sp.university = 'RUCU' and coalesce(la.verification_method, '') <> 'RUCU_REGISTER';

-- 2c. An RUCU student whose details DO match the register. Expected: these are the legitimate
--     ones, produced by verify_student_from_register, and they must all be RUCU_REGISTER.
select sp.user_id, sp.full_name, r.full_name as register_name,
       sp.registration_number, r.registration_number as register_registration
from public.student_profiles sp
join public.rucu_students r
  on lower(trim(r.registration_number)) = lower(trim(sp.registration_number))
 and lower(trim(r.last_name)) = lower(trim(sp.full_name))
where sp.university = 'RUCU';