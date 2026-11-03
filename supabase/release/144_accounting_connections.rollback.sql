-- Roll back application first. Refuse to discard any company's live connection or sign-in.
BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.integration_connections WHERE provider IN ('sage','quickbooks'))
 OR EXISTS (SELECT 1 FROM public.integration_secrets WHERE provider IN ('sage','quickbooks'))
 OR EXISTS (SELECT 1 FROM public.integration_oauth_states WHERE provider IN ('sage','quickbooks')) THEN
 RAISE EXCEPTION 'Disconnect cloud connections and review/clear their expired states before rollback; no data was removed.';
 END IF;
END $$;
DROP FUNCTION public.accounting_cloud_connections_ready();
ALTER TABLE public.integration_connections DROP CONSTRAINT integration_connections_provider_check;
ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_provider_check CHECK (provider IN ('xero','microsoft'));
ALTER TABLE public.integration_secrets DROP CONSTRAINT integration_secrets_provider_check;
ALTER TABLE public.integration_secrets ADD CONSTRAINT integration_secrets_provider_check CHECK (provider IN ('xero','microsoft'));
ALTER TABLE public.integration_oauth_states DROP CONSTRAINT integration_oauth_states_provider_check;
ALTER TABLE public.integration_oauth_states ADD CONSTRAINT integration_oauth_states_provider_check CHECK (provider IN ('xero','microsoft'));
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
  IF p_provider IS NULL OR p_provider NOT IN ('xero', 'microsoft') THEN
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
-- Restore trigger targets; the original 084 function was never replaced.
DROP TRIGGER IF EXISTS zz_integration_enqueue ON public.invoices;
CREATE TRIGGER zz_integration_enqueue AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.integration_enqueue();
DROP TRIGGER IF EXISTS zz_integration_enqueue ON public.credit_notes;
CREATE TRIGGER zz_integration_enqueue AFTER UPDATE OF status ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.integration_enqueue();
DROP FUNCTION public.accounting_cloud_enqueue();
COMMIT;
