-- Migration 134 (the job sheet names the customer's PO, not the sales order). Read only: every row should be TRUE (3). Bodies are compared
-- with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.convert_sales_order(uuid)')
)
-- convert_sales_order: 134's body ('Customer PO <po>' and the job's customer_po from the order or else its quote; no PO: as before).
SELECT 'convert_sales_order_is_134' AS check_name,
  coalesce((SELECT body = '5c32fec88493cce71da2cd55f83ff7b4' FROM fn), FALSE) AS ok
-- Exactly one convert_sales_order.
UNION ALL SELECT 'one_signature',
  (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'convert_sales_order')
-- Invoker (as 080), volatile, the pinned search_path, signed-in only (authenticated may; anon and PUBLIC may not).
UNION ALL SELECT 'invoker_pinned_signed_in_only',
  coalesce((SELECT NOT prosecdef AND provolatile = 'v' AND proconfig = ARRAY['search_path=pg_catalog, public']
            AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
   FROM fn), FALSE);
