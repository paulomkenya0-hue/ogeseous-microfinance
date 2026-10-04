-- OGESEOUS MICROFINANCE — Marketing Officer Referral System
-- Run after 001_foundation.sql and 002_verification.sql. Copyright © Paulo Mkenya

alter type public.user_role add value if not exists 'MARKETING_OFFICER';

create table public.marketing_officers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id), -- nullable: an officer can exist before a staff login is issued
  full_name text not null,
  university text not null check (university in ('RUCU','MKWAWA','IU')),
  referral_code text not null unique,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE')),
  created_at timestamptz not null default now()
);
create unique index marketing_officers_one_per_user on public.marketing_officers (user_id) where user_id is not null;

-- How each student says they heard about OGESEOUS. One answer per student; captured as early as
-- registration/dashboard today, and the same question will also sit on the loan application in Step 3.
create table public.referral_captures (
  id uuid primary key default gen_random_uuid(),
  student_user_id uuid not null unique references public.users(id) on delete cascade,
  source text not null check (source in ('STUDENTS','GOOGLE','MARKETING_OFFICER')),
  marketing_officer_id uuid references public.marketing_officers(id),
  captured_at timestamptz not null default now()
);

alter table public.marketing_officers enable row level security;
alter table public.referral_captures enable row level security;

create policy "admins manage officers" on public.marketing_officers
  for all using (public.is_admin()) with check (public.is_admin());
create policy "officer reads own row" on public.marketing_officers
  for select using (user_id = auth.uid());

create policy "admins read referrals" on public.referral_captures
  for select using (public.is_admin());
create policy "officer reads own referrals" on public.referral_captures
  for select using (exists (select 1 from public.marketing_officers mo where mo.id = marketing_officer_id and mo.user_id = auth.uid()));
create policy "student reads own answer" on public.referral_captures
  for select using (student_user_id = auth.uid());
-- Writes go only through submit_referral()/create_marketing_officer() below.

-- Admin creates an officer and gets back a generated referral code.
create or replace function public.create_marketing_officer(p_full_name text, p_university text, p_user_id uuid default null)
returns table (id uuid, referral_code text) language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; v_tries int := 0;
begin
  if not public.is_admin() then raise exception 'Only admins can create marketing officers'; end if;
  loop
    v_code := 'OG-' || p_university || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
    begin
      insert into public.marketing_officers (full_name, university, referral_code, user_id)
      values (trim(p_full_name), p_university, v_code, p_user_id) returning marketing_officers.id into v_id;
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 5 then raise exception 'Could not generate a unique referral code — please try again'; end if;
    end;
  end loop;
  insert into public.audit_logs (actor_id, action, entity, entity_id) values (auth.uid(), 'MARKETING_OFFICER_CREATED', 'marketing_officers', v_id::text);
  return query select v_id, v_code;
end $$;
revoke all on function public.create_marketing_officer(text,text,uuid) from public;
grant execute on function public.create_marketing_officer(text,text,uuid) to authenticated;

-- Student answers "How did you hear about us?" — resolves a referral code to its officer server-side.
create or replace function public.submit_referral(p_source text, p_code text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_officer uuid := null;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only student accounts can answer this';
  end if;
  if p_source not in ('STUDENTS','GOOGLE','MARKETING_OFFICER') then raise exception 'Invalid option'; end if;
  if p_source = 'MARKETING_OFFICER' then
    select id into v_officer from public.marketing_officers where lower(referral_code) = lower(trim(coalesce(p_code,''))) and status = 'ACTIVE';
    if v_officer is null then raise exception 'That referral number was not recognized'; end if;
  end if;
  insert into public.referral_captures (student_user_id, source, marketing_officer_id) values (auth.uid(), p_source, v_officer)
    on conflict (student_user_id) do update set source = excluded.source, marketing_officer_id = excluded.marketing_officer_id, captured_at = now();
end $$;
revoke all on function public.submit_referral(text,text) from public;
grant execute on function public.submit_referral(text,text) to authenticated;

-- Performance analytics. Non-admins see only their own row (row filter, same effect as RLS).
create or replace function public.get_marketing_stats()
returns table (officer_id uuid, full_name text, university text, referral_code text, status text, referrals bigint)
language sql security definer set search_path = public stable as $$
  select mo.id, mo.full_name, mo.university, mo.referral_code, mo.status, count(rc.id)
  from public.marketing_officers mo
  left join public.referral_captures rc on rc.marketing_officer_id = mo.id
  where public.is_admin() or mo.user_id = auth.uid()
  group by mo.id
  order by count(rc.id) desc;
$$;
revoke all on function public.get_marketing_stats() from public;
grant execute on function public.get_marketing_stats() to authenticated;
