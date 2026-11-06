-- Read only: after a separately approved release 150, every row must say true (bodies compared with all whitespace removed).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosrc, p.prosecdef, p.provolatile, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public._ai_helper_status_own_key()'), to_regprocedure('public.ai_helper_set_key(text,text)'),
                  to_regprocedure('public._ai_helper_force_off(uuid,text)'), to_regprocedure('public.ai_helper_tolra_configure(boolean,text,uuid)'),
                  to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'), to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)'),
                  to_regprocedure('public.ai_helper_save_settings(boolean,boolean,integer)'), to_regprocedure('public.ai_helper_tolra_remove_key(uuid,text)'))
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
  coalesce((SELECT body = '9bdcf4abcf7549ff2e0240f7609502cd' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
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
UNION ALL SELECT 'ai_helper_tolra_remove_key is 150''s: owner service only (signed-in users, anon and PUBLIC may not), needs the typed confirmation, audits ai_tolra_key_removed with companies_affected',
  coalesce((SELECT body = '34d6fa1e5ea438941599bac8fa2df12c' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('service_role', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = fn.oid AND a.grantee = 0)
                   AND prosrc LIKE '%''REMOVE SHARED TOLRA KEY''%' AND prosrc LIKE '%ai_tolra_key_removed%' AND prosrc LIKE '%companies_affected%'
                   AND prosrc NOT LIKE '%monthly_cap_pence%' AND prosrc NOT LIKE '%ai_helper_usage%' AND prosrc NOT LIKE '%ai_helper_requests%'
            FROM fn WHERE proname = 'ai_helper_tolra_remove_key'), false)
UNION ALL SELECT 'the shared Tolra key is either set or switched off (no platform switch on without a key)',
  NOT EXISTS (SELECT 1 FROM public.ai_helper_tolra_control WHERE enabled AND api_key_enc IS NULL)
UNION ALL SELECT 'every platform key removal audit row carries only the count, a flag and the source (no key)',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a, jsonb_object_keys(a.metadata) k
              WHERE a.action = 'ai_tolra_key_removed' AND k NOT IN ('companies_affected', 'was_on', 'source'))
UNION ALL SELECT 'the control row carries key_removed (boolean, not null, default false) and the platform switch can never be on while it is set',
  coalesce((SELECT data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false' FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ai_helper_tolra_control' AND column_name = 'key_removed'), false)
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ai_helper_tolra_control'::regclass AND conname = 'ai_helper_tolra_control_removed_off'
              AND contype = 'c' AND convalidated AND pg_get_constraintdef(oid) = 'CHECK ((NOT (enabled AND key_removed)))')
  AND NOT EXISTS (SELECT 1 FROM public.ai_helper_tolra_control WHERE enabled AND key_removed)
UNION ALL SELECT 'the removal sets key_removed and only an explicit switch-on clears it (no audit-log lookup decides it)',
  coalesce((SELECT bool_and(CASE proname WHEN 'ai_helper_tolra_remove_key' THEN prosrc LIKE '%key_removed = TRUE%'
                                         ELSE prosrc LIKE '%key_removed = (v_removed AND NOT v_enabled)%' AND prosrc LIKE '%(v_key IS NOT NULL OR v_removed)%' END
                            AND prosrc NOT LIKE '%audit_log r%' AND prosrc NOT LIKE '%ai_tolra_key_readded%')
            FROM fn WHERE proname IN ('ai_helper_tolra_remove_key', 'ai_helper_tolra_configure')), false)
UNION ALL SELECT 'signed-in users still cannot write the AI tables directly',
  NOT has_table_privilege('authenticated', 'public.ai_helper_settings', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.ai_helper_settings', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.ai_helper_secrets', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.ai_helper_tolra_companies', 'UPDATE')
UNION ALL SELECT 'every force-off audit row carries only codes and booleans (reason, scope, was_on flags, source), no key and no text',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a, jsonb_object_keys(a.metadata) k
              WHERE a.action = 'ai_forced_off_key_changed'
                AND k NOT IN ('reason', 'scope', 'roundup_was_on', 'rfq_was_on', 'assistant_was_on', 'finance_check_was_on', 'tolra_was_on', 'source'))
UNION ALL SELECT 'existing companies still on the old 500p default (no recorded cap save) were raised to 1000p: each raise has one audit row from the release with only from 500, to 1000, had_explicit_save and source (no key, no text)',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a, jsonb_object_keys(a.metadata) k
              WHERE a.action = 'ai_cap_default_raised' AND k NOT IN ('from', 'to', 'had_explicit_save', 'source'))
  AND NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.action = 'ai_cap_default_raised'
                  AND (a.entity_table IS DISTINCT FROM 'ai_helper_settings' OR a.metadata ->> 'from' IS DISTINCT FROM '500' OR a.metadata ->> 'to' IS DISTINCT FROM '1000'
                       OR a.metadata ->> 'source' IS DISTINCT FROM 'release_150' OR a.organization_id IS NULL))
-- Information, always true. 150 raised a cap at exactly 500 only when no save of the cap was on record; a 500 that remains was saved explicitly (flagged ai_cap_review_flagged for admin review) or set after 150 (0, 300, 2500 and so on are choices too). Either way the cap in force is that number.
UNION ALL SELECT 'info: ' || count(*) || ' existing ai_helper_settings rows carry 500 (saved explicitly and kept, or set after 150)', true
  FROM public.ai_helper_settings WHERE monthly_cap_pence = 500
UNION ALL SELECT 'info: ' || count(*) || ' companies were raised from 500p to 1000p by release 150 (' || count(*) FILTER (WHERE (a.metadata ->> 'had_explicit_save')::BOOLEAN) || ' of them had an explicit cap save in the audit log)', true
  FROM security_audit.audit_log a WHERE a.action = 'ai_cap_default_raised'
UNION ALL SELECT 'info: ' || count(DISTINCT a.entity_id) || ' companies at 500p were kept and flagged for admin review (ai_cap_review_flagged)', true
  FROM security_audit.audit_log a WHERE a.action = 'ai_cap_review_flagged';
