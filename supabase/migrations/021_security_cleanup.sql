-- OGESEOUS MICROFINANCE — Security cleanup: internal guard functions and the public tracking limit
-- Run after 020_financial_hardening.sql. Copyright © Paulo Mkenya
--
-- WHY THIS FILE EXISTS
--
-- 1. trusted_write() and in_trusted_write() were created with the default EXECUTE grant to PUBLIC.
--    trusted_write() lifts guard_protected_columns() for the current transaction. It is meant to be
--    called only from the security-definer functions that need it, never from a browser. PostgREST
--    exposes every executable function in the public schema, so leaving it callable handed any
--    signed-in user the marker that the guard uses to distinguish "trusted write" from "student".
--    The current setting is transaction-local, which limits the damage across separate HTTP
--    requests, but that is an accident of the transport, not a control. Revoke it.
--
--    in_trusted_write() is read-only and harmless by itself, but it is an internal detail of the
--    same guard and has no reason to be callable from outside.
--
-- 2. handle_user_email_change() syncs public.users.email from auth.users. 011's guard refuses an
--    email change by a non-admin caller, and the auth trigger runs with the user's auth.uid(), so
--    a self-service address change in Supabase Auth failed on the guard. Marking the sync as a
--    trusted write is the narrow fix; the function is already security definer and is the only
--    writer of that column on the auth side.
--
-- 3. track_application() is the one function granted to anon. Its rate limit counted ALL public
--    lookups in the last minute, so one caller could spend the whole budget and lock every other
--    student out of /track. The limit is now per application number: guessing one number is still
--    throttled, but a busy number cannot silence the rest of the institution.


-- ---------------------------------------------------------------------------------------
-- 1. Internal guard helpers are not part of the public API.
-- ---------------------------------------------------------------------------------------
revoke all on function public.trusted_write() from public;
revoke all on function public.in_trusted_write() from public;


-- ---------------------------------------------------------------------------------------
-- 2. Keep the auth email sync working under the guard.
-- ---------------------------------------------------------------------------------------
create or replace function public.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    perform public.trusted_write();
    update public.users set email = new.email where id = new.id;
  end if;
  return new;
end $$;


-- ---------------------------------------------------------------------------------------
-- 3. track_application(): per-number rate limit instead of one global budget.
--    The body is 014's, unchanged apart from the counter and the audit row's entity_id.
-- ---------------------------------------------------------------------------------------
create index if not exists audit_logs_action_entity_time_idx
  on public.audit_logs (action, entity_id, created_at desc);

create or replace function public.track_application(p_number text, p_phone text)
returns table (
  application_number text, status text, submitted_at timestamptz, updated_at timestamptz,
  masked_name text, action_required boolean, documents_needed integer
) language plpgsql security definer set search_path = public as $$
declare
  v_calls integer;
  v_owner uuid;
  v_name text;
  v_number text;
  v_key text;
begin
  -- Count only this application number. A global counter let one caller exhaust the budget and
  -- return "too many lookups" to every other student on /track.
  v_key := upper(trim(coalesce(p_number, '')));
  v_calls := (select count(*) from public.audit_logs
               where action = 'PUBLIC_TRACKING'
                 and entity_id = v_key
                 and created_at > now() - interval '1 minute');
  if v_calls >= 20 then
    raise exception 'Too many lookups for this application number. Please wait a minute and try again.';
  end if;
  insert into public.audit_logs (action, entity, entity_id)
  values ('PUBLIC_TRACKING', 'loan_applications', v_key);

  -- Resolve the application ONCE, to a single (owner, number). Matching on the student's name
  -- instead would be wrong in a way that is easy to miss: two students can share a name, and a
  -- name is not the key. v_owner is the key, and it comes from the row that satisfied BOTH the
  -- number and the phone.
  select la.user_id, la.application_number, sp.full_name
    into v_owner, v_number, v_name
    from public.loan_applications la
    join public.student_profiles sp on sp.user_id = la.user_id
    join public.users u on u.id = la.user_id
   where la.application_number is not null
     and upper(trim(la.application_number)) = upper(trim(coalesce(p_number, '')))
     -- Compared on the last nine digits so 0755…, +255755… and 255755… are all the same number,
     -- which is how people actually type them.
     and length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) >= 9
     and right(regexp_replace(coalesce(sp.phone, u.phone, ''), '[^0-9]', '', 'g'), 9)
       = right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 9)
   limit 1;

  -- No match, or the caller guessed: zero rows. The page says so and shows nothing else.
  if v_owner is null then return; end if;

  return query
  select v_number, la.status, la.submitted_at, la.updated_at,
         -- Initials only, derived here rather than returned as a stored column so a masked value
         -- and a full value can never disagree.
         upper(left(v_name, 1)
               || left((string_to_array(v_name, ' '))[array_length(string_to_array(v_name, ' '), 1)], 1)),
         (la.status = 'ACTION_REQUIRED'),
         (select count(*)::integer from public.required_document_types() t
           where not exists (select 1 from public.loan_documents d
                              where d.application_id = la.id and d.doc_type = t))
    from public.loan_applications la
   where la.user_id = v_owner
     and la.application_number = v_number;
end $$;
revoke all on function public.track_application(text,text) from public;
grant execute on function public.track_application(text,text) to anon, authenticated;
