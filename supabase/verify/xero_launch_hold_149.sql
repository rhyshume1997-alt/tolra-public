-- Catalogue checks; zero enabled rows is a launch acceptance check, not a permanent invariant after approved activation.
SELECT 'default_off' AS requirement, column_default='false' AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='integration_connections' AND column_name='transfers_enabled'
UNION ALL SELECT 'queue_guard',EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='xero_queue_launch_hold' AND NOT tgisinternal)
UNION ALL SELECT 'claim_guard',position('launch_hold' in pg_get_functiondef('public.integration_claim_next(uuid,text,integer,text,uuid)'::regprocedure))>0
UNION ALL SELECT 'retry_guard',position('xero_launch_hold' in pg_get_functiondef('public.integration_retry_send(uuid)'::regprocedure))>0
UNION ALL SELECT 'anon_cannot_enable',NOT has_function_privilege('anon','public.integration_xero_set_transfers(boolean)','EXECUTE')
UNION ALL SELECT 'client_cannot_query_foreign_gate',NOT has_function_privilege('authenticated','public.integration_xero_transfer_enabled(uuid)','EXECUTE');
