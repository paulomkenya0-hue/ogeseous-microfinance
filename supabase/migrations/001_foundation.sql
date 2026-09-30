-- OGESEOUS MICROFINANCE — Step 1 database foundation (Supabase / PostgreSQL)
-- Run in the Supabase SQL editor. Copyright © Paulo Mkenya

create type public.user_role as enum
  ('STUDENT','LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN');
create type public.user_status as enum ('ACTIVE','SUSPENDED');
create type public.verification_status as enum
  ('NOT_STARTED','PENDING','VERIFIED','REJECTED');

-- users: app-level record linked to Supabase Auth (password lives in auth.users only)
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  phone text,
  role public.user_role not null default 'STUDENT',
  status public.user_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.student_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  full_name text not null,
  phone text,
  university text check (university in ('RUCU','MKWAWA','IU')),
  registration_number text,
  form_four_index_number text,
  profile_photo_url text,
  verification_status public.verification_status not null default 'NOT_STARTED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- audit-ready log (written server-side only)
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.users(id),
  action text not null,
  entity text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- helpers
create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.users
    where id = auth.uid() and role in ('SUPER_ADMIN','MANAGER') and status = 'ACTIVE');
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create trigger trg_users_touch before update on public.users
  for each row execute function public.touch_updated_at();
create trigger trg_profiles_touch before update on public.student_profiles
  for each row execute function public.touch_updated_at();

-- On signup: ALWAYS create STUDENT. Any "role" sent by the client is ignored.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, phone, role)
  values (new.id, new.email, new.raw_user_meta_data->>'phone', 'STUDENT');
  insert into public.student_profiles (user_id, full_name, phone)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''),
          new.raw_user_meta_data->>'phone');
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Block privilege escalation: only admins may change role/status/verification
create or replace function public.guard_protected_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_table_name = 'users' and (new.role <> old.role or new.status <> old.status) then
      raise exception 'Not allowed to change role or status';
    end if;
    if tg_table_name = 'student_profiles'
       and new.verification_status <> old.verification_status then
      raise exception 'Not allowed to change verification status';
    end if;
  end if;
  return new;
end $$;

create trigger trg_users_guard before update on public.users
  for each row execute function public.guard_protected_columns();
create trigger trg_profiles_guard before update on public.student_profiles
  for each row execute function public.guard_protected_columns();

-- Row Level Security
alter table public.users enable row level security;
alter table public.student_profiles enable row level security;
alter table public.audit_logs enable row level security;

create policy "own user row" on public.users
  for select using (id = auth.uid() or public.is_admin());
create policy "own user update" on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy "own profile read" on public.student_profiles
  for select using (user_id = auth.uid() or public.is_admin());
create policy "own profile update" on public.student_profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "admins read audit" on public.audit_logs
  for select using (public.is_admin());
-- no insert/update/delete policies: audit rows are written with the service role only

-- Staff roles are assigned only by a SUPER_ADMIN via a server-side function/service role.
-- Create the first SUPER_ADMIN manually in the SQL editor:
--   update public.users set role = 'SUPER_ADMIN' where email = '<your-email>';
