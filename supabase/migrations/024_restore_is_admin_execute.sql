-- OGESEOUS MICROFINANCE — Restore EXECUTE on the RLS helper
-- Run after 023_revoke_public_trigger_helpers.sql. Copyright © Paulo Mkenya
--
-- WHY THIS FILE EXISTS
--
-- 022/023 removed anon EXECUTE from every public function. That is correct for RPCs and trigger
-- helpers, but RLS policy expressions run with the privileges of the querying role. Fifteen
-- policies call public.is_admin(), including the policies on `users` and `app_settings`, so a
-- signed-out read failed with:
--
--   permission denied for function is_admin
--
-- is_admin() is SECURITY DEFINER and returns false when auth.uid() is null, so granting it to
-- anon exposes no data. It is the one helper that must stay callable by both client roles.

grant execute on function public.is_admin() to anon, authenticated;
