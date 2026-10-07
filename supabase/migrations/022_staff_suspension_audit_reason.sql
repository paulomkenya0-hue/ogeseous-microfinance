-- Require the suspension reason collected by AdminSettings and retain it in the audit trail.
-- Drop the old signature so callers cannot bypass the reason by using the two-argument RPC.

drop function if exists public.set_user_status(uuid, text);

create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_current public.user_role;
  v_admins integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('ogeseous.super_admin_membership', 0));
  if not exists (
    select 1 from public.users
    where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE'
  ) then
    raise exception 'Only a super admin can assign roles';
  end if;
  if p_user_id = auth.uid() then raise exception 'You cannot change your own role'; end if;
  if p_role is null or p_role not in (
    'STUDENT', 'LOAN_OFFICER', 'ACCOUNTANT', 'COLLECTION_OFFICER',
    'MARKETING_OFFICER', 'MANAGER', 'SUPER_ADMIN'
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
  values (
    auth.uid(), 'ROLE_CHANGED', 'users', p_user_id::text,
    jsonb_build_object('from', v_current, 'to', p_role)
  );
end $$;

create or replace function public.set_user_status(p_user_id uuid, p_status text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_current public.user_status;
  v_admins integer;
  v_role public.user_role;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  perform pg_advisory_xact_lock(hashtextextended('ogeseous.super_admin_membership', 0));
  if not exists (
    select 1 from public.users
    where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE'
  ) then
    raise exception 'Only a super admin can suspend or reactivate accounts';
  end if;
  if p_user_id = auth.uid() then raise exception 'You cannot change your own account status'; end if;
  if p_status is null or p_status not in ('ACTIVE', 'SUSPENDED') then
    raise exception 'Unknown status: %', p_status;
  end if;
  if p_status = 'SUSPENDED' and length(coalesce(v_reason, '')) < 3 then
    raise exception 'A suspension reason of at least 3 characters is required';
  end if;

  select status, role into v_current, v_role
  from public.users where id = p_user_id for update;
  if not found then raise exception 'No such user'; end if;

  if v_role = 'SUPER_ADMIN' and p_status = 'SUSPENDED' then
    select count(*) into v_admins from public.users where role = 'SUPER_ADMIN' and status = 'ACTIVE';
    if v_admins <= 1 then
      raise exception 'This is the last active super admin — promote someone else first';
    end if;
  end if;

  if v_role = 'STUDENT' and p_status = 'SUSPENDED'
     and exists (select 1 from public.loans where user_id = p_user_id and status = 'ACTIVE') then
    raise exception 'This student still has an active loan. Settle or write it off before suspending the account.';
  end if;

  perform public.trusted_write();
  update public.users set status = p_status::public.user_status where id = p_user_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    auth.uid(), 'STATUS_CHANGED', 'users', p_user_id::text,
    jsonb_build_object('from', v_current, 'to', p_status, 'reason', v_reason)
  );
end $$;

revoke all on function public.set_user_status(uuid, text, text) from public;
grant execute on function public.set_user_status(uuid, text, text) to authenticated;