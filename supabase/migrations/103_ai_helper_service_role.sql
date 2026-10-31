-- =====================================================================================================
-- 103: the AI helper's key and settle are the server's (pre-go-live security review, S2/S3). Needs 101 (the AI helper) and ships WITH
-- it: production applies 101 and then 103. On a database without 101 the guard (section 1) stops it before anything changes (one
-- transaction: nothing of 103 is kept). If 101 were ever re-run after 103, run 103 again (101 puts back its reserve, settle and settle
-- grant). INDEPENDENT OF 102 (touches none of its objects). Safe to run again.
--
-- WHAT CHANGES.
--   a. S2. ai_helper_reserve (101) no longer hands the company's encrypted key back to the signed-in session (admin or office could
--      read it from the RPC answer). The server reads it itself with the service role, after its own checks and a successful
--      reservation (lib/ai-helper/server.ts). Same signature, same checks, same cap arithmetic; the answer is { ok, request_id }.
--   b. S3. ai_helper_settle (101) is callable by the service role only (no longer by authenticated): an office user could settle their
--      own request directly with made-up output, any model and cost 0 (a fake ai_helper_suggested event and suggestion, under-recorded
--      spend). Settle now takes the company and the person from the request row (the service role has no person); its audit row still
--      names the person who asked. Same signature, same checks on the result, same ledger arithmetic.
--   c. GRANT SELECT ON ai_helper_secrets TO service_role (it already had it through Supabase's default privileges; stated here). No
--      signed-in role gains anything.
-- GUARD (section 1): 101's objects are there and the two bodies 103 replaces are 101's (or already 103's), compared without
-- whitespace. SELF-CHECK (section 4). Verify: supabase/verify/ai_helper_service_role_103.sql (every row TRUE).
-- Rollback: supabase/release/103_ai_helper_service_role.rollback.sql (puts 101's two bodies and 101's settle grant back; Rhys's
-- approval). The app keeps working after a rollback (it reads the key and settles with the service role either way).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: 101 is there, and each body 103 replaces is 101's (or already 103's).
DO $$
BEGIN
  IF to_regclass('public.ai_helper_requests') IS NULL OR to_regclass('public.ai_helper_secrets') IS NULL
     OR to_regclass('public.ai_helper_usage') IS NULL OR to_regclass('public.ai_helper_settings') IS NULL
     OR to_regprocedure('public._ai_helper_caller(text[])') IS NULL OR to_regprocedure('public._ai_helper_audit(uuid,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)') IS NULL
     OR to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '103: the AI helper (101) is not applied; apply 101 first';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'))
       NOT IN ('8b9a4ec9293a5b6f0ddc8e505822c84f', 'c75e470a73e4d0e7508a27125f6f9e9c') THEN
    RAISE EXCEPTION '103: public.ai_helper_reserve is neither 101''s nor 103''s; stop and compare it first';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)'))
       NOT IN ('cd5ac6d43f9a5ade20815a82ed123717', 'ca5166191666584107491f95ccce4702') THEN
    RAISE EXCEPTION '103: public.ai_helper_settle is neither 101''s nor 103''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. S2: the key never goes back to a signed-in session.
-- 101's body; the answer is { ok: true, request_id } (no key_enc). The server reads the key itself with the service role.
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

-- -----------------------------------------------------------------------------------------------------
-- 3. S3: only the server (service role) settles a request.
-- The server (service role), after the model answered (or failed), for the request it reserved under the person's own session: the
-- actual cost (never above the reservation) moves to spent, the reservation is released, and the validated suggestion is kept (status
-- suggested), or the failure is recorded (status failed). Once per request. 101's checks on the result and its ledger arithmetic; the
-- company and the person come from the request row, and the audit row names that person.
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
-- The server reads the company's (encrypted) key with the service role; no signed-in role gains anything.
GRANT SELECT ON public.ai_helper_secrets TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check: settle is the service role's only, reserve's answer carries no key, the key table grants no signed-in role.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '103: ai_helper_settle is not service-role only';
  END IF;
  IF position('''key_enc''' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'))) > 0
     OR NOT has_function_privilege('authenticated', 'public.ai_helper_reserve(text,integer,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '103: ai_helper_reserve still returns the key, or is no longer callable by signed-in users';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_helper_secrets', 'SELECT') OR has_table_privilege('anon', 'public.ai_helper_secrets', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.ai_helper_secrets', 'SELECT') THEN
    RAISE EXCEPTION '103: the key table is readable by a signed-in role, or not by the service role';
  END IF;
END
$$;
