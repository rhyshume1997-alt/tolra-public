-- 173: exact approval send links. Inputs are scoped drafts and the existing mail ledger. Existing history and transport are unchanged.
BEGIN;
ALTER TABLE security_audit.company_email_sends
  ADD COLUMN IF NOT EXISTS approval_draft_id uuid,
  ADD COLUMN IF NOT EXISTS approval_attempt integer,
  ADD COLUMN IF NOT EXISTS approval_resolution text;

CREATE UNIQUE INDEX IF NOT EXISTS company_email_approval_attempt
  ON security_audit.company_email_sends (organization_id, approval_draft_id, approval_attempt)
  WHERE approval_draft_id IS NOT NULL;

-- Get the last exact link. Legacy attempts have no reliable association with a draft.
CREATE OR REPLACE FUNCTION public.approval_email_attempt_status(p_org uuid, p_user uuid, p_draft uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_draft public.email_history;
  v_last security_audit.company_email_sends;
BEGIN
  PERFORM public._company_email_caller(p_org, p_user);
  SELECT * INTO v_draft FROM public.email_history WHERE organization_id = p_org AND id = p_draft;
  IF NOT FOUND THEN RETURN 'held'; END IF;

  SELECT * INTO v_last FROM security_audit.company_email_sends
  WHERE organization_id = p_org AND approval_draft_id = p_draft ORDER BY approval_attempt DESC LIMIT 1;
  IF FOUND THEN
    IF v_last.status = 'failed' OR v_last.approval_resolution = 'not_sent' THEN RETURN 'failed'; END IF;
    RETURN 'held';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.email_history h
    LEFT JOIN security_audit.company_email_sends s ON h.id = s.history_id AND h.organization_id = s.organization_id
    WHERE h.organization_id = p_org AND h.id <> p_draft AND s.approval_draft_id IS NULL
      AND (s.status IN ('unknown', 'sending') OR (s.id IS NULL AND h.status = 'unknown'))
      AND NOT EXISTS (SELECT 1 FROM security_audit.company_email_sends linked
        WHERE linked.organization_id = p_org AND linked.approval_draft_id = h.id)
      AND h.related_to_type IS NOT DISTINCT FROM v_draft.related_to_type
      AND h.related_to_id IS NOT DISTINCT FROM v_draft.related_to_id
  ) THEN RETURN 'held'; END IF;
  RETURN 'new';
END
$$;

-- The approval queue only offers another provider for drafts whose own last attempt failed.
CREATE OR REPLACE FUNCTION public.approval_email_failed_drafts(p_drafts uuid[])
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.current_user_organization_id();
BEGIN
  PERFORM public._company_email_caller(v_org, auth.uid());
  RETURN ARRAY(
    SELECT last.approval_draft_id FROM (
      SELECT DISTINCT ON (s.approval_draft_id) s.approval_draft_id, s.status, s.approval_resolution
      FROM security_audit.company_email_sends s JOIN public.email_history h
        ON h.id = s.approval_draft_id AND h.organization_id = s.organization_id
      WHERE s.organization_id = v_org AND h.status = 'drafted' AND s.approval_draft_id = ANY(p_drafts)
      ORDER BY s.approval_draft_id, s.approval_attempt DESC
    ) last WHERE last.status = 'failed' OR last.approval_resolution = 'not_sent'
  );
END
$$;

-- Atomically link the reservation to the exact claimed draft before the provider can be called.
-- Keep the initial key; only a definite failure or explicit exact resolution advances it.
CREATE OR REPLACE FUNCTION public.reserve_approval_email(p_org uuid, p_user uuid, p_draft uuid, p_key text,
  p_to text, p_subject text, p_body text, p_related_type text, p_related_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_attempt integer;
  v_key text;
  v_result jsonb;
BEGIN
  PERFORM public._company_email_caller(p_org, p_user);
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid approval key' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mail-send:' || p_org::text, 0));
  PERFORM 1 FROM public.email_history WHERE organization_id = p_org AND id = p_draft AND status = 'sending'
    AND to_email = p_to AND subject = p_subject AND body = p_body
    AND related_to_type IS NOT DISTINCT FROM p_related_type AND related_to_id IS NOT DISTINCT FROM p_related_id FOR UPDATE;
  IF NOT FOUND OR public.approval_email_attempt_status(p_org, p_user, p_draft) = 'held'
    OR EXISTS (SELECT 1 FROM security_audit.company_email_sends WHERE organization_id = p_org
      AND history_id = p_draft AND status <> 'drafted') THEN
    RAISE EXCEPTION 'Approval send needs checking' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(max(approval_attempt), 0) + 1 INTO v_attempt
  FROM security_audit.company_email_sends WHERE organization_id = p_org AND approval_draft_id = p_draft;
  v_key := CASE WHEN v_attempt = 1 THEN p_key
                ELSE encode(sha256(convert_to(p_key || ':' || v_attempt::text, 'UTF8')), 'hex') END;
  -- A legacy reservation with the same key is not evidence of a link. Never repurpose it.
  IF EXISTS (SELECT 1 FROM security_audit.company_email_sends WHERE organization_id = p_org AND idempotency_key = v_key) THEN
    RAISE EXCEPTION 'Existing approval attempt needs checking' USING ERRCODE = 'P0001';
  END IF;
  v_result := public.reserve_company_email(p_org, p_user, v_key, p_to, p_subject, p_body, p_related_type, p_related_id, 'sending');
  UPDATE security_audit.company_email_sends SET approval_draft_id = p_draft, approval_attempt = v_attempt
  WHERE organization_id = p_org AND id = (v_result->>'send_id')::uuid AND approval_draft_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cannot link approval reservation'; END IF;
  RETURN v_result || jsonb_build_object('key', v_key);
END
$$;

-- An admin settles the latest linked attempt. Ambiguous historical rows stay untouched.
CREATE OR REPLACE FUNCTION public.resolve_approval_email(p_org uuid, p_user uuid, p_history uuid, p_outcome text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_attempt security_audit.company_email_sends;
  v_next text;
BEGIN
  PERFORM public._company_email_caller(p_org, p_user);
  IF public.is_api_role() AND NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins may settle approval sends' USING ERRCODE = '42501';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'not_sent') THEN
    RAISE EXCEPTION 'Unknown resolution' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mail-send:' || p_org::text, 0));
  SELECT s.* INTO v_attempt FROM security_audit.company_email_sends s
  WHERE s.organization_id = p_org AND s.approval_draft_id IS NOT NULL
    AND (s.approval_draft_id = p_history OR s.history_id = p_history)
    AND NOT EXISTS (SELECT 1 FROM security_audit.company_email_sends newer WHERE newer.organization_id = p_org
      AND newer.approval_draft_id = s.approval_draft_id AND newer.approval_attempt > s.approval_attempt)
  FOR UPDATE;
  IF NOT FOUND OR v_attempt.approval_resolution IS NOT NULL OR NOT (
    v_attempt.status = 'unknown' OR
    (v_attempt.status = 'sending' AND v_attempt.updated_at < now() - public.mail_send_stale_after())
  ) THEN RETURN 'held'; END IF;

  v_next := CASE p_outcome WHEN 'sent' THEN 'sent_manually' ELSE 'drafted' END;
  UPDATE public.email_history SET status = v_next,
    sent_at = CASE p_outcome WHEN 'sent' THEN now() ELSE sent_at END
  WHERE id = v_attempt.approval_draft_id AND organization_id = p_org AND status IN ('unknown', 'sending');
  IF NOT FOUND THEN RETURN 'held'; END IF;

  UPDATE public.email_history
  SET status = CASE p_outcome WHEN 'sent' THEN 'sent_manually' ELSE 'failed' END,
      sent_at = CASE p_outcome WHEN 'sent' THEN now() ELSE sent_at END
  WHERE id = v_attempt.history_id AND organization_id = p_org AND status IN ('unknown', 'sending');
  IF NOT FOUND THEN RAISE EXCEPTION 'Linked send history could not be settled'; END IF;

  -- Seal the original unknown key. A retry always uses a new linked reservation.
  UPDATE security_audit.company_email_sends SET status = 'unknown', approval_resolution = p_outcome, updated_at = now()
  WHERE id = v_attempt.id AND organization_id = p_org;
  RETURN v_next;
END
$$;

REVOKE ALL ON FUNCTION public.approval_email_attempt_status(uuid,uuid,uuid),
  public.reserve_approval_email(uuid,uuid,uuid,text,text,text,text,text,text),
  public.resolve_approval_email(uuid,uuid,uuid,text), public.approval_email_failed_drafts(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approval_email_attempt_status(uuid,uuid,uuid),
  public.reserve_approval_email(uuid,uuid,uuid,text,text,text,text,text,text),
  public.resolve_approval_email(uuid,uuid,uuid,text), public.approval_email_failed_drafts(uuid[]) TO authenticated;
COMMIT;
