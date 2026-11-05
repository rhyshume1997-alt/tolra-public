-- Post-144 release step 149. One-time, one transaction; never part of baseline replay.
-- Canonical source: supabase/proposals/x149_xero_launch_hold.sql (read its header for what it does and why). Existing objects cause refusal, never overwrite.
-- Apply only after 147 (and 144, whose connections table this guards). Verify: supabase/verify/xero_launch_hold_149.sql (every row t).
-- Rollback: supabase/release/149_xero_launch_hold.rollback.sql (refuses while a connected company is still held unless told that old sending is accepted).
BEGIN;
DO $post_release_guard$ BEGIN
 IF to_regprocedure('public.create_job_delivery_note(uuid,uuid,uuid,date,date,text,text,jsonb)') IS NULL OR to_regclass('public.company_setup_progress') IS NULL THEN
  RAISE EXCEPTION '149: required releases 145, 146 and 147 are missing; stop and check release preflight';
 END IF;
 IF to_regclass('public.integration_connections') IS NULL OR to_regclass('public.integration_sends') IS NULL OR to_regclass('public.organizations') IS NULL
    OR to_regprocedure('public.integration_unmapped(uuid,text)') IS NULL OR to_regprocedure('public.integration_record_result(uuid,uuid,text,text,text,text,timestamptz)') IS NULL
    OR to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public._session_membership()') IS NULL
    OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL OR to_regprocedure('public.current_user_organization_id()') IS NULL
    OR to_regprocedure('public.has_org_role(text[])') IS NULL THEN
  RAISE EXCEPTION '149: the Xero connection tables and helper functions it builds on (084, 144, 033, 036, 035) are not all in place; stop and check release preflight';
 END IF;
 -- The two functions replaced here must still be 084's (md5 of the body without whitespace); a different body is stopped and compared.
 IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.integration_claim_next(uuid,text,integer,text,uuid)')) IS DISTINCT FROM '1e926cf7051cc6614f0cfc6b2124b470'
    OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.integration_retry_send(uuid)')) IS DISTINCT FROM '1e8e2136759e43952aa406f8a6bcac88' THEN
  RAISE EXCEPTION '149: integration_claim_next or integration_retry_send is not 084''s; stop and compare it first';
 END IF;
 IF to_regclass('public.xero_transfer_hold') IS NOT NULL THEN RAISE EXCEPTION '149: the hold table already exists; this one-time release was applied before'; END IF;
END $post_release_guard$;

-- 1. One hold row per company. Nobody (no API role, not the service role) reads or writes it directly: only the definer functions below.
CREATE TABLE public.xero_transfer_hold (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  changed_by      uuid,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  reason          text
);
ALTER TABLE public.xero_transfer_hold ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xero_transfer_hold FROM PUBLIC, anon, authenticated, service_role;
-- Every company that exists now starts OFF, connected or not.
INSERT INTO public.xero_transfer_hold (organization_id, enabled, reason) SELECT o.id, false, 'installed off' FROM public.organizations o;

-- 2. The gate: ON only when the row says on AND the company is connected. Missing row = OFF. Server only.
CREATE FUNCTION public.integration_xero_transfer_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.xero_transfer_hold h WHERE h.organization_id = p_org AND h.enabled)
     AND EXISTS (SELECT 1 FROM public.integration_connections c WHERE c.organization_id = p_org AND c.provider = 'xero' AND c.status = 'connected')
$$;
REVOKE ALL ON FUNCTION public.integration_xero_transfer_enabled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_xero_transfer_enabled(uuid) TO service_role;

-- 3. The companies the daily sweep may renew and send for: switched on and connected. Server only.
CREATE FUNCTION public.integration_xero_enabled_orgs() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(h.organization_id ORDER BY h.organization_id), '{}'::uuid[]) FROM public.xero_transfer_hold h
  JOIN public.integration_connections c ON c.organization_id = h.organization_id AND c.provider = 'xero' AND c.status = 'connected'
  WHERE h.enabled
$$;
REVOKE ALL ON FUNCTION public.integration_xero_enabled_orgs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_xero_enabled_orgs() TO service_role;

-- 4. What the admin's card shows: the effective switch (the gate's own answer), the connection and whether it is mapped.
CREATE FUNCTION public.integration_xero_launch_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org    uuid := public.current_user_organization_id();
  v_status text;
  v_un     text[];
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Admin required.' USING ERRCODE = '42501';
  END IF;
  SELECT c.status INTO v_status FROM public.integration_connections c WHERE c.organization_id = v_org AND c.provider = 'xero';
  v_un := CASE WHEN v_status = 'connected' THEN public.integration_unmapped(v_org, 'xero') ELSE ARRAY['not connected']::text[] END;
  RETURN jsonb_build_object('enabled', public.integration_xero_transfer_enabled(v_org), 'connected', coalesce(v_status = 'connected', false),
                            'status', coalesce(v_status, 'not_connected'), 'mapped', cardinality(v_un) = 0 AND v_status = 'connected');
END
$$;

-- 5. Turn it on or off (signed in, the company's own admin, not a support session). ON needs connected AND mapped; where the company
-- requires the second step (organizations.require_admin_mfa), ON also needs an authenticator code from the last 15 minutes (as release 136).
-- OFF is always allowed to an admin. The connection row is locked first, the hold row second (the reset trigger takes them in that order too).
CREATE FUNCTION public.integration_xero_set_transfers(p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, security_audit AS $$
DECLARE
  v_org    uuid := public.current_user_organization_id();
  v_uid    uuid := auth.uid();
  v_status text;
  v_was    boolean;
  v_now    numeric := extract(epoch FROM now());
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can turn Xero transfers on or off.' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'Choose on or off.' USING ERRCODE = '22023'; END IF;
  SELECT c.status INTO v_status FROM public.integration_connections c WHERE c.organization_id = v_org AND c.provider = 'xero' FOR SHARE;
  IF p_enabled THEN
    IF v_status IS DISTINCT FROM 'connected' THEN
      RAISE EXCEPTION 'Connect this company to Xero first.' USING ERRCODE = '55000', HINT = 'not_connected';
    END IF;
    IF cardinality(public.integration_unmapped(v_org, 'xero')) > 0 THEN
      RAISE EXCEPTION 'Finish the Xero mapping first.' USING ERRCODE = '55000', HINT = 'not_mapped';
    END IF;
    IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::text) = 'authenticated'
       AND coalesce((SELECT o.require_admin_mfa FROM public.organizations o WHERE o.id = v_org), false)
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END) AS e
         WHERE e ->> 'method' IN ('totp', 'mfa/totp')
           AND CASE WHEN jsonb_typeof(e -> 'timestamp') = 'number' THEN (e ->> 'timestamp')::numeric END BETWEEN v_now - 900 AND v_now + 60) THEN
      RAISE EXCEPTION 'Enter a fresh code from your authenticator app to turn Xero transfers on.' USING ERRCODE = '42501', HINT = 'mfa_recent_required';
    END IF;
  END IF;
  INSERT INTO public.xero_transfer_hold (organization_id, enabled) VALUES (v_org, false) ON CONFLICT (organization_id) DO NOTHING;
  SELECT h.enabled INTO v_was FROM public.xero_transfer_hold h WHERE h.organization_id = v_org FOR UPDATE;
  IF v_was IS DISTINCT FROM p_enabled THEN
    UPDATE public.xero_transfer_hold h SET enabled = p_enabled, changed_by = v_uid, changed_at = now(), reason = 'admin' WHERE h.organization_id = v_org;
    PERFORM security_audit.log_named_event(v_org, 'XERO_TRANSFERS_CHANGED', 'xero_transfer_hold', v_org::text,
      jsonb_build_object('enabled', p_enabled, 'was', v_was, 'actor', v_uid));
  END IF;
  RETURN jsonb_build_object('enabled', p_enabled);
END
$$;
-- Signed-in admins only: not the service role either (the app's own server work has no business flipping a company's switch).
REVOKE ALL ON FUNCTION public.integration_xero_launch_status(), public.integration_xero_set_transfers(boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.integration_xero_launch_status(), public.integration_xero_set_transfers(boolean) TO authenticated;

-- 6. Any change to the Xero connection that makes it a different or a new one puts the company back to OFF: a first connection, a reconnect
-- or a fresh consent (connected_at), another Xero organisation, a status change (needs_reconnect, disconnected, connected again), the row
-- deleted. Other columns (a token refresh, updated_at) do not.
CREATE FUNCTION public.integration_xero_connection_reset() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, security_audit AS $$
DECLARE
  v_org uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  v_was boolean;
BEGIN
  IF (CASE WHEN TG_OP = 'DELETE' THEN OLD.provider ELSE NEW.provider END) IS DISTINCT FROM 'xero' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.connected_at IS NOT DISTINCT FROM OLD.connected_at AND NEW.external_connection_id IS NOT DISTINCT FROM OLD.external_connection_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.xero_transfer_hold (organization_id, enabled, reason) VALUES (v_org, false, 'connection changed') ON CONFLICT (organization_id) DO NOTHING;
  SELECT h.enabled INTO v_was FROM public.xero_transfer_hold h WHERE h.organization_id = v_org FOR UPDATE;
  IF v_was THEN
    UPDATE public.xero_transfer_hold h SET enabled = false, changed_by = auth.uid(), changed_at = now(), reason = 'connection changed' WHERE h.organization_id = v_org;
    PERFORM security_audit.log_named_event(v_org, 'XERO_TRANSFERS_CHANGED', 'xero_transfer_hold', v_org::text,
      jsonb_build_object('enabled', false, 'was', true, 'actor', auth.uid(), 'because', 'connection changed'));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.integration_xero_connection_reset() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER xero_connection_reset AFTER INSERT OR UPDATE OR DELETE ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.integration_xero_connection_reset();

-- 7. The two functions that claim and re-queue a send (084's, replaced with the switch added; every other line is 084's).
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
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 900 THEN
    RAISE EXCEPTION 'A claim lasts 10 to 900 seconds.' USING ERRCODE = '22023';
  END IF;
  SELECT c.status, c.tenant_id INTO v_status, v_tenant FROM public.integration_connections c WHERE c.organization_id = p_org AND c.provider = p_provider;
  IF v_status IS DISTINCT FROM 'connected' THEN
    RETURN jsonb_build_object('blocked', coalesce(v_status, 'not_connected'), 'send', NULL);
  END IF;
  -- 149: the per-company Xero transfer switch, judged HERE, in the one function that turns a queued row into a send, before this function
  -- changes any row. Every path (daily sweep, after-issue, Send now, batch, retry) goes through this claim, so a bypass in the app cannot send.
  IF p_provider = 'xero' AND NOT public.integration_xero_transfer_enabled(p_org) THEN
    RETURN jsonb_build_object('blocked', 'launch_hold', 'send', NULL);
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
  SELECT s.id, s.status, s.provider, s.doc_type, s.doc_ref, s.action INTO v_row FROM public.integration_sends s
  WHERE s.id = p_send AND s.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Send not found.' USING ERRCODE = 'P0002';
  END IF;
  -- 149: a company's own row first (a foreign id is still 'not found'), then the switch: off means nothing is queued again.
  IF v_row.provider = 'xero' AND NOT public.integration_xero_transfer_enabled(v_org) THEN
    RAISE EXCEPTION 'Xero transfers are off for this company.' USING ERRCODE = '55000', HINT = 'xero_launch_hold';
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

-- Self-check: everything above is in place; nobody but the definer functions can reach the hold table; every company has a row, none ON.
DO $self$ BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.xero_transfer_hold'::regclass)
    OR has_table_privilege('anon', 'public.xero_transfer_hold', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated', 'public.xero_transfer_hold', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('service_role', 'public.xero_transfer_hold', 'SELECT,INSERT,UPDATE,DELETE')
    OR EXISTS (SELECT 1 FROM public.organizations o WHERE NOT EXISTS (SELECT 1 FROM public.xero_transfer_hold h WHERE h.organization_id = o.id))
    OR EXISTS (SELECT 1 FROM public.xero_transfer_hold h WHERE h.enabled) THEN
  RAISE EXCEPTION '149: self-check failed (hold table access or the off-for-everyone start)';
 END IF;
END $self$;

COMMIT;
