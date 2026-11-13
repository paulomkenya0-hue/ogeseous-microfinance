-- OGESEOUS MICROFINANCE — Auth update: the phone number is an attribute, not the auth identity
-- Run after 017_no_rucu_self_declaration.sql. Copyright © Paulo Mkenya
--
-- WHY THIS FILE EXISTS
--
-- The current signup form (src/pages/Auth.tsx) creates the Supabase auth account with a synthetic
-- email address derived from the student's phone number, because email/password is the flow that
-- works without an SMS provider. The phone number therefore does NOT arrive in auth.users.phone;
-- it travels in raw_user_meta_data.
--
-- 016_phone_signup.sql's handle_new_user() read new.phone only, which is NULL for an email signup.
-- Every account created by the current frontend therefore got public.users.phone = NULL, and the
-- phone login had nothing to match. This version prefers the auth email and falls back to the
-- metadata phone, so both kinds of account are recorded consistently.
--
-- The phone uniqueness index is deliberately NOT re-created here: 016 already created
-- users_phone_unique on the same column. A second index under another name only costs writes.

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_phone text;
begin
  v_phone := nullif(trim(coalesce(nullif(new.phone, ''), new.raw_user_meta_data->>'phone', '')), '');

  insert into public.users (id, email, phone, role)
  values (new.id, nullif(trim(coalesce(new.email, '')), ''), v_phone, 'STUDENT');

  insert into public.student_profiles (user_id, full_name, phone)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), ''),
          v_phone);

  return new;
end $$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
