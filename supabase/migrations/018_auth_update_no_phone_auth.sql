-- OGESEOUS MICROFINANCE - Update auth to not use phone auth
-- Ensure phone is unique for users

-- NOTE: 016 already creates the canonical partial unique index `users_phone_unique` on
-- public.users(phone) WHERE phone IS NOT NULL. The earlier draft of this migration created a
-- second, identical index under the name `users_phone_unique_idx`; keep only one. Drop the
-- duplicate defensively in case an environment applied the old draft.
drop index if exists public.users_phone_unique_idx;

-- Update handle_new_user to prefer email from auth if provided
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_phone text;
begin
  -- Phone-identified students carry their phone in raw_user_meta_data, not in auth.users.phone,
  -- because the Phone auth provider is OFF (synthetic-email signup). Prefer the auth column when
  -- present, then the metadata fallback — same as 016, but with the metadata also consulted for
  -- the phone identity itself, which 016 only did for the profile row.
  v_phone := nullif(trim(coalesce(new.phone, new.raw_user_meta_data->>'phone', '')), '');
  insert into public.users (id, email, phone, role)
  values (new.id, nullif(trim(coalesce(new.email, '')), ''), v_phone, 'STUDENT');
  insert into public.student_profiles (user_id, full_name, phone)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), ''),
          -- NULL when there is no phone. An empty string here would poison every later
          -- "phone >= 9 digits" validation and the public-tracking phone match.
          v_phone);
  return new;
end $$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
