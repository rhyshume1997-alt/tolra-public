-- Migration 081 (the job flow In progress -> Finished -> Complete; reopen with a reason; the inspection's evidence, independence and
-- disposition; release of delivery notes and invoices only for a Complete job or an admin's early release; one draft invoice per job).
-- Read only: every row should be TRUE. Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, regexp_replace(p.prosrc, '\s', '', 'g') AS body
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.job_release_state(uuid)'), to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)'))
),
rs AS (SELECT * FROM f WHERE oid = to_regprocedure('public.job_release_state(uuid)')),
td AS (SELECT * FROM f WHERE oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)')),
api(sig) AS (VALUES ('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)'), ('public.reopen_job(uuid,text)'), ('public.release_job_early(uuid,text)')),
internal(sig) AS (VALUES ('public.job_early_release_active(uuid)'), ('public.job_finish_draft_invoice(uuid,uuid)'), ('public.jobs_flow_log()'), ('public.jobs_finish_kept()'),
                         ('public.job_inspections_evidence()'), ('public.job_inspections_immutable()'), ('public.job_flow_events_immutable()'),
                         ('public.delivery_notes_release_gate()'), ('public.invoices_job_release_gate()')),
trg AS (
  SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled = 'O'
)
SELECT 'job_release_state_is_081' AS check_name, (SELECT md5(body) = 'c16ea537b0b5706ab6db6e160214e17d' FROM rs) AS ok
-- 037's body exactly, but for the released line (Complete, or an admin's early release).
UNION ALL SELECT 'job_release_state_only_released_line_changed',
  (SELECT md5(replace(body, '--081(ISO90018.6):releasedonlywhenthejobisComplete(passed,oranadmin''sconcession,withnothinginrework),oran--adminreleaseditearlywithareason(job_early_release_active).Apartfailurenolongerreleasestherestbyitself:thejob--isputbacktoInprogress,andonlyanearlyreleaseletstheunaffectedpartgo(whatisheldstaysheld).v_rel:=(v_job.inspected_atISNOTNULLANDv_live=0)ORpublic.job_early_release_active(p_job);', 'v_rel:=(v_job.inspected_atISNOTNULLANDv_live=0)OR(v_live>0ANDNOTv_whole);')) = 'a7454c7da7ee23564436acfa6a330cd6' FROM rs)
UNION ALL SELECT 'job_release_state_security_unchanged',
  (SELECT prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=pg_catalog, public'] AND has_function_privilege('authenticated', oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM rs)
UNION ALL SELECT 'delivery_note_try_draft_is_081', (SELECT md5(body) = '52a9771fec832f0e20e9d780e7561caa' FROM td)
-- 059's body exactly, but for the step that puts a note on its job's invoice.
UNION ALL SELECT 'delivery_note_try_draft_only_link_added',
  (SELECT md5(replace(replace(body, 'v_job_invUUID;', ''), '--081:thenote''sjobalreadyhasitsinvoice(thedraftmadewhenthejobwasfinished,oranyliveinvoicemadeforthejob):--thenotegoesonthatone,soonejobnevergetsaseconddraft.Adraftfirst,thentheoldest.SELECTi.idINTOv_job_invFROMpublic.delivery_notesdJOINpublic.invoicesiONi.job_id=d.job_idANDi.organization_id=d.organization_idWHEREd.id=p_noteANDd.job_idISNOTNULLANDlower(coalesce(i.status,''draft''))NOTIN(''void'',''voided'',''cancelled'',''canceled'')ORDERBY(lower(coalesce(i.status,''draft''))=''draft'')DESC,i.created_at,i.idLIMIT1;IFv_job_invISNOTNULLTHENPERFORMset_config(''quoteflow.delivery_note_invoice'',p_note::TEXT,TRUE);UPDATEpublic.delivery_notesSETinvoice_id=v_job_invWHEREid=p_note;PERFORMset_config(''quoteflow.delivery_note_invoice'','''',TRUE);PERFORMsecurity_audit.log_named_event(p_org,''LINK_JOB_INVOICE'',''delivery_notes'',p_note::TEXT,jsonb_build_object(''invoice_id'',v_job_inv,''cause'',p_cause));RETURN''linked'';ENDIF;', '')) = 'ef7acce200b6f0349c84f076725d77c1' FROM td)
UNION ALL SELECT 'delivery_note_try_draft_internal',
  (SELECT prosecdef AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
          AND NOT has_function_privilege('service_role', oid, 'EXECUTE') AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM td)
-- The new calls: SECURITY DEFINER, the second-step check first, signed-in users only.
UNION ALL SELECT 'api_functions_signed_in_only',
  (SELECT bool_and(to_regprocedure(sig) IS NOT NULL AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(sig))
                   AND position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure(sig))) > 0
                   AND has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE') AND NOT has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE')
                   AND NOT has_function_privilege('public', to_regprocedure(sig), 'EXECUTE')) FROM api)
UNION ALL SELECT 'helpers_internal',
  (SELECT bool_and(to_regprocedure(sig) IS NOT NULL AND NOT has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE')
                   AND NOT has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE') AND NOT has_function_privilege('public', to_regprocedure(sig), 'EXECUTE')) FROM internal)
-- The flow status is worked out by the database from the job's own row (public.flow_status(job): nothing stored), for signed-in users.
UNION ALL SELECT 'flow_status_function',
  to_regprocedure('public.flow_status(public.jobs)') IS NOT NULL AND has_function_privilege('authenticated', to_regprocedure('public.flow_status(public.jobs)'), 'EXECUTE')
  AND NOT has_function_privilege('anon', to_regprocedure('public.flow_status(public.jobs)'), 'EXECUTE')
UNION ALL SELECT 'flow_status_mapping',
  NOT EXISTS (SELECT 1 FROM public.jobs j WHERE public.flow_status(j) IS DISTINCT FROM CASE WHEN j.stage IS NOT DISTINCT FROM 'rework' THEN 'in_progress'
                                                                                     WHEN j.inspected_at IS NOT NULL THEN 'complete'
                                                                                     WHEN j.finished_at IS NOT NULL THEN 'finished' ELSE 'in_progress' END)
-- The history: RLS on, read only for signed-in members of the company, never changed or removed, audited, the company tables' guards.
UNION ALL SELECT 'job_flow_events_read_only',
  (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.job_flow_events'::regclass)
  AND has_table_privilege('authenticated', 'public.job_flow_events', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.job_flow_events', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.job_flow_events', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.job_flow_events', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.job_flow_events', 'SELECT')
  AND (SELECT count(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_flow_events' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE')
UNION ALL SELECT 'job_flow_events_triggers',
  (SELECT count(*) = 7 FROM trg WHERE relname = 'job_flow_events' AND tgname IN ('job_flow_events_immutable', 'job_flow_events_no_truncate', 'audit_job_flow_events_changes',
                                                                                 'support_read_only', 'admin_mfa', 'zz_same_org_job_id', 'zz_same_org_inspection_id'))
-- The inspection record: the evidence and independence on the record itself, immutable, audited; still no write grant for the API.
UNION ALL SELECT 'job_inspections_evidence_immutable_audited',
  (SELECT count(*) = 4 FROM trg WHERE relname = 'job_inspections' AND tgname IN ('job_inspections_evidence', 'job_inspections_immutable', 'job_inspections_no_truncate', 'audit_job_inspections_changes'))
  AND NOT has_table_privilege('authenticated', 'public.job_inspections', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.job_inspections', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.job_inspections', 'DELETE')
UNION ALL SELECT 'job_inspections_columns_and_rules',
  (SELECT count(*) = 7 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_inspections'
     AND column_name IN ('acceptance_criteria', 'independent', 'override_reason', 'disposition', 'disposition_by', 'finisher_ids', 'client_op_id'))
  AND (SELECT count(*) = 4 FROM pg_constraint WHERE conrelid = 'public.job_inspections'::regclass
         AND conname IN ('job_inspections_criteria_shape', 'job_inspections_override_has_reason', 'job_inspections_disposition_shape', 'job_inspections_client_op'))
-- The flow on jobs, and the release gates on delivery notes and invoices.
UNION ALL SELECT 'job_triggers', (SELECT count(*) = 2 FROM trg WHERE relname = 'jobs' AND tgname IN ('ad_finish_kept', 'zz_jobs_flow_log'))
UNION ALL SELECT 'release_gates', EXISTS (SELECT 1 FROM trg WHERE relname = 'delivery_notes' AND tgname = 'delivery_notes_release_gate')
                                  AND EXISTS (SELECT 1 FROM trg WHERE relname = 'invoices' AND tgname = 'invoices_job_release_gate');
