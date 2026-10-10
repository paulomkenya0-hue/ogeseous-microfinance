-- Add the CEO as a distinct staff role. Apply separately from migrations that use the new enum
-- value so PostgreSQL can commit the enum change before the value is referenced.
alter type public.user_role add value if not exists 'CEO';
