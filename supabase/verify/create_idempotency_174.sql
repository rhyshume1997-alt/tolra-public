-- Read-only verification for release 174 (CR-010, CR-011, CR-012, CR-013, CR-020: creation idempotency).
-- Inputs: none. Outputs: one row per check (check_name, ok). Every row should be TRUE after 174 is applied.
SELECT 'all 5 target tables have nullable request_id uuid column' AS check_name,
       (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('quotes', 'invoices', 'sales_orders', 'purchase_orders', 'jobs')
          AND column_name = 'request_id'
          AND data_type = 'uuid'
          AND is_nullable = 'YES') = 5 AS ok
UNION ALL
SELECT 'all 5 partial unique indexes on (organization_id, request_id) exist',
       (SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'quotes_org_request_uniq',
            'invoices_org_request_uniq',
            'sales_orders_org_request_uniq',
            'purchase_orders_org_request_uniq',
            'jobs_org_request_uniq'
          )
          AND indexdef LIKE '%UNIQUE INDEX%'
          AND indexdef LIKE '%WHERE (request_id IS NOT NULL)%') = 5
UNION ALL
SELECT 'all 5 request_id immutability triggers are enabled',
       (SELECT count(*) FROM pg_trigger t
        WHERE t.tgname IN (
          'quotes_request_id_immutable',
          'invoices_request_id_immutable',
          'sales_orders_request_id_immutable',
          'purchase_orders_request_id_immutable',
          'jobs_request_id_immutable'
        )
          AND t.tgenabled = 'O'
          AND t.tgfoid = to_regprocedure('public.create_request_id_immutable()')) = 5
UNION ALL
SELECT 'create_request_id_immutable trigger function revokes PUBLIC, anon, authenticated',
       to_regprocedure('public.create_request_id_immutable()') IS NOT NULL
       AND NOT has_function_privilege('public', to_regprocedure('public.create_request_id_immutable()'), 'EXECUTE')
       AND NOT has_function_privilege('anon', to_regprocedure('public.create_request_id_immutable()'), 'EXECUTE')
       AND NOT has_function_privilege('authenticated', to_regprocedure('public.create_request_id_immutable()'), 'EXECUTE')
UNION ALL
SELECT 'all 4 idempotent create RPCs exist with pinned search_path and authenticated-only EXECUTE',
       (SELECT count(*) FROM pg_proc p
        WHERE p.oid IN (
          to_regprocedure('public.create_with_lines_idempotent(uuid,text,jsonb,text,text,jsonb)'),
          to_regprocedure('public.create_sales_order_idempotent(uuid,jsonb)'),
          to_regprocedure('public.create_purchase_order_idempotent(uuid,jsonb)'),
          to_regprocedure('public.create_job_idempotent(uuid,text,text,boolean,uuid,date,jsonb,boolean,jsonb,text)')
        )
          AND p.proconfig = ARRAY['search_path=pg_catalog, public']
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('public', p.oid, 'EXECUTE')) = 4;
