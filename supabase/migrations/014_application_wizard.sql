-- OGESEOUS MICROFINANCE — Migration 014: in-application student verification and the wizard
-- Run after 013_repayment_schedule.sql. Copyright © Paulo Mkenya
--
-- WHY THIS MIGRATION EXISTS
-- ========================
-- The old journey was: sign up -> confirm email -> sign in -> a SEPARATE verification
-- application with three document uploads -> wait for staff -> only then may the student even
-- open the loan form. For a student at RUCU, whose registration number and last name are already
-- in the register OGESEOUS imported, that is three round trips and a wait for a fact the database
-- already held.
--
-- This moves verification INSIDE the loan application and makes the register the authority:
--
--   Step 1  Registration number + last name -> matched against public.rucu_students.
--           On a match the authoritative name, registration number, programme and year of study
--           are copied onto the student's profile and shown READ-ONLY. The student never types
--           them, so they cannot contradict the register.
--           On no match nothing is created. There is deliberately no "create the record for me"
--           path: a failed match must never be able to manufacture a student.
--
--   Steps 2-6  Ordinary form steps, saved as a DRAFT. A draft is invisible to staff and cannot
--           be approved; review_loan_application() only accepts a submitted application.
--
--   Step 7  Review everything, tick the declaration, submit. Only NOW does the application get a
--           tracking number (OGS-YYYY-NNNNNN) and enter review.
--
-- A CRITICAL DISTINCTION, spelled out because the old code conflated it
-- ======================================================================
-- "This student is a real student at this university" and "this loan application is approved" are
-- different questions with different evidence. student_profiles.verification_status is NOT touched
-- by anything in this migration. The wizard records its own fact —
-- loan_applications.student_confirmed_at — meaning only "the student completed step 1 and their
-- identity details are frozen on this application". Staff confirm identity during loan review,
-- which is what a loan officer does anyway. Nothing here approves anything.
--
-- WHY 014 AND NOT AN EDIT TO 013
-- =============================
-- 013 was already applied to the database, so it is left alone. This is a new file, in order.
--
-- EVERY STATEMENT HERE IS RE-RUNNABLE. The SQL editor runs each statement in its own
-- transaction, so a failure part-way through leaves the statements before it committed — without
-- these guards, running the file again dies on "already exists" and you cannot tell how far it got.
--
-- TWO THINGS THIS MIGRATION REFUSES TO INVENT
-- ===========================================
--   TODO(OGESEOUS): guarantor_required and required_application_documents below are DEFAULTS, not
--   decisions. They are ordinary app_settings rows, so a manager changes them from /admin/settings
--   without touching SQL. Confirm them before a real student is turned away by a document rule
--   that nobody actually agreed to.
-- =====================================================================================


-- ---------------------------------------------------------------------------------------
-- 1. Wider status vocabulary.
--
-- ACTION_REQUIRED and COMPLETED are added. The old list had no way to say "come back with more",
-- which is the single most common outcome of a real assessment and the one a student most needs
-- to be able to see. NOT_APPLIED is deliberately NOT a stored status — it is the absence of an
-- application, and storing it would mean every student has a row before they have applied.
--
-- CLOSED is kept: it is the existing terminal state and 013/AdminLoanApplications already use it.
-- ---------------------------------------------------------------------------------------
alter table public.loan_applications drop constraint if exists loan_applications_status_check;
alter table public.loan_applications
  add constraint loan_applications_status_check
  check (status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED','APPROVED','REJECTED','DISBURSED','COMPLETED','CLOSED'));


-- ---------------------------------------------------------------------------------------
-- 2. Programme and year of study on the register.
--
-- These are what step 1 displays, so they belong on the register row that is authoritative for
-- them, not on the student's profile where a student could also have typed them. Nullable, and no
-- values are invented: import_rucu_students() can now carry them, and an operator can backfill
-- them in one UPDATE when the source spreadsheet has the columns.
-- ---------------------------------------------------------------------------------------
alter table public.rucu_students add column if not exists programme text;
alter table public.rucu_students add column if not exists year_of_study text;

-- Carry the two new columns through the bulk import. Same signature and same return type
-- (integer), so this is a plain CREATE OR REPLACE.
create or replace function public.import_rucu_students(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer := 0; r jsonb;
begin
  if not public.is_admin() then raise exception 'Only admins can import the student register'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.rucu_students (form_four_index_number, registration_number, last_name, full_name, programme, year_of_study, imported_by)
    values (trim(r->>'form_four_index_number'), trim(r->>'registration_number'), trim(r->>'last_name'), trim(r->>'full_name'),
            nullif(trim(coalesce(r->>'programme','')), ''), nullif(trim(coalesce(r->>'year_of_study','')), ''), auth.uid())
    on conflict (form_four_index_number, registration_number)
      do update set last_name = excluded.last_name, full_name = excluded.full_name,
                    programme = excluded.programme, year_of_study = excluded.year_of_study;
    v_count := v_count + 1;
  end loop;
  insert into public.audit_logs (actor_id, action, entity, metadata) values (auth.uid(), 'RUCU_IMPORT', 'rucu_students', jsonb_build_object('rows', v_count));
  return v_count;
end $$;
revoke all on function public.import_rucu_students(jsonb) from public;
grant execute on function public.import_rucu_students(jsonb) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 3. Contact and emergency details on the profile.
--
-- These are student-EDITABLE and so are NOT added to guard_protected_columns(): a student must be
-- able to correct a phone number or a next-of-kin. They are written through save_application_contact()
-- rather than a direct UPDATE anyway, so the validation lives in one server-side place and the
-- same rules apply whether the call comes from the wizard or anywhere else.
-- ---------------------------------------------------------------------------------------
alter table public.student_profiles add column if not exists address text;
alter table public.student_profiles add column if not exists emergency_contact_name text;
alter table public.student_profiles add column if not exists emergency_contact_relationship text;
alter table public.student_profiles add column if not exists emergency_contact_phone text;
-- Mirrored from the register match so the application can show it without a join on every read.
alter table public.student_profiles add column if not exists programme text;
alter table public.student_profiles add column if not exists year_of_study text;


-- ---------------------------------------------------------------------------------------
-- 4. Everything step 1 to step 7 of the wizard collects, on the application itself.
--
-- Stored on loan_applications rather than in a side table because each of these is 1:1 with the
-- application and is meaningless without it. Documents go in their own table (section 5) because
-- there is more than one per application.
-- ---------------------------------------------------------------------------------------
alter table public.loan_applications
  add column if not exists student_record_id uuid references public.rucu_students(id),
  add column if not exists student_confirmed_at timestamptz,
  add column if not exists verification_method text
    check (verification_method is null or verification_method in ('RUCU_REGISTER','SELF_DECLARED')),
  add column if not exists programme text,
  add column if not exists year_of_study text,
  -- financial
  add column if not exists monthly_income numeric(12,2) check (monthly_income is null or monthly_income >= 0),
  add column if not exists income_source text,
  add column if not exists monthly_expenses numeric(12,2) check (monthly_expenses is null or monthly_expenses >= 0),
  add column if not exists has_financial_support boolean,
  add column if not exists support_amount numeric(12,2) check (support_amount is null or support_amount > 0),
  add column if not exists support_source text,
  -- guarantor
  add column if not exists guarantor_full_name text,
  add column if not exists guarantor_relationship text,
  add column if not exists guarantor_phone text,
  add column if not exists guarantor_national_id text,
  add column if not exists guarantor_address text,
  -- what the student is being asked for when status is ACTION_REQUIRED
  add column if not exists action_required_note text;

create index if not exists applications_by_status
  on public.loan_applications (status, submitted_at desc);
create index if not exists applications_by_user
  on public.loan_applications (user_id, created_at desc);
-- Public tracking looks applications up by number; it already has a unique index, but this makes
-- the staff-side search by number cheap as well.
create index if not exists applications_tracking_lookup
  on public.loan_applications (application_number) where application_number is not null;


-- ---------------------------------------------------------------------------------------
-- 5. Documents, and the history of the application.
-- ---------------------------------------------------------------------------------------
create table if not exists public.loan_documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.loan_applications(id) on delete cascade,
  doc_type text not null check (doc_type in ('STUDENT_ID','NATIONAL_ID','GUARANTOR_ID','OTHER')),
  storage_path text not null,
  uploaded_at timestamptz not null default now(),
  unique (application_id, doc_type)
);
create index if not exists loan_documents_application_idx on public.loan_documents (application_id);

alter table public.loan_documents enable row level security;
-- Writes go through attach_application_document() only — there is deliberately no insert or
-- update policy, so a student cannot point a row at somebody else's file.
drop policy if exists "owner or staff read application documents" on public.loan_documents;
create policy "owner or staff read application documents" on public.loan_documents
  for select using (
    exists (select 1 from public.loan_applications la where la.id = application_id
             and (la.user_id = auth.uid()
                  or exists (select 1 from public.users u where u.id = auth.uid()
                    and u.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE'))));

create table if not exists public.application_status_history (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.loan_applications(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references public.users(id),
  actor_role public.user_role,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists application_history_idx
  on public.application_status_history (application_id, created_at);

alter table public.application_status_history enable row level security;
drop policy if exists "owner or staff read application history" on public.application_status_history;
create policy "owner or staff read application history" on public.application_status_history
  for select using (
    exists (select 1 from public.loan_applications la where la.id = application_id
             and (la.user_id = auth.uid()
                  or exists (select 1 from public.users u where u.id = auth.uid()
                    and u.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE'))));
-- No write policy. Every row is written by a security-definer function, which is what makes the
-- history trustworthy: there is no code path a student or a compromised browser can add to it.


-- ---------------------------------------------------------------------------------------
-- 6. One open application per student, across every status that is still open.
--
-- The old index was on status in ('DRAFT','SUBMITTED'). With the wizard there is no longer a
-- SUBMITTED state that matters — submission goes straight to UNDER_REVIEW — so without this a
-- student in ACTION_REQUIRED could open a second application and staff would be reviewing two
-- claims from one person. APPROVED/DISBURSED/REJECTED/COMPLETED/CLOSED stay outside it, which is
-- what lets a rejected student apply again on the SAME account instead of being pushed into a
-- duplicate one.
-- ---------------------------------------------------------------------------------------
drop index if exists public.one_open_application_per_student;
create unique index one_open_application_per_student on public.loan_applications (user_id)
  where status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED');


-- ---------------------------------------------------------------------------------------
-- 7. Business rules as settings, not constants.
-- ---------------------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('guarantor_required', 'true'),
  ('required_application_documents', 'STUDENT_ID,NATIONAL_ID,GUARANTOR_ID')
on conflict (key) do nothing;

-- The literal inside coalesce() is the SAME list the INSERT above installs, and that is not a
  -- coincidence. If the settings row were ever deleted, this fallback and the frontend's would
  -- have to agree or a student would be told they were finished and then refused at submit for a
  -- document the form never asked for. One value, written down in both places on purpose.
create or replace function public.required_document_types() returns text[]
language sql stable as $$
  select coalesce(array(
    select upper(btrim(t))
    from unnest(string_to_array(coalesce(nullif(trim((select value from public.app_settings where key = 'required_application_documents')), ''),
                                        'STUDENT_ID,NATIONAL_ID,GUARANTOR_ID'), ',')) as btrim(t)
    where btrim(t) in ('STUDENT_ID','NATIONAL_ID','GUARANTOR_ID','OTHER')
    order by 1), '{}'::text[]);
$$;
-- Every new function is EXECUTE to PUBLIC until it is revoked, which is why the codebase revokes
-- and re-grants on all eighteen of them without exception.
revoke all on function public.required_document_types() from public;
grant execute on function public.required_document_types() to authenticated;

create or replace function public.guarantor_is_required() returns boolean
language sql stable as $$
  select lower(coalesce(nullif(trim((select value from public.app_settings where key = 'guarantor_required')), ''), 'true')) = 'true';
$$;
revoke all on function public.guarantor_is_required() from public;
grant execute on function public.guarantor_is_required() to authenticated;

-- 011's loan_policy() gains two columns, which changes its row type, and Postgres cannot change a
-- return type with CREATE OR REPLACE (42P13). Drop first. The grants are reapplied below.
drop function if exists public.loan_policy();

create or replace function public.loan_policy()
returns table (
  min_amount numeric, max_amount numeric,
  periods integer[], requires_verification boolean,
  max_active_loans integer, annual_interest_rate numeric, interest_convention text,
  guarantor_required boolean, required_documents text[], purposes text[], income_sources text[]
) language sql security definer set search_path = public stable as $$
  select
    public.setting_num('min_loan_amount', 0),
    public.setting_num('max_loan_amount', 0),
    public.allowed_repayment_months(),
    -- Still true: a student must be confirmed on the application before it can be submitted.
    -- What changed is WHERE that happens, not WHETHER it is required.
    true,
    public.setting_num('max_active_loans_per_student', 1)::int,
    greatest(public.setting_num('annual_interest_rate', 0), 0),
    upper(coalesce(nullif(trim((select value from public.app_settings where key = 'interest_convention')), ''), 'NONE')),
    public.guarantor_is_required(),
    public.required_document_types(),
    -- Every loan purpose the database will accept, so the dropdown cannot offer a value the
    -- CHECK constraint then rejects. 011 added 'OTHER' with a mandatory description.
    array['TUITION_FEES','ACCOMMODATION','FOOD_LIVING','BOOKS_AND_MATERIALS','BUSINESS','OTHER']::text[],
    -- TODO(OGESEOUS): the income sources below are a starting list, not an agreed one. They are
    -- free text on the form and are only listed here so the wizard can offer them as suggestions.
    array['SALARIED','SELF_EMPLOYED','BUSINESS','FAMILY','SCHOLARSHIP','OTHER']::text[];
$$;
revoke all on function public.loan_policy() from public;
grant execute on function public.loan_policy() to authenticated;

-- 'FOOD_LIVING' and 'BUSINESS' are not in the CHECK that 011 installed.
alter table public.loan_applications drop constraint if exists loan_applications_purpose_check;
alter table public.loan_applications
  add constraint loan_applications_purpose_check
  check (purpose in ('TUITION_FEES','ACCOMMODATION','FOOD_LIVING','BOOKS_AND_MATERIALS','BUSINESS','OTHER'));
alter table public.loan_applications
  drop constraint if exists loan_applications_purpose_other_check;
alter table public.loan_applications
  add constraint loan_applications_purpose_other_check
  check ((purpose = 'OTHER') = (purpose_other is not null and length(trim(purpose_other)) >= 3));


-- ---------------------------------------------------------------------------------------
-- 8. Step 1 for a RUCU student: match registration number AND last name against the register.
--
-- BOTH fields must match. The old search_rucu_student() matched the Form Four index number AND
-- (registration OR last name), which is a different question and remains available for the manual
-- verification route. A last name on its own is not enough here, and neither is a registration
-- number on its own — a shared surname would otherwise hand one student another student's record.
--
-- Zero rows means "no match". It never means "create one".
--
-- The rate limit is counted in audit_logs for the same reason as search_rucu_student(): a limit a
-- client can forget is not a limit, and a burst of register probes is exactly what the audit trail
-- exists to make visible. 20 a minute is far above what one student needs.
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

  select * into v_row from public.rucu_students
   where lower(registration_number) = lower(trim(p_registration))
     and lower(last_name) = lower(trim(p_last_name))
   limit 1;
  if v_row.id is null then return; end if;   -- zero rows: the UI shows "record not found"

  -- One identity, one account. Caught here rather than as a unique-violation, because the message
  -- a student gets decides whether they sign in or ask for help.
  select sp.user_id into v_holder from public.student_profiles sp
   where sp.university = 'RUCU' and lower(sp.registration_number) = lower(v_row.registration_number)
     and sp.user_id <> auth.uid() limit 1;
  if v_holder is not null then
    raise exception 'That registration number is already registered to an account here. Sign in with that account instead of creating a new one.';
  end if;

  -- Canonical values come from the register, never from the browser.
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

  -- A student whose application is already UNDER_REVIEW cannot start another one by re-running
  -- step 1; send them to track it instead of silently creating a second claim.
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
-- 9. Step 1 for everyone else.
--
-- Mkwawa College and Iringa University have no register here, so there is nothing to match
-- against and a staff member confirms identity during loan review instead — which is the normal
-- job of the person assessing the application. This records what the student declared; it asserts
-- nothing. A RUCU student can use this too when the register genuinely has no row for them, which
-- is why it does not refuse the RUCU code outright: refusing would leave that student with no way
-- to apply at all, and the office would rather see the application and correct the register.
--
-- The authoritative detail this writes is guarded by guard_protected_columns(), which is why it
-- needs the trusted_write() marker rather than a widened permission.
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
-- 10. Steps 2 and 4 — loan details and financial information, saved to the draft.
--
-- TWO functions, not one, and that split is the point. The wizard reaches step 2 before it knows
-- anything about income, and step 4 before it knows anything about a guarantor. A single combined
-- function would have to either demand every field on every call — so "Save and continue" on the
-- amount field would refuse because the student had not yet reached the income step — or treat a
-- missing argument as "leave it alone", which cannot distinguish "not asked yet" from "the student
-- deliberately cleared it". Splitting means each function validates exactly the group it writes, so
-- clearing your income is as easy as entering it.
--
-- Neither touches the other's columns, so a student who enters an amount, goes to step 4, types
-- their income and then presses BACK to fix the amount keeps everything they typed in between.
--
-- save_loan_application_draft() is left alone: it is the older four-argument entry point and
-- redefining it here with a different meaning would make the two paths disagree about what a
-- draft is. This is a separate function for the wizard's richer payload, and both write the same
-- table through the same partial unique index, so a student cannot end up with two open
-- applications by using one and then the other.
-- ---------------------------------------------------------------------------------------
create or replace function public.save_application_loan(
  p_amount numeric, p_purpose text, p_purpose_other text, p_repayment_months integer
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_min numeric; v_max numeric; v_months integer[];
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;

  select id into v_id from public.loan_applications
   where user_id = auth.uid() and status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') limit 1;
  if v_id is null then
    raise exception 'Start your application first — confirm your student details before entering loan details';
  end if;
  if not exists (select 1 from public.loan_applications where id = v_id and student_confirmed_at is not null) then
    raise exception 'Confirm your student details first';
  end if;

  if p_purpose not in ('TUITION_FEES','ACCOMMODATION','FOOD_LIVING','BOOKS_AND_MATERIALS','BUSINESS','OTHER') then
    raise exception 'Invalid purpose';
  end if;
  -- A blank OTHER is refused rather than stored as NULL, because an application nobody can act on
  -- is worse than one that will not submit.
  if p_purpose = 'OTHER' and length(trim(coalesce(p_purpose_other, ''))) < 3 then
    raise exception 'Describe what the loan is for';
  end if;

  v_months := public.allowed_repayment_months();
  if coalesce(array_length(v_months, 1), 0) = 0 then raise exception 'No repayment periods are configured'; end if;
  if p_repayment_months is null or not (p_repayment_months = any (v_months)) then raise exception 'Invalid repayment period'; end if;

  v_min := public.setting_num('min_loan_amount', 0);
  v_max := public.setting_num('max_loan_amount', 0);
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount you need'; end if;
  if p_amount < v_min or p_amount > v_max then
    raise exception 'Loan amount (%) is outside the permitted range (%) to (%)', p_amount, v_min, v_max;
  end if;

  update public.loan_applications
     set amount = p_amount,
         purpose = p_purpose,
         purpose_other = case when p_purpose = 'OTHER' then nullif(trim(coalesce(p_purpose_other, '')), '') else null end,
         repayment_period_months = p_repayment_months
   where id = v_id and status = 'DRAFT';

  if not found then
    raise exception 'This application has already been submitted and can no longer be edited here';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id)
    values (auth.uid(), 'LOAN_DRAFT_SAVED', 'loan_applications', v_id::text);
  return v_id;
end $$;
revoke all on function public.save_application_loan(numeric,text,text,integer) from public;
grant execute on function public.save_application_loan(numeric,text,text,integer) to authenticated;


create or replace function public.save_application_financial(
  p_monthly_income numeric, p_income_source text, p_monthly_expenses numeric,
  p_has_support boolean, p_support_amount numeric, p_support_source text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;

  select id into v_id from public.loan_applications
   where user_id = auth.uid() and status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') limit 1;
  if v_id is null then
    raise exception 'Start your application first — confirm your student details before entering your finances';
  end if;

  if p_monthly_income is null or p_monthly_income < 0 then raise exception 'Enter your monthly income'; end if;
  if length(trim(coalesce(p_income_source, ''))) < 2 then raise exception 'Tell us where your income comes from'; end if;
  if p_monthly_expenses is null or p_monthly_expenses < 0 then raise exception 'Enter your monthly expenses'; end if;
  if coalesce(p_has_support, false) then
    if p_support_amount is null or p_support_amount <= 0 then raise exception 'Enter how much support you receive'; end if;
    if length(trim(coalesce(p_support_source, ''))) < 2 then raise exception 'Tell us who provides that support'; end if;
  end if;

  update public.loan_applications
     set monthly_income = p_monthly_income,
         income_source = nullif(trim(coalesce(p_income_source, '')), ''),
         monthly_expenses = p_monthly_expenses,
         has_financial_support = coalesce(p_has_support, false),
         support_amount = case when coalesce(p_has_support, false) then p_support_amount else null end,
         support_source = case when coalesce(p_has_support, false) then nullif(trim(coalesce(p_support_source, '')), '') else null end
   where id = v_id and status = 'DRAFT';

  if not found then
    raise exception 'This application has already been submitted and can no longer be edited here';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id)
    values (auth.uid(), 'LOAN_DRAFT_SAVED', 'loan_applications', v_id::text);
  return v_id;
end $$;
revoke all on function public.save_application_financial(numeric,text,numeric,boolean,numeric,text) from public;
grant execute on function public.save_application_financial(numeric,text,numeric,boolean,numeric,text) to authenticated;



-- ---------------------------------------------------------------------------------------
-- 11. Step 5 — the guarantor.
-- ---------------------------------------------------------------------------------------
create or replace function public.save_application_guarantor(
  p_full_name text, p_relationship text, p_phone text, p_national_id text, p_address text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;

  select id into v_id from public.loan_applications
   where user_id = auth.uid() and status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') limit 1;
  if v_id is null then raise exception 'Start your application first'; end if;

  if public.guarantor_is_required() then
    if length(trim(coalesce(p_full_name, ''))) < 3 then raise exception 'Enter your guarantor''s full name'; end if;
    if length(trim(coalesce(p_relationship, ''))) < 2 then raise exception 'State your relationship to the guarantor'; end if;
    if coalesce(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '') < 9 then
      raise exception 'Enter a phone number we can reach the guarantor on';
    end if;
    if length(trim(coalesce(p_national_id, ''))) < 5 then raise exception 'Enter the guarantor''s National ID number'; end if;
    if length(trim(coalesce(p_address, ''))) < 5 then raise exception 'Enter the guarantor''s address'; end if;
  else
    -- Not required: record whatever was entered, validate nothing beyond a length cap.
    p_full_name := left(trim(coalesce(p_full_name, '')), 200);
    p_relationship := left(trim(coalesce(p_relationship, '')), 80);
    p_national_id := left(trim(coalesce(p_national_id, '')), 80);
    p_address := left(trim(coalesce(p_address, '')), 400);
  end if;

  update public.loan_applications
     set guarantor_full_name = nullif(trim(coalesce(p_full_name, '')), ''),
         guarantor_relationship = nullif(trim(coalesce(p_relationship, '')), ''),
         guarantor_phone = nullif(trim(coalesce(p_phone, '')), ''),
         guarantor_national_id = nullif(trim(coalesce(p_national_id, '')), ''),
         guarantor_address = nullif(trim(coalesce(p_address, '')), '')
   where id = v_id and status = 'DRAFT';
  if not found then raise exception 'This application has already been submitted and can no longer be edited here'; end if;

  return v_id;
end $$;
revoke all on function public.save_application_guarantor(text,text,text,text,text) from public;
grant execute on function public.save_application_guarantor(text,text,text,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 12. Step 3 — contact details.
--
-- One function rather than a direct table UPDATE so the validation is in one place. These columns
-- are deliberately NOT in guard_protected_columns(): a student must be able to fix a typo in their
-- own phone number without an administrator.
-- ---------------------------------------------------------------------------------------
create or replace function public.save_application_contact(
  p_phone text, p_address text,
  p_emergency_name text, p_emergency_relationship text, p_emergency_phone text
) returns void language plpgsql security definer set search_path = public as $$
declare v_digits text;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;

  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_digits) < 9 then raise exception 'Enter a phone number we can reach you on'; end if;
  if length(trim(coalesce(p_address, ''))) < 3 then raise exception 'Enter your current address'; end if;

  -- Phone and address are required because something in the system depends on them: public
  -- tracking proves identity with the phone number on the account, so an account without one
  -- cannot be tracked by anyone but its owner.
  --
  -- The emergency contact is COLLECTED but not required. It is validated when it is filled in, and
  -- requiring it would be inventing a rule OGESEOUS has not stated. If it becomes a rule, make it
  -- one:
  --   if lower(coalesce(nullif(trim((select value from public.app_settings
  --        where key = 'emergency_contact_required')), ''), 'false')) = 'true'
  --      and length(trim(coalesce(p_emergency_name, ''))) < 3 then ...
  -- Nothing below rejects a student for leaving it blank.
  if length(trim(coalesce(p_emergency_name, ''))) > 0
     or length(trim(coalesce(p_emergency_phone, ''))) > 0
     or length(trim(coalesce(p_emergency_relationship, ''))) > 0 then
    if length(trim(coalesce(p_emergency_name, ''))) < 3 then
      raise exception 'Enter your emergency contact''s full name, or clear the field';
    end if;
    if length(trim(coalesce(p_emergency_relationship, ''))) < 2 then
      raise exception 'State your relationship to your emergency contact';
    end if;
    if length(regexp_replace(coalesce(p_emergency_phone, ''), '[^0-9]', '', 'g')) < 9 then
      raise exception 'Enter your emergency contact''s phone number';
    end if;
  end if;

  update public.student_profiles
     set phone = trim(p_phone),
         address = nullif(trim(p_address), ''),
         emergency_contact_name = case when length(trim(coalesce(p_emergency_name,''))) >= 3
                                       then trim(p_emergency_name) else null end,
         emergency_contact_relationship = case when length(trim(coalesce(p_emergency_name,''))) >= 3
                                       then nullif(trim(p_emergency_relationship), '') else null end,
         emergency_contact_phone = case when length(trim(coalesce(p_emergency_name,''))) >= 3
                                       then nullif(trim(p_emergency_phone), '') else null end
   where user_id = auth.uid();
end $$;
revoke all on function public.save_application_contact(text,text,text,text,text) from public;
grant execute on function public.save_application_contact(text,text,text,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 13. Step 6 — attach a document.
--
-- The path must resolve to a real object inside this student's own folder. Without that check a
-- student could store somebody else's file path on their application and staff would open it,
-- believing it was this student's document.
--
-- Returns the path it replaced, so the caller can delete the superseded object — otherwise every
-- re-upload of the same document leaves an orphan in the bucket.
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

  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'verification-documents'
       and o.name = trim(p_path)
       and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then raise exception 'That upload could not be found in your account. Please upload it again.'; end if;

  select storage_path into v_old from public.loan_documents
   where application_id = p_application_id and doc_type = p_doc_type;

  insert into public.loan_documents (application_id, doc_type, storage_path)
  values (p_application_id, p_doc_type, trim(p_path))
  on conflict (application_id, doc_type) do update
    set storage_path = excluded.storage_path, uploaded_at = now();

  return query select trim(p_path), v_old;
end $$;
revoke all on function public.attach_application_document(uuid,text,text) from public;
grant execute on function public.attach_application_document(uuid,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 14. Submission.
--
-- Returns a DIFFERENT row type from the version in 005, so this needs the 42P13 drop first.
--
-- The number is OGS-YYYY-NNNNNN, built from the existing sequence. The sequence is shared with
-- the old OGE- format on purpose: one sequence means one monotonic counter, so a number can never
-- be issued twice even though the two formats differ.
--
-- status goes straight to UNDER_REVIEW. There is no intermediate SUBMITTED state a reviewer has
-- to pick up, because "submitted" and "waiting for review" are the same fact and having both
-- meant a reviewer had to click something before a queue was a queue.
--
-- The `and status = 'DRAFT'` in the UPDATE is the double-click guard: a second click matches no
-- row and raises, instead of generating a second number.
-- ---------------------------------------------------------------------------------------
drop function if exists public.submit_loan_application(uuid,boolean);

create or replace function public.submit_loan_application(p_id uuid, p_terms_accepted boolean)
returns table (application_number text, status text, submitted_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_row public.loan_applications%rowtype;
  v_num text;
  v_token text;
  v_missing text[];
  v_required text[];
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not coalesce(p_terms_accepted, false) then
    raise exception 'You must confirm the information is correct before submitting';
  end if;

  select * into v_row from public.loan_applications where id = p_id for update;
  if v_row.id is null or v_row.user_id <> auth.uid() then raise exception 'Application not found'; end if;
  if v_row.status <> 'DRAFT' then
    raise exception 'This application has already been submitted';
  end if;

  if v_row.student_confirmed_at is null then
    raise exception 'Confirm your student details before submitting';
  end if;
  if v_row.submitted_at is not null then raise exception 'This application has already been submitted'; end if;

  if v_row.amount is null or v_row.purpose is null or v_row.repayment_period_months is null then
    raise exception 'Your loan details are incomplete';
  end if;
  if v_row.monthly_income is null or v_row.monthly_expenses is null then
    raise exception 'Your financial information is incomplete';
  end if;
  -- Phone and address are enforced HERE, at submission, and not only in the wizard.
  --
  -- Public tracking proves identity with the phone number on the account, so an application whose
  -- owner has no phone number is one that nobody but its owner can ever track — a receipt that
  -- silently never works. The wizard already refuses step 3 without them, so this cannot fire in
  -- normal use; it exists so the rule survives somebody calling the RPC directly, or a future
  -- change to the wizard that forgets the check.
  if length(regexp_replace(coalesce((select sp.phone from public.student_profiles sp
                                      where sp.user_id = v_row.user_id), ''),
                           '[^0-9]', '', 'g')) < 9 then
    raise exception 'Add a phone number on your account before submitting — it is how you track this application';
  end if;
  if length(trim(coalesce((select sp.address from public.student_profiles sp
                            where sp.user_id = v_row.user_id), ''))) < 3 then
    raise exception 'Add your current address before submitting';
  end if;
  if public.guarantor_is_required() and coalesce(trim(v_row.guarantor_full_name), '') = '' then
    raise exception 'Your guarantor''s details are required';
  end if;

  v_required := public.required_document_types();
  select coalesce(array_agg(t order by t), '{}'::text[]) into v_missing
    from unnest(v_required) t
   where not exists (select 1 from public.loan_documents d
                      where d.application_id = p_id and d.doc_type = t);
  if array_length(v_missing, 1) > 0 then
    raise exception 'Please upload: %', array_to_string(v_missing, ', ');
  end if;

  v_num := 'OGS-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.application_number_seq')::text, 6, '0');
  -- The QR verification token is kept, deliberately: /verify already existed, and lets somebody
  -- holding a printed copy check that it is genuine. Regenerated on every submission, so a number
  -- lifted off an old receipt cannot be replayed against a fresh application.
  v_token := encode(gen_random_bytes(12), 'hex');

  update public.loan_applications
     set status = 'UNDER_REVIEW', terms_accepted = true, terms_accepted_at = now(), submitted_at = now(),
         application_number = v_num, verification_token = v_token
   where id = p_id and status = 'DRAFT';
  if not found then raise exception 'This application has already been submitted'; end if;

  insert into public.application_status_history (application_id, from_status, to_status, actor_id, actor_role, note)
    values (p_id, 'DRAFT', 'UNDER_REVIEW', auth.uid(), 'STUDENT', 'Submitted by the student');
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_SUBMITTED', 'loan_applications', p_id::text,
            jsonb_build_object('application_number', v_num, 'amount', v_row.amount));

  return query select v_num, 'UNDER_REVIEW'::text, now();
end $$;
revoke all on function public.submit_loan_application(uuid,boolean) from public;
grant execute on function public.submit_loan_application(uuid,boolean) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 15. Review, extended with ACTION_REQUIRED and writing history.
--
-- Same signature and same return type as 006's version (void), so CREATE OR REPLACE is enough.
-- Two things change beyond the new decision:
--   * a student may move their own application from ACTION_REQUIRED back to UNDER_REVIEW by
--     resubmitting, so the decision list is filtered against the status the application is in;
--   * every transition is written to application_status_history, which is what makes the student's
--     "Last updated / what happened" view truthful instead of inferred.
-- ---------------------------------------------------------------------------------------
create or replace function public.review_loan_application(p_id uuid, p_decision text, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_from text; v_to text;
begin
  if not exists (select 1 from public.users where id = auth.uid()
                 and role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only loan officers, managers or super admins can review applications';
  end if;
  if p_decision not in ('UNDER_REVIEW','ACTION_REQUIRED','APPROVED','REJECTED') then raise exception 'Invalid decision'; end if;
  if p_decision = 'REJECTED' and length(trim(coalesce(p_notes, ''))) < 3 then
    raise exception 'Please give a reason for the rejection — the student is shown it';
  end if;
  if p_decision = 'ACTION_REQUIRED' and length(trim(coalesce(p_notes, ''))) < 3 then
    raise exception 'Please say what the student needs to provide — they are shown it';
  end if;

  select status into v_from from public.loan_applications where id = p_id;
  if v_from is null then raise exception 'Application not found'; end if;
  if v_from not in ('SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') then
    raise exception 'This application is % and cannot be reviewed further', v_from;
  end if;
  v_to := p_decision;

  update public.loan_applications
     set status = v_to,
         reviewed_by = auth.uid(), reviewed_at = now(),
         review_notes = nullif(trim(coalesce(p_notes, '')), ''),
         action_required_note = case when v_to = 'ACTION_REQUIRED' then nullif(trim(coalesce(p_notes, '')), '')
                                    when v_to = 'UNDER_REVIEW' then null when v_to = 'APPROVED' then null else action_required_note end
   where id = p_id;

  insert into public.application_status_history (application_id, from_status, to_status, actor_id, actor_role, note)
    values (p_id, v_from, v_to, auth.uid(),
            (select role::public.user_role from public.users where id = auth.uid()),
            nullif(trim(coalesce(p_notes, '')), ''));
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_' || v_to, 'loan_applications', p_id::text, jsonb_build_object('notes', p_notes));
end $$;
revoke all on function public.review_loan_application(uuid,text,text) from public;
grant execute on function public.review_loan_application(uuid,text,text) to authenticated;

-- A student in ACTION_REQUIRED has to be able to get their application moving again, or the status
-- is a dead end. Resubmitting re-enters review and clears the outstanding request.
create or replace function public.resubmit_application(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_from text;
begin
  select status into v_from from public.loan_applications where id = p_id and user_id = auth.uid();
  if v_from is null then raise exception 'Application not found'; end if;
  if v_from <> 'ACTION_REQUIRED' then raise exception 'There is nothing to resubmit'; end if;

  update public.loan_applications
     set status = 'UNDER_REVIEW', action_required_note = null, reviewed_at = now()
   where id = p_id and status = 'ACTION_REQUIRED';
  insert into public.application_status_history (application_id, from_status, to_status, actor_id, actor_role, note)
    values (p_id, 'ACTION_REQUIRED', 'UNDER_REVIEW', auth.uid(), 'STUDENT', 'Student provided what was requested');
  insert into public.audit_logs (actor_id, action, entity, entity_id)
    values (auth.uid(), 'LOAN_APPLICATION_RESUBMITTED', 'loan_applications', p_id::text);
end $$;
revoke all on function public.resubmit_application(uuid) from public;
grant execute on function public.resubmit_application(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 16. Status history, for the student and for staff.
-- ---------------------------------------------------------------------------------------
create or replace function public.get_application_history(p_id uuid)
returns table (from_status text, to_status text, note text, actor_name text, actor_role text, created_at timestamptz)
language sql security definer set search_path = public stable as $$
  select h.from_status, h.to_status, h.note, u.full_name, h.actor_role::text, h.created_at
  from public.application_status_history h
  left join public.student_profiles u on u.user_id = h.actor_id
  where h.application_id = p_id
    and exists (select 1 from public.loan_applications la where la.id = p_id
                 and (la.user_id = auth.uid()
                      or exists (select 1 from public.users su where su.id = auth.uid()
                        and su.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN') and su.status = 'ACTIVE')));
$$;
revoke all on function public.get_application_history(uuid) from public;
grant execute on function public.get_application_history(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 17. Public tracking.
--
-- Application number PLUS the phone number on the account: two things a person holding only a
-- screenshot does not have. What comes back is deliberately thin — status, dates, initials, and
-- how many documents are still outstanding. NOT returned: the amount, the full name, the
-- registration number, the university, the purpose, the guarantor, any document path. Someone who
-- guesses a valid application number still learns nothing without also knowing the phone.
--
-- Granted to anon because the page is public, so this is the one function in the schema where the
-- caller is not authenticated. That is also why the rate limit is global rather than per-user:
-- there is no account to count it against.
--
-- VOLATILE, not STABLE, because it writes an audit row. A STABLE function is one Postgres
-- promises performs no writes, and a statement function marked STABLE that inserts raises
-- "INSERT is not allowed in a non-volatile function" at CREATE time.
-- ---------------------------------------------------------------------------------------
create or replace function public.track_application(p_number text, p_phone text)
returns table (
  application_number text, status text, submitted_at timestamptz, updated_at timestamptz,
  masked_name text, action_required boolean, documents_needed integer
) language plpgsql security definer set search_path = public as $$
declare
  v_calls integer;
  v_owner uuid;
  v_name text;
  v_number text;
begin
  v_calls := (select count(*) from public.audit_logs
               where action = 'PUBLIC_TRACKING' and created_at > now() - interval '1 minute');
  if v_calls >= 120 then
    raise exception 'Too many lookups from this network. Please wait a minute and try again.';
  end if;
  insert into public.audit_logs (action, entity) values ('PUBLIC_TRACKING', 'loan_applications');

  -- Resolve the application ONCE, to a single (owner, number). Matching on the student's name
  -- instead would be wrong in a way that is easy to miss: two students can share a name, and a
  -- name is not the key. v_owner is the key, and it comes from the row that satisfied BOTH the
  -- number and the phone.
  select la.user_id, la.application_number, sp.full_name
    into v_owner, v_number, v_name
    from public.loan_applications la
    join public.student_profiles sp on sp.user_id = la.user_id
    join public.users u on u.id = la.user_id
   where la.application_number is not null
     and upper(trim(la.application_number)) = upper(trim(coalesce(p_number, '')))
     -- Compared on the last nine digits so 0755…, +255755… and 255755… are all the same number,
     -- which is how people actually type them.
     and length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) >= 9
     and right(regexp_replace(coalesce(sp.phone, u.phone, ''), '[^0-9]', '', 'g'), 9)
       = right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 9)
   limit 1;

  -- No match, or the caller guessed: zero rows. The page says so and shows nothing else.
  if v_owner is null then return; end if;

  return query
  select v_number, la.status, la.submitted_at, la.updated_at,
         -- Initials only, derived here rather than returned as a stored column so a masked value
         -- and a full value can never disagree.
         upper(left(v_name, 1)
               || left((string_to_array(v_name, ' '))[array_length(string_to_array(v_name, ' '), 1)], 1)),
         (la.status = 'ACTION_REQUIRED'),
         (select count(*)::integer from public.required_document_types() t
           where not exists (select 1 from public.loan_documents d
                              where d.application_id = la.id and d.doc_type = t))
    from public.loan_applications la
   where la.user_id = v_owner
     and la.application_number = v_number;
end $$;
revoke all on function public.track_application(text,text) from public;
grant execute on function public.track_application(text,text) to anon, authenticated;


-- ---------------------------------------------------------------------------------------
-- 18. Staff can read a student's uploaded documents.
--
-- 002's read policy is "your own folder, or is_admin()" and is_admin() is MANAGER/SUPER_ADMIN. A
-- LOAN_OFFICER could therefore open an application, see that a guarantor ID was attached, and be
-- unable to open it — while being the one person whose job it is to assess it. This extends the
-- read policy to exactly the roles that can already read the application row, so the two agree.
--
-- The test is "is this object an attached document of some application" rather than "is the folder
-- named after a user with an open application". Casting the folder segment to uuid would raise on
-- a hand-crafted object name and take the whole policy down with it; matching on the joined path
-- cannot, and is a narrower permission anyway — the reviewer reads the documents, not the
-- student's whole folder.
-- ---------------------------------------------------------------------------------------
drop policy if exists "application reviewers read documents" on storage.objects;
create policy "application reviewers read documents" on storage.objects for select to authenticated
  using (bucket_id = 'verification-documents'
         and exists (select 1 from public.users u where u.id = auth.uid()
              and u.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE')
         and exists (select 1
                       from public.loan_documents d
                       join public.loan_applications la on la.id = d.application_id
                      where d.storage_path = name
                        and la.user_id::text = (storage.foldername(name))[1]));


-- ---------------------------------------------------------------------------------------
-- 19. delete_my_account(): restated because the ON DELETE CASCADE from public.users now has far
--     more to take with it (loan_documents rows, the wizard columns).
--
--     The STUDENT-only check is load-bearing and is NOT optional. It was in 013's version and
--     dropping it would have let any member of staff delete their own account — and, for a
--     SUPER_ADMIN, possibly the last one. The explicit profile delete is redundant with the
--     cascade and is kept only so the intent is legible.
-- ---------------------------------------------------------------------------------------
drop function if exists public.delete_my_account();
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT') then
    raise exception 'Only student accounts can be deleted here. Contact OGESEOUS to close a staff account.';
  end if;
  if exists (select 1 from public.loans where user_id = auth.uid()) then
    raise exception 'You have a loan on record with OGESEOUS, so your account cannot be deleted. Please settle it or contact us.';
  end if;

  insert into public.audit_logs (actor_id, action, entity) values (auth.uid(), 'ACCOUNT_DELETED', 'users');
  delete from public.users where id = auth.uid();
end $$;
revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------------------
-- 20. One applicant's identity and contact details, for whoever is reviewing their application.
--
--     This exists because of a real gap rather than for convenience. student_profiles carries the
--     only copy of a student's phone number and address, and migration 001's only read policy on it
--     is "own profile read" — user_id = auth.uid() or is_admin(). is_admin() is MANAGER and
--     SUPER_ADMIN. So a LOAN_OFFICER, who is exactly the person who opens an application to review
--     it, cannot read the applicant's name, phone or address at all. Every other staff role with an
--     interest in collections is in the same position.
--
--     The narrowest fix is preferred over widening the policy: loosening student_profiles would
--     hand a loan officer the full contact details of every student who has ever signed up,
--     including the many who never applied and never will. This function hands over one applicant,
--     and only to an active member of staff.
--
--     SECURITY DEFINER because it must cross the RLS boundary above. STABLE because it writes
--     nothing. It reads no document path and no financial figure — those already have their own
--     gates (section 18 for the objects, and loan_applications' own policy for the rows).
-- ---------------------------------------------------------------------------------------
create or replace function public.application_student_detail(p_application_id uuid)
returns table (
  user_id uuid, full_name text, phone text, address text, university text,
  registration_number text, form_four_index_number text, programme text, year_of_study text,
  emergency_contact_name text, emergency_contact_relationship text, emergency_contact_phone text,
  email text, role public.user_role, account_status public.user_status
) language sql security definer set search_path = public stable as $$
  select p.user_id, p.full_name, p.phone, p.address, p.university,
         p.registration_number, p.form_four_index_number, p.programme, p.year_of_study,
         p.emergency_contact_name, p.emergency_contact_relationship, p.emergency_contact_phone,
         u.email, u.role, u.status
  from public.loan_applications a
  join public.student_profiles p on p.user_id = a.user_id
  join public.users u on u.id = a.user_id
  where a.id = p_application_id
    and exists (select 1 from public.users s
                 where s.id = auth.uid()
                   and s.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MARKETING_OFFICER','MANAGER','SUPER_ADMIN')
                   and s.status = 'ACTIVE');
$$;
revoke all on function public.application_student_detail(uuid) from public;
grant execute on function public.application_student_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Remediation queries, for AFTER this migration has run. Read them; they change nothing.
--
-- A. Applications that exist but were never confirmed under the wizard. Each needs the student's
--    details confirmed, or the application closed.
--      select id, application_number, status, user_id, created_at
--        from public.loan_applications
--       where student_confirmed_at is null and status <> 'DRAFT';
--
-- B. Backfill programme and year of study from a source export, if OGESEOUS has one:
--      update public.rucu_students r
--         set programme = s.programme, year_of_study = s.year_of_study
--        from (values ('<index>','<programme>','<year>')) as s(index, programme, year_of_study)
--       where r.form_four_index_number = s.index;
--
-- C. Submitted applications still sitting in the old SUBMITTED state, which the wizard no longer
--    uses. Move them into the review queue:
--      update public.loan_applications set status = 'UNDER_REVIEW' where status = 'SUBMITTED';
--      insert into public.application_status_history (application_id, from_status, to_status, note)
--      select id, 'SUBMITTED', 'UNDER_REVIEW', 'Migrated from the pre-wizard flow' from public.loan_applications
--       where status = 'UNDER_REVIEW';
-- ---------------------------------------------------------------------------------------
