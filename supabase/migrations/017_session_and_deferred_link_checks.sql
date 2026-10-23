-- =====================================================================================================
-- 017: close two gaps found after 014-016 (audit SEC7 and SEC14 follow-ups).
--
-- 1. Revoked sessions lose API access at once, not when their access token expires.
--    Signing out, a password change (other sessions) or an admin-set password deletes the session in Auth, but the
--    already-issued access token stays valid at the REST API until it expires (up to an hour). A PostgREST
--    pre-request check (runs once per REST/RPC request, before the query) now refuses a signed-in request whose
--    token's session (JWT claim session_id) no longer exists. It is deliberately not in the per-row access helpers:
--    measured there it made a 20,000-row read 8.5x slower.
--    Not covered: the Storage API (separate service) still accepts such a token until it expires.
--
-- 2. Deferred order<->job links are re-checked at commit.
--    sales_orders.converted_to_job_id and jobs.converted_from_sales_order_id have DEFERRABLE foreign keys (imports
--    create the pair in one transaction). The immediate same-organisation trigger (015) skips a link whose target
--    doesn't exist yet, so a target created later in the same transaction in another organisation slipped through.
--    A deferred constraint trigger now repeats the check at commit. Same-organisation imports are unchanged.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- ---- 1. live session check for REST / RPC ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.session_is_active()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.sessions s
    WHERE s.id = nullif(auth.jwt() ->> 'session_id', '')::UUID
      AND s.user_id = auth.uid()
      AND (s.not_after IS NULL OR s.not_after > now())
  )
$$;
REVOKE ALL ON FUNCTION public.session_is_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_is_active() TO authenticated, service_role;

-- Called by PostgREST before every request (pgrst.db_pre_request). Only signed-in user requests are checked:
-- anon and service_role requests pass untouched.
CREATE OR REPLACE FUNCTION public.check_request_session()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.jwt() ->> 'role' = 'authenticated' AND auth.uid() IS NOT NULL AND NOT public.session_is_active() THEN
    RAISE EXCEPTION 'Your session has ended. Sign in again.' USING ERRCODE = '28000';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.check_request_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_request_session() TO anon, authenticated, service_role;

-- Never replace someone else's request hook: if a different pgrst.db_pre_request is configured in the database (for
-- the authenticator role, in any database, or database-wide), stop here so both checks can be reviewed and combined
-- into one function first. Re-running with this hook already set is a no-op. (A hook configured outside the database,
-- in the API server's own settings, isn't visible here; see docs/RELEASE-CHECKLIST.md.)
DO $$
DECLARE
  v_existing TEXT;
BEGIN
  SELECT string_agg(DISTINCT split_part(cfg, '=', 2), ', ') INTO v_existing
  FROM pg_db_role_setting s
  CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
  WHERE (s.setrole = 0 OR s.setrole = 'authenticator'::regrole)
    AND cfg LIKE 'pgrst.db_pre_request=%'
    AND split_part(cfg, '=', 2) <> 'public.check_request_session';
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'An existing PostgREST request hook is configured (%). 017 will not replace it: combine both checks first.', v_existing
      USING ERRCODE = '55000';
  END IF;
END
$$;
ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.check_request_session';
NOTIFY pgrst, 'reload config';

-- ---- 2. deferred re-check of the deferrable order<->job links ------------------------------------------
DROP TRIGGER IF EXISTS zz_same_org_deferred_converted_to_job_id ON public.sales_orders;
CREATE CONSTRAINT TRIGGER zz_same_org_deferred_converted_to_job_id
  AFTER INSERT OR UPDATE OF converted_to_job_id, organization_id ON public.sales_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'converted_to_job_id');

DROP TRIGGER IF EXISTS zz_same_org_deferred_converted_from_sales_order_id ON public.jobs;
CREATE CONSTRAINT TRIGGER zz_same_org_deferred_converted_from_sales_order_id
  AFTER INSERT OR UPDATE OF converted_from_sales_order_id, organization_id ON public.jobs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('sales_orders', 'converted_from_sales_order_id');
