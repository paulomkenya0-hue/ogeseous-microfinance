-- OGESEOUS MICROFINANCE - RUCU lookup and student confirmation are separate actions.
-- Run after 024_rucu_register_admin_read.sql.

create table if not exists public.rucu_confirmation_challenges (
  user_id uuid primary key references public.users(id) on delete cascade,
  student_id uuid not null references public.rucu_students(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.rucu_confirmation_challenges enable row level security;

with reset_drafts as (
  update public.loan_applications
     set student_confirmed_at = null
   where status = 'DRAFT'
     and verification_method = 'RUCU_REGISTER'
     and student_confirmed_at is not null
  returning id
)
insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
select null, 'RUCU_CONFIRMATION_REQUIRED', 'loan_applications', id::text,
       jsonb_build_object('reason', 'migration 025 requires explicit student confirmation')
from reset_drafts;

create or replace function public.verify_student_from_register(
  p_registration text, p_last_name text
) returns table (
  rucu_student_id uuid, full_name text, registration_number text, form_four_index_number text,
  programme text, year_of_study text, application_id uuid
) language plpgsql security definer set search_path = public as $$
declare
  v_attempts integer;
  v_row public.rucu_students%rowtype;
  v_holder uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can verify a student record';
  end if;
  if length(trim(coalesce(p_registration, ''))) < 3 or length(trim(coalesce(p_last_name, ''))) < 2 then
    raise exception 'Enter both your registration number and your last name';
  end if;

  select count(*) into v_attempts from public.audit_logs
   where actor_id = auth.uid()
     and action in ('RUCU_WIZARD_MATCH', 'RUCU_WIZARD_CONFIRM')
     and created_at > now() - interval '1 minute';
  if v_attempts >= 20 then
    raise exception 'Too many attempts. Please wait a minute and try again.';
  end if;
  insert into public.audit_logs (actor_id, action, entity)
    values (auth.uid(), 'RUCU_WIZARD_MATCH', 'rucu_students');

  select r.* into v_row from public.rucu_students r
   where lower(r.registration_number) = lower(trim(p_registration))
     and lower(r.last_name) = lower(trim(p_last_name))
   limit 1;
  if v_row.id is null then return; end if;

  select sp.user_id into v_holder from public.student_profiles sp
   where sp.university = 'RUCU' and lower(sp.registration_number) = lower(v_row.registration_number)
     and sp.user_id <> auth.uid() limit 1;
  if v_holder is not null then
    raise exception 'That registration number is already registered to an account here. Sign in with that account instead of creating a new one.';
  end if;

  insert into public.rucu_confirmation_challenges (user_id, student_id, created_at)
  values (auth.uid(), v_row.id, now())
  on conflict (user_id) do update
    set student_id = excluded.student_id, created_at = excluded.created_at;

  return query select v_row.id, v_row.full_name, v_row.registration_number,
                      v_row.form_four_index_number, v_row.programme, v_row.year_of_study,
                      null::uuid;
end $$;
revoke all on function public.verify_student_from_register(text,text) from public;
grant execute on function public.verify_student_from_register(text,text) to authenticated;

create or replace function public.confirm_student_from_register(
  p_registration text, p_last_name text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_attempts integer;
  v_row public.rucu_students%rowtype;
  v_holder uuid;
  v_app uuid;
  v_challenge uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can confirm a student record';
  end if;
  if length(trim(coalesce(p_registration, ''))) < 3 or length(trim(coalesce(p_last_name, ''))) < 2 then
    raise exception 'Enter both your registration number and your last name';
  end if;

  select count(*) into v_attempts from public.audit_logs
   where actor_id = auth.uid()
     and action in ('RUCU_WIZARD_MATCH', 'RUCU_WIZARD_CONFIRM')
     and created_at > now() - interval '1 minute';
  if v_attempts >= 20 then
    raise exception 'Too many attempts. Please wait a minute and try again.';
  end if;

  select r.* into v_row from public.rucu_students r
   where lower(r.registration_number) = lower(trim(p_registration))
     and lower(r.last_name) = lower(trim(p_last_name))
   limit 1;
  if v_row.id is null then
    raise exception 'Student record no longer matches. Search again using your registration number and last name.';
  end if;

  select student_id into v_challenge from public.rucu_confirmation_challenges
    where user_id = auth.uid() and created_at > now() - interval '10 minutes'
    for update;
  if v_challenge is distinct from v_row.id then
    raise exception 'Your register match has expired. Search again before confirming.';
  end if;

  select sp.user_id into v_holder from public.student_profiles sp
   where sp.university = 'RUCU' and lower(sp.registration_number) = lower(v_row.registration_number)
     and sp.user_id <> auth.uid() limit 1;
  if v_holder is not null then
    raise exception 'That registration number is already registered to an account here. Sign in with that account instead of creating a new one.';
  end if;

  perform public.trusted_write();
  update public.student_profiles
     set full_name = v_row.full_name,
         university = 'RUCU',
         registration_number = v_row.registration_number,
         form_four_index_number = v_row.form_four_index_number,
         programme = v_row.programme,
         year_of_study = v_row.year_of_study
   where user_id = auth.uid();

  insert into public.loan_applications
    (user_id, student_record_id, student_confirmed_at, verification_method, programme, year_of_study)
  values (auth.uid(), v_row.id, now(), 'RUCU_REGISTER', v_row.programme, v_row.year_of_study)
  on conflict (user_id) where status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') do update
    set student_record_id = excluded.student_record_id,
        student_confirmed_at = excluded.student_confirmed_at,
        verification_method = excluded.verification_method,
        programme = excluded.programme,
        year_of_study = excluded.year_of_study
    where public.loan_applications.status = 'DRAFT'
  returning id into v_app;

  if v_app is null then
    raise exception 'You already have an application with OGESEOUS. Open your dashboard to see its status.';
  end if;

  delete from public.rucu_confirmation_challenges where user_id = auth.uid();
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'RUCU_WIZARD_CONFIRM', 'loan_applications', v_app::text,
            jsonb_build_object('rucu_student_id', v_row.id, 'method', 'RUCU_REGISTER'));
  return v_app;
end $$;
revoke all on function public.confirm_student_from_register(text,text) from public;
grant execute on function public.confirm_student_from_register(text,text) to authenticated;