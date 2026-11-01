-- 133 rollback: ONLY with Rhys's approval. Puts back 103's public.ai_helper_reserve and public.ai_helper_settle byte for byte (same
-- signatures, security, search_path and grants) and drops public.ai_helper_purge_requests. No row is changed: requests already charged
-- in full by 133's sweep keep that charge (cost_pence set); after the rollback a request left open is released again (103), and nothing
-- deletes old requests until 133 is applied again (the nightly cron then answers "skipped: not configured"). Run the whole text as one
-- transaction, then the release preflight (marker 133 shows "not applied") and supabase/verify/ai_helper_service_role_103.sql (TRUE).
BEGIN;
DO $$
DECLARE
  v_reserve TEXT;
  v_settle  TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)') INTO v_reserve;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)') INTO v_settle;
  -- 972540e8...: 133's reserve; c75e470a...: 103's (a second run of this rollback).
  IF v_reserve IS NULL OR v_reserve NOT IN ('972540e833a42bbb35ac5b670c56daa8', 'c75e470a73e4d0e7508a27125f6f9e9c') THEN
    RAISE EXCEPTION '133 rollback: ai_helper_reserve (md5 %) is neither 133''s nor 103''s; stop and compare', coalesce(v_reserve, 'missing');
  END IF;
  -- 7e04d0ab...: 133's settle; ca516619...: 103's.
  IF v_settle IS NULL OR v_settle NOT IN ('7e04d0ab645ec24dc0f0acb78c222702', 'ca5166191666584107491f95ccce4702') THEN
    RAISE EXCEPTION '133 rollback: ai_helper_settle (md5 %) is neither 133''s nor 103''s; stop and compare', coalesce(v_settle, 'missing');
  END IF;
END
$$;

-- 103's ai_helper_reserve, verbatim (supabase/migrations/103_ai_helper_service_role.sql section 2).
CREATE OR REPLACE FUNCTION public.ai_helper_reserve(p_feature TEXT, p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public._ai_helper_caller(ARRAY['admin', 'office']);
  v_month  DATE := date_trunc('month', now() AT TIME ZONE 'Europe/London')::DATE;
  v_set    public.ai_helper_settings%ROWTYPE;
  v_key    TEXT;
  v_ok     BOOLEAN := FALSE;
  v_reason TEXT;
  v_id     UUID;
BEGIN
  IF p_feature IS NULL OR p_feature NOT IN ('roundup', 'rfq') OR p_estimate_pence IS NULL OR p_estimate_pence NOT BETWEEN 1 AND 1000
     OR p_input_digest IS NULL OR p_input_digest !~ '^[0-9a-f]{64}$' OR p_input_bytes IS NULL OR p_input_bytes NOT BETWEEN 0 AND 200000 THEN
    RAISE EXCEPTION 'Invalid AI helper request.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_set FROM public.ai_helper_settings s WHERE s.organization_id = v_org;
  IF NOT coalesce(CASE p_feature WHEN 'roundup' THEN v_set.roundup_enabled ELSE v_set.rfq_enabled END, FALSE) THEN
    RAISE EXCEPTION 'The AI helper is off for this company.' USING ERRCODE = '42501', HINT = 'ai_helper_off';
  END IF;

  -- Reservations a request never settled (10 minutes is far past the app's own timeout) are released.
  WITH stale AS (
    UPDATE public.ai_helper_requests r SET status = 'expired', settled_at = now()
    WHERE r.organization_id = v_org AND r.status = 'reserved' AND r.created_at < now() - interval '10 minutes'
    RETURNING r.month, r.reserved_pence
  )
  UPDATE public.ai_helper_usage u SET reserved_pence = greatest(0, u.reserved_pence - s.total), updated_at = now()
  FROM (SELECT month, sum(reserved_pence)::INTEGER AS total FROM stale GROUP BY month) s
  WHERE u.organization_id = v_org AND u.month = s.month;

  SELECT k.api_key_enc INTO v_key FROM public.ai_helper_secrets k WHERE k.organization_id = v_org;
  IF v_key IS NULL THEN
    v_reason := 'no_key';
  ELSE
    INSERT INTO public.ai_helper_usage (organization_id, month) VALUES (v_org, v_month) ON CONFLICT (organization_id, month) DO NOTHING;
    UPDATE public.ai_helper_usage u SET reserved_pence = u.reserved_pence + p_estimate_pence, updated_at = now()
    WHERE u.organization_id = v_org AND u.month = v_month
      AND u.reserved_pence + u.spent_pence + p_estimate_pence
          <= (SELECT s.monthly_cap_pence FROM public.ai_helper_settings s WHERE s.organization_id = v_org)
    RETURNING TRUE INTO v_ok;
    IF NOT coalesce(v_ok, FALSE) THEN v_reason := 'cap'; END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ai_helper_requests (organization_id, user_id, feature, month, status, refusal, input_digest, input_bytes, settled_at)
    VALUES (v_org, auth.uid(), p_feature, v_month, 'refused', v_reason, p_input_digest, p_input_bytes, now())
    RETURNING id INTO v_id;
    PERFORM public._ai_helper_audit(v_org, 'ai_helper_refused', 'ai_helper_requests', v_id::TEXT,
      jsonb_build_object('feature', p_feature, 'reason', v_reason, 'estimate_pence', p_estimate_pence));
    RETURN jsonb_build_object('ok', FALSE, 'reason', v_reason, 'request_id', v_id);
  END IF;

  INSERT INTO public.ai_helper_requests (organization_id, user_id, feature, month, status, input_digest, input_bytes, reserved_pence)
  VALUES (v_org, auth.uid(), p_feature, v_month, 'reserved', p_input_digest, p_input_bytes, p_estimate_pence)
  RETURNING id INTO v_id;
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_requested', 'ai_helper_requests', v_id::TEXT,
    jsonb_build_object('feature', p_feature, 'input_bytes', p_input_bytes, 'estimate_pence', p_estimate_pence));
  RETURN jsonb_build_object('ok', TRUE, 'request_id', v_id);
END
$$;


-- 103's ai_helper_settle and its grant, verbatim (103 section 3).
CREATE OR REPLACE FUNCTION public.ai_helper_settle(p_request UUID, p_status TEXT, p_failure TEXT, p_cost_pence INTEGER, p_model TEXT, p_output JSONB)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_req  public.ai_helper_requests%ROWTYPE;
  v_cost INTEGER;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('suggested', 'failed')
     OR (p_status = 'failed' AND (p_failure IS NULL OR p_failure NOT IN ('unavailable', 'refused', 'invalid') OR p_output IS NOT NULL))
     OR (p_status = 'suggested' AND (p_failure IS NOT NULL OR p_output IS NULL OR jsonb_typeof(p_output) <> 'object' OR octet_length(p_output::TEXT) > 32768))
     OR (p_model IS NOT NULL AND p_model !~ '^[a-z0-9.-]{1,64}$') THEN
    RAISE EXCEPTION 'Invalid AI helper result.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req FROM public.ai_helper_requests r WHERE r.id = p_request FOR UPDATE;
  -- Open: still reserved, or expired by a later reserve before this answer came back (released, not yet settled).
  IF NOT FOUND OR NOT (v_req.status = 'reserved' OR (v_req.status = 'expired' AND v_req.cost_pence IS NULL)) THEN
    RAISE EXCEPTION 'This AI helper request is not open.' USING ERRCODE = '42501';
  END IF;
  v_cost := least(greatest(coalesce(p_cost_pence, 0), 0), v_req.reserved_pence);
  -- An expired request's reservation was already released by ai_helper_reserve: only the spend is added.
  UPDATE public.ai_helper_usage u
  SET reserved_pence = CASE WHEN v_req.status = 'reserved' THEN greatest(0, u.reserved_pence - v_req.reserved_pence) ELSE u.reserved_pence END,
      spent_pence = u.spent_pence + v_cost, updated_at = now()
  WHERE u.organization_id = v_req.organization_id AND u.month = v_req.month;
  UPDATE public.ai_helper_requests r
  SET status = p_status, failure = p_failure, cost_pence = v_cost, model = p_model, output = p_output, settled_at = now()
  WHERE r.id = v_req.id;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_req.organization_id, v_req.user_id, (SELECT p.email FROM public.user_profiles p WHERE p.id = v_req.user_id),
    CASE p_status WHEN 'suggested' THEN 'ai_helper_suggested' ELSE 'ai_helper_failed' END, 'ai_helper_requests', v_req.id::TEXT,
    jsonb_build_object('feature', v_req.feature, 'model', p_model, 'cost_pence', v_cost)
      || CASE WHEN p_failure IS NOT NULL THEN jsonb_build_object('reason', p_failure) ELSE '{}'::JSONB END
      || CASE WHEN jsonb_typeof(p_output -> 'lines') = 'array' THEN jsonb_build_object('lines', jsonb_array_length(p_output -> 'lines')) ELSE '{}'::JSONB END
      || jsonb_build_object('source', 'ai_helper'));
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_settle(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_settle(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB) TO service_role;

DROP FUNCTION IF EXISTS public.ai_helper_purge_requests(INTEGER);
COMMIT;
