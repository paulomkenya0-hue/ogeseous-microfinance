-- OGESEOUS MICROFINANCE — Remove the implicit PUBLIC grant that 022 missed
-- Run after 022_revoke_anon_function_execute.sql. Copyright © Paulo Mkenya
--
-- WHY THIS FILE EXISTS
--
-- 022 revoked anon EXECUTE from every public function, but four trigger helpers still had the
-- implicit `=X/postgres` (PUBLIC) grant in pg_proc.proacl. `REVOKE ... FROM anon` does not remove
-- a grant held through PUBLIC, so `has_function_privilege('anon', ...)` stayed true:
--
--   guard_protected_columns, handle_new_user, handle_user_email_change, touch_updated_at
--
-- They are trigger functions, not client RPCs, and none of them should be reachable over
-- PostgREST. This migration revokes PUBLIC as well, re-grants only the three public RPCs, and
-- removes the internal helpers from every client role. 022 is corrected in place for fresh
-- installs; this file records the fix for databases that already ran the first version.

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

-- The three RPCs that public pages and the login form genuinely need.
grant execute on function public.track_application(text, text) to anon, authenticated;
grant execute on function public.get_application_verification(text, text) to anon, authenticated;
grant execute on function public.login_email_for_phone(text) to anon, authenticated;

-- Never callable by a client, signed in or not.
revoke all on function public.trusted_write() from public, anon, authenticated;
revoke all on function public.in_trusted_write() from public, anon, authenticated;
revoke all on function public.guard_protected_columns() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.handle_user_email_change() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

notify pgrst, 'reload schema';
