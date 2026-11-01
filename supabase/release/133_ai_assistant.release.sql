-- 133_ai_assistant.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 133 (working number; Design holds 130 to 132): G3, the in-app AI assistant, built OFF. A third feature of the existing AI helper
-- (101, 103, 106, 122), not a second AI stack: the same settings row, cap ledger, request log, audit events, key and functions.
-- Needs 101 (tables, _ai_helper_caller, _ai_helper_audit) and 103 (ai_helper_reserve's body without the key, settle the service
-- role's). INDEPENDENT OF 106 AND 122 (touches neither the finance-check column or setter nor ai_helper_status) and of 123 to 129.
-- Safe to run again.
--
-- WHAT CHANGES. One column, one constraint, one new function, one function body; no row is updated, no grant is widened.
--   a. public.ai_helper_settings.assistant_enabled BOOLEAN NOT NULL DEFAULT FALSE: the company's own switch for the assistant. Every
--      existing company reads FALSE: the assistant is OFF everywhere when this file is applied.
--   b. public.ai_helper_requests CHECK ai_helper_requests_feature: 'assistant' is added to ('roundup', 'rfq'), so an assistant
--      request is logged, capped and audited exactly like the other two (status, digest and size of the input, never the text).
--   c. public.ai_helper_set_assistant(p_enabled BOOLEAN): the ADMIN's way to change (a), through 101's _ai_helper_caller (signed in,
--      the company's admin, no support session, the admin's second step where the company requires it). Audited as
--      ai_helper_settings_updated { assistant_enabled }, as 106's finance-check switch is. Definer, signed-in only.
--   d. public.ai_helper_reserve: 103's body with 'assistant' accepted and checked against (a). Same name, signature, VOLATILE, SECURITY
--      DEFINER, search_path, owner and grants (signed-in only); same role check, stale-reservation release, key test and cap arithmetic
--      (one guarded UPDATE: reserved + spent + estimate <= cap); still no key in its answer (103 S2). A feature that is off is refused
--      with HINT ai_helper_off before anything is reserved, so nothing reaches the model while the assistant is off.
--   ai_helper_settle (103's), ai_helper_decide (101's) and ai_helper_status (122's) are NOT changed: settle takes any open request;
--   decide stays RFQ-only (the assistant has nothing to decide: it only answers and drafts text the person copies).
-- NOTHING WRITES FOR THE ASSISTANT. It gets no new write path: no table grant, no RPC that changes a record. The only rows an
-- assistant request writes are its own ai_helper_requests row, the cap ledger and the audit events, through reserve and settle.
-- AFTER 133, 103's verify row reserve_returns_no_key reads FALSE by design: it pins 103's md5, and the body is now 133's.
-- supabase/verify/ai_assistant_133.sql checks the new state (no key in the answer included); 103's other three rows still hold.
-- GUARD (section 1): 101's objects are there and ai_helper_reserve's body is 103's (or already this file's), md5 with every whitespace
-- character removed. SELF-CHECK (section 5). Verify: supabase/verify/ai_assistant_133.sql (every row TRUE).
-- Rollback: supabase/release/133_ai_assistant.rollback.sql (puts back 103's reserve, drops the function and the column, restores the
-- two-feature CHECK; stops if any assistant request rows exist, for Rhys to decide; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: 101's tables and helpers are there, settle is the service role's (103), and reserve's body is 103's (or already 133's).
DO $$
DECLARE
  v_reserve TEXT;
BEGIN
  IF to_regclass('public.ai_helper_settings') IS NULL OR to_regclass('public.ai_helper_requests') IS NULL
     OR to_regclass('public.ai_helper_usage') IS NULL OR to_regclass('public.ai_helper_secrets') IS NULL
     OR to_regprocedure('public._ai_helper_caller(text[])') IS NULL OR to_regprocedure('public._ai_helper_audit(uuid,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '133: the AI helper (101) is not applied; apply 101 and 103 first';
  END IF;
  IF has_function_privilege('authenticated', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '133: ai_helper_settle is still callable by signed-in users; apply 103 first';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)') INTO v_reserve;
  -- c75e470a73e4d0e7508a27125f6f9e9c: 103's ai_helper_reserve; cf754fe55152a84f66bdb178897cdef9: this file's (section 4).
  IF v_reserve IS NULL OR v_reserve NOT IN ('c75e470a73e4d0e7508a27125f6f9e9c', 'cf754fe55152a84f66bdb178897cdef9') THEN
    RAISE EXCEPTION '133: public.ai_helper_reserve is not 103''s (md5 without whitespace %); stop and compare it first', coalesce(v_reserve, 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The company's switch (off for every company) and the request log's feature list.
ALTER TABLE public.ai_helper_settings ADD COLUMN IF NOT EXISTS assistant_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.ai_helper_requests DROP CONSTRAINT IF EXISTS ai_helper_requests_feature;
ALTER TABLE public.ai_helper_requests ADD CONSTRAINT ai_helper_requests_feature CHECK (feature IN ('roundup', 'rfq', 'assistant'));

-- -----------------------------------------------------------------------------------------------------
-- 3. Admin: the assistant's switch for the caller's own company (106's ai_helper_set_finance_check shape).
CREATE OR REPLACE FUNCTION public.ai_helper_set_assistant(p_enabled BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin']);
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'Choose on or off for the assistant.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_helper_settings AS s (organization_id, assistant_enabled, updated_at, updated_by)
  VALUES (v_org, p_enabled, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET assistant_enabled = EXCLUDED.assistant_enabled, updated_at = now(), updated_by = auth.uid();
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_settings_updated', 'ai_helper_settings', v_org::TEXT,
    jsonb_build_object('assistant_enabled', p_enabled));
  RETURN jsonb_build_object('assistant_enabled', p_enabled);
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_set_assistant(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_set_assistant(BOOLEAN) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. ai_helper_reserve: 103's body; 'assistant' is accepted and checked against its own switch. Nothing else changes.
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
  IF p_feature IS NULL OR p_feature NOT IN ('roundup', 'rfq', 'assistant') OR p_estimate_pence IS NULL OR p_estimate_pence NOT BETWEEN 1 AND 1000
     OR p_input_digest IS NULL OR p_input_digest !~ '^[0-9a-f]{64}$' OR p_input_bytes IS NULL OR p_input_bytes NOT BETWEEN 0 AND 200000 THEN
    RAISE EXCEPTION 'Invalid AI helper request.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_set FROM public.ai_helper_settings s WHERE s.organization_id = v_org;
  IF NOT coalesce(CASE p_feature WHEN 'roundup' THEN v_set.roundup_enabled WHEN 'rfq' THEN v_set.rfq_enabled WHEN 'assistant' THEN v_set.assistant_enabled END, FALSE) THEN
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
-- The grant exactly as 101 left it (CREATE OR REPLACE keeps it; restated so a re-run cannot drift).
REVOKE ALL ON FUNCTION public.ai_helper_reserve(TEXT, INTEGER, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve(TEXT, INTEGER, TEXT, INTEGER) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check before COMMIT (the same checks as supabase/verify/ai_assistant_133.sql): the column is NOT NULL DEFAULT FALSE, the
--    feature CHECK takes the three features, reserve is 133's and carries no key, both functions definer with 101's search_path and
--    signed-in only, settle still the service role's only, and the signed-in role still writes no AI helper table.
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings'
                 AND column_name = 'assistant_enabled' AND is_nullable = 'NO' AND column_default = 'false') THEN
    RAISE EXCEPTION '133: ai_helper_settings.assistant_enabled is not NOT NULL DEFAULT FALSE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.ai_helper_requests'::regclass AND c.conname = 'ai_helper_requests_feature'
                 AND pg_get_constraintdef(c.oid) LIKE '%''assistant''%' AND pg_get_constraintdef(c.oid) LIKE '%''rfq''%' AND pg_get_constraintdef(c.oid) LIKE '%''roundup''%') THEN
    RAISE EXCEPTION '133: ai_helper_requests_feature does not take roundup, rfq and assistant';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'cf754fe55152a84f66bdb178897cdef9' OR position('''key_enc''' IN p.prosrc) > 0
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)')) IS NOT FALSE THEN
    RAISE EXCEPTION '133: ai_helper_reserve is not 133''s after the replace';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.ai_helper_reserve(text,integer,text,integer)', 'public.ai_helper_set_assistant(boolean)'] LOOP
    IF (SELECT NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
               OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
               OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) IS NOT FALSE THEN
      RAISE EXCEPTION '133: % is not definer, pinned and signed-in only', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '133: ai_helper_settle is not the service role''s only';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_helper_settings', 'INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated', 'public.ai_helper_requests', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.ai_helper_usage', 'INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated', 'public.ai_helper_secrets', 'SELECT') THEN
    RAISE EXCEPTION '133: an AI helper table grants a signed-in user more than 101 does';
  END IF;
END
$$;

COMMIT;
