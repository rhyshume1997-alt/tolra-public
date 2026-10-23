-- READ ONLY. Migration 058 (quote accepted -> sales order -> job, automatic): run in a read-only transaction AFTER applying 058. Changes
-- nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 11 must be "true". Row 2 is also the pre-flight check: run it BEFORE 058 too; when a
-- quote has more than one sales order its value is "false: " and the quotes and their orders (058 refuses to apply until they are
-- resolved). Rows 12 to 14 are informational (counts; no expected value).
WITH
fn AS (SELECT p.proname, p.prosecdef, p.proconfig, p.proacl, p.oid, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
dupes AS (
  SELECT s.organization_id, s.quote_id, max(q.quote_ref) AS quote_ref, count(*) AS n, string_agg(s.so_number, ', ' ORDER BY s.created_at, s.id) AS orders
  FROM public.sales_orders s LEFT JOIN public.quotes q ON q.id = s.quote_id
  WHERE s.quote_id IS NOT NULL
  GROUP BY s.organization_id, s.quote_id
  HAVING count(*) > 1
)
SELECT * FROM (
  SELECT 1 AS n, 'One sales order per quote: unique partial index sales_orders_one_per_quote (organization_id, quote_id) WHERE quote_id IS NOT NULL' AS check_name,
      (SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'sales_orders' AND indexname = 'sales_orders_one_per_quote'
         AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef ILIKE '%(organization_id, quote_id)%' AND indexdef ILIKE '%quote_id IS NOT NULL%')::text AS value,
      'true' AS expected
  UNION ALL SELECT 2, 'The data: no quote has more than one sales order (otherwise: each such quote and its orders)',
      CASE WHEN NOT EXISTS (SELECT 1 FROM dupes) THEN 'true'
           ELSE 'false: ' || (SELECT string_agg(d.organization_id::text || ' quote ' || coalesce(d.quote_ref, d.quote_id::text) || ' (' || d.n || ' orders: ' || d.orders || ')', '; ') FROM dupes d) END,
      'true'
  UNION ALL SELECT 3, 'organization_settings.auto_convert_sales_orders: boolean, NOT NULL, default true',
      (SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organization_settings' AND column_name = 'auto_convert_sales_orders'
         AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true')::text, 'true'
  UNION ALL SELECT 4, 'Only an admin changes it: organization_settings_guard_nav checks auto_convert_sales_orders; set_auto_convert_sales_orders is SECURITY DEFINER, pinned search_path, second step, admin only, authenticated (not anon, not PUBLIC)',
      ((SELECT count(*) = 1 AND bool_and(position('auto_convert_sales_orders' IN prosrc) > 0) FROM fn WHERE proname = 'organization_settings_guard_nav')
       AND (SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') AND bool_and(position('assert_privileged_aal' IN prosrc) > 0)
              AND bool_and(position('has_org_role(ARRAY[''admin''])' IN prosrc) > 0)
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND NOT bool_or(EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
            FROM fn WHERE proname = 'set_auto_convert_sales_orders'))::text, 'true'
  -- 068 replaces accept_quote(uuid, text, date) by accept_quote(uuid, text, date, uuid[]) (p_lines DEFAULT NULL; three-argument calls
  -- unchanged). Either form passes, but exactly one accept_quote may exist, and every property below is checked on it.
  UNION ALL SELECT 5, 'accept_quote(uuid, text, date) (068: plus p_lines uuid[]; the only accept_quote): SECURITY DEFINER, pinned search_path, second step first, admin or office, caller''s company, quote row locked, makes the order through create_sales_order_from_quote and the job through convert_sales_order; authenticated only',
      (SELECT count(*) = 1 AND (SELECT count(*) FROM fn f2 WHERE f2.proname = 'accept_quote') = 1
              AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%')
              AND bool_and(prosrc ~ 'BEGIN\s+PERFORM public\.assert_privileged_aal\(\);')
              AND bool_and(position('current_user_organization_id()' IN prosrc) > 0) AND bool_and(position('has_org_role(ARRAY[''admin'', ''office''])' IN prosrc) > 0)
              AND bool_and(prosrc ~ 'FOR UPDATE') AND bool_and(position('create_sales_order_from_quote' IN prosrc) > 0) AND bool_and(position('convert_sales_order' IN prosrc) > 0)
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND NOT bool_or(EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
       FROM fn WHERE proname = 'accept_quote'
         AND pg_get_function_identity_arguments(oid) IN ('p_quote uuid, p_customer_po text, p_delivery_date date', 'p_quote uuid, p_customer_po text, p_delivery_date date, p_lines uuid[]'))::text, 'true'
  UNION ALL SELECT 6, 'create_sales_order_from_quote is internal: SECURITY DEFINER, pinned search_path, and no API role (authenticated, anon, PUBLIC) may call it',
      (SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%')
              AND NOT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE'))
              AND NOT bool_or(EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
       FROM fn WHERE proname = 'create_sales_order_from_quote')::text, 'true'
  UNION ALL SELECT 7, 'set_sales_order_customer_po: SECURITY DEFINER, pinned search_path, second step first, admin or office, authenticated only',
      (SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') AND bool_and(prosrc ~ 'BEGIN\s+PERFORM public\.assert_privileged_aal\(\);')
              AND bool_and(position('has_org_role(ARRAY[''admin'', ''office''])' IN prosrc) > 0)
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND NOT bool_or(EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
       FROM fn WHERE proname = 'set_sales_order_customer_po')::text, 'true'
  UNION ALL SELECT 8, 'convert_sales_order gives the job the order''s customer_po (not its so_number), still carries the machines and checks the second step',
      (SELECT count(*) = 1 AND bool_and(position('btrim(coalesce(v_order.customer_po' IN prosrc) > 0)
              AND bool_and(position('v_order.so_number, nullif(v_quote' IN prosrc) = 0)
              AND bool_and(position('carry_so_machines' IN prosrc) > 0) AND bool_and(position('assert_privileged_aal' IN prosrc) > 0)
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
       FROM fn WHERE proname = 'convert_sales_order')::text, 'true'
  UNION ALL SELECT 9, 'next_doc_number hands out SO numbers (and still every earlier prefix)',
      (SELECT count(*) = 1 AND bool_and(prosrc LIKE '%''QUO'', ''INV'', ''J'', ''PO'', ''RFQ'', ''DLN'', ''CN'', ''SO''%') AND bool_and(prosrc LIKE '%WHEN ''SO''  THEN EXISTS%')
       FROM fn WHERE proname = 'next_doc_number')::text, 'true'
  UNION ALL SELECT 10, 'Every SECURITY DEFINER function 058 adds has a pinned search_path (accept_quote, create_sales_order_from_quote, set_sales_order_customer_po, set_auto_convert_sales_orders)',
      (SELECT count(*) = 4 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') FROM fn
       WHERE proname IN ('accept_quote', 'create_sales_order_from_quote', 'set_sales_order_customer_po', 'set_auto_convert_sales_orders'))::text, 'true'
  UNION ALL SELECT 11, 'The data: every sales order linked to a quote is in its quote''s company, and every job made from an order is in the order''s company',
      ((SELECT count(*) = 0 FROM public.sales_orders s JOIN public.quotes q ON q.id = s.quote_id WHERE q.organization_id <> s.organization_id)
       AND (SELECT count(*) = 0 FROM public.jobs j JOIN public.sales_orders s ON s.id = j.converted_from_sales_order_id WHERE j.organization_id <> s.organization_id))::text, 'true'
  UNION ALL SELECT 12, 'Informational: accepted quotes with no sales order yet (accepted by an earlier build, or terms refused: entered by hand or accept_quote retried)',
      (SELECT count(*) FROM public.quotes q WHERE q.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM public.sales_orders s WHERE s.quote_id = q.id))::text, 'count'
  UNION ALL SELECT 13, 'Informational: open sales orders with a provisional number (no customer PO yet)',
      (SELECT count(*) FROM public.sales_orders s WHERE s.customer_po IS NULL AND s.so_number ~ '^SO-\d+$')::text, 'count'
  UNION ALL SELECT 14, 'Informational: orders not yet converted with no customer_po but a typed number (imported orders): their job gets no customer PO until "Add customer PO"',
      (SELECT count(*) FROM public.sales_orders s WHERE s.customer_po IS NULL AND s.so_number !~ '^SO-\d+$' AND s.converted_to_job_id IS NULL AND s.status NOT IN ('converted', 'closed'))::text, 'count'
) r ORDER BY n;
