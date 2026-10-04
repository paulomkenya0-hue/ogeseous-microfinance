-- OGESEOUS MICROFINANCE — Step 7: Admin verification & loan assessment
-- Run after 005. Copyright © Paulo Mkenya

alter table public.loan_applications drop constraint if exists loan_applications_status_check;
alter table public.loan_applications
  add constraint loan_applications_status_check
  check (status in ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED','DISBURSED','CLOSED'));

alter table public.loan_applications
  add column reviewed_by uuid references public.users(id),
  add column reviewed_at timestamptz,
  add column review_notes text;

-- Loan/collection/accounts staff can see every submitted application, not just their own.
create policy "staff read applications" on public.loan_applications
  for select using (exists (select 1 from public.users u where u.id = auth.uid()
    and u.role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN') and u.status = 'ACTIVE'));

create or replace function public.review_loan_application(p_id uuid, p_decision text, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.users where id = auth.uid() and role in ('LOAN_OFFICER','MANAGER','SUPER_ADMIN') and status = 'ACTIVE') then
    raise exception 'Only loan officers, managers or super admins can review applications';
  end if;
  if p_decision not in ('UNDER_REVIEW','APPROVED','REJECTED') then raise exception 'Invalid decision'; end if;
  update public.loan_applications
    set status = p_decision, reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes
    where id = p_id and status in ('SUBMITTED','UNDER_REVIEW');
  if not found then raise exception 'Application not found or not awaiting review'; end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (auth.uid(), 'LOAN_APPLICATION_' || p_decision, 'loan_applications', p_id::text, jsonb_build_object('notes', p_notes));
end $$;
revoke all on function public.review_loan_application(uuid,text,text) from public;
grant execute on function public.review_loan_application(uuid,text,text) to authenticated;
