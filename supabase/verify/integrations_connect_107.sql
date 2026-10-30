-- Migration 107 (integrations connect: Microsoft 365, app-level credentials, the accountant's link). Read only: every row should be TRUE (11).
-- Nothing here reads a secret, a token or a token hash.
WITH t AS (
  SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c
  WHERE c.oid IN (to_regclass('public.integration_app_credentials'), to_regclass('public.integration_connect_invites'))
), signed_in AS (
  SELECT p.oid, p.prosecdef, p.proconfig FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.integration_oauth_start(text,text,text)'), to_regprocedure('public.integration_invite_create(text,text)'),
                  to_regprocedure('public.integration_invites_open(text)'), to_regprocedure('public.integration_invite_revoke(uuid)'),
                  to_regprocedure('public.integration_disconnect_revoke(text)'),
                  to_regprocedure('public.integration_app_credentials_save(text,text,text,text,text,integer)'),
                  to_regprocedure('public.integration_app_credentials_remove(text)'), to_regprocedure('public.integration_app_credentials_list()'))
), server_only AS (
  SELECT p.oid, p.prosecdef, p.proconfig FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.integration_invite_peek(text)'), to_regprocedure('public.integration_invite_redeem(text,text,text)'),
                  to_regprocedure('public.integration_oauth_consume_invite(text,text)'))
)
-- Both new tables exist with row level security on.
SELECT 'two_tables_rls_on' AS check_name, (SELECT count(*) = 2 AND bool_and(relrowsecurity) FROM t) AS ok
-- Neither is readable or writable through the API (no grant to anon or authenticated, no policy).
UNION ALL SELECT 'no_api_access',
  (SELECT bool_and(NOT has_table_privilege('authenticated', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
                   AND NOT has_table_privilege('anon', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) FROM t)
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN ('integration_app_credentials', 'integration_connect_invites'))
-- The support read-only and admin two-step guards on both; no row audit (no ciphertext or token hash in the audit log).
UNION ALL SELECT 'guards_no_row_audit',
  (SELECT count(*) = 4 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT oid FROM t) AND g.tgname IN ('support_read_only', 'admin_mfa'))
  AND (SELECT count(*) = 4 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT oid FROM t))
-- The client secret is ciphertext only.
UNION ALL SELECT 'app_secret_ciphertext_only',
  EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.integration_app_credentials') AND c.conname = 'integration_app_credentials_secret_enc'
            AND pg_get_constraintdef(c.oid) LIKE '%^v[0-9]{1,3}%')
-- The invite keeps a SHA-256 only, is unique, and lasts at most 24 hours.
UNION ALL SELECT 'invite_hash_unique_24h',
  EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.integration_connect_invites') AND c.conname = 'integration_connect_invites_token_hash'
            AND pg_get_constraintdef(c.oid) LIKE '%[0-9a-f]{64}%')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.integration_connect_invites') AND c.conname = 'integration_connect_invites_token_key' AND c.contype = 'u')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.integration_connect_invites') AND c.conname = 'integration_connect_invites_24h'
            AND pg_get_constraintdef(c.oid) LIKE '%24:00:00%')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'integration_connect_invites' AND column_name = 'token')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'integration_connect_invites' AND column_name = 'revoked_at')
-- An OAuth state may carry the invite it came from.
UNION ALL SELECT 'oauth_state_via_invite',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'integration_oauth_states' AND column_name = 'via_invite')
-- Microsoft 365 is a provider for connections, secrets and OAuth states; the send log, mappings and contacts stay Xero only.
UNION ALL SELECT 'microsoft_provider_where_needed',
  (SELECT count(*) = 3 FROM pg_constraint c WHERE c.contype = 'c'
     AND c.conname IN ('integration_connections_provider_check', 'integration_secrets_provider_check', 'integration_oauth_states_provider_check')
     AND pg_get_constraintdef(c.oid) LIKE '%microsoft%')
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'c' AND c.conrelid IN (to_regclass('public.integration_sends'), to_regclass('public.integration_mappings'), to_regclass('public.integration_contacts'))
                    AND pg_get_constraintdef(c.oid) LIKE '%microsoft%')
-- A send row for any provider but Xero is dropped before it is stored.
UNION ALL SELECT 'send_log_accounting_only',
  EXISTS (SELECT 1 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgname = 'aa_integration_sends_accounting_only' AND g.tgrelid = to_regclass('public.integration_sends')
            AND g.tgfoid = to_regprocedure('public.integration_sends_accounting_only()') AND g.tgenabled = 'O')
  AND NOT has_function_privilege('authenticated', 'public.integration_sends_accounting_only()', 'EXECUTE')
-- The eight signed-in functions: definer, pinned search_path, signed-in only.
UNION ALL SELECT 'signed_in_functions',
  (SELECT count(*) = 8 AND bool_and(prosecdef AND proconfig IS NOT NULL AND has_function_privilege('authenticated', oid, 'EXECUTE')
                                    AND NOT has_function_privilege('anon', oid, 'EXECUTE')) FROM signed_in)
-- The three server functions: the service role only.
UNION ALL SELECT 'server_functions_service_role_only',
  (SELECT count(*) = 3 AND bool_and(prosecdef AND proconfig IS NOT NULL AND has_function_privilege('service_role', oid, 'EXECUTE')
                                    AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) FROM server_only)
-- No secret, token or token hash in the audit log.
UNION ALL SELECT 'no_secret_in_audit_log',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.entity_table IN ('integration_app_credentials', 'integration_connect_invites')
                AND (a.metadata ? 'client_secret_enc' OR a.metadata ? 'token_hash' OR a.metadata ? 'client_secret'));
