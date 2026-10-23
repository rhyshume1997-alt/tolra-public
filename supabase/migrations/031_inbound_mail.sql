-- =====================================================================================================
-- 031: inbound e-mail from the connected Microsoft 365 mailbox (one mailbox per deployment; see docs/M365-MAIL.md).
--
-- public.inbound_emails keeps a copy of each message the app picked up from the mailbox inbox, once: the unique
-- (organization_id, graph_message_id) means a message that is read again is not stored again. Each new message also
-- becomes an RFQ (rfqs.status 'new'), linked through inbound_emails.rfq_id.
-- Writes happen only through public.record_inbound_email(), a SECURITY DEFINER function for admins (the poll route
-- calls it as the signed-in admin). The API roles can read the table (admin, office) but have no insert, update or
-- delete grant and no policy for them. Nothing here changes the mailbox.
-- Mailbox sends are reserved in security_audit.mail_send_ledger before they are made (reserve_mail_send,
-- complete_mail_send, resolve_mail_send), the same protected pattern as 025. Forward only, safe to run more than once.
-- =====================================================================================================

CREATE TABLE IF NOT EXISTS public.inbound_emails (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  graph_message_id    TEXT NOT NULL,
  internet_message_id TEXT,
  from_address        TEXT,
  from_name           TEXT,
  subject             TEXT,
  received_at         TIMESTAMPTZ NOT NULL,
  body_preview        TEXT,
  body_text           TEXT,
  rfq_id              UUID REFERENCES public.rfqs(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, graph_message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_org_received ON public.inbound_emails (organization_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_rfq ON public.inbound_emails (rfq_id) WHERE rfq_id IS NOT NULL;

-- -----------------------------------------------------------------------------------------------------

-- Stores one message and, if it is new, the RFQ made from it, in one transaction. Organisation and actor come from the
-- session, never from the caller. Returns { inserted, inbound_email_id, rfq_id }; inserted is false (and no RFQ is made)
-- when this message was stored before.
CREATE OR REPLACE FUNCTION public.record_inbound_email(p_graph_message_id TEXT, p_internet_message_id TEXT, p_from_address TEXT,
                                                       p_from_name TEXT, p_subject TEXT, p_received_at TIMESTAMPTZ,
                                                       p_body_preview TEXT, p_body_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_inbound UUID;
  v_rfq     UUID;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF coalesce(p_graph_message_id, '') = '' OR p_received_at IS NULL THEN
    RAISE EXCEPTION 'message id and received time are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.inbound_emails (organization_id, graph_message_id, internet_message_id, from_address, from_name,
                                     subject, received_at, body_preview, body_text)
  VALUES (v_org, p_graph_message_id, p_internet_message_id, p_from_address, p_from_name, p_subject, p_received_at,
          p_body_preview, p_body_text)
  ON CONFLICT (organization_id, graph_message_id) DO NOTHING
  RETURNING id INTO v_inbound;
  IF v_inbound IS NULL THEN
    RETURN jsonb_build_object('inserted', FALSE, 'inbound_email_id', NULL, 'rfq_id', NULL);
  END IF;

  INSERT INTO public.rfqs (organization_id, customer, email, description, status, created_by, updated_by)
  VALUES (v_org,
          coalesce(nullif(trim(p_from_name), ''), nullif(trim(p_from_address), ''), 'Unknown sender'),
          nullif(trim(p_from_address), ''),
          left(trim(concat_ws(E'\n', nullif(trim(p_subject), ''), nullif(trim(p_body_preview), ''))), 2000),
          'new', v_user, v_user)
  RETURNING id INTO v_rfq;
  UPDATE public.inbound_emails SET rfq_id = v_rfq WHERE id = v_inbound;
  RETURN jsonb_build_object('inserted', TRUE, 'inbound_email_id', v_inbound, 'rfq_id', v_rfq);
END
$$;
REVOKE ALL ON FUNCTION public.record_inbound_email(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_inbound_email(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------

-- Every mailbox send (new message, reply, forward) is reserved here BEFORE it is sent, as migration 025 does for job
-- e-mails: insert-only for the API roles (not reachable through the API at all), unchanged by edits or deletes in the
-- visible e-mail history. status: sending (reserved), accepted (Microsoft answered 202: accepted for sending, not
-- "delivered"), unknown (the request may or may not have reached Microsoft: check Sent Items), failed (definitely
-- refused), confirmed_sent (an admin checked Sent Items and confirmed an unknown one went).
CREATE TABLE IF NOT EXISTS security_audit.mail_send_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('send', 'reply', 'forward')),
  -- sha256 (hex) the server computes from kind, target message or recipients, subject and body hash
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 64),
  recipients      TEXT[] NOT NULL,
  history_id      UUID NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('sending', 'accepted', 'unknown', 'failed', 'confirmed_sent')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS mail_send_ledger_user_time ON security_audit.mail_send_ledger (user_id, created_at);
REVOKE ALL ON security_audit.mail_send_ledger FROM PUBLIC, anon, authenticated, service_role;

-- A reservation still 'sending' this long after it was made or last touched belongs to a request that never recorded
-- its outcome (the process died, or the write failed): it may or may not have been sent, so it is treated as 'unknown',
-- never as failed. A fresh 'sending' reservation is an active request and is left alone.
CREATE OR REPLACE FUNCTION public.mail_send_stale_after()
RETURNS INTERVAL
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT INTERVAL '10 minutes' $$;
REVOKE ALL ON FUNCTION public.mail_send_stale_after() FROM PUBLIC, anon, authenticated;

-- Marks this company's stale 'sending' reservations 'unknown' (called inside reserve_mail_send / resolve_mail_send).
CREATE OR REPLACE FUNCTION public.expire_stale_mail_sends()
RETURNS INTEGER
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH expired AS (
    UPDATE security_audit.mail_send_ledger SET status = 'unknown', updated_at = now()
    WHERE organization_id = public.current_user_organization_id() AND status = 'sending' AND updated_at < now() - public.mail_send_stale_after()
    RETURNING 1)
  SELECT count(*)::INTEGER FROM expired
$$;
REVOKE ALL ON FUNCTION public.expire_stale_mail_sends() FROM PUBLIC, anon, authenticated;

-- Reserves one send: checks the limit (20 per person per hour) and the key under a per-company lock, logs the e-mail
-- in the history as 'sending' and records the reservation. The same key again is refused (PT409) while it is sending,
-- accepted, unknown (also a stale 'sending', see expire_stale_mail_sends) or confirmed. After a definite failure the key
-- may be reserved again by any admin of the company: it is checked against that admin's limit for the current hour like a
-- new reservation, and the row becomes theirs, dated now.
-- Returns { send_id, history_id }.
CREATE OR REPLACE FUNCTION public.reserve_mail_send(p_kind TEXT, p_key TEXT, p_recipients TEXT[], p_subject TEXT,
                                                    p_body TEXT, p_rfq UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_prior   security_audit.mail_send_ledger;
  v_history UUID;
  v_rfq     UUID;
  v_to      TEXT := array_to_string(p_recipients, ', ');
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('send', 'reply', 'forward') OR coalesce(array_length(p_recipients, 1), 0) = 0 OR length(p_key) <> 64 THEN
    RAISE EXCEPTION 'Invalid mail send' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_rfq FROM public.rfqs WHERE id = p_rfq AND organization_id = v_org;

  -- One reservation at a time per company, so two requests can't both take the last place.
  PERFORM pg_advisory_xact_lock(hashtextextended('mail-send:' || v_org::TEXT, 0));
  PERFORM public.expire_stale_mail_sends();

  SELECT * INTO v_prior FROM security_audit.mail_send_ledger WHERE organization_id = v_org AND idempotency_key = p_key;
  IF FOUND AND v_prior.status <> 'failed' THEN
    RAISE EXCEPTION 'Already sent or outcome unknown - check Sent Items before retrying' USING ERRCODE = 'PT409';
  END IF;

  -- The limit for this person and hour (a retried row is not counted twice: it is excluded here and counts again once
  -- it is dated now).
  IF (SELECT count(*) FROM security_audit.mail_send_ledger
      WHERE user_id = v_user AND created_at > now() - INTERVAL '1 hour' AND id IS DISTINCT FROM v_prior.id) >= 20 THEN
    RAISE EXCEPTION 'Rate limit exceeded. Max 20 emails per hour.' USING ERRCODE = 'PT429', HINT = 'user';
  END IF;

  IF v_prior.id IS NOT NULL THEN
    UPDATE public.email_history SET status = 'sending', to_email = v_to, drafted_by = v_user WHERE id = v_prior.history_id RETURNING id INTO v_history;
    IF v_history IS NULL THEN
      INSERT INTO public.email_history (organization_id, to_email, subject, body, related_to_type, related_to_id, drafted_by, status)
      VALUES (v_org, v_to, p_subject, p_body, CASE WHEN v_rfq IS NULL THEN 'general' ELSE 'rfq' END, v_rfq::TEXT, v_user, 'sending')
      RETURNING id INTO v_history;
    END IF;
    UPDATE security_audit.mail_send_ledger
    SET status = 'sending', user_id = v_user, history_id = v_history, recipients = p_recipients, created_at = now(), updated_at = now()
    WHERE id = v_prior.id;
    RETURN jsonb_build_object('send_id', v_prior.id, 'history_id', v_history);
  END IF;

  INSERT INTO public.email_history (organization_id, to_email, subject, body, related_to_type, related_to_id, drafted_by, status)
  VALUES (v_org, v_to, p_subject, p_body, CASE WHEN v_rfq IS NULL THEN 'general' ELSE 'rfq' END, v_rfq::TEXT, v_user, 'sending')
  RETURNING id INTO v_history;
  INSERT INTO security_audit.mail_send_ledger (organization_id, user_id, kind, idempotency_key, recipients, history_id, status)
  VALUES (v_org, v_user, p_kind, p_key, p_recipients, v_history, 'sending')
  RETURNING * INTO v_prior;
  RETURN jsonb_build_object('send_id', v_prior.id, 'history_id', v_history);
END
$$;
REVOKE ALL ON FUNCTION public.reserve_mail_send(TEXT, TEXT, TEXT[], TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_mail_send(TEXT, TEXT, TEXT[], TEXT, TEXT, UUID) TO authenticated;

-- Records the outcome of a reserved send: accepted (also sets the history to sent_via_system), failed, or unknown
-- (the history stays 'sending'). Only the person who reserved it, while it is still 'sending'.
CREATE OR REPLACE FUNCTION public.complete_mail_send(p_id UUID, p_outcome TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row security_audit.mail_send_ledger;
BEGIN
  IF p_outcome NOT IN ('accepted', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'Unknown outcome' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM security_audit.mail_send_ledger
  WHERE id = p_id AND organization_id = public.current_user_organization_id() AND user_id = auth.uid() AND status = 'sending'
  FOR UPDATE;
  IF NOT FOUND OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  UPDATE security_audit.mail_send_ledger SET status = p_outcome, updated_at = now() WHERE id = p_id;
  IF p_outcome = 'accepted' THEN
    UPDATE public.email_history SET status = 'sent_via_system', sent_at = now() WHERE id = v_row.history_id;
  ELSIF p_outcome = 'failed' THEN
    UPDATE public.email_history SET status = 'failed' WHERE id = v_row.history_id;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.complete_mail_send(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_mail_send(UUID, TEXT) TO authenticated;

-- An admin who checked Sent Items settles an 'unknown' send (a stale 'sending' counts as unknown): it went ('sent') or it
-- didn't ('failed', so it may be tried again). A fresh 'sending' reservation can't be settled. Returns the e-mail history
-- id; the route records the decision in the audit log.
CREATE OR REPLACE FUNCTION public.resolve_mail_send(p_id UUID, p_as TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row security_audit.mail_send_ledger;
BEGIN
  IF public.current_user_organization_id() IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_as NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'Unknown resolution' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mail-send:' || public.current_user_organization_id()::TEXT, 0));
  PERFORM public.expire_stale_mail_sends();
  SELECT * INTO v_row FROM security_audit.mail_send_ledger
  WHERE id = p_id AND organization_id = public.current_user_organization_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Send not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'unknown' THEN
    RAISE EXCEPTION 'Only an unknown outcome can be resolved' USING ERRCODE = 'PT409';
  END IF;
  UPDATE security_audit.mail_send_ledger SET status = CASE p_as WHEN 'sent' THEN 'confirmed_sent' ELSE 'failed' END, updated_at = now() WHERE id = p_id;
  UPDATE public.email_history SET status = CASE p_as WHEN 'sent' THEN 'sent_via_system' ELSE 'failed' END,
                                  sent_at = CASE p_as WHEN 'sent' THEN now() ELSE sent_at END
  WHERE id = v_row.history_id;
  RETURN v_row.history_id;
END
$$;
REVOKE ALL ON FUNCTION public.resolve_mail_send(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_mail_send(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------

-- Where the inbox check is up to, per company: the paging link to continue from when a check stopped at its page limit
-- (so a long run of messages with one timestamp is read over several checks instead of starting again), and the time
-- to start a fresh check from. Written only by save_mail_poll_state(); admins can read it.
CREATE TABLE IF NOT EXISTS public.mail_poll_state (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  next_link       TEXT CHECK (next_link IS NULL OR next_link LIKE 'https://graph.microsoft.com/v1.0/%'),
  checkpoint      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.mail_poll_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mail_poll_state rbac select" ON public.mail_poll_state;
CREATE POLICY "mail_poll_state rbac select" ON public.mail_poll_state FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.mail_poll_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mail_poll_state TO authenticated;

-- p_checkpoint NULL keeps the stored checkpoint. p_next_link NULL clears the link.
CREATE OR REPLACE FUNCTION public.save_mail_poll_state(p_next_link TEXT, p_checkpoint TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.mail_poll_state (organization_id, next_link, checkpoint, updated_at)
  VALUES (v_org, p_next_link, p_checkpoint, now())
  ON CONFLICT (organization_id) DO UPDATE
    SET next_link = EXCLUDED.next_link, checkpoint = coalesce(EXCLUDED.checkpoint, public.mail_poll_state.checkpoint), updated_at = now();
END
$$;
REVOKE ALL ON FUNCTION public.save_mail_poll_state(TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_mail_poll_state(TEXT, TIMESTAMPTZ) TO authenticated;

-- -----------------------------------------------------------------------------------------------------

ALTER TABLE public.inbound_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inbound_emails rbac select" ON public.inbound_emails;
CREATE POLICY "inbound_emails rbac select" ON public.inbound_emails FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
REVOKE ALL ON public.inbound_emails FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inbound_emails TO authenticated;
