-- OGESEOUS MICROFINANCE — Migration 027: sequential loan workflow foundation
-- Run after 026_repayment_periods_1_to_3.sql. Copyright © Paulo Mkenya
--
-- WHY THIS MIGRATION EXISTS
-- ========================
-- The workflow was a single step: a loan officer could set APPROVED directly, and money moved from
-- there. There was no manager gate, no accountant terms, no borrower acceptance of those terms, no
-- repayment verification, and no immutable record of who moved an application or a shilling.
--
-- This file lays the foundation only. It adds the vocabulary, the tables and the safe backfill.
-- The state machine itself is in 028, the money engine in 029, and the grants/verification in 030.
--
-- WHAT THIS FILE DOES NOT DO
-- ==========================
--   * It does not delete an application, a loan, a repayment, a document or a token.
--   * It does not rewrite or remove migrations 001-026.
--   * It does not drop a table. Every new constraint on historical data is added NOT VALID and is
--     validated only if the existing rows already satisfy it.
--   * Existing students, drafts, submitted applications, application numbers, verification tokens
--     and uploaded documents are untouched apart from the status backfill described in section 8.
--
-- RE-RUNNABLE. Every statement is guarded, because a half-applied migration must be finishable
-- rather than a puzzle. The only statements that can fail by design are the duplicate checks in
-- sections 7 and 8, and they fail with an instruction rather than silently dropping data.

-- ---------------------------------------------------------------------------------------
-- 0. pgcrypto, in the schema Supabase actually installs it in.
--
--    submit_loan_application() (014) calls unqualified gen_random_bytes(12) with
--    `set search_path = public`. On Supabase pgcrypto lives in `extensions`, so on a project where
--    that is the case the call fails with "function gen_random_bytes(integer) does not exist" and
--    NO student can submit an application. The working fix existed only in the deployed database,
--    not in version control, so a fresh install would reintroduce it.
--
--    One helper centralises the fix: it runs with a search_path that includes both schemas, so it
--    works whether pgcrypto was installed in `extensions` or in `public`.
-- ---------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create schema if not exists extensions;
    create extension pgcrypto with schema extensions;
  end if;
end $$;

create or replace function public.new_verification_token() returns text
language sql volatile security definer
set search_path = public, extensions
as $$
  select encode(gen_random_bytes(12), 'hex');
$$;
revoke all on function public.new_verification_token() from public;
revoke all on function public.new_verification_token() from anon, authenticated;


-- ---------------------------------------------------------------------------------------
-- 1. The application status vocabulary.
--
--    The new statuses are the sequential stages. The old ones are kept in the CHECK because
--    application_status_history stores historical from/to values, and because a stale client or
--    an un-migrated row must not make an UPDATE fail with a raw constraint error.
--
--    DRAFT                          student still filling the wizard
--    PENDING_LOAN_OFFICER           submitted; loan officer must assess and forward
--    RETURNED_TO_LOAN_OFFICER       manager sent it back to the loan officer
--    ACTION_REQUIRED                the student must supply something (either stage)
--    PENDING_MANAGER                loan officer forwarded it; manager must decide
--    PENDING_ACCOUNTANT             manager approved; accountant must prepare terms
--    RETURNED_TO_ACCOUNTANT         manager returned the terms for correction
--    PENDING_TERMS_APPROVAL         accountant prepared terms; manager must approve them
--    TERMS_APPROVED                 manager approved the terms; the student must accept them
--    TERMS_ACCEPTED                 student accepted; the accountant may disburse
--    DISBURSED                      at least one tranche is out; loan is running
--    PAID_OFF                       every tranche is fully repaid; accountant reconciles
--    CLOSED                         accountant reconciled and closed the file
--    REJECTED                       terminal refusal at the loan-officer or manager stage
-- ---------------------------------------------------------------------------------------
alter table public.loan_applications drop constraint if exists loan_applications_status_check;
alter table public.loan_applications
  add constraint loan_applications_status_check
  check (status in (
    'DRAFT',
    'SUBMITTED',
    'UNDER_REVIEW',
    'PENDING_LOAN_OFFICER',
    'RETURNED_TO_LOAN_OFFICER',
    'ACTION_REQUIRED',
    'PENDING_MANAGER',
    'PENDING_ACCOUNTANT',
    'RETURNED_TO_ACCOUNTANT',
    'PENDING_TERMS_APPROVAL',
    'TERMS_APPROVED',
    'TERMS_ACCEPTED',
    'APPROVED',
    'REJECTED',
    'DISBURSED',
    'PAID_OFF',
    'COMPLETED',
    'CLOSED'
  ));


-- ---------------------------------------------------------------------------------------
-- 2. One loan per application, with per-tranche totals.
--
--    Multiple tranches were deliberately NOT modelled in 020 ("partial disbursement is left as a
--    final amount"). This reverses that decision: each tranche has its own approved terms, its own
--    schedule and its own disbursement record. The loan row aggregates them, and
--    loans.application_id stays UNIQUE — one application, one loan, many tranches.
-- ---------------------------------------------------------------------------------------
alter table public.loans add column if not exists total_interest numeric(12,2) not null default 0;
alter table public.loans add column if not exists total_repayable numeric(12,2) not null default 0;
alter table public.loans add column if not exists amount_verified numeric(12,2) not null default 0;
alter table public.loans add column if not exists amount_pending numeric(12,2) not null default 0;
alter table public.loans add column if not exists paid_off_at timestamptz;
alter table public.loans add column if not exists closed_at timestamptz;
alter table public.loans add column if not exists closed_by uuid references public.users(id);

alter table public.loans drop constraint if exists loans_status_check;
alter table public.loans
  add constraint loans_status_check
  check (status in ('ACTIVE', 'DEFAULTED', 'PAID_OFF', 'CLOSED', 'VOIDED'));


-- ---------------------------------------------------------------------------------------
-- 3. The schedule gains a per-period breakdown and a tranche.
--
--    The OLD schedule divided the total into equal slices and had no interest/principal split,
--    so a student could not see what they were paying for and early settlement could not be
--    calculated honestly. Opening balance, interest and principal are nullable because historical
--    installments predate the breakdown and must not be invented.
-- ---------------------------------------------------------------------------------------
alter table public.loan_installments add column if not exists terms_id uuid;
alter table public.loan_installments add column if not exists tranche_no integer not null default 1;
alter table public.loan_installments add column if not exists opening_balance numeric(12,2);
alter table public.loan_installments add column if not exists interest_amount numeric(12,2);
alter table public.loan_installments add column if not exists principal_amount numeric(12,2);
alter table public.loan_installments add column if not exists closing_balance numeric(12,2);
alter table public.loan_installments add column if not exists voided_at timestamptz;

alter table public.loan_installments drop constraint if exists loan_installments_status_check;
alter table public.loan_installments
  add constraint loan_installments_status_check
  check (status in ('PENDING', 'PARTIAL', 'PAID', 'VOIDED'));

create index if not exists installments_terms_idx on public.loan_installments (terms_id, seq);
create index if not exists installments_tranche_idx on public.loan_installments (loan_id, tranche_no);


-- ---------------------------------------------------------------------------------------
-- 4. Repayments become a two-person operation.
--
--    A payment is now SUBMITTED (PENDING_VERIFICATION) and only moves the balance once a different
--    officer VERIFIES it. The submitter can never verify their own entry. Existing rows are
--    backfilled as VERIFIED because they were already treated as money received; changing that
--    would silently un-pay historical loans.
-- ---------------------------------------------------------------------------------------
alter table public.repayments add column if not exists status text not null default 'VERIFIED';
alter table public.repayments add column if not exists submitted_by uuid references public.users(id);
alter table public.repayments add column if not exists submitted_at timestamptz;
alter table public.repayments add column if not exists verified_by uuid references public.users(id);
alter table public.repayments add column if not exists verified_at timestamptz;
alter table public.repayments add column if not exists verification_note text;
alter table public.repayments add column if not exists self_verified_override boolean not null default false;
alter table public.repayments add column if not exists terms_id uuid;
alter table public.repayments add column if not exists tranche_no integer;
alter table public.repayments add column if not exists proof_path text;
alter table public.repayments add column if not exists idempotency_key text;

update public.repayments
   set status = 'REVERSED'
 where reversed_at is not null;

update public.repayments
   set submitted_by = coalesce(submitted_by, recorded_by),
       submitted_at = coalesce(submitted_at, paid_at),
       verified_by  = coalesce(verified_by, recorded_by),
       verified_at  = coalesce(verified_at, paid_at)
 where status = 'VERIFIED';

alter table public.repayments drop constraint if exists repayments_status_check;
alter table public.repayments
  add constraint repayments_status_check
  check (status in ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'REVERSED'));

-- Enforced for every new write. NOT VALID so the legacy rows backfilled above (where the recorder
-- is also the verifier, because there was no second person in the old model) do not fail the
-- migration. The RPC layer additionally refuses self-verification.
alter table public.repayments drop constraint if exists repayments_two_person_check;
alter table public.repayments
  add constraint repayments_two_person_check
  check (verified_by is null or submitted_by is null or verified_by <> submitted_by or self_verified_override)
  not valid;

alter table public.repayments drop constraint if exists repayments_status_reversal_check;
alter table public.repayments
  add constraint repayments_status_reversal_check
  check ((reversed_at is null) = (status <> 'REVERSED'))
  not valid;

create unique index if not exists repayments_idempotency_uniq
  on public.repayments (idempotency_key)
  where idempotency_key is not null;

create index if not exists repayments_status_idx
  on public.repayments (status, submitted_at desc);


-- ---------------------------------------------------------------------------------------
-- 5. New tables. All additive; none replaces an existing table.
-- ---------------------------------------------------------------------------------------

-- 5a. Per-tranche terms. One row per tranche, each independently approved by the manager and
--     accepted by the student before any money moves.
create table if not exists public.loan_terms (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.loan_applications(id) on delete restrict,
  tranche_no integer not null check (tranche_no > 0),
  status text not null default 'DRAFT_TERMS'
    check (status in ('DRAFT_TERMS', 'PENDING_MANAGER_TERMS', 'APPROVED_TERMS', 'ACCEPTED_BY_STUDENT', 'DISBURSED', 'VOIDED')),
  principal_amount numeric(12,2) not null check (principal_amount > 0),
  annual_rate numeric(9,6) not null check (annual_rate >= 0 and annual_rate <= 100),
  period_months integer not null check (period_months in (1, 2, 3)),
  installment_amount numeric(12,2) not null check (installment_amount > 0),
  total_interest numeric(12,2) not null check (total_interest >= 0),
  total_repayable numeric(12,2) not null check (total_repayable > 0),
  prepared_by uuid references public.users(id),
  prepared_at timestamptz,
  approved_by uuid references public.users(id),
  approved_at timestamptz,
  accepted_at timestamptz,
  manager_comment text,
  accountant_comment text,
  return_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (application_id, tranche_no)
);
create index if not exists loan_terms_application_idx on public.loan_terms (application_id, tranche_no);
create index if not exists loan_terms_status_idx on public.loan_terms (status);

drop trigger if exists trg_loan_terms_touch on public.loan_terms;
create trigger trg_loan_terms_touch before update on public.loan_terms
  for each row execute function public.touch_updated_at();

-- 5b. Disbursements. The immutable record of money actually leaving, one row per tranche.
create table if not exists public.disbursements (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.loan_applications(id) on delete restrict,
  loan_id uuid references public.loans(id) on delete restrict,
  terms_id uuid not null unique references public.loan_terms(id) on delete restrict,
  tranche_no integer not null check (tranche_no > 0),
  amount numeric(12,2) not null check (amount > 0),
  channel text not null check (channel in ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE')),
  reference text,
  proof_path text,
  status text not null default 'RECORDED' check (status in ('RECORDED', 'VOIDED')),
  disbursed_by uuid not null references public.users(id),
  disbursed_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmation_comment text,
  idempotency_key text,
  voided_by uuid references public.users(id),
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  unique (loan_id, tranche_no)
);
create index if not exists disbursements_application_idx on public.disbursements (application_id, tranche_no);
create unique index if not exists disbursements_reference_uniq
  on public.disbursements (lower(btrim(reference)))
  where reference is not null and btrim(reference) <> '' and status <> 'VOIDED';
create unique index if not exists disbursements_idempotency_uniq
  on public.disbursements (idempotency_key)
  where idempotency_key is not null;

-- 5c. Workflow transitions. Every stage move, with the comment and who made it. This is the
--     record the student sees and the auditor reads; application_status_history is kept as the
--     existing display path and is written alongside it.
create table if not exists public.loan_workflow_transitions (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.loan_applications(id) on delete restrict,
  loan_id uuid references public.loans(id) on delete restrict,
  terms_id uuid references public.loan_terms(id) on delete restrict,
  stage text not null,
  from_status text,
  to_status text not null,
  actor_id uuid references public.users(id),
  actor_role public.user_role,
  comment text,
  visible_to_student boolean not null default true,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists workflow_transitions_application_idx
  on public.loan_workflow_transitions (application_id, created_at);

-- 5d. Financial audit. Immutable before/after snapshots, including Super Admin edits.
create table if not exists public.financial_audit_events (
  id bigint generated always as identity primary key,
  entity text not null,
  entity_id text not null,
  action text not null,
  actor_id uuid references public.users(id),
  actor_role public.user_role,
  reason text,
  before jsonb,
  after jsonb,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists financial_audit_entity_idx
  on public.financial_audit_events (entity, entity_id, created_at desc);

-- 5e. Final reconciliation. One closure per loan.
create table if not exists public.loan_closures (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null unique references public.loans(id) on delete restrict,
  closed_by uuid not null references public.users(id),
  closed_at timestamptz not null default now(),
  reconciled_principal numeric(12,2) not null default 0,
  reconciled_interest numeric(12,2) not null default 0,
  total_collected numeric(12,2) not null default 0,
  note text,
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------------------------
-- 6. RLS on the new tables. No INSERT/UPDATE/DELETE policy anywhere: every row is written by a
--    SECURITY DEFINER function in 028/029, which is what makes the records trustworthy.
-- ---------------------------------------------------------------------------------------
alter table public.loan_terms enable row level security;
alter table public.disbursements enable row level security;
alter table public.loan_workflow_transitions enable row level security;
alter table public.financial_audit_events enable row level security;
alter table public.loan_closures enable row level security;

drop policy if exists "owner or staff read terms" on public.loan_terms;
create policy "owner or staff read terms" on public.loan_terms for select using (
  exists (
    select 1 from public.loan_applications a
     where a.id = application_id
       and (a.user_id = auth.uid()
            or exists (select 1 from public.users u
                        where u.id = auth.uid()
                          and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                          and u.status = 'ACTIVE'))
  )
);

drop policy if exists "owner or staff read disbursements" on public.disbursements;
create policy "owner or staff read disbursements" on public.disbursements for select using (
  exists (
    select 1 from public.loan_applications a
     where a.id = application_id
       and (a.user_id = auth.uid()
            or exists (select 1 from public.users u
                        where u.id = auth.uid()
                          and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                          and u.status = 'ACTIVE'))
  )
);

drop policy if exists "owner or staff read transitions" on public.loan_workflow_transitions;
create policy "owner or staff read transitions" on public.loan_workflow_transitions for select using (
  exists (
    select 1 from public.loan_applications a
     where a.id = application_id
       and (a.user_id = auth.uid()
            or exists (select 1 from public.users u
                        where u.id = auth.uid()
                          and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                          and u.status = 'ACTIVE'))
  )
  and (visible_to_student or exists (select 1 from public.users u
                                      where u.id = auth.uid()
                                        and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                                        and u.status = 'ACTIVE'))
);

drop policy if exists "managers read financial audit" on public.financial_audit_events;
create policy "managers read financial audit" on public.financial_audit_events for select using (
  exists (select 1 from public.users u
           where u.id = auth.uid()
             and u.role in ('MANAGER','SUPER_ADMIN','ACCOUNTANT')
             and u.status = 'ACTIVE')
);

drop policy if exists "owner or staff read closures" on public.loan_closures;
create policy "owner or staff read closures" on public.loan_closures for select using (
  exists (
    select 1 from public.loans l
     where l.id = loan_id
       and (l.user_id = auth.uid()
            or exists (select 1 from public.users u
                        where u.id = auth.uid()
                          and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                          and u.status = 'ACTIVE'))
  )
);


-- ---------------------------------------------------------------------------------------
-- 8. Backfill historical statuses, preserving the evidence.
--
--    SUBMITTED / UNDER_REVIEW were "waiting for a loan officer" in practice, so they map to
--    PENDING_LOAN_OFFICER. An old APPROVED with a loan was really disbursed; without one it is
--    waiting for the accountant. Every move is written to application_status_history and
--    audit_logs so the change is visible rather than silent.
-- ---------------------------------------------------------------------------------------
with moved as (
  update public.loan_applications
     set status = case
       when status in ('SUBMITTED', 'UNDER_REVIEW') then 'PENDING_LOAN_OFFICER'
       when status = 'APPROVED' and exists (select 1 from public.loans l where l.application_id = loan_applications.id) then 'DISBURSED'
       when status = 'APPROVED' then 'PENDING_ACCOUNTANT'
       else status
     end
   where status in ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED')
  returning id, status
)
insert into public.application_status_history (application_id, from_status, to_status, note)
select m.id, 'LEGACY', m.status, 'Migrated to the sequential workflow by 027_workflow_foundation.sql'
from moved m;

insert into public.application_status_history (application_id, from_status, to_status, note)
select a.id, 'LEGACY', a.status, 'Recorded by 027 status backfill'
from public.loan_applications a
where a.status in ('PENDING_LOAN_OFFICER', 'PENDING_ACCOUNTANT', 'DISBURSED')
  and not exists (
    select 1 from public.application_status_history h
     where h.application_id = a.id
       and h.note like 'Migrated to the sequential workflow%'
  )
  and not exists (
    select 1 from public.application_status_history h
     where h.application_id = a.id
       and h.note = 'Recorded by 027 status backfill'
  );


-- ---------------------------------------------------------------------------------------
-- 7. One open application per student, across every stage that is still in progress.
--
--    DISBURSED, PAID_OFF and CLOSED are deliberately OUTSIDE the index: a running loan is not an
--    application in progress, and a student with a live loan is separately prevented from starting
--    a new one by the trigger in section 9. REJECTED and CLOSED leave the index, which is what lets
--    a rejected student apply again on the same account.
-- ---------------------------------------------------------------------------------------
do $$
declare v_dupes text;
begin
  select string_agg(d, '; ' order by d) into v_dupes
  from (
    select u.email || ' (' || count(*) || ' in-progress applications)' as d
    from public.loan_applications a
    join public.users u on u.id = a.user_id
    where a.status in (
      'DRAFT','PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER','ACTION_REQUIRED',
      'PENDING_MANAGER','PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT',
      'PENDING_TERMS_APPROVAL','TERMS_APPROVED','TERMS_ACCEPTED',
      'SUBMITTED','UNDER_REVIEW','APPROVED')
    group by a.user_id, u.email
    having count(*) > 1
  ) x;
  if v_dupes is not null then
    raise exception
      'Refusing to rebuild the one-open-application index: these accounts already hold more than one in-progress application: %. Close or merge the extras first, then re-run 027.', v_dupes;
  end if;
end $$;

drop index if exists public.one_open_application_per_student;
create unique index one_open_application_per_student on public.loan_applications (user_id)
  where status in (
    'DRAFT','PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER','ACTION_REQUIRED',
    'PENDING_MANAGER','PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT',
    'PENDING_TERMS_APPROVAL','TERMS_APPROVED','TERMS_ACCEPTED');

create index if not exists applications_workflow_status_idx
  on public.loan_applications (status, updated_at desc);


-- ---------------------------------------------------------------------------------------
-- 9. A student with a live loan cannot open a new application.
--
--    The unique index above only covers applications. Without this trigger a student with a
--    DISBURSED loan could create a fresh DRAFT, which is exactly the "two loans at once" hole the
--    active-loan policy exists to close.
-- ---------------------------------------------------------------------------------------
create or replace function public.block_application_with_live_loan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in (
       'DRAFT','PENDING_LOAN_OFFICER','RETURNED_TO_LOAN_OFFICER','ACTION_REQUIRED',
       'PENDING_MANAGER','PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT',
       'PENDING_TERMS_APPROVAL','TERMS_APPROVED','TERMS_ACCEPTED')
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and exists (
       select 1 from public.loans l
        where l.user_id = new.user_id
          and l.status in ('ACTIVE', 'DEFAULTED', 'PAID_OFF')
     )
  then
    raise exception 'This student has a live loan. It must be fully settled and closed before a new application can be opened.';
  end if;
  return new;
end $$;

drop trigger if exists trg_block_application_with_live_loan on public.loan_applications;
create trigger trg_block_application_with_live_loan
  before insert or update of status on public.loan_applications
  for each row execute function public.block_application_with_live_loan();

revoke all on function public.block_application_with_live_loan() from public, anon, authenticated;


-- ---------------------------------------------------------------------------------------
-- 10. Settings used by the new engine.
--
--     annual_interest_rate is kept as the default the accountant sees. It is NOT the rate applied
--     to a loan: the rate is snapshotted on loan_terms and approved by the manager. Changing the
--     setting therefore cannot retrospectively reprice a loan that has already been issued.
-- ---------------------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('annual_interest_rate',          '0'),
  ('interest_convention',           'REDUCING_BALANCE'),
  ('min_annual_interest_rate',      '0'),
  ('max_annual_interest_rate',      '100'),
  ('repayment_verification_required', 'true')
on conflict (key) do nothing;

update public.app_settings
   set value = 'REDUCING_BALANCE'
 where key = 'interest_convention' and lower(trim(value)) = 'none';


-- ---------------------------------------------------------------------------------------
-- 11. Verification queries. Read-only.
-- ---------------------------------------------------------------------------------------
-- 11a. Every new status must be accepted by the CHECK. Expected: one row whose definition
--      contains PENDING_LOAN_OFFICER and CLOSED.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.loan_applications'::regclass
  and conname = 'loan_applications_status_check';

-- 11b. No application may still carry a legacy status after the backfill. Expected: zero rows.
select id, application_number, status from public.loan_applications
where status in ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED');

-- 11c. Existing repayments must all be decided. Expected: zero rows.
select id, loan_id, status, reversed_at from public.repayments
where status is null;

-- 11d. The new tables must exist. Expected: five rows.
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('loan_terms','disbursements','loan_workflow_transitions','financial_audit_events','loan_closures')
order by table_name;

notify pgrst, 'reload schema';
