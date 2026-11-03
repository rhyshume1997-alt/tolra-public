-- Read only: every row must be true before configuring credentials.
SELECT '144 ready service-only' AS check_name,
 to_regprocedure('public.accounting_cloud_connections_ready()') IS NOT NULL
 AND has_function_privilege('service_role','public.accounting_cloud_connections_ready()','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.accounting_cloud_connections_ready()','EXECUTE') AS ok
UNION ALL SELECT '144 sends Xero only', position('c.provider = ''xero''' IN pg_get_functiondef('public.accounting_cloud_enqueue()'::regprocedure)) > 0
UNION ALL SELECT '144 document trigger targets', count(*) = 2 FROM pg_trigger
 WHERE tgname = 'zz_integration_enqueue' AND NOT tgisinternal
 AND tgrelid IN ('public.invoices'::regclass, 'public.credit_notes'::regclass)
 AND tgfoid = 'public.accounting_cloud_enqueue()'::regprocedure
UNION ALL SELECT '084 enqueue body preserved', md5(regexp_replace(prosrc, '\s', '', 'g')) = '26bba3708dd4f02328376e1cd632f7d0'
 FROM pg_proc WHERE oid = 'public.integration_enqueue()'::regprocedure
UNION ALL SELECT '144 provider checks', count(*) = 3 FROM pg_constraint
 WHERE conname IN ('integration_connections_provider_check','integration_secrets_provider_check','integration_oauth_states_provider_check')
 AND pg_get_constraintdef(oid) LIKE '%sage%' AND pg_get_constraintdef(oid) LIKE '%quickbooks%';
