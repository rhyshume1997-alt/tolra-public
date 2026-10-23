-- =====================================================================================================
-- 025: job e-mail limits can't be raced or reset (audit B7a: SEC4).
--
-- Before: /api/send-job counted recent email_history rows, then inserted its own row in a separate request, so
-- parallel requests could all pass the same count; and admin/office can delete or edit email_history, which reset
-- the count. A retried request also sent the e-mail again.
-- Now public.reserve_job_email() does the check and the reservation in one transaction, under a per-company lock,
-- against security_audit.email_send_ledger: insert-only, not reachable through the API, unchanged by edits to the
-- visible history. Each request carries an idempotency key: the same key returns the earlier attempt instead of a
-- new one (and the provider receives the same key, so an uncertain send can be retried without a duplicate).
-- Limits are unchanged: 10 per person per hour, 100 per company per day. Forward only, safe to run more than once.
-- =====================================================================================================

CREATE TABLE IF NOT EXISTS security_audit.email_send_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  job_id          UUID NOT NULL,
  recipient       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  history_id      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS email_send_ledger_org_time ON security_audit.email_send_ledger (organization_id, created_at);
CREATE INDEX IF NOT EXISTS email_send_ledger_user_time ON security_audit.email_send_ledger (user_id, created_at);
REVOKE ALL ON security_audit.email_send_ledger FROM PUBLIC, anon, authenticated, service_role;

-- Attempts are facts: never edited or removed through the API roles (an owner can still purge old rows).
CREATE OR REPLACE FUNCTION security_audit.email_send_ledger_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.is_api_role() THEN
    RAISE EXCEPTION 'email send ledger is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS email_send_ledger_immutable ON security_audit.email_send_ledger;
CREATE TRIGGER email_send_ledger_immutable BEFORE UPDATE OR DELETE ON security_audit.email_send_ledger
  FOR EACH ROW EXECUTE FUNCTION security_audit.email_send_ledger_immutable();

-- p_mode: 'sending' (the provider is configured) or 'drafted' (it isn't; the e-mail is only saved).
-- Returns { history_id, replay, status }. Over a limit: PT429 (HTTP 429) with hint 'user' or 'organization'.
CREATE OR REPLACE FUNCTION public.reserve_job_email(p_job UUID, p_recipient TEXT, p_subject TEXT, p_body TEXT,
                                                    p_key TEXT, p_mode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_prior   security_audit.email_send_ledger;
  v_status  TEXT;
  v_history UUID;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_mode NOT IN ('sending', 'drafted') THEN
    RAISE EXCEPTION 'Unknown send mode' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job AND organization_id = v_org) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  -- One reservation at a time per company, so two requests can't both take the last place.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-email:' || v_org::TEXT, 0));

  SELECT * INTO v_prior FROM security_audit.email_send_ledger
  WHERE organization_id = v_org AND user_id = v_user AND idempotency_key = p_key;
  IF FOUND THEN
    IF v_prior.job_id <> p_job OR v_prior.recipient <> p_recipient THEN
      RAISE EXCEPTION 'This request key was already used for a different e-mail' USING ERRCODE = 'PT409';
    END IF;
    SELECT status INTO v_status FROM public.email_history WHERE id = v_prior.history_id;
    -- A failed send may be tried again under the same key (the provider de-duplicates by key); no extra quota.
    IF v_status = 'failed' AND p_mode = 'sending' THEN
      UPDATE public.email_history SET status = 'sending' WHERE id = v_prior.history_id;
      RETURN jsonb_build_object('history_id', v_prior.history_id, 'replay', FALSE, 'status', 'sending');
    END IF;
    RETURN jsonb_build_object('history_id', v_prior.history_id, 'replay', TRUE, 'status', coalesce(v_status, 'unknown'));
  END IF;

  IF (SELECT count(*) FROM security_audit.email_send_ledger
      WHERE user_id = v_user AND created_at > now() - INTERVAL '1 hour') >= 10 THEN
    RAISE EXCEPTION 'Rate limit exceeded. Max 10 emails per hour.' USING ERRCODE = 'PT429', HINT = 'user';
  END IF;
  IF (SELECT count(*) FROM security_audit.email_send_ledger
      WHERE organization_id = v_org AND created_at > now() - INTERVAL '1 day') >= 100 THEN
    RAISE EXCEPTION 'Daily email limit reached for your organisation.' USING ERRCODE = 'PT429', HINT = 'organization';
  END IF;

  INSERT INTO public.email_history (organization_id, to_email, subject, body, related_to_type, related_to_id, drafted_by, status)
  VALUES (v_org, p_recipient, p_subject, p_body, 'job', p_job::TEXT, v_user, p_mode)
  RETURNING id INTO v_history;
  INSERT INTO security_audit.email_send_ledger (organization_id, user_id, job_id, recipient, idempotency_key, history_id)
  VALUES (v_org, v_user, p_job, p_recipient, p_key, v_history);
  RETURN jsonb_build_object('history_id', v_history, 'replay', FALSE, 'status', p_mode);
END
$$;
REVOKE ALL ON FUNCTION public.reserve_job_email(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_job_email(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
