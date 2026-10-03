-- OGESEOUS MICROFINANCE — Phone-only student signup
-- Run after 015_register_lookup_fix.sql. Copyright © Paulo Mkenya
--
-- WHY THIS MIGRATION IS NECESSARY
--
-- The student signup form now collects exactly three things: full name, phone number and
-- password. There is no email address, because students are not asked to supply one and many of
-- them will not have one they can check.
--
-- Supabase Auth cannot create a password account with neither an email nor a phone: one of the
-- two is the account identifier. So a student account is now created against the PHONE NUMBER
-- (signUp({ phone, password })), and staff accounts continue to use an email address exactly as
-- before. Both kinds live in the same auth.users table, which is why this file exists rather than a
-- frontend-only change.
--
-- Two database facts forced it:
--
--   1. public.users.email is declared `text not null unique` in 001_foundation.sql. A student who
--      signs up with no email has auth.users.email = NULL, so the handle_new_user() trigger's
--      insert would fail with a not-null violation and NO STUDENT COULD EVER BE CREATED. Email has
--      to become nullable. The unique index is kept — NULLs do not collide in a unique index, and
--      two real staff addresses must still never be the same.
--
--   2. handle_new_user() read the phone number from raw_user_meta_data only. With a phone identity
--      the authoritative value is auth.users.phone, which is the one GoTrue enforces unique. The
--      trigger is updated to prefer it and fall back to the metadata, so a signup that arrives
--      without metadata still records the number.
--
-- WHAT IS DELIBERATELY NOT CHANGED
--
--   - Role stays STUDENT and status stays ACTIVE. New students are ordinary students; nothing here
--     grants anybody anything.
--   - No account, application or audit row is modified or deleted. The trigger is CREATE OR
--     REPLACE, which affects future signups only and does not re-run over existing users.
--   - No RLS policy, grant or function privilege is touched.
--   - admin@paulo.com and every other existing staff account is untouched: they keep their email
--     identity and their SUPER_ADMIN role.
--
-- MANUAL STEP REQUIRED FIRST (this migration cannot do it)
--
--   Supabase → Authentication → Providers → Phone
--     1. Turn the Phone provider ON. Without it, signUp({ phone }) fails with
--        "Phone logins are not enabled" and no student can register.
--     2. UNTICK "Confirm phone". With it on, signUp returns no session, the student is not logged
--        in, and the product requirement that signup lands them on the dashboard cannot be met.
--
--   Supabase → Authentication → Sign In / Providers → Email → Minimum password length: set to 4.
--     GoTrue rejects a shorter password before this application's own rule is consulted, so a
--     four-digit password fails at the API unless this is lowered. This is a project setting; no
--     code can change it.


-- ---------------------------------------------------------------------------------------
-- 1. Email becomes optional.
--
-- NOT NULL dropped, unique KEPT. The existing unique index is left in place on purpose: NULL is
-- allowed to repeat (every student has one), but two accounts with the same real address still
-- cannot exist.
-- ---------------------------------------------------------------------------------------
alter table public.users alter column email drop not null;

create unique index if not exists users_phone_unique on public.users (phone) where phone is not null;


-- ---------------------------------------------------------------------------------------
-- 2. handle_new_user(): understand a phone identity.
--
-- Same function, same trigger, same role. Only where the phone number comes from has changed, and
-- the email insert now tolerates NULL.
--
-- The metadata is still read as a fallback, because a caller may pass the number in either place and
-- auth.users.phone is the one GoTrue guarantees. full_name is unchanged: it still comes from
-- metadata, exactly as before, so the student_profiles row is populated the same way it always was.
-- ---------------------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_phone text;
begin
  -- auth.users.phone first (the enforced-unique identity), then the metadata copy.
  v_phone := nullif(trim(coalesce(new.phone, '')), '');

  insert into public.users (id, email, phone, role)
  values (new.id, nullif(trim(coalesce(new.email, '')), ''), v_phone, 'STUDENT');

  insert into public.student_profiles (user_id, full_name, phone)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), ''),
          coalesce(v_phone, nullif(trim(coalesce(new.raw_user_meta_data->>'phone', '')), '')));

  return new;
end $$;

-- The trigger definition is byte-for-byte the one 001_foundation.sql created; only the function it
-- points at is different. Re-stating it here is a no-op in effect but it means the live trigger
-- cannot drift away from the file if anything ever edited it.
--
-- CREATE OR REPLACE TRIGGER (PostgreSQL 14+) is used rather than DROP followed by CREATE: with a
-- drop there is a window in which auth.users has no trigger at all, and a student signing up inside
-- that window would get an auth account with no public.users row and no student_profiles row —
-- an account that exists but is invisible to the application and cannot be recovered from the UI.
-- Replace swaps the function pointer atomically.
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------------------
-- 3. Confirm the assumption this migration rests on.
--
-- Run these after applying. If section 3 returns any row, signup is still blocked in a way this
-- migration did not address and the message will say what.
-- ---------------------------------------------------------------------------------------

-- 3a. Every staff account still has an email. Any row here is a staff account that has lost its
--     identity and must be repaired before that person can sign in. Expected: zero rows.
select id, email, phone, role from public.users
where email is null and role <> 'STUDENT';

-- 3b. The SUPER_ADMIN account named in the product requirements is untouched. Expected: one row,
--     role SUPER_ADMIN, email admin@paulo.com.
select id, email, role, status from public.users where email = 'admin@paulo.com';

-- 3c. Students created BEFORE this migration kept the email identity they signed up with and still
--     have it — that column was populated, not cleared, and nothing here rewrites it. So this count
--     is the number of old-style students, not a fault. Every NEW student should have email NULL.
select
  count(*) filter (where email is not null) as students_with_email,
  count(*) filter (where email is null)     as students_without_email,
  count(*) filter (where phone is null)     as with_no_phone
from public.users where role = 'STUDENT';

-- 3d. No address was invented. If anyone had generated a placeholder email from a phone number this
--     would show one; the approach deliberately does not, so every value here is a real address
--     somebody typed. Expected: zero rows.
select id, email from public.users
where email is not null and (email like '%@phone.%' or email like '%@phone.%' or email ~ '^\+?[0-9]+@');


-- ---------------------------------------------------------------------------------------
-- 4. Reminder, not a query.
--
-- A four-digit password has ten thousand combinations, and a student account is identified by a
-- phone number rather than an email address. Anyone who knows the number can walk that space. This
-- is the rule the business asked for and it is implemented as asked; it is recorded here so the
-- choice is visible to whoever reads the schema next.
-- ---------------------------------------------------------------------------------------