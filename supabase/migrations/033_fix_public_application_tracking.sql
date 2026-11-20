-- Fix tracking failure: required_document_types returns text[], not a rowset.
-- Preserve two-factor lookup, audit and rate limiting.
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
         (select count(*)::integer from unnest(public.required_document_types()) as t(doc_type)
           where not exists (select 1 from public.loan_documents d
                              where d.application_id = la.id and d.doc_type = t.doc_type))
    from public.loan_applications la
   where la.user_id = v_owner
     and la.application_number = v_number;
end $$;
revoke all on function public.track_application(text,text) from public;
grant execute on function public.track_application(text,text) to anon, authenticated;
