-- OGESEOUS MICROFINANCE — Financial hardening: schedule authorization, defaulted repayments,
-- legacy schedules and voiding a disbursement
-- Run after 019_login_and_account_fixes.sql. Copyright © Paulo Mkenya
--
-- WHY THIS FILE EXISTS
--
-- Four defects around money, all reachable by ordinary authenticated users or by ordinary staff:
--
--   1. build_loan_schedule() and rebuild_loan_payments() were executable by ANY signed-in user and
--      took a loan id from the caller. A student could regenerate or recompute somebody else's loan.
--      They are internal helpers, so they now require a finance/collections staff role like every
--      other money function. A null auth.uid() (migration runner / SQL editor) is allowed, because
--      that is already the trusted service context the guard triggers use.
--
--   2. record_repayment() accepted only ACTIVE loans, while mark_loan_defaulted() moves a loan to
--      DEFAULTED and the admin screen listed only ACTIVE loans. A defaulted loan could therefore
--      never be paid again. DEFAULTED now accepts repayments; a fully repaid defaulted loan still
--      closes through rebuild_loan_payments().
--
--   3. A loan created before 013 has no installments. record_repayment() saw a scheduled total of
--      zero and refused every payment with "nothing left to repay". When the loan has no payments
--      yet, the schedule is now generated from the agreed term first. When it already has payments,
--      the function refuses with an instruction instead of silently rebuilding: only a manager may
--      replace a schedule that already has allocations (build_loan_schedule enforces that).
--
--   4. void_disbursement() deletes the loan, but reversed repayments still held a NOT NULL foreign
--      key to it, so the delete failed. The FK now becomes ON DELETE SET NULL and loan_id becomes
--      nullable ONLY for reversed rows (enforced by a check constraint). The reversal history is
--      kept, with its original loan reference dropped because the loan no longer exists. Collection
--      reminders are deleted with the loan; they have no meaning without it.
--
-- Partial disbursement is deliberately left as a final amount: the loan and its schedule are for
-- the amount actually disbursed. The admin screen now says so explicitly instead of implying the
-- remainder can be drawn later.


-- ---------------------------------------------------------------------------------------
-- 1. Reversed repayments must survive the deletion of a voided loan.
-- ---------------------------------------------------------------------------------------
alter table public.repayments alter column loan_id drop not null;

alter table public.repayments drop constraint if exists repayments_loan_id_fkey;
alter table public.repayments
  add constraint repayments_loan_id_fkey
  foreign key (loan_id) references public.loans(id) on delete set null;

-- A live repayment must always belong to a loan. Only a reversed row may be orphaned when the
-- mistaken loan it corrected is voided.
alter table public.repayments drop constraint if exists repayments_voided_loan_chk;
alter table public.repayments
  add constraint repayments_voided_loan_chk
  check (loan_id is not null or reversed_at is not null);

-- Reminders are operational notes about a loan; they cannot outlive it.
alter table public.collection_reminders
  drop constraint if exists collection_reminders_loan_id_fkey;
alter table public.collection_reminders
  add constraint collection_reminders_loan_id_fkey
  foreign key (loan_id) references public.loans(id) on delete cascade;


-- ---------------------------------------------------------------------------------------
-- 2. build_loan_schedule(): staff-only, and safe to use as a deliberate rebuild.
--
-- The body is 013's, with two additions:
--   * a role check, so a student cannot call it directly;
--   * the final rebuild_loan_payments() call, so rebuilds reallocate existing payments instead of
--     leaving the loan showing the full principal as outstanding.
-- A manager or super admin may rebuild a schedule that already has payments. Other finance staff
-- may only build one where no live payment exists — the disbursement and legacy-repair paths.
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
  i integer;
begin
  if auth.uid() is not null and not exists (
    select 1 from public.users
     where id = auth.uid()
       and role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and status = 'ACTIVE'
  ) then
    raise exception 'Only finance or collections staff can build a repayment schedule';
  end if;

  select l.principal_amount, la.repayment_period_months
    into v_principal, v_months
  from public.loans l join public.loan_applications la on la.id = l.application_id
  where l.id = p_loan_id;
  if v_principal is null then raise exception 'Loan not found'; end if;
  if v_months < 1 then raise exception 'Invalid repayment period on the application'; end if;

  if exists (select 1 from public.repayments where loan_id = p_loan_id and reversed_at is null)
     and auth.uid() is not null
     and not exists (
       select 1 from public.users
        where id = auth.uid() and role in ('MANAGER','SUPER_ADMIN') and status = 'ACTIVE'
     )
  then
    raise exception 'This loan has payments against it — only a manager or super admin can rebuild its schedule';
  end if;

  v_rate := greatest(public.setting_num('annual_interest_rate', 0), 0);
  v_conv := upper(coalesce(nullif(trim((select value from public.app_settings where key = 'interest_convention')), ''), 'NONE'));

  if v_rate = 0 or v_conv = 'NONE' then
    -- No interest: the term simply divides the principal.
    v_total := v_principal;
  elsif v_conv = 'FLAT' then
    -- Interest charged on the original principal for the whole term.
    v_total := v_principal * (1 + v_rate * (v_months::numeric / 12));
  else
    -- REDUCING_BALANCE: equal monthly payments on a declining balance.
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
    v_per_due := (select (disbursed_at + make_interval(months => i))::date from public.loans where id = p_loan_id);
    -- The last installment absorbs the rounding remainder, so the term sums to v_total exactly.
    insert into public.loan_installments (loan_id, seq, due_date, amount_due)
    values (p_loan_id, i, v_per_due, case when i = v_months then v_total - v_allocated else v_slice end);
    v_allocated := v_allocated + v_slice;
  end loop;

  update public.loans set outstanding_balance = v_total where id = p_loan_id;

  -- Reallocate any live payments against the new schedule and derive the balance from it.
  -- Without this a rebuild on a loan with payments would show the full principal as outstanding.
  perform public.rebuild_loan_payments(p_loan_id);
end $$;
revoke all on function public.build_loan_schedule(uuid) from public;
grant execute on function public.build_loan_schedule(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 3. rebuild_loan_payments(): staff-only, and never silently closes a loan with no schedule.
--
-- 013's allocator was correct, but recalculate_loan() on a legacy loan with no installments used to
-- find a zero total and mark the loan CLOSED. A missing schedule is a data-repair job, not a paid
-- loan, so this now raises instead.
-- ---------------------------------------------------------------------------------------
create or replace function public.rebuild_loan_payments(p_loan_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  pay record;
  ins record;
  v_left numeric;
  v_take numeric;
  v_outstanding numeric;
begin
  if auth.uid() is not null and not exists (
    select 1 from public.users
     where id = auth.uid()
       and role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and status = 'ACTIVE'
  ) then
    raise exception 'Only finance or collections staff can rebuild loan payments';
  end if;

  if not exists (select 1 from public.loans where id = p_loan_id) then
    raise exception 'Loan not found';
  end if;

  if not exists (select 1 from public.loan_installments where loan_id = p_loan_id) then
    raise exception 'This loan has no repayment schedule. Rebuild its schedule before recalculating payments.';
  end if;

  update public.loan_installments
     set amount_paid = 0, status = 'PENDING', paid_at = null, updated_at = now()
   where loan_id = p_loan_id;

  for pay in
    select r.amount from public.repayments r
     where r.loan_id = p_loan_id and r.reversed_at is null
     order by r.paid_at, r.id
  loop
    v_left := pay.amount;
    for ins in
      select id, amount_due, amount_paid from public.loan_installments
       where loan_id = p_loan_id and amount_paid < amount_due
       order by due_date, seq
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
         paid_at = case when amount_paid >= amount_due then now() else null end
   where loan_id = p_loan_id;

  select coalesce(sum(amount_due - amount_paid), 0) into v_outstanding
    from public.loan_installments where loan_id = p_loan_id;

  -- A defaulted loan that is brought fully up to date becomes active again: it owes nothing, so
  -- calling it in arrears would be wrong.
  update public.loans
     set outstanding_balance = v_outstanding,
         status = case when v_outstanding = 0 then 'CLOSED'
                       when status = 'DEFAULTED' then 'DEFAULTED'
                       else 'ACTIVE' end
   where id = p_loan_id;
end $$;
revoke all on function public.rebuild_loan_payments(uuid) from public;
grant execute on function public.rebuild_loan_payments(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 4. record_repayment(): DEFAULTED loans are collectable, and a legacy loan gets a schedule.
-- ---------------------------------------------------------------------------------------
drop function if exists public.record_repayment(uuid,numeric,text,text);

create or replace function public.record_repayment(p_loan_id uuid, p_amount numeric, p_method text, p_reference text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_scheduled numeric;
  v_id uuid;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only accountants, collection officers, managers or super admins can record repayments';
  end if;
  if p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if p_method not in ('CASH','MOBILE_MONEY','BANK_TRANSFER') then raise exception 'Invalid method'; end if;
  if p_reference is not null and length(trim(p_reference)) > 120 then raise exception 'Reference is too long'; end if;

  select l.status into v_status from public.loans l where l.id = p_loan_id for update;
  if v_status is null then raise exception 'Loan not found'; end if;
  if v_status not in ('ACTIVE','DEFAULTED') then
    raise exception 'This loan is % and cannot accept repayments', v_status;
  end if;

  -- Pre-013 loans have no schedule. Build one only when there is nothing to destroy: no live
  -- payment has been allocated yet. A loan that already has payments needs a manager to rebuild
  -- its schedule deliberately (build_loan_schedule permits that).
  if not exists (select 1 from public.loan_installments where loan_id = p_loan_id) then
    if exists (select 1 from public.repayments where loan_id = p_loan_id and reversed_at is null) then
      raise exception 'This loan predates the repayment schedule and already has payments. A manager must rebuild its schedule before more can be recorded.';
    end if;
    perform public.build_loan_schedule(p_loan_id);
  end if;

  -- Refuse to take money the schedule has no room for. Allocating it would leave the loan owing
  -- less than was paid, which is how a portfolio stops reconciling.
  select coalesce(sum(amount_due - amount_paid), 0) into v_scheduled
    from public.loan_installments where loan_id = p_loan_id;
  if v_scheduled <= 0 then raise exception 'This loan has nothing left to repay'; end if;
  if p_amount > v_scheduled then
    raise exception 'Repayment (%) exceeds the remaining scheduled amount (%). Split the payment if this is not a mistake.',
      p_amount, v_scheduled;
  end if;

  -- 011 added a unique index that would otherwise surface as a raw 23505.
  if p_reference is not null and trim(p_reference) <> '' and p_method in ('MOBILE_MONEY','BANK_TRANSFER') then
    if exists (select 1 from public.repayments
                where lower(btrim(reference)) = lower(btrim(p_reference)) and reversed_at is null) then
      raise exception 'Reference "%" is already recorded against a repayment. Check for a duplicate entry.', trim(p_reference);
    end if;
  end if;

  insert into public.repayments (loan_id, amount, method, reference, recorded_by)
  values (p_loan_id, p_amount, p_method, nullif(trim(p_reference), ''), auth.uid())
  returning id into v_id;

  perform public.rebuild_loan_payments(p_loan_id);

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'REPAYMENT_RECORDED', 'repayments', v_id::text,
          jsonb_build_object('loan_id', p_loan_id, 'amount', p_amount, 'method', p_method,
                             'reference', trim(coalesce(p_reference, ''))));
  return v_id;
end $$;
revoke all on function public.record_repayment(uuid,numeric,text,text) from public;
grant execute on function public.record_repayment(uuid,numeric,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 5. void_disbursement(): unchanged body, restated after the FK change so the intended state is
--    visible in one place. Non-reversed payments still block it; reversed history now survives
--    with loan_id = null.
-- ---------------------------------------------------------------------------------------
create or replace function public.void_disbursement(p_loan_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_app uuid; v_amount numeric;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only managers or super admins can void a disbursement';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for the void — it is kept in the audit log';
  end if;

  select application_id, principal_amount into v_app, v_amount
    from public.loans where id = p_loan_id for update;
  if v_app is null then raise exception 'Loan not found'; end if;

  if exists (select 1 from public.repayments where loan_id = p_loan_id and reversed_at is null) then
    raise exception 'Payments have been taken against this loan. Reverse them before voiding the disbursement.';
  end if;

  delete from public.loan_installments where loan_id = p_loan_id;
  delete from public.loans where id = p_loan_id;
  update public.loan_applications set status = 'APPROVED' where id = v_app;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_DISBURSEMENT_VOIDED', 'loans', p_loan_id::text,
          jsonb_build_object('amount', v_amount, 'application_id', v_app, 'reason', trim(p_reason)));
end $$;
revoke all on function public.void_disbursement(uuid,text) from public;
grant execute on function public.void_disbursement(uuid,text) to authenticated;
