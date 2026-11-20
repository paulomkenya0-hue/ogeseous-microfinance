-- Migration 035: fix ambiguous output-column `status` in submit RPC;
-- block students and ordinary staff from deleting loan applications.
-- Apply only after reviewing on staging and backing up production.

create or replace function public.submit_loan_application(p_id uuid, p_terms_accepted boolean)
returns table (application_number text, status text, submitted_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_row public.loan_applications%rowtype;
  v_num text;
  v_token text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not coalesce(p_terms_accepted, false) then
    raise exception 'You must confirm the information is correct before submitting';
  end if;

  select * into v_row from public.loan_applications where id = p_id for update;
  if v_row.id is null or v_row.user_id <> auth.uid() then raise exception 'Application not found'; end if;
  if v_row.status <> 'DRAFT' then
    raise exception 'This application has already been submitted';
  end if;
  if v_row.submitted_at is not null then raise exception 'This application has already been submitted'; end if;

  perform public.validate_application_submission(p_id);

  v_num := 'OGS-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.application_number_seq')::text, 6, '0');
  v_token := public.new_verification_token();

  update public.loan_applications
     set status = 'PENDING_LOAN_OFFICER',
         action_required_note = null,
         terms_accepted = true, terms_accepted_at = now(), submitted_at = now(),
         application_number = v_num, verification_token = v_token
   where loan_applications.id = p_id and loan_applications.status = 'DRAFT';
  if not found then raise exception 'This application has already been submitted'; end if;

  perform public.record_workflow_transition(
    p_id, 'STUDENT_SUBMIT', 'DRAFT', 'PENDING_LOAN_OFFICER',
    'Submitted by the student', null, true,
    jsonb_build_object('application_number', v_num));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_SUBMITTED', 'loan_applications', p_id::text,
            jsonb_build_object('application_number', v_num, 'amount', v_row.amount));

  return query select v_num, 'PENDING_LOAN_OFFICER'::text, now();
end $$;
revoke all on function public.submit_loan_application(uuid,boolean) from public;
grant execute on function public.submit_loan_application(uuid,boolean) to authenticated;

-- Defence in depth: a DELETE from any authenticated user must be authorized
-- independently of frontend controls and RLS policy changes.
create or replace function public.guard_loan_application_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  -- No authenticated caller: permit trusted database maintenance only.
  -- Service-role requests with a user JWT still have auth.uid() and are checked.
  if auth.uid() is not null then
    select u.role into v_role from public.users u
     where u.id = auth.uid() and u.status = 'ACTIVE';
    if coalesce(v_role, '') not in ('MANAGER', 'SUPER_ADMIN') then
      raise exception 'Only an active Manager or Super Admin can delete a loan application'
        using errcode = '42501';
    end if;
  end if;
  if exists (select 1 from public.loans l where l.application_id = old.id) then
    raise exception 'Application linked to a loan cannot be deleted; use a documented closure workflow'
      using errcode = '23503';
  end if;
  return old;
end $$;

drop trigger if exists trg_guard_loan_application_delete on public.loan_applications;
create trigger trg_guard_loan_application_delete
before delete on public.loan_applications
for each row execute function public.guard_loan_application_delete();
revoke all on function public.guard_loan_application_delete() from public, anon, authenticated;
