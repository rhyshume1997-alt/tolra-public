-- =====================================================================================================
-- 122: the AI helper's monthly cost cap defaults to GBP 5 a month per company (monthly_cap_pence 500; it was 0). Rhys's decision,
-- 30 Oct 19:12 GMT. Needs 101 (ai_helper_settings, ai_helper_status). Touches no other migration's objects.
--
-- WHAT CHANGES. Two things, both for a company the admin has not given a cap of its own:
--   a. public.ai_helper_settings.monthly_cap_pence: column DEFAULT 0 becomes DEFAULT 500 (inside 101's CHECK, 0 to 100000). A row
--      made from now on without a cap (ai_helper_set_key, 106's ai_helper_set_finance_check) gets 500.
--   b. public.ai_helper_status(): a company with no settings row reads monthly_cap_pence 500 (was 0). 101's body (the newest: no later
--      migration replaces it), one value changed. Same name, signature, STABLE, SECURITY DEFINER, search_path, owner and grants
--      (signed-in only, as 101). The switches still default to off, the key is still needed, and ai_helper_save_settings still
--      accepts 0 to 100000.
--   ai_helper_reserve is NOT changed (it stays 103's): a company with no settings row has every feature off, so reserve stops before
--   the cap and is never reached without a row; a row made from now on carries the 500 default itself.
-- EXISTING ROWS KEEP THEIR VALUE. No row is updated: a cap an admin saved stands, and so does a 0 a row took from the old default
-- (a row made by setting a key or the finance-check switch before 122). Rhys decides whether to update any of those.
-- After 122, 101's verify row off_by_default reads FALSE by design (the default is now 500); supabase/verify/ai_helper_cap_default_122.sql
-- checks the new state.
-- GUARD (section 1): ai_helper_status's body must be 101's (or already this file's), md5 with every whitespace character removed. Safe to
-- run again. SELF-CHECK (section 4). Verify: supabase/verify/ai_helper_cap_default_122.sql (every row TRUE).
-- Rollback: supabase/release/122_ai_helper_cap_default.rollback.sql (puts back 101's ai_helper_status and DEFAULT 0; rows stay as they are;
-- only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: 101's tables and ai_helper_status are there, and its body is 101's (or already this file's).
DO $$
DECLARE
  v_status  TEXT;
BEGIN
  IF to_regclass('public.ai_helper_settings') IS NULL OR to_regclass('public.ai_helper_usage') IS NULL OR to_regclass('public.ai_helper_secrets') IS NULL THEN
    RAISE EXCEPTION '122: 101''s AI helper tables are missing; apply 101 first';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_status()') INTO v_status;
  -- d204592e87f38efef24ea008ede7948c: 101's ai_helper_status; 3ef44c838451b46ea14030164d9b1384: this file's (section 2).
  IF v_status IS NULL OR v_status NOT IN ('d204592e87f38efef24ea008ede7948c', '3ef44c838451b46ea14030164d9b1384') THEN
    RAISE EXCEPTION '122: public.ai_helper_status is not 101''s (md5 without whitespace %); stop and compare it first', coalesce(v_status, 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. ai_helper_status: 101's body; a company with no settings row reads a cap of 500 (was 0).
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
    'monthly_cap_pence', coalesce(v_set.monthly_cap_pence, 500),
    'key_set', EXISTS (SELECT 1 FROM public.ai_helper_secrets k WHERE k.organization_id = v_org),
    'key_last4', CASE WHEN v_admin THEN v_set.api_key_last4 END,
    'month_spent_pence', coalesce(v_use.spent_pence, 0),
    'month_reserved_pence', coalesce(v_use.reserved_pence, 0),
    'can_manage', v_admin);
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 3. The grant exactly as 101 left it (CREATE OR REPLACE keeps it; restated so a re-run cannot drift), and the column default.
--    No row is updated.
REVOKE ALL ON FUNCTION public.ai_helper_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_status() TO authenticated;
ALTER TABLE public.ai_helper_settings ALTER COLUMN monthly_cap_pence SET DEFAULT 500;

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check before COMMIT (the same checks as supabase/verify/ai_helper_cap_default_122.sql): ai_helper_status's body is 122's, definer with
--    101's search_path, signed-in only (authenticated may, anon and PUBLIC may not); the column default is 500.
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '3ef44c838451b46ea14030164d9b1384' OR p.provolatile <> 's'
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_status()')) IS NOT FALSE THEN
    RAISE EXCEPTION '122: ai_helper_status is not 122''s after the replace';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.ai_helper_status()'] LOOP
    IF (SELECT NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
               OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
               OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) IS NOT FALSE THEN
      RAISE EXCEPTION '122: % is not definer, pinned and signed-in only', v_fn;
    END IF;
  END LOOP;
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings'
        AND column_name = 'monthly_cap_pence') IS DISTINCT FROM '500' THEN
    RAISE EXCEPTION '122: ai_helper_settings.monthly_cap_pence does not default to 500';
  END IF;
END
$$;
