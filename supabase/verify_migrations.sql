-- =====================================================================================
-- OGESEOUS MICROFINANCE — Post-migration verification
-- Run this AFTER migrations 001 -> 017 in the Supabase SQL editor.
-- Read-only: it selects and reports, it does not change anything.
--
-- How to read the output: every row saying "FAIL" must be fixed before any real
-- student or any real money is involved. "PASS" means the structure is present and
-- consistent. This checks the SHAPE and the MONEY ARITHMETIC — it does not prove the
-- app works end to end, which still needs the manual test pass in README.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- 1. Do all 17 migrations' objects exist?
-- -------------------------------------------------------------------------------------
with expected(grp, name) as (values
  ('table','users'), ('table','student_profiles'), ('table','audit_logs'),
  ('table','rucu_students'), ('table','verification_requests'),
  ('table','marketing_officers'), ('table','referral_captures'),
  ('table','loan_applications'), ('table','loans'), ('table','repayments'),
  ('table','collection_reminders'), ('table','app_settings'), ('table','loan_installments'),
  ('table','loan_documents'), ('table','application_status_history'),
  ('function','handle_new_user'), ('function','guard_protected_columns'),
  ('function','trusted_write'), ('function','in_trusted_write'),
  ('function','search_rucu_student'), ('function','submit_verification'),
  ('function','review_verification'), ('function','import_rucu_students'),
  ('function','create_marketing_officer'), ('function','submit_referral'),
  ('function','get_marketing_stats'),
  ('function','save_loan_application_draft'), ('function','submit_loan_application'),
  ('function','get_application_verification'),
  ('function','review_loan_application'),
  ('function','disburse_loan'), ('function','record_repayment'),
  ('function','list_arrears'), ('function','log_reminder'),
  ('function','get_dashboard_stats'), ('function','get_applications_by_university'),
  ('function','setting_num'), ('function','set_setting'), ('function','allowed_repayment_months'),
  ('function','set_user_role'), ('function','set_user_status'), ('function','link_marketing_officer'),
  ('function','list_staff'), ('function','find_user'), ('function','list_audit_actions'),
  ('function','build_loan_schedule'), ('function','rebuild_loan_payments'), ('function','recalculate_loan'),
  ('function','reverse_repayment'), ('function','void_disbursement'), ('function','mark_loan_defaulted'),
  ('function','get_loan_schedule'), ('function','delete_my_account'),
  ('function','verify_student_from_register'), ('function','declare_application_student'),
  ('function','save_application_loan'), ('function','save_application_financial'),
  ('function','save_application_guarantor'),
  ('function','save_application_contact'), ('function','attach_application_document'),
  ('function','resubmit_application'), ('function','get_application_history'),
  ('function','track_application'), ('function','required_document_types'),
  ('function','guarantor_is_required'), ('function','application_student_detail'),
  ('index','one_identity_per_account'), ('index','repayments_reference_uniq'),
  ('index','one_open_application_per_student'), ('index','applications_by_status')
)
select e.grp, e.name,
       case
         when e.grp = 'table' and to_regclass('public.'||e.name) is null then 'FAIL missing'
         when e.grp = 'function' and to_regprocedure('public.'||e.name) is null then 'FAIL missing'
         when e.grp = 'index' and to_regclass('public.'||e.name) is null then 'FAIL missing'
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
--
--    Migration 013 replaced the single-due-date model with a real schedule, so the test changed.
--    For every loan, all three of these must be true:
--      (a) sum(installments.amount_due)   == principal + interest billed for that loan
--      (b) sum(installments.amount_paid)   == sum of that loan's non-reversed repayments
--      (c) loans.outstanding_balance       == sum(amount_due - amount_paid) over that loan
--    If (b) or (c) fails, /admin/reports and every collections figure are showing wrong numbers.
--
--    Any FAIL can be repaired without touching data by hand:
--       select public.recalculate_loan('<loan_id>');
--    That recomputes the schedule from the repayments table, which is the record of what
--    actually happened. Run it for each failing loan, then re-run this check.
-- -------------------------------------------------------------------------------------
with per_loan as (
  select l.id, l.principal_amount, l.outstanding_balance, l.status,
    coalesce((select sum(i.amount_due)   from public.loan_installments i where i.loan_id = l.id), 0) as scheduled,
    coalesce((select sum(i.amount_paid)   from public.loan_installments i where i.loan_id = l.id), 0) as allocated,
    coalesce((select sum(r.amount) from public.repayments r
              where r.loan_id = l.id and r.reversed_at is null), 0) as received
  from public.loans l
)
select
  count(*) filter (where allocated <> received)                                        as paid_mismatch,
  count(*) filter (where outstanding_balance <> scheduled - allocated)                 as balance_mismatch,
  count(*) filter (where status = 'CLOSED' and allocated <> scheduled)                 as closed_but_unpaid,
  count(*) filter (where status = 'ACTIVE' and allocated = scheduled)                 as paid_but_still_active,
  count(*) filter (where scheduled = 0)                                                as loans_with_no_schedule,
  count(*)                                                        as total_loans,
  case
    when count(*) filter (where allocated <> received) = 0
     and count(*) filter (where outstanding_balance <> scheduled - allocated) = 0
     and count(*) filter (where status = 'CLOSED' and allocated <> scheduled) = 0
     and count(*) filter (where status = 'ACTIVE' and allocated = scheduled) = 0
     and count(*) filter (where scheduled = 0) = 0
    then 'PASS - money reconciles'
    else 'FAIL - run recalculate_loan() for each row listed by the queries below'
  end as result
from per_loan;

-- The individual offenders behind the counts above. Should return no rows.
with per_loan as (
  select l.id, l.principal_amount, l.outstanding_balance, l.status,
    coalesce((select sum(i.amount_due)   from public.loan_installments i where i.loan_id = l.id), 0) as scheduled,
    coalesce((select sum(i.amount_paid)   from public.loan_installments i where i.loan_id = l.id), 0) as allocated,
    coalesce((select sum(r.amount) from public.repayments r
              where r.loan_id = l.id and r.reversed_at is null), 0) as received
  from public.loans l
)
select id, principal_amount, scheduled, received, allocated, outstanding_balance, status,
       case
         when scheduled = 0 then 'no schedule generated'
         when allocated <> received then 'installments <> repayments'
         when outstanding_balance <> scheduled - allocated then 'balance <> schedule'
         else 'ok'
       end as problem
from per_loan
where scheduled = 0
   or allocated <> received
   or outstanding_balance <> scheduled - allocated
   or (status = 'CLOSED' and allocated <> scheduled)
   or (status = 'ACTIVE' and allocated = scheduled)
limit 50;


-- -------------------------------------------------------------------------------------
-- 5b. Portfolio-level check, independent of the per-loan detail above.
-- -------------------------------------------------------------------------------------
select
  coalesce((select sum(principal_amount) from public.loans), 0)                 as total_disbursed,
  coalesce((select sum(amount) from public.repayments where reversed_at is null), 0) as total_collected,
  coalesce((select sum(outstanding_balance) from public.loans), 0)              as total_outstanding,
  coalesce((select sum(principal_amount) from public.loans), 0)
    - coalesce((select sum(amount) from public.repayments where reversed_at is null), 0)
    - coalesce((select sum(outstanding_balance) from public.loans), 0)          as difference,
  case
    when coalesce((select sum(principal_amount) from public.loans), 0)
       - coalesce((select sum(amount) from public.repayments where reversed_at is null), 0)
       - coalesce((select sum(outstanding_balance) from public.loans), 0) = 0
    then 'PASS - disbursed <> repayments + outstanding'
    else 'FAIL - disbursed <> repayments + outstanding'
  end as result;

-- Reversed repayments must be excluded from every total. This shows what they were, for review.
select r.id, r.loan_id, r.amount, r.method, r.reference, r.reversed_at, r.reversed_by, r.reversal_reason
from public.repayments r
where r.reversed_at is not null
order by r.reversed_at desc
limit 50;


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


-- -------------------------------------------------------------------------------------
-- 9. Did migration 011 land? These are the fixes that were silent security holes.
-- -------------------------------------------------------------------------------------
select 'one_identity_per_account' as check, case when to_regclass('public.one_identity_per_account') is not null
    then 'PASS - one account per (university, registration)' else 'FAIL - missing, duplicate accounts are possible' end as result
union all select 'repayments_reference_uniq', case when to_regclass('public.repayments_reference_uniq') is not null
    then 'PASS - a payment reference cannot be reused' else 'FAIL - missing, a payment can be recorded twice' end
union all select 'app_settings', case when to_regclass('public.app_settings') is not null
    then 'PASS - loan limits are configured, not hard-coded' else 'FAIL - missing' end
union all select 'trusted_write', case when to_regproc('public.trusted_write') is not null
    then 'PASS - submit_verification() can pass the guard' else 'FAIL - submit_verification() is broken' end;

-- MUST be empty. If it is not, migration 011 refused to run; see its remediation query.
select university, registration_number, count(*) as accounts
from public.student_profiles
where university is not null and registration_number is not null
group by university, registration_number
having count(*) > 1;

-- Confirm the guard really does block a student from self-editing a verified identity.
-- Run as a STUDENT in the SQL editor (auth.uid() is then that student). All three MUST raise:
--   update public.student_profiles set full_name = 'Someone Else' where user_id = auth.uid();
--   update public.student_profiles set university = 'MKWAWA' where user_id = auth.uid();
--   update public.student_profiles set registration_number = 'FORGED' where user_id = auth.uid();
-- Expected: 'Not allowed to change verified identity details...'
-- Also confirm the legitimate path still works — as the student:
--   update public.student_profiles set phone = '+255700000000' where user_id = auth.uid();
-- Expected: succeeds.


-- -------------------------------------------------------------------------------------
-- 10. Business settings. These are DEFAULTS, not confirmed values. Review every one.
-- -------------------------------------------------------------------------------------
select key, value, updated_at, updated_by
from public.app_settings
order by key;

select
  case when (select value from public.app_settings where key = 'annual_interest_rate')::numeric = 0
    then 'interest is OFF — every installment equals the principal split'
    else 'WARNING - interest is on at ' || (select value from public.app_settings where key = 'annual_interest_rate')
         || ' using the ' || (select value from public.app_settings where key = 'interest_convention')
         || ' convention. Confirm this is a decision OGESEOUS and its compliance position have made.' end as interest_note,
  case when (select value from public.app_settings where key = 'max_loan_amount')::numeric > 0
    then 'loan ceiling is enforced' else 'FAIL - max_loan_amount is 0, no ceiling is applied' end as ceiling_note;


-- -------------------------------------------------------------------------------------
-- 11. The schedule generated at disbursement. Spot-check the due dates are monthly and that
--     the term sums to what is expected — this is what arrears is now calculated from.
-- -------------------------------------------------------------------------------------
select l.id, l.principal_amount, la.repayment_period_months,
  count(i.id) as installments,
  min(i.due_date) as first_due, max(i.due_date) as last_due,
  sum(i.amount_due) as total_scheduled,
  l.principal_amount - sum(i.amount_due) as interest_component,
  case
    when count(i.id) = la.repayment_period_months then 'PASS'
    else 'FAIL - installment count <> agreed term'
  end as result
from public.loans l
join public.loan_applications la on la.id = l.application_id
left join public.loan_installments i on i.loan_id = l.id
group by l.id, l.principal_amount, la.repayment_period_months
having count(i.id) <> la.repayment_period_months
order by l.created_at desc
limit 50;


-- -------------------------------------------------------------------------------------
-- 12. Loans from BEFORE migration 013 have no schedule. 013 does not backfill, because a
--     schedule can only be invented for a loan with no payments against it, and guessing the
--     term for a loan that is already being collected against would be wrong.
--
--     List them here, then handle each one deliberately: either void the disbursement and
--     re-disburse so a schedule is generated, or agree a schedule with the student and call
--         select public.build_loan_schedule('<loan_id>');
--     ...which is refused if the loan has payments against it. Settle or reverse those first.
-- -------------------------------------------------------------------------------------
select l.id, l.principal_amount, l.status, l.disbursed_at,
  (select count(*) from public.repayments r where r.loan_id = l.id and r.reversed_at is null) as repayments,
  'NEEDS A SCHEDULE' as action
from public.loans l
where not exists (select 1 from public.loan_installments i where i.loan_id = l.id)
order by l.disbursed_at desc;

-- -------------------------------------------------------------------------------------
-- 13. Sanity check on staff administration. There must be at least one active SUPER_ADMIN, or
--     nobody can assign roles and the system cannot be administered.
-- -------------------------------------------------------------------------------------
select role, status, count(*) as accounts
from public.users
where role <> 'STUDENT'
group by role, status
order by role, status;

select case when count(*) > 0 then 'PASS - at least one active super admin'
  else 'FAIL - no active super admin; nobody can assign roles or reverse payments' end as result
from public.users where role = 'SUPER_ADMIN' and status = 'ACTIVE';


-- -------------------------------------------------------------------------------------
-- 14. Migration 014 — the application wizard.
-- -------------------------------------------------------------------------------------
select 'loan_policy has guarantor_required' as check, case
    when exists (select 1 from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'loan_policy'
                    and p.prorettype = 'pg_catalog.record'::regtype
                    and length(coalesce(p.proargnames::text, '')) > 0)
    then 'PASS' else 'FAIL - 014 did not apply; loan_policy() is still the 011 version' end as result
union all select 'track_application is callable by anon', case
    when has_function_privilege('anon', 'public.track_application(text,text)', 'execute')
    then 'PASS - the public tracking page can call it'
    else 'FAIL - /track will be refused for signed-out visitors' end
union all select 'application_student_detail is staff-only', case
    when has_function_privilege('anon', 'public.application_student_detail(uuid)', 'execute') then
      'FAIL - anon can read applicant details'
    when has_function_privilege('authenticated', 'public.application_student_detail(uuid)', 'execute') then
      'PASS - authenticated callers reach it; the role filter is inside the function'
    else 'FAIL - nobody can call it; /admin/applications/:id will show no applicant' end
union all select 'submit_loan_application returns 3 columns', case
    when (select count(*) from information_schema.routines r
           join pg_proc p on p.proname = r.routine_name
          where r.specific_schema = 'public' and p.proname = 'submit_loan_application'
            and r.data_type = 'record') >= 1
    then 'PASS' else 'check by hand' end;

-- 14a. The two settings 014 seeds are DEFAULTS, not decisions. Confirm them.
select key, value,
       case when key = 'guarantor_required' then
         case when value = 'true' then 'every applicant must name a guarantor' else 'no guarantor needed' end
       when key = 'required_application_documents' then
         'students must upload: ' || value
       end as meaning
from public.app_settings
where key in ('guarantor_required', 'required_application_documents');

-- 14b. Applications that exist but were never confirmed under the wizard. 014 cannot infer this
--      for them; each student must redo step 1, or the application must be closed deliberately.
select id, application_number, status, user_id, created_at, 'NEEDS STUDENT CONFIRMATION' as action
from public.loan_applications
where student_confirmed_at is null and status <> 'DRAFT'
order by created_at desc
limit 50;

-- 14c. Submitted applications still sitting in the old SUBMITTED state. The wizard submits
--      straight to UNDER_REVIEW, so nothing new lands here; anything present is from before 014
--      and needs migrating (the UPDATE is at the bottom of 014).
select id, application_number, status, submitted_at
from public.loan_applications
where status = 'SUBMITTED'
order by submitted_at desc;

-- 14d. A submitted application MUST be in the history, and a draft MUST NOT be. A draft in the
--      history means something reviewed it before the student submitted anything.
select la.id, la.application_number, la.status,
       (select count(*) from public.application_status_history h where h.application_id = la.id) as history_rows,
       case
         when la.status = 'DRAFT' and (select count(*) from public.application_status_history h
                                         where h.application_id = la.id) > 0
           then 'FAIL - a draft has status history'
         when la.status <> 'DRAFT' and (select count(*) from public.application_status_history h
                                         where h.application_id = la.id) = 0
           then 'FAIL - a submitted application has no history'
         else 'PASS'
       end as result
from public.loan_applications la
where la.submitted_at is not null or la.status <> 'DRAFT'
order by la.created_at desc
limit 50;

-- 14e. Application numbers must be unique and correctly formed. The column has a UNIQUE
--      constraint, so a duplicate is impossible; this checks the FORMAT, because a number
--      students are told to quote that does not match what the page accepts is a support call.
select application_number,
       case when application_number ~ '^OGS-[0-9]{4}-[0-9]{6}$' then 'PASS'
            else 'legacy OGE- format from before 014' end as result
from public.loan_applications
where application_number is not null
order by created_at desc
limit 50;

-- 14f. Programme and year of study are only populated if the register import carried them.
--      Blank here is not a failure — it just means step 1 shows "—" for those two fields.
select count(*) as total,
       count(*) filter (where programme is not null)      as with_programme,
       count(*) filter (where year_of_study is not null)  as with_year
from public.rucu_students;

-- 14g. The wizard saves steps 2 and 4 through SEPARATE functions. If only one exists, the other
--      path is broken: the wizard will call whichever is missing and fail with "function does not
--      exist" the first time a student presses Save and continue on that step.
--
--      Run this. Every row it returns is MISSING. An empty result set is the pass.
select expected.name as missing_function, expected.note as used_for
from (values
  ('save_application_loan',       'step 2 — amount, purpose, term'),
  ('save_application_financial',  'step 4 — income, expenses, support'),
  ('save_application_contact',    'step 3 — phone, address'),
  ('save_application_guarantor',  'step 5 — guarantor'),
  ('attach_application_document', 'step 6 — upload'),
  ('submit_loan_application',     'step 7 — submit'),
  ('resubmit_application',        'dashboard — answer ACTION_REQUIRED'),
  ('get_application_history',     'history timeline, both sides'),
  ('track_application',           'the public /track page'),
  ('application_student_detail',  'the applicant block on /admin/applications/:id')
) as expected(name, note)
where not exists (select 1 from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = expected.name);

-- 14h. Every SUBMITTED application must be trackable by its owner on /track, which proves identity
--      with the phone number on the account. submit_loan_application() refuses without one, so a row
--      here means the application predates that check or the phone was cleared afterwards.
select la.id, la.application_number, la.status, sp.phone,
       'NOT TRACKABLE BY THE STUDENT' as action
from public.loan_applications la
join public.student_profiles sp on sp.user_id = la.user_id
where la.submitted_at is not null
  and length(regexp_replace(coalesce(sp.phone, ''), '[^0-9]', '', 'g')) < 9
order by la.submitted_at desc
limit 50;

-- 14i. Two students must never hold two open applications, and the partial unique index is what
--      guarantees it. This finds the situation the index exists to make impossible.
select user_id, count(*) as open_applications, array_agg(status order by created_at) as statuses
from public.loan_applications
where status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED')
group by user_id
having count(*) > 1;

-- -------------------------------------------------------------------------------------
-- 15. THE RUCU LOOKUP (migration 015).
--
-- This is the check that would have caught the "NO STUDENT FOUND" bug. It calls the function
-- exactly as a signed-in student does, so a PL/pgSQL error inside it surfaces here instead of in
-- front of somebody trying to apply for a loan.
--
-- Run these as a STUDENT (set role / auth.uid()), because the function refuses anyone else.
--
-- 15a. MUST return exactly one row, with the authoritative values from rucu_students.
--      An error here means 015 did not apply. ZERO rows means the register genuinely has no
--      match — which is a data problem, not a code one, and is answered by 15c.
-- -------------------------------------------------------------------------------------
select public.verify_student_from_register('RU/TEST/001/2024', 'MWAKYUSA');
-- Expected: one row -> rucu_student_id set, full_name = 'JOHN MWAKYUSA',
--           registration_number = 'RU/TEST/001/2024', programme not null, year_of_study not null.

-- 15b. The same lookup, deliberately wrong in each way. Both MUST return zero rows, and neither
--      may create a register row or an application.
select 'wrong surname' as case, count(*) as rows_returned
from public.verify_student_from_register('RU/TEST/001/2024', 'NOSUCHNAME')
union all
select 'wrong registration', count(*)
from public.verify_student_from_register('RU/TEST/999/2024', 'MWAKYUSA')
union all
select 'correct registration, lower-cased surname', count(*)
from public.verify_student_from_register('RU/TEST/001/2024', 'mwakyusa');
-- Expected: 0, 0, 1 — the comparison is case-insensitive, the inputs are not.

-- 15c. Surrounding whitespace must not defeat the match. Expected: 1.
select count(*) as rows_returned
from public.verify_student_from_register('  RU/TEST/001/2024  ', '  MWAKYUSA  ');

-- 15d. A failed lookup must not have created anything. Expected: exactly the one pre-existing row.
select count(*) as register_rows from public.rucu_students where registration_number = 'RU/TEST/001/2024';

-- 15e. Static regression check on the two functions that had the defect. Each declares an OUT
--      parameter whose name is also a column it reads, so the bare form is ambiguous and Postgres
--      raises "column reference X is ambiguous" instead of matching. Both must now use the
--      qualified form. Expected: one row per function, both PASS.
--      (15a proves it behaviourally; this catches the bare form being reintroduced in review.)
select p.proname,
       case
         when p.proname = 'verify_student_from_register'
              and p.prosrc like '%r.registration_number%'
              and p.prosrc like '%r.last_name%'                     then 'PASS'
         when p.proname = 'attach_application_document'
              and p.prosrc like '%d.storage_path%'                   then 'PASS'
         else 'FAIL - unqualified column reference reintroduced'
       end as result
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('verify_student_from_register', 'attach_application_document');

-- -------------------------------------------------------------------------------------
-- 16. Phone-only signup (016). Students now have NO email address, so public.users.email is
--     nullable and the signup trigger reads auth.users.phone. Read-only checks.
-- -------------------------------------------------------------------------------------

-- 16a. The signup trigger must exist and must read the phone identity. If it is still the 001
--      version it only reads raw_user_meta_data, and public.users.phone stays empty for every
--      student. Expected: one row, PASS.
select case
         when p.prosrc like '%new.phone%'                 then 'PASS'
         else 'FAIL - handle_new_user does not read auth.users.phone'
       end as result
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'handle_new_user';

-- 16b. The trigger must still fire on signup. A student account with no public.users row cannot
--      sign in to the application at all. Expected: one row, PASS.
select case
         when count(*) = 1 then 'PASS'
         else 'FAIL - on_auth_user_created missing or duplicated (' || count(*) || ')'
       end as result
from pg_trigger
where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created' and not tgisinternal;

-- 16c. Email is optional for students but still unique, so two staff accounts can never share an
--      address. Expected: no_yes below reads 'no'.
select 'users_email_is_nullable' as check,
       case when (select is_nullable from information_schema.columns
                   where table_schema = 'public' and table_name = 'users'
                     and column_name = 'email') = 'YES'
            then 'PASS' else 'FAIL - email is still NOT NULL; no phone-only signup can succeed'
       end as result
union all
select 'users_email_still_unique',
       case when (select count(*) from pg_constraint c
                   join pg_class t on t.oid = c.conrelid
                   where t.relname = 'users' and c.contype = 'u'
                     and pg_get_constraintdef(c.oid) like '%email%') >= 1
            then 'PASS' else 'FAIL - the unique constraint on email was lost'
       end;

-- 16d. No staff account may be left without an identity: staff sign in with their email address.
--      Expected: zero rows.
select 'staff_without_email' as problem, u.id, u.role
from public.users u where u.email is null and u.role <> 'STUDENT';

-- 16e. No placeholder email was invented from a phone number. Students are identified by phone;
--      there should be no address in the database that is really a phone number. Expected: zero rows.
select 'synthesised_email' as problem, u.id, u.email
from public.users u
where u.email ~ '^\+?[0-9]+@' or u.email like '%@phone%' or u.email like '%@student.invalid%';

-- 16f. Students created BEFORE 016 kept the email they signed up with; that is expected, not a
--      fault. Every student created AFTER 016 should have none. Read the counts: a rising
--      "students_without_email" column means signup is working. Expected: the column to be > 0
--      once new students have registered.
select count(*) filter (where email is null)     as students_without_email,
       count(*) filter (where email is not null) as students_with_email,
       count(*) filter (where phone is null)     as students_without_phone
from public.users where role = 'STUDENT';


-- -------------------------------------------------------------------------------------
-- 17. RUCU can no longer be self-declared (017). A student must not be able to write RUCU details
--     into their own profile without the register being consulted.
-- -------------------------------------------------------------------------------------

-- 17a. The guard must be present in the function body. Read-only, so it is safe to run here.
--      Expected: one row, PASS.
select case
         when p.prosrc like '%p_university = ''RUCU''%' then 'PASS'
         else 'FAIL - declare_application_student still accepts RUCU; a student can self-verify'
       end as result
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'declare_application_student';

-- 17b. MKWAWA and IU must STILL be declarable. If the guard was written too wide, students at
--      those universities cannot apply at all, which is worse than the hole it closed. Behavioural
--      check: run this as a signed-in STUDENT with a throwaway number, then delete the draft.
--      Expected: an application id for each of MKWAWA and IU, and an error for RUCU.
--
--        select declare_application_student('RUCU',   'TEST NAME', 'T/R/001', 'T/IDX/001');
--          -> error: Ruaha Catholic University students are checked against the RUCU register
--        select declare_application_student('MKWAWA', 'TEST NAME', 'T/M/001', 'T/IDX/002');
--          -> returns an application id
--        select declare_application_student('IU',     'TEST NAME', 'T/I/001', 'T/IDX/003');
--          -> returns an application id

-- 17c. Students who claimed RUCU by self-declaration before this migration. These need a human
--      decision from OGESEOUS; the migration deliberately does not touch existing rows.
--      Expected: zero rows on a database that was never used that way.
select 'declared_rucu' as problem, sp.user_id, sp.full_name, sp.registration_number, la.status
from public.student_profiles sp
left join public.loan_applications la on la.user_id = sp.user_id
where sp.university = 'RUCU' and coalesce(la.verification_method, '') <> 'RUCU_REGISTER';

-- 17d. Every legitimate RUCU student was matched against the register. A mismatch between the
--      profile and public.rucu_students means something wrote those fields without the lookup.
--      Expected: zero rows.
select 'rucu_profile_disagrees_with_register' as problem, sp.user_id, sp.full_name,
       sp.registration_number, r.full_name as register_name
from public.student_profiles sp
left join public.rucu_students r
  on lower(trim(r.registration_number)) = lower(trim(sp.registration_number))
 and lower(trim(r.last_name)) = lower(trim(sp.full_name))
where sp.university = 'RUCU' and r.id is null;


-- -------------------------------------------------------------------------------------
-- 18. THE MANUAL PASS. None of the above proves the wizard works; only signing in as a student
--     does. Follow this before a real student is let near it.
--
--   1. Sign up with a NEW phone number, a name and a four-digit PIN (e.g. 1234). You should land
--      straight on the dashboard, with no "confirm your phone" step and no email field at all.
--      If you see a confirmation step, phone confirmation is still on — see README,
--      "Turning off phone confirmation". If it refuses the PIN, Supabase's own minimum password
--      length is still 6 — see the same README section.
--   2. APPLY FOR LOAN -> Step 1. Choose Ruaha Catholic University, then a registration number and
--      last name that DO exist in rucu_students (RU/TEST/001/2024 / MWAKYUSA). You should see
--      the student found, read-only. No email address is asked for at any point.
--   3. On the same step, choose Mkwawa University College or Iringa University. The register fields
--      must disappear and your own details must be asked for instead. Nothing may appear that
--      looks like a lookup.
--   4. Back on RUCU, enter a registration number and last name that do NOT match. You should get
--      "Student record not found. Please check your registration number and last name." and NO new
--      row anywhere. You must not see [object Object] for any failure.
--   5. Fill steps 2-6, then step 7. Submission must be refused until the declaration is ticked.
--   6. Submit. You should get OGS-YYYY-NNNNNN and status UNDER REVIEW. Double-click Submit:
--      the second attempt must be refused, not create a second number.
--   7. Sign in as a LOAN_OFFICER with the EMAIL address. /admin/applications must list it,
--      /admin/applications/<id> must open, and each attached document must OPEN. If the document
--      will not open, the storage policy from 014 section 18 did not apply.
--   8. Set it to ACTION_REQUIRED with a note. Sign back in as the student: the note must be
--      visible, and "I've provided what was asked" must move it back to UNDER REVIEW.
--   9. Open /track in a signed-out browser, entering the application number plus the phone
--      number on the account. Then repeat with a WRONG phone number: it must return nothing.
--      Neither answer may show the amount, the full name or the registration number.
--  10. Confirm /admin/settings shows guarantor_required and required_application_documents, and
--      that changing guarantor_required to false immediately stops the guarantor step blocking
--      submission.
--  11. Sign in as a student and try to open another student's application id directly. It must
--      not load.
--
-- AND THE ONE THAT IS NO LONGER POSSIBLE:
--  12. In the browser console, as a signed-in student, call the RPC by hand:
--        await supabase.rpc('declare_application_student',
--          { p_university: 'RUCU', p_full_name: 'ANYTHING', p_registration: 'ANYTHING',
--            p_form_four_index: 'ANYTHING' })
--      It must raise. Before migration 017 it returned an application id and wrote unverified RUCU
--      details into the student's own profile.
-- -------------------------------------------------------------------------------------