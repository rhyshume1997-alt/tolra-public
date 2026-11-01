-- Migration 105 (an invoice is written off, and a write-off reversed, only with write_off_invoice / reverse_write_off). Read only: every
-- row should be TRUE. Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.invoices_write_off_guard()'), to_regprocedure('public.write_off_invoice(uuid,text)'),
                                 to_regprocedure('public.reverse_write_off(uuid,text)'))
),
trg AS (
  SELECT t.tgname, t.tgfoid, t.tgenabled, t.tgtype, t.tgattr
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'invoices_write_off_guard'
)
SELECT 'guard_is_105' AS check_name,
       coalesce((SELECT body = '6ec5e742ef64fe23121c8099c42d2200' AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM f WHERE proname = 'invoices_write_off_guard'), FALSE) AS ok
-- A trigger function: nobody calls it from the API.
UNION ALL SELECT 'guard_not_callable_from_api',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM f WHERE proname = 'invoices_write_off_guard'), FALSE)
-- The two steps: 105's bodies, definer, callable by authenticated only.
UNION ALL SELECT 'write_off_invoice_is_105',
  coalesce((SELECT body = 'c7449f4564711533d43a1aa252eddfdf' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
              AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM f WHERE proname = 'write_off_invoice'), FALSE)
UNION ALL SELECT 'reverse_write_off_is_105',
  coalesce((SELECT body = '4750ac042335694164b634edca559f23' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
              AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM f WHERE proname = 'reverse_write_off'), FALSE)
-- On invoices, enabled, BEFORE UPDATE FOR EACH ROW (tgtype 19 = ROW | BEFORE | UPDATE), on the status column only.
UNION ALL SELECT 'trigger_on_invoices_status',
  coalesce((SELECT tgfoid = to_regprocedure('public.invoices_write_off_guard()') AND tgenabled = 'O' AND tgtype = 19
              AND (SELECT array_agg(a.attname::TEXT) FROM unnest(trg.tgattr::INT2[]) AS k(attnum)
                   JOIN pg_attribute a ON a.attrelid = 'public.invoices'::regclass AND a.attnum = k.attnum) = ARRAY['status'] FROM trg), FALSE)
-- 105 changes no policy: admin and office still update invoices (the check is the trigger, not RLS).
UNION ALL SELECT 'update_policy_unchanged',
  (SELECT count(*) = 1 FROM pg_policy p WHERE p.polrelid = 'public.invoices'::regclass AND p.polname = 'invoices rbac update'
     AND pg_get_expr(p.polqual, p.polrelid) LIKE '%ARRAY[''admin''::text, ''office''::text]%');
