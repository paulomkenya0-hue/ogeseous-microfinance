-- OGESEOUS MICROFINANCE — Allow authenticated users to query the RUCU register.
-- RLS on rucu_students continues to restrict access to active SUPER_ADMIN/MANAGER
-- through public.is_admin(). Students and ordinary staff cannot read the table.

grant select on table public.rucu_students to authenticated;