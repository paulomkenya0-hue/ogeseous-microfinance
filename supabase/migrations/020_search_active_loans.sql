-- OGESEOUS MICROFINANCE — Server-side search of active loans for the repayments console.
-- Run after 019. Replaces the "first 100 active loans" dropdown on /admin/repayments,
-- which silently could not reach a loan beyond the first page.

create or replace function public.search_active_loans(p_query text)
returns table (
  loan_id uuid,
  full_name text,
  phone text,
  application_number text,
  outstanding_balance numeric,
  disbursed_at timestamptz
) language plpgsql security definer set search_path = public stable as $$
begin
  -- Same staff audience as record_repayment(): anyone who can post money can look it up.
  if not exists (select 1 from public.users
                 where id = auth.uid() and status = 'ACTIVE'
                   and role in ('ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')) then
    raise exception 'Only finance staff can search active loans';
  end if;

  return query
  select l.id, sp.full_name, coalesce(sp.phone, u.phone) as phone,
         la.application_number, l.outstanding_balance, l.disbursed_at
  from public.loans l
  join public.loan_applications la on la.id = l.application_id
  join public.users u on u.id = l.user_id
  left join public.student_profiles sp on sp.user_id = l.user_id
  where l.status = 'ACTIVE'
    and (
      p_query is null or btrim(p_query) = ''
      or l.id::text ilike btrim(p_query) || '%'
      or la.application_number ilike '%' || btrim(p_query) || '%'
      or sp.full_name ilike '%' || btrim(p_query) || '%'
      -- Phone compared on the last nine digits, same convention as tracking, so
      -- 0755…, +255755… and 255755… all match.
      or (length(regexp_replace(btrim(p_query), '[^0-9]', '', 'g')) >= 9
          and right(regexp_replace(coalesce(sp.phone, u.phone, ''), '[^0-9]', '', 'g'), 9)
            = right(regexp_replace(btrim(p_query), '[^0-9]', '', 'g'), 9))
    )
  order by l.outstanding_balance desc
  limit 25;
end $$;
revoke all on function public.search_active_loans(text) from public;
grant execute on function public.search_active_loans(text) to authenticated;
