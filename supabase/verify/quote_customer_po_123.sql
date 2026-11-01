-- Migration 123 (the customer's PO on the quote). Read only: every row should be TRUE (6). Bodies are compared with every whitespace
-- character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.quote_lifecycle_guard()'), to_regprocedure('public.create_sales_order_from_quote(uuid, text, date)'),
                  to_regprocedure('public.revise_quote(uuid)'), to_regprocedure('public.set_quote_customer_po(uuid, text)'))
)
-- quotes.customer_po: nullable text, with its check (trimmed, 1 to 100 characters).
SELECT 'quotes_customer_po_column' AS check_name,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quotes' AND column_name = 'customer_po'
            AND data_type = 'text' AND is_nullable = 'YES')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.quotes'::regclass AND c.conname = 'quotes_customer_po_check' AND c.contype = 'c') AS ok
-- The guard: 123's body (076's plus the customer-PO pass for set_quote_customer_po), invoker, its trigger enabled.
UNION ALL SELECT 'lifecycle_guard_is_123',
  coalesce((SELECT body = '3c01d528076221cdac11c72f7327ab02' AND NOT prosecdef FROM fn WHERE proname = 'quote_lifecycle_guard'), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quote_lifecycle_guard' AND tgenabled = 'O')
-- create_sales_order_from_quote: 123's body; internal (no API role may call it), definer, pinned.
UNION ALL SELECT 'order_from_quote_is_123_internal',
  coalesce((SELECT body = 'a5371d31fde32e60ed7b2a23f40f1935' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            FROM fn WHERE proname = 'create_sales_order_from_quote'), FALSE)
-- revise_quote: 123's body (keeps the PO), definer, pinned, signed-in only.
UNION ALL SELECT 'revise_quote_is_123',
  coalesce((SELECT body = 'dd78b559c44bf1effdc7e61109e1500c' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            FROM fn WHERE proname = 'revise_quote'), FALSE)
-- set_quote_customer_po: 123's body, definer, pinned, second step first, signed-in only (not anon, not PUBLIC).
UNION ALL SELECT 'set_quote_customer_po_definer_signed_in_only',
  coalesce((SELECT body = '00f8488bd689f3e473209d520218d402' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = 'set_quote_customer_po'), FALSE)
  AND (SELECT prosrc ~ 'BEGIN\s+PERFORM public\.assert_privileged_aal\(\);' FROM pg_proc WHERE oid = to_regprocedure('public.set_quote_customer_po(uuid, text)'))
-- Existing rows: 123 sets no customer PO on any quote (only users do, afterwards); a PO is never blank or padded.
UNION ALL SELECT 'quote_pos_well_formed',
  NOT EXISTS (SELECT 1 FROM public.quotes WHERE customer_po IS NOT NULL AND (customer_po <> btrim(customer_po) OR customer_po = '' OR char_length(customer_po) > 100));
