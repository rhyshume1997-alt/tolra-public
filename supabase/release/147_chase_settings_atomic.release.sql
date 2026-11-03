-- REVIEW ONLY. Phase 147: chase atomic settings, after the candidate's 145/146 phases.
-- Runtime prerequisite is the entire frozen 138 verification, not merely a table name.
-- Never part of numbered baseline replay. No costing package included.
BEGIN;
DO $post_release_guard$
DECLARE v_check record; v_count integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(147138);
 IF to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION '147: atomic chase settings already exist; stop, never overwrite';
 END IF;
 FOR v_check IN
-- Migration 138 (late-payer chasing: steps, pauses, drafts for approval). Read only: every row should be TRUE (12). Bodies are compared with
-- every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.chase_create_draft(uuid,uuid,uuid,text,text,text,text,uuid)'), to_regprocedure('public.chase_record_sent(uuid,uuid,uuid,uuid)'))
), t AS (
  SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('chase_steps', 'chase_pauses', 'chase_sends')
)
-- The two server-only functions are 138's bodies.
SELECT 'chase_functions_are_138' AS check_name,
  (SELECT count(*) = 2 FROM fn WHERE (proname, body) IN (('chase_create_draft', '5452f25d1f364e3915e01db2cfed2fee'), ('chase_record_sent', '213c534d5aeb25f0d14f9070396faf76'))) AS ok
-- Definer, search_path pinned, the service role only (not authenticated, anon or PUBLIC).
UNION ALL SELECT 'chase_functions_definer_pinned_service_only',
  (SELECT count(*) = 2 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
            AND has_function_privilege('service_role', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
            AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) FROM fn)
-- The three tables, each row-secured.
UNION ALL SELECT 'chase_tables_row_secured', (SELECT count(*) = 3 AND bool_and(relrowsecurity) FROM t)
-- Policies: steps (members read; admin/office write: 4), pauses (admin/office: 4), sends (admin/office read only: 1).
UNION ALL SELECT 'chase_policies',
  (SELECT count(*) FILTER (WHERE tablename = 'chase_steps') = 4 AND count(*) FILTER (WHERE tablename = 'chase_pauses') = 4
          AND count(*) FILTER (WHERE tablename = 'chase_sends') = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('chase_steps', 'chase_pauses', 'chase_sends'))
-- chase_sends: the API can read it only; nobody signed in writes it.
UNION ALL SELECT 'chase_sends_server_written',
  has_table_privilege('authenticated', 'public.chase_sends', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.chase_sends', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.chase_sends', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.chase_sends', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.chase_sends', 'SELECT') AND NOT has_table_privilege('anon', 'public.chase_steps', 'SELECT') AND NOT has_table_privilege('anon', 'public.chase_pauses', 'SELECT')
-- At most once per invoice per step.
UNION ALL SELECT 'chase_sends_one_per_step',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.chase_sends') AND conname = 'chase_sends_one_per_step' AND pg_get_constraintdef(oid) = 'UNIQUE (invoice_id, step_id)')
-- support_read_only and admin_mfa on all three tables.
UNION ALL SELECT 'chase_guards',
  (SELECT count(*) = 6 FROM pg_trigger g JOIN t ON t.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgname IN ('support_read_only', 'admin_mfa'))
-- 106's template keys plus the three chase texts.
UNION ALL SELECT 'email_templates_key_138',
  (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.email_templates'::regclass AND c.conname = 'email_templates_key')
    = 'CHECK ((key = ANY (ARRAY[''quote''::text, ''invoice''::text, ''purchase_order''::text, ''delivery_note''::text, ''invoice_reminder''::text, ''timesheet''::text, ''job_to_workshop''::text, ''rfq_clarify''::text, ''chase_before_due''::text, ''chase_firm''::text, ''chase_final''::text])))'
-- 076's invoice_issue_lock with the four claim columns open (138's body), and the claim guard trigger.
UNION ALL SELECT 'invoice_issue_lock_is_138',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'aa8c9f3ae3035d0ed566723a28edd827' FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_issue_lock()')), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid WHERE g.tgrelid = 'public.invoices'::regclass AND g.tgname = 'invoices_payment_claim_guard' AND NOT g.tgisinternal
              AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '7f540f262f12c85432b5a5172442d005' AND NOT p.prosecdef)
-- The payment-claim functions are 138's bodies.
UNION ALL SELECT 'payment_claim_functions_are_138',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '1ee5cb529645fd03263bd9e481864b1d' FROM pg_proc p WHERE p.oid = to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)')), FALSE)
  AND coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'd3cbee1ab48f8e29d20fe23f8d8603fd' FROM pg_proc p WHERE p.oid = to_regprocedure('public.resolve_payment_claim(uuid,text)')), FALSE)
-- Definer, pinned; mark: signed-in and the service role; resolve: signed-in only; never anon or PUBLIC.
UNION ALL SELECT 'payment_claim_definer_pinned_granted',
  (SELECT count(*) = 2 AND bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)'), to_regprocedure('public.resolve_payment_claim(uuid,text)')))
  AND has_function_privilege('service_role', 'public.mark_payment_claimed(uuid,text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.resolve_payment_claim(uuid,text)', 'EXECUTE')
-- The four columns, and the source's two values.
UNION ALL SELECT 'payment_claim_columns',
  (SELECT count(*) = 4 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices'
     AND (column_name, data_type) IN (('payment_claimed_at', 'timestamp with time zone'), ('payment_claim_source', 'text'), ('payment_claim_evidence', 'text'), ('payment_claim_message_id', 'text')))
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.invoices'::regclass AND conname = 'invoices_payment_claim_source'
              AND pg_get_constraintdef(oid) = 'CHECK ((payment_claim_source = ANY (ARRAY[''email''::text, ''manual''::text])))')
 LOOP
  v_count:=v_count+1;
  IF v_check.ok IS DISTINCT FROM true THEN RAISE EXCEPTION '147: required verified 138 failed: %',v_check.check_name; END IF;
 END LOOP;
 IF v_count<>12 THEN RAISE EXCEPTION '147: expected all 12 frozen 138 verification checks'; END IF;
END $post_release_guard$;

-- REVIEW PROPOSAL ONLY. Depends on 138. Not a numbered migration; not applied by builder2.
-- One transaction, same company/roles/RLS as 138; existing offset IDs are preserved.
CREATE FUNCTION public.save_chase_steps_atomic(p_org uuid, p_expected jsonb, p_steps jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.current_user_organization_id(); v_current jsonb; v_expected jsonb; v_session jsonb;
BEGIN
  PERFORM public.assert_privileged_aal();
  SELECT public.my_session() INTO v_session;
  IF auth.uid() IS NULL OR v_org IS NULL OR p_org IS DISTINCT FROM v_org OR NOT public.has_org_role(ARRAY['admin','office'])
     OR coalesce((v_session->>'support')::boolean,false) OR coalesce((v_session->>'read_only')::boolean,false) THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_expected) IS DISTINCT FROM 'array' OR jsonb_typeof(p_steps) IS DISTINCT FROM 'array' OR jsonb_array_length(p_steps)>10 THEN
    RAISE EXCEPTION 'Invalid chase steps' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_steps) x WHERE NOT (x ? 'days' AND x ? 'tone') OR jsonb_typeof(x->'days')<>'number' OR (x->>'days') !~ '^-?[0-9]+$'
             OR (x->>'days')::integer NOT BETWEEN -60 AND 365 OR x->>'tone' NOT IN ('before_due','friendly','firm','final')
             OR (((x->>'days')::integer<=0) IS DISTINCT FROM (x->>'tone'='before_due')))
     OR (SELECT count(DISTINCT (x->>'days')::integer) FROM jsonb_array_elements(p_steps) x)<>jsonb_array_length(p_steps) THEN
    RAISE EXCEPTION 'Invalid chase steps' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chase-steps:'||v_org::text,0));
  PERFORM 1 FROM public.chase_steps WHERE organization_id=v_org ORDER BY id FOR UPDATE;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'days',offset_days,'tone',tone) ORDER BY offset_days,id),'[]'::jsonb) INTO v_current FROM public.chase_steps WHERE organization_id=v_org;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','days',(x->>'days')::integer,'tone',x->>'tone') ORDER BY (x->>'days')::integer,x->>'id'),'[]'::jsonb) INTO v_expected FROM jsonb_array_elements(p_expected) x;
  IF v_current IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Chase settings changed; reload before saving' USING ERRCODE='40001'; END IF;
  DELETE FROM public.chase_steps s WHERE s.organization_id=v_org AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_steps) x WHERE (x->>'days')::integer=s.offset_days);
  UPDATE public.chase_steps s SET tone=x->>'tone' FROM jsonb_array_elements(p_steps) x WHERE s.organization_id=v_org AND s.offset_days=(x->>'days')::integer AND s.tone IS DISTINCT FROM x->>'tone';
  INSERT INTO public.chase_steps(organization_id,offset_days,tone) SELECT v_org,(x->>'days')::integer,x->>'tone' FROM jsonb_array_elements(p_steps) x WHERE NOT EXISTS (SELECT 1 FROM public.chase_steps s WHERE s.organization_id=v_org AND s.offset_days=(x->>'days')::integer);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'days',offset_days,'tone',tone) ORDER BY offset_days,id),'[]'::jsonb) INTO v_current FROM public.chase_steps WHERE organization_id=v_org;
  RETURN v_current;
END $$;
REVOKE ALL ON FUNCTION public.save_chase_steps_atomic(uuid,jsonb,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.save_chase_steps_atomic(uuid,jsonb,jsonb) TO authenticated;

DO $verify_release$
DECLARE v_check record; v_count integer:=0;
BEGIN
 FOR v_check IN
WITH f AS (SELECT * FROM pg_proc WHERE oid=to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)'))
SELECT '147 body checksum' AS check_name, coalesce((SELECT md5(regexp_replace(prosrc,'\s','','g'))='63145f3026fdc7db5dc1ba0a5928177a' FROM f),false) AS ok
UNION ALL SELECT '147 invoker and pinned path', coalesce((SELECT NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public'] AND prorettype='jsonb'::regtype AND provolatile='v' FROM f),false)
UNION ALL SELECT '147 authenticated only API grant', coalesce((SELECT has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('service_role',oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') FROM f),false)
UNION ALL SELECT '147 underlying RLS retained', coalesce((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.chase_steps')),false)
 LOOP
  v_count:=v_count+1;
  IF v_check.ok IS DISTINCT FROM true THEN RAISE EXCEPTION '147 self-check failed: %',v_check.check_name; END IF;
 END LOOP;
 IF v_count<>4 THEN RAISE EXCEPTION '147 verification incomplete'; END IF;
END $verify_release$;
COMMIT;
