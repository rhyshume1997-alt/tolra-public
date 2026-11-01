-- 122 rollback: ONLY with Rhys's approval. Puts back 101's public.ai_helper_status() byte for byte (same signature, security,
-- search_path and grants) and the column default 0 on ai_helper_settings.monthly_cap_pence. ai_helper_reserve is untouched (122 does
-- not change it). No row is changed: a row made while 122 was applied without a cap of its own (a key set, the finance-check switch)
-- keeps its 500, and every saved cap stands; Rhys decides whether to update any. Run the whole text as one transaction, then the
-- release preflight (marker 122 shows "not applied", 101 still "applied").
BEGIN;
DO $$
DECLARE
  v_status  TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_helper_status()') INTO v_status;
  -- 3ef44c83...: 122's body; d204592e...: 101's (a second run of this rollback).
  IF v_status IS NULL OR v_status NOT IN ('3ef44c838451b46ea14030164d9b1384', 'd204592e87f38efef24ea008ede7948c') THEN
    RAISE EXCEPTION '122 rollback: ai_helper_status (md5 %) is neither 122''s nor 101''s; stop and compare', coalesce(v_status, 'missing');
  END IF;
END
$$;

-- 101's ai_helper_status, verbatim (supabase/migrations/101_ai_helper.sql).
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

REVOKE ALL ON FUNCTION public.ai_helper_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_status() TO authenticated;
ALTER TABLE public.ai_helper_settings ALTER COLUMN monthly_cap_pence SET DEFAULT 0;

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_status()')) IS DISTINCT FROM 'd204592e87f38efef24ea008ede7948c'
     OR (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'monthly_cap_pence') IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION '122 rollback: 101''s ai_helper_status or the default 0 is not back';
  END IF;
END
$$;
COMMIT;
