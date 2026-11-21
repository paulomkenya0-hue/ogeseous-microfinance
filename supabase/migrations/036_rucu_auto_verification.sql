-- OGESEOUS: RUCU auto-verification only after a real register match.
-- Other universities continue through the existing manager verification workflow.
-- This migration does not change loan approvals, disbursements, or historical financial records.

create or replace function public.sync_rucu_register_verification()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_student public.rucu_students%rowtype;
  v_profile public.student_profiles%rowtype;
  v_account_active boolean;
begin
  if new.verification_method is distinct from 'RUCU_REGISTER'
     or new.student_confirmed_at is null
     or new.student_record_id is null then
    return new;
  end if;

  select * into v_student from public.rucu_students where id = new.student_record_id;
  select * into v_profile from public.student_profiles where user_id = new.user_id;
  select exists(select 1 from public.users
                where id = new.user_id and role = 'STUDENT' and status = 'ACTIVE')
    into v_account_active;

  -- Never grant verification based only on the selected university or a stale application flag.
  if v_student.id is null or v_profile.user_id is null or not v_account_active
     or v_profile.university is distinct from 'RUCU'
     or lower(btrim(coalesce(v_profile.registration_number,'')))
        <> lower(btrim(v_student.registration_number)) then
    return new;
  end if;

  if v_profile.verification_status is distinct from 'VERIFIED' then
    perform public.trusted_write();
    update public.student_profiles
       set verification_status = 'VERIFIED'
     where user_id = new.user_id
       and verification_status is distinct from 'VERIFIED';

    insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'RUCU_AUTO_VERIFIED', 'student_profiles', v_profile.id::text,
            jsonb_build_object('application_id', new.id,
                               'rucu_student_id', v_student.id,
                               'method', 'RUCU_REGISTER'));
  end if;
  return new;
end;
$$;

revoke all on function public.sync_rucu_register_verification() from public, anon, authenticated;

drop trigger if exists trg_rucu_auto_verify_insert on public.loan_applications;
create trigger trg_rucu_auto_verify_insert
  after insert on public.loan_applications
  for each row execute function public.sync_rucu_register_verification();

drop trigger if exists trg_rucu_auto_verify_update on public.loan_applications;
create trigger trg_rucu_auto_verify_update
  after update of student_record_id, student_confirmed_at, verification_method
  on public.loan_applications
  for each row execute function public.sync_rucu_register_verification();

-- Reconcile existing RUCU applications that contain valid register evidence.
-- Non-RUCU profiles are never updated by this migration.
with matched as (
  select distinct on (la.user_id) la.user_id, la.id as application_id,
         sp.id as profile_id, rs.id as register_id
  from public.loan_applications la
  join public.student_profiles sp on sp.user_id = la.user_id
  join public.users u on u.id = la.user_id
  join public.rucu_students rs on rs.id = la.student_record_id
  where la.verification_method = 'RUCU_REGISTER'
    and la.student_confirmed_at is not null
    and sp.university = 'RUCU'
    and lower(btrim(sp.registration_number)) = lower(btrim(rs.registration_number))
    and sp.verification_status <> 'VERIFIED'
    and u.role = 'STUDENT' and u.status = 'ACTIVE'
  order by la.user_id, la.student_confirmed_at desc
), updated as (
  update public.student_profiles sp
     set verification_status = 'VERIFIED'
    from matched m
   where sp.user_id = m.user_id
  returning sp.user_id
)
insert into public.audit_logs(actor_id, action, entity, entity_id, metadata)
select null, 'RUCU_AUTO_VERIFIED_BACKFILL', 'student_profiles', m.profile_id::text,
       jsonb_build_object('application_id', m.application_id,
                          'rucu_student_id', m.register_id)
from matched m
join updated u on u.user_id = m.user_id;
