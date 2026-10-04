-- OGESEOUS MICROFINANCE — Step 11: Management reports & financial dashboards
-- Run after 008. Copyright © Paulo Mkenya

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
    (select coalesce(sum(amount),0) from public.repayments),
    (select coalesce(sum(outstanding_balance),0) from public.loans where status = 'ACTIVE'),
    (select count(*) from public.loans where status = 'ACTIVE')
  where exists (select 1 from public.users u where u.id = auth.uid()
    and u.role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE');
$$;
revoke all on function public.get_dashboard_stats() from public;
grant execute on function public.get_dashboard_stats() to authenticated;

create or replace function public.get_applications_by_university()
returns table (university text, applications bigint, approved bigint)
language sql security definer set search_path = public stable as $$
  select sp.university, count(*), count(*) filter (where la.status in ('APPROVED','DISBURSED'))
  from public.loan_applications la
  join public.student_profiles sp on sp.user_id = la.user_id
  where exists (select 1 from public.users u where u.id = auth.uid()
    and u.role in ('ACCOUNTANT','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE')
  group by sp.university;
$$;
revoke all on function public.get_applications_by_university() from public;
grant execute on function public.get_applications_by_university() to authenticated;
