-- OGESEOUS MICROFINANCE — Migration 029: the financial engine
-- Run after 028_workflow_rpcs.sql. Copyright © Paulo Mkenya
--
-- WHAT THIS FILE REPLACES
-- =======================
-- 013 and 020 built a workable single-disbursement engine. That model cannot express the workflow
-- 027/028 introduced: a loan can now be paid out in tranches, each with its own approved terms,
-- its own schedule and its own due dates, and no repayment may move a balance until a second
-- officer has verified it.
--
-- The old functions are therefore not "tweaked". They are replaced:
--
--   disburse_loan()              -> disburse_tranche()          (terms, channel, reference, proof)
--   record_repayment()           -> submit_repayment()          (PENDING_VERIFICATION, no allocation)
--   reverse_repayment()          -> verification-aware reversal (two-person rule, restores waivers)
--   void_disbursement()          -> non-destructive void        (no DELETE of loans or schedules)
--   build_loan_schedule()        -> legacy-only repair path     (refuses to overwrite tranche schedules)
--   rebuild_loan_payments()      -> allocates only VERIFIED payments
--
-- disburse_loan() and record_repayment() are kept as callable stubs that raise an explanation.
-- A stale tab gets a useful message instead of "function does not exist", and neither function can
-- be used to bypass the workflow.
--
-- MONEY RULES, WRITTEN ONCE
-- =========================
--   * Reducing balance, equal monthly installments, 2dp. 028 owns amortization_schedule().
--   * A repayment is SUBMITTED, then VERIFIED by a different officer. Only VERIFIED payments are
--     allocated to installments. PENDING_VERIFICATION money is visible but is not "received".
--   * The submitter can never verify their own repayment. No exception, not even for SUPER_ADMIN.
--   * A loan becomes PAID_OFF when its schedule is fully settled. It becomes CLOSED only when the
--     accountant has reconciled it through close_loan(). Those are deliberately separate states.
--   * Corrections are reversal entries. No hard delete of a repayment, disbursement or audit row.
--   * Early settlement is principal outstanding plus interest accrued to the settlement date. The
--     unearned future interest is written off, with the write-off stored on the repayment and in
--     the immutable financial audit trail.
--
-- RE-RUNNABLE. Every table change is guarded. The functions are CREATE OR REPLACE except where a
-- return type changes, in which case the old function is dropped explicitly.

-- ---------------------------------------------------------------------------------------
-- 0. Early-settlement columns on repayments.
--
--    A settlement is still a repayment, so it still needs two-person verification. The extra
--    columns record what was forgiven and exactly which installments were reduced, so a reversal
--    can put the schedule back the way it was instead of guessing.
-- ---------------------------------------------------------------------------------------
alter table public.repayments add column if not exists is_settlement boolean not null default false;
alter table public.repayments add column if not exists waived_interest numeric(12,2) not null default 0;
alter table public.repayments add column if not exists settlement_principal numeric(12,2);
alter table public.repayments add column if not exists settlement_interest numeric(12,2);
alter table public.repayments add column if not exists settlement_adjustments jsonb;

create index if not exists repayments_verification_queue_idx
  on public.repayments (submitted_at)
  where status = 'PENDING_VERIFICATION' and reversed_at is null;


-- ---------------------------------------------------------------------------------------
-- 1. The internal allocator.
--
--    This is the single implementation of "what does this loan owe". Every public money function
--    calls it. It has NO role check because the caller has already made that decision; the public
--    wrapper below is the only client-callable entry point.
--
--    It counts only VERIFIED, non-reversed repayments. That is the whole point of the two-person
--    model: money that has merely been typed in cannot reduce a debt.
-- ---------------------------------------------------------------------------------------
create or replace function public.rebuild_loan_payments_internal(p_loan_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  pay record;
  ins record;
  v_left numeric;
  v_take numeric;
  v_outstanding numeric;
  v_verified numeric;
  v_pending numeric;
  v_loan public.loans%rowtype;
  v_app_status text;
begin
  select * into v_loan from public.loans where id = p_loan_id for update;
  if v_loan.id is null then raise exception 'Loan not found'; end if;

  if not exists (select 1 from public.loan_installments where loan_id = p_loan_id and voided_at is null) then
    raise exception 'This loan has no live repayment schedule. Rebuild its schedule before recalculating payments.';
  end if;

  -- Clear the allocation on live installments only. A voided tranche keeps its historical figures.
  update public.loan_installments
     set amount_paid = 0, status = 'PENDING', paid_at = null, updated_at = now()
   where loan_id = p_loan_id and voided_at is null;

  for pay in
    select r.amount from public.repayments r
     where r.loan_id = p_loan_id
       and r.status = 'VERIFIED'
       and r.reversed_at is null
     order by coalesce(r.verified_at, r.paid_at), r.id
  loop
    v_left := pay.amount;
    for ins in
      select i.id, i.amount_due, i.amount_paid
        from public.loan_installments i
       where i.loan_id = p_loan_id
         and i.voided_at is null
         and i.amount_paid < i.amount_due
       order by i.tranche_no, i.due_date, i.seq
    loop
      exit when v_left <= 0;
      v_take := least(ins.amount_due - ins.amount_paid, v_left);
      update public.loan_installments
         set amount_paid = amount_paid + v_take, updated_at = now()
       where id = ins.id;
      v_left := v_left - v_take;
    end loop;
  end loop;

  update public.loan_installments
     set status = case when amount_paid >= amount_due then 'PAID'
                       when amount_paid > 0 then 'PARTIAL'
                       else 'PENDING' end,
         paid_at = case when amount_paid >= amount_due then coalesce(paid_at, now()) else null end
   where loan_id = p_loan_id and voided_at is null;

  select coalesce(sum(amount_due - amount_paid), 0) into v_outstanding
    from public.loan_installments
   where loan_id = p_loan_id and voided_at is null;

  select coalesce(sum(amount), 0) into v_verified
    from public.repayments
   where loan_id = p_loan_id and status = 'VERIFIED' and reversed_at is null;

  select coalesce(sum(amount), 0) into v_pending
    from public.repayments
   where loan_id = p_loan_id and status = 'PENDING_VERIFICATION' and reversed_at is null;

  -- A PAID_OFF loan whose last verified payment is reversed must reopen. A CLOSED or VOIDED loan
  -- never changes here; those are terminal until a Super Admin acts explicitly.
  update public.loans
     set outstanding_balance = v_outstanding,
         amount_verified = v_verified,
         amount_pending = v_pending,
         status = case
           when status in ('CLOSED', 'VOIDED') then status
           when v_outstanding <= 0.01 then 'PAID_OFF'
           when status = 'PAID_OFF' then 'ACTIVE'
           when status = 'DEFAULTED' then 'DEFAULTED'
           else 'ACTIVE'
         end,
         paid_off_at = case
           when status in ('CLOSED', 'VOIDED') then paid_off_at
           when v_outstanding <= 0.01 then coalesce(paid_off_at, now())
           else null
         end
   where id = p_loan_id;

  -- Keep the application stage in step with the loan. DISBURSED is the only application status
  -- whose meaning changes when the last installment is paid.
  select status into v_app_status from public.loan_applications where id = v_loan.application_id;
  if v_app_status = 'DISBURSED' and v_outstanding <= 0.01 then
    update public.loan_applications set status = 'PAID_OFF' where id = v_loan.application_id;
  elsif v_app_status = 'PAID_OFF' and v_outstanding > 0.01 then
    update public.loan_applications set status = 'DISBURSED' where id = v_loan.application_id;
  end if;
end $$;
revoke all on function public.rebuild_loan_payments_internal(uuid) from public, anon, authenticated;


-- Public repair wrapper. Finance and management only: a collection officer records money, but does
-- not get to rewrite the allocation of the whole loan.
create or replace function public.rebuild_loan_payments(p_loan_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from public.users
     where id = auth.uid()
       and role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN')
       and status = 'ACTIVE'
  ) then
    raise exception 'Only an accountant, manager or super admin can rebuild loan payments';
  end if;
  perform public.rebuild_loan_payments_internal(p_loan_id);
end $$;
revoke all on function public.rebuild_loan_payments(uuid) from public;
grant execute on function public.rebuild_loan_payments(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 2. build_loan_schedule(): the legacy repair path.
--
--    A loan with tranche schedules must never be rebuilt by this function: it would delete every
--    tranche and replace it with one schedule at the global setting, silently repricing the loan.
--    It is kept for loans created before 027 that have no terms_id on any installment.
-- ---------------------------------------------------------------------------------------
create or replace function public.build_loan_schedule(p_loan_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_principal numeric;
  v_months integer;
  v_rate numeric;
  v_conv text;
  v_total numeric;
  v_slice numeric;
  v_allocated numeric := 0;
  v_per_due date;
  v_monthly numeric;
  v_disbursed timestamptz;
  i integer;
begin
  if auth.uid() is not null and not exists (
    select 1 from public.users
     where id = auth.uid()
       and role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN')
       and status = 'ACTIVE'
  ) then
    raise exception 'Only an accountant, manager or super admin can build a repayment schedule';
  end if;

  select l.principal_amount, la.repayment_period_months, l.disbursed_at
    into v_principal, v_months, v_disbursed
  from public.loans l join public.loan_applications la on la.id = l.application_id
  where l.id = p_loan_id;
  if v_principal is null then raise exception 'Loan not found'; end if;

  if exists (select 1 from public.loan_installments where loan_id = p_loan_id and terms_id is not null) then
    raise exception 'This loan uses per-tranche terms. Its schedule is generated by disburse_tranche() and cannot be rebuilt here.';
  end if;
  if v_months is null or v_months < 1 then raise exception 'Invalid repayment period on the application'; end if;

  if exists (select 1 from public.repayments
              where loan_id = p_loan_id and status in ('VERIFIED','PENDING_VERIFICATION') and reversed_at is null) then
    raise exception 'This loan has repayments against it. Reverse them before rebuilding the schedule.';
  end if;

  v_rate := greatest(public.setting_num('annual_interest_rate', 0), 0) / 100.0;
  v_conv := upper(coalesce(nullif(trim((select value from public.app_settings where key = 'interest_convention')), ''), 'NONE'));

  if v_rate = 0 or v_conv = 'NONE' then
    v_total := v_principal;
  elsif v_conv = 'FLAT' then
    v_total := v_principal * (1 + v_rate * (v_months::numeric / 12));
  else
    v_monthly := v_rate / 12;
    if v_monthly = 0 then
      v_total := v_principal;
    else
      v_total := v_principal * v_monthly / (1 - power(1 + v_monthly, -v_months::numeric)) * v_months;
    end if;
  end if;

  v_total := round(v_total, 2);
  v_slice := round(v_total / v_months, 2);

  delete from public.loan_installments where loan_id = p_loan_id;
  for i in 1..v_months loop
    v_per_due := (v_disbursed + make_interval(months => i))::date;
    insert into public.loan_installments
      (loan_id, tranche_no, seq, due_date, amount_due, opening_balance, interest_amount,
       principal_amount, closing_balance)
    values
      (p_loan_id, 1, i, v_per_due,
       case when i = v_months then v_total - v_allocated else v_slice end,
       round(v_total - v_allocated, 2), 0,
       case when i = v_months then v_total - v_allocated else v_slice end,
       round(v_total - v_allocated - (case when i = v_months then v_total - v_allocated else v_slice end), 2));
    v_allocated := v_allocated + v_slice;
  end loop;

  perform public.rebuild_loan_payments_internal(p_loan_id);
end $$;
revoke all on function public.build_loan_schedule(uuid) from public;
grant execute on function public.build_loan_schedule(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 3. disburse_tranche(): the only way money leaves the institution.
--
--    The accountant can only call this after:
--      * the manager approved the terms,
--      * the student explicitly accepted them,
--      * the student is still verified and active,
--      * the channel, reference, proof and confirmation are present.
--
--    Each tranche gets its own schedule from its own disbursement date. The loan row aggregates
--    the tranches. A second tranche is possible without reopening the application: the accountant
--    prepares new terms, the manager approves them, the student accepts them, then this runs again.
-- ---------------------------------------------------------------------------------------
create or replace function public.disburse_tranche(
  p_terms_id uuid,
  p_channel text,
  p_reference text,
  p_proof_path text,
  p_idempotency_key text default null,
  p_confirm boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_terms public.loan_terms%rowtype;
  v_app public.loan_applications%rowtype;
  v_loan public.loans%rowtype;
  v_existing uuid;
  v_disbursement_id uuid;
  v_loan_id uuid;
  v_disbursed_at timestamptz := now();
  v_channel text := upper(trim(coalesce(p_channel, '')));
  v_reference text := nullif(trim(coalesce(p_reference, '')), '');
  v_proof text := nullif(trim(coalesce(p_proof_path, '')), '');
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_disbursed_total numeric;
  v_scheduled record;
begin
  if not exists (
    select 1 from public.users
     where id = auth.uid() and role in ('ACCOUNTANT','SUPER_ADMIN') and status = 'ACTIVE'
  ) then
    raise exception 'Only an accountant can disburse loan money';
  end if;
  if not coalesce(p_confirm, false) then
    raise exception 'Confirm that the money has actually been paid before recording this disbursement';
  end if;
  if v_channel not in ('CASH','MOBILE_MONEY','BANK_TRANSFER','CHEQUE') then
    raise exception 'Choose a valid disbursement channel';
  end if;
  if v_channel <> 'CASH' and v_reference is null then
    raise exception 'Enter the transaction reference for this % payment', lower(v_channel);
  end if;
  if v_reference is not null and length(v_reference) > 120 then
    raise exception 'The transaction reference is too long';
  end if;
  if v_proof is null then
    raise exception 'Attach proof of payment before recording this disbursement';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'payment-proofs'
       and o.name = v_proof
       and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then
    raise exception 'That proof of payment could not be found in your upload folder. Upload it again.';
  end if;

  select * into v_terms from public.loan_terms where id = p_terms_id for update;
  if v_terms.id is null then raise exception 'Loan terms not found'; end if;
  if v_terms.status <> 'ACCEPTED_BY_STUDENT' then
    raise exception 'These terms are % and have not been accepted by the student', v_terms.status;
  end if;

  select * into v_app from public.loan_applications where id = v_terms.application_id for update;
  if v_app.id is null then raise exception 'Application not found'; end if;
  if v_app.status <> 'TERMS_ACCEPTED' then
    raise exception 'This application is % and is not ready for disbursement', v_app.status;
  end if;

  if v_key is not null then
    select id into v_existing from public.disbursements where idempotency_key = v_key;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  if exists (select 1 from public.disbursements where terms_id = p_terms_id and status = 'RECORDED') then
    raise exception 'These terms have already been disbursed. If this is a mistake, void the disbursement instead of recording a second one.';
  end if;

  if v_reference is not null and exists (
    select 1 from public.disbursements
     where lower(btrim(reference)) = lower(v_reference)
       and status = 'RECORDED'
  ) then
    raise exception 'Reference "%" is already recorded against another disbursement. Check for a duplicate.', v_reference;
  end if;

  select coalesce(sum(amount), 0) into v_disbursed_total
    from public.disbursements
   where application_id = v_app.id and status = 'RECORDED';
  if round(v_disbursed_total + v_terms.principal_amount, 2) > round(v_app.amount, 2) then
    raise exception 'Disbursing this tranche would pay out % against a % application',
      round(v_disbursed_total + v_terms.principal_amount, 2), round(v_app.amount, 2);
  end if;

  if not exists (select 1 from public.student_profiles
                  where user_id = v_app.user_id and verification_status = 'VERIFIED') then
    raise exception 'The student is no longer verified, so this cannot be disbursed';
  end if;
  if not exists (select 1 from public.users where id = v_app.user_id and status = 'ACTIVE') then
    raise exception 'The student''s account is suspended, so this cannot be disbursed';
  end if;

  select * into v_loan from public.loans where application_id = v_app.id for update;

  if v_loan.id is null then
    insert into public.loans
      (application_id, user_id, principal_amount, outstanding_balance, status,
       disbursed_by, disbursed_at, total_interest, total_repayable)
    values
      (v_app.id, v_app.user_id, v_terms.principal_amount, v_terms.total_repayable, 'ACTIVE',
       auth.uid(), v_disbursed_at, v_terms.total_interest, v_terms.total_repayable)
    returning * into v_loan;
  else
    if v_loan.status = 'CLOSED' then
      raise exception 'This loan is closed and cannot accept another tranche';
    end if;
    if v_loan.status = 'PAID_OFF' then
      raise exception 'This loan is paid off. A new tranche cannot be added after payoff.';
    end if;

    if v_loan.status = 'VOIDED' then
      -- The previous tranche was voided and the loan row is the historical shell. Reset it to the
      -- tranche being paid out now.
      update public.loans
         set principal_amount = v_terms.principal_amount,
             outstanding_balance = v_terms.total_repayable,
             total_interest = v_terms.total_interest,
             total_repayable = v_terms.total_repayable,
             amount_verified = 0,
             amount_pending = 0,
             status = 'ACTIVE',
             disbursed_by = auth.uid(),
             disbursed_at = v_disbursed_at,
             paid_off_at = null,
             closed_at = null,
             closed_by = null
       where id = v_loan.id
       returning * into v_loan;
    else
      update public.loans
         set principal_amount = principal_amount + v_terms.principal_amount,
             outstanding_balance = outstanding_balance + v_terms.total_repayable,
             total_interest = total_interest + v_terms.total_interest,
             total_repayable = total_repayable + v_terms.total_repayable,
             status = 'ACTIVE'
       where id = v_loan.id
       returning * into v_loan;
    end if;
  end if;

  insert into public.disbursements
    (application_id, loan_id, terms_id, tranche_no, amount, channel, reference, proof_path,
     status, disbursed_by, disbursed_at, idempotency_key)
  values
    (v_app.id, v_loan.id, p_terms_id, v_terms.tranche_no, v_terms.principal_amount,
     v_channel, v_reference, v_proof, 'RECORDED', auth.uid(), v_disbursed_at, v_key)
  returning id into v_disbursement_id;

  -- One schedule per tranche, dated from this tranche's own disbursement.
  for v_scheduled in
    select * from public.amortization_schedule(v_terms.principal_amount, v_terms.annual_rate, v_terms.period_months)
  loop
    insert into public.loan_installments
      (loan_id, terms_id, tranche_no, seq, due_date, amount_due, amount_paid, status,
       opening_balance, interest_amount, principal_amount, closing_balance)
    values
      (v_loan.id, p_terms_id, v_terms.tranche_no, v_scheduled.seq,
       (v_disbursed_at + make_interval(months => v_scheduled.seq))::date,
       v_scheduled.installment_amount, 0, 'PENDING',
       v_scheduled.opening_balance, v_scheduled.interest_amount,
       v_scheduled.principal_amount, v_scheduled.closing_balance);
  end loop;

  update public.loan_terms set status = 'DISBURSED' where id = p_terms_id;
  update public.loan_applications set status = 'DISBURSED' where id = v_app.id;

  perform public.rebuild_loan_payments_internal(v_loan.id);

  perform public.log_financial_event(
    'disbursements', v_disbursement_id::text, 'DISBURSEMENT_RECORDED', null, null,
    jsonb_build_object('application_id', v_app.id, 'loan_id', v_loan.id,
                       'terms_id', p_terms_id, 'tranche_no', v_terms.tranche_no,
                       'amount', v_terms.principal_amount, 'channel', v_channel,
                       'reference', v_reference),
    jsonb_build_object('annuity', v_terms.installment_amount, 'period_months', v_terms.period_months,
                       'annual_rate', v_terms.annual_rate));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_TRANCHE_DISBURSED', 'disbursements', v_disbursement_id::text,
          jsonb_build_object('application_id', v_app.id, 'loan_id', v_loan.id,
                             'tranche_no', v_terms.tranche_no, 'amount', v_terms.principal_amount,
                             'channel', v_channel, 'reference', v_reference));

  return v_disbursement_id;
end $$;
revoke all on function public.disburse_tranche(uuid,text,text,text,text,boolean) from public;
grant execute on function public.disburse_tranche(uuid,text,text,text,text,boolean) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 4. submit_repayment(): record money, but do not allocate it yet.
--
--    The old function allocated immediately. That made a collection officer's typo an immediate
--    change to the debt. Now the entry sits in PENDING_VERIFICATION until a different officer has
--    checked the cash, the mobile-money message or the bank statement.
-- ---------------------------------------------------------------------------------------
create or replace function public.submit_repayment(
  p_loan_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null,
  p_proof_path text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_loan public.loans%rowtype;
  v_existing uuid;
  v_id uuid;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_method text := upper(trim(coalesce(p_method, '')));
  v_reference text := nullif(trim(coalesce(p_reference, '')), '');
  v_proof text := nullif(trim(coalesce(p_proof_path, '')), '');
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_outstanding numeric;
  v_pending numeric;
  v_terms uuid;
  v_tranche integer;
begin
  if not exists (
    select 1 from public.users
     where id = auth.uid()
       and role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and status = 'ACTIVE'
  ) then
    raise exception 'Only a collection officer, accountant or manager can record a repayment';
  end if;
  if v_amount <= 0 then raise exception 'Enter an amount greater than zero'; end if;
  if v_method not in ('CASH','MOBILE_MONEY','BANK_TRANSFER') then raise exception 'Choose a valid payment method'; end if;
  if v_reference is not null and length(v_reference) > 120 then raise exception 'The reference is too long'; end if;
  if v_method <> 'CASH' and v_reference is null then
    raise exception 'Enter the transaction reference for this % payment', lower(v_method);
  end if;
  if v_method <> 'CASH' and v_proof is null then
    raise exception 'Attach proof of payment for this % payment', lower(v_method);
  end if;
  if v_proof is not null and not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'payment-proofs'
       and o.name = v_proof
       and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then
    raise exception 'That proof of payment could not be found in your upload folder. Upload it again.';
  end if;

  select * into v_loan from public.loans where id = p_loan_id for update;
  if v_loan.id is null then raise exception 'Loan not found'; end if;
  if v_loan.status not in ('ACTIVE','DEFAULTED') then
    raise exception 'This loan is % and cannot accept repayments', v_loan.status;
  end if;

  if v_key is not null then
    select id into v_existing from public.repayments where idempotency_key = v_key;
    if v_existing is not null then return v_existing; end if;
  end if;

  if v_reference is not null and v_method in ('MOBILE_MONEY','BANK_TRANSFER') and exists (
    select 1 from public.repayments
     where lower(btrim(reference)) = lower(v_reference)
       and method in ('MOBILE_MONEY','BANK_TRANSFER')
       and status not in ('REJECTED','REVERSED')
  ) then
    raise exception 'Reference "%" is already recorded against a repayment. Check for a duplicate entry.', v_reference;
  end if;

  select coalesce(sum(amount_due - amount_paid), 0) into v_outstanding
    from public.loan_installments
   where loan_id = p_loan_id and voided_at is null;
  if v_outstanding <= 0 then raise exception 'This loan has nothing left to repay'; end if;

  select coalesce(sum(amount), 0) into v_pending
    from public.repayments
   where loan_id = p_loan_id and status = 'PENDING_VERIFICATION' and reversed_at is null;
  if v_amount > round(v_outstanding - v_pending, 2) then
    raise exception 'This repayment (%) is more than the % still outstanding after pending entries. Split the payment or wait for verification.',
      v_amount, round(v_outstanding - v_pending, 2);
  end if;

  select i.terms_id, i.tranche_no into v_terms, v_tranche
    from public.loan_installments i
   where i.loan_id = p_loan_id and i.voided_at is null and i.amount_paid < i.amount_due
   order by i.tranche_no, i.due_date, i.seq
   limit 1;

  insert into public.repayments
    (loan_id, amount, method, reference, recorded_by, paid_at, status,
     submitted_by, submitted_at, terms_id, tranche_no, proof_path, idempotency_key)
  values
    (p_loan_id, v_amount, v_method, v_reference, auth.uid(), now(), 'PENDING_VERIFICATION',
     auth.uid(), now(), v_terms, v_tranche, v_proof, v_key)
  returning id into v_id;

  perform public.rebuild_loan_payments_internal(p_loan_id);

  perform public.log_financial_event(
    'repayments', v_id::text, 'REPAYMENT_SUBMITTED', null, null,
    jsonb_build_object('loan_id', p_loan_id, 'amount', v_amount, 'method', v_method,
                       'reference', v_reference, 'status', 'PENDING_VERIFICATION'),
    jsonb_build_object('submitted_by', auth.uid()));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'REPAYMENT_SUBMITTED', 'repayments', v_id::text,
          jsonb_build_object('loan_id', p_loan_id, 'amount', v_amount, 'method', v_method,
                             'reference', v_reference));

  return v_id;
end $$;
revoke all on function public.submit_repayment(uuid,numeric,text,text,text,text) from public;
grant execute on function public.submit_repayment(uuid,numeric,text,text,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 5. verify_repayment(): the second pair of eyes.
--
--    ABSOLUTE RULE: the officer who submitted the payment can never verify it. Not with a flag, not
--    with a role, not as SUPER_ADMIN. If the same person must act, a different officer has to take
--    the handover. This is the control the two-person requirement exists for.
--
--    For an early settlement, the unearned interest is written off before the allocation runs. The
--    cuts are stored so a later reversal can put the schedule back.
-- ---------------------------------------------------------------------------------------
create or replace function public.verify_repayment(
  p_repayment_id uuid,
  p_comment text default null,
  p_confirm boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_rep public.repayments%rowtype;
  v_before jsonb;
  v_loan public.loans%rowtype;
  v_remaining numeric;
  v_unpaid_interest numeric;
  v_cut numeric;
  v_adj jsonb := '[]'::jsonb;
  ins record;
  v_outstanding numeric;
begin
  if not coalesce(p_confirm, false) then
    raise exception 'Confirm that you have checked this payment against the cash or bank record';
  end if;
  if not exists (
    select 1 from public.users
     where id = auth.uid() and role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and status = 'ACTIVE'
  ) then
    raise exception 'Only an accountant, manager or super admin can verify a repayment';
  end if;

  select * into v_rep from public.repayments where id = p_repayment_id for update;
  if v_rep.id is null then raise exception 'Repayment not found'; end if;
  if v_rep.status <> 'PENDING_VERIFICATION' then
    raise exception 'This repayment is % and cannot be verified again', v_rep.status;
  end if;
  if v_rep.reversed_at is not null then
    raise exception 'This repayment was reversed and cannot be verified';
  end if;
  if v_rep.submitted_by = auth.uid() or v_rep.recorded_by = auth.uid() then
    raise exception 'You cannot verify a repayment you submitted yourself — a different officer must check it';
  end if;

  select * into v_loan from public.loans where id = v_rep.loan_id for update;
  if v_loan.id is null then raise exception 'Loan not found'; end if;
  if v_loan.status not in ('ACTIVE','DEFAULTED') then
    raise exception 'This loan is % and cannot accept a verified repayment', v_loan.status;
  end if;

  select to_jsonb(r) into v_before from public.repayments r where r.id = p_repayment_id;

  if v_rep.is_settlement and coalesce(v_rep.waived_interest, 0) > 0 then
    v_remaining := round(v_rep.waived_interest, 2);
    for ins in
      select i.id, i.amount_due, i.amount_paid, i.interest_amount
        from public.loan_installments i
       where i.loan_id = v_rep.loan_id
         and i.voided_at is null
         and i.amount_due > i.amount_paid
       order by i.tranche_no desc, i.seq desc
    loop
      exit when v_remaining <= 0;
      v_unpaid_interest := greatest(coalesce(ins.interest_amount, 0) - ins.amount_paid, 0);
      v_cut := least(ins.amount_due - ins.amount_paid, v_remaining, v_unpaid_interest);
      if v_cut > 0 then
        update public.loan_installments
           set amount_due = amount_due - v_cut,
               interest_amount = greatest(coalesce(interest_amount, 0) - v_cut, 0),
               updated_at = now()
         where id = ins.id;
        v_adj := v_adj || jsonb_build_object('installment_id', ins.id, 'cut', v_cut);
        v_remaining := round(v_remaining - v_cut, 2);
      end if;
    end loop;
    if v_remaining > 0 then
      raise exception 'This schedule has no interest left to write off. The settlement quote is stale; ask for a new one.';
    end if;
  end if;

  update public.repayments
     set status = 'VERIFIED',
         verified_by = auth.uid(),
         verified_at = now(),
         verification_note = nullif(trim(coalesce(p_comment, '')), ''),
         settlement_adjustments = case when v_rep.is_settlement then v_adj else settlement_adjustments end
   where id = p_repayment_id
   returning * into v_rep;

  perform public.rebuild_loan_payments_internal(v_rep.loan_id);

  if v_rep.is_settlement then
    select outstanding_balance into v_outstanding from public.loans where id = v_rep.loan_id;
    if v_outstanding > 0.01 then
      raise exception 'The settlement payment did not clear the loan (% still outstanding). Ask for a fresh settlement quote.', v_outstanding;
    end if;
  end if;

  perform public.log_financial_event(
    'repayments', p_repayment_id::text, 'REPAYMENT_VERIFIED', p_comment, v_before, to_jsonb(v_rep),
    jsonb_build_object('loan_id', v_rep.loan_id, 'settlement', v_rep.is_settlement,
                       'waived_interest', v_rep.waived_interest));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'REPAYMENT_VERIFIED', 'repayments', p_repayment_id::text,
          jsonb_build_object('loan_id', v_rep.loan_id, 'amount', v_rep.amount,
                             'settlement', v_rep.is_settlement));
end $$;
revoke all on function public.verify_repayment(uuid,text,boolean) from public;
grant execute on function public.verify_repayment(uuid,text,boolean) to authenticated;


create or replace function public.reject_repayment(p_repayment_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_rep public.repayments%rowtype;
  v_before jsonb;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Say why this repayment is being rejected — the submitter is shown it';
  end if;
  if not exists (
    select 1 from public.users
     where id = auth.uid() and role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and status = 'ACTIVE'
  ) then
    raise exception 'Only an accountant, manager or super admin can reject a repayment';
  end if;

  select * into v_rep from public.repayments where id = p_repayment_id for update;
  if v_rep.id is null then raise exception 'Repayment not found'; end if;
  if v_rep.status <> 'PENDING_VERIFICATION' then
    raise exception 'This repayment is % and cannot be rejected now', v_rep.status;
  end if;
  if v_rep.submitted_by = auth.uid() or v_rep.recorded_by = auth.uid() then
    raise exception 'You cannot reject a repayment you submitted yourself — a different officer must decide it';
  end if;

  select to_jsonb(r) into v_before from public.repayments r where r.id = p_repayment_id;

  update public.repayments
     set status = 'REJECTED',
         verified_by = auth.uid(),
         verified_at = now(),
         verification_note = trim(p_reason)
   where id = p_repayment_id
   returning * into v_rep;

  perform public.rebuild_loan_payments_internal(v_rep.loan_id);

  perform public.log_financial_event(
    'repayments', p_repayment_id::text, 'REPAYMENT_REJECTED', p_reason, v_before, to_jsonb(v_rep),
    jsonb_build_object('loan_id', v_rep.loan_id));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'REPAYMENT_REJECTED', 'repayments', p_repayment_id::text,
          jsonb_build_object('loan_id', v_rep.loan_id, 'amount', v_rep.amount, 'reason', trim(p_reason)));
end $$;
revoke all on function public.reject_repayment(uuid,text) from public;
grant execute on function public.reject_repayment(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 6. reverse_repayment(): correct a verified payment without deleting the evidence.
--
--    Finance or management only. The officer who submitted or verified the payment cannot reverse
--    it. A settlement reversal restores the interest that was written off, using the stored cuts.
-- ---------------------------------------------------------------------------------------
create or replace function public.reverse_repayment(p_repayment_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_rep public.repayments%rowtype;
  v_before jsonb;
  v_loan public.loans%rowtype;
  adj jsonb;
begin
  if not exists (
    select 1 from public.users
     where id = auth.uid() and role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and status = 'ACTIVE'
  ) then
    raise exception 'Only an accountant, manager or super admin can reverse a repayment';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for the reversal — it is kept in the audit trail';
  end if;

  select * into v_rep from public.repayments where id = p_repayment_id for update;
  if v_rep.id is null then raise exception 'Repayment not found'; end if;
  if v_rep.reversed_at is not null then
    raise exception 'This repayment was already reversed on %', v_rep.reversed_at;
  end if;
  if v_rep.status <> 'VERIFIED' then
    raise exception 'Only a verified repayment can be reversed. This one is %.', v_rep.status;
  end if;
  if v_rep.submitted_by = auth.uid() or v_rep.verified_by = auth.uid() or v_rep.recorded_by = auth.uid() then
    raise exception 'You cannot reverse a repayment you submitted, verified or recorded — another officer must do it';
  end if;

  select * into v_loan from public.loans where id = v_rep.loan_id for update;
  if v_loan.id is null then raise exception 'Loan not found'; end if;
  if v_loan.status in ('CLOSED','VOIDED') then
    raise exception 'This loan is % and its ledger can no longer be reversed through this function', v_loan.status;
  end if;

  select to_jsonb(r) into v_before from public.repayments r where r.id = p_repayment_id;

  -- Put back any interest that the settlement wrote off.
  if v_rep.settlement_adjustments is not null then
    for adj in select value from jsonb_array_elements(v_rep.settlement_adjustments) loop
      update public.loan_installments
         set amount_due = amount_due + coalesce((adj->>'cut')::numeric, 0),
             interest_amount = coalesce(interest_amount, 0) + coalesce((adj->>'cut')::numeric, 0),
             updated_at = now()
       where id = (adj->>'installment_id')::uuid
         and loan_id = v_rep.loan_id
         and voided_at is null;
    end loop;
  end if;

  update public.repayments
     set status = 'REVERSED',
         reversed_at = now(),
         reversed_by = auth.uid(),
         reversal_reason = trim(p_reason)
   where id = p_repayment_id
   returning * into v_rep;

  perform public.rebuild_loan_payments_internal(v_rep.loan_id);

  perform public.log_financial_event(
    'repayments', p_repayment_id::text, 'REPAYMENT_REVERSED', p_reason, v_before, to_jsonb(v_rep),
    jsonb_build_object('loan_id', v_rep.loan_id, 'restored_adjustments', v_rep.settlement_adjustments));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'REPAYMENT_REVERSED', 'repayments', p_repayment_id::text,
          jsonb_build_object('loan_id', v_rep.loan_id, 'amount', v_rep.amount, 'reason', trim(p_reason)));
end $$;
revoke all on function public.reverse_repayment(uuid,text) from public;
grant execute on function public.reverse_repayment(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 7. loan_settlement_quote(): principal outstanding + interest accrued to today.
--
--    The quote is deliberately not "everything left on the schedule". Most of that is future
--    interest the student has not had the use of the money for yet. The schedule keeps its
--    contractual shape; a settlement writes off only the unearned portion.
-- ---------------------------------------------------------------------------------------
create or replace function public.loan_settlement_quote(p_loan_id uuid)
returns table (
  loan_id uuid,
  principal_outstanding numeric,
  accrued_interest numeric,
  settlement_amount numeric,
  scheduled_outstanding numeric,
  as_of date
)
language plpgsql security definer set search_path = public stable as $$
declare
  v_owner uuid;
  v_principal numeric := 0;
  v_principal_paid numeric := 0;
  v_accrued numeric := 0;
  v_scheduled numeric := 0;
  v_fraction numeric;
  v_period_start date;
  v_period_days integer;
  v_days_elapsed integer;
  v_accrued_for numeric;
  v_paid_interest numeric;
  ins record;
begin
  select l.user_id into v_owner from public.loans l where l.id = p_loan_id;
  if v_owner is null then raise exception 'Loan not found'; end if;

  if not (
    v_owner = auth.uid()
    or exists (
      select 1 from public.users u
       where u.id = auth.uid()
         and u.role in ('ACCOUNTANT','COLLECTION_OFFICER','LOAN_OFFICER','MANAGER','SUPER_ADMIN')
         and u.status = 'ACTIVE'
    )
  ) then
    raise exception 'You cannot see this loan';
  end if;

  for ins in
    select i.principal_amount, i.interest_amount, i.amount_due, i.amount_paid, i.due_date
      from public.loan_installments i
     where i.loan_id = p_loan_id and i.voided_at is null
     order by i.tranche_no, i.seq
  loop
    -- Legacy schedules predate per-installment principal/interest columns. When those are null,
    -- treat the scheduled amount as principal so a quote is still produced instead of zero.
    v_principal := v_principal + coalesce(ins.principal_amount, ins.amount_due, 0);
    v_principal_paid := v_principal_paid
      + least(coalesce(ins.principal_amount, ins.amount_due, 0),
              greatest(ins.amount_paid - coalesce(ins.interest_amount, 0), 0));
    v_scheduled := v_scheduled + (ins.amount_due - ins.amount_paid);

    v_period_start := (ins.due_date - interval '1 month')::date;
    v_period_days := greatest((ins.due_date - v_period_start), 1);
    v_days_elapsed := greatest(current_date - v_period_start, 0);
    v_fraction := least(v_days_elapsed::numeric / v_period_days, 1);
    v_accrued_for := round(coalesce(ins.interest_amount, 0) * v_fraction, 2);
    v_paid_interest := least(ins.amount_paid, coalesce(ins.interest_amount, 0));
    v_accrued := v_accrued + greatest(v_accrued_for - v_paid_interest, 0);
  end loop;

  return query select
    p_loan_id,
    round(greatest(v_principal - v_principal_paid, 0), 2),
    round(v_accrued, 2),
    round(greatest(v_principal - v_principal_paid, 0) + v_accrued, 2),
    round(v_scheduled, 2),
    current_date;
end $$;
revoke all on function public.loan_settlement_quote(uuid) from public;
grant execute on function public.loan_settlement_quote(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 8. submit_loan_settlement(): submit, do not verify.
--
--    It is still a repayment, so it still needs a different officer to verify it. The stored
--    waiver is what the verifier checks, and what a reversal later restores.
-- ---------------------------------------------------------------------------------------
create or replace function public.submit_loan_settlement(
  p_loan_id uuid,
  p_method text,
  p_reference text default null,
  p_proof_path text default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_loan public.loans%rowtype;
  v_quote record;
  v_existing uuid;
  v_id uuid;
  v_method text := upper(trim(coalesce(p_method, '')));
  v_reference text := nullif(trim(coalesce(p_reference, '')), '');
  v_proof text := nullif(trim(coalesce(p_proof_path, '')), '');
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_waived numeric;
  v_terms uuid;
  v_tranche integer;
begin
  if not exists (
    select 1 from public.users
     where id = auth.uid()
       and role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and status = 'ACTIVE'
  ) then
    raise exception 'Only a collection officer, accountant or manager can record a settlement';
  end if;
  if v_method not in ('CASH','MOBILE_MONEY','BANK_TRANSFER') then raise exception 'Choose a valid payment method'; end if;
  if v_reference is not null and length(v_reference) > 120 then raise exception 'The reference is too long'; end if;
  if v_method <> 'CASH' and v_reference is null then
    raise exception 'Enter the transaction reference for this % payment', lower(v_method);
  end if;
  if v_method <> 'CASH' and v_proof is null then
    raise exception 'Attach proof of payment for this % payment', lower(v_method);
  end if;
  if v_proof is not null and not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'payment-proofs'
       and o.name = v_proof
       and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then
    raise exception 'That proof of payment could not be found in your upload folder. Upload it again.';
  end if;

  select * into v_loan from public.loans where id = p_loan_id for update;
  if v_loan.id is null then raise exception 'Loan not found'; end if;
  if v_loan.status not in ('ACTIVE','DEFAULTED') then
    raise exception 'This loan is % and cannot be settled', v_loan.status;
  end if;
  if exists (select 1 from public.repayments
              where loan_id = p_loan_id and status = 'PENDING_VERIFICATION' and reversed_at is null) then
    raise exception 'This loan has a payment waiting for verification. Decide that first.';
  end if;

  if v_key is not null then
    select id into v_existing from public.repayments where idempotency_key = v_key;
    if v_existing is not null then return v_existing; end if;
  end if;

  select * into v_quote from public.loan_settlement_quote(p_loan_id);
  if coalesce(v_quote.settlement_amount, 0) <= 0 then
    raise exception 'There is nothing left to settle on this loan';
  end if;
  v_waived := round(v_quote.scheduled_outstanding - v_quote.settlement_amount, 2);
  if v_waived < 0 then raise exception 'The settlement quote is inconsistent; try again later'; end if;

  if v_reference is not null and v_method in ('MOBILE_MONEY','BANK_TRANSFER') and exists (
    select 1 from public.repayments
     where lower(btrim(reference)) = lower(v_reference)
       and method in ('MOBILE_MONEY','BANK_TRANSFER')
       and status not in ('REJECTED','REVERSED')
  ) then
    raise exception 'Reference "%" is already recorded against a repayment. Check for a duplicate entry.', v_reference;
  end if;

  select i.terms_id, i.tranche_no into v_terms, v_tranche
    from public.loan_installments i
   where i.loan_id = p_loan_id and i.voided_at is null and i.amount_paid < i.amount_due
   order by i.tranche_no, i.due_date, i.seq
   limit 1;

  insert into public.repayments
    (loan_id, amount, method, reference, recorded_by, paid_at, status,
     submitted_by, submitted_at, terms_id, tranche_no, proof_path, idempotency_key,
     is_settlement, waived_interest, settlement_principal, settlement_interest)
  values
    (p_loan_id, v_quote.settlement_amount, v_method, v_reference, auth.uid(), now(),
     'PENDING_VERIFICATION', auth.uid(), now(), v_terms, v_tranche, v_proof, v_key,
     true, v_waived, v_quote.principal_outstanding, v_quote.accrued_interest)
  returning id into v_id;

  perform public.rebuild_loan_payments_internal(p_loan_id);

  perform public.log_financial_event(
    'repayments', v_id::text, 'SETTLEMENT_SUBMITTED', null, null,
    jsonb_build_object('loan_id', p_loan_id, 'amount', v_quote.settlement_amount,
                       'principal', v_quote.principal_outstanding,
                       'accrued_interest', v_quote.accrued_interest,
                       'waived_interest', v_waived, 'status', 'PENDING_VERIFICATION'),
    jsonb_build_object('submitted_by', auth.uid(), 'scheduled_outstanding', v_quote.scheduled_outstanding));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_SETTLEMENT_SUBMITTED', 'repayments', v_id::text,
          jsonb_build_object('loan_id', p_loan_id, 'amount', v_quote.settlement_amount,
                             'waived_interest', v_waived));

  return v_id;
end $$;
revoke all on function public.submit_loan_settlement(uuid,text,text,text,text) from public;
grant execute on function public.submit_loan_settlement(uuid,text,text,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 9. void_disbursement(): unwind a tranche without deleting the record of it.
--
--    The old version deleted the loan, the schedule and every installment. That is forbidden now:
--    a disbursement is evidence that money left, and the correction has to remain visible. It is
--    refused while any live repayment exists. Reversed repayments are fine.
-- ---------------------------------------------------------------------------------------
create or replace function public.void_disbursement(p_loan_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_disb public.disbursements%rowtype;
  v_loan public.loans%rowtype;
  v_before jsonb;
  v_count bigint;
  v_principal numeric;
  v_interest numeric;
  v_repayable numeric;
begin
  if not exists (
    select 1 from public.users
     where id = auth.uid() and role in ('MANAGER','SUPER_ADMIN') and status = 'ACTIVE'
  ) then
    raise exception 'Only a manager or super admin can void a disbursement';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for the void — it is kept in the audit trail';
  end if;

  select * into v_loan from public.loans where id = p_loan_id for update;
  if v_loan.id is null then raise exception 'Loan not found'; end if;
  if v_loan.status in ('CLOSED','VOIDED') then
    raise exception 'This loan is % and cannot be voided again', v_loan.status;
  end if;

  select * into v_disb from public.disbursements
   where loan_id = p_loan_id and status = 'RECORDED'
   order by tranche_no desc, disbursed_at desc
   limit 1
   for update;
  if v_disb.id is null then
    raise exception 'This loan has no recorded tranche to void. Legacy loans need the Super Admin reconciliation path.';
  end if;

  if exists (
    select 1 from public.repayments
     where loan_id = p_loan_id and reversed_at is null
       and status in ('PENDING_VERIFICATION','VERIFIED')
  ) then
    raise exception 'There is a live repayment against this loan. Reverse it before voiding the disbursement.';
  end if;

  select to_jsonb(d) into v_before from public.disbursements d where d.id = v_disb.id;

  update public.disbursements
     set status = 'VOIDED', voided_by = auth.uid(), voided_at = now(), void_reason = trim(p_reason)
   where id = v_disb.id;
  update public.loan_terms set status = 'VOIDED' where id = v_disb.terms_id and status <> 'VOIDED';
  update public.loan_installments
     set status = 'VOIDED', voided_at = now(), updated_at = now()
   where loan_id = p_loan_id and tranche_no = v_disb.tranche_no and voided_at is null;

  select count(*), coalesce(sum(d.amount), 0), coalesce(sum(t.total_interest), 0),
         coalesce(sum(t.total_repayable), 0)
    into v_count, v_principal, v_interest, v_repayable
    from public.disbursements d
    join public.loan_terms t on t.id = d.terms_id
   where d.loan_id = p_loan_id and d.status = 'RECORDED';

  if v_count = 0 then
    update public.loans
       set status = 'VOIDED', outstanding_balance = 0,
           amount_verified = 0, amount_pending = 0
     where id = p_loan_id;
    update public.loan_applications set status = 'PENDING_ACCOUNTANT' where id = v_loan.application_id;
  else
    update public.loans
       set principal_amount = v_principal,
           total_interest = v_interest,
           total_repayable = v_repayable,
           status = 'ACTIVE'
     where id = p_loan_id;
    perform public.rebuild_loan_payments_internal(p_loan_id);
    update public.loan_applications set status = 'DISBURSED' where id = v_loan.application_id;
  end if;

  perform public.log_financial_event(
    'disbursements', v_disb.id::text, 'DISBURSEMENT_VOIDED', p_reason, v_before, null,
    jsonb_build_object('loan_id', p_loan_id, 'tranche_no', v_disb.tranche_no,
                       'amount', v_disb.amount));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_DISBURSEMENT_VOIDED', 'disbursements', v_disb.id::text,
          jsonb_build_object('loan_id', p_loan_id, 'tranche_no', v_disb.tranche_no,
                             'amount', v_disb.amount, 'reason', trim(p_reason)));
end $$;
revoke all on function public.void_disbursement(uuid,text) from public;
grant execute on function public.void_disbursement(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 10. close_loan(): the accountant's final reconciliation.
--
--     PAID_OFF means the schedule is settled. CLOSED means a human has checked the file, recorded
--     what was collected and closed it. Only the accountant (or super admin) performs this.
-- ---------------------------------------------------------------------------------------
create or replace function public.close_loan(p_loan_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_loan public.loans%rowtype;
  v_principal numeric;
  v_interest numeric;
  v_collected numeric;
  v_existing uuid;
begin
  if not exists (
    select 1 from public.users
     where id = auth.uid() and role in ('ACCOUNTANT','SUPER_ADMIN') and status = 'ACTIVE'
  ) then
    raise exception 'Only an accountant or super admin can close a reconciled loan';
  end if;

  select * into v_loan from public.loans where id = p_loan_id for update;
  if v_loan.id is null then raise exception 'Loan not found'; end if;
  if v_loan.status = 'CLOSED' then raise exception 'This loan is already closed'; end if;
  if v_loan.status <> 'PAID_OFF' or v_loan.outstanding_balance > 0.01 then
    raise exception 'This loan is % with % outstanding. It cannot be closed until it is paid off.',
      v_loan.status, v_loan.outstanding_balance;
  end if;

  if exists (select 1 from public.repayments
              where loan_id = p_loan_id and status = 'PENDING_VERIFICATION' and reversed_at is null) then
    raise exception 'There is a payment waiting for verification. Decide it before closing the loan.';
  end if;
  if exists (select 1 from public.loan_terms
              where application_id = v_loan.application_id
                and status in ('DRAFT_TERMS','PENDING_MANAGER_TERMS','APPROVED_TERMS','ACCEPTED_BY_STUDENT')) then
    raise exception 'There are terms still in progress on this application. Finish or void them before closing.';
  end if;

  select id into v_existing from public.loan_closures where loan_id = p_loan_id;
  if v_existing is not null then raise exception 'This loan already has a reconciliation record'; end if;

  select coalesce(sum(amount), 0) into v_principal
    from public.disbursements where loan_id = p_loan_id and status = 'RECORDED';
  select coalesce(sum(t.total_interest), 0) into v_interest
    from public.disbursements d join public.loan_terms t on t.id = d.terms_id
   where d.loan_id = p_loan_id and d.status = 'RECORDED';
  select coalesce(sum(amount), 0) into v_collected
    from public.repayments
   where loan_id = p_loan_id and status = 'VERIFIED' and reversed_at is null;

  insert into public.loan_closures
    (loan_id, closed_by, reconciled_principal, reconciled_interest, total_collected, note)
  values
    (p_loan_id, auth.uid(), v_principal, v_interest, v_collected,
     nullif(trim(coalesce(p_note, '')), ''));

  update public.loans
     set status = 'CLOSED', closed_at = now(), closed_by = auth.uid()
   where id = p_loan_id;
  update public.loan_applications set status = 'CLOSED' where id = v_loan.application_id;

  perform public.log_financial_event(
    'loans', p_loan_id::text, 'LOAN_CLOSED', p_note,
    jsonb_build_object('status', v_loan.status, 'outstanding', v_loan.outstanding_balance),
    jsonb_build_object('status', 'CLOSED', 'principal', v_principal, 'interest', v_interest,
                       'collected', v_collected),
    jsonb_build_object('application_id', v_loan.application_id));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_CLOSED', 'loans', p_loan_id::text,
          jsonb_build_object('application_id', v_loan.application_id,
                             'principal', v_principal, 'interest', v_interest,
                             'collected', v_collected, 'note', nullif(trim(coalesce(p_note, '')), '')));
end $$;
revoke all on function public.close_loan(uuid,text) from public;
grant execute on function public.close_loan(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 11. Super Admin ledger override.
--
--     The requirement is not "no edits". It is "no invisible edits". This function is the only
--     way to change a repayment amount after it has been recorded, it demands a reason, and it
--     writes both the before and after snapshot to financial_audit_events. It never deletes.
-- ---------------------------------------------------------------------------------------
create or replace function public.super_admin_amend_repayment(
  p_repayment_id uuid, p_amount numeric, p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_rep public.repayments%rowtype;
  v_before jsonb;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_scheduled numeric;
begin
  if not exists (
    select 1 from public.users
     where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE'
  ) then
    raise exception 'Only a super admin can amend a recorded repayment';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give a full reason for the amendment — it is kept in the immutable audit trail';
  end if;
  if v_amount <= 0 then raise exception 'The amended amount must be greater than zero'; end if;

  select * into v_rep from public.repayments where id = p_repayment_id for update;
  if v_rep.id is null then raise exception 'Repayment not found'; end if;
  if v_rep.reversed_at is not null then raise exception 'A reversed repayment cannot be amended'; end if;
  if v_rep.status <> 'VERIFIED' then
    raise exception 'Only a verified repayment can be amended. This one is %.', v_rep.status;
  end if;

  select coalesce(sum(amount_due - amount_paid), 0) into v_scheduled
    from public.loan_installments
   where loan_id = v_rep.loan_id and voided_at is null;
  if v_amount > v_scheduled + v_rep.amount then
    raise exception 'The amended amount (%) would overpay the loan', v_amount;
  end if;

  select to_jsonb(r) into v_before from public.repayments r where r.id = p_repayment_id;

  update public.repayments set amount = v_amount where id = p_repayment_id
   returning * into v_rep;

  perform public.rebuild_loan_payments_internal(v_rep.loan_id);

  perform public.log_financial_event(
    'repayments', p_repayment_id::text, 'SUPER_ADMIN_AMENDMENT', p_reason, v_before, to_jsonb(v_rep),
    jsonb_build_object('loan_id', v_rep.loan_id));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'SUPER_ADMIN_REPAYMENT_AMENDED', 'repayments', p_repayment_id::text,
          jsonb_build_object('loan_id', v_rep.loan_id, 'amount', v_amount, 'reason', trim(p_reason)));
end $$;
revoke all on function public.super_admin_amend_repayment(uuid,numeric,text) from public;
grant execute on function public.super_admin_amend_repayment(uuid,numeric,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 12. The legacy bypasses are closed.
-- ---------------------------------------------------------------------------------------
create or replace function public.disburse_loan(p_application_id uuid, p_amount numeric)
returns uuid
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Loans are disbursed per approved tranche now. Use disburse_tranche() after the manager approves the terms and the student accepts them.';
end $$;
revoke all on function public.disburse_loan(uuid,numeric) from public;
grant execute on function public.disburse_loan(uuid,numeric) to authenticated;

create or replace function public.record_repayment(
  p_loan_id uuid, p_amount numeric, p_method text, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Repayments are submitted for verification now. Use submit_repayment(); a different officer must verify it.';
end $$;
revoke all on function public.record_repayment(uuid,numeric,text,text) from public;
grant execute on function public.record_repayment(uuid,numeric,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 13. Reading the schedule and the queues.
-- ---------------------------------------------------------------------------------------
-- The return type gains the tranche and the interest/principal breakdown, so the old function has
-- to be dropped first (42P13). The grants are reapplied below.
drop function if exists public.get_loan_schedule(uuid);

create or replace function public.get_loan_schedule(p_loan_id uuid)
returns table (
  tranche_no integer, seq integer, due_date date, amount_due numeric, amount_paid numeric,
  amount_outstanding numeric, status text, days_overdue integer,
  opening_balance numeric, interest_amount numeric, principal_amount numeric, closing_balance numeric,
  terms_id uuid
) language plpgsql security definer set search_path = public stable as $$
declare v_owner uuid;
begin
  select l.user_id into v_owner from public.loans l where l.id = p_loan_id;
  if v_owner is null then raise exception 'Loan not found'; end if;
  if not (
    v_owner = auth.uid()
    or exists (
      select 1 from public.users u
       where u.id = auth.uid()
         and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
         and u.status = 'ACTIVE'
    )
  ) then
    raise exception 'You cannot see this loan';
  end if;

  return query
  select i.tranche_no, i.seq, i.due_date, i.amount_due, i.amount_paid,
         i.amount_due - i.amount_paid, i.status,
         greatest((current_date - i.due_date), 0),
         i.opening_balance, i.interest_amount, i.principal_amount, i.closing_balance, i.terms_id
    from public.loan_installments i
   where i.loan_id = p_loan_id and i.voided_at is null
   order by i.tranche_no, i.seq;
end $$;
revoke all on function public.get_loan_schedule(uuid) from public;
grant execute on function public.get_loan_schedule(uuid) to authenticated;


create or replace function public.list_arrears()
returns table (
  loan_id uuid, student_name text, university text, outstanding numeric,
  due_date date, days_overdue integer, installments_missed bigint, total_due numeric, amount_paid numeric
) language sql security definer set search_path = public stable as $$
  select l.id, sp.full_name, sp.university,
    coalesce((select sum(i.amount_due - i.amount_paid) from public.loan_installments i
              where i.loan_id = l.id and i.voided_at is null and i.amount_due > i.amount_paid), 0),
    min(i.due_date) filter (where i.amount_due > i.amount_paid and i.due_date <= current_date),
    greatest((current_date - min(i.due_date) filter (where i.amount_due > i.amount_paid and i.due_date <= current_date)), 0),
    count(*) filter (where i.amount_due > i.amount_paid and i.due_date <= current_date),
    coalesce(sum(i.amount_due), 0),
    coalesce(sum(i.amount_paid), 0)
  from public.loans l
  join public.student_profiles sp on sp.user_id = l.user_id
  join public.loan_installments i on i.loan_id = l.id
  where l.status in ('ACTIVE','DEFAULTED')
    and i.voided_at is null
    and i.amount_due > i.amount_paid
    and i.due_date <= current_date
    and exists (select 1 from public.users u where u.id = auth.uid()
      and u.role in ('COLLECTION_OFFICER','ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE')
  group by l.id, sp.full_name, sp.university
  order by min(i.due_date);
$$;
revoke all on function public.list_arrears() from public;
grant execute on function public.list_arrears() to authenticated;


create or replace function public.list_pending_repayments()
returns table (
  repayment_id uuid, loan_id uuid, application_id uuid, application_number text,
  student_name text, amount numeric, method text, reference text, proof_path text,
  submitted_by uuid, submitted_by_name text, submitted_at timestamptz,
  tranche_no integer, is_settlement boolean, waived_interest numeric
) language sql security definer set search_path = public stable as $$
  select r.id, r.loan_id, l.application_id, a.application_number,
         sp.full_name, r.amount, r.method, r.reference, r.proof_path,
         r.submitted_by, coalesce(submitter.full_name, su.email), r.submitted_at,
         r.tranche_no, r.is_settlement, r.waived_interest
    from public.repayments r
    join public.loans l on l.id = r.loan_id
    join public.loan_applications a on a.id = l.application_id
    join public.student_profiles sp on sp.user_id = l.user_id
    left join public.student_profiles submitter on submitter.user_id = r.submitted_by
    left join public.users su on su.id = r.submitted_by
   where r.status = 'PENDING_VERIFICATION'
     and r.reversed_at is null
     and exists (select 1 from public.users u where u.id = auth.uid()
       and u.role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE')
   order by r.submitted_at, r.id;
$$;
revoke all on function public.list_pending_repayments() from public;
grant execute on function public.list_pending_repayments() to authenticated;


create or replace function public.get_dashboard_stats()
returns table (
  total_students bigint, verified_students bigint, total_applications bigint, submitted_applications bigint,
  approved_applications bigint, total_disbursed numeric, total_collected numeric, outstanding_portfolio numeric, active_loans bigint,
  total_repayable numeric, interest_billed numeric, overdue_balance numeric, loans_in_arrears bigint
) language sql security definer set search_path = public stable as $$
  select
    (select count(*) from public.users where role = 'STUDENT' and status = 'ACTIVE'),
    (select count(*) from public.student_profiles where verification_status = 'VERIFIED'),
    (select count(*) from public.loan_applications),
    (select count(*) from public.loan_applications where status <> 'DRAFT'),
    (select count(*) from public.loan_applications
      where status in ('PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT','PENDING_TERMS_APPROVAL',
                       'TERMS_APPROVED','TERMS_ACCEPTED','DISBURSED','PAID_OFF','CLOSED','APPROVED')),
    (select coalesce(sum(principal_amount), 0) from public.loans where status <> 'VOIDED'),
    (select coalesce(sum(amount), 0) from public.repayments
      where status = 'VERIFIED' and reversed_at is null),
    (select coalesce(sum(outstanding_balance), 0) from public.loans
      where status in ('ACTIVE','DEFAULTED')),
    (select count(*) from public.loans where status in ('ACTIVE','DEFAULTED')),
    (select coalesce(sum(i.amount_due), 0) from public.loan_installments i where i.voided_at is null),
    (select coalesce(sum(i.amount_due), 0) from public.loan_installments i where i.voided_at is null)
      - (select coalesce(sum(principal_amount), 0) from public.loans where status <> 'VOIDED'),
    (select coalesce(sum(i.amount_due - i.amount_paid), 0)
       from public.loan_installments i
       join public.loans l on l.id = i.loan_id
      where l.status in ('ACTIVE','DEFAULTED')
        and i.voided_at is null
        and i.amount_due > i.amount_paid
        and i.due_date <= current_date),
    (select count(distinct i.loan_id)
       from public.loan_installments i
       join public.loans l on l.id = i.loan_id
      where l.status in ('ACTIVE','DEFAULTED')
        and i.voided_at is null
        and i.amount_due > i.amount_paid
        and i.due_date <= current_date)
  where exists (select 1 from public.users u where u.id = auth.uid()
    and u.role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE');
$$;
revoke all on function public.get_dashboard_stats() from public;
grant execute on function public.get_dashboard_stats() to authenticated;


-- ---------------------------------------------------------------------------------------
-- 14. Verification queries. Read-only.
-- ---------------------------------------------------------------------------------------
-- 14a. The workflow's money functions must exist. Expected: ten rows.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'disburse_tranche','submit_repayment','verify_repayment','reject_repayment',
    'reverse_repayment','void_disbursement','close_loan','loan_settlement_quote',
    'submit_loan_settlement','super_admin_amend_repayment')
order by proname;

-- 14b. No legacy loan may be left with a misleading zero schedule after a tranche rebuild.
--      Expected: zero rows for tranche loans.
select l.id, l.status, l.outstanding_balance
from public.loans l
where l.status in ('ACTIVE','DEFAULTED')
  and not exists (select 1 from public.loan_installments i
                   where i.loan_id = l.id and i.voided_at is null)
limit 50;

-- 14c. No PENDING_VERIFICATION payment may already be allocated. Expected: zero rows.
select r.id, r.loan_id, r.amount, r.status
from public.repayments r
where r.status = 'PENDING_VERIFICATION'
  and exists (select 1 from public.loan_installments i
               where i.loan_id = r.loan_id and i.amount_paid > 0)
  and not exists (select 1 from public.repayments v
                   where v.loan_id = r.loan_id and v.status = 'VERIFIED' and v.reversed_at is null)
limit 50;

-- 14d. A sample settlement quote. Replace the id with a live loan before running by hand.
-- select * from public.loan_settlement_quote('<loan_id>');

notify pgrst, 'reload schema';
