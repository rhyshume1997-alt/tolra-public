-- Migration 100 (customers can be archived; a used customer can't be deleted). Read only: every row should be TRUE (6). Bodies are
-- compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_archive_state(text,uuid,text)')
)
-- set_archive_state: 028's body with 'customers' added; definer, 028's search_path.
SELECT 'set_archive_state_is_100' AS check_name,
       coalesce((SELECT body = '0b3bc80a57f0e0e16e4f0d7f42c5eccf' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM fn), FALSE) AS ok
-- Signed-in only (as 028): authenticated may call it; anon and PUBLIC may not.
UNION ALL SELECT 'set_archive_state_signed_in_only',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn), FALSE)
-- record_archive_state accepts customers alongside 028's six tables.
UNION ALL SELECT 'record_archive_state_accepts_customers',
  EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.record_archive_state'::regclass AND c.conname = 'record_archive_state_record_table_check'
            AND pg_get_constraintdef(c.oid) = 'CHECK ((record_table = ANY (ARRAY[''jobs''::text, ''quotes''::text, ''invoices''::text, ''purchase_orders''::text, ''sales_orders''::text, ''delivery_notes''::text, ''customers''::text])))')
-- record_archive_state keeps 028's rules: row security on, readable by signed-in members, writable only through the function.
UNION ALL SELECT 'record_archive_state_read_only_for_members',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.record_archive_state'::regclass)
  AND has_table_privilege('authenticated', 'public.record_archive_state', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.record_archive_state', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.record_archive_state', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.record_archive_state', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.record_archive_state', 'SELECT')
-- A used customer can't be deleted or renamed by a signed-in user (082's guard, unchanged).
UNION ALL SELECT 'customers_in_use_guard_on_delete',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.customers'::regclass AND tgname = 'customers_in_use_guard' AND tgenabled = 'O'
            AND tgfoid = to_regprocedure('public.customers_in_use_guard()') AND (tgtype & 8) = 8)
-- The customer row is never changed by archiving: set_archive_state writes only record_archive_state.
UNION ALL SELECT 'set_archive_state_writes_only_archive_state',
  coalesce((SELECT position('UPDATEpublic.customers' IN regexp_replace(p.prosrc, '\s', '', 'g')) = 0
              AND position('INSERTINTOpublic.record_archive_state' IN regexp_replace(p.prosrc, '\s', '', 'g')) > 0
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_archive_state(text,uuid,text)')), FALSE);
