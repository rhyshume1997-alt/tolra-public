-- Migration 127 (reading the company's own inbox through the delegated Microsoft 365 connection). Read only: every row should be TRUE (7).
-- Nothing here reads a token, a cursor or a message. Bodies are compared with every whitespace character removed (an SQL-editor paste may
-- store CRLF).
WITH fn AS (
  SELECT f.sig, p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) = f.body AS same
  FROM (VALUES ('public.mailbox_sync_connected(uuid,text,boolean)', '157bc48f606d2d36a18cdcef5da067a5', 'server'),
               ('public.mailbox_sync_due(uuid)', 'f166b13165a5e3f45a8ee96ed9563ab2', 'server'),
               ('public.mailbox_sync_result(uuid,text,text,timestamp with time zone)', 'bc91232dd7936719831735c19703274c', 'server'),
               ('public.mailbox_record_inbound(uuid,text,text,text,text,text,timestamp with time zone,text,text)', '4a7ede00d54804941fc17a291bde6b4c', 'server'),
               ('public.mailbox_sync_status()', '2d190567cfe9f2bd8fa6c6d055b7df45', 'signed_in'),
               ('public.mailbox_sync_claim(uuid,integer)', 'a9985b00301c4579f1f6797205c21834', 'server'),
               ('public.mailbox_suggest_email_link(uuid,uuid,text,uuid,text)', '2ad8ea7f269f532b082e3db31e58f7ed', 'server')) AS f(sig, body, who)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
), server_fn AS (
  SELECT * FROM fn WHERE sig <> 'public.mailbox_sync_status()'
)
-- The table exists with row level security on, no policy, and no grant to anon or authenticated.
SELECT 'sync_table_closed' AS check_name,
  coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.integration_mailbox_sync')), FALSE)
  AND NOT has_table_privilege('authenticated', 'public.integration_mailbox_sync', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
  AND NOT has_table_privilege('anon', 'public.integration_mailbox_sync', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'integration_mailbox_sync') AS ok
-- The failure column takes a fixed code only (no free text: never Microsoft's words or a token), and the paging link only Graph's.
UNION ALL SELECT 'error_codes_and_links_only',
  EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass('public.integration_mailbox_sync') AND pg_get_constraintdef(k.oid) LIKE '%last_error%store_failed%')
  AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass('public.integration_mailbox_sync') AND pg_get_constraintdef(k.oid) LIKE '%next_link%https://graph.microsoft.com/v1.0/%')
-- The support read-only and admin two-step guards on it; no row audit.
UNION ALL SELECT 'guards_no_row_audit',
  (SELECT count(*) = 2 AND bool_and(g.tgname IN ('support_read_only', 'admin_mfa')) FROM pg_trigger g
   WHERE NOT g.tgisinternal AND g.tgrelid = to_regclass('public.integration_mailbox_sync'))
-- All seven functions are 127's, definer, search_path pinned.
UNION ALL SELECT 'functions_are_127',
  (SELECT count(*) = 7 AND bool_and(oid IS NOT NULL AND same AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']) FROM fn)
-- The six server functions: the service role's only (not anon, not authenticated, not PUBLIC).
UNION ALL SELECT 'server_functions_service_role_only',
  (SELECT bool_and(oid IS NOT NULL AND has_function_privilege('service_role', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = server_fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
   FROM server_fn)
-- The throttle column is there (mailbox_sync_claim's claimed_at).
UNION ALL SELECT 'throttle_column',
  EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.integration_mailbox_sync') AND a.attname = 'claimed_at' AND NOT a.attisdropped
          AND a.atttypid = 'timestamptz'::regtype)
-- The card's status function: signed in only.
UNION ALL SELECT 'status_signed_in_only',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE sig = 'public.mailbox_sync_status()'), FALSE);
