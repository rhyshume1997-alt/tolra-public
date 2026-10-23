-- Migration 075 (site network check phase 1, B40 / G21; refused late time actions, G18). Read only: every row should be TRUE.
WITH t(name) AS (
  SELECT unnest(ARRAY['site_network_settings', 'site_networks', 'site_network_members', 'attendance_event_networks', 'site_network_ops',
                      'time_sync_rejections'])
),
callable(sig) AS (
  SELECT unnest(ARRAY['public.set_site_network_check(uuid,text)', 'public.add_site_network(uuid,text,text)', 'public.remove_site_network(uuid,uuid)',
                      'public.set_member_on_site_only(uuid,uuid,boolean)', 'public.my_request_network()',
                      'public.report_time_sync_rejection(uuid,text,text,timestamptz,text,text,text,text)',
                      'public.resolve_time_sync_rejection(uuid,text)'])
),
internal(sig) AS (
  SELECT unnest(ARRAY['public.site_network_host(text)', 'public.site_network_private(inet)', 'public.site_network_parse(text)',
                      'public.request_client_ip()', 'public.site_network_matches(uuid,inet)', 'public.attendance_events_network()',
                      'public.site_network_admin_org()', 'public.site_network_replay(uuid,uuid,text,jsonb)',
                      'public.time_sync_rejection_answer(public.time_sync_rejections,boolean)'])
)
SELECT 'tables_present' AS check_name, (SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) FROM t) AS ok
UNION ALL SELECT 'rls_enabled', (SELECT bool_and(c.relrowsecurity) AND count(*) = 6 FROM pg_class c JOIN t ON c.oid = to_regclass('public.' || t.name))
UNION ALL SELECT 'no_direct_api_writes', NOT EXISTS (
  SELECT 1 FROM t, unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
  WHERE has_table_privilege(r, 'public.' || t.name, p))
  AND NOT EXISTS (SELECT 1 FROM t WHERE has_table_privilege('anon', 'public.' || t.name, 'SELECT'))
  AND NOT has_table_privilege('authenticated', 'public.site_network_ops', 'SELECT')
UNION ALL SELECT 'read_policies_company_scoped', (
  SELECT count(*) = 5 FROM pg_policies p
  WHERE p.schemaname = 'public' AND p.cmd = 'SELECT' AND p.qual LIKE '%current_user_organization_id()%'
    AND p.tablename IN ('site_network_settings', 'site_networks', 'site_network_members', 'attendance_event_networks', 'time_sync_rejections'))
  AND (SELECT bool_and(p.qual LIKE '%auth.uid()%') FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename IN ('site_network_members', 'attendance_event_networks', 'time_sync_rejections'))
  AND (SELECT bool_and(p.qual NOT LIKE '%workshop%') FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.tablename IN ('site_network_settings', 'site_networks'))
UNION ALL SELECT 'callable_signed_in_definer_pinned', (
  SELECT bool_and(p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                  AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) AND count(*) = 7
  FROM callable c JOIN pg_proc p ON p.oid = to_regprocedure(c.sig))
UNION ALL SELECT 'internal_not_callable', (
  SELECT bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) AND count(*) = 9
  FROM internal i JOIN pg_proc p ON p.oid = to_regprocedure(i.sig))
UNION ALL SELECT 'second_step_and_company_first', (
  SELECT bool_and(p.prosrc LIKE '%assert_privileged_aal()%' AND p.prosrc LIKE '%time_caller_org()%') AND count(*) = 3
  FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.site_network_admin_org()'),
                                 to_regprocedure('public.report_time_sync_rejection(uuid,text,text,timestamptz,text,text,text,text)'),
                                 to_regprocedure('public.resolve_time_sync_rejection(uuid,text)')))
  AND (SELECT bool_and(p.prosrc LIKE '%site_network_admin_org()%' AND p.prosrc LIKE '%site_network_replay(%')
       FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.set_site_network_check(uuid,text)'), to_regprocedure('public.add_site_network(uuid,text,text)'),
                                      to_regprocedure('public.remove_site_network(uuid,uuid)'), to_regprocedure('public.set_member_on_site_only(uuid,uuid,boolean)')))
-- The client IP comes from the server-set request headers, cf-connecting-ip only (never x-forwarded-for).
UNION ALL SELECT 'ip_from_cf_connecting_ip_only', (
  SELECT p.prosrc LIKE '%request.headers%' AND p.prosrc LIKE '%cf-connecting-ip%' AND p.prosrc NOT LIKE '%x-forwarded-for%'
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.request_client_ip()'))
-- Flag only: the check runs AFTER the clock row is written and swallows its own errors; it never raises a refusal.
UNION ALL SELECT 'check_trigger_after_insert_never_refuses', (
  SELECT count(*) = 1 FROM pg_trigger g
  WHERE g.tgrelid = 'public.attendance_events'::regclass AND g.tgname = 'zz_attendance_events_network' AND g.tgenabled = 'O'
    AND g.tgfoid = to_regprocedure('public.attendance_events_network()') AND (g.tgtype & 2) = 0 AND (g.tgtype & 4) = 4 AND (g.tgtype & 1) = 1)
  AND (SELECT p.prosrc LIKE '%EXCEPTION WHEN OTHERS%' AND p.prosrc NOT LIKE '%RAISE%' FROM pg_proc p WHERE p.oid = to_regprocedure('public.attendance_events_network()'))
UNION ALL SELECT 'switch_off_by_default_no_refuse_mode', (
  SELECT pg_get_expr(d.adbin, d.adrelid) = '''off''::text' FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.site_network_settings'::regclass AND a.attname = 'site_network_check')
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.site_network_settings'::regclass AND pg_get_constraintdef(c.oid) LIKE '%refuse%')
  AND (SELECT pg_get_expr(d.adbin, d.adrelid) = 'false' FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'public.site_network_members'::regclass AND a.attname = 'on_site_only')
UNION ALL SELECT 'guards', (
  SELECT count(*) = 17 FROM pg_trigger g JOIN t ON g.tgrelid = to_regclass('public.' || t.name)
  WHERE g.tgenabled = 'O' AND (g.tgname IN ('support_read_only', 'admin_mfa') OR g.tgname = 'audit_' || t.name || '_changes'))
  AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'public.attendance_event_networks'::regclass AND g.tgname = 'attendance_event_networks_immutable' AND g.tgenabled = 'O')
-- Data: each check row belongs to its clock row (same company and person, a clock action), an IP only for on_site / off_site, the flag
-- only for off_site; each saved network is a public range; each report is its person's, in a company they belong to.
UNION ALL SELECT 'checks_consistent', NOT EXISTS (
  SELECT 1 FROM public.attendance_event_networks n LEFT JOIN public.attendance_events e ON e.id = n.event_id
  WHERE e.id IS NULL OR e.organization_id <> n.organization_id OR e.user_id <> n.user_id OR e.source <> 'clock'
     OR n.off_site_network <> (n.status = 'off_site') OR (n.ip IS NOT NULL) <> (n.status IN ('on_site', 'off_site')))
UNION ALL SELECT 'networks_public', NOT EXISTS (SELECT 1 FROM public.site_networks n WHERE public.site_network_private(n.network))
UNION ALL SELECT 'reports_consistent', NOT EXISTS (
  SELECT 1 FROM public.time_sync_rejections r
  WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id)
     OR (r.resolved_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = r.organization_id AND m.user_id = r.resolved_by)));
