-- Migration 076 (data import: Admin > Data import, the SQL foundation; small imports in one call, large ones staged, validated whole,
-- committed in parts and undone). Read only: every row should be TRUE.
WITH t(name) AS (
  SELECT unnest(ARRAY['import_mappings', 'import_batches', 'import_record_keys', 'import_runs', 'import_stage'])
),
callable(sig) AS (
  SELECT unnest(ARRAY['public.import_company_data(jsonb,boolean,uuid)', 'public.import_stage_part(uuid,integer,jsonb)',
                      'public.import_validate(uuid,integer,uuid)', 'public.import_commit_part(uuid,uuid)', 'public.import_undo(uuid,uuid)'])
),
internal(sig) AS (
  SELECT unnest(ARRAY['public.import_norm_name(text)', 'public.import_clean_text(text)', 'public.import_clean_record(jsonb)', 'public.import_num(text)',
                      'public.import_date(text)', 'public.import_bool(text)', 'public.import_mappings_stamp()', 'public.import_batches_immutable()',
                      'public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)', 'public.import_admin_org()',
                      'public.import_check_payload(jsonb)', 'public.import_replay(uuid,uuid,text)', 'public.import_failure(jsonb,text,text,text)',
                      'public.import_merge_stage(uuid,uuid)', 'public.import_plan(jsonb,integer)', 'public.import_part_payload(jsonb,jsonb)',
                      'public.import_undo_part(uuid,uuid)'])
),
insert_guards(sig) AS (
  SELECT unnest(ARRAY['public.documents_start_as_drafts()', 'public.invoice_lines_issue_lock()', 'public.quote_lines_issue_lock()'])
),
delete_guards(sig) AS (
  SELECT unnest(ARRAY['public.invoice_lines_issue_lock()', 'public.quote_lines_issue_lock()', 'public.invoice_issue_lock()',
                      'public.quote_lifecycle_guard()', 'public.purchase_order_issue_lock()'])
)
SELECT 'tables_present' AS check_name, (SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) FROM t) AS ok
UNION ALL SELECT 'rls_enabled', (SELECT bool_and(c.relrowsecurity) AND count(*) = 5 FROM pg_class c JOIN t ON c.oid = to_regclass('public.' || t.name))
-- Mappings: admins write them through their row rules; the others: read only for the API; nothing for anon.
UNION ALL SELECT 'api_privileges',
  NOT EXISTS (SELECT 1 FROM t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p WHERE has_table_privilege('anon', 'public.' || t.name, p))
  AND has_table_privilege('authenticated', 'public.import_mappings', 'SELECT') AND has_table_privilege('authenticated', 'public.import_mappings', 'INSERT')
  AND has_table_privilege('authenticated', 'public.import_mappings', 'UPDATE') AND has_table_privilege('authenticated', 'public.import_mappings', 'DELETE')
  AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['import_batches', 'import_record_keys', 'import_runs', 'import_stage']) x, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
                  WHERE has_table_privilege('authenticated', 'public.' || x, p))
UNION ALL SELECT 'policies_admin_of_session_company', (
  SELECT count(*) = 8 AND bool_and(coalesce(p.qual, p.with_check) LIKE '%current_user_organization_id()%'
                                   AND coalesce(p.qual, p.with_check) LIKE '%has_org_role(ARRAY[''admin''::text])%'
                                   AND coalesce(p.with_check, p.qual) LIKE '%has_org_role(ARRAY[''admin''::text])%')
  FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN (SELECT name FROM t))
UNION ALL SELECT 'callable_signed_in_definer_pinned', (
  SELECT bool_and(p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                  AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) AND count(*) = 5
  FROM callable c JOIN pg_proc p ON p.oid = to_regprocedure(c.sig))
UNION ALL SELECT 'internal_not_callable', (
  SELECT bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) AND count(*) = 17
  FROM internal i JOIN pg_proc p ON p.oid = to_regprocedure(i.sig))
-- Admin of the session's company, second step, no support session (one place, used by every entry point); one call per company at a
-- time; keyed; the work in a sub-block.
UNION ALL SELECT 'entry_checks', (
  SELECT p.prosrc LIKE '%assert_privileged_aal()%' AND p.prosrc LIKE '%current_user_organization_id()%' AND p.prosrc LIKE '%s.is_support%'
         AND p.prosrc LIKE '%has_org_role(ARRAY[''admin''])%'
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_admin_org()'))
  AND (SELECT bool_and(p.prosrc LIKE '%public.import_admin_org()%' AND p.prosrc LIKE '%pg_advisory_xact_lock(hashtext(''import_company_data''), hashtext(v_org::TEXT))%')
       FROM callable c JOIN pg_proc p ON p.oid = to_regprocedure(c.sig))
  AND (SELECT bool_and(p.prosrc LIKE '%WHEN SQLSTATE ''QI076''%') FROM pg_proc p
       WHERE p.oid IN (to_regprocedure('public.import_company_data(jsonb,boolean,uuid)'), to_regprocedure('public.import_commit_part(uuid,uuid)')))
  AND NOT EXISTS (SELECT 1 FROM callable c JOIN pg_proc p ON p.oid = to_regprocedure(c.sig) WHERE p.prosrc LIKE '%->> ''organization_id''%')
UNION ALL SELECT 'norm_name_immutable_and_ported', (
  SELECT p.provolatile = 'i' FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_norm_name(text)'))
  AND public.import_norm_name('  Smith & Sons LIMITED. ') = 'smith and sons ltd'
  AND public.import_norm_name('École d''Été Ltd') = 'ecole d ete ltd'
  AND public.import_norm_name(NULL) = ''
  AND public.import_clean_text('''=SUM(A1)') = '=SUM(A1)' AND public.import_clean_text('''-12.50') = '''-12.50' AND public.import_clean_text('  ') IS NULL
-- The guards: an INSERT passes only while quoteflow.data_import names the row's company, a DELETE only while quoteflow.data_import_undo
-- does; each keeps its own checks; only the import (and its undo) sets them, and clears them after its writes.
UNION ALL SELECT 'guards_honour_import_only', (
  SELECT count(*) = 3 AND bool_and(p.prosrc LIKE '%current_setting(''quoteflow.data_import'', TRUE) = NEW.organization_id::TEXT%')
  FROM insert_guards g JOIN pg_proc p ON p.oid = to_regprocedure(g.sig))
  AND (SELECT count(*) = 5 AND bool_and(p.prosrc LIKE '%TG_OP = ''DELETE'' AND current_setting(''quoteflow.data_import_undo'', TRUE) = OLD.organization_id::TEXT%')
       FROM delete_guards g JOIN pg_proc p ON p.oid = to_regprocedure(g.sig))
  AND (SELECT prosrc LIKE '%must be saved as a draft and then issued%' FROM pg_proc WHERE oid = to_regprocedure('public.documents_start_as_drafts()'))
  AND (SELECT prosrc LIKE '%has been issued, so it can''''t be deleted%' FROM pg_proc WHERE oid = to_regprocedure('public.invoice_issue_lock()'))
  AND (SELECT prosrc LIKE '%quoteflow.accept_quote%' FROM pg_proc WHERE oid = to_regprocedure('public.quote_lines_issue_lock()'))
  AND (SELECT count(*) = 1 FROM pg_proc p WHERE p.prosrc LIKE '%set_config(''quoteflow.data_import'',%')
  AND (SELECT count(*) = 1 FROM pg_proc p WHERE p.prosrc LIKE '%set_config(''quoteflow.data_import_undo'',%')
  AND (SELECT p.prosrc LIKE '%set_config(''quoteflow.data_import'', '''', TRUE)%' FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)'))
  AND (SELECT p.prosrc LIKE '%set_config(''quoteflow.data_import_undo'', '''', TRUE)%' FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_undo_part(uuid,uuid)'))
-- Undo deletes by the import's own keys only, locks first, refuses what changed or is still used.
UNION ALL SELECT 'undo_own_rows_only', (
  SELECT p.prosrc LIKE '%FROM public.import_record_keys k WHERE k.organization_id = p_org AND k.batch_id = p_batch_id%'
         AND p.prosrc LIKE '%FOR UPDATE OF t%' AND p.prosrc LIKE '%changed in Tolra after the import%' AND p.prosrc LIKE '%still used in Tolra%'
         AND p.prosrc LIKE '%> u.audit_rows%'
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_undo_part(uuid,uuid)'))
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'import_record_keys' AND column_name = 'audit_rows')
  AND (SELECT p.prosrc LIKE '%INTERVAL ''24 hours''%' AND p.prosrc LIKE '%r.parts_committed = 0%'
       FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_stage_part(uuid,integer,jsonb)'))
UNION ALL SELECT 'record_keys_unique_per_company_kind_key', EXISTS (
  SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.import_record_keys'::regclass AND c.contype = 'p'
    AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (organization_id, kind, match_key)')
UNION ALL SELECT 'batches_immutable_and_keyed', EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.import_batches'::regclass AND tgname = 'import_batches_immutable' AND tgenabled = 'O')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.import_batches'::regclass AND c.conname = 'import_batches_one_per_key')
UNION ALL SELECT 'audit_support_mfa_triggers', (
  SELECT count(*) = 13 FROM pg_trigger tg
  WHERE tg.tgrelid IN (SELECT to_regclass('public.' || name) FROM t)
    AND tg.tgname IN ('audit_import_mappings_changes', 'audit_import_batches_changes', 'audit_import_runs_changes', 'support_read_only', 'admin_mfa')
    AND tg.tgenabled = 'O')
-- The read events may name the payments and weekly-hours exports; IMPORT_COMMITTED and IMPORT_UNDONE are never a client's to write.
UNION ALL SELECT 'audit_export_entries', (
  SELECT p.prosrc LIKE '%WHEN ''invoice_payments'' THEN ARRAY[''admin'', ''office'']%' AND p.prosrc LIKE '%WHEN ''time_week_approvals'' THEN ARRAY[''admin'', ''office'']%'
         AND p.prosrc NOT LIKE '%IMPORT_%'
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.audit_event_allowed(text,text)'))
  AND NOT public.audit_event_allowed('IMPORT_COMMITTED', 'import_batches') AND NOT public.audit_event_allowed('IMPORT_UNDONE', 'import_batches')
UNION ALL SELECT 'batches_and_runs_consistent', NOT EXISTS (
  SELECT 1 FROM public.import_batches b
  WHERE (b.status = 'committed') IS DISTINCT FROM coalesce((b.result ->> 'committed')::BOOLEAN, FALSE)
     OR (b.status = 'committed' AND (b.result ->> 'error_count')::INT <> 0)
     OR (b.large AND b.import_id IS NULL))
  AND NOT EXISTS (SELECT 1 FROM public.import_record_keys k JOIN public.import_batches b ON b.id = k.batch_id
                  WHERE b.organization_id <> k.organization_id OR b.status <> 'committed')
  AND NOT EXISTS (SELECT 1 FROM public.import_runs r WHERE r.parts_committed > coalesce(r.parts, 0) OR r.parts_undone > r.parts_committed)
  AND NOT EXISTS (SELECT 1 FROM public.import_stage s JOIN public.import_runs r USING (organization_id, import_id)
                  WHERE r.status IN ('committed', 'undone', 'cancelled'));
