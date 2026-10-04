-- OGESEOUS MICROFINANCE — Step 8 (Approval & disbursement) + Step 9 (Repayments)
-- Run after 006. Copyright © Paulo Mkenya

create table public.loans (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.loan_applications(id),
  user_id uuid not null references public.users(id),
  principal_amount numeric(12,2) not null check (principal_amount > 0),
  outstanding_balance numeric(12,2) not null check (outstanding_balance >= 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED','DEFAULTED')),
  disbursed_by uuid references public.users(id),
  disbursed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.loans enable row level security;
create policy "owner or staff read loans" on public.loans for select using (
  user_id = auth.uid() or exists (select 1 from public.users u where u.id = auth.uid()
    and u.role in ('ACCOUNTANT','COLLECTION_OFFICER','LOAN_OFFICER','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE'));

create or replace function public.disburse_loan(p_application_id uuid, p_amount numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_loan_id uuid; v_user uuid;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only accountants, managers or super admins can disburse loans';
  end if;
  select user_id into v_user from public.loan_applications where id = p_application_id and status = 'APPROVED';
  if v_user is null then raise exception 'Application not found or not approved'; end if;
  if p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;

  insert into public.loans (application_id, user_id, principal_amount, outstanding_balance, disbursed_by)
  values (p_application_id, v_user, p_amount, p_amount, auth.uid()) returning id into v_loan_id;
  update public.loan_applications set status = 'DISBURSED' where id = p_application_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_DISBURSED', 'loans', v_loan_id::text, jsonb_build_object('amount', p_amount));
  return v_loan_id;
end $$;
revoke all on function public.disburse_loan(uuid,numeric) from public;
grant execute on function public.disburse_loan(uuid,numeric) to authenticated;

create table public.repayments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id),
  amount numeric(12,2) not null check (amount > 0),
  method text not null check (method in ('CASH','MOBILE_MONEY','BANK_TRANSFER')),
  reference text,
  recorded_by uuid references public.users(id),
  paid_at timestamptz not null default now()
);
alter table public.repayments enable row level security;
create policy "owner or staff read repayments" on public.repayments for select using (
  exists (select 1 from public.loans l where l.id = loan_id and (l.user_id = auth.uid()
    or exists (select 1 from public.users u where u.id = auth.uid()
      and u.role in ('ACCOUNTANT','COLLECTION_OFFICER','LOAN_OFFICER','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE'))));

create or replace function public.record_repayment(p_loan_id uuid, p_amount numeric, p_method text, p_reference text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_balance numeric;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only accountants, collection officers, managers or super admins can record repayments';
  end if;
  if p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if p_method not in ('CASH','MOBILE_MONEY','BANK_TRANSFER') then raise exception 'Invalid method'; end if;

  insert into public.repayments (loan_id, amount, method, reference, recorded_by) values (p_loan_id, p_amount, p_method, p_reference, auth.uid());
  update public.loans set outstanding_balance = greatest(outstanding_balance - p_amount, 0) where id = p_loan_id returning outstanding_balance into v_balance;
  if v_balance is null then raise exception 'Loan not found'; end if;
  if v_balance = 0 then update public.loans set status = 'CLOSED' where id = p_loan_id; end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'REPAYMENT_RECORDED', 'loans', p_loan_id::text, jsonb_build_object('amount', p_amount, 'method', p_method));
end $$;
revoke all on function public.record_repayment(uuid,numeric,text,text) from public;
grant execute on function public.record_repayment(uuid,numeric,text,text) to authenticated;
