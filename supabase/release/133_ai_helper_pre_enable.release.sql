-- 133_ai_helper_pre_enable.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 133: the AI helper before it is switched on for any company (AI-PRE; E9 Q4 and Q6, ChatGPT + Astra conditions). NUMBERING
-- (provisional): 133 is a working number (Design owns 130+); the final number is given at merge. Needs 101 and 103 (and 122 for the
-- default cap; nothing here depends on it). The AI helper stays OFF: nothing here switches it on.
--
-- WHAT CHANGES.
--   a. Q4, uncertain requests are paid for. ai_helper_reserve's stale sweep (103) RELEASED a reservation nobody settled within 10
--      minutes, so a request whose answer was lost (timeout after the provider did the work, a settle that failed) cost nothing against
--      the cap. Now the sweep MOVES it into spent (charged in full, the request's cost_pence = its reservation). 103's body otherwise.
--   b. Q4, a late answer on a swept request: ai_helper_settle (103) still records it (status, model, output, audit event) but adds no
--      spend and gives none back: the full charge stands. A request released by the pre-133 sweep (cost_pence NULL) settles as before.
--      103's checks, grants and audit row otherwise. (The app side of Q4: no SDK retries, the JSON schema counted in the reservation,
--      and only a certain rejection before any work is settled at 0; anything else is settled at the full reservation.)
--   c. Q6, retention: public.ai_helper_purge_requests(p_limit) deletes AI helper requests (with the suggestion they hold) made more than
--      12 months ago, for every company, oldest first, at most p_limit rows a call; one audit row per company it deleted from
--      (ai_helper_requests_purged: the count and the cut-off, no content). The service role only (the nightly cron calls it). The
--      audit events of the requests themselves stay (6 years, docs/DATA-RETENTION.md); they hold ids, pence and counts, no text.
-- GUARD (section 1): 101's objects are there and reserve and settle are 103's (or already 133's); the purge function is absent or 133's.
-- Safe to run again. SELF-CHECK (section 5). Verify: supabase/verify/ai_helper_pre_enable_133.sql (every row TRUE).
-- Rollback: supabase/release/133_ai_helper_pre_enable.rollback.sql (puts back 103's two bodies, drops the purge; Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard.
DO $$
BEGIN
  IF to_regclass('public.ai_helper_requests') IS NULL OR to_regclass('public.ai_helper_usage') IS NULL
     OR to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)') IS NULL
     OR to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '133: the AI helper (101, 103) is not applied; apply them first';
  END IF;
  -- c75e470a...: 103's ai_helper_reserve; 972540e8...: this file's (section 2).
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'))
       NOT IN ('c75e470a73e4d0e7508a27125f6f9e9c', '972540e833a42bbb35ac5b670c56daa8') THEN
    RAISE EXCEPTION '133: public.ai_helper_reserve is neither 103''s nor 133''s; stop and compare it first';
  END IF;
  -- ca516619...: 103's ai_helper_settle; 7e04d0ab...: this file's (section 3).
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)'))
       NOT IN ('ca5166191666584107491f95ccce4702', '7e04d0ab645ec24dc0f0acb78c222702') THEN
    RAISE EXCEPTION '133: public.ai_helper_settle is neither 103''s nor 133''s; stop and compare it first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_purge_requests(integer)')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'c4b0d7f39cec1f23c6bd1d5e31e59fa9') THEN
    RAISE EXCEPTION '133: public.ai_helper_purge_requests exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. Reserve: 103's body; the stale sweep charges in full instead of releasing.
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


-- -----------------------------------------------------------------------------------------------------
-- 3. Settle: 103's body; a request charged in full by the sweep keeps that charge when its late answer arrives.
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
  -- Open: still reserved, or expired by a later reserve before this answer came back and not settled since: charged in full by 133's
  -- sweep (cost_pence = the reservation, no model, failure or output yet), or released by the sweep before 133 (cost_pence NULL).
  IF NOT FOUND OR NOT (v_req.status = 'reserved'
                       OR (v_req.status = 'expired' AND (v_req.cost_pence IS NULL
                           OR (v_req.model IS NULL AND v_req.failure IS NULL AND v_req.output IS NULL)))) THEN
    RAISE EXCEPTION 'This AI helper request is not open.' USING ERRCODE = '42501';
  END IF;
  -- Charged in full by the sweep: the charge stands (no refund, no second charge). Otherwise the cost given, never above the reservation.
  v_cost := CASE WHEN v_req.status = 'expired' AND v_req.cost_pence IS NOT NULL THEN v_req.cost_pence
                 ELSE least(greatest(coalesce(p_cost_pence, 0), 0), v_req.reserved_pence) END;
  -- Reserved: the reservation is released and the cost spent. Expired before 133: released already, only the spend is added. Expired
  -- by 133's sweep: already in spent, nothing moves.
  UPDATE public.ai_helper_usage u
  SET reserved_pence = CASE WHEN v_req.status = 'reserved' THEN greatest(0, u.reserved_pence - v_req.reserved_pence) ELSE u.reserved_pence END,
      spent_pence = u.spent_pence + CASE WHEN v_req.status = 'expired' AND v_req.cost_pence IS NOT NULL THEN 0 ELSE v_cost END, updated_at = now()
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

-- -----------------------------------------------------------------------------------------------------
-- 4. Retention: requests (and the suggestion each holds) made more than 12 months ago are deleted, every company, oldest first.
CREATE OR REPLACE FUNCTION public.ai_helper_purge_requests(p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cutoff  TIMESTAMPTZ := now() - interval '12 months';
  v_deleted INTEGER := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid purge limit.' USING ERRCODE = '22023';
  END IF;
  WITH doomed AS (
    SELECT r.id FROM public.ai_helper_requests r
    WHERE r.created_at < v_cutoff
    ORDER BY r.created_at, r.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  gone AS (
    DELETE FROM public.ai_helper_requests r USING doomed d WHERE r.id = d.id
    RETURNING r.organization_id
  ),
  per_company AS (SELECT g.organization_id, count(*)::INTEGER AS n FROM gone g GROUP BY g.organization_id),
  logged AS (
    INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
    SELECT c.organization_id, NULL, NULL, 'ai_helper_requests_purged', 'ai_helper_requests', NULL,
           jsonb_build_object('deleted', c.n, 'created_before', to_char(v_cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'source', 'ai_helper')
    FROM per_company c
    RETURNING 1
  )
  SELECT coalesce(sum(c.n), 0)::INTEGER INTO v_deleted FROM per_company c, (SELECT count(*) FROM logged) l;
  RETURN v_deleted;
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_purge_requests(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_purge_requests(INTEGER) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check: grants as 103 (settle and purge the service role's only; reserve signed-in users'), and no signed-in role may delete.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ai_helper_reserve(text,integer,text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ai_helper_reserve(text,integer,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ai_helper_purge_requests(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ai_helper_purge_requests(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ai_helper_purge_requests(integer)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.ai_helper_requests', 'DELETE') THEN
    RAISE EXCEPTION '133: grants are not as expected';
  END IF;
END
$$;

COMMIT;
