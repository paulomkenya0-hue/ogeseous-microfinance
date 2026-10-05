-- OGESEOUS MICROFINANCE — Phase 4 security hardening: throttle the public verification
-- endpoint with a dedicated, self-cleaning rate-limit log instead of unbounded audit_logs.
-- Run after 018. Depends on nothing else new.

-- -------------------------------------------------------------------------------------
-- 1. A dedicated, lightweight event log. Kept separate from audit_logs on purpose:
--    audit_logs is an evidence trail that must never be pruned, while rate-limit events
--    are disposable and should be deleted, not kept. RLS enabled with NO policies, so
--    nothing outside our definer functions can read or write it.
-- -------------------------------------------------------------------------------------
create table if not exists public.rate_limit_events (
  id bigint generated always as identity primary key,
  action text not null,
  key text not null default '',
  created_at timestamptz not null default now()
);
alter table public.rate_limit_events enable row level security;
create index if not exists rate_limit_events_action_created_idx
  on public.rate_limit_events (action, created_at);
create index if not exists rate_limit_events_action_key_created_idx
  on public.rate_limit_events (action, key, created_at);

-- Records one hit and returns the number of hits for (action, key) inside the window.
-- Old rows for this action are pruned on the same call, so the table cannot grow without
-- bound even under a sustained probe. Callable only as a definer function; it has no
-- direct grant.
create or replace function public.rate_limit_count(p_action text, p_key text, p_window interval)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  delete from public.rate_limit_events where action = p_action and created_at < now() - interval '10 minutes';
  insert into public.rate_limit_events (action, key) values (p_action, p_key);
  select count(*) into v_count from public.rate_limit_events
   where action = p_action and key = p_key and created_at > now() - p_window;
  return v_count;
end $$;
revoke all on function public.rate_limit_count(text,text,interval) from public;
revoke execute on function public.rate_limit_count(text,text,interval) from authenticated, anon;

-- -------------------------------------------------------------------------------------
-- 2. Throttle get_application_verification. Same two limits as the audit-log design for
--    track_application, but counted in the disposable table:
--      - global: 120 lookups/minute across all callers (stops spraying many tokens)
--      - per application number: 10 lookups/minute (stops grinding one number's token)
--    A throttled caller and a wrong token both surface as "Too many requests…" / no rows —
--    nothing distinguishes "this number exists" from "this number does not".
--    Now VOLATILE because it writes to the event log (a STABLE function cannot write).
-- -------------------------------------------------------------------------------------
create or replace function public.get_application_verification(p_app_number text, p_token text)
returns table (application_number text, full_name text, university text, status text, submitted_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_global integer; v_per_number integer;
begin
  v_global := public.rate_limit_count('APP_VERIFICATION', '', interval '1 minute');
  if v_global > 120 then
    raise exception 'Too many verification attempts. Please wait a minute and try again.';
  end if;

  v_per_number := public.rate_limit_count('APP_VERIFICATION_NUMBER', upper(trim(coalesce(p_app_number, ''))), interval '1 minute');
  if v_per_number > 10 then
    raise exception 'Too many attempts for this application. Please wait a minute and try again.';
  end if;

  return query
  select la.application_number, sp.full_name, sp.university, la.status, la.submitted_at
  from public.loan_applications la join public.student_profiles sp on sp.user_id = la.user_id
  where la.application_number = p_app_number and la.verification_token = p_token;
end $$;
revoke all on function public.get_application_verification(text,text) from public;
grant execute on function public.get_application_verification(text,text) to authenticated, anon;
