-- OGESEOUS MICROFINANCE — Step 4 (Terms acceptance & submission) + Step 6 support (QR verification)
-- Run after 001–004. Copyright © Paulo Mkenya

alter table public.loan_applications
  add column terms_accepted boolean not null default false,
  add column terms_accepted_at timestamptz,
  add column submitted_at timestamptz,
  add column application_number text unique,
  add column verification_token text unique;

create sequence public.application_number_seq;

-- Submits a DRAFT application: requires explicit Terms & Conditions acceptance,
-- generates the application number and a private QR verification token.
create or replace function public.submit_loan_application(p_id uuid, p_terms_accepted boolean)
returns table (application_number text, verification_token text)
language plpgsql security definer set search_path = public as $$
declare v_num text; v_token text;
begin
  if not p_terms_accepted then raise exception 'You must accept the Terms & Conditions to submit'; end if;
  v_num := 'OGE-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.application_number_seq')::text, 4, '0');
  v_token := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));

  update public.loan_applications
    set status = 'SUBMITTED', terms_accepted = true, terms_accepted_at = now(), submitted_at = now(),
        application_number = v_num, verification_token = v_token
    where id = p_id and user_id = auth.uid() and status = 'DRAFT';

  if not found then raise exception 'Application not found or already submitted'; end if;
  insert into public.audit_logs (actor_id, action, entity, entity_id) values (auth.uid(), 'LOAN_APPLICATION_SUBMITTED', 'loan_applications', p_id::text);
  return query select v_num, v_token;
end $$;
revoke all on function public.submit_loan_application(uuid,boolean) from public;
grant execute on function public.submit_loan_application(uuid,boolean) to authenticated;

-- Public verification for the printed/QR form. Requires BOTH the application number and its
-- private token (only present on the QR code), so the application number alone can't be scraped.
create or replace function public.get_application_verification(p_app_number text, p_token text)
returns table (application_number text, full_name text, university text, status text, submitted_at timestamptz)
language sql security definer set search_path = public stable as $$
  select la.application_number, sp.full_name, sp.university, la.status, la.submitted_at
  from public.loan_applications la join public.student_profiles sp on sp.user_id = la.user_id
  where la.application_number = p_app_number and la.verification_token = p_token;
$$;
revoke all on function public.get_application_verification(text,text) from public;
grant execute on function public.get_application_verification(text,text) to authenticated, anon;
