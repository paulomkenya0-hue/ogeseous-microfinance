-- RUCU register may be imported without a Form Four index. Index supplied by student is unverified.
-- No existing student/loan/repayment rows are deleted.
alter table public.rucu_students alter column form_four_index_number drop not null;

-- Prevent two register entries with the same registration number. Stop with a clear error if
-- historical duplicates exist rather than silently selecting one.
do $$ begin
  if exists (select 1 from public.rucu_students group by lower(trim(registration_number)) having count(*) > 1) then
    raise exception 'Duplicate registration numbers in rucu_students; resolve them before migration 031';
  end if;
end $$;
create unique index if not exists rucu_students_registration_unique_ci
  on public.rucu_students (lower(trim(registration_number)));

create or replace function public.import_rucu_students(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_count integer := 0; v_reg text; v_index text; v_last text; v_full text;
begin
  if not public.is_admin() then raise exception 'Only admins can import the student register'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 250 then
    raise exception 'Supply a JSON array of at most 250 students';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    v_reg := nullif(trim(r->>'registration_number'), '');
    v_index := nullif(trim(r->>'form_four_index_number'), '');
    v_last := nullif(trim(r->>'last_name'), '');
    v_full := nullif(trim(r->>'full_name'), '');
    if v_reg is null or v_last is null or v_full is null then continue; end if;
    if length(v_reg) > 100 or length(v_full) > 300 or length(v_last) > 150 then
      raise exception 'Invalid student record length';
    end if;
    -- ON CONFLICT expression matches case-insensitive unique index, including legacy rows.
    insert into public.rucu_students
      (registration_number, form_four_index_number, last_name, full_name, programme, year_of_study, imported_by)
    values (v_reg, v_index, v_last, v_full, nullif(trim(r->>'programme'), ''),
            nullif(trim(r->>'year_of_study'), ''), auth.uid())
    on conflict (lower(trim(registration_number))) do update
      set last_name = excluded.last_name,
          full_name = excluded.full_name,
          programme = coalesce(excluded.programme, public.rucu_students.programme),
          year_of_study = coalesce(excluded.year_of_study, public.rucu_students.year_of_study),
          form_four_index_number = coalesce(excluded.form_four_index_number, public.rucu_students.form_four_index_number);
    v_count := v_count + 1;
  end loop;
  insert into public.audit_logs (actor_id, action, entity, metadata)
    values (auth.uid(), 'RUCU_IMPORT', 'rucu_students', jsonb_build_object('rows',v_count));
  return v_count;
end $$;
revoke all on function public.import_rucu_students(jsonb) from public, anon;
grant execute on function public.import_rucu_students(jsonb) to authenticated;

-- Student may propose an index only on their own already-matched RUCU DRAFT.
-- Do not write to the authoritative RUCU register or mark identity verified.
create or replace function public.submit_rucu_form_four_index(p_index text) returns void
language plpgsql security definer set search_path = public as $$
declare v_index text := upper(trim(coalesce(p_index,''))); v_app uuid;
begin
  if auth.uid() is null or not exists (
    select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE'
  ) then raise exception 'Only active students can submit an index'; end if;
  if length(v_index) < 6 or length(v_index) > 50 or v_index !~ '^[A-Z0-9/-]+$' then
    raise exception 'Enter a valid Form Four index number'; end if;
  select a.id into v_app from public.loan_applications a
  where a.user_id = auth.uid() and a.status = 'DRAFT'
    and a.verification_method = 'RUCU_REGISTER' and a.student_record_id is not null
  limit 1 for update;
  if v_app is null then raise exception 'Match your RUCU registration first; only drafts can be edited'; end if;
  if exists (select 1 from public.student_profiles sp
    where sp.user_id = auth.uid() and sp.verification_status = 'VERIFIED') then
    raise exception 'Verified identity is staff-managed'; end if;
  if exists (select 1 from public.student_profiles sp
    where sp.user_id <> auth.uid() and upper(trim(sp.form_four_index_number)) = v_index) then
    raise exception 'Index number already belongs to another account'; end if;
  perform public.trusted_write();
  update public.student_profiles set form_four_index_number = v_index
    where user_id = auth.uid() and university = 'RUCU';
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'RUCU_INDEX_SELF_REPORTED', 'loan_applications', v_app::text,
      jsonb_build_object('index_submitted', true, 'verification_required', true));
end $$;
revoke all on function public.submit_rucu_form_four_index(text) from public, anon;
grant execute on function public.submit_rucu_form_four_index(text) to authenticated;
