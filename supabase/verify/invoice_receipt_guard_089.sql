-- Migration 089 (an invoice's receipts change only through the payment and credit steps, on a draft as on an issued invoice; a draft is
-- issued only when what it shows as paid or credited is what its recorded payments and credits add up to). Read only: every row should
-- be TRUE. Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_receipts_guard()')
),
trg AS (
  SELECT t.tgname, t.tgfoid, t.tgenabled, t.tgtype, t.tgattr
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'zz_invoice_receipts'
)
SELECT 'guard_is_089' AS check_name,
       coalesce((SELECT body = '18851e08d5d58c3bb648bb13e0fe0e22' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM f), FALSE) AS ok
-- A trigger function: nobody calls it from the API.
UNION ALL SELECT 'guard_not_callable_from_api',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM f), FALSE)
-- On invoices, enabled, BEFORE INSERT OR UPDATE FOR EACH ROW (tgtype 23 = ROW | BEFORE | INSERT | UPDATE).
UNION ALL SELECT 'trigger_on_invoices',
  coalesce((SELECT tgfoid = to_regprocedure('public.invoice_receipts_guard()') AND tgenabled = 'O' AND tgtype = 23 FROM trg), FALSE)
-- Its UPDATE fires on exactly the status and the five receipt columns.
UNION ALL SELECT 'trigger_columns_status_and_receipts',
  coalesce((SELECT array_agg(a.attname::TEXT ORDER BY a.attname) = ARRAY['amount_paid', 'credited_amount', 'paid_at', 'payment_unverified', 'refunded_amount', 'status']
            FROM trg CROSS JOIN LATERAL unnest(trg.tgattr::INT2[]) AS k(attnum)
            JOIN pg_attribute a ON a.attrelid = 'public.invoices'::regclass AND a.attnum = k.attnum), FALSE)
-- 076's lock (issued invoices) is still there and still runs before it.
UNION ALL SELECT 'issue_lock_still_first',
  (SELECT count(*) = 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'invoice_issue_lock'
     AND t.tgfoid = 'public.invoice_issue_lock()'::regprocedure AND t.tgenabled = 'O' AND t.tgname < 'zz_invoice_receipts')
-- 089 changes no policy or grant: admin and office still update invoices (the check is the trigger, not RLS).
UNION ALL SELECT 'update_policy_unchanged',
  (SELECT count(*) = 1 FROM pg_policy p WHERE p.polrelid = 'public.invoices'::regclass AND p.polname = 'invoices rbac update'
     AND pg_get_expr(p.polqual, p.polrelid) LIKE '%ARRAY[''admin''::text, ''office''::text]%');
