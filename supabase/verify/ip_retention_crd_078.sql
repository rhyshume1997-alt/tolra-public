-- Migration 078 (clock-in addresses kept 30 days and never in the audit log; CRD credit note numbers). Read only: every row should be TRUE.
WITH ips AS (SELECT to_regclass('public.attendance_event_network_ips') AS t),
fn(sig, body, secdef, config) AS (
  SELECT x.sig, p.prosrc, p.prosecdef, p.proconfig
  FROM unnest(ARRAY['public.attendance_events_network()', 'public.site_network_ip_retention()', 'public.site_network_ip_purge(uuid,integer)',
                    'public.purge_site_network_ips(boolean)', 'public.next_doc_number(text)', 'public.seed_credit_note_number(uuid,text)',
                    'public.issue_credit_note(uuid)']) AS x(sig)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig)
)
SELECT 'address_table_read_only' AS check_name, (
  SELECT t IS NOT NULL FROM ips)
  AND (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.attendance_event_network_ips'::regclass)
  AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
                  WHERE has_table_privilege(r, 'public.attendance_event_network_ips', p))
  AND NOT has_table_privilege('anon', 'public.attendance_event_network_ips', 'SELECT')
  AND (SELECT count(*) = 1 AND bool_and(p.cmd = 'SELECT' AND p.qual LIKE '%current_user_organization_id()%' AND p.qual LIKE '%auth.uid()%')
       FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_event_network_ips') AS ok
-- Not audited (the address never reaches security_audit.audit_log) and not immutable (expired rows are deleted); support read-only and
-- the admin second step as 075's tables.
UNION ALL SELECT 'address_table_not_audited_guarded', (
  SELECT count(*) FILTER (WHERE g.tgname IN ('support_read_only', 'admin_mfa') AND g.tgenabled = 'O') = 2
     AND count(*) FILTER (WHERE g.tgname NOT IN ('support_read_only', 'admin_mfa')) = 0
  FROM pg_trigger g WHERE g.tgrelid = 'public.attendance_event_network_ips'::regclass AND NOT g.tgisinternal)
UNION ALL SELECT 'retention_30_days', (SELECT public.site_network_ip_retention() = INTERVAL '30 days')
UNION ALL SELECT 'functions_and_rights', (
  SELECT bool_and(f.body IS NOT NULL AND f.config @> ARRAY['search_path=pg_catalog, public']) AND count(*) = 7 FROM fn f)
  AND (SELECT f.secdef AND has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE') AND NOT has_function_privilege('anon', to_regprocedure(f.sig), 'EXECUTE')
       FROM fn f WHERE f.sig = 'public.purge_site_network_ips(boolean)')
  AND (SELECT bool_and(NOT f.secdef AND NOT has_function_privilege('anon', to_regprocedure(f.sig), 'EXECUTE') AND NOT has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE'))
       FROM fn f WHERE f.sig IN ('public.site_network_ip_retention()', 'public.site_network_ip_purge(uuid,integer)', 'public.seed_credit_note_number(uuid,text)'))
  AND NOT has_function_privilege('service_role', 'public.seed_credit_note_number(uuid,text)'::regprocedure, 'EXECUTE')
  AND (SELECT f.body LIKE '%site_network_admin_org()%' AND f.body LIKE '%time_company_lock(v_org)%' FROM fn f WHERE f.sig = 'public.purge_site_network_ips(boolean)')
-- The check: still AFTER INSERT, never refusing (075's verify rule), the address written apart, expired ones deleted first.
UNION ALL SELECT 'check_trigger_keeps_address_apart', (
  SELECT count(*) = 1 FROM pg_trigger g
  WHERE g.tgrelid = 'public.attendance_events'::regclass AND g.tgname = 'zz_attendance_events_network' AND g.tgenabled = 'O'
    AND g.tgfoid = to_regprocedure('public.attendance_events_network()') AND (g.tgtype & 2) = 0 AND (g.tgtype & 4) = 4 AND (g.tgtype & 1) = 1)
  AND (SELECT f.secdef AND f.body LIKE '%EXCEPTION WHEN OTHERS%' AND f.body NOT LIKE '%RAISE%' AND f.body LIKE '%INSERT INTO public.attendance_event_network_ips%'
              AND f.body LIKE '%site_network_ip_purge(NEW.organization_id, 500)%' AND f.body LIKE '%v_status, NULL, v_status = ''off_site''%'
       FROM fn f WHERE f.sig = 'public.attendance_events_network()')
-- Never refuses: every statement of the check runs inside the outer handler (the body, without comments and whitespace, opens the
-- handler's block first and closes it last), the purge has its own handler, and the address insert its own (the flag row survives it).
UNION ALL SELECT 'check_trigger_all_inside_handler', (
  SELECT b LIKE 'DECLAREv_modeTEXT;v_ipINET;v_statusTEXT;v_checkedTIMESTAMPTZ;BEGINBEGINBEGINIFEXISTS(SELECT1FROMpublic.attendance_event_network_ips%'
     AND b LIKE '%PERFORMpublic.site_network_ip_purge(NEW.organization_id,500);ENDIF;EXCEPTIONWHENOTHERSTHENNULL;END;IFNEW.source<>''clock''THEN%'
     AND b LIKE '%BEGININSERTINTOpublic.attendance_event_network_ips(event_id,organization_id,user_id,ip,checked_at)VALUES(NEW.id,NEW.organization_id,NEW.user_id,v_ip,v_checked);EXCEPTIONWHENOTHERSTHENNULL;END;ENDIF;EXCEPTIONWHENOTHERSTHENRETURNNULL;END;RETURNNULL;END'
     AND (length(b) - length(replace(b, 'EXCEPTIONWHENOTHERS', ''))) = 3 * length('EXCEPTIONWHENOTHERS')
  FROM (SELECT regexp_replace(regexp_replace(f.body, '--[^\n]*', '', 'g'), '\s', '', 'g') AS b FROM fn f WHERE f.sig = 'public.attendance_events_network()') x)
-- The check rows keep status, flag and time for ever and never an address; they stay immutable and audited.
UNION ALL SELECT 'check_rows_hold_no_address', (
  SELECT pg_get_constraintdef(c.oid) = 'CHECK ((ip IS NULL))' FROM pg_constraint c
  WHERE c.conrelid = 'public.attendance_event_networks'::regclass AND c.conname = 'attendance_event_networks_ip')
  AND NOT EXISTS (SELECT 1 FROM public.attendance_event_networks n WHERE n.ip IS NOT NULL)
  AND (SELECT count(*) = 2 FROM pg_trigger g WHERE g.tgrelid = 'public.attendance_event_networks'::regclass AND g.tgenabled = 'O'
         AND g.tgname IN ('attendance_event_networks_immutable', 'audit_attendance_event_networks_changes'))
-- Each kept address is its check's (same company, person and time; an on_site or off_site check).
UNION ALL SELECT 'addresses_consistent', NOT EXISTS (
  SELECT 1 FROM public.attendance_event_network_ips i LEFT JOIN public.attendance_event_networks n ON n.event_id = i.event_id
  WHERE n.event_id IS NULL OR n.organization_id <> i.organization_id OR n.user_id <> i.user_id OR n.checked_at <> i.checked_at
     OR n.status NOT IN ('on_site', 'off_site'))
-- Nothing of the address table is in the audit log.
UNION ALL SELECT 'no_address_rows_in_audit_log', NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.entity_table = 'attendance_event_network_ips' AND a.action IN ('INSERT', 'UPDATE', 'DELETE'))
-- A seen address is never trusted by itself: add_site_network (admin) is the only function that writes site_networks.
UNION ALL SELECT 'only_admin_adds_site_networks', (
  SELECT array_agg(p.oid::regprocedure::TEXT ORDER BY 1) = ARRAY['add_site_network(uuid,text,text)']
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND p.prosrc ~* '(insert\s+into|update)\s+(public\.)?site_networks\M')
  AND (SELECT p.prosrc LIKE '%site_network_admin_org()%' FROM pg_proc p WHERE p.oid = 'public.add_site_network(uuid,text,text)'::regprocedure)
-- Credit notes: CRD from next_doc_number (carrying on after the highest CRD-n / CN-n), issued by issue_credit_note; credit_ref unique.
UNION ALL SELECT 'crd_numbering', (
  SELECT f.body LIKE '%''CRD''%' AND strpos(f.body, '^(?:CRD|CN)-(\d{1,9})$') > 0 AND f.body LIKE '%GREATEST(c.last + 1, EXCLUDED.last)%'
         AND f.body LIKE '%WHEN ''CRD'' THEN EXISTS (SELECT 1 FROM public.credit_notes%'
  FROM fn f WHERE f.sig = 'public.next_doc_number(text)')
  AND (SELECT f.body LIKE '%next_doc_number(''CRD'')%' AND f.body NOT LIKE '%next_doc_number(''CN'')%' FROM fn f WHERE f.sig = 'public.issue_credit_note(uuid)')
  AND EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = 'credit_notes_ref_org_uniq'
              AND i.indexdef LIKE 'CREATE UNIQUE INDEX credit_notes_ref_org_uniq ON public.credit_notes USING btree (organization_id, credit_ref)%');
