-- REVIEW PROPOSAL ONLY, SUPERSEDED. The hardened version of this function now ships INSIDE numbered release 143 (supabase/migrations/143_costing_rates.sql, section 5:
-- same signature; adds shape and range validation to 22023 before any write, unchanged rows left alone, id-case-insensitive comparison, 500-row limit also on p_expected,
-- EXECUTE for authenticated only). This file is the original reviewed text, kept for tests/postgres/atomic-settings.test.mjs (its own fixture) and never applied to a real database.
CREATE OR REPLACE FUNCTION public.save_costing_settings_txn(p_org uuid,p_expected jsonb,p_value jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE v_org uuid:=public.current_user_organization_id(); v_current jsonb; v_expected jsonb; v_session jsonb;
BEGIN
  PERFORM public.assert_privileged_aal(); SELECT public.my_session() INTO v_session;
  IF auth.uid() IS NULL OR p_org IS DISTINCT FROM v_org OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin','office']) OR coalesce((v_session->>'support')::boolean,false) OR coalesce((v_session->>'read_only')::boolean,false) THEN RAISE EXCEPTION 'Not permitted' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_expected->'materials') IS DISTINCT FROM 'array' OR jsonb_typeof(p_expected->'machines') IS DISTINCT FROM 'array' OR jsonb_typeof(p_value->'materials') IS DISTINCT FROM 'array' OR jsonb_typeof(p_value->'machines') IS DISTINCT FROM 'array' OR jsonb_typeof(p_value->'defaults') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid settings' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_value->'materials')>500 OR jsonb_array_length(p_value->'machines')>500 THEN RAISE EXCEPTION 'Too many rates' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('costing-settings:'||v_org::text,0));
  PERFORM 1 FROM public.costing_materials WHERE organization_id=v_org ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.costing_machines WHERE organization_id=v_org ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.costing_defaults WHERE organization_id=v_org FOR UPDATE;
  SELECT jsonb_build_object('materials',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'price_pence',price_pence,'price_unit',price_unit,'scrap_pct',scrap_pct) ORDER BY id) FROM public.costing_materials WHERE organization_id=v_org),'[]'::jsonb),
  'machines',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'hourly_rate_pence',hourly_rate_pence,'labour_rate_pence',labour_rate_pence) ORDER BY id) FROM public.costing_machines WHERE organization_id=v_org),'[]'::jsonb),
  'defaults',(SELECT jsonb_build_object('labour_rate_pence',labour_rate_pence,'programming_rate_pence',programming_rate_pence,'overhead_pct',overhead_pct,'default_margin_pct',default_margin_pct) FROM public.costing_defaults WHERE organization_id=v_org)) INTO v_current;
  v_expected:=p_expected || jsonb_build_object('materials',coalesce((SELECT jsonb_agg(x ORDER BY x->>'id') FROM jsonb_array_elements(p_expected->'materials') x),'[]'::jsonb),'machines',coalesce((SELECT jsonb_agg(x ORDER BY x->>'id') FROM jsonb_array_elements(p_expected->'machines') x),'[]'::jsonb));
  IF v_expected IS DISTINCT FROM v_current THEN RAISE EXCEPTION 'Settings changed; reload' USING ERRCODE='40001'; END IF;
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_value->'materials') x)<>jsonb_array_length(p_value->'materials') OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_value->'machines') x)<>jsonb_array_length(p_value->'machines') THEN RAISE EXCEPTION 'Repeated rate ID' USING ERRCODE='22023'; END IF;
  DELETE FROM public.costing_materials s WHERE s.organization_id=v_org AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_value->'materials') x WHERE (x->>'id')::uuid=s.id);
  DELETE FROM public.costing_machines s WHERE s.organization_id=v_org AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_value->'machines') x WHERE (x->>'id')::uuid=s.id);
  INSERT INTO public.costing_materials(id,organization_id,name,price_pence,price_unit,scrap_pct) SELECT (x->>'id')::uuid,v_org,x->>'name',(x->>'price_pence')::integer,x->>'price_unit',(x->>'scrap_pct')::numeric FROM jsonb_array_elements(p_value->'materials') x
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,price_pence=excluded.price_pence,price_unit=excluded.price_unit,scrap_pct=excluded.scrap_pct WHERE costing_materials.organization_id=v_org;
  INSERT INTO public.costing_machines(id,organization_id,name,hourly_rate_pence,labour_rate_pence) SELECT (x->>'id')::uuid,v_org,x->>'name',(x->>'hourly_rate_pence')::integer,(x->>'labour_rate_pence')::integer FROM jsonb_array_elements(p_value->'machines') x
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,hourly_rate_pence=excluded.hourly_rate_pence,labour_rate_pence=excluded.labour_rate_pence WHERE costing_machines.organization_id=v_org;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_value->'materials') x WHERE NOT EXISTS(SELECT 1 FROM public.costing_materials s WHERE s.organization_id=v_org AND s.id=(x->>'id')::uuid)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_value->'machines') x WHERE NOT EXISTS(SELECT 1 FROM public.costing_machines s WHERE s.organization_id=v_org AND s.id=(x->>'id')::uuid)) THEN RAISE EXCEPTION 'Invalid rate ID' USING ERRCODE='42501'; END IF;
  INSERT INTO public.costing_defaults(organization_id,labour_rate_pence,programming_rate_pence,overhead_pct,default_margin_pct) VALUES(v_org,(p_value#>>'{defaults,labour_rate_pence}')::integer,(p_value#>>'{defaults,programming_rate_pence}')::integer,(p_value#>>'{defaults,overhead_pct}')::numeric,(p_value#>>'{defaults,default_margin_pct}')::numeric)
    ON CONFLICT(organization_id) DO UPDATE SET labour_rate_pence=excluded.labour_rate_pence,programming_rate_pence=excluded.programming_rate_pence,overhead_pct=excluded.overhead_pct,default_margin_pct=excluded.default_margin_pct;
END $$;
REVOKE ALL ON FUNCTION public.save_costing_settings_txn(uuid,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_costing_settings_txn(uuid,jsonb,jsonb) TO authenticated;
