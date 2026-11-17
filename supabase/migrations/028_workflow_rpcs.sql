-- OGESEOUS MICROFINANCE — Migration 028: the sequential workflow state machine
-- Run after 027_workflow_foundation.sql. Copyright © Paulo Mkenya
--
-- WHAT THIS FILE DOES
-- ===================
-- 027 added the vocabulary and the tables. This file adds the only code paths that may move an
-- application through them:
--
--   Student  submit / resubmit                     -> PENDING_LOAN_OFFICER
--   Loan officer  forward + comment                -> PENDING_MANAGER
--   Loan officer  reject                           -> REJECTED
--   Loan officer or manager  return to student     -> ACTION_REQUIRED
--   Manager  approve / reject / return             -> PENDING_ACCOUNTANT / REJECTED / RETURNED_TO_LOAN_OFFICER
--   Accountant  prepare per-tranche terms          -> PENDING_TERMS_APPROVAL
--   Manager  approve / return terms                -> TERMS_APPROVED / RETURNED_TO_ACCOUNTANT
--   Student  accept / decline terms                -> TERMS_ACCEPTED / RETURNED_TO_ACCOUNTANT
--
-- The old review_loan_application() is neutered: it can no longer set APPROVED from a single
-- click, which is the bypass this whole workflow exists to close.
--
-- THREE DEFECTS INHERITED FROM EARLIER MIGRATIONS ARE FIXED HERE, because the new index and the
-- tranche model make them reachable:
--
--   1. The partial unique index one_open_application_per_student changed its status list in 027.
--      The ON CONFLICT (user_id) WHERE status in (...) clauses in 015/017/011 no longer infer it,
--      so verify_student_from_register(), declare_application_student() and
--      save_loan_application_draft() would fail with "there is no unique or exclusion constraint
--      matching the ON CONFLICT specification". They are redefined with the new list.
--
--   2. loan_installments had UNIQUE (loan_id, seq). A second tranche needs its own seq 1..n, so
--      that constraint is replaced by UNIQUE (loan_id, tranche_no, seq).
--
--   3. block_application_with_live_loan() refused any open status while a live loan existed. That
--      is correct for a NEW application, but it also blocked the SAME application moving from
--      DISBURSED to PENDING_TERMS_APPROVAL for a second tranche. It now ignores a live loan that
--      belongs to the application being updated.
--
-- A note on interest: this file snapshots terms with reducing-balance amortization. The rate is a
-- commercial decision made per loan by the accountant and approved by the manager. The global
-- setting is only a prefill. No flat-rate path exists here, by design.

-- ---------------------------------------------------------------------------------------
-- 0. Re-runnable guards for the two schema corrections above.
-- ---------------------------------------------------------------------------------------
-- 0a. One installment sequence PER TRANCHE, not per loan.
alter table public.loan_installments
  drop constraint if exists loan_installments_loan_id_seq_key;
create unique index if not exists installments_loan_tranche_seq_uniq
  on public.loan_installments (loan_id, tranche_no, seq);

-- 0b. Installment rows written from now on point at the terms that generated them. Historical
--     rows have terms_id = null, which is why the constraint is added NOT VALID.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.loan_installments'::regclass
       and conname = 'loan_installments_terms_id_fkey'
  ) then
    alter table public.loan_installments
      add constraint loan_installments_terms_id_fkey
      foreign key (terms_id) references public.loan_terms(id) on delete restrict not valid;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.loan_installments'::regclass
       and conname = 'loan_installments_terms_id_fkey'
       and not convalidated
  ) and not exists (
    select 1 from public.loan_installments i
     where i.terms_id is not null
       and not exists (select 1 from public.loan_terms t where t.id = i.terms_id)
  ) then
    alter table public.loan_installments validate constraint loan_installments_terms_id_fkey;
  end if;
end $$;

-- 0c. Only one set of terms may be open per application. DISBURSED/VOIDED terms are closed;
--     ACCEPTED_BY_STUDENT is open until the accountant actually pays it out.
create unique index if not exists loan_terms_one_open_per_application
  on public.loan_terms (application_id)
  where status in ('DRAFT_TERMS','PENDING_MANAGER_TERMS','APPROVED_TERMS','ACCEPTED_BY_STUDENT');


-- ---------------------------------------------------------------------------------------
-- 1. Two internal writers, both revoked from every client role.
--
--    record_workflow_transition() is the single place a stage move is written. It updates BOTH the
--    new transition table and the existing application_status_history, so the two cannot disagree.
--    The full comment lives only in loan_workflow_transitions when the move is internal; a student
--    must not read the manager's note to the loan officer just because the history table is theirs.
--
--    log_financial_event() writes the immutable before/after record for a money decision.
-- ---------------------------------------------------------------------------------------
create or replace function public.record_workflow_transition(
  p_application_id uuid,
  p_stage text,
  p_from_status text,
  p_to_status text,
  p_comment text default null,
  p_terms_id uuid default null,
  p_visible_to_student boolean default true,
  p_metadata jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role public.user_role;
  v_loan uuid;
  v_note text;
begin
  select u.role into v_role from public.users u where u.id = auth.uid();
  select l.id into v_loan from public.loans l where l.application_id = p_application_id limit 1;

  insert into public.loan_workflow_transitions
    (application_id, loan_id, terms_id, stage, from_status, to_status,
     actor_id, actor_role, comment, visible_to_student, metadata)
  values
    (p_application_id, v_loan, p_terms_id, p_stage, p_from_status, p_to_status,
     auth.uid(), v_role, nullif(trim(coalesce(p_comment, '')), ''),
     coalesce(p_visible_to_student, true), p_metadata);

  -- The old history table has no visibility column and is readable by the application owner.
  -- Writing an internal note there would leak it, so an internal move gets a null note.
  v_note := case when coalesce(p_visible_to_student, true)
                 then nullif(trim(coalesce(p_comment, '')), '')
                 else null end;

  insert into public.application_status_history
    (application_id, from_status, to_status, actor_id, actor_role, note)
  values
    (p_application_id, p_from_status, p_to_status, auth.uid(), v_role, v_note);
end $$;
revoke all on function public.record_workflow_transition(uuid,text,text,text,text,uuid,boolean,jsonb)
  from public, anon, authenticated;

create or replace function public.log_financial_event(
  p_entity text,
  p_entity_id text,
  p_action text,
  p_reason text default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_metadata jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_role public.user_role;
begin
  select u.role into v_role from public.users u where u.id = auth.uid();
  insert into public.financial_audit_events
    (entity, entity_id, action, actor_id, actor_role, reason, before, after, metadata)
  values
    (p_entity, p_entity_id, p_action, auth.uid(), v_role,
     nullif(trim(coalesce(p_reason, '')), ''), p_before, p_after, p_metadata);
end $$;
revoke all on function public.log_financial_event(text,text,text,text,jsonb,jsonb,jsonb)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------------------
-- 2. Amortization: reducing balance, equal monthly installments, 2dp.
--
--    The rules, stated once so 028 and 029 cannot drift apart:
--      * monthly rate = annual percentage / 100 / 12
--      * installment = P * r / (1 - (1 + r)^-n), rounded to 2dp
--      * interest each period = opening balance * r, rounded to 2dp
--      * principal each period = installment - interest; the final period takes the remaining
--        opening balance so the schedule closes at exactly zero
--      * the final installment is the one that absorbs every rounding difference
--
--    There is deliberately no FLAT branch. A flat loan can only exist if somebody adds one here,
--    which is the point: the requirement is reducing balance unless explicitly configured.
-- ---------------------------------------------------------------------------------------
create or replace function public.amortization_schedule(
  p_principal numeric, p_annual_rate numeric, p_months integer
) returns table (
  seq integer,
  opening_balance numeric,
  interest_amount numeric,
  principal_amount numeric,
  installment_amount numeric,
  closing_balance numeric
) language plpgsql immutable as $$
declare
  v_opening numeric;
  v_rate numeric;
  v_payment numeric;
  v_interest numeric;
  v_principal_part numeric;
  v_closing numeric;
  i integer;
begin
  if p_principal is null or p_principal <= 0 then
    raise exception 'Principal must be greater than zero';
  end if;
  if p_months is null or p_months < 1 then
    raise exception 'Invalid repayment period';
  end if;
  if p_annual_rate is null or p_annual_rate < 0 then
    raise exception 'Interest rate cannot be negative';
  end if;

  v_opening := round(p_principal, 2);
  v_rate := round(p_annual_rate, 6) / 100 / 12;

  if v_rate = 0 then
    v_payment := round(v_opening / p_months, 2);
  else
    v_payment := round(v_opening * v_rate / (1 - power(1 + v_rate, -p_months)), 2);
  end if;

  for i in 1..p_months loop
    v_interest := round(v_opening * v_rate, 2);
    if i = p_months then
      -- The final period clears whatever principal is left, so the schedule cannot end on a
      -- rounding residue.
      v_principal_part := v_opening;
    else
      v_principal_part := greatest(round(v_payment - v_interest, 2), 0);
      if v_principal_part > v_opening then v_principal_part := v_opening; end if;
    end if;
    v_closing := round(v_opening - v_principal_part, 2);

    seq := i;
    opening_balance := v_opening;
    interest_amount := v_interest;
    principal_amount := v_principal_part;
    installment_amount := round(v_principal_part + v_interest, 2);
    closing_balance := v_closing;
    return next;

    v_opening := v_closing;
  end loop;
end $$;
revoke all on function public.amortization_schedule(numeric,numeric,integer) from public;
grant execute on function public.amortization_schedule(numeric,numeric,integer) to authenticated;

-- One-row summary for the terms screen and for accountant_prepare_terms().
create or replace function public.loan_quote(
  p_principal numeric, p_annual_rate numeric, p_months integer
) returns table (
  installment_amount numeric,
  total_interest numeric,
  total_repayable numeric
) language sql immutable as $$
  with schedule as (
    select * from public.amortization_schedule(p_principal, p_annual_rate, p_months)
  )
  select
    (select s.installment_amount from schedule s order by s.seq limit 1),
    round(coalesce((select sum(s.interest_amount) from schedule s), 0), 2),
    round(coalesce((select sum(s.installment_amount) from schedule s), 0), 2);
$$;
revoke all on function public.loan_quote(numeric,numeric,integer) from public;
grant execute on function public.loan_quote(numeric,numeric,integer) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 3. Submission checks in one place.
--
--    submit_loan_application() and resubmit_application() must apply the same rules: a student
--    who fixes a missing document and resubmits must not slip past a check that submit enforces.
--    Internal only; revoked from every client role.
-- ---------------------------------------------------------------------------------------
create or replace function public.validate_application_submission(p_id uuid)
returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.loan_applications%rowtype;
  v_missing text[];
  v_required text[];
  v_months integer[];
begin
  select * into v_row from public.loan_applications where id = p_id;
  if v_row.id is null then raise exception 'Application not found'; end if;
  if v_row.student_confirmed_at is null then
    raise exception 'Confirm your student details before submitting';
  end if;
  if v_row.amount is null or v_row.amount <= 0 then
    raise exception 'Your loan details are incomplete';
  end if;
  if v_row.purpose is null or v_row.repayment_period_months is null then
    raise exception 'Your loan details are incomplete';
  end if;
  v_months := public.allowed_repayment_months();
  if not (v_row.repayment_period_months = any (v_months)) then
    raise exception 'Choose one of the permitted repayment periods: %', array_to_string(v_months, ', ');
  end if;
  if v_row.monthly_income is null or v_row.monthly_expenses is null then
    raise exception 'Your financial information is incomplete';
  end if;
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
end $$;
revoke all on function public.validate_application_submission(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------------------
-- 4. Submit: the student's application enters the first staff stage, not "under review".
--
--    Same signature and same return shape as 014, so CREATE OR REPLACE is enough. Two changes:
--      * the status is PENDING_LOAN_OFFICER, which is a real queue entry;
--      * the token comes from new_verification_token(), the helper 027 added so a project with
--        pgcrypto in `extensions` no longer fails on an unqualified gen_random_bytes().
-- ---------------------------------------------------------------------------------------
create or replace function public.submit_loan_application(p_id uuid, p_terms_accepted boolean)
returns table (application_number text, status text, submitted_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_row public.loan_applications%rowtype;
  v_num text;
  v_token text;
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
  if v_row.submitted_at is not null then raise exception 'This application has already been submitted'; end if;

  perform public.validate_application_submission(p_id);

  v_num := 'OGS-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.application_number_seq')::text, 6, '0');
  v_token := public.new_verification_token();

  update public.loan_applications
     set status = 'PENDING_LOAN_OFFICER',
         action_required_note = null,
         terms_accepted = true, terms_accepted_at = now(), submitted_at = now(),
         application_number = v_num, verification_token = v_token
   where id = p_id and status = 'DRAFT';
  if not found then raise exception 'This application has already been submitted'; end if;

  perform public.record_workflow_transition(
    p_id, 'STUDENT_SUBMIT', 'DRAFT', 'PENDING_LOAN_OFFICER',
    'Submitted by the student', null, true,
    jsonb_build_object('application_number', v_num));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_SUBMITTED', 'loan_applications', p_id::text,
            jsonb_build_object('application_number', v_num, 'amount', v_row.amount));

  return query select v_num, 'PENDING_LOAN_OFFICER'::text, now();
end $$;
revoke all on function public.submit_loan_application(uuid,boolean) from public;
grant execute on function public.submit_loan_application(uuid,boolean) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 5. Resubmit after ACTION_REQUIRED.
--
--    It goes back to the LOAN OFFICER, not to wherever it came from. The loan officer is the
--    officer who owns the student relationship; the manager sees it again only after a fresh
--    assessment. That is the same order of work as the first submission.
-- ---------------------------------------------------------------------------------------
create or replace function public.resubmit_application(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_row public.loan_applications%rowtype;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_row from public.loan_applications
   where id = p_id and user_id = auth.uid() for update;
  if v_row.id is null then raise exception 'Application not found'; end if;
  if v_row.status <> 'ACTION_REQUIRED' then
    raise exception 'There is nothing to resubmit';
  end if;

  perform public.validate_application_submission(p_id);

  update public.loan_applications
     set status = 'PENDING_LOAN_OFFICER',
         action_required_note = null
   where id = p_id and status = 'ACTION_REQUIRED';

  perform public.record_workflow_transition(
    p_id, 'STUDENT_RESUBMIT', 'ACTION_REQUIRED', 'PENDING_LOAN_OFFICER',
    'Student provided what was requested', null, true, null);

  insert into public.audit_logs (actor_id, action, entity, entity_id)
    values (auth.uid(), 'LOAN_APPLICATION_RESUBMITTED', 'loan_applications', p_id::text);
end $$;
revoke all on function public.resubmit_application(uuid) from public;
grant execute on function public.resubmit_application(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 6. The old single-step review is closed.
--
--    Leaving it callable would let a loan officer (or manager) keep setting APPROVED directly,
--    which skips the manager, the accountant, the terms and the borrower's acceptance. The
--    function is kept so a stale client gets an explanation rather than "function not found".
-- ---------------------------------------------------------------------------------------
create or replace function public.review_loan_application(p_id uuid, p_decision text, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Applications are reviewed through the sequential workflow now. Use forward_application_to_manager(), manager_decide_application() or return_application_to_student().';
end $$;
revoke all on function public.review_loan_application(uuid,text,text) from public;
grant execute on function public.review_loan_application(uuid,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 7. Functions broken by the 027 index change: same bodies, corrected ON CONFLICT list.
--
--    The new partial index covers these statuses. The arbiter predicate must be implied by it, so
--    the list below is the index's own list. SUBMITTED and UNDER_REVIEW were backfilled away by
--    027 and are no longer in the index.
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

  select r.* into v_row from public.rucu_students r
   where lower(r.registration_number) = lower(trim(p_registration))
     and lower(r.last_name) = lower(trim(p_last_name))
   limit 1;
  if v_row.id is null then return; end if;

  select sp.user_id into v_holder from public.student_profiles sp
   where sp.university = 'RUCU' and lower(sp.registration_number) = lower(v_row.registration_number)
     and sp.user_id <> auth.uid() limit 1;
  if v_holder is not null then
    raise exception 'That registration number is already registered to an account here. Sign in with that account instead of creating a new one.';
  end if;

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
  on conflict (user_id) where status in (
    'DRAFT','PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER','ACTION_REQUIRED',
    'PENDING_MANAGER','PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT',
    'PENDING_TERMS_APPROVAL','TERMS_APPROVED','TERMS_ACCEPTED') do update
    set student_record_id = excluded.student_record_id,
        student_confirmed_at = excluded.student_confirmed_at,
        verification_method = excluded.verification_method,
        programme = excluded.programme,
        year_of_study = excluded.year_of_study
    where public.loan_applications.status = 'DRAFT'
  returning id into v_app;

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
  on conflict (user_id) where status in (
    'DRAFT','PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER','ACTION_REQUIRED',
    'PENDING_MANAGER','PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT',
    'PENDING_TERMS_APPROVAL','TERMS_APPROVED','TERMS_ACCEPTED') do update
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

-- The legacy four-argument draft writer. The wizard uses save_application_loan() below, but a
-- stale tab can still call this, so its ON CONFLICT list must match the 027 index too.
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
  on conflict (user_id) where status in (
    'DRAFT','PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER','ACTION_REQUIRED',
    'PENDING_MANAGER','PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT',
    'PENDING_TERMS_APPROVAL','TERMS_APPROVED','TERMS_ACCEPTED') do update
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
-- 8. ACTION_REQUIRED must be editable, or the status is a dead end.
--
--    The wizard functions update the draft. They now also update when the loan officer has asked
--    the student to correct something. The update never touches a submitted application in any
--    other state, and the ON CONFLICT/index path is unchanged.
-- ---------------------------------------------------------------------------------------
create or replace function public.save_application_loan(
  p_amount numeric, p_purpose text, p_purpose_other text, p_repayment_months integer
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_min numeric; v_max numeric; v_months integer[];
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;

  select id into v_id from public.loan_applications
   where user_id = auth.uid() and status in ('DRAFT','ACTION_REQUIRED') limit 1;
  if v_id is null then
    raise exception 'Start your application first — confirm your student details before entering loan details';
  end if;
  if not exists (select 1 from public.loan_applications where id = v_id and student_confirmed_at is not null) then
    raise exception 'Confirm your student details first';
  end if;

  if p_purpose not in ('TUITION_FEES','ACCOMMODATION','FOOD_LIVING','BOOKS_AND_MATERIALS','BUSINESS','OTHER') then
    raise exception 'Invalid purpose';
  end if;
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
   where id = v_id and status in ('DRAFT','ACTION_REQUIRED');

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
   where user_id = auth.uid() and status in ('DRAFT','ACTION_REQUIRED') limit 1;
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
   where id = v_id and status in ('DRAFT','ACTION_REQUIRED');

  if not found then
    raise exception 'This application has already been submitted and can no longer be edited here';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id)
    values (auth.uid(), 'LOAN_DRAFT_SAVED', 'loan_applications', v_id::text);
  return v_id;
end $$;
revoke all on function public.save_application_financial(numeric,text,numeric,boolean,numeric,text) from public;
grant execute on function public.save_application_financial(numeric,text,numeric,boolean,numeric,text) to authenticated;

create or replace function public.save_application_guarantor(
  p_full_name text, p_relationship text, p_phone text, p_national_id text, p_address text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;

  select id into v_id from public.loan_applications
   where user_id = auth.uid() and status in ('DRAFT','ACTION_REQUIRED') limit 1;
  if v_id is null then raise exception 'Start your application first'; end if;

  if public.guarantor_is_required() then
    if length(trim(coalesce(p_full_name, ''))) < 3 then raise exception 'Enter your guarantor''s full name'; end if;
    if length(trim(coalesce(p_relationship, ''))) < 2 then raise exception 'State your relationship to the guarantor'; end if;
    if length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) < 9 then
      raise exception 'Enter a phone number we can reach the guarantor on';
    end if;
    if length(trim(coalesce(p_national_id, ''))) < 5 then raise exception 'Enter the guarantor''s National ID number'; end if;
    if length(trim(coalesce(p_address, ''))) < 5 then raise exception 'Enter the guarantor''s address'; end if;
  else
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
   where id = v_id and status in ('DRAFT','ACTION_REQUIRED');
  if not found then raise exception 'This application has already been submitted and can no longer be edited here'; end if;

  return v_id;
end $$;
revoke all on function public.save_application_guarantor(text,text,text,text,text) from public;
grant execute on function public.save_application_guarantor(text,text,text,text,text) to authenticated;

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

  if not exists (select 1 from public.loan_applications
                  where id = p_application_id and status in ('DRAFT','ACTION_REQUIRED')) then
    raise exception 'This application is no longer editable here';
  end if;

  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'verification-documents'
       and o.name = trim(p_path)
       and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then raise exception 'That upload could not be found in your account. Please upload it again.'; end if;

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
-- 9. Correct the live-loan trigger for tranches.
--
--    A live loan must block a NEW application, not the same application's next tranche. The test
--    is therefore "a live loan exists for this student on a DIFFERENT application".
-- ---------------------------------------------------------------------------------------
create or replace function public.block_application_with_live_loan() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_is_open boolean;
begin
  v_is_open := new.status in (
    'DRAFT','PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER','ACTION_REQUIRED',
    'PENDING_MANAGER','PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT',
    'PENDING_TERMS_APPROVAL','TERMS_APPROVED','TERMS_ACCEPTED');

  -- OLD is not read at all on INSERT, where it is unassigned.
  if not v_is_open then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;

  if exists (
       select 1 from public.loans l
        where l.user_id = new.user_id
          and l.status in ('ACTIVE', 'DEFAULTED', 'PAID_OFF')
          and l.application_id is distinct from new.id
     )
  then
    raise exception 'This student has a live loan. It must be fully settled and closed before a new application can be opened.';
  end if;
  return new;
end $$;
revoke all on function public.block_application_with_live_loan() from public, anon, authenticated;


-- ---------------------------------------------------------------------------------------
-- 10. Loan officer: forward, reject, or return to the student.
--
--     A comment is mandatory on every one of these: it is the handover record the next officer
--     reads. The explicit confirmation flag is not security, it is a second deliberate action so
--     a mis-click cannot move an application to the manager.
-- ---------------------------------------------------------------------------------------
create or replace function public.forward_application_to_manager(
  p_id uuid, p_comment text, p_confirm boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare v_row public.loan_applications%rowtype;
begin
  if not coalesce(p_confirm, false) then
    raise exception 'Confirm that you have assessed this application before forwarding it';
  end if;
  if length(trim(coalesce(p_comment, ''))) < 3 then
    raise exception 'Add a note for the manager explaining your assessment';
  end if;
  if not exists (select 1 from public.users
                  where id = auth.uid()
                    and role in ('LOAN_OFFICER','SUPER_ADMIN')
                    and status = 'ACTIVE') then
    raise exception 'Only a loan officer can forward an application to the manager';
  end if;

  select * into v_row from public.loan_applications where id = p_id for update;
  if v_row.id is null then raise exception 'Application not found'; end if;
  if v_row.status not in ('PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER') then
    raise exception 'This application is % and cannot be forwarded from here', v_row.status;
  end if;
  if v_row.student_confirmed_at is null then
    raise exception 'The student''s identity has not been confirmed on this application';
  end if;
  if exists (select 1 from public.loan_terms
              where application_id = p_id
                and status in ('DRAFT_TERMS','PENDING_MANAGER_TERMS','APPROVED_TERMS','ACCEPTED_BY_STUDENT')) then
    raise exception 'This application already has terms in progress';
  end if;

  -- review_notes is readable by the student (the application row is theirs), so the loan
  -- officer's internal handover note is NOT written there. It lives only in the transition table.
  update public.loan_applications
     set status = 'PENDING_MANAGER',
         reviewed_by = auth.uid(), reviewed_at = now(),
         action_required_note = null
   where id = p_id;

  perform public.record_workflow_transition(
    p_id, 'LOAN_OFFICER_FORWARD', v_row.status, 'PENDING_MANAGER',
    p_comment, null, false,
    jsonb_build_object('amount', v_row.amount, 'period_months', v_row.repayment_period_months));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_FORWARDED', 'loan_applications', p_id::text,
            jsonb_build_object('comment', trim(p_comment), 'from_status', v_row.status));
end $$;
revoke all on function public.forward_application_to_manager(uuid,text,boolean) from public;
grant execute on function public.forward_application_to_manager(uuid,text,boolean) to authenticated;

create or replace function public.loan_officer_reject_application(p_id uuid, p_comment text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_row public.loan_applications%rowtype;
begin
  if length(trim(coalesce(p_comment, ''))) < 3 then
    raise exception 'Give a reason for the rejection — the student is shown it';
  end if;
  if not exists (select 1 from public.users
                  where id = auth.uid()
                    and role in ('LOAN_OFFICER','SUPER_ADMIN')
                    and status = 'ACTIVE') then
    raise exception 'Only a loan officer can reject an application at this stage';
  end if;

  select * into v_row from public.loan_applications where id = p_id for update;
  if v_row.id is null then raise exception 'Application not found'; end if;
  if v_row.status not in ('PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER') then
    raise exception 'This application is % and cannot be rejected at this stage', v_row.status;
  end if;

  update public.loan_applications
     set status = 'REJECTED',
         reviewed_by = auth.uid(), reviewed_at = now(),
         review_notes = trim(p_comment),
         action_required_note = null
   where id = p_id;

  perform public.record_workflow_transition(
    p_id, 'LOAN_OFFICER_REJECT', v_row.status, 'REJECTED',
    p_comment, null, true, null);

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_REJECTED', 'loan_applications', p_id::text,
            jsonb_build_object('comment', trim(p_comment), 'from_status', v_row.status));
end $$;
revoke all on function public.loan_officer_reject_application(uuid,text) from public;
grant execute on function public.loan_officer_reject_application(uuid,text) to authenticated;

create or replace function public.return_application_to_student(p_id uuid, p_note text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_row public.loan_applications%rowtype;
begin
  if length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'Say what the student needs to provide — they are shown it';
  end if;
  if not exists (select 1 from public.users
                  where id = auth.uid()
                    and role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN')
                    and status = 'ACTIVE') then
    raise exception 'Only a loan officer, manager or super admin can return an application to the student';
  end if;

  select * into v_row from public.loan_applications where id = p_id for update;
  if v_row.id is null then raise exception 'Application not found'; end if;
  if v_row.status not in ('PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER','PENDING_MANAGER') then
    raise exception 'This application is % and cannot be returned to the student now', v_row.status;
  end if;

  update public.loan_applications
     set status = 'ACTION_REQUIRED',
         action_required_note = trim(p_note),
         reviewed_by = auth.uid(), reviewed_at = now(),
         review_notes = trim(p_note)
   where id = p_id;

  perform public.record_workflow_transition(
    p_id, 'RETURN_TO_STUDENT', v_row.status, 'ACTION_REQUIRED',
    p_note, null, true, null);

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_ACTION_REQUIRED', 'loan_applications', p_id::text,
            jsonb_build_object('note', trim(p_note), 'from_status', v_row.status));
end $$;
revoke all on function public.return_application_to_student(uuid,text) from public;
grant execute on function public.return_application_to_student(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 11. Manager decision.
--
--     APPROVE moves to the accountant, REJECT ends the application, RETURN sends it back to the
--     loan officer for rework. The comment is mandatory on all three because the student or the
--     loan officer is owed an explanation in each case.
-- ---------------------------------------------------------------------------------------
create or replace function public.manager_decide_application(
  p_id uuid, p_decision text, p_comment text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.loan_applications%rowtype;
  v_decision text := upper(trim(coalesce(p_decision, '')));
  v_to text;
begin
  if v_decision not in ('APPROVE','REJECT','RETURN') then
    raise exception 'Choose approve, reject or return';
  end if;
  if length(trim(coalesce(p_comment, ''))) < 3 then
    raise exception 'Add a comment for the record — it is mandatory at the manager stage';
  end if;
  if not exists (select 1 from public.users
                  where id = auth.uid()
                    and role in ('MANAGER','SUPER_ADMIN')
                    and status = 'ACTIVE') then
    raise exception 'Only a manager can decide an application at this stage';
  end if;

  select * into v_row from public.loan_applications where id = p_id for update;
  if v_row.id is null then raise exception 'Application not found'; end if;
  if v_row.status <> 'PENDING_MANAGER' then
    raise exception 'This application is % and is not waiting for a manager', v_row.status;
  end if;

  v_to := case v_decision
            when 'APPROVE' then 'PENDING_ACCOUNTANT'
            when 'REJECT'  then 'REJECTED'
            else 'RETURNED_TO_LOAN_OFFICER'
          end;

  -- Only a rejection is a message to the student. An approval or an internal return is recorded
  -- in loan_workflow_transitions, not in the student-readable review_notes column.
  update public.loan_applications
     set status = v_to,
         reviewed_by = auth.uid(), reviewed_at = now(),
         review_notes = case when v_decision = 'REJECT' then trim(p_comment) else null end,
         action_required_note = null
   where id = p_id;

  perform public.record_workflow_transition(
    p_id, 'MANAGER_DECISION', 'PENDING_MANAGER', v_to,
    p_comment, null, (v_decision = 'REJECT'),
    jsonb_build_object('decision', v_decision, 'amount', v_row.amount,
                       'period_months', v_row.repayment_period_months));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_MANAGER_' || v_decision, 'loan_applications', p_id::text,
            jsonb_build_object('comment', trim(p_comment), 'to_status', v_to));
end $$;
revoke all on function public.manager_decide_application(uuid,text,text) from public;
grant execute on function public.manager_decide_application(uuid,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 12. Accountant: prepare per-tranche terms.
--
--     One row per tranche. The first call after manager approval creates tranche 1; a call while
--     the loan is DISBURSED creates the next tranche; a call after a return or a student decline
--     edits the existing draft rather than inventing another row.
--
--     The sum of all non-voided tranches may not exceed the amount the student actually applied
--     for. A tranche cannot be for more than that, and the last tranche closes the gap.
-- ---------------------------------------------------------------------------------------
create or replace function public.accountant_prepare_terms(
  p_application_id uuid,
  p_principal numeric,
  p_annual_rate numeric,
  p_period_months integer,
  p_comment text default null,
  p_terms_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_app public.loan_applications%rowtype;
  v_terms public.loan_terms%rowtype;
  v_before jsonb;
  v_terms_id uuid;
  v_tranche integer;
  v_committed numeric;
  v_rate numeric;
  v_min_rate numeric;
  v_max_rate numeric;
  v_quote record;
  v_months integer[];
begin
  if not exists (select 1 from public.users
                  where id = auth.uid()
                    and role in ('ACCOUNTANT','SUPER_ADMIN')
                    and status = 'ACTIVE') then
    raise exception 'Only an accountant can prepare loan terms';
  end if;

  select * into v_app from public.loan_applications where id = p_application_id for update;
  if v_app.id is null then raise exception 'Application not found'; end if;
  if v_app.status not in ('PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT','DISBURSED') then
    raise exception 'This application is % and is not ready for terms', v_app.status;
  end if;

  if p_principal is null or round(p_principal, 2) <= 0 then
    raise exception 'Enter the amount to be paid out in this tranche';
  end if;
  if p_annual_rate is null then raise exception 'Enter the annual interest rate for this tranche'; end if;
  v_rate := round(p_annual_rate, 6);
  v_min_rate := public.setting_num('min_annual_interest_rate', 0);
  v_max_rate := public.setting_num('max_annual_interest_rate', 100);
  if v_rate < v_min_rate or v_rate > v_max_rate then
    raise exception 'Interest rate % is outside the permitted range % to %', v_rate, v_min_rate, v_max_rate;
  end if;

  v_months := public.allowed_repayment_months();
  if p_period_months is null or p_period_months not in (1, 2, 3) or not (p_period_months = any (v_months)) then
    raise exception 'Choose a repayment period of 1, 2 or 3 months';
  end if;

  -- Resolve the row this call is allowed to write.
  if p_terms_id is not null then
    select * into v_terms from public.loan_terms where id = p_terms_id for update;
    if v_terms.id is null or v_terms.application_id <> p_application_id then
      raise exception 'Terms not found on this application';
    end if;
    if v_terms.status <> 'DRAFT_TERMS' then
      raise exception 'These terms are % and can no longer be edited', v_terms.status;
    end if;
    v_terms_id := v_terms.id;
  else
    select * into v_terms from public.loan_terms
     where application_id = p_application_id and status = 'DRAFT_TERMS'
     order by tranche_no desc limit 1
     for update;
    if v_terms.id is not null then
      v_terms_id := v_terms.id;
    else
      -- A first set or a later tranche. RETURNED_TO_ACCOUNTANT with no draft means the row was
      -- lost or already moved on; refuse rather than guess which tranche was meant.
      if v_app.status = 'RETURNED_TO_ACCOUNTANT' then
        raise exception 'There is no returned terms row to correct. Ask the manager to return the terms again.';
      end if;
      select coalesce(max(tranche_no), 0) + 1 into v_tranche
        from public.loan_terms where application_id = p_application_id;
      v_terms_id := null;  -- insert path below
    end if;
  end if;

  -- Everything already committed to this application, excluding the row being replaced.
  select coalesce(sum(t.principal_amount), 0) into v_committed
    from public.loan_terms t
   where t.application_id = p_application_id
     and t.status <> 'VOIDED'
     and t.id is distinct from v_terms_id;
  if round(v_committed + round(p_principal, 2), 2) > round(v_app.amount, 2) then
    raise exception 'The tranches would total % which is more than the % the student applied for',
      round(v_committed + round(p_principal, 2), 2), round(v_app.amount, 2);
  end if;

  select * into v_quote from public.loan_quote(round(p_principal, 2), v_rate, p_period_months);

  if v_terms_id is not null then
    select to_jsonb(t) into v_before from public.loan_terms t where t.id = v_terms_id;
    update public.loan_terms
       set principal_amount = round(p_principal, 2),
           annual_rate = v_rate,
           period_months = p_period_months,
           installment_amount = v_quote.installment_amount,
           total_interest = v_quote.total_interest,
           total_repayable = v_quote.total_repayable,
           status = 'PENDING_MANAGER_TERMS',
           prepared_by = auth.uid(),
           prepared_at = now(),
           accountant_comment = nullif(trim(coalesce(p_comment, '')), ''),
           return_reason = null,
           approved_by = null,
           approved_at = null,
           accepted_at = null
     where id = v_terms_id
     returning * into v_terms;

    perform public.record_workflow_transition(
      p_application_id, 'ACCOUNTANT_TERMS', v_app.status, 'PENDING_TERMS_APPROVAL',
      p_comment, v_terms_id, false,
      jsonb_build_object('tranche_no', v_terms.tranche_no, 'principal', v_terms.principal_amount,
                         'revised', true));
  else
    insert into public.loan_terms
      (application_id, tranche_no, status, principal_amount, annual_rate, period_months,
       installment_amount, total_interest, total_repayable,
       prepared_by, prepared_at, accountant_comment)
    values
      (p_application_id, v_tranche, 'PENDING_MANAGER_TERMS', round(p_principal, 2), v_rate, p_period_months,
       v_quote.installment_amount, v_quote.total_interest, v_quote.total_repayable,
       auth.uid(), now(), nullif(trim(coalesce(p_comment, '')), ''))
    returning * into v_terms;
    v_terms_id := v_terms.id;

    perform public.record_workflow_transition(
      p_application_id, 'ACCOUNTANT_TERMS', v_app.status, 'PENDING_TERMS_APPROVAL',
      p_comment, v_terms_id, false,
      jsonb_build_object('tranche_no', v_tranche, 'principal', round(p_principal, 2)));
  end if;

  update public.loan_applications
     set status = 'PENDING_TERMS_APPROVAL',
         action_required_note = null
   where id = p_application_id;

  perform public.log_financial_event(
    'loan_terms', v_terms_id::text, 'TERMS_PREPARED', p_comment, v_before, to_jsonb(v_terms),
    jsonb_build_object('application_id', p_application_id, 'tranche_no', v_terms.tranche_no));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_TERMS_PREPARED', 'loan_terms', v_terms_id::text,
            jsonb_build_object('application_id', p_application_id, 'tranche_no', v_terms.tranche_no,
                               'principal', v_terms.principal_amount, 'annual_rate', v_rate,
                               'period_months', p_period_months));

  return v_terms_id;
end $$;
revoke all on function public.accountant_prepare_terms(uuid,numeric,numeric,integer,text,uuid) from public;
grant execute on function public.accountant_prepare_terms(uuid,numeric,numeric,integer,text,uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 13. Manager: approve or return the terms.
-- ---------------------------------------------------------------------------------------
create or replace function public.manager_approve_terms(p_terms_id uuid, p_comment text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_terms public.loan_terms%rowtype;
  v_app public.loan_applications%rowtype;
  v_before jsonb;
begin
  if not exists (select 1 from public.users
                  where id = auth.uid()
                    and role in ('MANAGER','SUPER_ADMIN')
                    and status = 'ACTIVE') then
    raise exception 'Only a manager can approve loan terms';
  end if;

  select * into v_terms from public.loan_terms where id = p_terms_id for update;
  if v_terms.id is null then raise exception 'Terms not found'; end if;
  if v_terms.status <> 'PENDING_MANAGER_TERMS' then
    raise exception 'These terms are % and are not waiting for approval', v_terms.status;
  end if;

  select * into v_app from public.loan_applications where id = v_terms.application_id for update;
  if v_app.status <> 'PENDING_TERMS_APPROVAL' then
    raise exception 'This application is % and its terms cannot be approved now', v_app.status;
  end if;

  select to_jsonb(t) into v_before from public.loan_terms t where t.id = p_terms_id;

  update public.loan_terms
     set status = 'APPROVED_TERMS',
         approved_by = auth.uid(),
         approved_at = now(),
         manager_comment = nullif(trim(coalesce(p_comment, '')), ''),
         return_reason = null
   where id = p_terms_id
   returning * into v_terms;

  update public.loan_applications set status = 'TERMS_APPROVED' where id = v_terms.application_id;

  perform public.record_workflow_transition(
    v_terms.application_id, 'MANAGER_TERMS_APPROVE', 'PENDING_TERMS_APPROVAL', 'TERMS_APPROVED',
    p_comment, p_terms_id, true,
    jsonb_build_object('tranche_no', v_terms.tranche_no, 'principal', v_terms.principal_amount,
                       'annual_rate', v_terms.annual_rate, 'period_months', v_terms.period_months,
                       'installment', v_terms.installment_amount));

  perform public.log_financial_event(
    'loan_terms', p_terms_id::text, 'TERMS_APPROVED', p_comment, v_before, to_jsonb(v_terms),
    jsonb_build_object('application_id', v_terms.application_id));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_TERMS_APPROVED', 'loan_terms', p_terms_id::text,
            jsonb_build_object('application_id', v_terms.application_id,
                               'tranche_no', v_terms.tranche_no));
end $$;
revoke all on function public.manager_approve_terms(uuid,text) from public;
grant execute on function public.manager_approve_terms(uuid,text) to authenticated;

create or replace function public.manager_return_terms(p_terms_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_terms public.loan_terms%rowtype;
  v_app public.loan_applications%rowtype;
  v_before jsonb;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give the accountant a reason for returning the terms';
  end if;
  if not exists (select 1 from public.users
                  where id = auth.uid()
                    and role in ('MANAGER','SUPER_ADMIN')
                    and status = 'ACTIVE') then
    raise exception 'Only a manager can return loan terms';
  end if;

  select * into v_terms from public.loan_terms where id = p_terms_id for update;
  if v_terms.id is null then raise exception 'Terms not found'; end if;
  if v_terms.status <> 'PENDING_MANAGER_TERMS' then
    raise exception 'These terms are % and are not waiting for approval', v_terms.status;
  end if;

  select * into v_app from public.loan_applications where id = v_terms.application_id for update;
  if v_app.status <> 'PENDING_TERMS_APPROVAL' then
    raise exception 'This application is % and its terms cannot be returned now', v_app.status;
  end if;

  select to_jsonb(t) into v_before from public.loan_terms t where t.id = p_terms_id;

  update public.loan_terms
     set status = 'DRAFT_TERMS',
         return_reason = trim(p_reason),
         approved_by = null,
         approved_at = null
   where id = p_terms_id
   returning * into v_terms;

  update public.loan_applications set status = 'RETURNED_TO_ACCOUNTANT' where id = v_terms.application_id;

  perform public.record_workflow_transition(
    v_terms.application_id, 'MANAGER_TERMS_RETURN', 'PENDING_TERMS_APPROVAL', 'RETURNED_TO_ACCOUNTANT',
    p_reason, p_terms_id, false,
    jsonb_build_object('tranche_no', v_terms.tranche_no));

  perform public.log_financial_event(
    'loan_terms', p_terms_id::text, 'TERMS_RETURNED', p_reason, v_before, to_jsonb(v_terms),
    jsonb_build_object('application_id', v_terms.application_id));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_TERMS_RETURNED', 'loan_terms', p_terms_id::text,
            jsonb_build_object('reason', trim(p_reason), 'application_id', v_terms.application_id));
end $$;
revoke all on function public.manager_return_terms(uuid,text) from public;
grant execute on function public.manager_return_terms(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 14. Student: explicit acceptance or decline.
--
--     Acceptance is a boolean argument that must be true. It is not a substitute for a real
--     signature, but it does mean a client cannot accept terms by accident with a bare call.
--     Declining returns the file to the accountant to renegotiate; it does not silently reject the
--     student, because a counter-offer is a normal outcome.
-- ---------------------------------------------------------------------------------------
create or replace function public.student_accept_terms(p_terms_id uuid, p_accept boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_terms public.loan_terms%rowtype;
  v_app public.loan_applications%rowtype;
  v_before jsonb;
begin
  if not coalesce(p_accept, false) then
    raise exception 'Tick the box to confirm that you accept these terms';
  end if;

  select t.* into v_terms
    from public.loan_terms t
    join public.loan_applications a on a.id = t.application_id
   where t.id = p_terms_id and a.user_id = auth.uid()
   for update of t;
  if v_terms.id is null then raise exception 'Terms not found'; end if;
  if v_terms.status <> 'APPROVED_TERMS' then
    raise exception 'These terms are % and cannot be accepted now', v_terms.status;
  end if;

  select * into v_app from public.loan_applications where id = v_terms.application_id for update;
  if v_app.status <> 'TERMS_APPROVED' then
    raise exception 'This application is % and its terms are not awaiting your acceptance', v_app.status;
  end if;

  select to_jsonb(t) into v_before from public.loan_terms t where t.id = p_terms_id;

  update public.loan_terms
     set status = 'ACCEPTED_BY_STUDENT', accepted_at = now()
   where id = p_terms_id
   returning * into v_terms;

  update public.loan_applications set status = 'TERMS_ACCEPTED' where id = v_terms.application_id;

  perform public.record_workflow_transition(
    v_terms.application_id, 'STUDENT_TERMS_ACCEPT', 'TERMS_APPROVED', 'TERMS_ACCEPTED',
    'Student accepted the loan terms', p_terms_id, true,
    jsonb_build_object('tranche_no', v_terms.tranche_no, 'principal', v_terms.principal_amount,
                       'annual_rate', v_terms.annual_rate, 'period_months', v_terms.period_months));

  perform public.log_financial_event(
    'loan_terms', p_terms_id::text, 'TERMS_ACCEPTED_BY_STUDENT', null, v_before, to_jsonb(v_terms),
    jsonb_build_object('application_id', v_terms.application_id));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_TERMS_ACCEPTED_BY_STUDENT', 'loan_terms', p_terms_id::text,
            jsonb_build_object('application_id', v_terms.application_id));
end $$;
revoke all on function public.student_accept_terms(uuid,boolean) from public;
grant execute on function public.student_accept_terms(uuid,boolean) to authenticated;

create or replace function public.student_decline_terms(p_terms_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_terms public.loan_terms%rowtype;
  v_app public.loan_applications%rowtype;
  v_before jsonb;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Tell OGESEOUS why you are not accepting these terms';
  end if;

  select t.* into v_terms
    from public.loan_terms t
    join public.loan_applications a on a.id = t.application_id
   where t.id = p_terms_id and a.user_id = auth.uid()
   for update of t;
  if v_terms.id is null then raise exception 'Terms not found'; end if;
  if v_terms.status <> 'APPROVED_TERMS' then
    raise exception 'These terms are % and cannot be declined now', v_terms.status;
  end if;

  select * into v_app from public.loan_applications where id = v_terms.application_id for update;
  if v_app.status <> 'TERMS_APPROVED' then
    raise exception 'This application is % and its terms are not awaiting your decision', v_app.status;
  end if;

  select to_jsonb(t) into v_before from public.loan_terms t where t.id = p_terms_id;

  update public.loan_terms
     set status = 'DRAFT_TERMS',
         return_reason = trim(p_reason),
         approved_by = null,
         approved_at = null,
         accepted_at = null
   where id = p_terms_id
   returning * into v_terms;

  update public.loan_applications set status = 'RETURNED_TO_ACCOUNTANT' where id = v_terms.application_id;

  perform public.record_workflow_transition(
    v_terms.application_id, 'STUDENT_TERMS_DECLINE', 'TERMS_APPROVED', 'RETURNED_TO_ACCOUNTANT',
    p_reason, p_terms_id, true,
    jsonb_build_object('tranche_no', v_terms.tranche_no));

  perform public.log_financial_event(
    'loan_terms', p_terms_id::text, 'TERMS_DECLINED_BY_STUDENT', p_reason, v_before, to_jsonb(v_terms),
    jsonb_build_object('application_id', v_terms.application_id));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_TERMS_DECLINED_BY_STUDENT', 'loan_terms', p_terms_id::text,
            jsonb_build_object('reason', trim(p_reason), 'application_id', v_terms.application_id));
end $$;
revoke all on function public.student_decline_terms(uuid,text) from public;
grant execute on function public.student_decline_terms(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 15. Verification queries. Read-only; run after applying.
-- ---------------------------------------------------------------------------------------
-- 15a. The workflow functions must all exist. Expected: eight rows.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'forward_application_to_manager','loan_officer_reject_application',
    'manager_decide_application','return_application_to_student',
    'accountant_prepare_terms','manager_approve_terms','manager_return_terms',
    'student_accept_terms','student_decline_terms')
order by proname;

-- 15b. The installments uniqueness must now include the tranche. Expected: one row whose
--      definition contains tranche_no.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'loan_installments'
  and indexname = 'installments_loan_tranche_seq_uniq';

-- 15c. No application may be in a status the new workflow cannot move. Expected: zero rows.
select id, application_number, status
from public.loan_applications
where status in ('SUBMITTED','UNDER_REVIEW','APPROVED');

-- 15d. A sample quote. Expected: three equal-ish installments summing to total_repayable, with
--      the last one absorbing the rounding difference.
select * from public.amortization_schedule(100000, 24, 3);
select * from public.loan_quote(100000, 24, 3);

notify pgrst, 'reload schema';
