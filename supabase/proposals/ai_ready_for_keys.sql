-- AI READY FOR KEYS: proposal against main 68f89ca7, NOT in numbered baseline or the go-live release.
-- Requires 101/103/122/133/134. Review and authorise separately before any production use.
-- ONE existing per-company setting/usage ledger for RFQ, round-up and assistant, including own-key.
-- New/unconfigured companies default to 1000p. No existing row/cap/spend/key/switch is reset.
-- AI stays OFF by default. Finance check is deterministic, costs zero and calls no provider.
-- Cap setters and all three paid paths lock company settings before the usage row, so a cap change
-- cannot race a reservation against an old cap. No new policy, table, ledger or AI framework.
BEGIN;
DO $$ BEGIN
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_status()'))
    NOT IN ('3ef44c838451b46ea14030164d9b1384', 'a144add4b49efdc0b08fb9a3ad4657d9') OR to_regprocedure('public.ai_helper_status()') IS NULL THEN
    RAISE EXCEPTION 'AI READY: unexpected ai_helper_status; stop and compare the target version';
  END IF;
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_save_settings(boolean,boolean,integer)'))
    NOT IN ('70658b5b1ebd4547872d8d152c29fb56', 'e26d13bc31075b5633013db3345696c0') OR to_regprocedure('public.ai_helper_save_settings(boolean,boolean,integer)') IS NULL THEN
    RAISE EXCEPTION 'AI READY: unexpected ai_helper_save_settings; stop and compare the target version';
  END IF;
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'))
    NOT IN ('972540e833a42bbb35ac5b670c56daa8', '4f01eb3ad6e06cccbd53fb86482cd3d6') OR to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'AI READY: unexpected ai_helper_reserve; stop and compare the target version';
  END IF;
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)'))
    NOT IN ('f3e880f36702f8a1d358a4da194f7b5a', '8b8594f704c5cb1b8edf154c582ace36') OR to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'AI READY: unexpected ai_helper_reserve_assistant; stop and compare the target version';
  END IF;
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)')) IS DISTINCT FROM '7e04d0ab645ec24dc0f0acb78c222702' THEN
    RAISE EXCEPTION 'AI READY: expected 133 settlement; no ledger change attempted';
  END IF;
END $$;

ALTER TABLE public.ai_helper_settings ALTER COLUMN monthly_cap_pence SET DEFAULT 1000;

CREATE OR REPLACE FUNCTION public.ai_helper_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public._ai_helper_caller(ARRAY['admin', 'office']);
  v_admin BOOLEAN := public.has_org_role(ARRAY['admin']);
  v_month DATE := date_trunc('month', now() AT TIME ZONE 'Europe/London')::DATE;
  v_set   public.ai_helper_settings%ROWTYPE;
  v_use   public.ai_helper_usage%ROWTYPE;
BEGIN
  SELECT * INTO v_set FROM public.ai_helper_settings s WHERE s.organization_id = v_org;
  SELECT * INTO v_use FROM public.ai_helper_usage u WHERE u.organization_id = v_org AND u.month = v_month;
  RETURN jsonb_build_object(
    'roundup_enabled', coalesce(v_set.roundup_enabled, FALSE),
    'rfq_enabled', coalesce(v_set.rfq_enabled, FALSE),
    'monthly_cap_pence', coalesce(v_set.monthly_cap_pence, 1000),
    'key_set', EXISTS (SELECT 1 FROM public.ai_helper_secrets k WHERE k.organization_id = v_org),
    'key_last4', CASE WHEN v_admin THEN v_set.api_key_last4 END,
    'month_spent_pence', coalesce(v_use.spent_pence, 0),
    'month_reserved_pence', coalesce(v_use.reserved_pence, 0),
    'can_manage', v_admin);
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_helper_save_settings(p_roundup BOOLEAN, p_rfq BOOLEAN, p_cap_pence INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin']);
  v_month DATE := date_trunc('month', now() AT TIME ZONE 'Europe/London')::DATE;
  v_used INTEGER;
BEGIN
  IF p_roundup IS NULL OR p_rfq IS NULL OR p_cap_pence IS NULL OR p_cap_pence NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Choose both switches and a monthly limit between £0 and £1000.' USING ERRCODE = '22023';
  END IF;
  -- Same lock order as reserve: company settings, then its monthly usage row.
  INSERT INTO public.ai_helper_settings(organization_id) VALUES(v_org) ON CONFLICT DO NOTHING;
  PERFORM s.organization_id FROM public.ai_helper_settings s WHERE s.organization_id = v_org FOR UPDATE;
  INSERT INTO public.ai_helper_usage(organization_id, month) VALUES(v_org, v_month) ON CONFLICT DO NOTHING;
  SELECT u.spent_pence + u.reserved_pence INTO v_used FROM public.ai_helper_usage u
    WHERE u.organization_id = v_org AND u.month = v_month FOR UPDATE;
  IF p_cap_pence < v_used THEN
    RAISE EXCEPTION 'The limit cannot be below used and reserved AI.' USING ERRCODE = '22023', HINT = 'cap_below_usage';
  END IF;
  UPDATE public.ai_helper_settings s SET roundup_enabled = p_roundup, rfq_enabled = p_rfq,
    monthly_cap_pence = p_cap_pence, updated_at = now(), updated_by = auth.uid() WHERE s.organization_id = v_org;
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_settings_updated', 'ai_helper_settings', v_org::TEXT,
    jsonb_build_object('roundup_enabled', p_roundup, 'rfq_enabled', p_rfq, 'monthly_cap_pence', p_cap_pence));
  RETURN public.ai_helper_status();
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_save_settings(boolean,boolean,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_save_settings(boolean,boolean,integer) TO authenticated;

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
  SELECT * INTO v_set FROM public.ai_helper_settings s WHERE s.organization_id = v_org FOR SHARE;
  IF NOT coalesce(CASE p_feature WHEN 'roundup' THEN v_set.roundup_enabled ELSE v_set.rfq_enabled END, FALSE) THEN
    RAISE EXCEPTION 'The AI helper is off for this company.' USING ERRCODE = '42501', HINT = 'ai_helper_off';
  END IF;

  -- Reservations a request never settled (10 minutes is far past the app's own timeout) are CHARGED IN FULL (133): nobody knows
  -- whether the provider did the work and billed it, so the reservation moves into spent and the request records that charge
  -- (cost_pence = its reservation). A late answer is still recorded by settle, at no extra cost.
  WITH stale AS (
    UPDATE public.ai_helper_requests r SET status = 'expired', cost_pence = r.reserved_pence, settled_at = now()
    WHERE r.organization_id = v_org AND r.status = 'reserved' AND r.created_at < now() - interval '10 minutes'
    RETURNING r.month, r.reserved_pence
  )
  UPDATE public.ai_helper_usage u SET reserved_pence = greatest(0, u.reserved_pence - s.total), spent_pence = u.spent_pence + s.total, updated_at = now()
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
REVOKE ALL ON FUNCTION public.ai_helper_reserve(text,integer,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve(text,integer,text,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_helper_reserve_assistant(p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
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
  IF p_estimate_pence IS NULL OR p_estimate_pence NOT BETWEEN 1 AND 1000
     OR p_input_digest IS NULL OR p_input_digest !~ '^[0-9a-f]{64}$' OR p_input_bytes IS NULL OR p_input_bytes NOT BETWEEN 0 AND 200000 THEN
    RAISE EXCEPTION 'Invalid AI helper request.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_set FROM public.ai_helper_settings s WHERE s.organization_id = v_org FOR SHARE;
  IF NOT coalesce(v_set.assistant_enabled, FALSE) THEN
    RAISE EXCEPTION 'The AI assistant is off for this company.' USING ERRCODE = '42501', HINT = 'ai_helper_off';
  END IF;

  -- 133's sweep, unchanged: reservations a request never settled (10 minutes is far past the app's own timeout), of ANY feature, are
  -- CHARGED IN FULL: nobody knows whether the provider did the work and billed it, so the reservation moves into spent and the request
  -- records that charge (cost_pence = its reservation). A late answer is still recorded by 133's settle, at no extra cost.
  WITH stale AS (
    UPDATE public.ai_helper_requests r SET status = 'expired', cost_pence = r.reserved_pence, settled_at = now()
    WHERE r.organization_id = v_org AND r.status = 'reserved' AND r.created_at < now() - interval '10 minutes'
    RETURNING r.month, r.reserved_pence
  )
  UPDATE public.ai_helper_usage u SET reserved_pence = greatest(0, u.reserved_pence - s.total), spent_pence = u.spent_pence + s.total, updated_at = now()
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
    VALUES (v_org, auth.uid(), 'assistant', v_month, 'refused', v_reason, p_input_digest, p_input_bytes, now())
    RETURNING id INTO v_id;
    PERFORM public._ai_helper_audit(v_org, 'ai_helper_refused', 'ai_helper_requests', v_id::TEXT,
      jsonb_build_object('feature', 'assistant', 'reason', v_reason, 'estimate_pence', p_estimate_pence));
    RETURN jsonb_build_object('ok', FALSE, 'reason', v_reason, 'request_id', v_id);
  END IF;

  INSERT INTO public.ai_helper_requests (organization_id, user_id, feature, month, status, input_digest, input_bytes, reserved_pence)
  VALUES (v_org, auth.uid(), 'assistant', v_month, 'reserved', p_input_digest, p_input_bytes, p_estimate_pence)
  RETURNING id INTO v_id;
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_requested', 'ai_helper_requests', v_id::TEXT,
    jsonb_build_object('feature', 'assistant', 'input_bytes', p_input_bytes, 'estimate_pence', p_estimate_pence));
  RETURN jsonb_build_object('ok', TRUE, 'request_id', v_id);
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_reserve_assistant(integer,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve_assistant(integer,text,integer) TO authenticated;

-- Deployment must run the companion read-only verify; an exit code alone is not acceptance.
COMMIT;
