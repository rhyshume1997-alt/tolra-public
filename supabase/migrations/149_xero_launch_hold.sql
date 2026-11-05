-- 149: per-company Xero transfer launch hold, OFF for existing and new connections.
-- Main ends at 137; release147 and optional profitability148 are not modified.
BEGIN;
ALTER TABLE public.integration_connections ADD COLUMN transfers_enabled boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.integration_xero_transfer_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.integration_connections WHERE organization_id=p_org AND provider='xero' AND status='connected' AND transfers_enabled)
$$;
REVOKE ALL ON FUNCTION public.integration_xero_transfer_enabled(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.integration_xero_transfer_enabled(uuid) TO service_role;

CREATE FUNCTION public.integration_xero_launch_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.current_user_organization_id(); result jsonb;
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Admin required.' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('enabled',transfers_enabled,'connected',status='connected') INTO result
 FROM public.integration_connections WHERE organization_id=org AND provider='xero';
 RETURN coalesce(result,'{"enabled":false,"connected":false}'::jsonb);
END $$;
CREATE FUNCTION public.integration_xero_set_transfers(p_enabled boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,security_audit AS $$
DECLARE org uuid:=public.current_user_organization_id();
BEGIN
 PERFORM public.assert_privileged_aal();
 IF auth.uid() IS NULL OR org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Admin required.' USING ERRCODE='42501'; END IF;
 IF p_enabled IS NULL THEN RAISE EXCEPTION 'Choose on or off.' USING ERRCODE='22023'; END IF;
 UPDATE public.integration_connections SET transfers_enabled=p_enabled,updated_at=now()
 WHERE organization_id=org AND provider='xero' AND (NOT p_enabled OR status='connected');
 IF NOT FOUND THEN RAISE EXCEPTION 'Connect this company first.' USING ERRCODE='55000'; END IF;
 -- Existing table triggers enforce support read-only and admin MFA.
 PERFORM security_audit.log_named_event(org,'XERO_TRANSFERS_CHANGED','integration_connections',org::text,jsonb_build_object('enabled',p_enabled));
END $$;
REVOKE ALL ON FUNCTION public.integration_xero_launch_status(),public.integration_xero_set_transfers(boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.integration_xero_launch_status(),public.integration_xero_set_transfers(boolean) TO authenticated;

CREATE FUNCTION public.integration_xero_connection_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN NEW.transfers_enabled:=false; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER xero_connection_launch_hold BEFORE INSERT OR UPDATE ON public.integration_connections
 FOR EACH ROW EXECUTE FUNCTION public.integration_xero_connection_hold();

CREATE FUNCTION public.integration_xero_queue_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.provider='xero' AND NOT public.integration_xero_transfer_enabled(NEW.organization_id) THEN
  IF TG_OP='INSERT' THEN RETURN NULL; END IF; -- Do not break invoice issue; do not create a transfer queue row.
  IF NEW.status IN ('pending','sending') THEN
   RAISE EXCEPTION 'Xero transfers are off for this company.' USING ERRCODE='55000',HINT='xero_launch_hold';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER xero_queue_launch_hold BEFORE INSERT OR UPDATE ON public.integration_sends
 FOR EACH ROW EXECUTE FUNCTION public.integration_xero_queue_hold();
REVOKE ALL ON FUNCTION public.integration_xero_connection_hold(),public.integration_xero_queue_hold() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.integration_claim_next(p_org UUID, p_provider TEXT, p_lease_seconds INTEGER DEFAULT 120,
                                                        p_doc_type TEXT DEFAULT NULL, p_doc_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status   TEXT;
  v_tenant   TEXT;
  v_unmapped TEXT[];
  v_row      RECORD;
  v_ext      TEXT;
  v_claim    UUID := gen_random_uuid();
BEGIN
  IF p_provider = 'xero' AND NOT public.integration_xero_transfer_enabled(p_org) THEN
    RETURN jsonb_build_object('blocked','launch_hold','send',NULL);
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 900 THEN
    RAISE EXCEPTION 'A claim lasts 10 to 900 seconds.' USING ERRCODE = '22023';
  END IF;
  SELECT c.status, c.tenant_id INTO v_status, v_tenant FROM public.integration_connections c WHERE c.organization_id = p_org AND c.provider = p_provider;
  IF v_status IS DISTINCT FROM 'connected' THEN
    RETURN jsonb_build_object('blocked', coalesce(v_status, 'not_connected'), 'send', NULL);
  END IF;

  UPDATE public.integration_sends s
  SET status = 'needs_check', claimed_until = NULL, updated_at = now(),
      last_error = 'The send stopped before its result came back: check Xero before sending it again.'
  WHERE s.organization_id = p_org AND s.provider = p_provider AND s.status = 'sending' AND s.claimed_until < now();
  UPDATE public.integration_sends s
  SET status = 'skipped', last_error = 'Started for another Xero organisation: not sent to this one.', updated_at = now()
  WHERE s.organization_id = p_org AND s.provider = p_provider AND s.status = 'pending' AND s.tenant_id IS NOT NULL AND s.tenant_id <> v_tenant;
  UPDATE public.integration_sends c
  SET status = 'skipped', last_error = 'Voided in Tolra before it reached Xero: not sent.', updated_at = now()
  WHERE c.organization_id = p_org AND c.provider = p_provider AND c.action = 'create' AND c.external_id IS NULL
    AND ((c.status = 'failed') OR (c.status = 'pending' AND c.attempts = 0))
    AND EXISTS (SELECT 1 FROM public.integration_sends v WHERE v.organization_id = c.organization_id AND v.provider = c.provider
                  AND v.doc_type = c.doc_type AND v.doc_id = c.doc_id AND v.action = 'void' AND v.status = 'pending');
  UPDATE public.integration_sends v
  SET status = 'skipped', last_error = 'Its invoice never reached Xero: nothing to void.', updated_at = now()
  WHERE v.organization_id = p_org AND v.provider = p_provider AND v.action = 'void' AND v.status = 'pending'
    AND EXISTS (SELECT 1 FROM public.integration_sends c WHERE c.organization_id = v.organization_id AND c.provider = v.provider
                  AND c.doc_type = v.doc_type AND c.doc_id = v.doc_id AND c.action = 'create' AND c.status = 'skipped');
  UPDATE public.integration_sends v
  SET status = 'skipped', last_error = 'Its invoice was sent to another Xero organisation (connected before): void it there by hand.', updated_at = now()
  WHERE v.organization_id = p_org AND v.provider = p_provider AND v.action = 'void' AND v.status = 'pending'
    AND EXISTS (SELECT 1 FROM public.integration_sends c WHERE c.organization_id = v.organization_id AND c.provider = v.provider
                  AND c.doc_type = v.doc_type AND c.doc_id = v.doc_id AND c.action = 'create' AND c.tenant_id IS NOT NULL AND c.tenant_id <> v_tenant);

  v_unmapped := public.integration_unmapped(p_org, p_provider);
  IF cardinality(v_unmapped) > 0 THEN
    RETURN jsonb_build_object('blocked', 'unmapped', 'unmapped', to_jsonb(v_unmapped), 'send', NULL);
  END IF;

  SELECT s.id, s.doc_type, s.doc_id, s.doc_ref, s.action, s.attempts, s.external_id INTO v_row
  FROM public.integration_sends s
  WHERE s.organization_id = p_org AND s.provider = p_provider AND s.status = 'pending' AND s.next_attempt_at <= now()
    -- With a document (the automatic send right after it is issued or voided, Rhys Wed 21 Oct): only that document's first attempt;
    -- every retry and every other document waits for an admin's Send now (or the daily sweep).
    AND (p_doc_id IS NULL OR (s.doc_id = p_doc_id AND s.doc_type = p_doc_type AND s.attempts = 0))
    AND (s.action = 'create'
         OR EXISTS (SELECT 1 FROM public.integration_sends c WHERE c.organization_id = s.organization_id AND c.provider = s.provider
                      AND c.doc_type = s.doc_type AND c.doc_id = s.doc_id AND c.action = 'create' AND c.external_id IS NOT NULL
                      AND c.status IN ('sent', 'failed') AND c.tenant_id = v_tenant))
  ORDER BY s.created_at, s.id
  LIMIT 1
  FOR UPDATE OF s SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('blocked', NULL, 'send', NULL);
  END IF;
  IF v_row.action = 'void' THEN
    SELECT c.external_id INTO v_ext FROM public.integration_sends c WHERE c.organization_id = p_org AND c.provider = p_provider
      AND c.doc_type = v_row.doc_type AND c.doc_id = v_row.doc_id AND c.action = 'create';
  ELSE
    v_ext := v_row.external_id;
  END IF;
  UPDATE public.integration_sends s
  SET status = 'sending', claim_token = v_claim, claimed_until = now() + make_interval(secs => p_lease_seconds),
      attempts = s.attempts + 1, tenant_id = v_tenant, updated_at = now()
  WHERE s.id = v_row.id;
  RETURN jsonb_build_object('blocked', NULL, 'send', jsonb_build_object('id', v_row.id, 'claim', v_claim, 'doc_type', v_row.doc_type,
    'doc_id', v_row.doc_id, 'doc_ref', v_row.doc_ref, 'action', v_row.action, 'attempts', v_row.attempts + 1, 'external_id', v_ext,
    'tenant_id', v_tenant));
END
$$;

CREATE OR REPLACE FUNCTION public.integration_retry_send(p_send UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_row RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can send a document again.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.integration_xero_transfer_enabled(v_org) THEN
    RAISE EXCEPTION 'Xero transfers are off for this company.' USING ERRCODE='55000', HINT='xero_launch_hold';
  END IF;
  SELECT s.id, s.status, s.doc_type, s.doc_ref, s.action INTO v_row FROM public.integration_sends s
  WHERE s.id = p_send AND s.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Send not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status NOT IN ('failed', 'needs_check') THEN
    RAISE EXCEPTION 'Only a failed send, or one to check, can be sent again.' USING ERRCODE = '22023', HINT = 'not_retryable';
  END IF;
  UPDATE public.integration_sends s SET status = 'pending', next_attempt_at = now(), claimed_until = NULL, updated_at = now()
  WHERE s.id = p_send AND s.organization_id = v_org;
  PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_SEND_RETRY', 'integration_sends', p_send::TEXT,
    jsonb_build_object('doc_type', v_row.doc_type, 'doc_ref', v_row.doc_ref, 'action', v_row.action, 'was', v_row.status));
  RETURN jsonb_build_object('id', p_send, 'status', 'pending');
END
$$;
COMMIT;
