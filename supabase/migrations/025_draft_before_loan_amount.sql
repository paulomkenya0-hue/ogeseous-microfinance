-- OGESEOUS MICROFINANCE — Migration 025: a draft may exist before a loan amount does
-- Run after 024_restore_is_admin_execute.sql. Copyright © Paulo Mkenya
--
-- WHY THIS MIGRATION EXISTS
-- ========================
-- Step 1 of the wizard asks who the student is. It deliberately creates the draft application
-- there, before the student has been asked for an amount, a purpose or a repayment period.
--
-- 004_loan_applications.sql declared all three of those columns NOT NULL. At that time it was safe:
-- the only way an application could come into existence was save_loan_application_draft(), which
-- was called only after the student had typed an amount.
--
-- 014 and 017 then added two new entry points:
--
--   verify_student_from_register()  -- RUCU students, matched against the register
--   declare_application_student()   -- MKWAWA and IU students, self-declared
--
-- Both insert a row containing only user_id, student_confirmed_at and verification_method. Postgres
-- therefore refuses the first Continue of every new application with:
--
--   null value in column "amount" of relation "loan_applications" violates not-null constraint
--
-- (The bug report said relation "loan_application" (singular). No table of that name exists in this
-- schema; the table is public.loan_applications, and the constraint named in the message is the one
-- created by 004_loan_applications.sql line 11. The root cause is the same either way.)
--
-- WHY NOT INSERT 0
-- ================
-- amount = 0 satisfies neither the existing CHECK (amount > 0) nor the business meaning of a loan.
-- Writing a zero would turn "the student has not reached step 3" into "the student asked for
-- nothing", and every report that sums applications would be wrong. The honest representation of an
-- incomplete draft is NULL, and the decision about whether an amount exists belongs to the step that
-- asks for it.
--
-- WHAT THIS CHANGES, AND WHAT IT DOES NOT
-- =======================================
--   * amount, purpose and repayment_period_months become NULLABLE, because a DRAFT genuinely does
--     not have them yet.
--   * The existing amount > 0 CHECK is kept. In Postgres a CHECK that evaluates to NULL passes, so
--     NULL is allowed while zero and negative amounts are still refused. Nothing is loosened for a
--     value that is actually present.
--   * A new CHECK requires every application that has left DRAFT to carry a positive amount. It is
--     added NOT VALID so it does not scan or reject historical rows, then validated only when the
--     data is already clean. This is the database-level guarantee that no submitted application can
--     lack an amount, even if a future function forgets to check.
--   * No table is dropped. No row is created, updated or deleted. No RLS policy is changed. No grant
--     is altered. Writes still go only through the SECURITY DEFINER functions; there is still no
--     INSERT or UPDATE policy on loan_applications.
--   * Existing student profiles, drafts and submitted applications are untouched.
--
-- EVERY STATEMENT IS RE-RUNNABLE. The SQL editor applies each statement in its own transaction, so
-- the guards below are what let a half-applied file be run again without "already exists" errors.
--
-- LOAN AMOUNT VALIDATION AFTER THIS MIGRATION
-- ===========================================
--   frontend : LoanWizard.validate('loan') rejects empty, zero, negative, below-minimum and
--              above-maximum amounts before any RPC is called.
--   draft RPC: save_application_loan() rejects NULL and <= 0, then rejects anything outside the
--              configured min/max range. Only that function writes the three columns.
--   submit   : submit_loan_application() refuses a draft whose amount is NULL.
--   table    : CHECK (amount > 0) from 004 still applies to any non-NULL amount, and the new CHECK
--              below refuses a non-DRAFT row with a NULL or non-positive amount.
-- That is the same rule in all four places, which is the point.


-- ---------------------------------------------------------------------------------------
-- 1. A draft is allowed to be incomplete.
--
-- Dropping NOT NULL does not widen what a real application may contain: the checks that matter are
-- re-imposed on rows that have left DRAFT in section 2.
-- ---------------------------------------------------------------------------------------
alter table public.loan_applications alter column amount drop not null;
alter table public.loan_applications alter column purpose drop not null;
alter table public.loan_applications alter column repayment_period_months drop not null;


-- ---------------------------------------------------------------------------------------
-- 2. Anything that is no longer a DRAFT must carry a real amount.
--
-- NOT VALID means existing rows are not scanned at ADD time, so this migration cannot fail on data
-- written before it. The constraint is still enforced for every INSERT and every UPDATE from that
-- point on. Section 3 then validates it if — and only if — the existing rows already satisfy it, so
-- a clean database ends up with a fully validated constraint and a dirty one is reported rather
-- than blocked.
-- ---------------------------------------------------------------------------------------
alter table public.loan_applications
  drop constraint if exists loan_applications_submitted_amount_check;

alter table public.loan_applications
  add constraint loan_applications_submitted_amount_check
  check (status = 'DRAFT' or (amount is not null and amount > 0))
  not valid;


-- ---------------------------------------------------------------------------------------
-- 3. Validate the new constraint only when the existing data permits it.
--
-- A row returned by the query below is NOT repaired here. Which amount a historical application
-- really had is a question for OGESEOUS and the student, not something a migration may invent. The
-- constraint is already enforced for new writes; validating it can wait until the rows are fixed.
-- ---------------------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from public.loan_applications
     where status <> 'DRAFT'
       and (amount is null or amount <= 0)
  ) then
    alter table public.loan_applications
      validate constraint loan_applications_submitted_amount_check;
  end if;
end $$;


-- ---------------------------------------------------------------------------------------
-- 4. Verification. These are read-only and safe to run in the SQL editor after applying.
-- ---------------------------------------------------------------------------------------

-- 4a. The three columns must now be nullable. Expected: three rows, all is_nullable = 'YES'.
select column_name, is_nullable, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'loan_applications'
  and column_name in ('amount', 'purpose', 'repayment_period_months')
order by ordinal_position;

-- 4b. The state-dependent amount guarantee must exist. Expected: one row, validated = true on a
--     database whose historical data was clean, false (NOT VALID but still enforced) otherwise.
select conname,
       convalidated as validated,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.loan_applications'::regclass
  and conname = 'loan_applications_submitted_amount_check';

-- 4c. Drafts may legitimately appear here; anything that has left DRAFT must not. Expected: zero
--     rows. Fix any row by hand before treating the deployment as complete.
select id, user_id, status, amount, purpose, repayment_period_months, created_at
from public.loan_applications
where status <> 'DRAFT'
  and (amount is null or amount <= 0)
order by created_at desc
limit 50;

-- 4d. The existing "a real amount is positive" check from 004 must still be present. Expected: at
--     least one row whose definition contains "amount > 0".
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.loan_applications'::regclass
  and contype = 'c'
  and pg_get_constraintdef(oid) like '%amount > 0%';

-- 4e. Drafts are still invisible to other students and staff reads are unchanged: this is the RLS
--     policy from 004, and it must still be the only policy on this table. Expected: one SELECT
--     policy plus any staff SELECT policy added by 006 (two rows in a normal database).
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'loan_applications'
order by policyname;
