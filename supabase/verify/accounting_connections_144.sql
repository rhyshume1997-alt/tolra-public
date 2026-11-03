-- Read only: every row must be true before configuring credentials.
SELECT '144 ready service-only' AS check_name,
 to_regprocedure('public.accounting_cloud_connections_ready()') IS NOT NULL
 AND has_function_privilege('service_role','public.accounting_cloud_connections_ready()','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.accounting_cloud_connections_ready()','EXECUTE') AS ok
UNION ALL SELECT '144 sends Xero only', position('c.provider = ''xero''' IN pg_get_functiondef('public.integration_enqueue()'::regprocedure)) > 0
UNION ALL SELECT '144 provider checks', count(*) = 3 FROM pg_constraint
 WHERE conname IN ('integration_connections_provider_check','integration_secrets_provider_check','integration_oauth_states_provider_check')
 AND pg_get_constraintdef(oid) LIKE '%sage%' AND pg_get_constraintdef(oid) LIKE '%quickbooks%';
