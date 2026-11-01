-- 133 rollback: ONLY with Rhys's approval. Puts back 103's public.ai_helper_reserve byte for byte (same signature, security, search_path
-- and grants), drops public.ai_helper_set_assistant(boolean) and ai_helper_settings.assistant_enabled, and restores 101's two-feature
-- CHECK on ai_helper_requests. ai_helper_settle (103), ai_helper_decide (101) and ai_helper_status (122) are untouched (133 does not
-- change them). STOPS, changing nothing, if any assistant request row exists (the two-feature CHECK could not hold): Rhys decides what
-- happens to those rows first (their audit events stay either way). Run the whole text as one transaction, then the release preflight
-- (marker 133 shows "not applied", 103 "applied" again). The app keeps working after it: the assistant reads as not available.
BEGIN;
DO $$
DECLARE
  v_reserve TEXT;
  v_rows    BIGINT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)') INTO v_reserve;
  -- cf754fe5...: 133's body; c75e470a...: 103's (a second run of this rollback).
  IF v_reserve IS NULL OR v_reserve NOT IN ('cf754fe55152a84f66bdb178897cdef9', 'c75e470a73e4d0e7508a27125f6f9e9c') THEN
    RAISE EXCEPTION '133 rollback: ai_helper_reserve (md5 %) is neither 133''s nor 103''s; stop and compare', coalesce(v_reserve, 'missing');
  END IF;
  SELECT count(*) FROM public.ai_helper_requests r WHERE r.feature = 'assistant' INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION '133 rollback stopped: % assistant request row(s) exist; Rhys decides what happens to them before 133 is rolled back', v_rows;
  END IF;
END
$$;

-- 103's ai_helper_reserve, verbatim (supabase/migrations/103_ai_helper_service_role.sql).
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
REVOKE ALL ON FUNCTION public.ai_helper_reserve(TEXT, INTEGER, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve(TEXT, INTEGER, TEXT, INTEGER) TO authenticated;

DROP FUNCTION IF EXISTS public.ai_helper_set_assistant(BOOLEAN);
ALTER TABLE public.ai_helper_settings DROP COLUMN IF EXISTS assistant_enabled;
ALTER TABLE public.ai_helper_requests DROP CONSTRAINT IF EXISTS ai_helper_requests_feature;
ALTER TABLE public.ai_helper_requests ADD CONSTRAINT ai_helper_requests_feature CHECK (feature IN ('roundup', 'rfq'));

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'))
       IS DISTINCT FROM 'c75e470a73e4d0e7508a27125f6f9e9c'
     OR to_regprocedure('public.ai_helper_set_assistant(boolean)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'assistant_enabled')
     OR NOT has_function_privilege('authenticated', 'public.ai_helper_reserve(text,integer,text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ai_helper_reserve(text,integer,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '133 rollback: the database is not back to 103''s AI helper';
  END IF;
END
$$;
COMMIT;
