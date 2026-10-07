-- Allow importing the current RUCU register, which identifies students by registration number
-- and does not provide Form Four index numbers.

alter table public.rucu_students
  alter column form_four_index_number drop not null;

alter table public.rucu_students
  drop constraint if exists rucu_students_form_four_index_number_registration_number_key;

do $$
begin
  if exists (
    select 1
    from public.rucu_students
    group by upper(trim(registration_number))
    having count(*) > 1
  ) then
    raise exception 'RUCU register has duplicate registration numbers; resolve duplicates before migration 021';
  end if;
end $$;

create unique index if not exists rucu_students_registration_number_key
  on public.rucu_students (upper(trim(registration_number)));

create or replace function public.import_rucu_students(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer := 0;
  v_row_number integer;
  v_registration text;
  v_last_name text;
  v_full_name text;
  r jsonb;
begin
  if not public.is_admin() then raise exception 'Only admins can import the student register'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Student rows must be a JSON array'; end if;
  if jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Import must contain between 1 and 5000 student rows';
  end if;

  for r, v_row_number in
    select value, ordinality::integer
    from jsonb_array_elements(p_rows) with ordinality as rows(value, ordinality)
  loop
    if jsonb_typeof(r) is distinct from 'object' then
      raise exception 'Invalid student data on row %', v_row_number;
    end if;

    v_registration := upper(trim(coalesce(r->>'registration_number', '')));
    v_last_name := trim(coalesce(r->>'last_name', ''));
    v_full_name := trim(coalesce(r->>'full_name', ''));
    if length(v_registration) < 3 or length(v_registration) > 80
       or length(v_last_name) < 2 or length(v_last_name) > 100
       or length(v_full_name) < 3 or length(v_full_name) > 160 then
      raise exception 'Missing or invalid registration number/name on row %', v_row_number;
    end if;

    insert into public.rucu_students (
      form_four_index_number, registration_number, last_name, full_name,
      programme, year_of_study, imported_by
    ) values (
      nullif(trim(coalesce(r->>'form_four_index_number', '')), ''), v_registration, v_last_name, v_full_name,
      nullif(trim(coalesce(r->>'programme', '')), ''), nullif(trim(coalesce(r->>'year_of_study', '')), ''), auth.uid()
    )
    on conflict ((upper(trim(registration_number)))) do update
      set form_four_index_number = coalesce(excluded.form_four_index_number, public.rucu_students.form_four_index_number),
          last_name = excluded.last_name,
          full_name = excluded.full_name,
          programme = coalesce(excluded.programme, public.rucu_students.programme),
          year_of_study = coalesce(excluded.year_of_study, public.rucu_students.year_of_study);
    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs (actor_id, action, entity, metadata)
    values (auth.uid(), 'RUCU_IMPORT', 'rucu_students', jsonb_build_object('rows', v_count));
  return v_count;
end $$;

revoke all on function public.import_rucu_students(jsonb) from public;
grant execute on function public.import_rucu_students(jsonb) to authenticated;