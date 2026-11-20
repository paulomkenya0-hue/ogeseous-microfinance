-- Security hotfix: students must never self-delete their authentication identity.
-- No existing financial or application records are modified.
-- Administrative account closure must use a separate, audited staff workflow.
create or replace function public.delete_my_account()
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'Self-service account deletion is disabled. Contact OGESEOUS management.'
    using errcode = '42501';
end;
$$;

revoke all on function public.delete_my_account() from public, anon, authenticated;
comment on function public.delete_my_account() is
  'Disabled: account deletion requires a manager or super administrator through an audited administrative process.';
