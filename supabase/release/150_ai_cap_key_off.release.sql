-- Post-144 release step 150. One-time, one transaction; never part of baseline replay.
-- Canonical source: supabase/proposals/a150_ai_cap_key_off.sql. Existing objects cause refusal, never overwrite.
BEGIN;
DO $post_release_guard$ BEGIN
 IF to_regclass('public.ai_helper_tolra_control') IS NULL OR to_regclass('public.ai_helper_tolra_companies') IS NULL
    OR to_regprocedure('public._ai_helper_status_own_key()') IS NULL OR to_regclass('public.company_setup_progress') IS NULL THEN
  RAISE EXCEPTION '150: required releases 145 and 146 are missing; stop and check release preflight';
 END IF;
 IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public._ai_helper_status_own_key()')) IS DISTINCT FROM '3ef44c838451b46ea14030164d9b1384'
    OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_set_key(text,text)')) IS DISTINCT FROM 'a6680aba0f169e5331110ba388f05e49'
    OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_tolra_configure(boolean,text,uuid)')) IS DISTINCT FROM 'a100254532a8b9635e0b2b0952801b60'
    OR to_regprocedure('public._ai_helper_force_off(uuid,text)') IS NOT NULL
    OR (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'monthly_cap_pence') IS DISTINCT FROM '500' THEN
  RAISE EXCEPTION '150: the AI key functions, status or cap default are not exactly as 101, 122 and 146 left them (or 150 is already applied); stop and compare first';
 END IF;
END $post_release_guard$;

-- 0. Before-image of every settings row, compared at the end: this release must not change one.
SELECT set_config('a150.settings_before', coalesce((SELECT md5(string_agg(to_jsonb(s)::TEXT, ',' ORDER BY s.organization_id)) FROM public.ai_helper_settings s), 'none'), TRUE);

-- 1. The own-key default cap: 1000p on rows made from now on.
ALTER TABLE public.ai_helper_settings ALTER COLUMN monthly_cap_pence SET DEFAULT 1000;

-- 2. Status for a company with no settings row reads 1000 (122's body, 500 became 1000).
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
    'monthly_cap_pence', coalesce(v_set.monthly_cap_pence, 1000),
    'key_set', EXISTS (SELECT 1 FROM public.ai_helper_secrets k WHERE k.organization_id = v_org),
    'key_last4', CASE WHEN v_admin THEN v_set.api_key_last4 END,
    'month_spent_pence', coalesce(v_use.spent_pence, 0),
    'month_reserved_pence', coalesce(v_use.reserved_pence, 0),
    'can_manage', v_admin);
END
$$;

-- 3. The force-off. Internal: no browser role and no service role can call it (the two key functions below are its only callers).
CREATE FUNCTION public._ai_helper_force_off(p_org UUID, p_reason TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tolra   BOOLEAN := FALSE;
  v_was     public.ai_helper_settings%ROWTYPE;
  v_any     BOOLEAN := FALSE;
BEGIN
  IF p_org IS NULL OR p_reason IS NULL OR p_reason NOT IN ('key_saved', 'key_replaced', 'key_removed') THEN
    RAISE EXCEPTION 'Invalid force-off.' USING ERRCODE = '22023';
  END IF;
  -- Tolra company row first, then settings (the order ai_helper_set_tolra_mode takes them in).
  UPDATE public.ai_helper_tolra_companies c SET enabled = FALSE WHERE c.organization_id = p_org AND c.enabled RETURNING TRUE INTO v_tolra;
  v_tolra := coalesce(v_tolra, FALSE);
  SELECT * INTO v_was FROM public.ai_helper_settings s WHERE s.organization_id = p_org FOR UPDATE;
  IF FOUND AND (v_was.roundup_enabled OR v_was.rfq_enabled OR v_was.assistant_enabled OR v_was.finance_check_enabled) THEN
    v_any := TRUE;
    UPDATE public.ai_helper_settings s
    SET roundup_enabled = FALSE, rfq_enabled = FALSE, assistant_enabled = FALSE, finance_check_enabled = FALSE, updated_at = now(), updated_by = auth.uid()
    WHERE s.organization_id = p_org;
  END IF;
  IF v_any OR v_tolra THEN
    PERFORM public._ai_helper_audit(p_org, 'ai_forced_off_key_changed', 'ai_helper_settings', p_org::TEXT,
      jsonb_build_object('reason', p_reason,
        'roundup_was_on', coalesce(v_was.roundup_enabled, FALSE), 'rfq_was_on', coalesce(v_was.rfq_enabled, FALSE),
        'assistant_was_on', coalesce(v_was.assistant_enabled, FALSE), 'finance_check_was_on', coalesce(v_was.finance_check_enabled, FALSE),
        'tolra_was_on', v_tolra));
  END IF;
  RETURN v_any OR v_tolra;
END
$$;
REVOKE ALL ON FUNCTION public._ai_helper_force_off(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 4. Admin: store, replace or (with NULL) remove the company's own key (101's function) and switch the company's AI off.
CREATE OR REPLACE FUNCTION public.ai_helper_set_key(p_key_enc TEXT, p_last4 TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._ai_helper_caller(ARRAY['admin']);
  v_had BOOLEAN;
BEGIN
  -- Lock order: the Tolra company row before the settings row (ai_helper_set_tolra_mode's order).
  PERFORM 1 FROM public.ai_helper_tolra_companies c WHERE c.organization_id = v_org FOR UPDATE;
  IF p_key_enc IS NULL THEN
    DELETE FROM public.ai_helper_secrets k WHERE k.organization_id = v_org;
    UPDATE public.ai_helper_settings s SET api_key_last4 = NULL, updated_at = now(), updated_by = auth.uid() WHERE s.organization_id = v_org;
    PERFORM public._ai_helper_audit(v_org, 'ai_helper_key_cleared', 'ai_helper_settings', v_org::TEXT, '{}'::JSONB);
    PERFORM public._ai_helper_force_off(v_org, 'key_removed');
    RETURN public.ai_helper_status();
  END IF;
  IF p_key_enc !~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' OR octet_length(p_key_enc) > 2048
     OR p_last4 IS NULL OR p_last4 !~ '^[A-Za-z0-9_-]{4}$' THEN
    RAISE EXCEPTION 'The key was not stored in the expected form.' USING ERRCODE = '22023';
  END IF;
  v_had := EXISTS (SELECT 1 FROM public.ai_helper_secrets k WHERE k.organization_id = v_org);
  INSERT INTO public.ai_helper_secrets AS k (organization_id, api_key_enc, updated_at, updated_by)
  VALUES (v_org, p_key_enc, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, updated_at = now(), updated_by = auth.uid();
  INSERT INTO public.ai_helper_settings AS s (organization_id, api_key_last4, updated_at, updated_by)
  VALUES (v_org, p_last4, now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET api_key_last4 = EXCLUDED.api_key_last4, updated_at = now(), updated_by = auth.uid();
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_key_set', 'ai_helper_settings', v_org::TEXT, '{}'::JSONB);
  PERFORM public._ai_helper_force_off(v_org, CASE WHEN v_had THEN 'key_replaced' ELSE 'key_saved' END);
  RETURN public.ai_helper_status();
END
$$;
REVOKE ALL ON FUNCTION public.ai_helper_set_key(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_set_key(TEXT, TEXT) TO authenticated;

-- 5. Platform owner: 146's function; replacing Tolra's platform key switches the platform switch off whatever the call asked for (the owner
--    switches it on again with a second call). The first key (none stored before) keeps the asked switch. The companies' own rows are not touched:
--    with the platform switch off every provided-AI reservation is refused (ai_helper_off) and nothing reaches the provider.
CREATE OR REPLACE FUNCTION public.ai_helper_tolra_configure(p_enabled BOOLEAN,p_key_enc TEXT,p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_key TEXT; v_was_on BOOLEAN; v_enabled BOOLEAN := p_enabled; v_replaced BOOLEAN := FALSE;
BEGIN
 IF p_enabled IS NULL OR p_owner IS NULL THEN RAISE EXCEPTION 'Invalid setting.' USING ERRCODE = '22023'; END IF;
 IF NOT EXISTS (SELECT 1 FROM security_audit.platform_admins WHERE user_id = p_owner) THEN RAISE EXCEPTION 'Owner required.' USING ERRCODE = '42501'; END IF;
 SELECT api_key_enc, enabled INTO v_key, v_was_on FROM public.ai_helper_tolra_control WHERE singleton FOR UPDATE;
 IF p_key_enc IS NOT NULL AND v_key IS NOT NULL THEN v_replaced := TRUE; v_enabled := FALSE; END IF;
 v_key := coalesce(p_key_enc,v_key);
 IF v_enabled AND v_key IS NULL THEN RAISE EXCEPTION 'Add a key first.' USING ERRCODE = '22023'; END IF;
 UPDATE public.ai_helper_tolra_control SET enabled = v_enabled,api_key_enc = v_key,updated_by = p_owner,updated_at = now() WHERE singleton;
 IF v_replaced AND v_was_on THEN
  INSERT INTO security_audit.audit_log(organization_id,actor_user_id,actor_email,action,entity_table,entity_id,metadata)
  VALUES(NULL,p_owner,(SELECT p.email FROM public.user_profiles p WHERE p.id = p_owner),'ai_forced_off_key_changed','ai_helper_tolra_control','singleton',
   jsonb_build_object('reason','key_replaced','scope','platform','tolra_was_on',TRUE,'source','platform_owner'));
 END IF;
 RETURN jsonb_build_object('enabled',v_enabled,'key_set',v_key IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID) TO service_role;

-- 6. Self-check before COMMIT: the settings rows are exactly as they were; the default is 1000.
DO $$
BEGIN
  IF coalesce((SELECT md5(string_agg(to_jsonb(s)::TEXT, ',' ORDER BY s.organization_id)) FROM public.ai_helper_settings s), 'none') IS DISTINCT FROM current_setting('a150.settings_before') THEN
    RAISE EXCEPTION '150: an ai_helper_settings row changed; this release must not change one';
  END IF;
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'monthly_cap_pence') IS DISTINCT FROM '1000' THEN
    RAISE EXCEPTION '150: ai_helper_settings.monthly_cap_pence does not default to 1000';
  END IF;
END
$$;

COMMIT;
