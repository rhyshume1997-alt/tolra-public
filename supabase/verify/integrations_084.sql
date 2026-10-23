-- Migration 084 (integrations layer + Xero connect and push, G22). Read only: every row should be TRUE. Bodies are compared with every
-- whitespace character removed (an SQL-editor paste may store CRLF). Nothing here reads a token.
WITH f AS (
  SELECT f.sig, p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) = f.body AS same
  FROM (VALUES ('public.integration_vat_key(boolean,boolean,numeric)', '5888052cf753ac3981ad80ac88a03c2a'),
               ('public.integration_carriage_vat_key(boolean,boolean,numeric)', 'a7a2b19c8f37e3a56171165e565947f3'),
               ('public.integration_document(uuid,text,uuid)', '795a05b1b69e782009016c166ae1f134'),
               ('public.integration_unmapped(uuid,text)', '7a82009695c1f1a79b1df7d68fac724e'),
               ('public.integration_enqueue()', '26bba3708dd4f02328376e1cd632f7d0'),
               ('public.integration_oauth_begin(text,text,text)', '426b80b684e190d212cbdb18d511bd4a'),
               ('public.integration_oauth_consume(uuid,uuid,text,text)', 'f69377561a80fcbc71b8521879226125'),
               ('public.integration_store_connection(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,integer)', 'c3c0d54db277c9a3a2e3db0194570f76'),
               ('public.integration_disconnect(text)', '3a3581322cd57e116908074c2357fda1'),
               ('public.integration_mark_needs_reconnect(uuid,text,text)', 'f4e26e9d96d6c9ff861842876d27cb48'),
               ('public.integration_token_lease(uuid,text,uuid,integer)', 'a2b30349f62887d0155a140308637864'),
               ('public.integration_token_store(uuid,text,uuid,text,text,timestamp with time zone,integer)', 'a2789f9ce27710bf857f5543ac7ada04'),
               ('public.integration_token_release(uuid,text,uuid)', 'abc5577db31577fb09499063eadc294d'),
               ('public.integration_claim_next(uuid,text,integer,text,uuid)', '1e926cf7051cc6614f0cfc6b2124b470'),
               ('public.integration_record_result(uuid,uuid,text,text,text,text,timestamp with time zone)', '8bc5ebfbf2317fe1d461006158326ce8'),
               ('public.integration_set_mapping(text,text,text,text,text)', '52d30fd1c2605d0eccae08d07f71b22a'),
               ('public.integration_retry_send(uuid)', '1e8e2136759e43952aa406f8a6bcac88'),
               ('public.integration_contact_record(uuid,text,text,text,text,text)', 'c501214f478528b3da30c22362766db9'),
               ('public.integration_resolve_contact(text,text,text)', 'f822e371fec0c04762d8a337ffb4f64a'),
               ('public.integration_overview(text)', 'dd5820b12ef24958b5a16cca5a4d36b9')) AS f(sig, body)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
),
signed_in AS (SELECT * FROM f WHERE sig IN ('public.integration_oauth_begin(text,text,text)', 'public.integration_disconnect(text)', 'public.integration_set_mapping(text,text,text,text,text)',
                                           'public.integration_retry_send(uuid)', 'public.integration_resolve_contact(text,text,text)', 'public.integration_overview(text)')),
server_only AS (SELECT * FROM f WHERE sig NOT IN (SELECT sig FROM signed_in)),
t AS (
  SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c
  WHERE c.oid IN (to_regclass('public.integration_connections'), to_regclass('public.integration_secrets'), to_regclass('public.integration_oauth_states'),
                  to_regclass('public.integration_mappings'), to_regclass('public.integration_contacts'), to_regclass('public.integration_sends'))
),
readable AS (SELECT * FROM t WHERE relname IN ('integration_connections', 'integration_mappings', 'integration_contacts', 'integration_sends')),
secret AS (SELECT * FROM t WHERE relname IN ('integration_secrets', 'integration_oauth_states'))
SELECT 'functions_are_084' AS check_name, (SELECT count(*) = 20 AND bool_and(oid IS NOT NULL AND same) FROM f) AS ok
-- Every one of them runs with a fixed search_path.
UNION ALL SELECT 'functions_fixed_search_path', (SELECT bool_and(proconfig IS NOT NULL AND array_to_string(proconfig, ',') LIKE 'search_path=pg_catalog%') FROM f)
-- Signed-in users only: admin (and two-step sign-in) is checked inside, for the caller's own company.
UNION ALL SELECT 'signed_in_functions', (SELECT count(*) = 6 AND bool_and(prosecdef AND has_function_privilege('authenticated', oid, 'EXECUTE')
                                                AND NOT has_function_privilege('anon', oid, 'EXECUTE')) FROM signed_in)
-- The server's own functions (tokens, claim, results, the document) and the internal ones: never callable from the API.
UNION ALL SELECT 'server_functions_not_in_api', (SELECT count(*) = 14 AND bool_and(NOT has_function_privilege('anon', oid, 'EXECUTE')
                                                        AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')) FROM server_only)
UNION ALL SELECT 'server_functions_for_service_role', (SELECT count(*) = 11 AND bool_and(has_function_privilege('service_role', oid, 'EXECUTE')) FROM server_only
                                                       WHERE sig NOT IN ('public.integration_vat_key(boolean,boolean,numeric)', 'public.integration_carriage_vat_key(boolean,boolean,numeric)', 'public.integration_enqueue()'))
-- Six tables, RLS on, no API write, nothing for anon.
UNION ALL SELECT 'tables_rls_no_api_write', (SELECT count(*) = 6 AND bool_and(relrowsecurity AND NOT has_table_privilege('authenticated', oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
                                                  AND NOT has_table_privilege('anon', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) FROM t)
-- The tokens and the OAuth states: no signed-in user reads them, through any path (no grant, no policy).
UNION ALL SELECT 'secrets_unreadable', (SELECT count(*) = 2 AND bool_and(NOT has_table_privilege('authenticated', oid, 'SELECT')) FROM secret)
                                        AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN ('integration_secrets', 'integration_oauth_states'))
-- The other four: the company's admins read them (SELECT only).
UNION ALL SELECT 'readable_by_company_admins_only',
  (SELECT count(*) = 4 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN (SELECT relname FROM readable) AND p.cmd = 'SELECT'
     AND p.roles = '{authenticated}' AND p.qual LIKE '%current_user_organization_id()%' AND p.qual LIKE '%has_org_role(ARRAY[''admin''::text])%')
  AND (SELECT count(*) = 4 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename LIKE 'integration\_%')
  AND (SELECT bool_and(has_table_privilege('authenticated', oid, 'SELECT')) FROM readable)
-- The support read-only and admin two-step guards on all six; row audit on the four readable tables, never on the secrets or states.
UNION ALL SELECT 'guards_on_every_table',
  (SELECT count(*) = 12 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT oid FROM t) AND g.tgname IN ('support_read_only', 'admin_mfa'))
UNION ALL SELECT 'audited_except_secrets',
  (SELECT count(*) = 4 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgfoid = 'security_audit.log_row_change()'::regprocedure AND g.tgrelid IN (SELECT oid FROM readable))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgfoid = 'security_audit.log_row_change()'::regprocedure AND g.tgrelid IN (SELECT oid FROM secret))
-- Tokens are ciphertext only: the CHECK refuses anything else, and every stored value is in that form.
UNION ALL SELECT 'tokens_ciphertext_only',
  (SELECT count(*) = 2 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.integration_secrets') AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%^v[0-9]{1,3}%' AND (pg_get_constraintdef(c.oid) LIKE '%refresh_token_enc%' OR pg_get_constraintdef(c.oid) LIKE '%access_token_enc%'))
UNION ALL SELECT 'no_token_in_audit_log',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.entity_table IN ('integration_secrets', 'integration_oauth_states'))
-- One Tolra company per Xero organisation; each document and action sent once.
UNION ALL SELECT 'one_company_per_tenant',
  EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = 'integration_connections_one_company_per_tenant'
            AND i.indexdef LIKE 'CREATE UNIQUE INDEX%(provider, tenant_id) WHERE (status <> ''disconnected''::text)')
UNION ALL SELECT 'each_document_once',
  EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'integration_sends_once' AND c.contype = 'u' AND c.conrelid = to_regclass('public.integration_sends')
            AND pg_get_constraintdef(c.oid) = 'UNIQUE (organization_id, provider, doc_type, doc_id, action)')
-- Issuing (and voiding) queues through the trigger on both document tables.
UNION ALL SELECT 'enqueue_on_invoices_and_credit_notes',
  (SELECT count(*) = 2 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgname = 'zz_integration_enqueue' AND g.tgfoid = 'public.integration_enqueue()'::regprocedure
     AND g.tgrelid IN ('public.invoices'::regclass, 'public.credit_notes'::regclass))
-- Off by default: right after 084 no company is connected (informational after an admin connects one: then the count is theirs).
UNION ALL SELECT 'live_connections_have_tenant',
  NOT EXISTS (SELECT 1 FROM public.integration_connections c WHERE c.status <> 'disconnected' AND c.tenant_id IS NULL);
