-- 144_accounting_connections.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- 144: cloud accounting connections and read-only balance evidence. No invoice/payment records changed.
-- Reuse the existing company-bound OAuth state, tenant uniqueness, encrypted secrets and refresh leases.
-- Only connections/secrets/states accept the new providers. Mapping/contact/send tables remain Xero-only.
-- Prerequisite: 107. New app credentials are environment-only. No provider subscription is purchased.
ALTER TABLE public.integration_connections DROP CONSTRAINT integration_connections_provider_check;
ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_provider_check CHECK (provider IN ('xero', 'microsoft', 'sage', 'quickbooks'));
ALTER TABLE public.integration_secrets DROP CONSTRAINT integration_secrets_provider_check;
ALTER TABLE public.integration_secrets ADD CONSTRAINT integration_secrets_provider_check CHECK (provider IN ('xero', 'microsoft', 'sage', 'quickbooks'));
ALTER TABLE public.integration_oauth_states DROP CONSTRAINT integration_oauth_states_provider_check;
ALTER TABLE public.integration_oauth_states ADD CONSTRAINT integration_oauth_states_provider_check CHECK (provider IN ('xero', 'microsoft', 'sage', 'quickbooks'));
CREATE OR REPLACE FUNCTION public.integration_oauth_start(p_provider TEXT, p_state_hash TEXT, p_verifier_enc TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can connect it.' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('xero', 'microsoft', 'sage', 'quickbooks') THEN
    RAISE EXCEPTION 'Unknown provider.' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.integration_oauth_states s
  WHERE s.organization_id = v_org AND (s.consumed_at IS NOT NULL OR s.expires_at < now());
  IF (SELECT count(*) FROM public.integration_oauth_states s WHERE s.organization_id = v_org AND s.user_id = v_uid) >= 5 THEN
    RAISE EXCEPTION 'Too many Connect attempts are open: wait 10 minutes and try again.' USING ERRCODE = '54000', HINT = 'too_many_attempts';
  END IF;
  INSERT INTO public.integration_oauth_states (organization_id, provider, user_id, state_hash, verifier_enc, expires_at)
  VALUES (v_org, p_provider, v_uid, p_state_hash, p_verifier_enc, now() + interval '10 minutes')
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Read-only connections must never enqueue an outbound accounting send.
CREATE OR REPLACE FUNCTION public.integration_enqueue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_was  TEXT := lower(coalesce(OLD.status, 'draft'));
  v_is   TEXT := lower(coalesce(NEW.status, 'draft'));
  v_type TEXT := CASE TG_TABLE_NAME WHEN 'invoices' THEN 'invoice' ELSE 'credit_note' END;
  v_ref  TEXT := left(to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'invoices' THEN 'invoice_ref' ELSE 'credit_ref' END, 100);
  v_conn RECORD;
BEGIN
  IF v_was = v_is THEN
    RETURN NULL;
  END IF;
  IF current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT
     OR EXISTS (SELECT 1 FROM public.import_record_keys k WHERE k.organization_id = NEW.organization_id AND k.record_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  FOR v_conn IN SELECT c.provider FROM public.integration_connections c
                WHERE c.organization_id = NEW.organization_id AND c.provider = 'xero' AND c.status IN ('connected', 'needs_reconnect') ORDER BY c.provider LOOP
    IF v_was = 'draft' AND v_is NOT IN ('void', 'cancelled') THEN
      INSERT INTO public.integration_sends (organization_id, provider, doc_type, doc_id, doc_ref, action)
      VALUES (NEW.organization_id, v_conn.provider, v_type, NEW.id, v_ref, 'create')
      ON CONFLICT ON CONSTRAINT integration_sends_once DO NOTHING;
    ELSIF v_type = 'invoice' AND v_is IN ('void', 'cancelled') AND v_was NOT IN ('void', 'cancelled', 'draft')
          AND EXISTS (SELECT 1 FROM public.integration_sends s WHERE s.organization_id = NEW.organization_id AND s.provider = v_conn.provider
                        AND s.doc_type = 'invoice' AND s.doc_id = NEW.id AND s.action = 'create') THEN
      INSERT INTO public.integration_sends (organization_id, provider, doc_type, doc_id, doc_ref, action)
      VALUES (NEW.organization_id, v_conn.provider, 'invoice', NEW.id, v_ref, 'void')
      ON CONFLICT ON CONSTRAINT integration_sends_once DO NOTHING;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION public.accounting_cloud_connections_ready()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT TRUE $$;
REVOKE ALL ON FUNCTION public.accounting_cloud_connections_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_cloud_connections_ready() TO service_role;

COMMIT;
