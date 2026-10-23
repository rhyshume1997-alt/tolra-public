-- Migration 072 (customer sign-off on jobs). Read only: every readiness row should be TRUE.
-- The second query lists the companies that have the setting on and how many customer sign-offs each has (none right after apply:
-- 072 switches no company on). Nothing is changed.
SELECT 'setting_column' AS check_name, EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'organization_settings' AND column_name = 'customer_signoff_enabled'
    AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false'
) AS ok
UNION ALL SELECT 'setting_guard_trigger', EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organization_settings'::regclass
    AND tgname = 'organization_settings_customer_signoff_guard' AND tgenabled = 'O'
)
UNION ALL SELECT 'customer_columns', (
  SELECT count(*) = 7 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'job_signoffs'
    AND column_name IN ('signer_position', 'signer_company', 'statement', 'customer_comment', 'device_signed_at', 'shown_worksheet_version', 'shown_snapshot_sha256')
)
UNION ALL SELECT 'kind_allows_customer', EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_signoffs'::regclass AND conname = 'job_signoffs_kind_check' AND convalidated
    AND pg_get_constraintdef(oid) LIKE '%''primary''%''inspector''%''customer''%'
)
UNION ALL SELECT 'customer_shape_check', EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_signoffs'::regclass AND conname = 'job_signoffs_customer_shape' AND convalidated
    AND pg_get_constraintdef(oid) LIKE '%isfinite(device_signed_at)%'
)
-- The phone's time: finite (above) and within 30 days before to 1 day after the row arrived.
UNION ALL SELECT 'device_time_window', EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_signoffs'::regclass AND conname = 'job_signoffs_device_time_window' AND convalidated
) AND NOT EXISTS (
  SELECT 1 FROM public.job_signoffs WHERE kind = 'customer'
    AND (NOT isfinite(device_signed_at) OR device_signed_at < created_at - INTERVAL '30 days' OR device_signed_at > created_at + INTERVAL '1 day')
)
-- Still a record: never changed or removed (045's triggers), no API write grant, same-company read only.
UNION ALL SELECT 'record_still_immutable', (
  SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.job_signoffs'::regclass AND tgname IN ('job_signoffs_immutable', 'job_signoffs_no_truncate') AND tgenabled = 'O'
) AND NOT has_table_privilege('authenticated', 'public.job_signoffs', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.job_signoffs', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.job_signoffs', 'DELETE') AND NOT has_table_privilege('anon', 'public.job_signoffs', 'SELECT')
UNION ALL SELECT 'functions_for_signed_in_only', (
  SELECT bool_and(p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
  FROM pg_proc p WHERE p.oid IN ('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)'::regprocedure,
                                 'public.set_customer_signoff_enabled(boolean)'::regprocedure)
)
UNION ALL SELECT 'guard_internal', NOT has_function_privilege('authenticated', 'public.organization_settings_customer_signoff_guard()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.organization_settings_customer_signoff_guard()', 'EXECUTE')
-- 045's sign-off function is untouched (one form, 10 arguments) and every earlier row still has no customer field.
UNION ALL SELECT 'operator_signoff_unchanged', to_regprocedure('public.sign_off_job(uuid,integer,text,text,text,date,text,text,text,uuid)') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sign_off_job' AND pronargs <> 10)
  AND NOT EXISTS (SELECT 1 FROM public.job_signoffs WHERE kind <> 'customer' AND (statement IS NOT NULL OR device_signed_at IS NOT NULL));

SELECT o.slug AS company, s.customer_signoff_enabled AS customer_signoff_on,
       (SELECT count(*) FROM public.job_signoffs j WHERE j.organization_id = o.id AND j.kind = 'customer') AS customer_signoffs
FROM public.organization_settings s
JOIN public.organizations o ON o.id = s.organization_id
WHERE s.customer_signoff_enabled OR EXISTS (SELECT 1 FROM public.job_signoffs j WHERE j.organization_id = o.id AND j.kind = 'customer')
ORDER BY o.slug;
