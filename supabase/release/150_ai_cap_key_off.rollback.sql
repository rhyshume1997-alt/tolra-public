-- Post-144 rollback of release 150. Review first: puts the own-key default cap back to 500, the status fallback back to 500, ai_helper_set_key back to 101's
-- body (a key save, replacement or removal no longer switches AI off), ai_helper_tolra_configure, ai_helper_reserve and ai_helper_reserve_assistant
-- back to 146's bodies (each mode checks only its own cap again), ai_helper_save_settings back to 101's, and removes the internal force-off
-- function, the platform key removal function (its audit rows are kept) and the control row's key_removed column (a removed shared key
-- stays removed and the platform switch stays off; after rollback a new key follows 146's rules again). Every ai_helper_settings row, usage row, request and audit row is kept as it is, including 'ai_forced_off_key_changed' audit rows and the
-- switches 150 turned off (they stay off). Rows made while 150 was installed keep the 1000 they were made with. Nothing here switches anything on.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public._ai_helper_force_off(uuid,text)') IS NULL THEN
  RAISE EXCEPTION '150 rollback: release 150 is not installed; nothing to roll back';
 END IF;
END $$;
ALTER TABLE public.ai_helper_settings ALTER COLUMN monthly_cap_pence SET DEFAULT 500;
CREATE OR REPLACE FUNCTION public._ai_helper_status_own_key()
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
CREATE OR REPLACE FUNCTION public.ai_helper_set_key(p_key_enc TEXT, p_last4 TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin']);
BEGIN
  IF p_key_enc IS NULL THEN
    DELETE FROM public.ai_helper_secrets k WHERE k.organization_id = v_org;
    UPDATE public.ai_helper_settings s SET api_key_last4 = NULL, updated_at = now(), updated_by = auth.uid() WHERE s.organization_id = v_org;
    PERFORM public._ai_helper_audit(v_org, 'ai_helper_key_cleared', 'ai_helper_settings', v_org::TEXT, '{}'::JSONB);
    RETURN public.ai_helper_status();
  END IF;
  IF p_key_enc !~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' OR octet_length(p_key_enc) > 2048
     OR p_last4 IS NULL OR p_last4 !~ '^[A-Za-z0-9_-]{4}$' THEN
    RAISE EXCEPTION 'The key was not stored in the expected form.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_helper_secrets AS k (organization_id, api_key_enc, updated_at, updated_by)
  VALUES (v_org, p_key_enc, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, updated_at = now(), updated_by = auth.uid();
  INSERT INTO public.ai_helper_settings AS s (organization_id, api_key_last4, updated_at, updated_by)
  VALUES (v_org, p_last4, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET api_key_last4 = EXCLUDED.api_key_last4, updated_at = now(), updated_by = auth.uid();
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_key_set', 'ai_helper_settings', v_org::TEXT, '{}'::JSONB);
  RETURN public.ai_helper_status();
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_set_key(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_set_key(TEXT, TEXT) TO authenticated;
CREATE OR REPLACE FUNCTION public.ai_helper_tolra_configure(p_enabled BOOLEAN,p_key_enc TEXT,p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_key TEXT;
BEGIN
 IF p_enabled IS NULL OR p_owner IS NULL THEN RAISE EXCEPTION 'Invalid setting.' USING ERRCODE = '22023'; END IF;
 IF NOT EXISTS (SELECT 1 FROM security_audit.platform_admins WHERE user_id = p_owner) THEN RAISE EXCEPTION 'Owner required.' USING ERRCODE = '42501'; END IF;
 SELECT api_key_enc INTO v_key FROM public.ai_helper_tolra_control WHERE singleton FOR UPDATE;
 v_key := coalesce(p_key_enc,v_key);
 IF p_enabled AND v_key IS NULL THEN RAISE EXCEPTION 'Add a key first.' USING ERRCODE = '22023'; END IF;
 UPDATE public.ai_helper_tolra_control SET enabled = p_enabled,api_key_enc = v_key,updated_by = p_owner,updated_at = now() WHERE singleton;
 RETURN jsonb_build_object('enabled',p_enabled,'key_set',v_key IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID) TO service_role;
-- 146's two public reserve entry points (each mode checks only its own cap again).
CREATE OR REPLACE FUNCTION public.ai_helper_reserve(p_feature TEXT, p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org UUID := public._ai_helper_caller(ARRAY['admin','office']);
BEGIN
 IF EXISTS (SELECT 1 FROM public.ai_helper_tolra_companies WHERE organization_id = v_org AND enabled) THEN
  -- Preserve the original two-feature API; assistant has its own entry point.
  IF p_feature IS NULL OR p_feature NOT IN ('roundup','rfq') THEN RAISE EXCEPTION 'Invalid feature.' USING ERRCODE = '22023'; END IF;
  RETURN public._ai_helper_reserve_tolra(p_feature,p_estimate_pence,p_input_digest,p_input_bytes);
 END IF;
 RETURN public._ai_helper_reserve_own_key(p_feature,p_estimate_pence,p_input_digest,p_input_bytes);
END $$;
CREATE OR REPLACE FUNCTION public.ai_helper_reserve_assistant(p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org UUID := public._ai_helper_caller(ARRAY['admin','office']);
BEGIN
 IF EXISTS (SELECT 1 FROM public.ai_helper_tolra_companies WHERE organization_id = v_org AND enabled) THEN
  RETURN public._ai_helper_reserve_tolra('assistant',p_estimate_pence,p_input_digest,p_input_bytes);
 END IF;
 RETURN public._ai_helper_reserve_assistant_own_key(p_estimate_pence,p_input_digest,p_input_bytes);
END $$;
REVOKE ALL ON FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER), public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER), public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER) TO authenticated;
-- 101's ai_helper_save_settings (a cap below usage is accepted again).
CREATE OR REPLACE FUNCTION public.ai_helper_save_settings(p_roundup BOOLEAN, p_rfq BOOLEAN, p_cap_pence INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin']);
BEGIN
  IF p_roundup IS NULL OR p_rfq IS NULL OR p_cap_pence IS NULL OR p_cap_pence NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Choose both switches and a monthly limit between £0 and £1000.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_helper_settings AS s (organization_id, roundup_enabled, rfq_enabled, monthly_cap_pence, updated_at, updated_by)
  VALUES (v_org, p_roundup, p_rfq, p_cap_pence, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE
    SET roundup_enabled = EXCLUDED.roundup_enabled, rfq_enabled = EXCLUDED.rfq_enabled,
        monthly_cap_pence = EXCLUDED.monthly_cap_pence, updated_at = now(), updated_by = auth.uid();
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_settings_updated', 'ai_helper_settings', v_org::TEXT,
    jsonb_build_object('roundup_enabled', p_roundup, 'rfq_enabled', p_rfq, 'monthly_cap_pence', p_cap_pence));
  RETURN public.ai_helper_status();
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_save_settings(BOOLEAN, BOOLEAN, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_save_settings(BOOLEAN, BOOLEAN, INTEGER) TO authenticated;
DROP FUNCTION public._ai_helper_force_off(UUID, TEXT);
DROP FUNCTION public.ai_helper_tolra_remove_key(UUID, TEXT);
ALTER TABLE public.ai_helper_tolra_control DROP CONSTRAINT ai_helper_tolra_control_removed_off;
ALTER TABLE public.ai_helper_tolra_control DROP COLUMN key_removed;
DO $$ BEGIN
 IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public._ai_helper_status_own_key()')) IS DISTINCT FROM '3ef44c838451b46ea14030164d9b1384'
    OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_set_key(text,text)')) IS DISTINCT FROM 'a6680aba0f169e5331110ba388f05e49'
    OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_tolra_configure(boolean,text,uuid)')) IS DISTINCT FROM 'a100254532a8b9635e0b2b0952801b60'
    OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)')) IS DISTINCT FROM '9c5edca01d9bed8602b6186dfffa278b'
    OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)')) IS DISTINCT FROM '9d2ef791742a5b67a02277ea04bb08e3'
    OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_save_settings(boolean,boolean,integer)')) IS DISTINCT FROM '70658b5b1ebd4547872d8d152c29fb56'
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_tolra_control' AND column_name = 'key_removed')
    OR (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'monthly_cap_pence') IS DISTINCT FROM '500' THEN
  RAISE EXCEPTION '150 rollback: the restored functions or default are not exactly 101, 122 and 146';
 END IF;
END $$;
COMMIT;
