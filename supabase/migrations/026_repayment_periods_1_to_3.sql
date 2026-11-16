-- OGESEOUS: repayment periods of 1, 2 and 3 months.
-- Historical migrations remain unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.allowed_repayment_months()
RETURNS integer[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    array_agg(n ORDER BY n),
    ARRAY[]::integer[]
  )
  FROM (
    SELECT DISTINCT trim(x)::integer AS n
    FROM unnest(
      string_to_array(
        (
          SELECT value
          FROM public.app_settings
          WHERE key = 'allowed_repayment_months'
        ),
        ','
      )
    ) AS t(x)
    WHERE trim(x) ~ '^[0-9]{1,3}$'
      AND trim(x)::integer BETWEEN 1 AND 120
  ) AS valid_periods;
$$;

INSERT INTO public.app_settings (key, value)
VALUES ('allowed_repayment_months', '1,2,3')
ON CONFLICT (key)
DO UPDATE SET value = EXCLUDED.value;

-- The previous policy allowed 6, 12, 18 and 24 months.
-- Historical applications must be preserved.
-- Existing rows are not deleted or rewritten.
ALTER TABLE public.loan_applications
DROP CONSTRAINT IF EXISTS loan_applications_repayment_period_months_check;

ALTER TABLE public.loan_applications
ADD CONSTRAINT loan_applications_repayment_period_months_check
CHECK (
  repayment_period_months IN (1, 2, 3)
);

COMMIT;
