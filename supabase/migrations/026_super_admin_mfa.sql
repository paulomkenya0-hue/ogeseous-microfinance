-- OGESEOUS MICROFINANCE - Require TOTP MFA for super-admin sessions.
-- Run after 025_rucu_explicit_confirmation.sql.

create or replace function public.super_admin_mfa_satisfied() returns boolean
language sql security definer stable set search_path = public as $$
  select not exists (
    select 1 from public.users
    where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE'
  ) or auth.jwt() ->> 'aal' = 'aal2';
$$;
revoke all on function public.super_admin_mfa_satisfied() from public;
grant execute on function public.super_admin_mfa_satisfied() to anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and status = 'ACTIVE'
      and (role = 'MANAGER' or (role = 'SUPER_ADMIN' and public.super_admin_mfa_satisfied()))
  );
$$;

-- Several older SECURITY DEFINER RPCs authorize with a direct role list instead of is_admin().
-- Add the assurance check to those predicates while leaving each function's role list intact.
do $$
declare
  v_function record;
  v_source text;
  v_definition text;
begin
  for v_function in
    select p.prosrc, pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.proname <> 'is_admin'
      and (
        p.prosrc ~* E'\\m([a-z_][a-z0-9_]*\\.)?role\\M\\s+in\\s*\\([^)]*''SUPER_ADMIN'''
        or p.prosrc ~* E'id\\s*=\\s*auth\\.uid\\(\\)\\s+and\\s+role\\s*=\\s*''SUPER_ADMIN'''
      )
  loop
    v_source := regexp_replace(
      v_function.prosrc,
      E'(\\m([a-z_][a-z0-9_]*\\.)?role\\M\\s+in\\s*\\([^)]*''SUPER_ADMIN''[^)]*\\))',
      E'\\1 and public.super_admin_mfa_satisfied()',
      'gi'
    );
    v_source := regexp_replace(
      v_source,
      E'(id\\s*=\\s*auth\\.uid\\(\\)\\s+and\\s+role\\s*=\\s*''SUPER_ADMIN'')',
      E'\\1 and public.super_admin_mfa_satisfied()',
      'gi'
    );
    if v_source <> v_function.prosrc then
      v_definition := replace(v_function.definition, v_function.prosrc, v_source);
      execute v_definition;
    end if;
  end loop;
end $$;

-- Restrictive policies AND with existing policies: managers and students keep their current
-- access, while an active super admin with only AAL1 sees or changes no protected rows.
do $$
declare
  v_table record;
begin
  for v_table in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and c.relname <> 'users'
  loop
    execute format('drop policy if exists %I on public.%I', 'super admin MFA gate', v_table.relname);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (public.super_admin_mfa_satisfied()) with check (public.super_admin_mfa_satisfied())',
      'super admin MFA gate', v_table.relname
    );
  end loop;
end $$;

-- AuthContext needs the signed-in user's own role/status row to know which gate to render.
-- This does not expose other users or let an AAL1 session pass protected admin operations.
drop policy if exists "super admin MFA gate" on public.users;
create policy "super admin MFA gate" on public.users
  as restrictive for all to authenticated
  using (id = auth.uid() or public.super_admin_mfa_satisfied())
  with check (id = auth.uid() or public.super_admin_mfa_satisfied());

drop policy if exists "super admin MFA gate" on storage.objects;
create policy "super admin MFA gate" on storage.objects
  as restrictive for all to authenticated
  using (public.super_admin_mfa_satisfied())
  with check (public.super_admin_mfa_satisfied());

create or replace function public.record_super_admin_mfa_event(p_action text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_action not in ('SUPER_ADMIN_MFA_ENROLLED', 'SUPER_ADMIN_MFA_VERIFIED') then
    raise exception 'Unsupported super-admin security event';
  end if;
  if not exists (
    select 1 from public.users
    where id = auth.uid() and role = 'SUPER_ADMIN' and status = 'ACTIVE'
  ) or not public.super_admin_mfa_satisfied() then
    raise exception 'An active super admin with MFA is required';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), p_action, 'auth_mfa', auth.uid()::text, jsonb_build_object('aal', 'aal2'));
end $$;
revoke all on function public.record_super_admin_mfa_event(text) from public;
grant execute on function public.record_super_admin_mfa_event(text) to authenticated;