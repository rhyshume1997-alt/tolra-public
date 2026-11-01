-- Migration 133 (G3: the AI assistant, built off). Read only: every row should be TRUE (7). Bodies are compared with every whitespace
-- character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.prosrc, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)'), to_regprocedure('public.ai_helper_set_assistant(boolean)'),
                  to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)'), to_regprocedure('public.ai_helper_status()'))
)
-- The company's switch: NOT NULL DEFAULT FALSE (off for every company until an admin turns it on).
SELECT 'assistant_off_by_default' AS check_name,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings'
          AND column_name = 'assistant_enabled' AND is_nullable = 'NO' AND column_default = 'false') AS ok
-- The request log takes the three features (so an assistant request is capped, logged and audited like the other two).
UNION ALL SELECT 'feature_check_has_assistant',
  EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.ai_helper_requests'::regclass AND c.conname = 'ai_helper_requests_feature'
          AND pg_get_constraintdef(c.oid) LIKE '%''assistant''%' AND pg_get_constraintdef(c.oid) LIKE '%''rfq''%' AND pg_get_constraintdef(c.oid) LIKE '%''roundup''%')
-- ai_helper_reserve_assistant: this file's body (103's reserve for the one feature, against its own switch), no key in its answer,
-- the guarded cap UPDATE.
UNION ALL SELECT 'reserve_assistant_is_133',
  coalesce((SELECT body = 'ad90f8bb9e5789d5d88ef64b0479635a' AND provolatile = 'v' AND position('''key_enc''' IN prosrc) = 0
                   AND position('u.reserved_pence + u.spent_pence + p_estimate_pence' IN prosrc) > 0 AND position('v_set.assistant_enabled' IN prosrc) > 0
            FROM fn WHERE proname = 'ai_helper_reserve_assistant'), FALSE)
-- ai_helper_set_assistant: admin only, through 101's caller check.
UNION ALL SELECT 'set_assistant_admin_only',
  coalesce((SELECT position('_ai_helper_caller(ARRAY[''admin''])' IN prosrc) > 0 FROM fn WHERE proname = 'ai_helper_set_assistant'), FALSE)
-- Both: definer, 101's search_path, signed-in only (authenticated may; anon and PUBLIC may not).
UNION ALL SELECT 'functions_definer_signed_in_only',
  (SELECT count(*) = 2 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
            AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
   FROM fn WHERE proname IN ('ai_helper_reserve_assistant', 'ai_helper_set_assistant'))
-- Untouched by 133: settle is 103's and the service role's only; status is 122's.
UNION ALL SELECT 'settle_and_status_unchanged',
  coalesce((SELECT body = 'ca5166191666584107491f95ccce4702' AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND has_function_privilege('service_role', oid, 'EXECUTE')
            FROM fn WHERE proname = 'ai_helper_settle'), FALSE)
  AND coalesce((SELECT body = '3ef44c838451b46ea14030164d9b1384' FROM fn WHERE proname = 'ai_helper_status'), FALSE)
-- No write path for a signed-in user: the AI helper tables still grant SELECT only (and nothing on the key table).
UNION ALL SELECT 'no_signed_in_write_grant',
  NOT has_table_privilege('authenticated', 'public.ai_helper_settings', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.ai_helper_requests', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.ai_helper_usage', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.ai_helper_secrets', 'SELECT');
