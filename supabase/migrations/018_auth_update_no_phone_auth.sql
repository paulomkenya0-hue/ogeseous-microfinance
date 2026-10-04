-- OGESEOUS MICROFINANCE - Update auth to not use phone auth
-- Ensure phone is unique for users

create unique index if not exists users_phone_unique_idx on public.users (phone) where phone is not null;

-- Update handle_new_user to prefer email from auth if provided
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_phone text;
begin
  v_phone := nullif(trim(coalesce(new.phone, new.raw_user_meta_data->>'phone', '')), '');
  insert into public.users (id, email, phone, role)
  values (new.id, nullif(trim(coalesce(new.email, '')), ''), v_phone, 'STUDENT');
  insert into public.student_profiles (user_id, full_name, phone)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), ''),
          coalesce(v_phone, ''));
  return new;
end $$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
