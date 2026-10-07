-- OGESEOUS MICROFINANCE — Allow authenticated users to read
-- verification requests, with RLS continuing to restrict access.
-- Admins are allowed by the existing is_admin() SELECT policy;
-- students can only read their own requests.

grant select on table public.verification_requests to authenticated;