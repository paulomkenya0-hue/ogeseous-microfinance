-- OGESEOUS MICROFINANCE — Corrections to money-handling and verification logic (002, 007)
-- Run after 009_reports.sql. Copyright © Paulo Mkenya
--
-- This migration only re-defines functions. No tables, columns or rows are changed, and
-- 002/007 are left untouched, so it is safe to run against a database that already has
-- migrations 001-009 applied.
--
-- Four defects are corrected:
--   1. submit_verification() — the RUCU register was never consulted. p_rucu_student_id was
--      stored but never validated, so a student could call the function directly with
--      method 'RUCU_AUTO' and any name they liked. search_rucu_student() is a convenience
--      for the UI, not the guarantee; this function is the guarantee.
--   2. submit_verification() — it only set verification_status, never writing university,
--      registration_number or form_four_index_number to student_profiles. Those columns were
--      therefore ALWAYS blank, so the loan application PDF and /student/application showed an
--      empty University and Registration No. for every student. They are populated here.
--   3. disburse_loan() — no upper bound. Any amount could be disbursed against an approved
--      application, including more than the student applied for.
--   4. record_repayment() — overpayment was silently absorbed by greatest(balance - amount, 0)
--      while the full amount was stored in repayments, so sum(repayments) stopped reconciling
--      with the loan balances. It also accepted payments against CLOSED/DEFAULTED loans, and
--      read the balance without a lock, so two concurrent payments could over-collect.
--
-- CHANGE 2 AFFECTS EXISTING DATA: profiles created before this migration keep whatever they
-- had (usually nothing). Those students must resubmit verification, or an admin must backfill
-- student_profiles from their verification_requests.
--
-- REVIEW THIS LINE BY LINE BEFORE IT HANDLES REAL MONEY.

-- ---------------------------------------------------------------------------------------
-- 1 + 2. submit_verification(): validate against the RUCU register, and populate the profile.
--
-- The register row is uniquely identified by (form_four_index_number, registration_number),
-- which is the pair a student must present. Both are checked against the row the client
-- claimed to match. The stored full_name is then TAKEN FROM THE REGISTER, not from the
-- browser, so a student's name can never be forged. Names are deliberately not compared
-- for equality: legitimate spelling differences would reject real students for no benefit,
-- and the canonical value is used regardless.
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
  -- Method must agree with university: RUCU is the only register-backed university.
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

  insert into public.verification_requests
    (user_id, university, method, registration_number, form_four_index_number, full_name_provided,
     rucu_student_id, form_four_certificate_url, identity_document_url, passport_photo_url)
  values (auth.uid(), p_university, p_method::public.verification_method, v_reg, v_index, v_full,
          p_rucu_student_id, trim(p_certificate_url), trim(p_id_document_url), trim(p_passport_url))
  returning id into v_id;

  -- Populate the profile. These columns were previously never written, which is why the
  -- loan application form and PDF showed a blank university and registration number.
  update public.student_profiles
    set verification_status  = 'PENDING',
        university           = p_university,
        registration_number  = v_reg,
        form_four_index_number = v_index,
        full_name            = v_full
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
-- 3. disburse_loan(): cap the amount at the approved application amount.
--    If OGESEOUS intentionally allows disbursing less than approved, that is still
--    allowed — only disbursing MORE is now blocked.
-- ---------------------------------------------------------------------------------------
create or replace function public.disburse_loan(p_application_id uuid, p_amount numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_loan_id uuid; v_user uuid; v_approved numeric;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only accountants, managers or super admins can disburse loans';
  end if;
  select user_id, amount into v_user, v_approved
  from public.loan_applications where id = p_application_id and status = 'APPROVED';
  if v_user is null then raise exception 'Application not found or not approved'; end if;
  if p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if p_amount > v_approved then
    raise exception 'Disbursement amount (%) exceeds the approved amount (%)', p_amount, v_approved;
  end if;

  insert into public.loans (application_id, user_id, principal_amount, outstanding_balance, disbursed_by)
  values (p_application_id, v_user, p_amount, p_amount, auth.uid()) returning id into v_loan_id;
  update public.loan_applications set status = 'DISBURSED' where id = p_application_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_DISBURSED', 'loans', v_loan_id::text,
            jsonb_build_object('amount', p_amount, 'approved_amount', v_approved));
  return v_loan_id;
end $$;
revoke all on function public.disburse_loan(uuid,numeric) from public;
grant execute on function public.disburse_loan(uuid,numeric) to authenticated;

-- ---------------------------------------------------------------------------------------
-- 4. record_repayment(): reject overpayment, and only accept payments on ACTIVE loans.
--    The loan row is locked FOR UPDATE first so two concurrent repayments cannot both read
--    the same outstanding balance and over-collect the loan.
-- ---------------------------------------------------------------------------------------
create or replace function public.record_repayment(p_loan_id uuid, p_amount numeric, p_method text, p_reference text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_balance numeric; v_status text;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only accountants, collection officers, managers or super admins can record repayments';
  end if;
  if p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if p_method not in ('CASH','MOBILE_MONEY','BANK_TRANSFER') then raise exception 'Invalid method'; end if;

  select outstanding_balance, status into v_balance, v_status
  from public.loans where id = p_loan_id for update;

  if v_balance is null then raise exception 'Loan not found'; end if;
  if v_status <> 'ACTIVE' then raise exception 'This loan is % and cannot accept repayments', v_status; end if;
  if p_amount > v_balance then
    raise exception 'Repayment (%) exceeds the outstanding balance (%)', p_amount, v_balance;
  end if;

  insert into public.repayments (loan_id, amount, method, reference, recorded_by)
  values (p_loan_id, p_amount, p_method, p_reference, auth.uid());

  update public.loans set outstanding_balance = outstanding_balance - p_amount where id = p_loan_id;
  if v_balance - p_amount = 0 then update public.loans set status = 'CLOSED' where id = p_loan_id; end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'REPAYMENT_RECORDED', 'loans', p_loan_id::text,
            jsonb_build_object('amount', p_amount, 'method', p_method, 'balance_before', v_balance));
end $$;
revoke all on function public.record_repayment(uuid,numeric,text,text) from public;
grant execute on function public.record_repayment(uuid,numeric,text,text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Optional one-off backfill for students verified before this migration, whose profile
-- university / registration number / index number are blank. Review the SELECT first.
--   update public.student_profiles sp
--      set university           = vr.university,
--          registration_number  = vr.registration_number,
--          form_four_index_number = vr.form_four_index_number,
--          full_name            = vr.full_name_provided
--     from (select distinct on (user_id) * from public.verification_requests
--            order by user_id, created_at desc) vr
--    where vr.user_id = sp.user_id
--      and (sp.university is null or sp.registration_number is null);
-- ---------------------------------------------------------------------------------------