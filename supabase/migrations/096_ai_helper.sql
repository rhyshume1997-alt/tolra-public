-- =====================================================================================================
-- 096: the Tolra AI admin helper, first version (lib/ai-helper, app/api/ai-helper, AI_HELPER_ENABLED). Two features, both OFF by
-- default per company: the round-up (a read-only summary of what is late, waiting or unbilled) and RFQ email to draft quote (a
-- suggestion only; a person's Approve click creates a normal draft through create_with_lines under their own session). Needs 033
-- (assert_privileged_aal, require_admin_mfa_guard), 036 (_session_membership, support_readonly_guard), 000/035 (security_audit.audit_log,
-- log_row_change). INDEPENDENT OF 094 AND 095: touches none of their objects (or 081 to 093's). Safe to run again.
--
-- WHAT IT ADDS. Four tables, seven functions; no existing table, row, function, policy or grant changes.
--   a. public.ai_helper_settings: one row per company: roundup_enabled and rfq_enabled (default FALSE), monthly_cap_pence (default 0:
--      nothing runs until an admin sets a cap), api_key_last4. Read by the company's admin and office users; row audited.
--   b. public.ai_helper_secrets: the company's own Anthropic API key, encrypted by the server (lib/integrations/crypto.ts, AES-256-GCM
--      bound to the company; the database never sees the key). No grant to anyone: only ai_helper_reserve hands the ciphertext back, to
--      an office or admin user of that company with a feature on and the cap not reached. NOT row audited (no ciphertext in the log).
--   c. public.ai_helper_usage: one row per company per month (Europe/London): reserved_pence and spent_pence. The cap is reserved BEFORE
--      each model request in one row-locked UPDATE (reserved + spent + estimate <= cap), so two requests at once cannot both pass it;
--      settled after with the provider's own usage (never above the reservation). A reservation older than 10 minutes is released.
--   d. public.ai_helper_requests: one row per request (feature, digest and size of the input, never the text; the validated suggestion;
--      reserved and actual cost; status reserved / refused / expired / suggested / failed / approved / rejected; who decided, when, the
--      draft quote it became).
--   Functions (SECURITY DEFINER, signed-in only; company from current_user_organization_id(), person from auth.uid(); a support session
--   is refused; admins pass assert_privileged_aal): ai_helper_status() (admin, office), ai_helper_save_settings and ai_helper_set_key
--   (admin), ai_helper_reserve, ai_helper_settle and ai_helper_decide (admin, office). Internal: _ai_helper_audit (no grant).
-- AUDIT. The events are written by these functions themselves, in the same transaction as the change, straight into
-- security_audit.audit_log (as 072's and 093's functions do): ai_helper_requested, ai_helper_refused, ai_helper_suggested,
-- ai_helper_failed, ai_helper_approved, ai_helper_rejected, ai_helper_settings_updated, ai_helper_key_set, ai_helper_key_cleared. Ids,
-- feature, model, counts and pence only: no text, no names, no key. The names are guarded: write_audit (the app's own path) still refuses
-- them (audit_event_allowed does not list them), so a client can't make one up. audit_event_allowed and write_audit are NOT replaced
-- (095's bodies stay, and re-running 095 after 096 still passes its guard).
-- RLS: on all four. SELECT for the company's admin and office users on a, c, d; nothing on b; no INSERT, UPDATE or DELETE grant (only the
-- functions write). Every table carries support_read_only and admin_mfa, as 084's do.
-- GUARD (section 1). SELF-CHECK (section 5). Verify: supabase/verify/ai_helper_096.sql (every row TRUE).
-- Rollback: supabase/release/096_ai_helper.rollback.sql (drops the four tables and seven functions; audit rows stay; Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists.
DO $$
BEGIN
  IF to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL
     OR to_regprocedure('public.support_readonly_guard()') IS NULL OR to_regprocedure('public._session_membership()') IS NULL
     OR to_regprocedure('security_audit.log_row_change()') IS NULL OR to_regclass('security_audit.audit_log') IS NULL
     OR to_regclass('public.quotes') IS NULL OR to_regclass('public.user_profiles') IS NULL THEN
    RAISE EXCEPTION '096: a function or table it needs (033, 036, the audit log, quotes) is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The tables, row level security, grants and guards.
CREATE TABLE IF NOT EXISTS public.ai_helper_settings (
  organization_id   UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  roundup_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  rfq_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  monthly_cap_pence INTEGER NOT NULL DEFAULT 0 CONSTRAINT ai_helper_settings_cap CHECK (monthly_cap_pence BETWEEN 0 AND 100000),
  api_key_last4     TEXT CONSTRAINT ai_helper_settings_last4 CHECK (api_key_last4 IS NULL OR api_key_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID
);

CREATE TABLE IF NOT EXISTS public.ai_helper_secrets (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- lib/integrations/crypto.ts's stored form only, so a plain key can never be stored by mistake.
  api_key_enc     TEXT NOT NULL CONSTRAINT ai_helper_secrets_form CHECK (api_key_enc ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID
);

CREATE TABLE IF NOT EXISTS public.ai_helper_usage (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  month           DATE NOT NULL CONSTRAINT ai_helper_usage_month CHECK (month = date_trunc('month', month)::DATE),
  reserved_pence  INTEGER NOT NULL DEFAULT 0 CONSTRAINT ai_helper_usage_reserved CHECK (reserved_pence >= 0),
  spent_pence     INTEGER NOT NULL DEFAULT 0 CONSTRAINT ai_helper_usage_spent CHECK (spent_pence >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, month)
);

CREATE TABLE IF NOT EXISTS public.ai_helper_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  feature         TEXT NOT NULL CONSTRAINT ai_helper_requests_feature CHECK (feature IN ('roundup', 'rfq')),
  month           DATE NOT NULL,
  status          TEXT NOT NULL CONSTRAINT ai_helper_requests_status
                    CHECK (status IN ('reserved', 'refused', 'expired', 'suggested', 'failed', 'approved', 'rejected')),
  refusal         TEXT CONSTRAINT ai_helper_requests_refusal CHECK (refusal IS NULL OR refusal IN ('cap', 'no_key')),
  failure         TEXT CONSTRAINT ai_helper_requests_failure CHECK (failure IS NULL OR failure IN ('unavailable', 'refused', 'invalid')),
  input_digest    TEXT NOT NULL CONSTRAINT ai_helper_requests_digest CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  input_bytes     INTEGER NOT NULL CONSTRAINT ai_helper_requests_bytes CHECK (input_bytes BETWEEN 0 AND 200000),
  reserved_pence  INTEGER NOT NULL DEFAULT 0 CONSTRAINT ai_helper_requests_reserved CHECK (reserved_pence >= 0),
  cost_pence      INTEGER CONSTRAINT ai_helper_requests_cost CHECK (cost_pence IS NULL OR cost_pence >= 0),
  model           TEXT CONSTRAINT ai_helper_requests_model CHECK (model IS NULL OR model ~ '^[a-z0-9.-]{1,64}$'),
  output          JSONB CONSTRAINT ai_helper_requests_output CHECK (output IS NULL OR (jsonb_typeof(output) = 'object' AND octet_length(output::TEXT) <= 32768)),
  result_quote_id UUID,
  decided_by      UUID,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_helper_requests_org ON public.ai_helper_requests (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_helper_requests_open ON public.ai_helper_requests (organization_id, created_at) WHERE status = 'reserved';
-- One draft quote is the result of one suggestion at most.
CREATE UNIQUE INDEX IF NOT EXISTS ai_helper_requests_one_quote ON public.ai_helper_requests (result_quote_id) WHERE result_quote_id IS NOT NULL;

ALTER TABLE public.ai_helper_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_helper_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_helper_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_helper_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_helper_settings office select" ON public.ai_helper_settings;
CREATE POLICY "ai_helper_settings office select" ON public.ai_helper_settings FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
DROP POLICY IF EXISTS "ai_helper_usage office select" ON public.ai_helper_usage;
CREATE POLICY "ai_helper_usage office select" ON public.ai_helper_usage FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
DROP POLICY IF EXISTS "ai_helper_requests office select" ON public.ai_helper_requests;
CREATE POLICY "ai_helper_requests office select" ON public.ai_helper_requests FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));

REVOKE ALL ON public.ai_helper_settings, public.ai_helper_secrets, public.ai_helper_usage, public.ai_helper_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_helper_settings, public.ai_helper_usage, public.ai_helper_requests TO authenticated;

-- Row audit on the settings only (no secret in it). Requests and usage are recorded by the named events (ids and pence, no text).
DROP TRIGGER IF EXISTS audit_ai_helper_settings_changes ON public.ai_helper_settings;
CREATE TRIGGER audit_ai_helper_settings_changes AFTER INSERT OR DELETE OR UPDATE ON public.ai_helper_settings
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

DROP TRIGGER IF EXISTS support_read_only ON public.ai_helper_settings;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_helper_settings FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.ai_helper_secrets;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_helper_secrets FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.ai_helper_usage;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_helper_usage FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.ai_helper_requests;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.ai_helper_requests FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();

DROP TRIGGER IF EXISTS admin_mfa ON public.ai_helper_settings;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.ai_helper_settings FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.ai_helper_secrets;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.ai_helper_secrets FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.ai_helper_usage;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.ai_helper_usage FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.ai_helper_requests;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.ai_helper_requests FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. The internal helpers: one audit row (the caller's company, person and e-mail), and the checks every function makes first.
CREATE OR REPLACE FUNCTION public._ai_helper_audit(p_org UUID, p_action TEXT, p_table TEXT, p_entity TEXT, p_metadata JSONB)
RETURNS VOID
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public
AS $$
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (p_org, auth.uid(),
          coalesce(nullif(auth.jwt() ->> 'email', ''), (SELECT p.email FROM public.user_profiles p WHERE p.id = auth.uid())),
          p_action, p_table, p_entity, coalesce(p_metadata, '{}'::JSONB) || jsonb_build_object('source', 'ai_helper'));
$$;
REVOKE ALL ON FUNCTION public._ai_helper_audit(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- The caller's company, after the checks every AI helper function makes: signed in, an active company, the roles given, no support
-- session (spec rule 9: it would spend the company's budget and send its data out), and the second step for an admin who needs it.
CREATE OR REPLACE FUNCTION public._ai_helper_caller(p_roles TEXT[])
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(p_roles) THEN
    RAISE EXCEPTION 'Only office and admin users can use the AI helper.' USING ERRCODE = '42501';
  END IF;
  IF coalesce((SELECT s.is_support FROM public._session_membership() s LIMIT 1), FALSE) THEN
    RAISE EXCEPTION 'Support access can''t use the AI helper.' USING ERRCODE = '42501', HINT = 'support_refused';
  END IF;
  RETURN v_org;
END
$$;
REVOKE ALL ON FUNCTION public._ai_helper_caller(TEXT[]) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. The functions the app calls (each as the signed-in person, through their own session).

-- The company's switches, cap and this month's figures. The key itself never leaves: only whether one is set and, for an admin, its
-- last four characters.
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
    'monthly_cap_pence', coalesce(v_set.monthly_cap_pence, 0),
    'key_set', EXISTS (SELECT 1 FROM public.ai_helper_secrets k WHERE k.organization_id = v_org),
    'key_last4', CASE WHEN v_admin THEN v_set.api_key_last4 END,
    'month_spent_pence', coalesce(v_use.spent_pence, 0),
    'month_reserved_pence', coalesce(v_use.reserved_pence, 0),
    'can_manage', v_admin);
END
$$;

-- Admin: the two switches and the monthly cap (0 to 100000 pence).
CREATE OR REPLACE FUNCTION public.ai_helper_save_settings(p_roundup BOOLEAN, p_rfq BOOLEAN, p_cap_pence INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin']);
BEGIN
  IF p_roundup IS NULL OR p_rfq IS NULL OR p_cap_pence IS NULL OR p_cap_pence NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Choose both switches and a monthly limit between £0 and £1000.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_helper_settings AS s (organization_id, roundup_enabled, rfq_enabled, monthly_cap_pence, updated_at, updated_by)
  VALUES (v_org, p_roundup, p_rfq, p_cap_pence, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE
    SET roundup_enabled = EXCLUDED.roundup_enabled, rfq_enabled = EXCLUDED.rfq_enabled,
        monthly_cap_pence = EXCLUDED.monthly_cap_pence, updated_at = now(), updated_by = auth.uid();
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_settings_updated', 'ai_helper_settings', v_org::TEXT,
    jsonb_build_object('roundup_enabled', p_roundup, 'rfq_enabled', p_rfq, 'monthly_cap_pence', p_cap_pence));
  RETURN public.ai_helper_status();
END
$$;

-- Admin: store (or, with NULL, remove) the company's own API key, already encrypted by the server, and its last four characters.
CREATE OR REPLACE FUNCTION public.ai_helper_set_key(p_key_enc TEXT, p_last4 TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin']);
BEGIN
  IF p_key_enc IS NULL THEN
    DELETE FROM public.ai_helper_secrets k WHERE k.organization_id = v_org;
    UPDATE public.ai_helper_settings s SET api_key_last4 = NULL, updated_at = now(), updated_by = auth.uid() WHERE s.organization_id = v_org;
    PERFORM public._ai_helper_audit(v_org, 'ai_helper_key_cleared', 'ai_helper_settings', v_org::TEXT, '{}'::JSONB);
    RETURN public.ai_helper_status();
  END IF;
  IF p_key_enc !~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' OR octet_length(p_key_enc) > 2048
     OR p_last4 IS NULL OR p_last4 !~ '^[A-Za-z0-9_-]{4}$' THEN
    RAISE EXCEPTION 'The key was not stored in the expected form.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_helper_secrets AS k (organization_id, api_key_enc, updated_at, updated_by)
  VALUES (v_org, p_key_enc, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, updated_at = now(), updated_by = auth.uid();
  INSERT INTO public.ai_helper_settings AS s (organization_id, api_key_last4, updated_at, updated_by)
  VALUES (v_org, p_last4, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET api_key_last4 = EXCLUDED.api_key_last4, updated_at = now(), updated_by = auth.uid();
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_key_set', 'ai_helper_settings', v_org::TEXT, '{}'::JSONB);
  RETURN public.ai_helper_status();
END
$$;

-- Office or admin: reserve the estimate against this month's cap BEFORE a model request. The feature must be on for the company (checked
-- here, not only in the app). No key or not enough left: a 'refused' request and an ai_helper_refused event, and { ok: false } (the
-- app makes no model call). Otherwise a 'reserved' request, an ai_helper_requested event, and { ok: true, request_id, key_enc }.
-- Race-safe: the reservation is one UPDATE on the company's month row, whose WHERE (reserved + spent + estimate <= cap) Postgres
-- re-checks on the locked, newest row, so concurrent requests queue on the row and never pass the cap together.
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
  RETURN jsonb_build_object('ok', TRUE, 'request_id', v_id, 'key_enc', v_key);
END
$$;

-- The same person, after the model answered (or failed): the actual cost (never above the reservation) moves to spent, the reservation
-- is released, and the validated suggestion is kept (status suggested), or the failure is recorded (status failed). Once per request.
CREATE OR REPLACE FUNCTION public.ai_helper_settle(p_request UUID, p_status TEXT, p_failure TEXT, p_cost_pence INTEGER, p_model TEXT, p_output JSONB)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org  UUID := public._ai_helper_caller(ARRAY['admin', 'office']);
  v_req  public.ai_helper_requests%ROWTYPE;
  v_cost INTEGER;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('suggested', 'failed')
     OR (p_status = 'failed' AND (p_failure IS NULL OR p_failure NOT IN ('unavailable', 'refused', 'invalid') OR p_output IS NOT NULL))
     OR (p_status = 'suggested' AND (p_failure IS NOT NULL OR p_output IS NULL OR jsonb_typeof(p_output) <> 'object' OR octet_length(p_output::TEXT) > 32768))
     OR (p_model IS NOT NULL AND p_model !~ '^[a-z0-9.-]{1,64}$') THEN
    RAISE EXCEPTION 'Invalid AI helper result.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req FROM public.ai_helper_requests r WHERE r.id = p_request AND r.organization_id = v_org FOR UPDATE;
  -- Open: still reserved, or expired by a later reserve before this answer came back (released, not yet settled).
  IF NOT FOUND OR v_req.user_id IS DISTINCT FROM auth.uid()
     OR NOT (v_req.status = 'reserved' OR (v_req.status = 'expired' AND v_req.cost_pence IS NULL)) THEN
    RAISE EXCEPTION 'This AI helper request is not open.' USING ERRCODE = '42501';
  END IF;
  v_cost := least(greatest(coalesce(p_cost_pence, 0), 0), v_req.reserved_pence);
  -- An expired request's reservation was already released by ai_helper_reserve: only the spend is added.
  UPDATE public.ai_helper_usage u
  SET reserved_pence = CASE WHEN v_req.status = 'reserved' THEN greatest(0, u.reserved_pence - v_req.reserved_pence) ELSE u.reserved_pence END,
      spent_pence = u.spent_pence + v_cost, updated_at = now()
  WHERE u.organization_id = v_org AND u.month = v_req.month;
  UPDATE public.ai_helper_requests r
  SET status = p_status, failure = p_failure, cost_pence = v_cost, model = p_model, output = p_output, settled_at = now()
  WHERE r.id = v_req.id;
  PERFORM public._ai_helper_audit(v_org, CASE p_status WHEN 'suggested' THEN 'ai_helper_suggested' ELSE 'ai_helper_failed' END,
    'ai_helper_requests', v_req.id::TEXT,
    jsonb_build_object('feature', v_req.feature, 'model', p_model, 'cost_pence', v_cost)
      || CASE WHEN p_failure IS NOT NULL THEN jsonb_build_object('reason', p_failure) ELSE '{}'::JSONB END
      || CASE WHEN jsonb_typeof(p_output -> 'lines') = 'array' THEN jsonb_build_object('lines', jsonb_array_length(p_output -> 'lines')) ELSE '{}'::JSONB END);
END
$$;

-- Office or admin: the person's decision on an RFQ suggestion, once. Approved names the draft quote the person's own Approve click
-- created (create_with_lines, as the Quote Builder saves): it must be a draft of this company made after the suggestion. Rejected names
-- none. Nothing else changes: the quote itself was written, checked and audited by its own path.
CREATE OR REPLACE FUNCTION public.ai_helper_decide(p_request UUID, p_decision TEXT, p_quote UUID)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin', 'office']);
  v_req public.ai_helper_requests%ROWTYPE;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') OR (p_decision = 'approved') <> (p_quote IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid decision.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req FROM public.ai_helper_requests r WHERE r.id = p_request AND r.organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR v_req.feature <> 'rfq' OR v_req.status <> 'suggested' THEN
    RAISE EXCEPTION 'This suggestion is not waiting for a decision.' USING ERRCODE = '42501';
  END IF;
  IF p_decision = 'approved' AND (
       NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org AND q.status = 'draft' AND q.created_at >= v_req.created_at)
       OR EXISTS (SELECT 1 FROM public.ai_helper_requests r WHERE r.result_quote_id = p_quote)) THEN
    RAISE EXCEPTION 'That draft quote can''t be linked to this suggestion.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.ai_helper_requests r SET status = p_decision, result_quote_id = p_quote, decided_by = auth.uid(), decided_at = now()
  WHERE r.id = v_req.id;
  PERFORM public._ai_helper_audit(v_org, CASE p_decision WHEN 'approved' THEN 'ai_helper_approved' ELSE 'ai_helper_rejected' END,
    'ai_helper_requests', v_req.id::TEXT,
    jsonb_build_object('feature', 'rfq') || CASE WHEN p_quote IS NOT NULL THEN jsonb_build_object('quote_id', p_quote) ELSE '{}'::JSONB END);
END
$$;

REVOKE ALL ON FUNCTION public.ai_helper_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_helper_save_settings(BOOLEAN, BOOLEAN, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_helper_set_key(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_helper_reserve(TEXT, INTEGER, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_helper_settle(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_helper_decide(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_save_settings(BOOLEAN, BOOLEAN, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_set_key(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve(TEXT, INTEGER, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_settle(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_decide(UUID, TEXT, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check: RLS on, the grants as above, the six app functions definer and signed-in only, the helpers callable by no one.
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN ('public.ai_helper_settings'::regclass, 'public.ai_helper_secrets'::regclass,
                'public.ai_helper_usage'::regclass, 'public.ai_helper_requests'::regclass) AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION '096: row level security is off on an AI helper table';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_helper_secrets', 'SELECT') OR has_table_privilege('anon', 'public.ai_helper_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ai_helper_settings', 'INSERT') OR has_table_privilege('authenticated', 'public.ai_helper_usage', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ai_helper_requests', 'UPDATE') OR has_table_privilege('authenticated', 'public.ai_helper_requests', 'DELETE') THEN
    RAISE EXCEPTION '096: an AI helper table grants more than SELECT';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.ai_helper_status()', 'public.ai_helper_save_settings(boolean,boolean,integer)', 'public.ai_helper_set_key(text,text)',
                              'public.ai_helper_reserve(text,integer,text,integer)', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)',
                              'public.ai_helper_decide(uuid,text,uuid)'] LOOP
    IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn))
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '096: % is not definer, pinned and signed-in only', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._ai_helper_audit(uuid,text,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._ai_helper_caller(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION '096: an internal AI helper function is callable';
  END IF;
END
$$;
