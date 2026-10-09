-- OGESEOUS MICROFINANCE - Remove the unfinished super-admin MFA requirement.
-- Run after 026_super_admin_mfa.sql. This also removes the recursive users policy
-- that caused "stack depth limit exceeded" during role checks.

do $$
declare
  v_policy record;
  v_function record;
  v_source text;
  v_definition text;
begin
  for v_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where policyname = 'super admin MFA gate'
  loop
    execute format(
      'drop policy %I on %I.%I',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename
    );
  end loop;

  -- Migration 026 added this predicate to SECURITY DEFINER role checks. Remove only
  -- the appended MFA condition and preserve each function's original authorization.
  for v_function in
    select p.oid, p.prosrc
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.proname not in ('super_admin_mfa_satisfied', 'record_super_admin_mfa_event')
      and p.prosrc like '%public.super_admin_mfa_satisfied()%'
  loop
    v_source := replace(v_function.prosrc, ' and public.super_admin_mfa_satisfied()', '');
    if v_source <> v_function.prosrc then
      v_definition := replace(pg_get_functiondef(v_function.oid), v_function.prosrc, v_source);
      execute v_definition;
    end if;
  end loop;
end $$;

-- Restore the original role-based admin helper from migration 001.
create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role in ('SUPER_ADMIN','MANAGER') and status = 'ACTIVE'
  );
$$;

drop function if exists public.record_super_admin_mfa_event(text);
drop function if exists public.super_admin_mfa_satisfied();
