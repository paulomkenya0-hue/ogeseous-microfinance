-- OGESEOUS MICROFINANCE — Migration 030: grants, RLS, immutability and verification
-- Run after 029_financial_engine.sql. Copyright © Paulo Mkenya
--
-- This file closes the gaps that are not about the happy path:
--
--   * 026 added a CHECK (repayment_period_months IN (1,2,3)) that would fail on a database with
--     historical 6/12/18/24-month applications. It is re-added NOT VALID here, so history survives
--     while every new row is still enforced.
--   * application_student_detail() exposed a student's full contact details to MARKETING_OFFICER.
--     Marketing has its own referral tables; it does not need the applicant's phone and address.
--   * get_application_history() only recognised three staff roles. Accountants and collections
--     officers could not read the history of a file they are working on.
--   * set_setting() let a manager change the interest rate, loan limits and repayment policy. The
--     per-loan rate is set by the accountant and approved by the manager; the global value is only
--     a prefill. Financial settings are now SUPER_ADMIN only.
--   * loan_terms was readable in full by the student, including drafts and internal comments. The
--     student now sees only approved/accepted/disbursed terms, without internal comments.
--   * Audit records were ordinary tables. A DELETE or UPDATE would have erased the trail. Triggers
--     now refuse it.
--   * Payment proofs need a private bucket. The finance staff upload them; the student can read the
--     proof attached to their own loan.
--
-- RE-RUNNABLE. Policies are dropped before creation, functions are CREATE OR REPLACE, and the
-- storage bucket uses ON CONFLICT.

-- ---------------------------------------------------------------------------------------
-- 1. The 026 CHECK, made safe for historical rows.
-- ---------------------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.loan_applications'::regclass
       and conname = 'loan_applications_repayment_period_months_check'
  ) then
    alter table public.loan_applications
      drop constraint loan_applications_repayment_period_months_check;
  end if;

  alter table public.loan_applications
    add constraint loan_applications_repayment_period_months_check
    check (repayment_period_months is null or repayment_period_months in (1, 2, 3))
    not valid;

  -- Only validate when the existing data already satisfies it. A legacy 6-month application stays
  -- visible and untouched; new rows are enforced by the NOT VALID constraint exactly the same way.
  if not exists (
    select 1 from public.loan_applications
     where repayment_period_months is not null
       and repayment_period_months not in (1, 2, 3)
  ) then
    alter table public.loan_applications
      validate constraint loan_applications_repayment_period_months_check;
  end if;
end $$;


-- ---------------------------------------------------------------------------------------
-- 2. The repayment policy is 1, 2 or 3 months, whatever a stale setting says.
-- ---------------------------------------------------------------------------------------
create or replace function public.allowed_repayment_months() returns integer[]
language sql stable as $$
  select coalesce(
    nullif(
      array(select distinct trim(x)::integer
              from unnest(string_to_array(
                coalesce((select value from public.app_settings where key = 'allowed_repayment_months'), '1,2,3'),
                ',')) as t(x)
             where trim(x) ~ '^[0-9]{1,3}$'
               and trim(x)::integer in (1, 2, 3)
             order by 1),
      '{}'::integer[]
    ),
    array[1,2,3]
  );
$$;
revoke all on function public.allowed_repayment_months() from public;
grant execute on function public.allowed_repayment_months() to authenticated;


-- ---------------------------------------------------------------------------------------
-- 3. Marketing officers no longer receive an applicant's contact sheet.
--
--    They keep their referral tables and their own marketing_officers row. The loan file itself is
--    a need-to-know document: loan officer, accountant, collections, manager, super admin.
-- ---------------------------------------------------------------------------------------
create or replace function public.application_student_detail(p_application_id uuid)
returns table (
  user_id uuid, full_name text, phone text, address text, university text,
  registration_number text, form_four_index_number text, programme text, year_of_study text,
  emergency_contact_name text, emergency_contact_relationship text, emergency_contact_phone text,
  email text, role public.user_role, account_status public.user_status
) language sql security definer set search_path = public stable as $$
  select p.user_id, p.full_name, p.phone, p.address, p.university,
         p.registration_number, p.form_four_index_number, p.programme, p.year_of_study,
         p.emergency_contact_name, p.emergency_contact_relationship, p.emergency_contact_phone,
         u.email, u.role, u.status
  from public.loan_applications a
  join public.student_profiles p on p.user_id = a.user_id
  join public.users u on u.id = a.user_id
  where a.id = p_application_id
    and exists (select 1 from public.users s
                 where s.id = auth.uid()
                   and s.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                   and s.status = 'ACTIVE');
$$;
revoke all on function public.application_student_detail(uuid) from public;
grant execute on function public.application_student_detail(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 4. Every staff role that can work a file can read its history.
--
--    The note written here is already filtered by record_workflow_transition(): internal moves get
--    a null note, so this does not leak the manager's handover comment to the student.
-- ---------------------------------------------------------------------------------------
create or replace function public.get_application_history(p_id uuid)
returns table (from_status text, to_status text, note text, actor_name text, actor_role text, created_at timestamptz)
language sql security definer set search_path = public stable as $$
  select h.from_status, h.to_status, h.note,
         coalesce(sp.full_name, u.email), h.actor_role::text, h.created_at
  from public.application_status_history h
  left join public.student_profiles sp on sp.user_id = h.actor_id
  left join public.users u on u.id = h.actor_id
  where h.application_id = p_id
    and exists (select 1 from public.loan_applications la where la.id = p_id
                 and (la.user_id = auth.uid()
                      or exists (select 1 from public.users su where su.id = auth.uid()
                        and su.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                        and su.status = 'ACTIVE')));
$$;
revoke all on function public.get_application_history(uuid) from public;
grant execute on function public.get_application_history(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 5. Safe terms reader.
--
--    A student needs the terms they are being asked to accept. They do not need the accountant's
--    draft, the manager's internal note, or every previous counter-offer. Staff get the full row.
-- ---------------------------------------------------------------------------------------
create or replace function public.get_application_terms(p_application_id uuid)
returns table (
  terms_id uuid, tranche_no integer, status text, principal_amount numeric, annual_rate numeric,
  period_months integer, installment_amount numeric, total_interest numeric, total_repayable numeric,
  prepared_at timestamptz, approved_at timestamptz, accepted_at timestamptz,
  manager_comment text, accountant_comment text, return_reason text
) language plpgsql security definer set search_path = public stable as $$
declare
  v_owner uuid;
  v_is_staff boolean := false;
begin
  select a.user_id into v_owner from public.loan_applications a where a.id = p_application_id;
  if v_owner is null then raise exception 'Application not found'; end if;

  v_is_staff := coalesce(exists (
    select 1 from public.users u
     where u.id = auth.uid()
       and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and u.status = 'ACTIVE'
  ), false);

  if not (v_owner = auth.uid() or v_is_staff) then
    raise exception 'You cannot see the terms on this application';
  end if;

  return query
  select t.id, t.tranche_no, t.status, t.principal_amount, t.annual_rate,
         t.period_months, t.installment_amount, t.total_interest, t.total_repayable,
         t.prepared_at, t.approved_at, t.accepted_at,
         case when v_is_staff then t.manager_comment else null end,
         case when v_is_staff then t.accountant_comment else null end,
         case when v_is_staff then t.return_reason else null end
    from public.loan_terms t
   where t.application_id = p_application_id
     and (v_is_staff or t.status in ('APPROVED_TERMS','ACCEPTED_BY_STUDENT','DISBURSED'))
   order by t.tranche_no;
end $$;
revoke all on function public.get_application_terms(uuid) from public;
grant execute on function public.get_application_terms(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 6. Workflow reader with the internal comments kept internal.
-- ---------------------------------------------------------------------------------------
create or replace function public.get_application_workflow(p_application_id uuid)
returns table (
  stage text, from_status text, to_status text, actor_name text, actor_role text,
  comment text, created_at timestamptz
) language plpgsql security definer set search_path = public stable as $$
declare
  v_owner uuid;
  v_is_staff boolean := false;
begin
  select a.user_id into v_owner from public.loan_applications a where a.id = p_application_id;
  if v_owner is null then raise exception 'Application not found'; end if;

  v_is_staff := coalesce(exists (
    select 1 from public.users u
     where u.id = auth.uid()
       and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and u.status = 'ACTIVE'
  ), false);

  if not (v_owner = auth.uid() or v_is_staff) then
    raise exception 'You cannot see the workflow on this application';
  end if;

  return query
  select t.stage, t.from_status, t.to_status,
         coalesce(sp.full_name, u.email), t.actor_role::text,
         case when v_is_staff or t.visible_to_student then t.comment else null end,
         t.created_at
    from public.loan_workflow_transitions t
    left join public.student_profiles sp on sp.user_id = t.actor_id
    left join public.users u on u.id = t.actor_id
   where t.application_id = p_application_id
     and (v_is_staff or t.visible_to_student)
   order by t.created_at, t.id;
end $$;
revoke all on function public.get_application_workflow(uuid) from public;
grant execute on function public.get_application_workflow(uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 7. Financial settings are SUPER_ADMIN only.
--
--    The per-loan rate is prepared by the accountant and approved by the manager. Letting a
--    manager change the global default would let the same person set the rate and approve it.
-- ---------------------------------------------------------------------------------------
create or replace function public.set_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_key text := trim(coalesce(p_key, ''));
  v_value text := trim(coalesce(p_value, ''));
  v_financial text[] := array[
    'annual_interest_rate','interest_convention','min_annual_interest_rate',
    'max_annual_interest_rate','min_loan_amount','max_loan_amount',
    'max_active_loans_per_student','allowed_repayment_months','repayment_verification_required'
  ];
begin
  if v_key = '' then raise exception 'Setting key is required'; end if;
  if length(v_value) > 500 then raise exception 'Setting value is too long'; end if;

  if v_key = any (v_financial) then
    if not exists (select 1 from public.users
                    where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE') then
      raise exception 'Financial settings can only be changed by a super admin';
    end if;
  else
    if not exists (select 1 from public.users
                    where id = auth.uid() and role in ('SUPER_ADMIN','MANAGER') and status = 'ACTIVE') then
      raise exception 'Only managers or super admins can change settings';
    end if;
  end if;

  if v_key = 'allowed_repayment_months' then
    if v_value !~ '^[0-9]+(,[0-9]+)*$' then
      raise exception 'Allowed repayment periods must be a comma-separated list of months';
    end if;
    if exists (
      select 1 from unnest(string_to_array(v_value, ',')) x
       where trim(x)::integer not in (1, 2, 3)
    ) then
      raise exception 'Repayment periods must be 1, 2 or 3 months';
    end if;
  end if;

  insert into public.app_settings (key, value, updated_by, updated_at)
  values (v_key, v_value, auth.uid(), now())
  on conflict (key) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'SETTING_CHANGED', 'app_settings', v_key,
          jsonb_build_object('value', v_value));
end $$;
revoke all on function public.set_setting(text,text) from public;
grant execute on function public.set_setting(text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 8. loan_terms RLS: the student sees only the terms they are allowed to act on.
-- ---------------------------------------------------------------------------------------
drop policy if exists "owner or staff read terms" on public.loan_terms;
drop policy if exists "staff read terms" on public.loan_terms;
drop policy if exists "student reads approved terms" on public.loan_terms;

create policy "staff read terms" on public.loan_terms for select using (
  exists (
    select 1 from public.users u
     where u.id = auth.uid()
       and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and u.status = 'ACTIVE'
  )
);

create policy "student reads approved terms" on public.loan_terms for select using (
  status in ('APPROVED_TERMS','ACCEPTED_BY_STUDENT','DISBURSED')
  and exists (
    select 1 from public.loan_applications a
     where a.id = application_id and a.user_id = auth.uid()
  )
);


-- ---------------------------------------------------------------------------------------
-- 8b. Accountants and collection officers need the application file for their own queues.
--
--     006's "staff read applications" policy only listed the loan officer, manager and super
--     admin. The accountant cannot prepare terms and collections cannot chase arrears if the
--     RLS layer hides the application, its documents and its status history. Access is still
--     need-to-know: students see only their own row, and marketing officers see none of it.
-- ---------------------------------------------------------------------------------------
drop policy if exists "staff read applications" on public.loan_applications;
create policy "staff read applications" on public.loan_applications for select using (
  exists (
    select 1 from public.users u
     where u.id = auth.uid()
       and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and u.status = 'ACTIVE'
  )
);

drop policy if exists "owner or staff read application documents" on public.loan_documents;
create policy "owner or staff read application documents" on public.loan_documents
  for select using (
    exists (
      select 1 from public.loan_applications la
       where la.id = application_id
         and (la.user_id = auth.uid()
              or exists (select 1 from public.users u
                          where u.id = auth.uid()
                            and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                            and u.status = 'ACTIVE'))
    )
  );

drop policy if exists "owner or staff read application history" on public.application_status_history;
create policy "owner or staff read application history" on public.application_status_history
  for select using (
    exists (
      select 1 from public.loan_applications la
       where la.id = application_id
         and (la.user_id = auth.uid()
              or exists (select 1 from public.users u
                          where u.id = auth.uid()
                            and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
                            and u.status = 'ACTIVE'))
    )
  );



-- ---------------------------------------------------------------------------------------
-- 9. Immutable audit evidence.
--
--    The workflow transitions and the financial audit events are append-only. A disbursement may
--    change from RECORDED to VOIDED, but it may never be deleted. A repayment may be verified,
--    rejected or reversed, but never deleted. A closure is terminal.
-- ---------------------------------------------------------------------------------------
create or replace function public.prevent_evidence_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'This record is immutable. Correct it with a reversal or an audited override instead of changing or deleting it.';
end $$;
revoke all on function public.prevent_evidence_mutation() from public, anon, authenticated;

drop trigger if exists trg_financial_audit_immutable on public.financial_audit_events;
create trigger trg_financial_audit_immutable
  before update or delete on public.financial_audit_events
  for each row execute function public.prevent_evidence_mutation();

drop trigger if exists trg_workflow_transitions_immutable on public.loan_workflow_transitions;
create trigger trg_workflow_transitions_immutable
  before update or delete on public.loan_workflow_transitions
  for each row execute function public.prevent_evidence_mutation();

drop trigger if exists trg_disbursements_no_delete on public.disbursements;
create trigger trg_disbursements_no_delete
  before delete on public.disbursements
  for each row execute function public.prevent_evidence_mutation();

drop trigger if exists trg_repayments_no_delete on public.repayments;
create trigger trg_repayments_no_delete
  before delete on public.repayments
  for each row execute function public.prevent_evidence_mutation();

drop trigger if exists trg_loan_closures_immutable on public.loan_closures;
create trigger trg_loan_closures_immutable
  before update or delete on public.loan_closures
  for each row execute function public.prevent_evidence_mutation();


-- ---------------------------------------------------------------------------------------
-- 10. Private storage for payment proofs.
--
--     The path must start with the uploader's uid. Finance staff upload; the student can read the
--     proof attached to their own loan. The bucket is private, so a guessed path is not enough.
-- ---------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('payment-proofs', 'payment-proofs', false)
on conflict (id) do nothing;

drop policy if exists "finance staff upload payment proofs" on storage.objects;
create policy "finance staff upload payment proofs" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.users u
       where u.id = auth.uid()
         and u.role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
         and u.status = 'ACTIVE'
    )
  );

drop policy if exists "finance staff read payment proofs" on storage.objects;
create policy "finance staff read payment proofs" on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and exists (
      select 1 from public.users u
       where u.id = auth.uid()
         and u.role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
         and u.status = 'ACTIVE'
    )
  );

drop policy if exists "borrower reads own payment proofs" on storage.objects;
create policy "borrower reads own payment proofs" on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (
      exists (
        select 1 from public.repayments r
          join public.loans l on l.id = r.loan_id
         where r.proof_path = name and l.user_id = auth.uid()
      )
      or exists (
        select 1 from public.disbursements d
          join public.loans l on l.id = d.loan_id
         where d.proof_path = name and l.user_id = auth.uid()
      )
    )
  );


-- ---------------------------------------------------------------------------------------
-- 11. No signed-out visitor may call any workflow or money function.
--
--     A new function is executable by PUBLIC until told otherwise. The functions below are all
--     written for signed-in staff or students, so `anon` is revoked explicitly and `authenticated`
--     is granted explicitly. Internal helpers are not in this list and stay revoked.
-- ---------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'submit_loan_application','resubmit_application','forward_application_to_manager',
         'loan_officer_reject_application','manager_decide_application','return_application_to_student',
         'accountant_prepare_terms','manager_approve_terms','manager_return_terms',
         'student_accept_terms','student_decline_terms','amortization_schedule','loan_quote',
         'disburse_tranche','submit_repayment','verify_repayment','reject_repayment',
         'reverse_repayment','void_disbursement','close_loan','loan_settlement_quote',
         'submit_loan_settlement','super_admin_amend_repayment','list_pending_repayments',
         'get_loan_schedule','list_arrears','get_dashboard_stats','build_loan_schedule',
         'rebuild_loan_payments','disburse_loan','record_repayment',
         'get_application_terms','get_application_workflow','get_application_history',
         'application_student_detail','set_setting','allowed_repayment_months'
       )
  loop
    execute format('revoke all on function %s from public, anon', r.signature);
    execute format('grant execute on function %s to authenticated', r.signature);
  end loop;
end $$;


-- ---------------------------------------------------------------------------------------
-- 12. Verification queries. Read-only.
-- ---------------------------------------------------------------------------------------
-- 12a. The 026 check must not be valid against historical data unless every row already meets it.
--      A NOT VALID constraint is still enforced for new writes.
select conname, convalidated,
       case when pg_get_constraintdef(oid) like '%1, 2, 3%' then 'PASS - three-month policy'
            else 'FAIL - wrong definition' end as result
from pg_constraint
where conrelid = 'public.loan_applications'::regclass
  and conname = 'loan_applications_repayment_period_months_check';

-- 12b. Marketing officers must not be able to read an applicant's contact sheet.
select p.proname,
       case when p.prosrc not like '%MARKETING_OFFICER%' then 'PASS'
            else 'FAIL - marketing is still in application_student_detail' end as result
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'application_student_detail';

-- 12c. Financial settings are SUPER_ADMIN only.
select p.proname,
       case when p.prosrc like '%Financial settings can only be changed by a super admin%' then 'PASS'
            else 'FAIL - financial settings are still manager-writable' end as result
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_setting';

-- 12d. The safe terms and workflow readers exist.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('get_application_terms','get_application_workflow')
order by proname;

-- 12e. The evidence triggers exist.
select tgname, c.relname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal
  and tgname in ('trg_financial_audit_immutable','trg_workflow_transitions_immutable',
                 'trg_disbursements_no_delete','trg_repayments_no_delete',
                 'trg_loan_closures_immutable')
order by tgname;

-- 12f. The private proof bucket exists.
select id,
       case when public then 'FAIL - bucket is public' else 'PASS - private' end as result
from storage.buckets
where id = 'payment-proofs';

-- 12g. No workflow or money function may be executable by anon.
select p.oid::regprocedure::text as function,
       case when has_function_privilege('anon', p.oid, 'execute') then 'FAIL - anon can execute'
            else 'PASS' end as result
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'disburse_tranche','submit_repayment','verify_repayment','reject_repayment',
    'reverse_repayment','void_disbursement','close_loan','loan_settlement_quote',
    'submit_loan_settlement','super_admin_amend_repayment','student_accept_terms',
    'student_decline_terms','accountant_prepare_terms','manager_approve_terms',
    'manager_return_terms','forward_application_to_manager','manager_decide_application'
  )
order by 1;

notify pgrst, 'reload schema';
