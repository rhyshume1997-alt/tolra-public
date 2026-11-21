-- Post-144 release step 163 (the chase steps screen saves all its steps in one database call; registered in supabase/release-plan.json as
-- phase 163, after 154 and 156 to 160 and independent of 161 and 162; CI's post-144 step installs it). One transaction; never part of
-- baseline replay. Not applied anywhere hosted. Canonical source: supabase/proposals/p163_chase_steps_atomic.sql (its body between BEGIN; and
-- COMMIT; is copied below verbatim; scripts/check-release-plan.mjs fails if they drift). The function text is the reviewed proposal
-- supabase/proposals/builder2_chase_settings_atomic.sql, unchanged; that file stays and its own test reads it.
-- WHAT IT DOES: adds ONE new function, public.save_chase_steps_atomic(p_org uuid, p_expected jsonb, p_steps jsonb), that the app already
-- calls (lib/chase/ui-store.ts, from the invoice reminder card in Settings) and that production does not have, so saving changed chase steps
-- fails there today with "Could not save chase steps". It needs release 138 (the chase_steps table and its guard) and nothing else.
-- WHAT IT DOES NOT DO: no table, column, policy, trigger or other function is created, changed or dropped; no data is read or written;
-- nothing is gated (the app already calls it); AI, email sending and Xero are untouched.
-- HOW IT BEHAVES: SECURITY INVOKER (so 138's row security on chase_steps still applies), search_path pg_catalog, public. Admin and office
-- of the caller's own company only; support and read-only sessions refused; second step (assert_privileged_aal) first. At most 10 steps,
-- one per offset, offset -60..365, tone before_due exactly when the offset is 0 or less. One advisory lock per company; the caller must
-- send the steps it last read (p_expected): if they differ the call fails with 40001 and writes nothing. Existing step IDs are kept
-- (so send history stays linked); steps not in the new list are deleted, changed tones updated, new offsets inserted, all in one call.
-- EXECUTE: signed-in users (authenticated) and service_role only; not anon, not PUBLIC.
-- STATE is judged by the function's exact body (md5 of its source with every whitespace character removed, because an SQL-editor paste may
-- store CRLF): ABSENT (no function of this name in public): the release applies. INSTALLED (this body, invoker, pinned search_path, grants
-- as above): running again changes nothing. DRIFTED (any other body, security, search_path or another overload of the same name): the file
-- REFUSES with a message and changes nothing.
-- Verify: supabase/verify/chase_steps_atomic_163.sql (every row true). Rollback: supabase/release/163_chase_steps_atomic.rollback.sql
-- (drops only this function, so the database is exactly as before 163; steps already saved stay). Production only with Rhys's separate yes
-- on this exact file after a fresh backup.
-- Inputs: the database. Outputs: one function. Must not change: any other function (the self-check compares a fingerprint of every other
-- function in public and security_audit, with grants, before and after), chase_steps and chase_pauses (columns, constraints, triggers,
-- policies, grants, row security) and every row of chase_steps.
BEGIN;
DO $post_release_guard$
DECLARE
  v_oid OID := to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)');
  v_others INTEGER;
BEGIN
 IF to_regclass('public.chase_steps') IS NULL OR to_regclass('public.chase_pauses') IS NULL THEN
  RAISE EXCEPTION '163: public.chase_steps or public.chase_pauses is missing; apply release 138 first (see release preflight)';
 END IF;
 IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.chase_steps'::regclass AND t.tgname = 'chase_steps_guard' AND t.tgenabled = 'O') <> 1 THEN
  RAISE EXCEPTION '163: release 138''s chase_steps_guard trigger is missing or disabled; stop and run release preflight';
 END IF;
 IF to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public.my_session()') IS NULL
    OR to_regprocedure('public.has_org_role(text[])') IS NULL OR to_regprocedure('public.current_user_organization_id()') IS NULL THEN
  RAISE EXCEPTION '163: a helper it calls (assert_privileged_aal, my_session, has_org_role or current_user_organization_id) is missing; stop and run release preflight';
 END IF;
 SELECT count(*) INTO v_others FROM pg_catalog.pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'save_chase_steps_atomic' AND p.oid IS DISTINCT FROM v_oid;
 IF v_others > 0 THEN
  RAISE EXCEPTION '163: another function named save_chase_steps_atomic exists (a different argument list); stop and compare it first, nothing was changed';
 END IF;
 IF v_oid IS NOT NULL THEN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_oid AND NOT p.prosecdef
                   AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '63145f3026fdc7db5dc1ba0a5928177a') THEN
   RAISE EXCEPTION '163: public.save_chase_steps_atomic(uuid, jsonb, jsonb) exists but is not 163''s (body, security or search_path differ); stop and compare it first, nothing was changed';
  END IF;
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything 163 must not touch (every other function with its grants, chase_steps and chase_pauses structure
-- and the chase_steps rows). The self-check requires the identical fingerprint. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p163_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p163fp$
  SELECT 'every other function (name, args, security, config, body, grants)'::TEXT,
         md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), p.prosecdef::TEXT, coalesce(p.proconfig::TEXT, ''), md5(p.prosrc), coalesce(p.proacl::TEXT, ''))), '' ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), ''))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND NOT (n.nspname = 'public' AND p.proname = 'save_chase_steps_atomic')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 'chase_steps and chase_pauses: columns',
         md5(coalesce(string_agg(concat_ws('|', c.table_name, c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.table_name, c.ordinal_position), ''))
  FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('chase_steps', 'chase_pauses')
  UNION ALL SELECT 'chase_steps and chase_pauses: constraints',
         md5(coalesce(string_agg(concat_ws('|', k.conrelid::regclass::TEXT, k.conname, pg_catalog.pg_get_constraintdef(k.oid)), ';' ORDER BY k.conrelid::regclass::TEXT, k.conname), ''))
  FROM pg_catalog.pg_constraint k WHERE k.conrelid IN ('public.chase_steps'::regclass, 'public.chase_pauses'::regclass)
  UNION ALL SELECT 'chase_steps and chase_pauses: triggers',
         md5(coalesce(string_agg(concat_ws('|', t.tgrelid::regclass::TEXT, t.tgname, t.tgenabled::TEXT, pg_catalog.pg_get_triggerdef(t.oid)), ';' ORDER BY t.tgrelid::regclass::TEXT, t.tgname), ''))
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN ('public.chase_steps'::regclass, 'public.chase_pauses'::regclass)
  UNION ALL SELECT 'chase_steps and chase_pauses: policies',
         md5(coalesce(string_agg(concat_ws('|', p.tablename, p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, '')), ';' ORDER BY p.tablename, p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN ('chase_steps', 'chase_pauses')
  UNION ALL SELECT 'chase_steps and chase_pauses: row security, owner, grants',
         coalesce(string_agg(c.relname || '|' || c.relrowsecurity::TEXT || '|' || c.relforcerowsecurity::TEXT || '|' || c.relowner::regrole::TEXT || '|' || coalesce(c.relacl::TEXT, ''), ';' ORDER BY c.relname), '')
  FROM pg_catalog.pg_class c WHERE c.oid IN ('public.chase_steps'::regclass, 'public.chase_pauses'::regclass)
  UNION ALL SELECT 'chase_steps rows', md5(coalesce(string_agg(to_jsonb(s)::TEXT, ';' ORDER BY s.id), ''))
  FROM public.chase_steps s
$p163fp$;
CREATE TEMP TABLE p163_before ON COMMIT DROP AS SELECT * FROM pg_temp.p163_fingerprint();

-- ---- The function (the reviewed proposal's body, unchanged) ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_chase_steps_atomic(p_org uuid, p_expected jsonb, p_steps jsonb)
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
REVOKE ALL ON FUNCTION public.save_chase_steps_atomic(uuid,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_chase_steps_atomic(uuid,jsonb,jsonb) TO authenticated;

DO $p163_self_check$
DECLARE
  v_oid OID := to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '163 self-check: the function is missing';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'save_chase_steps_atomic') <> 1 THEN
    RAISE EXCEPTION '163 self-check: there must be exactly one function named save_chase_steps_atomic';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_oid AND NOT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND p.prorettype = 'jsonb'::regtype AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '63145f3026fdc7db5dc1ba0a5928177a') THEN
    RAISE EXCEPTION '163 self-check: the function must be invoker, with search_path pg_catalog, public, returning jsonb, with 163''s body (md5 63145f30...)';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '163 self-check: signed-in users must be able to execute the function and anon and PUBLIC must not';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p163_before EXCEPT SELECT * FROM pg_temp.p163_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p163_fingerprint() EXCEPT SELECT * FROM pg_temp.p163_before) THEN
    RAISE EXCEPTION '163 self-check: another function, chase_steps or chase_pauses (columns, constraints, triggers, policies, grants, row security) or a chase_steps row changed';
  END IF;
END
$p163_self_check$;
DROP TABLE pg_temp.p163_before;
DROP FUNCTION pg_temp.p163_fingerprint();
COMMIT;
