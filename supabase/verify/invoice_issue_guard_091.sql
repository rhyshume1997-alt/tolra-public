-- Migration 091 (a draft invoice is issued only by issue_invoice: never by editing its status or number). Read only: every row should be
-- TRUE. Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_issue_guard()')
),
iss AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.issue_invoice(uuid)')
),
trg AS (
  SELECT t.tgname, t.tgfoid, t.tgenabled, t.tgtype, t.tgattr
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'zz_invoice_via_issue'
)
SELECT 'guard_is_091' AS check_name,
       coalesce((SELECT body = 'a601d6b3464100729d4c9b5055d6633e' AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM f), FALSE) AS ok
-- A trigger function: nobody calls it from the API.
UNION ALL SELECT 'guard_not_callable_from_api',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM f), FALSE)
-- issue_invoice is 034's plus the quoteflow.invoice_issue setting; still the caller's (invoker), still callable by authenticated only.
UNION ALL SELECT 'issue_invoice_is_091',
  coalesce((SELECT body = 'ee9b9005e060379ce9dcc8e45a7afd42' AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
              AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM iss), FALSE)
-- On invoices, enabled, BEFORE UPDATE FOR EACH ROW (tgtype 19 = ROW | BEFORE | UPDATE).
UNION ALL SELECT 'trigger_on_invoices',
  coalesce((SELECT tgfoid = to_regprocedure('public.invoice_issue_guard()') AND tgenabled = 'O' AND tgtype = 19 FROM trg), FALSE)
-- Its UPDATE fires on exactly the status, the number and the issue stamp.
UNION ALL SELECT 'trigger_columns_status_ref_issue_stamp',
  coalesce((SELECT array_agg(a.attname::TEXT ORDER BY a.attname) = ARRAY['invoice_ref', 'issued_at', 'issued_by', 'status']
            FROM trg CROSS JOIN LATERAL unnest(trg.tgattr::INT2[]) AS k(attnum)
            JOIN pg_attribute a ON a.attrelid = 'public.invoices'::regclass AND a.attnum = k.attnum), FALSE)
-- 027's check that a non-draft has a number is still there (091 leaves a move with no number to it).
UNION ALL SELECT 'issued_have_number_still_there',
  (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = 'public.invoices'::regclass AND c.conname = 'invoices_issued_have_number' AND c.contype = 'c')
-- 091 changes no policy or grant: admin and office still update invoices (the check is the trigger, not RLS).
UNION ALL SELECT 'update_policy_unchanged',
  (SELECT count(*) = 1 FROM pg_policy p WHERE p.polrelid = 'public.invoices'::regclass AND p.polname = 'invoices rbac update'
     AND pg_get_expr(p.polqual, p.polrelid) LIKE '%ARRAY[''admin''::text, ''office''::text]%');
