-- Migration 088 (a converted sales order's value and VAT are its job's: a signed-in change of total_value, vat_enabled, vat_pct or
-- vat_exempt is refused once the order is converted, and so is a signed-in clear or change of a job's link to an order that exists). Read only: every row should be TRUE. Bodies are compared with every whitespace
-- character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.sales_orders_converted_money_guard()')
),
jf AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_converted_order_link_guard()')
),
jtrg AS (
  SELECT t.tgname, t.tgfoid, t.tgenabled, t.tgtype, t.tgattr
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'zz_converted_order_link'
),
trg AS (
  SELECT t.tgname, t.tgfoid, t.tgenabled, t.tgtype, t.tgattr
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.sales_orders'::regclass AND t.tgname = 'zz_converted_order_money'
)
SELECT 'guard_is_088' AS check_name,
       coalesce((SELECT body = '6ef7d52b93dee149a290afec414ada86' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM f), FALSE) AS ok
-- A trigger function: nobody calls it from the API.
UNION ALL SELECT 'guard_not_callable_from_api',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM f), FALSE)
-- On sales_orders, enabled, BEFORE UPDATE FOR EACH ROW (tgtype 19 = ROW | BEFORE | UPDATE), on exactly the four money / VAT columns.
UNION ALL SELECT 'trigger_on_sales_orders',
  coalesce((SELECT tgfoid = to_regprocedure('public.sales_orders_converted_money_guard()') AND tgenabled = 'O' AND tgtype = 19 FROM trg), FALSE)
UNION ALL SELECT 'trigger_columns_money_and_vat',
  coalesce((SELECT array_agg(a.attname::TEXT ORDER BY a.attname) = ARRAY['total_value', 'vat_enabled', 'vat_exempt', 'vat_pct']
            FROM trg CROSS JOIN LATERAL unnest(trg.tgattr::INT2[]) AS k(attnum)
            JOIN pg_attribute a ON a.attrelid = 'public.sales_orders'::regclass AND a.attnum = k.attnum), FALSE)
-- The job's side of the link: the same checks for jobs_converted_order_link_guard and its trigger on exactly converted_from_sales_order_id.
UNION ALL SELECT 'job_link_guard_is_088',
  coalesce((SELECT body = 'b81e2cea3f3051325c67bf065858b437' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM jf), FALSE)
UNION ALL SELECT 'job_link_guard_not_callable_from_api',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM jf), FALSE)
UNION ALL SELECT 'trigger_on_jobs',
  coalesce((SELECT tgfoid = to_regprocedure('public.jobs_converted_order_link_guard()') AND tgenabled = 'O' AND tgtype = 19 FROM jtrg), FALSE)
UNION ALL SELECT 'trigger_column_job_link',
  coalesce((SELECT array_agg(a.attname::TEXT ORDER BY a.attname) = ARRAY['converted_from_sales_order_id']
            FROM jtrg CROSS JOIN LATERAL unnest(jtrg.tgattr::INT2[]) AS k(attnum)
            JOIN pg_attribute a ON a.attrelid = 'public.jobs'::regclass AND a.attnum = k.attnum), FALSE)
-- 088 changes no policy or grant: admin and office still update sales orders (the check is the trigger, not RLS).
UNION ALL SELECT 'update_policy_unchanged',
  (SELECT count(*) = 1 FROM pg_policy p WHERE p.polrelid = 'public.sales_orders'::regclass AND p.polname = 'sales_orders rbac update'
     AND pg_get_expr(p.polqual, p.polrelid) LIKE '%ARRAY[''admin''::text, ''office''::text]%');
