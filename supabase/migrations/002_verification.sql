-- OGESEOUS MICROFINANCE — Step 2: Student Verification
-- Run after 001_foundation.sql. Copyright © Paulo Mkenya

create type public.verification_method as enum ('RUCU_AUTO','MANUAL');
create type public.request_status as enum ('PENDING','VERIFIED','REJECTED');

-- Admin-imported RUCU student register (source of truth for RUCU auto-match).
create table public.rucu_students (
  id uuid primary key default gen_random_uuid(),
  form_four_index_number text not null,
  registration_number text not null,
  last_name text not null,
  full_name text not null,
  imported_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  unique (form_four_index_number, registration_number)
);
alter table public.rucu_students enable row level security;
create policy "admins manage rucu register" on public.rucu_students
  for all using (public.is_admin()) with check (public.is_admin());
-- No student-facing policy: students never query this table directly, only via search_rucu_student() below.

create table public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  university text not null check (university in ('RUCU','MKWAWA','IU')),
  method public.verification_method not null,
  registration_number text not null,
  form_four_index_number text not null,
  full_name_provided text not null,
  rucu_student_id uuid references public.rucu_students(id),
  form_four_certificate_url text not null,
  identity_document_url text not null,
  passport_photo_url text not null,
  status public.request_status not null default 'PENDING',
  rejection_reason text,
  reviewed_by uuid references public.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_verification_touch before update on public.verification_requests
  for each row execute function public.touch_updated_at();

-- Only one open (PENDING or VERIFIED) request per student at a time.
create unique index one_open_request_per_student on public.verification_requests (user_id)
  where status in ('PENDING','VERIFIED');

alter table public.verification_requests enable row level security;
create policy "student reads own requests" on public.verification_requests
  for select using (user_id = auth.uid() or public.is_admin());
-- All writes go through the security-definer functions below, not direct insert/update,
-- so there are no insert/update policies here for ordinary users.
create policy "admins update requests" on public.verification_requests
  for update using (public.is_admin()) with check (public.is_admin());

-- Search the RUCU register without exposing the whole table to students.
-- Requires the index number plus at least one of registration number or last name to match.
create or replace function public.search_rucu_student(
  p_index text, p_registration text default null, p_lastname text default null
) returns table (id uuid, full_name text, registration_number text, form_four_index_number text)
language sql security definer set search_path = public stable as $$
  select r.id, r.full_name, r.registration_number, r.form_four_index_number
  from public.rucu_students r
  where auth.uid() is not null
    and lower(r.form_four_index_number) = lower(trim(p_index))
    and (
      (p_registration is not null and lower(r.registration_number) = lower(trim(p_registration)))
      or (p_lastname is not null and lower(r.last_name) = lower(trim(p_lastname)))
    )
  limit 1;
$$;
revoke all on function public.search_rucu_student(text,text,text) from public;
grant execute on function public.search_rucu_student(text,text,text) to authenticated;

-- Submit a verification request as the current student. Ignores any client-supplied status/role.
create or replace function public.submit_verification(
  p_university text, p_method text, p_registration text, p_index text, p_full_name text,
  p_rucu_student_id uuid, p_certificate_url text, p_id_document_url text, p_passport_url text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can submit verification';
  end if;
  insert into public.verification_requests
    (user_id, university, method, registration_number, form_four_index_number, full_name_provided,
     rucu_student_id, form_four_certificate_url, identity_document_url, passport_photo_url)
  values (auth.uid(), p_university, p_method::public.verification_method, trim(p_registration), trim(p_index), trim(p_full_name),
          p_rucu_student_id, p_certificate_url, p_id_document_url, p_passport_url)
  returning id into v_id;
  update public.student_profiles set verification_status = 'PENDING' where user_id = auth.uid();
  insert into public.audit_logs (actor_id, action, entity, entity_id) values (auth.uid(), 'VERIFICATION_SUBMITTED', 'verification_requests', v_id::text);
  return v_id;
end $$;
revoke all on function public.submit_verification(text,text,text,text,text,uuid,text,text,text) from public;
grant execute on function public.submit_verification(text,text,text,text,text,uuid,text,text,text) to authenticated;

-- Admin approves or rejects a request; keeps verification_requests and student_profiles in sync atomically.
create or replace function public.review_verification(p_request_id uuid, p_decision text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not public.is_admin() then raise exception 'Only admins can review verification requests'; end if;
  if p_decision not in ('VERIFIED','REJECTED') then raise exception 'Invalid decision'; end if;
  select user_id into v_user from public.verification_requests where id = p_request_id;
  if v_user is null then raise exception 'Request not found'; end if;
  update public.verification_requests
    set status = p_decision::public.request_status, rejection_reason = case when p_decision = 'REJECTED' then p_reason else null end,
        reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_request_id;
  update public.student_profiles set verification_status = p_decision::public.verification_status where user_id = v_user;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'VERIFICATION_' || p_decision, 'verification_requests', p_request_id::text, jsonb_build_object('reason', p_reason));
end $$;
revoke all on function public.review_verification(uuid,text,text) from public;
grant execute on function public.review_verification(uuid,text,text) to authenticated;

-- Admin bulk-imports the RUCU register from a parsed CSV/Excel file (array of rows).
create or replace function public.import_rucu_students(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer := 0; r jsonb;
begin
  if not public.is_admin() then raise exception 'Only admins can import the student register'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.rucu_students (form_four_index_number, registration_number, last_name, full_name, imported_by)
    values (trim(r->>'form_four_index_number'), trim(r->>'registration_number'), trim(r->>'last_name'), trim(r->>'full_name'), auth.uid())
    on conflict (form_four_index_number, registration_number)
      do update set last_name = excluded.last_name, full_name = excluded.full_name;
    v_count := v_count + 1;
  end loop;
  insert into public.audit_logs (actor_id, action, entity, metadata) values (auth.uid(), 'RUCU_IMPORT', 'rucu_students', jsonb_build_object('rows', v_count));
  return v_count;
end $$;
revoke all on function public.import_rucu_students(jsonb) from public;
grant execute on function public.import_rucu_students(jsonb) to authenticated;

-- Private storage for verification documents. Create the bucket if it doesn't exist yet.
insert into storage.buckets (id, name, public) values ('verification-documents','verification-documents', false)
  on conflict (id) do nothing;

create policy "own folder upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'verification-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder read" on storage.objects for select to authenticated
  using (bucket_id = 'verification-documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "own folder update" on storage.objects for update to authenticated
  using (bucket_id = 'verification-documents' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'verification-documents' and (storage.foldername(name))[1] = auth.uid()::text);
