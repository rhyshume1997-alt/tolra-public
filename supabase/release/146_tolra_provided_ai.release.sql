-- Post-144 release step 146. One-time, one transaction; never part of baseline replay.
-- Canonical source: supabase/proposals/n2_tolra_provided_ai.sql. Existing objects cause refusal, never overwrite.
BEGIN;
DO $post_release_guard$ BEGIN
 IF to_regclass('public.company_setup_progress') IS NULL OR to_regprocedure('public.accounting_cloud_connections_ready()') IS NULL THEN
  RAISE EXCEPTION '146: required release 145 is missing; stop and check release preflight';
 END IF;
END $post_release_guard$;

DO $$ BEGIN
 IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)')) IS DISTINCT FROM '972540e833a42bbb35ac5b670c56daa8'
 OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)')) IS DISTINCT FROM 'f3e880f36702f8a1d358a4da194f7b5a' THEN
  RAISE EXCEPTION 'Review the existing reserve functions before applying N2; expected 133 and 134.';
 END IF;
END $$;

CREATE TABLE public.ai_helper_tolra_control (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 api_key_enc TEXT CHECK (octet_length(api_key_enc) <= 2048) CHECK (api_key_enc IS NULL OR api_key_enc ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
 updated_by UUID REFERENCES auth.users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (NOT enabled OR api_key_enc IS NOT NULL)
);
INSERT INTO public.ai_helper_tolra_control(singleton) VALUES (TRUE);
ALTER TABLE public.ai_helper_tolra_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_helper_tolra_control FROM PUBLIC, anon, authenticated;

CREATE TABLE public.ai_helper_tolra_companies (
 organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 monthly_cap_pence INTEGER NOT NULL DEFAULT 1000 CHECK (monthly_cap_pence BETWEEN 0 AND 100000)
);
ALTER TABLE public.ai_helper_tolra_companies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_helper_tolra_companies FROM PUBLIC, anon, authenticated;
-- There are deliberately no direct company table grants/policies: all access
-- goes through the scoped caller functions below, including support refusal.
ALTER TABLE public.ai_helper_requests ADD COLUMN key_source TEXT NOT NULL DEFAULT 'own' CHECK (key_source IN ('own', 'tolra'));

ALTER FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER) RENAME TO _ai_helper_reserve_own_key;
ALTER FUNCTION public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER) RENAME TO _ai_helper_reserve_assistant_own_key;
ALTER FUNCTION public.ai_helper_status() RENAME TO _ai_helper_status_own_key;
REVOKE ALL ON FUNCTION public._ai_helper_reserve_own_key(TEXT,INTEGER,TEXT,INTEGER), public._ai_helper_reserve_assistant_own_key(INTEGER,TEXT,INTEGER), public._ai_helper_status_own_key() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._ai_helper_reserve_tolra(p_feature TEXT, p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public._ai_helper_caller(ARRAY['admin', 'office']);
  v_month  DATE := date_trunc('month', now() AT TIME ZONE 'Europe/London')::DATE;
  v_set    public.ai_helper_settings%ROWTYPE;
  v_key    TEXT;
  v_cap INTEGER;
  v_ok     BOOLEAN := FALSE;
  v_reason TEXT;
  v_id     UUID;
BEGIN
  IF p_feature IS NULL OR p_feature NOT IN ('roundup', 'rfq', 'assistant') OR p_estimate_pence IS NULL OR p_estimate_pence NOT BETWEEN 1 AND 1000
     OR p_input_digest IS NULL OR p_input_digest !~ '^[0-9a-f]{64}$' OR p_input_bytes IS NULL OR p_input_bytes NOT BETWEEN 0 AND 200000 THEN
    RAISE EXCEPTION 'Invalid AI helper request.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_set FROM public.ai_helper_settings s WHERE s.organization_id = v_org;
  IF NOT coalesce(CASE p_feature WHEN 'roundup' THEN v_set.roundup_enabled WHEN 'assistant' THEN v_set.assistant_enabled ELSE v_set.rfq_enabled END, FALSE) THEN
    RAISE EXCEPTION 'The AI helper is off for this company.' USING ERRCODE = '42501', HINT = 'ai_helper_off';
  END IF;

  -- Lock the mode/control rows while reserving. An unavailable provided mode
  -- refuses rather than silently charging the company's own provider account.
  SELECT c.api_key_enc INTO v_key FROM public.ai_helper_tolra_control c WHERE c.singleton AND c.enabled FOR SHARE;
  SELECT s.monthly_cap_pence INTO v_cap FROM public.ai_helper_tolra_companies s WHERE s.organization_id = v_org AND s.enabled FOR SHARE;
  IF v_key IS NULL OR v_cap IS NULL THEN
    RAISE EXCEPTION 'Tolra AI is off.' USING ERRCODE = '42501', HINT = 'ai_helper_off';
  END IF;

  -- Reservations a request never settled (10 minutes is far past the app's own timeout) are CHARGED IN FULL (133): nobody knows
  -- whether the provider did the work and billed it, so the reservation moves into spent and the request records that charge
  -- (cost_pence = its reservation). A late answer is still recorded by settle, at no extra cost.
  WITH stale AS (
    UPDATE public.ai_helper_requests r SET status = 'expired', cost_pence = r.reserved_pence, settled_at = now()
    WHERE r.organization_id = v_org AND r.status = 'reserved' AND r.created_at < now() - interval '10 minutes'
    RETURNING r.month, r.reserved_pence
  )
  UPDATE public.ai_helper_usage u SET reserved_pence = greatest(0, u.reserved_pence - s.total), spent_pence = u.spent_pence + s.total, updated_at = now()
  FROM (SELECT month, sum(reserved_pence)::INTEGER AS total FROM stale GROUP BY month) s
  WHERE u.organization_id = v_org AND u.month = s.month;

  IF v_key IS NULL THEN
    v_reason := 'no_key';
  ELSE
    INSERT INTO public.ai_helper_usage (organization_id, month) VALUES (v_org, v_month) ON CONFLICT (organization_id, month) DO NOTHING;
    UPDATE public.ai_helper_usage u SET reserved_pence = u.reserved_pence + p_estimate_pence, updated_at = now()
    WHERE u.organization_id = v_org AND u.month = v_month
      AND u.reserved_pence + u.spent_pence + p_estimate_pence
          <= v_cap
    RETURNING TRUE INTO v_ok;
    IF NOT coalesce(v_ok, FALSE) THEN v_reason := 'cap'; END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ai_helper_requests (organization_id, user_id, feature, month, status, refusal, input_digest, input_bytes, settled_at, key_source)
    VALUES (v_org, auth.uid(), p_feature, v_month, 'refused', v_reason, p_input_digest, p_input_bytes, now(), 'tolra')
    RETURNING id INTO v_id;
    PERFORM public._ai_helper_audit(v_org, 'ai_helper_refused', 'ai_helper_requests', v_id::TEXT,
      jsonb_build_object('feature', p_feature, 'reason', v_reason, 'estimate_pence', p_estimate_pence));
    RETURN jsonb_build_object('ok', FALSE, 'reason', v_reason, 'request_id', v_id);
  END IF;

  INSERT INTO public.ai_helper_requests (organization_id, user_id, feature, month, status, input_digest, input_bytes, reserved_pence, key_source)
  VALUES (v_org, auth.uid(), p_feature, v_month, 'reserved', p_input_digest, p_input_bytes, p_estimate_pence, 'tolra')
  RETURNING id INTO v_id;
  PERFORM public._ai_helper_audit(v_org, 'ai_helper_requested', 'ai_helper_requests', v_id::TEXT,
    jsonb_build_object('feature', p_feature, 'input_bytes', p_input_bytes, 'estimate_pence', p_estimate_pence));
  RETURN jsonb_build_object('ok', TRUE, 'request_id', v_id, 'key_source', 'tolra');
END
$$;
REVOKE ALL ON FUNCTION public._ai_helper_reserve_tolra(TEXT,INTEGER,TEXT,INTEGER) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.ai_helper_reserve(p_feature TEXT, p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
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
CREATE FUNCTION public.ai_helper_reserve_assistant(p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org UUID := public._ai_helper_caller(ARRAY['admin','office']);
BEGIN
 IF EXISTS (SELECT 1 FROM public.ai_helper_tolra_companies WHERE organization_id = v_org AND enabled) THEN
  RETURN public._ai_helper_reserve_tolra('assistant',p_estimate_pence,p_input_digest,p_input_bytes);
 END IF;
 RETURN public._ai_helper_reserve_assistant_own_key(p_estimate_pence,p_input_digest,p_input_bytes);
END $$;

CREATE FUNCTION public.ai_helper_status()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org UUID := public._ai_helper_caller(ARRAY['admin','office']); v_old JSONB; v_mode public.ai_helper_tolra_companies%ROWTYPE;
BEGIN
 v_old := public._ai_helper_status_own_key();
 SELECT * INTO v_mode FROM public.ai_helper_tolra_companies WHERE organization_id = v_org;
 RETURN v_old || jsonb_build_object(
  'tolra_available', EXISTS (SELECT 1 FROM public.ai_helper_tolra_control WHERE singleton AND enabled AND api_key_enc IS NOT NULL),
  'tolra_enabled', coalesce(v_mode.enabled,FALSE), 'tolra_cap_pence', coalesce(v_mode.monthly_cap_pence,1000));
END $$;

CREATE FUNCTION public.ai_helper_set_tolra_mode(p_enabled BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org UUID := public._ai_helper_caller(ARRAY['admin']);
BEGIN
 IF p_enabled IS NULL THEN RAISE EXCEPTION 'Choose on or off.' USING ERRCODE = '22023'; END IF;
 IF p_enabled AND NOT EXISTS (SELECT 1 FROM public.ai_helper_tolra_control WHERE singleton AND enabled AND api_key_enc IS NOT NULL) THEN
  RAISE EXCEPTION 'Tolra AI is not available.' USING ERRCODE = '42501';
 END IF;
 INSERT INTO public.ai_helper_tolra_companies(organization_id,enabled) VALUES(v_org,p_enabled)
 ON CONFLICT(organization_id) DO UPDATE SET enabled = EXCLUDED.enabled;
 INSERT INTO public.ai_helper_settings(organization_id,roundup_enabled,rfq_enabled,assistant_enabled,updated_by,updated_at)
 VALUES(v_org,p_enabled,p_enabled,p_enabled,auth.uid(),now())
 ON CONFLICT(organization_id) DO UPDATE SET roundup_enabled = EXCLUDED.roundup_enabled, rfq_enabled = EXCLUDED.rfq_enabled,
 assistant_enabled = EXCLUDED.assistant_enabled, updated_by = auth.uid(), updated_at = now();
 PERFORM public._ai_helper_audit(v_org,'ai_helper_settings_updated','ai_helper_settings',v_org::TEXT,jsonb_build_object('tolra_enabled',p_enabled));
END $$;

-- Only the server, after reserve. Neither a company nor its browser can read
-- Tolra's encrypted key. Refuse foreign, settled, own-key or disabled requests.
CREATE FUNCTION public.ai_helper_tolra_key(p_request UUID,p_org UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT c.api_key_enc FROM public.ai_helper_tolra_control c
 WHERE c.singleton AND c.enabled AND EXISTS (
  SELECT 1 FROM public.ai_helper_requests r WHERE r.id = p_request AND r.organization_id = p_org
   AND r.status = 'reserved' AND r.key_source = 'tolra');
$$;
CREATE FUNCTION public.ai_helper_tolra_owner_status()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT jsonb_build_object('enabled',enabled,'key_set',api_key_enc IS NOT NULL)
 FROM public.ai_helper_tolra_control WHERE singleton;
$$;
CREATE FUNCTION public.ai_helper_tolra_configure(p_enabled BOOLEAN,p_key_enc TEXT,p_owner UUID)
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
-- Owner-only cap reads/writes. The application checks owner MFA before using
-- the service role. These functions also check the owner's registry identity.
CREATE FUNCTION public.ai_helper_tolra_caps()
RETURNS TABLE(organization_id UUID, monthly_cap_pence INTEGER, spent_pence INTEGER, reserved_pence INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT o.id, coalesce(c.monthly_cap_pence,1000), coalesce(u.spent_pence,0), coalesce(u.reserved_pence,0)
 FROM public.organizations o LEFT JOIN public.ai_helper_tolra_companies c ON c.organization_id = o.id
 LEFT JOIN public.ai_helper_usage u ON u.organization_id = o.id AND u.month = date_trunc('month',now() AT TIME ZONE 'Europe/London')::DATE;
$$;
CREATE FUNCTION public.ai_helper_tolra_set_cap(p_org UUID,p_cap_pence INTEGER,p_owner UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_month DATE := date_trunc('month',now() AT TIME ZONE 'Europe/London')::DATE; v_used INTEGER;
BEGIN
 IF p_org IS NULL OR p_cap_pence IS NULL OR p_cap_pence NOT BETWEEN 0 AND 100000 THEN
  RAISE EXCEPTION 'Choose whole pence from 0 to 100000.' USING ERRCODE = '22023';
 END IF;
 IF p_owner IS NULL OR NOT EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p_owner) THEN
  RAISE EXCEPTION 'Owner required.' USING ERRCODE = '42501';
 END IF;
 INSERT INTO public.ai_helper_tolra_companies(organization_id) VALUES(p_org) ON CONFLICT(organization_id) DO NOTHING;
 -- Match reserve's lock order: settings before monthly ledger. Reserve holds
 -- FOR SHARE on this same row until its guarded UPDATE commits. This exclusive
 -- lock serializes cap changes with reservations, including a simultaneous cut.
 PERFORM c.organization_id FROM public.ai_helper_tolra_companies c WHERE c.organization_id = p_org FOR UPDATE;
 INSERT INTO public.ai_helper_usage(organization_id,month) VALUES(p_org,v_month) ON CONFLICT(organization_id,month) DO NOTHING;
 SELECT u.spent_pence + u.reserved_pence INTO v_used FROM public.ai_helper_usage u WHERE u.organization_id = p_org AND u.month = v_month FOR UPDATE;
 IF p_cap_pence < v_used THEN
  RAISE EXCEPTION 'The limit cannot be below used and reserved AI.' USING ERRCODE = '22023', HINT = 'cap_below_usage';
 END IF;
 UPDATE public.ai_helper_tolra_companies SET monthly_cap_pence = p_cap_pence WHERE organization_id = p_org;
 INSERT INTO security_audit.audit_log(organization_id,actor_user_id,actor_email,action,entity_table,entity_id,metadata)
 VALUES(p_org,p_owner,(SELECT p.email FROM public.user_profiles p WHERE p.id = p_owner),'ai_helper_settings_updated','ai_helper_tolra_companies',p_org::TEXT,
  jsonb_build_object('monthly_cap_pence',p_cap_pence,'source','platform_owner'));
END $$;
REVOKE ALL ON FUNCTION public.ai_helper_tolra_caps(), public.ai_helper_tolra_set_cap(UUID,INTEGER,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_tolra_caps(), public.ai_helper_tolra_set_cap(UUID,INTEGER,UUID) TO service_role;
REVOKE ALL ON FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER), public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER), public.ai_helper_status(), public.ai_helper_set_tolra_mode(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER), public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER), public.ai_helper_status(), public.ai_helper_set_tolra_mode(BOOLEAN) TO authenticated;
REVOKE ALL ON FUNCTION public.ai_helper_tolra_key(UUID,UUID), public.ai_helper_tolra_owner_status(), public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_tolra_key(UUID,UUID), public.ai_helper_tolra_owner_status(), public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID) TO service_role;

COMMIT;
