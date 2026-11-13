-- OGESEOUS MICROFINANCE — Revoke anon EXECUTE from functions that are not public RPCs
-- Run after 021_security_cleanup.sql. Copyright © Paulo Mkenya
--
-- WHY THIS FILE EXISTS
--
-- Supabase grants EXECUTE on every new function in the public schema to `anon`,
-- `authenticated` and `service_role` through ALTER DEFAULT PRIVILEGES. A migration that writes
--
--     revoke all on function public.some_function(...) from public;
--
-- therefore removes only the implicit PUBLIC grant. The explicit grant to `anon` survives, and
-- PostgREST will still expose the function at /rest/v1/rpc/some_function. That is how functions
-- written as authenticated-only — `application_student_detail`, the money functions, and even
-- `trusted_write()` — remained callable by a signed-out visitor.
--
-- Most of those functions reject a null auth.uid() themselves, so this was not a data leak. It is
-- still the wrong boundary: a function should not be reachable at all unless it is meant to be.
-- The three RPCs that public pages genuinely call are re-granted at the end:
--
--   * track_application(text, text)          /track
--   * get_application_verification(text, text) /verify
--   * login_email_for_phone(text)            /login
--
-- `service_role` keeps its grants; it bypasses RLS by design and is never used in the browser.

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from public, anon', fn.signature);
  end loop;
end $$;

-- The public pages that must work while signed out.
grant execute on function public.track_application(text, text) to anon;
grant execute on function public.get_application_verification(text, text) to anon;
grant execute on function public.login_email_for_phone(text) to anon;

-- Internal helpers. `trusted_write()` is the marker that lifts guard_protected_columns(); no
-- client, signed in or not, may set it. The trigger helpers are only ever invoked by a trigger.
revoke all on function public.trusted_write() from public, anon, authenticated;
revoke all on function public.in_trusted_write() from public, anon, authenticated;
revoke all on function public.guard_protected_columns() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.handle_user_email_change() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- Ask PostgREST to drop its cached function list so the new grants take effect immediately.
notify pgrst, 'reload schema';
