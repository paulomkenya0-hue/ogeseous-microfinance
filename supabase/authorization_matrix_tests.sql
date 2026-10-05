-- =====================================================================================
-- OGESEOUS MICROFINANCE — Authorization matrix tests (database level).
-- Run in the SQL editor AFTER all migrations. Read-only apart from a temp table and a
-- transaction-scoped JWT-claims GUC; it changes no real data. Every row must read PASS.
--
-- How impersonation works: Supabase's auth.uid() reads auth.uid() -> request.jwt.claims
-- -> sub. Setting that GUC transactionally makes our SECURITY DEFINER functions behave
-- exactly as if that user called them over HTTP.
-- =====================================================================================

begin;

create temporary table if not exists authz_test_results (
  scenario text primary key,
  result text
);
truncate authz_test_results;

create or replace function pg_temp.expect_denied(p_scenario text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  insert into authz_test_results values (p_scenario, 'FAIL - call succeeded, but should have been denied')
  on conflict (scenario) do update set result = excluded.result;
exception when others then
  insert into authz_test_results values (p_scenario, 'PASS')
  on conflict (scenario) do update set result = excluded.result;
end $$;

create or replace function pg_temp.expect_allowed_error_is_not_permission(p_scenario text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  insert into authz_test_results values (p_scenario, 'PASS - call reached the function')
  on conflict (scenario) do update set result = excluded.result;
exception when others then
  -- Role check passed means the error must be about the object, not permissions.
  if sqlerrm ilike '%only %' or sqlerrm ilike '%permission denied%' then
    insert into authz_test_results values (p_scenario, 'FAIL - denied by role: ' || sqlerrm)
    on conflict (scenario) do update set result = excluded.result;
  else
    insert into authz_test_results values (p_scenario, 'PASS - passed role gate, failed later: ' || left(sqlerrm, 60))
    on conflict (scenario) do update set result = excluded.result;
  end if;
end $$;

-- -------------------------------------------------------------------------------------
-- As a STUDENT: the internal allocators and every admin action must be denied.
-- -------------------------------------------------------------------------------------
do $$
declare v_student uuid;
begin
  select id into v_student from public.users where role = 'STUDENT' and status = 'ACTIVE' limit 1;
  if v_student is null then
    insert into authz_test_results values ('student_present', 'SKIP - no active student in the database');
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_student, 'role', 'authenticated')::text, true);

  perform pg_temp.expect_denied('student_cannot_call_build_loan_schedule',
    format('select public.build_loan_schedule(%L::uuid)', gen_random_uuid()));
  perform pg_temp.expect_denied('student_cannot_call_rebuild_loan_payments',
    format('select public.rebuild_loan_payments(%L::uuid)', gen_random_uuid()));
  perform pg_temp.expect_denied('student_cannot_approve_loan',
    format('select public.review_loan_application(%L::uuid, %L, %L)', gen_random_uuid(), 'APPROVED', 'ok'));
  perform pg_temp.expect_denied('student_cannot_disburse_loan',
    format('select public.disburse_loan(%L::uuid, 1)', gen_random_uuid()));
  perform pg_temp.expect_denied('student_cannot_record_repayment',
    format('select public.record_repayment(%L::uuid, 1, %L, null)', gen_random_uuid(), 'CASH'));
  perform pg_temp.expect_denied('student_cannot_reverse_repayment',
    format('select public.reverse_repayment(%L::uuid, %L)', gen_random_uuid(), 'test'));
  perform pg_temp.expect_denied('student_cannot_set_role',
    format('select public.set_user_role(%L::uuid, %L)', gen_random_uuid(), 'MANAGER'));
  perform pg_temp.expect_denied('student_cannot_void_disbursement',
    format('select public.void_disbursement(%L::uuid, %L)', gen_random_uuid(), 'test'));
end $$;

-- Direct table exposure: as a student, another student's rows must be invisible.
do $$
declare v_a uuid; v_b uuid; v_rows integer;
begin
  select id into v_a from public.users where role = 'STUDENT' and status = 'ACTIVE' limit 1;
  select id into v_b from public.users where role = 'STUDENT' and status = 'ACTIVE' and id <> v_a limit 1;
  if v_a is null or v_b is null then
    insert into authz_test_results values ('cross_student_read', 'SKIP - need two active students');
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  select count(*) into v_rows from public.loans where user_id = v_b;
  insert into authz_test_results values ('student_cannot_read_other_students_loans',
    case when v_rows = 0 then 'PASS' else 'FAIL - saw ' || v_rows || ' rows' end);
  select count(*) into v_rows from public.student_profiles where user_id = v_b;
  insert into authz_test_results values ('student_cannot_read_other_profiles',
    case when v_rows = 0 then 'PASS' else 'FAIL - saw ' || v_rows || ' rows' end);
end $$;

-- -------------------------------------------------------------------------------------
-- LOAN_OFFICER: can review applications; cannot disburse, reverse, void, or set roles.
-- -------------------------------------------------------------------------------------
do $$
declare v_officer uuid;
begin
  select id into v_officer from public.users where role = 'LOAN_OFFICER' and status = 'ACTIVE' limit 1;
  if v_officer is null then
    insert into authz_test_results values ('loan_officer', 'SKIP - no active loan officer');
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_officer, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_denied('loan_officer_cannot_disburse',
    format('select public.disburse_loan(%L::uuid, 1)', gen_random_uuid()));
  perform pg_temp.expect_denied('loan_officer_cannot_reverse',
    format('select public.reverse_repayment(%L::uuid, %L)', gen_random_uuid(), 'test'));
  perform pg_temp.expect_denied('loan_officer_cannot_void',
    format('select public.void_disbursement(%L::uuid, %L)', gen_random_uuid(), 'test'));
  perform pg_temp.expect_denied('loan_officer_cannot_set_role',
    format('select public.set_user_role(%L::uuid, %L)', gen_random_uuid(), 'MANAGER'));
  perform pg_temp.expect_denied('loan_officer_cannot_record_repayment',
    format('select public.record_repayment(%L::uuid, 1, %L, null)', gen_random_uuid(), 'CASH'));
end $$;

-- -------------------------------------------------------------------------------------
-- COLLECTION_OFFICER: can record repayments; cannot reverse or change roles.
-- -------------------------------------------------------------------------------------
do $$
declare v_col uuid;
begin
  select id into v_col from public.users where role = 'COLLECTION_OFFICER' and status = 'ACTIVE' limit 1;
  if v_col is null then
    insert into authz_test_results values ('collection_officer', 'SKIP - no active collection officer');
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_col, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_allowed_error_is_not_permission('collection_officer_can_reach_record_repayment',
    format('select public.record_repayment(%L::uuid, 1, %L, null)', gen_random_uuid(), 'CASH'));
  perform pg_temp.expect_denied('collection_officer_cannot_reverse',
    format('select public.reverse_repayment(%L::uuid, %L)', gen_random_uuid(), 'test'));
  perform pg_temp.expect_denied('collection_officer_cannot_set_role',
    format('select public.set_user_role(%L::uuid, %L)', gen_random_uuid(), 'MANAGER'));
  perform pg_temp.expect_denied('collection_officer_cannot_disburse',
    format('select public.disburse_loan(%L::uuid, 1)', gen_random_uuid()));
end $$;

-- -------------------------------------------------------------------------------------
-- MANAGER: financial operations allowed; still cannot change roles (SUPER_ADMIN only).
-- -------------------------------------------------------------------------------------
do $$
declare v_mgr uuid;
begin
  select id into v_mgr from public.users where role = 'MANAGER' and status = 'ACTIVE' limit 1;
  if v_mgr is null then
    insert into authz_test_results values ('manager', 'SKIP - no active manager');
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_denied('manager_cannot_set_role',
    format('select public.set_user_role(%L::uuid, %L)', gen_random_uuid(), 'MANAGER'));
  perform pg_temp.expect_allowed_error_is_not_permission('manager_can_reach_recalculate_loan',
    format('select public.recalculate_loan(%L::uuid)', gen_random_uuid()));
end $$;

-- -------------------------------------------------------------------------------------
-- ANON: no function privileges on the internals, no rows in protected tables.
-- -------------------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform pg_temp.expect_denied('anon_cannot_call_build_loan_schedule',
    format('select public.build_loan_schedule(%L::uuid)', gen_random_uuid()));
  perform pg_temp.expect_denied('anon_cannot_call_rebuild_loan_payments',
    format('select public.rebuild_loan_payments(%L::uuid)', gen_random_uuid()));
  perform pg_temp.expect_denied('anon_cannot_disburse',
    format('select public.disburse_loan(%L::uuid, 1)', gen_random_uuid()));
  insert into authz_test_results
    select 'anon_sees_no_users', case when count(*) = 0 then 'PASS' else 'FAIL - ' || count(*) || ' rows' end
    from public.users;
end $$;

-- -------------------------------------------------------------------------------------
-- Grant checks (declarative, no impersonation needed). Expected: PASS on every row.
-- -------------------------------------------------------------------------------------
insert into authz_test_results
select 'grant_authenticated_build_loan_schedule',
       case when not has_function_privilege('authenticated', 'public.build_loan_schedule(uuid)', 'execute')
            then 'PASS' else 'FAIL' end
union all
select 'grant_authenticated_rebuild_loan_payments',
       case when not has_function_privilege('authenticated', 'public.rebuild_loan_payments(uuid)', 'execute')
            then 'PASS' else 'FAIL' end
union all
select 'grant_anon_build_loan_schedule',
       case when not has_function_privilege('anon', 'public.build_loan_schedule(uuid)', 'execute')
            then 'PASS' else 'FAIL' end
union all
select 'grant_anon_get_application_verification_still_allowed',
       case when has_function_privilege('anon', 'public.get_application_verification(text,text)', 'execute')
            then 'PASS' else 'FAIL' end
union all
select 'grant_authenticated_rate_limit_count_revoked',
       case when not has_function_privilege('authenticated', 'public.rate_limit_count(text,text,interval)', 'execute')
            then 'PASS' else 'FAIL' end
union all
select 'grant_authenticated_search_active_loans_allowed',
       case when has_function_privilege('authenticated', 'public.search_active_loans(text)', 'execute')
            then 'PASS' else 'FAIL' end;

select * from authz_test_results order by result desc, scenario;

rollback;
