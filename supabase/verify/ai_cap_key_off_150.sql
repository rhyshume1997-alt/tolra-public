-- Read only: after a separately approved release 150, every row must say true (bodies compared with all whitespace removed).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosrc, p.prosecdef, p.provolatile, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public._ai_helper_status_own_key()'), to_regprocedure('public.ai_helper_set_key(text,text)'),
                  to_regprocedure('public._ai_helper_force_off(uuid,text)'), to_regprocedure('public.ai_helper_tolra_configure(boolean,text,uuid)'),
                  to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'), to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)'),
                  to_regprocedure('public.ai_helper_save_settings(boolean,boolean,integer)'))
)
SELECT 'own-key cap defaults to 1000p on new rows' AS check_name,
  coalesce((SELECT column_default = '1000' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'monthly_cap_pence'), false) AS ok
UNION ALL SELECT 'provided AI cap still defaults to 1000p per company',
  coalesce((SELECT column_default = '1000' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_tolra_companies' AND column_name = 'monthly_cap_pence'), false)
UNION ALL SELECT 'every stored cap is still inside 0 to 100000 (101 check)',
  NOT EXISTS (SELECT 1 FROM public.ai_helper_settings WHERE monthly_cap_pence NOT BETWEEN 0 AND 100000)
UNION ALL SELECT 'the status fallback is 150''s (a company with no row reads 1000, none reads 500), stable, definer, pinned, not callable by signed-in users',
  coalesce((SELECT body = 'a144add4b49efdc0b08fb9a3ad4657d9' AND provolatile = 's' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND prosrc LIKE '%coalesce(v_set.monthly_cap_pence, 1000)%' AND prosrc NOT LIKE '%, 500)%'
                   AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            FROM fn WHERE proname = '_ai_helper_status_own_key'), false)
UNION ALL SELECT 'ai_helper_set_key is 150''s, definer, pinned, signed-in only (anon and PUBLIC may not)',
  coalesce((SELECT body = '423fd435ce49775980461ee998cff63f' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = fn.oid AND a.grantee = 0)
            FROM fn WHERE proname = 'ai_helper_set_key'), false)
UNION ALL SELECT 'a key save, replacement or removal runs the force-off after it has written, in the same function',
  coalesce((SELECT position('_ai_helper_force_off(v_org, ''key_removed'')' IN prosrc) > position('ai_helper_key_cleared' IN prosrc)
                   AND position('_ai_helper_force_off(v_org, CASE WHEN v_had' IN prosrc) > position('ai_helper_key_set' IN prosrc)
                   AND position('ai_helper_key_set' IN prosrc) > position('INSERT INTO public.ai_helper_secrets' IN prosrc)
            FROM fn WHERE proname = 'ai_helper_set_key'), false)
UNION ALL SELECT 'the force-off is internal: no PUBLIC, anon, signed-in or service role may run it; it switches roundup, rfq, assistant, finance check and the Tolra mode off and audits it',
  coalesce((SELECT body = '81fb7034c4cddc39c8cba5d4f6822fbf' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('service_role', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = fn.oid AND a.grantee = 0)
                   AND prosrc LIKE '%roundup_enabled = FALSE, rfq_enabled = FALSE, assistant_enabled = FALSE, finance_check_enabled = FALSE%'
                   AND prosrc LIKE '%SET enabled = FALSE%' AND prosrc LIKE '%ai_forced_off_key_changed%' AND prosrc NOT LIKE '%monthly_cap_pence%'
            FROM fn WHERE proname = '_ai_helper_force_off'), false)
UNION ALL SELECT 'ai_helper_tolra_configure is 150''s; owner service only (signed-in users and anon may not); a replaced platform key switches the platform off',
  coalesce((SELECT body = '9bbb5d3b56c51fe63f21917836857427' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('service_role', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND prosrc LIKE '%v_replaced := TRUE; v_enabled := FALSE%'
            FROM fn WHERE proname = 'ai_helper_tolra_configure'), false)
UNION ALL SELECT 'one company cap across both modes: ai_helper_reserve and ai_helper_reserve_assistant are 150''s (refuse above least(own-key cap, Tolra cap)), definer, signed-in only (anon and PUBLIC may not)',
  coalesce((SELECT count(*) = 2 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND body IN ('48b3f8302686bc6310402b117ea09ad5', '3c415227fefdeda349442ff870a88e64')
                   AND prosrc LIKE '%least(coalesce((SELECT s.monthly_cap_pence FROM public.ai_helper_settings s WHERE s.organization_id = v_org), 1000)%'
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = fn.oid AND a.grantee = 0))
            FROM fn WHERE proname IN ('ai_helper_reserve', 'ai_helper_reserve_assistant')), false)
UNION ALL SELECT 'ai_helper_save_settings is 150''s (a cap below this month''s spent + reserved is refused), definer, pinned, signed-in only (anon and PUBLIC may not)',
  coalesce((SELECT body = '2d9f74178c3527f28dab42e17dcc29b0' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND prosrc LIKE '%cap_below_usage%' AND prosrc LIKE '%ai_helper_settings_updated%'
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = fn.oid AND a.grantee = 0)
            FROM fn WHERE proname = 'ai_helper_save_settings'), false)
UNION ALL SELECT 'signed-in users still cannot write the AI tables directly',
  NOT has_table_privilege('authenticated', 'public.ai_helper_settings', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.ai_helper_settings', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.ai_helper_secrets', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.ai_helper_tolra_companies', 'UPDATE')
UNION ALL SELECT 'every force-off audit row carries only codes and booleans (reason, scope, was_on flags, source), no key and no text',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a, jsonb_object_keys(a.metadata) k
              WHERE a.action = 'ai_forced_off_key_changed'
                AND k NOT IN ('reason', 'scope', 'roundup_was_on', 'rfq_was_on', 'assistant_was_on', 'finance_check_was_on', 'tolra_was_on', 'source'))
-- Information, always true: existing rows were not rewritten by 150, so any row made at the old 500 default still reads 500.
UNION ALL SELECT 'info: ' || count(*) || ' existing ai_helper_settings rows carry 500 (150 leaves every existing cap as it was)', true
  FROM public.ai_helper_settings WHERE monthly_cap_pence = 500;
