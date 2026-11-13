-- OGESEOUS MICROFINANCE — Login, application wizard and account-deletion fixes
-- Run after 018_auth_update_no_phone_auth.sql. Copyright © Paulo Mkenya
--
-- WHY THIS FILE EXISTS
--
-- Migration 014 has already been applied in the live database, so correcting the text of 014
-- fixes only a fresh install — Postgres stores the compiled function bodies, not the script.
-- This migration re-creates the affected functions and adds the one lookup the login page needs.
--
-- It also repeats the correction made in place to 014: save_application_guarantor compared the
-- text returned by regexp_replace() with the integer 9, which raises
-- "operator does not exist: text < integer" on every call. With guarantor_required defaulting to
-- true, that blocked step 5 of the wizard for every applicant.
--
-- Nothing here changes a role, an RLS policy on a table, or the administrative surface.


-- ---------------------------------------------------------------------------------------
-- 1. save_application_guarantor: compare the digit COUNT, not the digit string.
-- ---------------------------------------------------------------------------------------
create or replace function public.save_application_guarantor(
  p_full_name text, p_relationship text, p_phone text, p_national_id text, p_address text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;

  select id into v_id from public.loan_applications
   where user_id = auth.uid() and status in ('DRAFT','SUBMITTED','UNDER_REVIEW','ACTION_REQUIRED') limit 1;
  if v_id is null then raise exception 'Start your application first'; end if;

  if public.guarantor_is_required() then
    if length(trim(coalesce(p_full_name, ''))) < 3 then raise exception 'Enter your guarantor''s full name'; end if;
    if length(trim(coalesce(p_relationship, ''))) < 2 then raise exception 'State your relationship to the guarantor'; end if;
    if length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) < 9 then
      raise exception 'Enter a phone number we can reach the guarantor on';
    end if;
    if length(trim(coalesce(p_national_id, ''))) < 5 then raise exception 'Enter the guarantor''s National ID number'; end if;
    if length(trim(coalesce(p_address, ''))) < 5 then raise exception 'Enter the guarantor''s address'; end if;
  else
    -- Not required: record whatever was entered, validate nothing beyond a length cap.
    p_full_name := left(trim(coalesce(p_full_name, '')), 200);
    p_relationship := left(trim(coalesce(p_relationship, '')), 80);
    p_national_id := left(trim(coalesce(p_national_id, '')), 80);
    p_address := left(trim(coalesce(p_address, '')), 400);
  end if;

  update public.loan_applications
     set guarantor_full_name = nullif(trim(coalesce(p_full_name, '')), ''),
         guarantor_relationship = nullif(trim(coalesce(p_relationship, '')), ''),
         guarantor_phone = nullif(trim(coalesce(p_phone, '')), ''),
         guarantor_national_id = nullif(trim(coalesce(p_national_id, '')), ''),
         guarantor_address = nullif(trim(coalesce(p_address, '')), '')
   where id = v_id and status = 'DRAFT';
  if not found then raise exception 'This application has already been submitted and can no longer be edited here'; end if;

  return v_id;
end $$;
revoke all on function public.save_application_guarantor(text,text,text,text,text) from public;
grant execute on function public.save_application_guarantor(text,text,text,text,text) to authenticated;


-- ---------------------------------------------------------------------------------------
-- 2. Repair accounts created while the trigger read only auth.users.phone.
--
-- A signup through the current form sends the number in raw_user_meta_data, so 016's trigger
-- stored NULL in public.users.phone. student_profiles received the number, so it can be restored
-- without guessing. Runs before the login lookup below so those accounts work immediately.
-- ---------------------------------------------------------------------------------------
update public.users u
   set phone = nullif(trim(sp.phone), '')
  from public.student_profiles sp
 where sp.user_id = u.id
   and u.phone is null
   and nullif(trim(sp.phone), '') is not null;


-- ---------------------------------------------------------------------------------------
-- 3. login_email_for_phone(): the one anonymous read login genuinely needs.
--
-- The login page must turn a phone number into the email address Supabase's password flow signs
-- in with. It happens before a session exists, so public.users' RLS ("own row or admin") returns
-- nothing, and the old direct table read failed for every student.
--
-- The function returns a single value and only for a STUDENT account. It does not expose the row,
-- the profile, the role or the status. It is deliberately narrow rather than widening the table's
-- SELECT policy to anon, which would expose every user's row to the public API.
--
-- Trade-off, stated plainly: an anonymous caller can learn whether a phone number has an account.
-- That is inherent in any phone-to-identifier lookup. The returned address for current signups is
-- the deterministic synthetic address, so it adds no secret; older accounts may have a real email,
-- which is why the function is limited to students and returns no other column.
-- ---------------------------------------------------------------------------------------
create or replace function public.login_email_for_phone(p_phone text)
returns text
language sql security definer set search_path = public stable as $$
  select u.email
    from public.users u
   where u.phone = nullif(trim(p_phone), '')
     and u.role = 'STUDENT'
     and u.email is not null
   limit 1;
$$;
revoke all on function public.login_email_for_phone(text) from public;
grant execute on function public.login_email_for_phone(text) to anon, authenticated;


-- ---------------------------------------------------------------------------------------
-- 4. Make account deletion possible.
--
-- Two audit/history foreign keys had no ON DELETE action, so the row inserted by
-- delete_my_account() (and every earlier audit row written by the student) blocked the delete.
-- SET NULL keeps the audit trail — the event and entity_id remain — while releasing the account.
-- ---------------------------------------------------------------------------------------
alter table public.audit_logs
  drop constraint if exists audit_logs_actor_id_fkey;
alter table public.audit_logs
  add constraint audit_logs_actor_id_fkey
  foreign key (actor_id) references public.users(id) on delete set null;

alter table public.application_status_history
  drop constraint if exists application_status_history_actor_id_fkey;
alter table public.application_status_history
  add constraint application_status_history_actor_id_fkey
  foreign key (actor_id) references public.users(id) on delete set null;


-- ---------------------------------------------------------------------------------------
-- 5. delete_my_account(): delete the auth identity too.
--
-- The old version deleted only public.users. Even when the FK allowed it, the Supabase auth row
-- survived, so the login still existed. Deleting auth.users cascades through public.users and
-- every student-owned row (applications, documents, profile, referrals).
--
-- A loan of any status still blocks deletion: financial records are not erased by a self-service
-- action. Staff accounts are refused for the same reason as before.
-- ---------------------------------------------------------------------------------------
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = v_uid and role = 'STUDENT') then
    raise exception 'Only student accounts can be deleted here. Contact OGESEOUS to close a staff account.';
  end if;
  if exists (select 1 from public.loans where user_id = v_uid) then
    raise exception 'You have a loan on record with OGESEOUS, so your account cannot be deleted. Please settle it or contact us.';
  end if;

  -- Keep the referral record but drop the reference to an account that is about to disappear.
  update public.marketing_officers set user_id = null where user_id = v_uid;

  -- actor_id is null because the actor is being removed; entity_id preserves who was deleted.
  insert into public.audit_logs (actor_id, action, entity, entity_id)
  values (null, 'ACCOUNT_DELETED', 'users', v_uid::text);

  delete from auth.users where id = v_uid;
end $$;
revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
