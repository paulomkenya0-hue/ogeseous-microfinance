-- OGESEOUS MICROFINANCE — Staff administration
-- Run after 011_security_hardening.sql. Copyright © Paulo Mkenya
--
-- Closes a gap that SECURITY.md and the README both papered over: they say staff accounts are
-- "created through the app", but before this migration there was no way to do that at all. The
-- only path to a role change was a hand-written UPDATE in the SQL editor, which meant:
--
--   * every staff member was onboarded outside any audit trail;
--   * the users table had a SUSPENDED status that nothing in the system could ever set, so a
--     leaver's access could not be revoked without a manual database edit;
--   * an administrator who wanted a colleague's access removed had to be trusted with SQL access.
--
-- Everything here goes through SECURITY DEFINER functions, so there is still no UPDATE policy on
-- public.users and a direct write is still refused by the guard trigger.
--
-- Deliberately stricter than is_admin(): role assignment is SUPER_ADMIN only, NOT manager. A
-- MANAGER must not be able to mint a SUPER_ADMIN, or the two-admin control is worth nothing.

-- ---------------------------------------------------------------------------------------
-- Keep public.users.email in step with auth.users.email.
--
-- 011's guard now refuses any email change made through the app, which is right — the app is not
-- the authority on a login address. But that leaves public.users.email free to go stale if the
-- user changes their address in Supabase Auth, and the admin staff list shows that address.
-- Syncing it from the auth side removes the drift without opening a write path.
-- ---------------------------------------------------------------------------------------
create or replace function public.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.users set email = new.email where id = new.id;
  end if;
  return new;
end $$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();


-- ---------------------------------------------------------------------------------------
-- Role assignment.
--
-- Lockout guards, because a mis-click here can leave nobody able to administer the system:
--   * you cannot change your own role;
--   * the last active SUPER_ADMIN cannot be demoted.
-- ---------------------------------------------------------------------------------------
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare v_current public.user_role; v_admins integer;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE') then
    raise exception 'Only a super admin can assign roles';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  if p_role not in ('STUDENT','LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MARKETING_OFFICER','MANAGER','SUPER_ADMIN') then
    raise exception 'Unknown role: %', p_role;
  end if;
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'No such user';
  end if;

  select role into v_current from public.users where id = p_user_id;

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


-- ---------------------------------------------------------------------------------------
-- Suspension. This is the off-switch: every money and verification function checks
-- status = 'ACTIVE', so a suspended account stops working immediately, everywhere, at once.
-- ---------------------------------------------------------------------------------------
create or replace function public.set_user_status(p_user_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare v_current public.user_status; v_admins integer; v_role public.user_role;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE') then
    raise exception 'Only a super admin can suspend or reactivate accounts';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot change your own account status';
  end if;
  if p_status not in ('ACTIVE','SUSPENDED') then
    raise exception 'Unknown status: %', p_status;
  end if;
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'No such user';
  end if;

  select status, role into v_current, v_role from public.users where id = p_user_id;

  if v_role = 'SUPER_ADMIN' and p_status = 'SUSPENDED' then
    select count(*) into v_admins from public.users where role = 'SUPER_ADMIN' and status = 'ACTIVE';
    if v_admins <= 1 then
      raise exception 'This is the last active super admin — promote someone else first';
    end if;
  end if;

  -- A live loan belongs to the student, not to the account. Suspension stops access; it must not
  -- pretend the debt disappeared. Refuse it loudly instead.
  if v_role = 'STUDENT' and p_status = 'SUSPENDED'
     and exists (select 1 from public.loans where user_id = p_user_id and status = 'ACTIVE') then
    raise exception 'This student still has an active loan. Settle or write it off before suspending the account.';
  end if;

  perform public.trusted_write();
  update public.users set status = p_status::public.user_status where id = p_user_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'STATUS_CHANGED', 'users', p_user_id::text,
          jsonb_build_object('from', v_current, 'to', p_status));
end $$;
revoke all on function public.set_user_status(uuid,text) from public;
grant execute on function public.set_user_status(uuid,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- Link a marketing officer record to a login, so the officer can see their own referral count.
-- ---------------------------------------------------------------------------------------
create or replace function public.link_marketing_officer(p_officer_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can link marketing officers'; end if;
  if p_user_id is null then
    update public.marketing_officers set user_id = null where id = p_officer_id;
    return;
  end if;
  if not exists (select 1 from public.users where id = p_user_id and role = 'MARKETING_OFFICER' and status = 'ACTIVE') then
    raise exception 'That user is not an active marketing officer';
  end if;
  update public.marketing_officers set user_id = p_user_id where id = p_officer_id;
  insert into public.audit_logs (actor_id, action, entity, entity_id)
  values (auth.uid(), 'MARKETING_OFFICER_LINKED', 'marketing_officers', p_officer_id::text);
end $$;
revoke all on function public.link_marketing_officer(uuid,uuid) from public;
grant execute on function public.link_marketing_officer(uuid,uuid) to authenticated;

-- create_marketing_officer() took p_user_id but never checked the role it was given. Same rule.
create or replace function public.create_marketing_officer(p_full_name text, p_university text, p_user_id uuid default null)
returns table (id uuid, referral_code text) language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; v_tries int := 0;
begin
  if not public.is_admin() then raise exception 'Only admins can create marketing officers'; end if;
  if length(trim(coalesce(p_full_name, ''))) < 3 then raise exception 'Enter the officer''s full name'; end if;
  if p_university not in ('RUCU','MKWAWA','IU') then raise exception 'Invalid university'; end if;
  if p_user_id is not null and not exists (
    select 1 from public.users where id = p_user_id and role = 'MARKETING_OFFICER' and status = 'ACTIVE') then
    raise exception 'That user is not an active marketing officer';
  end if;
  loop
    v_code := 'OG-' || p_university || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
    begin
      insert into public.marketing_officers (full_name, university, referral_code, user_id)
      values (trim(p_full_name), p_university, v_code, p_user_id) returning marketing_officers.id into v_id;
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 5 then raise exception 'Could not generate a unique referral code — please try again'; end if;
    end;
  end loop;
  insert into public.audit_logs (actor_id, action, entity, entity_id)
  values (auth.uid(), 'MARKETING_OFFICER_CREATED', 'marketing_officers', v_id::text);
  return query select v_id, v_code;
end $$;
revoke all on function public.create_marketing_officer(text,text,uuid) from public;
grant execute on function public.create_marketing_officer(text,text,uuid) to authenticated;


-- ---------------------------------------------------------------------------------------
-- Staff directory for /admin/settings.
--
-- A function rather than a direct SELECT on public.users, so the browser never receives the full
-- student list (and every student's email address) just to render a staff table.
-- ---------------------------------------------------------------------------------------
create or replace function public.list_staff()
returns table (
  id uuid, email text, role public.user_role, status public.user_status,
  verified bigint, active_loans bigint, outstanding numeric, created_at timestamptz
) language sql security definer set search_path = public stable as $$
  select u.id, u.email, u.role, u.status,
    (select count(*) from public.student_profiles sp where sp.user_id = u.id and sp.verification_status = 'VERIFIED'),
    (select count(*) from public.loans l where l.user_id = u.id and l.status = 'ACTIVE'),
    (select coalesce(sum(l.outstanding_balance), 0) from public.loans l where l.user_id = u.id and l.status = 'ACTIVE'),
    u.created_at
  from public.users u
  where u.role <> 'STUDENT' and public.is_admin()
  order by u.role, u.email;
$$;
revoke all on function public.list_staff() from public;
grant execute on function public.list_staff() to authenticated;

-- Find a student by email or registration number when revoking access. Also a function, for the
-- same reason.
create or replace function public.find_user(p_query text)
returns table (id uuid, email text, role public.user_role, status public.user_status, full_name text, university text)
language sql security definer set search_path = public stable as $$
  select u.id, u.email, u.role, u.status, sp.full_name, sp.university
  from public.users u
  left join public.student_profiles sp on sp.user_id = u.id
  where public.is_admin()
    and (lower(u.email) = lower(trim(p_query)) or lower(sp.registration_number) = lower(trim(p_query)))
  limit 5;
$$;
revoke all on function public.find_user(text) from public;
grant execute on function public.find_user(text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- Audit log readers.
--
-- audit_logs is the main fraud control in this system and had no way to be read in the UI at all.
-- RLS already limits the table to admins, so these only add the action list for the filter
-- dropdown; the log itself is queried directly with limit/offset for pagination.
-- ---------------------------------------------------------------------------------------
create or replace function public.list_audit_actions()
returns table (action text, times bigint) language sql security definer set search_path = public stable as $$
  select a.action, count(*) from public.audit_logs a
  where public.is_admin() group by a.action order by count(*) desc;
$$;
revoke all on function public.list_audit_actions() from public;
grant execute on function public.list_audit_actions() to authenticated;
