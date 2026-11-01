-- Migration 128 (Settings > Workshop network: rename, refused clock actions recorded for the admin's banner). Read only: every row
-- should be TRUE (7). Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn(sig, oid, secdef, config, body) AS (
  SELECT x.sig, p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g'))
  FROM unnest(ARRAY['public.rename_site_network(uuid,uuid,text)', 'public.record_clock_in_refusal(uuid,text)', 'public.purge_site_network_ips(boolean)',
                    'public.site_network_ip_purge(uuid,integer)', 'public.clock_in_refusal_ip_purge(uuid,integer)',
                    'public.clock_in_refusal_answer(clock_in_network_refusals,boolean)']) AS x(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig)
)
-- The keyed admin saves also take 'rename' (075's four kinds kept).
SELECT 'ops_kind_allows_rename' AS check_name, coalesce((
  SELECT pg_get_constraintdef(c.oid) = 'CHECK ((kind = ANY (ARRAY[''check''::text, ''add''::text, ''remove''::text, ''member''::text, ''rename''::text])))'
  FROM pg_constraint c WHERE c.conrelid = to_regclass('public.site_network_ops') AND c.conname = 'site_network_ops_kind_check'), FALSE) AS ok
-- The refusal record: RLS on, the company's admins only (one SELECT policy), no API writes, anon nothing.
UNION ALL SELECT 'refusals_admin_read_only', coalesce((
  SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.clock_in_network_refusals'))
  AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
                  WHERE has_table_privilege(r, 'public.clock_in_network_refusals', p))
  AND NOT has_table_privilege('anon', 'public.clock_in_network_refusals', 'SELECT')
  AND (SELECT count(*) = 1 AND bool_and(p.cmd = 'SELECT' AND p.qual LIKE '%current_user_organization_id()%' AND p.qual LIKE '%has_org_role(ARRAY[''admin''::text])%')
       FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'clock_in_network_refusals'), FALSE)
-- Not audited (the address never reaches security_audit.audit_log): support read-only and the admin second step only.
UNION ALL SELECT 'refusals_not_audited_guarded', coalesce((
  SELECT count(*) FILTER (WHERE g.tgname IN ('support_read_only', 'admin_mfa') AND g.tgenabled = 'O') = 2
     AND count(*) FILTER (WHERE g.tgname NOT IN ('support_read_only', 'admin_mfa')) = 0
  FROM pg_trigger g WHERE g.tgrelid = to_regclass('public.clock_in_network_refusals') AND NOT g.tgisinternal), FALSE)
-- The three callable functions: 128's bodies, definer, pinned, signed-in only.
UNION ALL SELECT 'callable_functions', (
  SELECT count(*) = 3 AND bool_and(f.secdef AND f.config = ARRAY['search_path=pg_catalog, public']
           AND has_function_privilege('authenticated', f.oid, 'EXECUTE') AND NOT has_function_privilege('anon', f.oid, 'EXECUTE')
           AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = f.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  FROM fn f WHERE f.sig IN ('public.rename_site_network(uuid,uuid,text)', 'public.record_clock_in_refusal(uuid,text)', 'public.purge_site_network_ips(boolean)'))
  AND (SELECT body = '235122cd4d464c5aa867f9d449ac82f0' FROM fn WHERE sig = 'public.rename_site_network(uuid,uuid,text)')
  AND (SELECT body = '5d7deffec96d2be139b5b1586d480856' FROM fn WHERE sig = 'public.record_clock_in_refusal(uuid,text)')
  AND (SELECT body = '8bf4c2dbdb1b11618cabc6a1520ebd75' FROM fn WHERE sig = 'public.purge_site_network_ips(boolean)')
-- The internal ones: invoker, pinned, no API role (the ip-purge cron calls site_network_ip_purge as the service role).
UNION ALL SELECT 'internal_functions', (
  SELECT count(*) = 3 AND bool_and(f.oid IS NOT NULL AND NOT f.secdef AND f.config = ARRAY['search_path=pg_catalog, public']
           AND NOT has_function_privilege('authenticated', f.oid, 'EXECUTE') AND NOT has_function_privilege('anon', f.oid, 'EXECUTE'))
  FROM fn f WHERE f.sig IN ('public.site_network_ip_purge(uuid,integer)', 'public.clock_in_refusal_ip_purge(uuid,integer)',
                            'public.clock_in_refusal_answer(clock_in_network_refusals,boolean)'))
  AND (SELECT body = '53348dc930741ac3eae1ec3258337871' FROM fn WHERE sig = 'public.site_network_ip_purge(uuid,integer)')
  AND (SELECT body = '480ad265498cee457e7ccf0344fe596a' FROM fn WHERE sig = 'public.clock_in_refusal_ip_purge(uuid,integer)')
  AND has_function_privilege('service_role', 'public.site_network_ip_purge(uuid,integer)'::regprocedure, 'EXECUTE')
-- A seen address never becomes a site network by itself (078's rule; 078's verify row only_admin_adds_site_networks reads FALSE after 128
-- by design, because rename_site_network also updates site_networks): the only writers are add_site_network (an admin's explicit save)
-- and rename_site_network, whose one UPDATE changes the label only.
UNION ALL SELECT 'only_admin_saves_site_networks', coalesce((
  SELECT array_agg(p.oid::regprocedure::TEXT ORDER BY 1) = ARRAY['add_site_network(uuid,text,text)', 'rename_site_network(uuid,uuid,text)']
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND p.prosrc ~* '(insert\s+into|update)\s+(public\.)?site_networks\M')
  AND (SELECT p.prosrc LIKE '%site_network_admin_org()%' AND p.prosrc LIKE '%UPDATE public.site_networks SET label = v_label WHERE organization_id = v_org AND id = p_id;%'
              AND (length(p.prosrc) - length(replace(p.prosrc, 'UPDATE public.site_networks', ''))) = length('UPDATE public.site_networks')
       FROM pg_proc p WHERE p.oid = to_regprocedure('public.rename_site_network(uuid,uuid,text)')), FALSE)
-- No refusal address older than the retention period is still kept (the purge has run since; informational on a fresh project: TRUE).
UNION ALL SELECT 'no_expired_refusal_address', coalesce(NOT EXISTS (
  SELECT 1 FROM public.clock_in_network_refusals r WHERE r.ip IS NOT NULL AND r.attempted_at < now() - public.site_network_ip_retention() - INTERVAL '2 days'), FALSE);
