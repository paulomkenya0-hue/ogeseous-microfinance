-- OGESEOUS MICROFINANCE — Repayment schedule, interest, reversals and arrears
-- Run after 012_staff_administration.sql. Copyright © Paulo Mkenya
--
-- 007 modelled a loan as one lump due on a single date: due_date = disbursement + the whole
-- repayment period. A 24-month loan therefore fell due in full on one day, two years after the
-- money was paid out, and list_arrears() had nothing to say until that day arrived. There was
-- also no interest anywhere, and no way to undo a mistake: a repayment recorded against the wrong
-- loan, or against the right loan twice, could only be corrected by hand in SQL.
--
-- This migration replaces that model with a real schedule.
--
--   1. loan_installments: one row per month of the agreed term, each with its own due date.
--      Generated at disbursement from the approved term, the principal and the configured rate.
--   2. Interest is supported but ships DISABLED. annual_interest_rate is 0 and
--      interest_convention is 'none', so this migration changes no existing behaviour.
--      >>> The interest rate AND the convention (flat vs reducing balance) are commercial and
--      >>> legal decisions for OGESEOUS. They are settings, not constants, precisely so that
--      >>> nobody has to edit this SQL to change them. Confirm both, and confirm compliance,
--      >>> before setting annual_interest_rate to anything other than 0. <<<
--   3. A single allocator, rebuild_loan_payments(), is the ONLY thing that ever moves money
--      across a loan. It recomputes every installment from the non-reversed repayments, oldest
--      first, and derives the loan balance and status from the result. Recording and reversing a
--      payment both go through it, so the two paths cannot drift apart and there is no
--      incremental-update logic to get wrong.
--   4. Reversals are recorded, never deleted. A reversed repayment keeps its row and gains
--      reversed_at / reversed_by / reversal_reason, so the audit trail shows both the entry and
--      the correction. Every total in this schema excludes reversed rows.
--   5. void_disbursement() lets a mistaken disbursement be unwound, refused if any payment has
--      been taken against it.
--
-- The schedule always reconciles exactly: the final installment is the total minus everything
-- allocated before it, so amount_paid sums to the payments taken and outstanding_balance sums to
-- what is left. Rounding never leaks into a total.
--
-- THIS FILE IS SAFE TO RUN MORE THAN ONCE, including after a partial failure. Two reasons it has to
-- be, both learned the hard way:
--
--   * Postgres runs each statement in the SQL editor as its own transaction, so when this file
--     stopped at list_arrears() the statements before it had already committed. Every CREATE is
--     therefore guarded, so re-running finishes the job instead of failing on "relation already
--     exists".
--   * CREATE OR REPLACE cannot change a function's RETURN TYPE (42P13). list_arrears() and
--     get_dashboard_stats() gain columns here, so they are dropped first. If you ever add or remove
--     an OUT column on any function in this file, add or keep the matching
--     `drop function if exists` immediately above it, or the whole file stops at that statement.

-- ---------------------------------------------------------------------------------------
-- 1. The schedule.
-- ---------------------------------------------------------------------------------------
-- Every statement in this file is re-runnable. Postgres runs each statement in the SQL editor as
-- its own transaction, so an earlier failure leaves the statements before it committed — without
-- these guards, simply running the file again then fails on "relation already exists" and you are
-- left guessing how far it got.
create table if not exists public.loan_installments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  seq integer not null check (seq > 0),
  due_date date not null,
  amount_due numeric(12,2) not null check (amount_due >= 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  status text not null default 'PENDING' check (status in ('PENDING','PARTIAL','PAID')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (loan_id, seq),
  check (amount_paid <= amount_due)
);
drop trigger if exists trg_installment_touch on public.loan_installments;
create trigger trg_installment_touch before update on public.loan_installments
  for each row execute function public.touch_updated_at();

-- Arrears are always "unpaid installments past their date", so that is the index that matters.
create index if not exists installments_due_date_idx on public.loan_installments (due_date) where status <> 'PAID';
create index if not exists installments_loan_idx on public.loan_installments (loan_id, seq);

alter table public.loan_installments enable row level security;
-- There is no "create policy if not exists"; drop first. Postgres would otherwise raise
-- "policy already exists" and the rest of this file would never run.
drop policy if exists "owner or staff read installments" on public.loan_installments;
create policy "owner or staff read installments" on public.loan_installments for select using (
  exists (select 1 from public.loans l where l.id = loan_id and (l.user_id = auth.uid()
    or exists (select 1 from public.users u where u.id = auth.uid()
      and u.role in ('ACCOUNTANT','COLLECTION_OFFICER','LOAN_OFFICER','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE'))));
-- No write policy. Only the functions below may change a schedule.

insert into public.app_settings (key, value) values
  ('interest_convention', 'none')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------------------
-- 2. build_loan_schedule(): generate the term. Called at disbursement, and by
--    recalculate_loan() when a schedule needs rebuilding from the payments actually taken.
--    Destroys payment history, so it is only ever called on a loan with no repayments against it.
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
  -- This allocator moves money across a loan, so it is never callable from the client. Only our
  -- own trusted definer functions (which set the transaction-local marker first) may invoke it.
  if not public.in_trusted_write() then
    raise exception 'build_loan_schedule is internal-only; call disburse_loan or recalculate_loan instead';
  end if;

  select l.principal_amount, la.repayment_period_months
    into v_principal, v_months
  from public.loans l join public.loan_applications la on la.id = l.application_id
  where l.id = p_loan_id;
  if v_principal is null then raise exception 'Loan not found'; end if;

  -- Serialize concurrent schedule/recalculation work on the same loan.
  perform 1 from public.loans where id = p_loan_id for update;
  if v_months < 1 then raise exception 'Invalid repayment period on the application'; end if;

  if exists (select 1 from public.repayments where loan_id = p_loan_id and reversed_at is null) then
    raise exception 'This loan has payments against it — reverse them before changing the schedule';
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
end $$;
revoke all on function public.build_loan_schedule(uuid) from public;
-- Internal-only: deliberately NO grant to authenticated or anon. The trusted wrappers
-- (disburse_loan, recalculate_loan) invoke it as the function owner, which needs no grant.
revoke execute on function public.build_loan_schedule(uuid) from authenticated, anon;


-- ---------------------------------------------------------------------------------------
-- 3. rebuild_loan_payments(): the single allocator.
--
-- Recomputes the whole loan from its non-reversed repayments, oldest payment first against the
-- oldest unpaid installment. It is idempotent and order-deterministic, which is why both
-- recording and reversing a payment call it instead of doing incremental arithmetic: there is
-- exactly one implementation of "what does this loan owe", so there is exactly one place for it
-- to be wrong.
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
  -- Internal allocator: only callable from a trusted definer function that set the
  -- transaction-local marker first. Direct RPC calls have no marker and are refused.
  if not public.in_trusted_write() then
    raise exception 'rebuild_loan_payments is internal-only; call recalculate_loan or record a repayment instead';
  end if;

  -- Serialize concurrent rebuilds of the same loan (record_repayment already holds this lock
  -- in the same transaction, so re-taking it is a no-op there).
  perform 1 from public.loans where id = p_loan_id for update;

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
-- Internal-only: deliberately NO grant to authenticated or anon. The trusted wrappers
-- (record_repayment, reverse_repayment, recalculate_loan) invoke it as the function owner.
revoke execute on function public.rebuild_loan_payments(uuid) from authenticated, anon;


-- Repair entry point. If a total ever looks wrong, this recomputes it from the repayments table,
-- which is the record of what actually happened. MANAGER / SUPER_ADMIN only.
create or replace function public.recalculate_loan(p_loan_id uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare v_outstanding numeric;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only managers or super admins can recalculate a loan';
  end if;
  perform public.trusted_write();
  perform public.rebuild_loan_payments(p_loan_id);
  select outstanding_balance into v_outstanding from public.loans where id = p_loan_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_RECALCULATED', 'loans', p_loan_id::text,
          jsonb_build_object('outstanding', v_outstanding));
  return v_outstanding;
end $$;
revoke all on function public.recalculate_loan(uuid) from public;
grant execute on function public.recalculate_loan(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 4. disburse_loan(): 010's version plus the loan ceiling, the per-student limit and a
--    requirement that the student is still verified at the moment the money moves.
--
--    The signature is unchanged, so this is a plain CREATE OR REPLACE.
-- ---------------------------------------------------------------------------------------
create or replace function public.disburse_loan(p_application_id uuid, p_amount numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_loan_id uuid; v_user uuid; v_approved numeric;
  v_max numeric; v_cap integer; v_active integer; v_verified public.verification_status;
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

  -- Verification can lapse between approval and disbursement, and so can the student's status.
  -- Re-check both here rather than trusting the state at approval time.
  select verification_status into v_verified from public.student_profiles where user_id = v_user;
  if v_verified is distinct from 'VERIFIED' then
    raise exception 'The student is no longer verified (current status: %), so this cannot be disbursed', coalesce(v_verified::text, 'no profile');
  end if;
  if not exists (select 1 from public.users where id = v_user and status = 'ACTIVE') then
    raise exception 'The student''s account is suspended, so this cannot be disbursed';
  end if;

  v_max := public.setting_num('max_loan_amount', 0);
  if v_max > 0 and p_amount > v_max then
    raise exception 'Disbursement amount (%) is above the maximum permitted loan (%)', p_amount, v_max;
  end if;

  v_cap := public.setting_num('max_active_loans_per_student', 1)::int;
  if v_cap > 0 then
    select count(*) into v_active from public.loans where user_id = v_user and status = 'ACTIVE';
    if v_active >= v_cap then
      raise exception 'This student already has % active loan(s) and the limit is %', v_active, v_cap;
    end if;
  end if;

  insert into public.loans (application_id, user_id, principal_amount, outstanding_balance, disbursed_by)
  values (p_application_id, v_user, p_amount, p_amount, auth.uid()) returning id into v_loan_id;

  -- Marks this transaction as trusted so the internal allocator below runs.
  perform public.trusted_write();
  perform public.build_loan_schedule(v_loan_id);

  update public.loan_applications set status = 'DISBURSED' where id = p_application_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_DISBURSED', 'loans', v_loan_id::text,
          jsonb_build_object('amount', p_amount, 'approved_amount', v_approved,
                             'interest_rate', public.setting_num('annual_interest_rate', 0)));
  return v_loan_id;
end $$;
revoke all on function public.disburse_loan(uuid,numeric) from public;
grant execute on function public.disburse_loan(uuid,numeric) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 5. record_repayment(): now returns the repayment id so the UI can offer an undo straight away.
--
--    CREATE OR REPLACE cannot change a return type, so the void version is dropped first. The
--    REVOKE below is not optional: a freshly created function is executable by PUBLIC until told
--    otherwise, which is exactly the window this schema never wants.
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
  if v_status <> 'ACTIVE' then raise exception 'This loan is % and cannot accept repayments', v_status; end if;

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

  -- Marks this transaction as trusted so the internal allocator below runs.
  perform public.trusted_write();
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
-- 6. reverse_repayment(): correct a mistaken entry without deleting the evidence.
--
--    MANAGER / SUPER_ADMIN only, and deliberately not the same person who recorded it — a
--    collection officer who typed the wrong amount must not be able to make it disappear.
-- ---------------------------------------------------------------------------------------
create or replace function public.reverse_repayment(p_repayment_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_loan uuid;
  v_amount numeric;
  v_recorded_by uuid;
  v_loan_status text;
  v_reversed_at timestamptz;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only managers or super admins can reverse a repayment';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for the reversal — it is kept in the audit log';
  end if;

  select r.loan_id, r.amount, r.recorded_by, r.reversed_at, l.status
    into v_loan, v_amount, v_recorded_by, v_reversed_at, v_loan_status
    from public.repayments r
    join public.loans l on l.id = r.loan_id
   where r.id = p_repayment_id;
  if not found then raise exception 'Repayment not found'; end if;

  if v_reversed_at is not null then
    raise exception 'This repayment was already reversed on %', v_reversed_at;
  end if;
  if v_recorded_by = auth.uid() then
    raise exception 'You cannot reverse a repayment you recorded yourself — ask a manager to do it';
  end if;

  update public.repayments
     set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = trim(p_reason)
   where id = p_repayment_id;

  -- Marks this transaction as trusted so the internal allocator below runs.
  perform public.trusted_write();
  perform public.rebuild_loan_payments(v_loan);

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'REPAYMENT_REVERSED', 'repayments', p_repayment_id::text,
          jsonb_build_object('loan_id', v_loan, 'amount', v_amount, 'reason', trim(p_reason)));
end $$;
revoke all on function public.reverse_repayment(uuid,text) from public;
grant execute on function public.reverse_repayment(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 7. void_disbursement(): unwind a disbursement that should never have happened.
--
--    Refused once any payment has been taken, because deleting the loan would delete the debt
--    while leaving the cash in the bank. Settle or reverse the payments first.
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


-- ---------------------------------------------------------------------------------------
-- 8. mark_loan_defaulted(): collections staff flag a loan for escalation.
-- ---------------------------------------------------------------------------------------
create or replace function public.mark_loan_defaulted(p_loan_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.users where id = auth.uid()
                 and role in ('COLLECTION_OFFICER','ACCOUNTANT','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only collections staff can mark a loan as defaulted';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason'; end if;

  update public.loans set status = 'DEFAULTED' where id = p_loan_id and status = 'ACTIVE';
  if not found then raise exception 'Loan not found or not active'; end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_DEFAULTED', 'loans', p_loan_id::text, jsonb_build_object('reason', trim(p_reason)));
end $$;
revoke all on function public.mark_loan_defaulted(uuid,text) from public;
grant execute on function public.mark_loan_defaulted(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 9. list_arrears(): rewritten against installments, so a loan is in arrears from the first
--    missed month instead of from one single date at the end of the term.
-- ---------------------------------------------------------------------------------------
-- Postgres cannot change a function's return type with CREATE OR REPLACE (42P13), so the old
-- one has to go first. 008 declared six OUT columns and this returns nine, because arrears are
-- now counted per installment rather than as one lump due at the end of the term.
--
-- The revoke/grant pair below is reapplied after the create, so dropping does not leave the
-- function executable by PUBLIC, which is the default for every new function.
drop function if exists public.list_arrears();

create or replace function public.list_arrears()
returns table (
  loan_id uuid, student_name text, university text, outstanding numeric,
  due_date date, days_overdue integer, installments_missed bigint, total_due numeric, amount_paid numeric
) language sql security definer set search_path = public stable as $$
  select l.id, sp.full_name, sp.university,
    coalesce((select sum(i.amount_due - i.amount_paid) from public.loan_installments i
              where i.loan_id = l.id and i.amount_due > i.amount_paid), 0),
    min(i.due_date) filter (where i.amount_due > i.amount_paid and i.due_date <= now()::date),
    greatest((now()::date - min(i.due_date) filter (where i.amount_due > i.amount_paid and i.due_date <= now()::date))::int, 0),
    count(*) filter (where i.amount_due > i.amount_paid and i.due_date <= now()::date),
    coalesce(sum(i.amount_due), 0),
    coalesce(sum(i.amount_paid), 0)
  from public.loans l
  join public.student_profiles sp on sp.user_id = l.user_id
  join public.loan_installments i on i.loan_id = l.id
  where l.status in ('ACTIVE','DEFAULTED')
    and i.amount_due > i.amount_paid
    and i.due_date <= now()::date
    and exists (select 1 from public.users u where u.id = auth.uid()
      and u.role in ('COLLECTION_OFFICER','ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE')
  group by l.id, sp.full_name, sp.university
  order by min(i.due_date);
$$;
revoke all on function public.list_arrears() from public;
grant execute on function public.list_arrears() to authenticated;


-- Schedule for the student view and for staff. RLS already limits the installments table itself,
-- but this returns the loan and the student together in one call so the page is a single query.
create or replace function public.get_loan_schedule(p_loan_id uuid)
returns table (
  seq integer, due_date date, amount_due numeric, amount_paid numeric, amount_outstanding numeric,
  status text, days_overdue integer
) language sql security definer set search_path = public stable as $$
  select i.seq, i.due_date, i.amount_due, i.amount_paid, i.amount_due - i.amount_paid,
    i.status, greatest((now()::date - i.due_date)::int, 0)
  from public.loan_installments i
  join public.loans l on l.id = i.loan_id
  where i.loan_id = p_loan_id
    and (l.user_id = auth.uid()
      or exists (select 1 from public.users u where u.id = auth.uid()
        and u.role in ('ACCOUNTANT','COLLECTION_OFFICER','LOAN_OFFICER','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE'))
  order by i.seq;
$$;
revoke all on function public.get_loan_schedule(uuid) from public;
grant execute on function public.get_loan_schedule(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 10. Dashboard totals. Reversed repayments are excluded everywhere.
--
--     Two notes on the shape of this function:
--       * It returns ZERO ROWS for roles that may not see financial totals, not a row of nulls.
--         That distinction matters: the UI can tell "you are not allowed to see this" apart from
--         "the figures are zero".
--       * interest_billed is a static figure per loan — everything the schedule asks for, minus
--         the principal. It deliberately does NOT try to apportion interest to the unpaid part
--         of a loan, because payments are allocated by due date rather than pro rata, and any
--         such split would be an invention. For the live position, use overdue_balance.
-- ---------------------------------------------------------------------------------------
-- Same 42P13 problem as list_arrears(): 009 and 011 declared nine OUT columns and this returns
-- thirteen, adding the scheduled total, the interest billed, the overdue balance and the number of
-- loans in arrears. Drop before replacing; the grants are reapplied below.
drop function if exists public.get_dashboard_stats();

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
    (select count(*) from public.loan_applications where status not in ('DRAFT')),
    (select count(*) from public.loan_applications where status in ('APPROVED','DISBURSED')),
    (select coalesce(sum(principal_amount),0) from public.loans),
    (select coalesce(sum(amount),0) from public.repayments where reversed_at is null),
    (select coalesce(sum(outstanding_balance),0) from public.loans where status = 'ACTIVE'),
    (select count(*) from public.loans where status = 'ACTIVE'),
    (select coalesce(sum(i.amount_due), 0) from public.loan_installments i),
    -- Everything the schedules will ever collect, less the principal that was advanced.
    (select coalesce(sum(i.amount_due), 0) from public.loan_installments i)
      - (select coalesce(sum(principal_amount), 0) from public.loans),
    (select coalesce(sum(i.amount_due - i.amount_paid), 0)
       from public.loan_installments i
       join public.loans l on l.id = i.loan_id
      where l.status in ('ACTIVE','DEFAULTED')
        and i.amount_due > i.amount_paid
        and i.due_date <= now()::date),
    (select count(distinct i.loan_id)
       from public.loan_installments i
       join public.loans l on l.id = i.loan_id
      where l.status in ('ACTIVE','DEFAULTED')
        and i.amount_due > i.amount_paid
        and i.due_date <= now()::date)
  where exists (select 1 from public.users u where u.id = auth.uid()
    and u.role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE');
$$;
revoke all on function public.get_dashboard_stats() from public;
grant execute on function public.get_dashboard_stats() to authenticated;


-- ---------------------------------------------------------------------------------------
-- 11. Account deletion.
--
-- The Privacy Policy page promises something the system could not deliver. This lets a student
-- delete their own account — but only while nothing financial is attached to it. A student with a
-- loan is not deleted, because that would delete the institution's record of a debt; they are
-- told to settle it first. Deletion cascades to their profile, verification requests and
-- uploaded documents.
-- ---------------------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT') then
    raise exception 'Only student accounts can be deleted here. Contact OGESEOUS to close a staff account.';
  end if;
  if exists (select 1 from public.loans where user_id = auth.uid()) then
    raise exception 'You have a loan on record with OGESEOUS, so your account cannot be deleted. Please settle it or contact us.';
  end if;
  insert into public.audit_logs (actor_id, action, entity)
  values (auth.uid(), 'ACCOUNT_DELETED', 'users');
  delete from public.users where id = auth.uid();
end $$;
revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
