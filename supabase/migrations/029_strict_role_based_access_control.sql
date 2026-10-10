-- Enforce least-privilege access for every staff role.
-- Run after 028_add_ceo_role.sql. The browser permission matrix is UX only; this migration is
-- the authority for PostgREST reads and SECURITY DEFINER operations.

-- Only the super admin is a system administrator. In particular, managers no longer inherit
-- staff-management, settings, audit-log, or RUCU-register access through this helper.
create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE'
  );
$$;

-- Staff/student profile reads are separate from role assignment and settings.
drop policy if exists "staff read student profiles" on public.student_profiles;
create policy "staff read student profiles" on public.student_profiles
  for select to authenticated using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and u.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN')
    )
  );

drop policy if exists "staff read verification requests" on public.verification_requests;
create policy "staff read verification requests" on public.verification_requests
  for select to authenticated using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and u.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN')
    )
  );

-- A loan officer assesses an application; the CEO is the normal final approver. Managers retain
-- operational approval authority. Accountants see only approved applications for disbursement.
drop policy if exists "staff read applications" on public.loan_applications;
create policy "staff read applications" on public.loan_applications
  for select to authenticated using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and (
          u.role in ('LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN')
          or (u.role = 'ACCOUNTANT' and public.loan_applications.status = 'APPROVED')
        )
    )
  );

drop policy if exists "owner or staff read loans" on public.loans;
create policy "owner or permitted staff read loans" on public.loans
  for select to authenticated using (
    user_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and u.role in ('LOAN_OFFICER','ACCOUNTANT','MANAGER','CEO','SUPER_ADMIN')
        and (u.role <> 'LOAN_OFFICER' or public.loans.status = 'ACTIVE')
    )
  );

drop policy if exists "owner or staff read repayments" on public.repayments;
create policy "owner or permitted staff read repayments" on public.repayments
  for select to authenticated using (
    exists (
      select 1 from public.loans l
      where l.id = loan_id
        and (
          l.user_id = auth.uid()
          or exists (
            select 1 from public.users u
            where u.id = auth.uid() and u.status = 'ACTIVE'
              and u.role in ('ACCOUNTANT','MANAGER','CEO','SUPER_ADMIN')
          )
        )
    )
  );

drop policy if exists "staff read reminders" on public.collection_reminders;
create policy "permitted staff read reminders" on public.collection_reminders
  for select to authenticated using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and u.role in ('COLLECTION_OFFICER','MANAGER','CEO','SUPER_ADMIN')
    )
  );

drop policy if exists "owner or staff read installments" on public.loan_installments;
create policy "owner or permitted staff read installments" on public.loan_installments
  for select to authenticated using (
    exists (
      select 1 from public.loans l
      where l.id = loan_id
        and (
          l.user_id = auth.uid()
          or exists (
            select 1 from public.users u
            where u.id = auth.uid() and u.status = 'ACTIVE'
              and u.role in ('LOAN_OFFICER','ACCOUNTANT','MANAGER','CEO','SUPER_ADMIN')
              and (u.role <> 'LOAN_OFFICER' or l.status = 'ACTIVE')
          )
        )
    )
  );

-- Request/application documents are available only to the review chain, or to an accountant
-- while an approved application is being prepared for disbursement.
drop policy if exists "owner or staff read application documents" on public.loan_documents;
create policy "owner or permitted staff read application documents" on public.loan_documents
  for select to authenticated using (
    exists (
      select 1 from public.loan_applications la
      where la.id = application_id
        and (
          la.user_id = auth.uid()
          or exists (
            select 1 from public.users u
            where u.id = auth.uid() and u.status = 'ACTIVE'
              and (
                u.role in ('LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN')
                or (u.role = 'ACCOUNTANT' and la.status = 'APPROVED')
              )
          )
        )
    )
  );

drop policy if exists "owner or staff read application history" on public.application_status_history;
create policy "owner or permitted staff read application history" on public.application_status_history
  for select to authenticated using (
    exists (
      select 1 from public.loan_applications la
      where la.id = application_id
        and (
          la.user_id = auth.uid()
          or exists (
            select 1 from public.users u
            where u.id = auth.uid() and u.status = 'ACTIVE'
              and (
                u.role in ('LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN')
                or (u.role = 'ACCOUNTANT' and la.status = 'APPROVED')
              )
          )
        )
    )
  );

-- Preserve a student's own private files; staff access follows application ownership and status.
drop policy if exists "application reviewers read documents" on storage.objects;
create policy "permitted application reviewers read documents" on storage.objects
  for select to authenticated using (
    bucket_id = 'verification-documents'
    and exists (
      select 1 from public.loan_documents d
      join public.loan_applications la on la.id = d.application_id
      join public.users u on u.id = auth.uid()
      where d.storage_path = name and u.status = 'ACTIVE'
        and (
          la.user_id = auth.uid()
          or u.role in ('LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN')
          or (u.role = 'ACCOUNTANT' and la.status = 'APPROVED')
        )
    )
  );

-- Restrict high-risk table reads even if a broad permissive policy is added later.
drop policy if exists "rbac staff directory" on public.users;
create policy "rbac staff directory" on public.users
  as restrictive for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "rbac student profiles" on public.student_profiles;
create policy "rbac student profiles" on public.student_profiles
  as restrictive for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and u.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN')
    )
  );

drop policy if exists "rbac verification requests" on public.verification_requests;
create policy "rbac verification requests" on public.verification_requests
  as restrictive for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and u.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN')
    )
  );

drop policy if exists "rbac loan applications" on public.loan_applications;
create policy "rbac loan applications" on public.loan_applications
  as restrictive for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and (
          u.role in ('LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN')
          or (u.role = 'ACCOUNTANT' and public.loan_applications.status = 'APPROVED')
        )
    )
  );

drop policy if exists "rbac application history" on public.application_status_history;
create policy "rbac application history" on public.application_status_history
  as restrictive for select to authenticated
  using (
    exists (
      select 1 from public.loan_applications la
      where la.id = application_id
        and (
          la.user_id = auth.uid()
          or exists (
            select 1 from public.users u
            where u.id = auth.uid() and u.status = 'ACTIVE'
              and (
                u.role in ('LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN')
                or (u.role = 'ACCOUNTANT' and la.status = 'APPROVED')
              )
          )
        )
    )
  );

drop policy if exists "rbac loan documents" on public.loan_documents;
create policy "rbac loan documents" on public.loan_documents
  as restrictive for select to authenticated
  using (
    exists (
      select 1 from public.loan_applications la
      where la.id = application_id
        and (
          la.user_id = auth.uid()
          or exists (
            select 1 from public.users u
            where u.id = auth.uid() and u.status = 'ACTIVE'
              and (
                u.role in ('LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN')
                or (u.role = 'ACCOUNTANT' and la.status = 'APPROVED')
              )
          )
        )
    )
  );

drop policy if exists "rbac loans" on public.loans;
create policy "rbac loans" on public.loans
  as restrictive for select to authenticated using (
    user_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and u.role in ('LOAN_OFFICER','ACCOUNTANT','MANAGER','CEO','SUPER_ADMIN')
        and (u.role <> 'LOAN_OFFICER' or public.loans.status = 'ACTIVE')
    )
  );

drop policy if exists "rbac repayments" on public.repayments;
create policy "rbac repayments" on public.repayments
  as restrictive for select to authenticated using (
    exists (
      select 1 from public.loans l
      where l.id = loan_id
        and (
          l.user_id = auth.uid()
          or exists (
            select 1 from public.users u
            where u.id = auth.uid() and u.status = 'ACTIVE'
              and u.role in ('ACCOUNTANT','MANAGER','CEO','SUPER_ADMIN')
          )
        )
    )
  );

drop policy if exists "rbac collections" on public.collection_reminders;
create policy "rbac collections" on public.collection_reminders
  as restrictive for select to authenticated using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.status = 'ACTIVE'
        and u.role in ('COLLECTION_OFFICER','MANAGER','CEO','SUPER_ADMIN')
    )
  );

drop policy if exists "rbac installments" on public.loan_installments;
create policy "rbac installments" on public.loan_installments
  as restrictive for select to authenticated using (
    exists (
      select 1 from public.loans l
      where l.id = loan_id
        and (
          l.user_id = auth.uid()
          or exists (
            select 1 from public.users u
            where u.id = auth.uid() and u.status = 'ACTIVE'
              and u.role in ('LOAN_OFFICER','ACCOUNTANT','MANAGER','CEO','SUPER_ADMIN')
            and (u.role <> 'LOAN_OFFICER' or l.status = 'ACTIVE')
        )
      )
    )
  );

drop policy if exists "rbac settings" on public.app_settings;
create policy "rbac settings" on public.app_settings
  as restrictive for select to authenticated using (public.is_admin());

drop policy if exists "rbac audit logs" on public.audit_logs;
create policy "rbac audit logs" on public.audit_logs
  as restrictive for select to authenticated using (public.is_admin());

drop policy if exists "rbac RUCU register" on public.rucu_students;
create policy "rbac RUCU register" on public.rucu_students
  as restrictive for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Verification decisions are a Loan Officer task; manager oversight and the super admin retain
-- approval capability. CEO application approval does not confer student-verification authority.
create or replace function public.review_verification(p_request_id uuid, p_decision text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and status = 'ACTIVE'
      and role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN')
  ) then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: loan verification is restricted to Loan Officers, Managers, and Super Admins';
  end if;
  if p_decision is null or p_decision not in ('VERIFIED','REJECTED') then
    raise exception 'Invalid decision';
  end if;
  if p_decision = 'REJECTED' and length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Please give the student a reason for the rejection';
  end if;

  select user_id into v_user from public.verification_requests
  where id = p_request_id and status = 'PENDING';
  if v_user is null then raise exception 'Request not found or has already been reviewed'; end if;

  perform public.trusted_write();
  update public.verification_requests
  set status = p_decision::public.request_status,
      rejection_reason = case when p_decision = 'REJECTED' then trim(p_reason) else null end,
      reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_request_id;
  update public.student_profiles
  set verification_status = p_decision::public.verification_status
  where user_id = v_user;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(), 'VERIFICATION_' || p_decision, 'verification_requests', p_request_id::text,
    jsonb_build_object('reason', p_reason)
  );
end $$;
revoke all on function public.review_verification(uuid,text,text) from public;
grant execute on function public.review_verification(uuid,text,text) to authenticated;

-- Loan officers may assess and request information, but cannot make the final lending decision.
create or replace function public.review_loan_application(p_id uuid, p_decision text, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_to text;
  v_role public.user_role;
begin
  select role into v_role from public.users
  where id = auth.uid() and status = 'ACTIVE';
  if v_role is null or v_role not in ('LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN') then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: your role cannot review loan applications';
  end if;
  if p_decision is null or p_decision not in ('UNDER_REVIEW','ACTION_REQUIRED','APPROVED','REJECTED') then
    raise exception 'Invalid decision';
  end if;
  if v_role = 'LOAN_OFFICER' and p_decision not in ('UNDER_REVIEW','ACTION_REQUIRED') then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: only the CEO, a Manager, or a Super Admin can approve or reject a loan';
  end if;
  if v_role = 'CEO' and p_decision not in ('APPROVED','REJECTED') then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: the CEO role is limited to final approval decisions';
  end if;
  if p_decision = 'REJECTED' and length(trim(coalesce(p_notes, ''))) < 3 then
    raise exception 'Please give a reason for the rejection — the student is shown it';
  end if;
  if p_decision = 'ACTION_REQUIRED' and length(trim(coalesce(p_notes, ''))) < 3 then
    raise exception 'Please say what the student needs to provide — they are shown it';
  end if;

  select status into v_from from public.loan_applications where id = p_id for update;
  if v_from is null then raise exception 'Application not found'; end if;
  if v_from not in ('SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') then
    raise exception 'This application is % and cannot be reviewed further', v_from;
  end if;
  v_to := p_decision;

  update public.loan_applications
  set status = v_to,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_notes = nullif(trim(coalesce(p_notes, '')), ''),
      action_required_note = case
        when v_to = 'ACTION_REQUIRED' then nullif(trim(coalesce(p_notes, '')), '')
        when v_to in ('UNDER_REVIEW','APPROVED') then null
        else action_required_note
      end
  where id = p_id;

  insert into public.application_status_history
    (application_id, from_status, to_status, actor_id, actor_role, note)
  values (
    p_id, v_from, v_to, auth.uid(), v_role,
    nullif(trim(coalesce(p_notes, '')), '')
  );
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(), 'LOAN_APPLICATION_' || v_to, 'loan_applications', p_id::text,
    jsonb_build_object('notes', p_notes)
  );
end $$;
revoke all on function public.review_loan_application(uuid,text,text) from public;
grant execute on function public.review_loan_application(uuid,text,text) to authenticated;

-- Disbursement belongs to the Accountant. Keep the database-side loan caps, verification checks,
-- schedule generation, and audit record in the same atomic operation.
create or replace function public.disburse_loan(p_application_id uuid, p_amount numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_loan_id uuid;
  v_user uuid;
  v_approved numeric;
  v_max numeric;
  v_cap integer;
  v_active integer;
  v_verified public.verification_status;
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and role in ('ACCOUNTANT','SUPER_ADMIN') and status = 'ACTIVE'
  ) then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: only Accountants or Super Admins can disburse loans';
  end if;
  select user_id, amount into v_user, v_approved
  from public.loan_applications
  where id = p_application_id and status = 'APPROVED'
  for update;
  if v_user is null then raise exception 'Application not found or not approved'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if p_amount > v_approved then
    raise exception 'Disbursement amount (%) exceeds the approved amount (%)', p_amount, v_approved;
  end if;

  select verification_status into v_verified
  from public.student_profiles where user_id = v_user;
  if v_verified is distinct from 'VERIFIED' then
    raise exception 'The student is no longer verified (current status: %), so this cannot be disbursed',
      coalesce(v_verified::text, 'no profile');
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
  values (p_application_id, v_user, p_amount, p_amount, auth.uid())
  returning id into v_loan_id;

  perform public.trusted_write();
  perform public.build_loan_schedule(v_loan_id);
  update public.loan_applications set status = 'DISBURSED' where id = p_application_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(), 'LOAN_DISBURSED', 'loans', v_loan_id::text,
    jsonb_build_object(
      'amount', p_amount,
      'approved_amount', v_approved,
      'interest_rate', public.setting_num('annual_interest_rate', 0)
    )
  );
  return v_loan_id;
end $$;
revoke all on function public.disburse_loan(uuid,numeric) from public;
grant execute on function public.disburse_loan(uuid,numeric) to authenticated;

-- Repayment recording and loan-search RPCs are finance tasks, not collection field access.
do $$
declare
  v_function record;
  v_source text;
  v_definition text;
  v_old text;
  v_new text;
begin
  for v_function in
    select p.oid, p.prosrc, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('record_repayment','search_active_loans')
  loop
    v_source := v_function.prosrc;
    v_old := 'role in (''ACCOUNTANT'',''COLLECTION_OFFICER'',''MANAGER'',''SUPER_ADMIN'')';
    v_new := 'role in (''ACCOUNTANT'',''MANAGER'',''SUPER_ADMIN'')';
    if position(v_old in v_source) = 0 and position(v_new in v_source) = 0 then
      raise exception 'Could not find expected repayment authorization in %', v_function.proname;
    end if;
    v_source := replace(v_source, v_old, v_new);
    if v_function.proname = 'record_repayment' then
      v_old := 'raise exception ''Only accountants, collection officers, managers or super admins can record repayments'';';
      v_new := 'raise insufficient_privilege using message = ''403 Unauthorized / Access Denied: only Accountants or Super Admins can record repayments'';';
      v_source := replace(v_source, v_old, v_new);
    else
      v_old := 'raise exception ''Only finance staff can search active loans'';';
      v_new := 'raise insufficient_privilege using message = ''403 Unauthorized / Access Denied: only authorized finance staff can search active loans'';';
      v_source := replace(v_source, v_old, v_new);
    end if;
    v_definition := replace(pg_get_functiondef(v_function.oid), v_function.prosrc, v_source);
    execute v_definition;
  end loop;
end $$;

-- Accountants reconcile and collect payments. Managers and the super admin can review arrears,
-- but only collection officers, managers, and the super admin can make field follow-up changes.
create or replace function public.list_arrears()
returns table (
  loan_id uuid, student_name text, university text, outstanding numeric,
  due_date date, days_overdue integer, installments_missed bigint, total_due numeric, amount_paid numeric
) language plpgsql security definer set search_path = public stable as $$
begin
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.status = 'ACTIVE'
      and u.role in ('COLLECTION_OFFICER','MANAGER','CEO','SUPER_ADMIN')
  ) then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: arrears access is restricted to Collection Officers, Managers, the CEO, and Super Admins';
  end if;
  return query
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
  group by l.id, sp.full_name, sp.university
  order by min(i.due_date);
end;
$$;
revoke all on function public.list_arrears() from public;
grant execute on function public.list_arrears() to authenticated;

create or replace function public.log_reminder(p_loan_id uuid, p_channel text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.users where id = auth.uid() and status = 'ACTIVE'
      and role in ('COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
  ) then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: collection reminders are restricted to Collection Officers, Managers, and Super Admins';
  end if;
  if p_channel is null or p_channel not in ('SMS','EMAIL','CALL','VISIT') then
    raise exception 'Invalid reminder channel';
  end if;
  if not exists (select 1 from public.loans where id = p_loan_id) then
    raise exception 'Loan not found';
  end if;
  insert into public.collection_reminders (loan_id, channel, note, sent_by)
  values (p_loan_id, p_channel, nullif(trim(coalesce(p_note, '')), ''), auth.uid());
  insert into public.audit_logs (actor_id, action, entity, entity_id)
  values (auth.uid(), 'REMINDER_LOGGED', 'loans', p_loan_id::text);
end $$;
revoke all on function public.log_reminder(uuid,text,text) from public;
grant execute on function public.log_reminder(uuid,text,text) to authenticated;

-- Aggregate portfolio analytics are available to finance, management, and the CEO only.
drop function if exists public.get_dashboard_stats();
create function public.get_dashboard_stats()
returns table (
  total_students bigint, verified_students bigint, total_applications bigint, submitted_applications bigint,
  approved_applications bigint, total_disbursed numeric, total_collected numeric,
  outstanding_portfolio numeric, active_loans bigint, total_repayable numeric,
  interest_billed numeric, overdue_balance numeric, loans_in_arrears bigint
) language plpgsql security definer set search_path = public stable as $$
begin
  if not exists (
    select 1 from public.users u where u.id = auth.uid() and u.status = 'ACTIVE'
      and u.role in ('ACCOUNTANT','MANAGER','CEO','SUPER_ADMIN')
  ) then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: financial reports are restricted to Accountants, Managers, the CEO, and Super Admins';
  end if;
  return query
  select
    (select count(*) from public.users where role = 'STUDENT' and status = 'ACTIVE'),
    (select count(*) from public.student_profiles where verification_status = 'VERIFIED'),
    (select count(*) from public.loan_applications),
    (select count(*) from public.loan_applications where status <> 'DRAFT'),
    (select count(*) from public.loan_applications where status in ('APPROVED','DISBURSED')),
    (select coalesce(sum(principal_amount),0) from public.loans),
    (select coalesce(sum(amount),0) from public.repayments where reversed_at is null),
    (select coalesce(sum(outstanding_balance),0) from public.loans where status = 'ACTIVE'),
    (select count(*) from public.loans where status = 'ACTIVE'),
    (select coalesce(sum(i.amount_due),0) from public.loan_installments i),
    (select coalesce(sum(i.amount_due),0) from public.loan_installments i)
      - (select coalesce(sum(principal_amount),0) from public.loans),
    (select coalesce(sum(i.amount_due - i.amount_paid),0)
     from public.loan_installments i join public.loans l on l.id = i.loan_id
     where l.status in ('ACTIVE','DEFAULTED') and i.amount_due > i.amount_paid and i.due_date <= now()::date),
    (select count(distinct i.loan_id)
     from public.loan_installments i join public.loans l on l.id = i.loan_id
     where l.status in ('ACTIVE','DEFAULTED') and i.amount_due > i.amount_paid and i.due_date <= now()::date)
  ;
end;
$$;
revoke all on function public.get_dashboard_stats() from public;
grant execute on function public.get_dashboard_stats() to authenticated;

create or replace function public.get_applications_by_university()
returns table (university text, applications bigint, approved bigint)
language sql security definer set search_path = public stable as $$
  select sp.university, count(*), count(*) filter (where la.status in ('APPROVED','DISBURSED'))
  from public.loan_applications la
  join public.student_profiles sp on sp.user_id = la.user_id
  where exists (
    select 1 from public.users u where u.id = auth.uid() and u.status = 'ACTIVE'
      and u.role in ('ACCOUNTANT','MANAGER','CEO','SUPER_ADMIN')
  )
  group by sp.university;
$$;
revoke all on function public.get_applications_by_university() from public;
grant execute on function public.get_applications_by_university() to authenticated;

-- Restrict financial configuration and staff lifecycle to the super admin.
create or replace function public.set_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: only an active Super Admin can change settings';
  end if;
  if p_key is null or length(trim(p_key)) = 0 or length(trim(p_key)) > 120 then
    raise exception 'Invalid setting key';
  end if;
  if p_value is null or length(trim(p_value)) > 500 then
    raise exception 'Setting value is invalid or too long';
  end if;
  insert into public.app_settings (key, value, updated_by, updated_at)
  values (trim(p_key), trim(p_value), auth.uid(), now())
  on conflict (key) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'SETTING_CHANGED', 'app_settings', trim(p_key),
          jsonb_build_object('value', trim(p_value)));
end $$;
revoke all on function public.set_setting(text,text) from public;
grant execute on function public.set_setting(text,text) to authenticated;

create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_current public.user_role;
  v_admins integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('ogeseous.super_admin_membership', 0));
  if not public.is_admin() then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: only an active Super Admin can assign roles';
  end if;
  if p_user_id = auth.uid() then raise exception 'You cannot change your own role'; end if;
  if p_role is null or p_role not in (
    'STUDENT','LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER',
    'MARKETING_OFFICER','MANAGER','CEO','SUPER_ADMIN'
  ) then
    raise exception 'Unknown role: %', p_role;
  end if;

  select role into v_current from public.users where id = p_user_id for update;
  if not found then raise exception 'No such user'; end if;
  if v_current = 'SUPER_ADMIN' and p_role <> 'SUPER_ADMIN' then
    select count(*) into v_admins from public.users where role = 'SUPER_ADMIN' and status = 'ACTIVE';
    if v_admins <= 1 then
      raise exception 'This is the last active super admin — promote someone else first';
    end if;
  end if;

  perform public.trusted_write();
  update public.users set role = p_role::public.user_role where id = p_user_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'ROLE_CHANGED', 'users', p_user_id::text,
          jsonb_build_object('from', v_current, 'to', p_role));
end $$;
revoke all on function public.set_user_role(uuid,text) from public;
grant execute on function public.set_user_role(uuid,text) to authenticated;

-- Extend CEO access to application history/details without granting the former broad staff roles.
do $$
declare
  v_function record;
  v_source text;
  v_definition text;
  v_old text;
  v_new text;
begin
  for v_function in
    select p.oid, p.prosrc, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('get_application_history','application_student_detail')
  loop
    v_source := v_function.prosrc;
    if v_function.proname = 'get_application_history' then
      v_old := 'and su.role in (''LOAN_OFFICER'',''MANAGER'',''SUPER_ADMIN'') and su.status = ''ACTIVE''';
      v_new := 'and su.role in (''LOAN_OFFICER'',''MANAGER'',''CEO'',''SUPER_ADMIN'',''ACCOUNTANT'') and su.status = ''ACTIVE'' and (su.role <> ''ACCOUNTANT'' or la.status = ''APPROVED'')';
      if position(v_old in v_source) = 0 then
        raise exception 'Could not find expected application-history authorization';
      end if;
      v_source := replace(v_source, v_old, v_new);
    else
      v_old := 's.role in (''LOAN_OFFICER'',''ACCOUNTANT'',''COLLECTION_OFFICER'',''MARKETING_OFFICER'',''MANAGER'',''SUPER_ADMIN'')';
      v_new := 's.role in (''LOAN_OFFICER'',''ACCOUNTANT'',''MANAGER'',''CEO'',''SUPER_ADMIN'')';
      if position(v_old in v_source) = 0 then
        raise exception 'Could not find expected application-student authorization';
      end if;
      v_source := replace(v_source, v_old, v_new);
      v_old := 'and s.status = ''ACTIVE''';
      v_new := 'and s.status = ''ACTIVE'' and (s.role <> ''ACCOUNTANT'' or a.status = ''APPROVED'')';
      if position(v_old in v_source) = 0 then
        raise exception 'Could not find active-user check in application-student detail';
      end if;
      v_source := replace(v_source, v_old, v_new);
    end if;
    v_definition := replace(pg_get_functiondef(v_function.oid), v_function.prosrc, v_source);
    execute v_definition;
  end loop;
end $$;

-- Manager oversight is read-only for ordinary repayment entry; only Accountants and the super
-- admin may post payment transactions.
do $$
declare
  v_oid oid;
  v_source text;
  v_old text := 'role in (''ACCOUNTANT'',''MANAGER'',''SUPER_ADMIN'')';
  v_new text := 'role in (''ACCOUNTANT'',''SUPER_ADMIN'')';
  v_definition text;
begin
  select p.oid, p.prosrc into v_oid, v_source
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_repayment';
  if v_oid is null or position(v_old in v_source) = 0 then
    raise exception 'Could not find expected repayment-record authorization';
  end if;
  v_definition := replace(pg_get_functiondef(v_oid), v_source, replace(v_source, v_old, v_new));
  execute v_definition;
end $$;

-- Align the active-loan schedule reader with the role matrix (collections use arrears-only RPCs).
do $$
declare
  v_oid oid;
  v_source text;
  v_definition text;
  v_old text := 'role in (''ACCOUNTANT'',''COLLECTION_OFFICER'',''LOAN_OFFICER'',''MANAGER'',''SUPER_ADMIN'')';
  v_new text := 'role in (''ACCOUNTANT'',''LOAN_OFFICER'',''MANAGER'',''CEO'',''SUPER_ADMIN'')';
begin
  select p.oid, p.prosrc into v_oid, v_source
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_loan_schedule';
  if v_oid is null or position(v_old in v_source) = 0 then
    raise exception 'Could not find expected loan-schedule authorization';
  end if;
  v_definition := replace(pg_get_functiondef(v_oid), v_source, replace(v_source, v_old, v_new));
  execute v_definition;
end $$;

-- Loan Officers may inspect schedules only for active loans, not closed or defaulted accounts.
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
      or exists (
        select 1 from public.users u where u.id = auth.uid() and u.status = 'ACTIVE'
          and u.role in ('ACCOUNTANT','LOAN_OFFICER','MANAGER','CEO','SUPER_ADMIN')
          and (u.role <> 'LOAN_OFFICER' or l.status = 'ACTIVE')
      ))
  order by i.seq;
$$;
revoke all on function public.get_loan_schedule(uuid) from public;
grant execute on function public.get_loan_schedule(uuid) to authenticated;

-- Ensure collection-only roles cannot read or write general repayment records by either the RPC
-- or direct table access. Direct inserts remain denied by RLS; this guard protects future RPCs.
create or replace function public.guard_repayment_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from public.users
    where id = auth.uid() and status = 'ACTIVE'
      and role in ('ACCOUNTANT','SUPER_ADMIN')
  ) then
    raise insufficient_privilege using message = '403 Unauthorized / Access Denied: only Accountants or Super Admins can record repayments';
  end if;
  return new;
end $$;
drop trigger if exists trg_repayment_role on public.repayments;
create trigger trg_repayment_role before insert on public.repayments
  for each row execute function public.guard_repayment_role();

-- Collections may follow arrears and mark a loan defaulted, but cannot disburse, collect or
-- reconcile payments. Patch the established defaulting RPC's authorization to omit accountants.
do $$
declare
  v_oid oid;
  v_source text;
  v_old text := 'role in (''COLLECTION_OFFICER'',''ACCOUNTANT'',''MANAGER'',''SUPER_ADMIN'')';
  v_new text := 'role in (''COLLECTION_OFFICER'',''MANAGER'',''SUPER_ADMIN'')';
  v_definition text;
begin
  select p.oid, p.prosrc into v_oid, v_source
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'mark_loan_defaulted';
  if v_oid is null or (position(v_old in v_source) = 0 and
                       position('role in (''COLLECTION_OFFICER'',''MANAGER'',''SUPER_ADMIN'')' in v_source) = 0) then
    raise exception 'Could not find expected loan-default authorization';
  end if;
  v_source := replace(v_source, v_old, v_new);
  v_source := replace(
    v_source,
    'raise exception ''Only collections staff can mark a loan as defaulted'';',
    'raise insufficient_privilege using message = ''403 Unauthorized / Access Denied: only Collection Officers, Managers, or Super Admins can mark a loan as defaulted'';'
  );
  v_definition := replace(pg_get_functiondef(v_oid), (select prosrc from pg_proc where oid = v_oid), v_source);
  execute v_definition;
end $$;

-- Keep the generated migration history useful when validating a new installation.
comment on function public.is_admin() is 'True only for an active SUPER_ADMIN; ordinary staff permissions are role-specific.';
