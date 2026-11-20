-- 032: Accountant-selected monthly flat rate for NEW terms only. Review before production deployment.
-- New terms use simple (flat) MONTHLY interest; existing annual/reducing-balance terms remain unchanged.
-- Do not backfill monthly_rate for historical offers or rewrite recorded installments.
alter table public.loan_terms add column if not exists monthly_rate numeric(9,6);
alter table public.loan_terms drop constraint if exists loan_terms_monthly_rate_check;
alter table public.loan_terms add constraint loan_terms_monthly_rate_check
  check (monthly_rate is null or (monthly_rate >= 0 and monthly_rate <= 100));

create or replace function public.flat_monthly_schedule(
 p_principal numeric, p_monthly_rate numeric, p_months integer
) returns table (
 seq integer, opening_balance numeric, interest_amount numeric,
 principal_amount numeric, installment_amount numeric, closing_balance numeric
) language plpgsql immutable as $$
declare
 v_interest_total numeric; v_total numeric; v_interest_paid numeric := 0;
 v_principal_paid numeric := 0; v_due_paid numeric := 0;
 v_i numeric; v_p numeric; v_due numeric; i integer;
begin
 if p_principal is null or p_principal <= 0 or p_months is null or p_months not in (1,2,3)
    or p_monthly_rate is null or p_monthly_rate < 0 or p_monthly_rate > 100 then
   raise exception 'Invalid principal, monthly interest rate or repayment period';
 end if;
 v_interest_total := round(p_principal * p_monthly_rate / 100 * p_months, 2);
 v_total := round(p_principal + v_interest_total, 2);
 for i in 1..p_months loop
   v_i := case when i = p_months then v_interest_total - v_interest_paid
               else round(v_interest_total / p_months, 2) end;
   v_p := case when i = p_months then round(p_principal - v_principal_paid, 2)
               else round(p_principal / p_months, 2) end;
   v_due := round(v_p + v_i, 2);
   seq := i;
   opening_balance := round(p_principal - v_principal_paid, 2);
   interest_amount := v_i;
   principal_amount := v_p;
   installment_amount := v_due;
   closing_balance := round(opening_balance - v_p, 2);
   return next;
   v_interest_paid := v_interest_paid + v_i;
   v_principal_paid := v_principal_paid + v_p;
   v_due_paid := v_due_paid + v_due;
 end loop;
end $$;
revoke all on function public.flat_monthly_schedule(numeric,numeric,integer) from public;
grant execute on function public.flat_monthly_schedule(numeric,numeric,integer) to authenticated;

create or replace function public.loan_quote_flat_monthly(
 p_principal numeric, p_monthly_rate numeric, p_months integer
) returns table (installment_amount numeric,total_interest numeric,total_repayable numeric)
language sql immutable as $$
 with s as (select * from public.flat_monthly_schedule(p_principal,p_monthly_rate,p_months))
 select (select installment_amount from s order by seq limit 1),
        round(sum(interest_amount),2), round(sum(installment_amount),2) from s;
$$;
revoke all on function public.loan_quote_flat_monthly(numeric,numeric,integer) from public;
grant execute on function public.loan_quote_flat_monthly(numeric,numeric,integer) to authenticated;

create or replace function public.accountant_prepare_terms(
  p_application_id uuid,
  p_principal numeric,
  p_annual_rate numeric,
  p_period_months integer,
  p_comment text default null,
  p_terms_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_app public.loan_applications%rowtype;
  v_terms public.loan_terms%rowtype;
  v_before jsonb;
  v_terms_id uuid;
  v_tranche integer;
  v_committed numeric;
  v_rate numeric;
  v_min_rate numeric;
  v_max_rate numeric;
  v_quote record;
  v_months integer[];
begin
  if not exists (select 1 from public.users
                  where id = auth.uid()
                    and role in ('ACCOUNTANT','SUPER_ADMIN')
                    and status = 'ACTIVE') then
    raise exception 'Only an accountant can prepare loan terms';
  end if;

  select * into v_app from public.loan_applications where id = p_application_id for update;
  if v_app.id is null then raise exception 'Application not found'; end if;
  if v_app.status not in ('PENDING_ACCOUNTANT','RETURNED_TO_ACCOUNTANT','DISBURSED') then
    raise exception 'This application is % and is not ready for terms', v_app.status;
  end if;

  if p_principal is null or round(p_principal, 2) <= 0 then
    raise exception 'Enter the amount to be paid out in this tranche';
  end if;
  if p_annual_rate is null then raise exception 'Enter the monthly flat interest rate for this tranche'; end if;
  v_rate := round(p_annual_rate, 6);
  v_min_rate := public.setting_num('min_monthly_interest_rate', 0);
  v_max_rate := public.setting_num('max_monthly_interest_rate', 100);
  if v_rate < v_min_rate or v_rate > v_max_rate then
    raise exception 'Interest rate % is outside the permitted range % to %', v_rate, v_min_rate, v_max_rate;
  end if;

  v_months := public.allowed_repayment_months();
  if p_period_months is null or p_period_months not in (1, 2, 3) or not (p_period_months = any (v_months)) then
    raise exception 'Choose a repayment period of 1, 2 or 3 months';
  end if;

  -- Resolve the row this call is allowed to write.
  if p_terms_id is not null then
    select * into v_terms from public.loan_terms where id = p_terms_id for update;
    if v_terms.id is null or v_terms.application_id <> p_application_id then
      raise exception 'Terms not found on this application';
    end if;
    if v_terms.status <> 'DRAFT_TERMS' then
      raise exception 'These terms are % and can no longer be edited', v_terms.status;
    end if;
    v_terms_id := v_terms.id;
  else
    select * into v_terms from public.loan_terms
     where application_id = p_application_id and status = 'DRAFT_TERMS'
     order by tranche_no desc limit 1
     for update;
    if v_terms.id is not null then
      v_terms_id := v_terms.id;
    else
      -- A first set or a later tranche. RETURNED_TO_ACCOUNTANT with no draft means the row was
      -- lost or already moved on; refuse rather than guess which tranche was meant.
      if v_app.status = 'RETURNED_TO_ACCOUNTANT' then
        raise exception 'There is no returned terms row to correct. Ask the manager to return the terms again.';
      end if;
      select coalesce(max(tranche_no), 0) + 1 into v_tranche
        from public.loan_terms where application_id = p_application_id;
      v_terms_id := null;  -- insert path below
    end if;
  end if;

  -- Everything already committed to this application, excluding the row being replaced.
  select coalesce(sum(t.principal_amount), 0) into v_committed
    from public.loan_terms t
   where t.application_id = p_application_id
     and t.status <> 'VOIDED'
     and t.id is distinct from v_terms_id;
  if round(v_committed + round(p_principal, 2), 2) > round(v_app.amount, 2) then
    raise exception 'The tranches would total % which is more than the % the student applied for',
      round(v_committed + round(p_principal, 2), 2), round(v_app.amount, 2);
  end if;

  select * into v_quote from public.loan_quote_flat_monthly(round(p_principal, 2), v_rate, p_period_months);

  if v_terms_id is not null then
    select to_jsonb(t) into v_before from public.loan_terms t where t.id = v_terms_id;
    update public.loan_terms
       set principal_amount = round(p_principal, 2),
           annual_rate = 0,
           monthly_rate = v_rate,
           period_months = p_period_months,
           installment_amount = v_quote.installment_amount,
           total_interest = v_quote.total_interest,
           total_repayable = v_quote.total_repayable,
           status = 'PENDING_MANAGER_TERMS',
           prepared_by = auth.uid(),
           prepared_at = now(),
           accountant_comment = nullif(trim(coalesce(p_comment, '')), ''),
           return_reason = null,
           approved_by = null,
           approved_at = null,
           accepted_at = null
     where id = v_terms_id
     returning * into v_terms;

    perform public.record_workflow_transition(
      p_application_id, 'ACCOUNTANT_TERMS', v_app.status, 'PENDING_TERMS_APPROVAL',
      p_comment, v_terms_id, false,
      jsonb_build_object('tranche_no', v_terms.tranche_no, 'principal', v_terms.principal_amount,
                         'revised', true));
  else
    insert into public.loan_terms
      (application_id, tranche_no, status, principal_amount, annual_rate, monthly_rate, period_months,
       installment_amount, total_interest, total_repayable,
       prepared_by, prepared_at, accountant_comment)
    values
      (p_application_id, v_tranche, 'PENDING_MANAGER_TERMS', round(p_principal, 2), 0, v_rate, p_period_months,
       v_quote.installment_amount, v_quote.total_interest, v_quote.total_repayable,
       auth.uid(), now(), nullif(trim(coalesce(p_comment, '')), ''))
    returning * into v_terms;
    v_terms_id := v_terms.id;

    perform public.record_workflow_transition(
      p_application_id, 'ACCOUNTANT_TERMS', v_app.status, 'PENDING_TERMS_APPROVAL',
      p_comment, v_terms_id, false,
      jsonb_build_object('tranche_no', v_tranche, 'principal', round(p_principal, 2)));
  end if;

  update public.loan_applications
     set status = 'PENDING_TERMS_APPROVAL',
         action_required_note = null
   where id = p_application_id;

  perform public.log_financial_event(
    'loan_terms', v_terms_id::text, 'TERMS_PREPARED', p_comment, v_before, to_jsonb(v_terms),
    jsonb_build_object('application_id', p_application_id, 'tranche_no', v_terms.tranche_no));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_TERMS_PREPARED', 'loan_terms', v_terms_id::text,
            jsonb_build_object('application_id', p_application_id, 'tranche_no', v_terms.tranche_no,
                               'principal', v_terms.principal_amount, 'monthly_rate', v_rate,
                               'period_months', p_period_months));

  return v_terms_id;
end $$;
create or replace function public.disburse_tranche(
  p_terms_id uuid,
  p_channel text,
  p_reference text,
  p_proof_path text,
  p_idempotency_key text default null,
  p_confirm boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_terms public.loan_terms%rowtype;
  v_app public.loan_applications%rowtype;
  v_loan public.loans%rowtype;
  v_existing uuid;
  v_disbursement_id uuid;
  v_loan_id uuid;
  v_disbursed_at timestamptz := now();
  v_channel text := upper(trim(coalesce(p_channel, '')));
  v_reference text := nullif(trim(coalesce(p_reference, '')), '');
  v_proof text := nullif(trim(coalesce(p_proof_path, '')), '');
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_disbursed_total numeric;
  v_scheduled record;
begin
  if not exists (
    select 1 from public.users
     where id = auth.uid() and role in ('ACCOUNTANT','SUPER_ADMIN') and status = 'ACTIVE'
  ) then
    raise exception 'Only an accountant can disburse loan money';
  end if;
  if not coalesce(p_confirm, false) then
    raise exception 'Confirm that the money has actually been paid before recording this disbursement';
  end if;
  if v_channel not in ('CASH','MOBILE_MONEY','BANK_TRANSFER','CHEQUE') then
    raise exception 'Choose a valid disbursement channel';
  end if;
  if v_channel <> 'CASH' and v_reference is null then
    raise exception 'Enter the transaction reference for this % payment', lower(v_channel);
  end if;
  if v_reference is not null and length(v_reference) > 120 then
    raise exception 'The transaction reference is too long';
  end if;
  if v_proof is null then
    raise exception 'Attach proof of payment before recording this disbursement';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'payment-proofs'
       and o.name = v_proof
       and (storage.foldername(o.name))[1] = auth.uid()::text
  ) then
    raise exception 'That proof of payment could not be found in your upload folder. Upload it again.';
  end if;

  select * into v_terms from public.loan_terms where id = p_terms_id for update;
  if v_terms.id is null then raise exception 'Loan terms not found'; end if;
  if v_terms.status <> 'ACCEPTED_BY_STUDENT' then
    raise exception 'These terms are % and have not been accepted by the student', v_terms.status;
  end if;

  select * into v_app from public.loan_applications where id = v_terms.application_id for update;
  if v_app.id is null then raise exception 'Application not found'; end if;
  if v_app.status <> 'TERMS_ACCEPTED' then
    raise exception 'This application is % and is not ready for disbursement', v_app.status;
  end if;

  if v_key is not null then
    select id into v_existing from public.disbursements where idempotency_key = v_key;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  if exists (select 1 from public.disbursements where terms_id = p_terms_id and status = 'RECORDED') then
    raise exception 'These terms have already been disbursed. If this is a mistake, void the disbursement instead of recording a second one.';
  end if;

  if v_reference is not null and exists (
    select 1 from public.disbursements
     where lower(btrim(reference)) = lower(v_reference)
       and status = 'RECORDED'
  ) then
    raise exception 'Reference "%" is already recorded against another disbursement. Check for a duplicate.', v_reference;
  end if;

  select coalesce(sum(amount), 0) into v_disbursed_total
    from public.disbursements
   where application_id = v_app.id and status = 'RECORDED';
  if round(v_disbursed_total + v_terms.principal_amount, 2) > round(v_app.amount, 2) then
    raise exception 'Disbursing this tranche would pay out % against a % application',
      round(v_disbursed_total + v_terms.principal_amount, 2), round(v_app.amount, 2);
  end if;

  if not exists (select 1 from public.student_profiles
                  where user_id = v_app.user_id and verification_status = 'VERIFIED') then
    raise exception 'The student is no longer verified, so this cannot be disbursed';
  end if;
  if not exists (select 1 from public.users where id = v_app.user_id and status = 'ACTIVE') then
    raise exception 'The student''s account is suspended, so this cannot be disbursed';
  end if;

  select * into v_loan from public.loans where application_id = v_app.id for update;

  if v_loan.id is null then
    insert into public.loans
      (application_id, user_id, principal_amount, outstanding_balance, status,
       disbursed_by, disbursed_at, total_interest, total_repayable)
    values
      (v_app.id, v_app.user_id, v_terms.principal_amount, v_terms.total_repayable, 'ACTIVE',
       auth.uid(), v_disbursed_at, v_terms.total_interest, v_terms.total_repayable)
    returning * into v_loan;
  else
    if v_loan.status = 'CLOSED' then
      raise exception 'This loan is closed and cannot accept another tranche';
    end if;
    if v_loan.status = 'PAID_OFF' then
      raise exception 'This loan is paid off. A new tranche cannot be added after payoff.';
    end if;

    if v_loan.status = 'VOIDED' then
      -- The previous tranche was voided and the loan row is the historical shell. Reset it to the
      -- tranche being paid out now.
      update public.loans
         set principal_amount = v_terms.principal_amount,
             outstanding_balance = v_terms.total_repayable,
             total_interest = v_terms.total_interest,
             total_repayable = v_terms.total_repayable,
             amount_verified = 0,
             amount_pending = 0,
             status = 'ACTIVE',
             disbursed_by = auth.uid(),
             disbursed_at = v_disbursed_at,
             paid_off_at = null,
             closed_at = null,
             closed_by = null
       where id = v_loan.id
       returning * into v_loan;
    else
      update public.loans
         set principal_amount = principal_amount + v_terms.principal_amount,
             outstanding_balance = outstanding_balance + v_terms.total_repayable,
             total_interest = total_interest + v_terms.total_interest,
             total_repayable = total_repayable + v_terms.total_repayable,
             status = 'ACTIVE'
       where id = v_loan.id
       returning * into v_loan;
    end if;
  end if;

  insert into public.disbursements
    (application_id, loan_id, terms_id, tranche_no, amount, channel, reference, proof_path,
     status, disbursed_by, disbursed_at, idempotency_key)
  values
    (v_app.id, v_loan.id, p_terms_id, v_terms.tranche_no, v_terms.principal_amount,
     v_channel, v_reference, v_proof, 'RECORDED', auth.uid(), v_disbursed_at, v_key)
  returning id into v_disbursement_id;

  -- One schedule per tranche, dated from this tranche's own disbursement.
  for v_scheduled in
    select * from public.flat_monthly_schedule(v_terms.principal_amount, v_terms.monthly_rate, v_terms.period_months)
    where v_terms.monthly_rate is not null
    union all
    select * from public.amortization_schedule(v_terms.principal_amount, v_terms.annual_rate, v_terms.period_months)
    where v_terms.monthly_rate is null
  loop
    insert into public.loan_installments
      (loan_id, terms_id, tranche_no, seq, due_date, amount_due, amount_paid, status,
       opening_balance, interest_amount, principal_amount, closing_balance)
    values
      (v_loan.id, p_terms_id, v_terms.tranche_no, v_scheduled.seq,
       (v_disbursed_at + make_interval(months => v_scheduled.seq))::date,
       v_scheduled.installment_amount, 0, 'PENDING',
       v_scheduled.opening_balance, v_scheduled.interest_amount,
       v_scheduled.principal_amount, v_scheduled.closing_balance);
  end loop;

  update public.loan_terms set status = 'DISBURSED' where id = p_terms_id;
  update public.loan_applications set status = 'DISBURSED' where id = v_app.id;

  perform public.rebuild_loan_payments_internal(v_loan.id);

  perform public.log_financial_event(
    'disbursements', v_disbursement_id::text, 'DISBURSEMENT_RECORDED', null, null,
    jsonb_build_object('application_id', v_app.id, 'loan_id', v_loan.id,
                       'terms_id', p_terms_id, 'tranche_no', v_terms.tranche_no,
                       'amount', v_terms.principal_amount, 'channel', v_channel,
                       'reference', v_reference),
    jsonb_build_object('annuity', v_terms.installment_amount, 'period_months', v_terms.period_months,
                       'annual_rate', v_terms.annual_rate));

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (auth.uid(), 'LOAN_TRANCHE_DISBURSED', 'disbursements', v_disbursement_id::text,
          jsonb_build_object('application_id', v_app.id, 'loan_id', v_loan.id,
                             'tranche_no', v_terms.tranche_no, 'amount', v_terms.principal_amount,
                             'channel', v_channel, 'reference', v_reference));

  return v_disbursement_id;
end $$;
create or replace function public.get_application_terms_v2(p_application_id uuid)
returns table (
  terms_id uuid, tranche_no integer, status text, principal_amount numeric, annual_rate numeric, monthly_rate numeric,
  period_months integer, installment_amount numeric, total_interest numeric, total_repayable numeric,
  prepared_at timestamptz, approved_at timestamptz, accepted_at timestamptz,
  manager_comment text, accountant_comment text, return_reason text
) language plpgsql security definer set search_path = public stable as $$
declare
  v_owner uuid;
  v_is_staff boolean := false;
begin
  select a.user_id into v_owner from public.loan_applications a where a.id = p_application_id;
  if v_owner is null then raise exception 'Application not found'; end if;

  v_is_staff := coalesce(exists (
    select 1 from public.users u
     where u.id = auth.uid()
       and u.role in ('LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MANAGER','SUPER_ADMIN')
       and u.status = 'ACTIVE'
  ), false);

  if not (v_owner = auth.uid() or v_is_staff) then
    raise exception 'You cannot see the terms on this application';
  end if;

  return query
  select t.id, t.tranche_no, t.status, t.principal_amount, t.annual_rate, t.monthly_rate,
         t.period_months, t.installment_amount, t.total_interest, t.total_repayable,
         t.prepared_at, t.approved_at, t.accepted_at,
         case when v_is_staff then t.manager_comment else null end,
         case when v_is_staff then t.accountant_comment else null end,
         case when v_is_staff then t.return_reason else null end
    from public.loan_terms t
   where t.application_id = p_application_id
     and (v_is_staff or t.status in ('APPROVED_TERMS','ACCEPTED_BY_STUDENT','DISBURSED'))
   order by t.tranche_no;
end $$;
revoke all on function public.get_application_terms_v2(uuid) from public;
grant execute on function public.get_application_terms_v2(uuid) to authenticated;
notify pgrst, 'reload schema';
