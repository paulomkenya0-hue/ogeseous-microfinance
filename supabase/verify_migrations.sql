-- =====================================================================================
-- OGESEOUS MICROFINANCE — Post-migration verification
-- Run this AFTER migrations 001 -> 010 in the Supabase SQL editor.
-- Read-only: it selects and reports, it does not change anything.
--
-- How to read the output: every row saying "FAIL" must be fixed before any real
-- student or any real money is involved. "PASS" means the structure is present and
-- consistent. This checks the SHAPE and the MONEY ARITHMETIC — it does not prove the
-- app works end to end, which still needs the manual test pass in README.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- 1. Do all 10 migrations' objects exist?
-- -------------------------------------------------------------------------------------
with expected(grp, name) as (values
  ('table','users'), ('table','student_profiles'), ('table','audit_logs'),
  ('table','rucu_students'), ('table','verification_requests'),
  ('table','marketing_officers'), ('table','referral_captures'),
  ('table','loan_applications'), ('table','loans'), ('table','repayments'),
  ('table','collection_reminders'),
  ('function','handle_new_user'), ('function','guard_protected_columns'),
  ('function','search_rucu_student'), ('function','submit_verification'),
  ('function','review_verification'), ('function','import_rucu_students'),
  ('function','create_marketing_officer'), ('function','submit_referral'),
  ('function','get_marketing_stats'),
  ('function','save_loan_application_draft'), ('function','submit_loan_application'),
  ('function','get_application_verification'),
  ('function','review_loan_application'),
  ('function','disburse_loan'), ('function','record_repayment'),
  ('function','list_arrears'), ('function','log_reminder'),
  ('function','get_dashboard_stats'), ('function','get_applications_by_university')
)
select e.grp, e.name,
       case
         when e.grp = 'table' and to_regclass('public.'||e.name) is null then 'FAIL missing'
         when e.grp = 'function' and to_regprocedure('public.'||e.name) is null then 'FAIL missing'
         else 'PASS'
       end as result
from expected e
order by e.grp desc, e.name;


-- -------------------------------------------------------------------------------------
-- 2. Is RLS actually enabled on every table? A table without RLS is fully public.
-- -------------------------------------------------------------------------------------
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       case when c.relrowsecurity then 'PASS' else 'FAIL - no RLS' end as result
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, c.relname;


-- -------------------------------------------------------------------------------------
-- 3. Is the private storage bucket there, and is it actually private?
-- -------------------------------------------------------------------------------------
select id, public,
       case when public then 'FAIL - bucket is public' else 'PASS - private' end as result
from storage.buckets
where id = 'verification-documents';


-- -------------------------------------------------------------------------------------
-- 4. Did migration 010 take effect? These checks confirm the fixes replaced the old bodies.
--    Run each and confirm it raises the stated error.
-- -------------------------------------------------------------------------------------
-- Test A: disburse_loan must REFUSE an amount above the approved amount.
--         Create a throwaway approved application first, then call with a huge number.
--   update public.loan_applications set status='APPROVED', amount = 500000
--    where user_id = (select id from public.users limit 1);
--   select public.disburse_loan(<that id>, 9999999);   -- expect: 'exceeds the approved amount'
--
-- Test B: record_repayment must REFUSE more than the outstanding balance.
--   select public.record_repayment(<a loan id>, 999999999);  -- expect: 'exceeds the outstanding balance'
--
-- Test C: record_repayment must REFUSE a closed loan.
--   update public.loans set status='CLOSED' where id = <a loan id>;
--   select public.record_repayment(<that id>, 100);          -- expect: 'cannot accept repayments'
--   update public.loans set status='ACTIVE' where id = <a loan id>;  -- undo


-- -------------------------------------------------------------------------------------
-- 5. THE IMPORTANT ONE — does the money arithmetic reconcile?
--    Every shilling disbursed must equal repayments + what is still outstanding.
--    If this fails, the reports on /admin/reports are showing wrong numbers.
-- -------------------------------------------------------------------------------------
select
  coalesce(sum(l.principal_amount), 0)                            as total_disbursed,
  coalesce((select sum(r.amount) from public.repayments r), 0)   as total_repayments,
  coalesce(sum(l.outstanding_balance), 0)                        as total_outstanding,
  coalesce(sum(l.principal_amount), 0)
    - coalesce((select sum(r.amount) from public.repayments r), 0)
    - coalesce(sum(l.outstanding_balance), 0)                    as difference,
  case
    when coalesce(sum(l.principal_amount), 0)
       - coalesce((select sum(r.amount) from public.repayments r), 0)
       - coalesce(sum(l.outstanding_balance), 0) = 0
    then 'PASS - money reconciles'
    else 'FAIL - disbursed <> repayments + outstanding'
  end as result
from public.loans l;


-- -------------------------------------------------------------------------------------
-- 6. Did any loan already record an overpayment? (Check BEFORE trusting existing data.)
--    Migration 010 stops new overpayments, but any that happened while testing it
--    in 007 are still sitting in repayments.
-- -------------------------------------------------------------------------------------
select r.id, r.loan_id, r.amount as repayment_amount,
       l.principal_amount, l.outstanding_balance
from public.repayments r
join public.loans l on l.id = r.loan_id
where r.amount > l.principal_amount
   or (r.amount - coalesce(l.principal_amount, 0)) > 0
limit 50;
-- Each row here is an overpayment that 007 absorbed silently. Investigate before going live.


-- -------------------------------------------------------------------------------------
-- 7. Are student profiles populated? Before 010 they were always blank, which made the
--    loan application PDF show an empty University and Registration No.
-- -------------------------------------------------------------------------------------
select
  count(*) filter (where university is null)                     as missing_university,
  count(*) filter (where registration_number is null)            as missing_registration,
  count(*) filter (where form_four_index_number is null)         as missing_index,
  count(*)                                                        as total_students,
  case
    when count(*) = 0 then 'no students yet - nothing to backfill'
    when count(*) filter (where university is null) = 0 then 'PASS - all populated'
    else 'BACKFILL NEEDED - see the commented query at the bottom of 010_fixes.sql'
  end as result
from public.student_profiles;


-- -------------------------------------------------------------------------------------
-- 8. Has any status/role been changed outside the SQL functions? The guard trigger
--    should make this impossible; this reports whether it ever happened.
-- -------------------------------------------------------------------------------------
select action, count(*) as times
from public.audit_logs
group by action
order by times desc;
-- Every sensitive action should be represented here once staff start using the app.
-- An absence of rows just means nothing has been approved or disbursed yet.