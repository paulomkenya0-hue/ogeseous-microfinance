-- OGESEOUS MICROFINANCE — Step 10: Collections, arrears & reminders
-- Run after 007. Copyright © Paulo Mkenya

create table public.collection_reminders (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id),
  channel text not null check (channel in ('SMS','EMAIL','CALL','VISIT')),
  note text,
  sent_by uuid references public.users(id),
  sent_at timestamptz not null default now()
);
alter table public.collection_reminders enable row level security;
create policy "staff read reminders" on public.collection_reminders for select using (
  exists (select 1 from public.users u where u.id = auth.uid()
    and u.role in ('COLLECTION_OFFICER','ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE'));

-- Simple due-date model: repayment is expected repayment_period_months after disbursement.
-- No partial installment schedule yet — that would be a further refinement.
create or replace function public.list_arrears()
returns table (loan_id uuid, student_name text, university text, outstanding numeric, due_date date, days_overdue integer)
language sql security definer set search_path = public stable as $$
  select l.id, sp.full_name, sp.university, l.outstanding_balance,
    (l.disbursed_at + (la.repayment_period_months || ' months')::interval)::date as due_date,
    greatest((now()::date - (l.disbursed_at + (la.repayment_period_months || ' months')::interval)::date), 0)
  from public.loans l
  join public.loan_applications la on la.id = l.application_id
  join public.student_profiles sp on sp.user_id = l.user_id
  where exists (select 1 from public.users u where u.id = auth.uid()
      and u.role in ('COLLECTION_OFFICER','ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE')
    and l.outstanding_balance > 0
    and (l.disbursed_at + (la.repayment_period_months || ' months')::interval) < now()
  order by due_date asc;
$$;
revoke all on function public.list_arrears() from public;
grant execute on function public.list_arrears() to authenticated;

-- Logs that a reminder was attempted. Does NOT send a real SMS/email — no such service is configured.
create or replace function public.log_reminder(p_loan_id uuid, p_channel text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('COLLECTION_OFFICER','ACCOUNTANT','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only collection staff can log reminders';
  end if;
  insert into public.collection_reminders (loan_id, channel, note, sent_by) values (p_loan_id, p_channel, p_note, auth.uid());
  insert into public.audit_logs (actor_id, action, entity, entity_id) values (auth.uid(), 'REMINDER_LOGGED', 'loans', p_loan_id::text);
end $$;
revoke all on function public.log_reminder(uuid,text,text) from public;
grant execute on function public.log_reminder(uuid,text,text) to authenticated;
