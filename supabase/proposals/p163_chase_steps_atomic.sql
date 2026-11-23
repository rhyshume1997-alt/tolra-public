-- Release 163 proposal (canonical source of supabase/release/163_chase_steps_atomic.release.sql; its body below is copied into that file verbatim, and
-- scripts/check-release-plan.mjs fails if the two drift). Adds the one function the chase steps screen already calls and production lacks:
-- public.save_chase_steps_atomic(p_org uuid, p_expected jsonb, p_steps jsonb). It needs release 138 (chase_steps and its guard) only; nothing from 162.
-- SECURITY INVOKER (138's row security still applies), search_path pg_catalog, public; admin and office of the caller's own company only; support and
-- read-only sessions and the second-step rule refused; at most 10 steps; a stale snapshot is refused 40001; existing step ids are kept. The function text is
-- the reviewed proposal supabase/proposals/builder2_chase_settings_atomic.sql, unchanged. Not applied anywhere hosted.
BEGIN;
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
COMMIT;
