-- OGESEOUS MICROFINANCE — Security hardening (fixes the defects found in the Steps 1-11 review)
-- Run after 010_fixes.sql. Copyright © Paulo Mkenya
--
-- This migration closes the following defects. Each is a correctness or security hole that was
-- present in 001-010 and is NOT reachable through the app's own UI — it needs a crafted API call
-- (the browser, curl and PostgREST are all the same thing to RLS).
--
--   1. submit_verification() COULD NEVER SUCCEED. 001's guard_protected_columns() trigger blocks
--      any change to student_profiles.verification_status, and it fires inside 010's
--      SECURITY DEFINER submit_verification() too, because auth.uid() still returns the student's
--      id inside a definer function (it reads the JWT session GUC, not current_user). Every
--      student submission therefore died with 'Not allowed to change verification status'.
--      Fixed by introducing an explicit trusted-write marker that only our own server-side
--      functions can set.
--   2. A student could overwrite their own VERIFIED identity. The "own profile update" policy
--      lets a student UPDATE any column of their student_profiles row, and the guard only
--      protected verification_status. A single API call could rewrite full_name, university,
--      registration_number and form_four_index_number while keeping status = 'VERIFIED' — which
--      defeated 010's "the name comes from the register, not the browser" guarantee and printed
--      the forged values onto the application PDF and the public /verify page.
--      Fixed by extending the guard to cover every identity column.
--   3. Nothing stopped one real student from holding several verified accounts. There was no
--      uniqueness on identity, so the same (university, registration number) pair could be
--      verified on N different accounts, each eligible for its own loan.
--      Fixed with a partial unique index.
--   4. No ceiling on loan amount, anywhere. The only limits were numeric(12,2) and amount > 0.
--      Fixed with a configurable business setting, enforced in the database.
--   5. purpose = 'OTHER' did not require purpose_other, so the RPC accepted a null description.
--      Fixed with a CHECK constraint.
--   6. Mobile-money / bank references were not unique, so the same real-world payment could be
--      recorded twice and the double-count was undetectable. Fixed with a partial unique index.
--   7. review_verification() did not check the request's current status, so an already-reviewed
--      request could be re-decided — including downgrading a VERIFIED student (who may already
--      hold a live loan) to REJECTED. Fixed with a state guard.
--   8. The verification-documents bucket had no MIME allowlist and no delete policy. The 5MB
--      limit in src/pages/Verify.tsx is client-side only and was trivially bypassed, and a
--      student could never delete their own uploaded documents.
--
-- CHANGE 3 AFFECTS EXISTING DATA: this migration REFUSES TO RUN if two accounts already share a
-- (university, registration number) pair. The error message names the offending pairs. Resolve
-- them first (see the remediation query at the bottom of this file), then re-run.
--
-- REVIEW THIS LINE BY LINE BEFORE IT HANDLES REAL MONEY.


-- ---------------------------------------------------------------------------------------
-- 0. Trusted-write marker.
--
-- A SECURITY DEFINER function must be able to write the columns the guard protects, but nothing
-- else may. The marker is a transaction-local GUC: set_config(..., true) is scoped to the current
-- transaction and resets automatically, so it cannot leak into a later request.
--
-- This is safe because an authenticated client cannot set an arbitrary custom GUC — PostgREST
-- exposes no way to run set_config(). Only a SECURITY DEFINER function of ours can, and every
-- call site is listed below and in 012/013.
-- ---------------------------------------------------------------------------------------
create or replace function public.trusted_write() returns void
language plpgsql as $$
begin
  perform set_config('app.trusted_write', 'on', true);
end $$;

create or replace function public.in_trusted_write() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.trusted_write', true), '') = 'on';
$$;


-- ---------------------------------------------------------------------------------------
-- 1 + 2. The guard, fixed.
--
-- is_admin() alone is NOT enough to lift the guard: a definer function runs as its owner, so a
-- blanket "current_user is trusted" test would also open the door to any future definer function
-- that nobody re-reads. The marker is explicit and per-call-site.
--
-- Students keep full control of their own phone number and profile photo. Everything that
-- identifies them to the university is server-managed only.
-- ---------------------------------------------------------------------------------------
create or replace function public.guard_protected_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() or public.in_trusted_write() then
    return new;
  end if;

  if tg_table_name = 'users' then
    if new.role <> old.role or new.status <> old.status then
      raise exception 'Not allowed to change role or status';
    end if;
    if new.id <> old.id or new.email <> old.email or new.created_at <> old.created_at then
      raise exception 'Not allowed to change id, email or created_at';
    end if;
  end if;

  if tg_table_name = 'student_profiles' then
    if new.verification_status <> old.verification_status then
      raise exception 'Not allowed to change verification status';
    end if;
    -- Verified identity. These are written only by submit_verification() (from the RUCU register
    -- for RUCU, or from the student's own submission for manual universities, which staff then
    -- review) and are never editable afterwards.
    if new.full_name is distinct from old.full_name
       or new.university is distinct from old.university
       or new.registration_number is distinct from old.registration_number
       or new.form_four_index_number is distinct from old.form_four_index_number then
      raise exception 'Not allowed to change verified identity details. Contact OGESEOUS to correct them.';
    end if;
    if new.id is distinct from old.id or new.user_id is distinct from old.user_id
       or new.created_at is distinct from old.created_at then
      raise exception 'Not allowed to change id, user_id or created_at';
    end if;
  end if;

  return new;
end $$;


-- ---------------------------------------------------------------------------------------
-- 3. One verified identity per account.
--
-- Refuse to run rather than silently skip, so the duplicate-accounts hole cannot survive a
-- "successful" deployment. See the remediation query at the bottom of this file.
-- ---------------------------------------------------------------------------------------
do $$
declare v_dupes text;
begin
  select string_agg(d, ', ' order by d) into v_dupes
  from (
    select university || '/' || registration_number as d
    from public.student_profiles
    where university is not null and registration_number is not null
    group by university, registration_number
    having count(*) > 1
  ) x;
  if v_dupes is not null then
    raise exception
      'Refusing to create the identity uniqueness index: these university/registration pairs are already held by more than one account: %. Resolve each duplicate first (see the remediation query at the bottom of 011_security_hardening.sql), then re-run this migration.',
      left(v_dupes, 500);
  end if;
end $$;

create unique index one_identity_per_account
  on public.student_profiles (university, registration_number)
  where university is not null and registration_number is not null;


-- ---------------------------------------------------------------------------------------
-- 4. Configurable business limits.
--
-- These are settings, not magic numbers, so the business can change them from /admin/settings
-- without another migration. Seeded with values that are SAFE but NOT YET CONFIRMED by
-- OGESEOUS — see the TODO block. Change them before going live.
--
--   TODO(OGESEOUS): confirm max_loan_amount, min_loan_amount and max_active_loans_per_student
--   with the business. annual_interest_rate MUST be set together with the interest convention
--   (see 013_installments.sql) and, in Tanzania, confirmed as compliant before it is non-zero.
-- ---------------------------------------------------------------------------------------
create table public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id)
);

insert into public.app_settings (key, value) values
  ('min_loan_amount',              '50000'),
  ('max_loan_amount',              '5000000'),
  ('max_active_loans_per_student', '1'),
  ('annual_interest_rate',         '0'),
  ('allowed_repayment_months',     '6,12,18,24'),
  ('institution_name',             'OGESEOUS Microfinance'),
  ('institution_email',            ''),
  ('institution_phone',            ''),
  ('institution_address',          '')
on conflict (key) do nothing;

create trigger trg_settings_touch before update on public.app_settings
  for each row execute function public.touch_updated_at();

alter table public.app_settings enable row level security;
create policy "admins read settings" on public.app_settings
  for select using (public.is_admin());

-- Numeric read with a fallback, so a missing or malformed setting can never crash a money path.
create or replace function public.setting_num(p_key text, p_default numeric) returns numeric
language sql stable as $$
  select coalesce(
    (select nullif(trim(value), '')::numeric from public.app_settings where key = p_key),
    p_default);
$$;

-- Admins write settings through this function so the change is audited. Never a direct UPDATE:
-- that is what RLS is for, and there is deliberately no update policy.
create or replace function public.set_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.users where id = auth.uid()
                 and role in ('SUPER_ADMIN','MANAGER') and status = 'ACTIVE') then
    raise exception 'Only managers or super admins can change settings';
  end if;
  if length(trim(p_value)) > 500 then raise exception 'Setting value is too long'; end if;
  insert into public.app_settings (key, value, updated_by, updated_at)
  values (p_key, trim(p_value), auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'SETTING_CHANGED', 'app_settings', p_key, jsonb_build_object('value', trim(p_value)));
end $$;
revoke all on function public.set_setting(text,text) from public;
grant execute on function public.set_setting(text,text) to authenticated;

-- Allowed repayment periods, so the UI and the database cannot drift apart.
create or replace function public.allowed_repayment_months() returns integer[]
language sql stable as $$
  select array(
    select btrim(m)::int
    from unnest(string_to_array(public.setting_num('allowed_repayment_months', 24)::text, ',')) as btrim(m)
    where btrim(m) ~ '^[0-9]{1,3}$' and btrim(m)::int between 1 and 120
    order by 1);
$$;

-- What the loan form should offer, read by /student/apply.
--
-- Without this the form either hard-codes limits that the database then contradicts, or says
-- nothing and shows a student a raw Postgres message like "Loan amount (9000000) is outside the
-- permitted range (50000) to (5000000)" when they could have been told the range up front.
-- Readable by any signed-in user; it exposes no business data beyond what the form shows anyway.
create or replace function public.loan_policy()
returns table (
  min_amount numeric, max_amount numeric,
  periods integer[], requires_verification boolean,
  max_active_loans integer, annual_interest_rate numeric, interest_convention text
) language sql security definer set search_path = public stable as $$
  select
    public.setting_num('min_loan_amount', 0),
    public.setting_num('max_loan_amount', 0),
    public.allowed_repayment_months(),
    true,
    public.setting_num('max_active_loans_per_student', 1)::int,
    greatest(public.setting_num('annual_interest_rate', 0), 0),
    upper(coalesce(nullif(trim((select value from public.app_settings where key = 'interest_convention')), ''), 'NONE'));
$$;
revoke all on function public.loan_policy() from public;
grant execute on function public.loan_policy() to authenticated;


-- ---------------------------------------------------------------------------------------
-- 5. purpose = 'OTHER' must carry a description.
-- ---------------------------------------------------------------------------------------
alter table public.loan_applications drop constraint if exists loan_applications_purpose_check;
alter table public.loan_applications
  add constraint loan_applications_purpose_check
  check ((purpose = 'OTHER') = (purpose_other is not null and length(trim(purpose_other)) >= 3));

-- Redefined so the description is cleared when the purpose is not OTHER. Without this the new
-- CHECK would reject a legitimate call that sent a stale purpose_other along with, say,
-- TUITION_FEES.
create or replace function public.save_loan_application_draft(
  p_amount numeric, p_purpose text, p_purpose_other text, p_repayment_months integer
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_min numeric; v_max numeric; v_months integer[];
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;
  if not exists (select 1 from public.student_profiles where user_id = auth.uid() and verification_status = 'VERIFIED') then
    raise exception 'Complete student verification before applying for a loan';
  end if;
  if p_purpose not in ('TUITION_FEES','ACCOMMODATION','BOOKS_AND_MATERIALS','OTHER') then raise exception 'Invalid purpose'; end if;

  v_months := public.allowed_repayment_months();
  if coalesce(array_length(v_months, 1), 0) = 0 then raise exception 'No repayment periods are configured'; end if;
  if p_repayment_months is null or not (p_repayment_months = any (v_months)) then raise exception 'Invalid repayment period'; end if;

  v_min := public.setting_num('min_loan_amount', 0);
  v_max := public.setting_num('max_loan_amount', 0);
  if p_amount is null or p_amount < v_min or p_amount > v_max then
    raise exception 'Loan amount (%) is outside the permitted range (%) to (%)', p_amount, v_min, v_max;
  end if;

  insert into public.loan_applications (user_id, amount, purpose, purpose_other, repayment_period_months)
  values (auth.uid(), p_amount, p_purpose,
          case when p_purpose = 'OTHER' then nullif(trim(coalesce(p_purpose_other, '')), '') else null end,
          p_repayment_months)
  on conflict (user_id) where status in ('DRAFT','SUBMITTED') do update
    set amount = excluded.amount, purpose = excluded.purpose, purpose_other = excluded.purpose_other,
        repayment_period_months = excluded.repayment_period_months
    where public.loan_applications.status = 'DRAFT'
  returning id into v_id;

  if v_id is null then raise exception 'This application has already been submitted and can no longer be edited here'; end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id)
  values (auth.uid(), 'LOAN_DRAFT_SAVED', 'loan_applications', v_id::text);
  return v_id;
end $$;
revoke all on function public.save_loan_application_draft(numeric,text,text,integer) from public;
grant execute on function public.save_loan_application_draft(numeric,text,text,integer) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 6. A mobile-money or bank reference identifies one real-world payment, so it must not repeat.
--
-- Scoped to MOBILE_MONEY and BANK_TRANSFER on purpose: cash collections have no reference, and
-- staff do sometimes write "N/A" for cash. Blocking that would break the cash workflow to
-- protect against a duplicate that cash cannot have in the first place.
-- ---------------------------------------------------------------------------------------
create unique index repayments_reference_uniq
  on public.repayments (lower(btrim(reference)))
  where reference is not null and btrim(reference) <> ''
    and method in ('MOBILE_MONEY','BANK_TRANSFER');


-- ---------------------------------------------------------------------------------------
-- 7. review_verification(): only a PENDING request may be decided, and only once.
--
-- 002's version had no state check, so a VERIFIED student who already holds a live loan could be
-- silently downgraded to REJECTED, leaving the profile and the loan disagreeing.
--
-- Re-submission after a rejection is still fine: one_open_request_per_student only covers PENDING
-- and VERIFIED, and the rejection does not clear the profile's identity columns, so the same
-- student resubmitting updates their own existing row and does not collide with
-- one_identity_per_account.
-- ---------------------------------------------------------------------------------------
create or replace function public.review_verification(p_request_id uuid, p_decision text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not public.is_admin() then raise exception 'Only admins can review verification requests'; end if;
  if p_decision not in ('VERIFIED','REJECTED') then raise exception 'Invalid decision'; end if;
  if p_decision = 'REJECTED' and length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Please give the student a reason for the rejection';
  end if;

  select user_id into v_user from public.verification_requests
    where id = p_request_id and status = 'PENDING';
  if v_user is null then raise exception 'Request not found or has already been reviewed'; end if;

  perform public.trusted_write();
  update public.verification_requests
    set status = p_decision::public.request_status,
        rejection_reason = case when p_decision = 'REJECTED' then trim(p_reason) else null end,
        reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_request_id;
  update public.student_profiles set verification_status = p_decision::public.verification_status
    where user_id = v_user;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'VERIFICATION_' || p_decision, 'verification_requests', p_request_id::text,
          jsonb_build_object('reason', p_reason));
end $$;
revoke all on function public.review_verification(uuid,text,text) from public;
grant execute on function public.review_verification(uuid,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- submit_verification(): 010's body, unchanged in behaviour, plus the trusted-write marker so
-- the guard lets it through. The register checks, the document checks and the profile population
-- are all exactly as 010 defined them — only the marker is new.
-- ---------------------------------------------------------------------------------------
create or replace function public.submit_verification(
  p_university text, p_method text, p_registration text, p_index text, p_full_name text,
  p_rucu_student_id uuid, p_certificate_url text, p_id_document_url text, p_passport_url text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_row public.rucu_students%rowtype;
  v_reg text;
  v_index text;
  v_full text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can submit verification';
  end if;
  if p_university not in ('RUCU','MKWAWA','IU') then raise exception 'Invalid university'; end if;
  if p_method not in ('RUCU_AUTO','MANUAL') then raise exception 'Invalid verification method'; end if;
  if (p_university = 'RUCU') <> (p_method = 'RUCU_AUTO') then
    raise exception 'Invalid verification method for this university';
  end if;

  if p_university = 'RUCU' then
    if p_rucu_student_id is null then
      raise exception 'No matching RUCU record was provided';
    end if;
    select * into v_row from public.rucu_students where id = p_rucu_student_id;
    if v_row.id is null then
      raise exception 'No matching record found in the RUCU database. Check your details or contact OGESEOUS.';
    end if;
    if lower(trim(p_index)) <> lower(v_row.form_four_index_number) then
      raise exception 'Form Four Index Number does not match the RUCU record';
    end if;
    if lower(trim(p_registration)) <> lower(v_row.registration_number) then
      raise exception 'Registration Number does not match the RUCU record';
    end if;
    v_index  := v_row.form_four_index_number;
    v_reg    := v_row.registration_number;
    v_full   := v_row.full_name;
  else
    if p_rucu_student_id is not null then
      raise exception 'Register match details cannot be supplied for manual verification';
    end if;
    v_index  := trim(p_index);
    v_reg    := trim(p_registration);
    v_full   := trim(p_full_name);
    if length(v_full) < 3 then raise exception 'Please enter your full name'; end if;
    if v_index = '' or v_reg = '' then raise exception 'Registration number and Form Four Index Number are both required'; end if;
  end if;

  if coalesce(trim(p_certificate_url), '') = '' or coalesce(trim(p_id_document_url), '') = ''
     or coalesce(trim(p_passport_url), '') = '' then
    raise exception 'All three documents are required';
  end if;

  -- Documents must live in this student's own folder, or the path stored here is a pointer to
  -- somebody else's file (or to nothing at all). 002 accepted any string.
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'verification-documents'
      and o.name = trim(p_certificate_url)
      and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then raise exception 'The Form Four certificate upload could not be found in your account'; end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'verification-documents'
      and o.name = trim(p_id_document_url)
      and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then raise exception 'The identity document upload could not be found in your account'; end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'verification-documents'
      and o.name = trim(p_passport_url)
      and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then raise exception 'The passport photo upload could not be found in your account'; end if;

  insert into public.verification_requests
    (user_id, university, method, registration_number, form_four_index_number, full_name_provided,
     rucu_student_id, form_four_certificate_url, identity_document_url, passport_photo_url)
  values (auth.uid(), p_university, p_method::public.verification_method, v_reg, v_index, v_full,
          p_rucu_student_id, trim(p_certificate_url), trim(p_id_document_url), trim(p_passport_url))
  returning id into v_id;

  -- Populate the profile. 010 fixed the blank-profile bug but this could never run; see the
  -- trusted_write() marker above.
  perform public.trusted_write();
  update public.student_profiles
    set verification_status    = 'PENDING',
        university             = p_university,
        registration_number    = v_reg,
        form_four_index_number = v_index,
        full_name              = v_full
    where user_id = auth.uid();

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'VERIFICATION_SUBMITTED', 'verification_requests', v_id::text,
            jsonb_build_object('method', p_method, 'university', p_university,
                               'rucu_student_id', p_rucu_student_id));
  return v_id;
end $$;
revoke all on function public.submit_verification(text,text,text,text,text,uuid,text,text,text) from public;
grant execute on function public.submit_verification(text,text,text,text,text,uuid,text,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 8. Storage: MIME allowlist, size cap and a delete policy.
--
-- The 5MB limit in the browser was the only limit and was trivially bypassed. Supabase applies
-- allowed_mime_types and file_size_limit server-side on upload.
--
-- The bucket columns only exist on reasonably recent Supabase projects, so this is guarded: on an
-- older project the bucket is left as-is and the client-side checks still apply. Do not rely on
-- that in production — upgrade the project.
-- ---------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    update storage.buckets
      set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','application/pdf'],
          file_size_limit    = 5242880
      where id = 'verification-documents';
  else
    raise warning 'storage.buckets.allowed_mime_types is unavailable on this project; the 5MB/MIME checks remain client-side only. Upgrade the Supabase project.';
  end if;
end $$;

create policy "own folder delete" on storage.objects for delete to authenticated
  using (bucket_id = 'verification-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "admins delete documents" on storage.objects for delete to authenticated
  using (bucket_id = 'verification-documents' and public.is_admin());

-- Rate-limit the RUCU register search. search_rucu_student() accepts any authenticated user and
-- returned a full register row on a match, so it could be used to enumerate the whole student
-- body one guessed last name at a time. 30 attempts a minute is far above what the UI needs.
-- Redefined as plpgsql so the rate limit runs inside the search itself rather than depending on
-- the browser remembering to call it first. A limit a client can forget is not a limit.
--
-- The limit is counted in audit_logs, which is where every rate-limited action belongs anyway:
-- a burst of RUCU searches from one account is exactly the kind of thing the audit trail exists to
-- make visible. 30 a minute is far above what the verification form needs for a real student.
create or replace function public.search_rucu_student(
  p_index text, p_registration text default null, p_lastname text default null
) returns table (id uuid, full_name text, registration_number text, form_four_index_number text)
language plpgsql security definer set search_path = public as $$
declare v_attempts integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select count(*) into v_attempts from public.audit_logs
   where actor_id = auth.uid()
     and action = 'RUCU_SEARCH'
     and created_at > now() - interval '1 minute';
  if v_attempts >= 30 then
    raise exception 'Too many search attempts. Please wait a minute and try again.';
  end if;
  insert into public.audit_logs (actor_id, action, entity) values (auth.uid(), 'RUCU_SEARCH', 'rucu_students');

  return query
    select r.id, r.full_name, r.registration_number, r.form_four_index_number
    from public.rucu_students r
    where lower(r.form_four_index_number) = lower(trim(coalesce(p_index, '')))
      and (
        (p_registration is not null and btrim(p_registration) <> ''
          and lower(r.registration_number) = lower(trim(p_registration)))
        or
        (p_lastname is not null and btrim(p_lastname) <> ''
          and lower(r.last_name) = lower(trim(p_lastname)))
      )
    limit 1;
end $$;
revoke all on function public.search_rucu_student(text,text,text) from public;
grant execute on function public.search_rucu_student(text,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- Reports must not count reversed repayments. 012 adds the reversal columns; define the column
-- here so 009's totals can be corrected in the same pass, and 013 rebuilds the rest.
-- ---------------------------------------------------------------------------------------
alter table public.repayments add column if not exists reversed_at timestamptz;
alter table public.repayments add column if not exists reversed_by uuid references public.users(id);
alter table public.repayments add column if not exists reversal_reason text;
-- A reversal must carry a reason. Plain repayments stay unaffected.
alter table public.repayments drop constraint if exists repayments_reversal_reason_check;
alter table public.repayments
  add constraint repayments_reversal_reason_check
  check ((reversed_at is null) or (reversal_reason is not null and length(trim(reversal_reason)) >= 3));

create or replace function public.get_dashboard_stats()
returns table (
  total_students bigint, verified_students bigint, total_applications bigint, submitted_applications bigint,
  approved_applications bigint, total_disbursed numeric, total_collected numeric, outstanding_portfolio numeric, active_loans bigint
) language sql security definer set search_path = public stable as $$
  select
    (select count(*) from public.users where role = 'STUDENT'),
    (select count(*) from public.student_profiles where verification_status = 'VERIFIED'),
    (select count(*) from public.loan_applications),
    (select count(*) from public.loan_applications where status not in ('DRAFT')),
    (select count(*) from public.loan_applications where status in ('APPROVED','DISBURSED')),
    (select coalesce(sum(principal_amount),0) from public.loans),
    (select coalesce(sum(amount),0) from public.repayments where reversed_at is null),
    (select coalesce(sum(outstanding_balance),0) from public.loans where status = 'ACTIVE'),
    (select count(*) from public.loans where status = 'ACTIVE')
  where exists (select 1 from public.users u where u.id = auth.uid()
    and u.role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE');
$$;
revoke all on function public.get_dashboard_stats() from public;
grant execute on function public.get_dashboard_stats() to authenticated;


-- ---------------------------------------------------------------------------------------
-- Remediation for defect 3, if this migration refused to run.
--
-- Find the duplicated identities:
--   select university, registration_number, count(*) as accounts,
--          array_agg(user_id) as user_ids
--   from public.student_profiles
--   where university is not null and registration_number is not null
--   group by university, registration_number having count(*) > 1;
--
-- For each group: keep the oldest genuine account and close the others. Confirm with the student
-- first — do not delete a real account on the strength of this query alone.
--   update public.users set status = 'SUSPENDED' where id = <duplicate user_id>;
--
-- If the registration number itself is wrong (a typo in manual verification rather than a
-- duplicate registration), correct it through the register instead:
--   update public.rucu_students set registration_number = '<correct value>'
--    where id = <rucu_student_id>;
-- ---------------------------------------------------------------------------------------
