-- OGESEOUS MICROFINANCE — Step 3: Loan Application System (draft capture only)
-- Run after 001, 002, 003. Copyright © Paulo Mkenya
--
-- Scope note: this step builds the loan application form and stores it as a DRAFT.
-- Mandatory Terms & Conditions acceptance and final submission are Step 4.
-- Admin review/assessment of applications is Step 7. Neither is implemented yet.

create table public.loan_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  purpose text not null check (purpose in ('TUITION_FEES','ACCOMMODATION','BOOKS_AND_MATERIALS','OTHER')),
  purpose_other text,
  repayment_period_months integer not null check (repayment_period_months in (6,12,18,24)),
  status text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_loan_app_touch before update on public.loan_applications
  for each row execute function public.touch_updated_at();

-- One active application per student while only DRAFT exists; keeps room for future statuses.
create unique index one_open_application_per_student on public.loan_applications (user_id)
  where status in ('DRAFT','SUBMITTED');

alter table public.loan_applications enable row level security;
create policy "student reads own application" on public.loan_applications
  for select using (user_id = auth.uid() or public.is_admin());
-- No direct insert/update policy: all writes go through save_loan_application_draft() below,
-- which enforces verification and draft-only editing.

-- Create or update the student's draft application. Only VERIFIED students may call this,
-- and only while the application is still a DRAFT (Step 4 will add the submit transition).
create or replace function public.save_loan_application_draft(
  p_amount numeric, p_purpose text, p_purpose_other text, p_repayment_months integer
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'STUDENT' and status = 'ACTIVE') then
    raise exception 'Only active student accounts can apply';
  end if;
  if not exists (select 1 from public.student_profiles where user_id = auth.uid() and verification_status = 'VERIFIED') then
    raise exception 'Complete student verification before applying for a loan';
  end if;
  if p_purpose not in ('TUITION_FEES','ACCOMMODATION','BOOKS_AND_MATERIALS','OTHER') then raise exception 'Invalid purpose'; end if;
  if p_repayment_months not in (6,12,18,24) then raise exception 'Invalid repayment period'; end if;

  insert into public.loan_applications (user_id, amount, purpose, purpose_other, repayment_period_months)
  values (auth.uid(), p_amount, p_purpose, nullif(trim(coalesce(p_purpose_other,'')),''), p_repayment_months)
  on conflict (user_id) where status in ('DRAFT','SUBMITTED') do update
    set amount = excluded.amount, purpose = excluded.purpose, purpose_other = excluded.purpose_other,
        repayment_period_months = excluded.repayment_period_months
    where public.loan_applications.status = 'DRAFT'
  returning id into v_id;

  if v_id is null then raise exception 'This application has already been submitted and can no longer be edited here'; end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id) values (auth.uid(), 'LOAN_DRAFT_SAVED', 'loan_applications', v_id::text);
  return v_id;
end $$;
revoke all on function public.save_loan_application_draft(numeric,text,text,integer) from public;
grant execute on function public.save_loan_application_draft(numeric,text,text,integer) to authenticated;
