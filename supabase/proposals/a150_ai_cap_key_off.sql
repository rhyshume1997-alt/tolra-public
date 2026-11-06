-- A150 proposal (AI: 1000p own-key default, AI forced off when a key is replaced or removed). Review and apply in a separate release; never run
-- during app startup. Packaged as post-144 release step 150 (supabase/release/150_ai_cap_key_off.release.sql), after 147 and any release between.
-- Decided by Rhys: (1) the own-key helper's monthly cap defaults to 1000p (GBP 10), the same figure as Tolra-provided AI; (2) replacing or removing
-- the company's own key, or replacing Tolra's platform key, switches AI off and it must be switched on again on purpose.
-- Changes (no table and no policy is added; one column on the platform control row (h); no existing row is rewritten):
--   a. ai_helper_settings.monthly_cap_pence: column DEFAULT 500 becomes 1000 (inside 101's CHECK 0..100000). Only a row made from now on without a
--      cap (ai_helper_set_key, 106's ai_helper_set_finance_check, 134's ai_helper_set_assistant, 146's ai_helper_set_tolra_mode) gets 1000.
--      Every existing row keeps its value: rows made at the old default (500) are indistinguishable from an explicit 500 in the row itself.
--   b. _ai_helper_status_own_key(): 122's body; a company with no settings row reads 1000 (was 500). 146's ai_helper_status wraps it.
--   c. ai_helper_set_key(): 101's body plus the force-off below, after the key is stored, replaced or removed (same signature, grants, search path).
--   d. ai_helper_tolra_configure(): 146's body; replacing Tolra's platform key switches the platform switch off (same signature and grants).
--   e. _ai_helper_force_off(org, reason): internal, no caller can run it. Sets roundup, rfq, assistant and finance-check to FALSE and the company's
--      Tolra mode to FALSE, only where one was on, and writes one 'ai_forced_off_key_changed' audit row (codes and booleans only). The cap, the usage
--      ledger, the request log and requests already reserved are not touched: a granted reservation is settled as before (settle does not look at
--      the switches), and a reservation whose key is gone or replaced is settled by the app as failed at 0p (released), or runs on the new key.
--   f. ai_helper_reserve() and ai_helper_reserve_assistant(): 146's dispatch kept; one company cap across both modes. A reservation in either
--      mode is refused ('cap') unless used + reserved stays within least(own-key cap, Tolra cap) (own-key 1000 where no settings row; the Tolra
--      cap only where the company has a Tolra row). Switching mode no longer reaches the higher of the two caps. The reservers are unchanged.
--   g. ai_helper_save_settings(): 101's body; an own-key cap below this month's spent + reserved is refused (22023, hint cap_below_usage),
--      the usage row locked while checking (as ai_helper_tolra_set_cap does for the Tolra cap). Same signature, grants and audit row.
--   h. ai_helper_tolra_control.key_removed BOOLEAN NOT NULL DEFAULT FALSE, with CHECK (NOT (enabled AND key_removed)), and
--      ai_helper_tolra_remove_key(owner, confirm): new, platform owner only (service role), exact confirmation 'REMOVE SHARED TOLRA KEY';
--      clears the shared key, switches the platform off, sets key_removed, audits 'ai_tolra_key_removed' with companies_affected. Company rows,
--      usage, requests and audit rows are kept. ai_helper_tolra_configure (d) stores a key added after a removal OFF; only the explicit
--      switch-on configure(TRUE, NULL, owner) clears key_removed. The mark lives on the row, not in the audit log, so no audit purge can re-enable.
--   Lock order, so nothing can deadlock: Tolra company row, then the settings row (as ai_helper_set_tolra_mode does).
BEGIN;
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

-- 5. Platform control row: key_removed (new column, FALSE on the existing row). TRUE once the shared key has been removed (5c); it is cleared
--    ONLY by an explicit switch-on (ai_helper_tolra_configure(TRUE, NULL, owner) with a key stored). The CHECK makes it impossible for the
--    platform switch to be on while the mark is set, so no later key, audit purge or retention job can turn provided AI back on.
ALTER TABLE public.ai_helper_tolra_control ADD COLUMN key_removed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.ai_helper_tolra_control ADD CONSTRAINT ai_helper_tolra_control_removed_off CHECK (NOT (enabled AND key_removed));

-- 5b. Platform owner: 146's function; replacing Tolra's platform key switches the platform switch off whatever the call asked for (the owner
--    switches it on again with a second call). The first key (none stored before) keeps the asked switch, unless the shared key was removed
--    (key_removed): then the new key is stored OFF and the mark stays until the explicit switch-on. The companies' own rows are not touched:
--    with the platform switch off every provided-AI reservation is refused (ai_helper_off) and nothing reaches the provider.
CREATE OR REPLACE FUNCTION public.ai_helper_tolra_configure(p_enabled BOOLEAN,p_key_enc TEXT,p_owner UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_key TEXT; v_was_on BOOLEAN; v_removed BOOLEAN; v_enabled BOOLEAN := p_enabled; v_replaced BOOLEAN := FALSE;
BEGIN
 IF p_enabled IS NULL OR p_owner IS NULL THEN RAISE EXCEPTION 'Invalid setting.' USING ERRCODE = '22023'; END IF;
 IF NOT EXISTS (SELECT 1 FROM security_audit.platform_admins WHERE user_id = p_owner) THEN RAISE EXCEPTION 'Owner required.' USING ERRCODE = '42501'; END IF;
 SELECT api_key_enc, enabled, key_removed INTO v_key, v_was_on, v_removed FROM public.ai_helper_tolra_control WHERE singleton FOR UPDATE;
 IF p_key_enc IS NOT NULL AND (v_key IS NOT NULL OR v_removed) THEN v_replaced := TRUE; v_enabled := FALSE; END IF;
 v_key := coalesce(p_key_enc,v_key);
 IF v_enabled AND v_key IS NULL THEN RAISE EXCEPTION 'Add a key first.' USING ERRCODE = '22023'; END IF;
 -- v_enabled can only be TRUE here for an explicit switch-on (no key in the call) or a first key with no removal mark: only that clears it.
 UPDATE public.ai_helper_tolra_control SET enabled = v_enabled,api_key_enc = v_key,key_removed = (v_removed AND NOT v_enabled),updated_by = p_owner,updated_at = now() WHERE singleton;
 IF v_replaced AND v_was_on THEN
  INSERT INTO security_audit.audit_log(organization_id,actor_user_id,actor_email,action,entity_table,entity_id,metadata)
  VALUES(NULL,p_owner,(SELECT p.email FROM public.user_profiles p WHERE p.id = p_owner),'ai_forced_off_key_changed','ai_helper_tolra_control','singleton',
   jsonb_build_object('reason','key_replaced','scope','platform','tolra_was_on',TRUE,'source','platform_owner'));
 END IF;
 RETURN jsonb_build_object('enabled',v_enabled,'key_set',v_key IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_tolra_configure(BOOLEAN,TEXT,UUID) TO service_role;

-- 5c. Platform owner: remove the shared Tolra key. Owner only (platform_admins, as configure), service role only (as configure); needs the exact
--     confirmation 'REMOVE SHARED TOLRA KEY'. A wrong or missing confirmation is refused (22023, hint confirmation_required) and the refusal's
--     DETAIL says how many companies use provided AI now. Removal clears the key, switches the platform off and sets key_removed in one
--     transaction, and writes one 'ai_tolra_key_removed' audit row (organization NULL, actor = owner; companies_affected, was_on, source; no key).
--     Company rows (mode, caps), usage, requests and audit rows are not touched; every provided reservation is then refused (ai_helper_off)
--     before any provider call. A key added later is stored OFF (5b) until the owner switches provided AI on with a second, explicit call.
CREATE FUNCTION public.ai_helper_tolra_remove_key(p_owner UUID, p_confirm TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_key TEXT; v_was_on BOOLEAN; v_n INTEGER;
BEGIN
 IF p_owner IS NULL THEN RAISE EXCEPTION 'Invalid setting.' USING ERRCODE = '22023'; END IF;
 IF NOT EXISTS (SELECT 1 FROM security_audit.platform_admins WHERE user_id = p_owner) THEN RAISE EXCEPTION 'Owner required.' USING ERRCODE = '42501'; END IF;
 SELECT api_key_enc, enabled INTO v_key, v_was_on FROM public.ai_helper_tolra_control WHERE singleton FOR UPDATE;
 SELECT count(*)::INTEGER INTO v_n FROM public.ai_helper_tolra_companies c WHERE c.enabled;
 IF p_confirm IS DISTINCT FROM 'REMOVE SHARED TOLRA KEY' THEN
  RAISE EXCEPTION 'Type REMOVE SHARED TOLRA KEY to remove the shared Tolra key.' USING ERRCODE = '22023', HINT = 'confirmation_required',
   DETAIL = format('%s companies use Tolra-provided AI now; removing the key stops provided AI for all of them.', v_n);
 END IF;
 IF v_key IS NULL THEN RAISE EXCEPTION 'There is no shared Tolra key to remove.' USING ERRCODE = '22023', HINT = 'no_key'; END IF;
 UPDATE public.ai_helper_tolra_control SET enabled = FALSE, api_key_enc = NULL, key_removed = TRUE, updated_by = p_owner, updated_at = now() WHERE singleton;
 INSERT INTO security_audit.audit_log(organization_id,actor_user_id,actor_email,action,entity_table,entity_id,metadata)
 VALUES(NULL,p_owner,(SELECT p.email FROM public.user_profiles p WHERE p.id = p_owner),'ai_tolra_key_removed','ai_helper_tolra_control','singleton',
  jsonb_build_object('companies_affected',v_n,'was_on',coalesce(v_was_on,FALSE),'source','platform_owner'));
 RETURN jsonb_build_object('enabled',FALSE,'key_set',FALSE,'companies_affected',v_n);
END $$;
REVOKE ALL ON FUNCTION public.ai_helper_tolra_remove_key(UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_helper_tolra_remove_key(UUID,TEXT) TO service_role;

-- 6. One company cap across both modes. 146's two public entry points dispatch to the Tolra-provided reserver (which checks only the Tolra cap)
--    or the own-key reserver (which checks only the own-key cap) over the same usage row, so switching mode could reach the higher cap. They now
--    keep 146's dispatch and refuse with 'cap' unless used + reserved after this reservation is within least(own-key cap, Tolra cap): own-key cap
--    from ai_helper_settings (1000 where no row), Tolra cap from ai_helper_tolra_companies only where the company has a row (enabled or not).
--    The check runs after the reserver's own guarded usage UPDATE, while this transaction holds that usage row's lock, so a concurrent reservation
--    waits and then sees this one: no overshoot. An over-cap grant is undone (subtransaction rolled back) and a 'cap' refusal recorded instead.
--    No lock is added or reordered (the reservers' own order is kept: control, Tolra company row, then usage); the reservers' bodies are unchanged.
CREATE OR REPLACE FUNCTION public.ai_helper_reserve(p_feature TEXT, p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
 v_org UUID := public._ai_helper_caller(ARRAY['admin','office']);
 v_month DATE := date_trunc('month', now() AT TIME ZONE 'Europe/London')::DATE;
 v_tolra BOOLEAN;
 v_res JSONB;
 v_id UUID;
BEGIN
 v_tolra := EXISTS (SELECT 1 FROM public.ai_helper_tolra_companies WHERE organization_id = v_org AND enabled);
 IF v_tolra THEN
  -- Preserve the original two-feature API; assistant has its own entry point.
  IF p_feature IS NULL OR p_feature NOT IN ('roundup','rfq') THEN RAISE EXCEPTION 'Invalid feature.' USING ERRCODE = '22023'; END IF;
 END IF;
 BEGIN
  IF v_tolra THEN
   v_res := public._ai_helper_reserve_tolra(p_feature,p_estimate_pence,p_input_digest,p_input_bytes);
  ELSE
   v_res := public._ai_helper_reserve_own_key(p_feature,p_estimate_pence,p_input_digest,p_input_bytes);
  END IF;
  IF coalesce((v_res ->> 'ok')::BOOLEAN, FALSE)
     AND (SELECT u.spent_pence + u.reserved_pence FROM public.ai_helper_usage u WHERE u.organization_id = v_org AND u.month = v_month)
         > least(coalesce((SELECT s.monthly_cap_pence FROM public.ai_helper_settings s WHERE s.organization_id = v_org), 1000),
                 (SELECT c.monthly_cap_pence FROM public.ai_helper_tolra_companies c WHERE c.organization_id = v_org)) THEN
   RAISE EXCEPTION 'Company AI cap reached.' USING ERRCODE = 'TC150';
  END IF;
 EXCEPTION WHEN SQLSTATE 'TC150' THEN
  v_res := NULL;
 END;
 IF v_res IS NOT NULL THEN RETURN v_res; END IF;
 INSERT INTO public.ai_helper_requests (organization_id, user_id, feature, month, status, refusal, input_digest, input_bytes, settled_at, key_source)
 VALUES (v_org, auth.uid(), p_feature, v_month, 'refused', 'cap', p_input_digest, p_input_bytes, now(), CASE WHEN v_tolra THEN 'tolra' ELSE 'own' END)
 RETURNING id INTO v_id;
 PERFORM public._ai_helper_audit(v_org, 'ai_helper_refused', 'ai_helper_requests', v_id::TEXT,
   jsonb_build_object('feature', p_feature, 'reason', 'cap', 'estimate_pence', p_estimate_pence));
 RETURN jsonb_build_object('ok', FALSE, 'reason', 'cap', 'request_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.ai_helper_reserve_assistant(p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
 v_org UUID := public._ai_helper_caller(ARRAY['admin','office']);
 v_month DATE := date_trunc('month', now() AT TIME ZONE 'Europe/London')::DATE;
 v_tolra BOOLEAN;
 v_res JSONB;
 v_id UUID;
BEGIN
 v_tolra := EXISTS (SELECT 1 FROM public.ai_helper_tolra_companies WHERE organization_id = v_org AND enabled);
 BEGIN
  IF v_tolra THEN
   v_res := public._ai_helper_reserve_tolra('assistant',p_estimate_pence,p_input_digest,p_input_bytes);
  ELSE
   v_res := public._ai_helper_reserve_assistant_own_key(p_estimate_pence,p_input_digest,p_input_bytes);
  END IF;
  IF coalesce((v_res ->> 'ok')::BOOLEAN, FALSE)
     AND (SELECT u.spent_pence + u.reserved_pence FROM public.ai_helper_usage u WHERE u.organization_id = v_org AND u.month = v_month)
         > least(coalesce((SELECT s.monthly_cap_pence FROM public.ai_helper_settings s WHERE s.organization_id = v_org), 1000),
                 (SELECT c.monthly_cap_pence FROM public.ai_helper_tolra_companies c WHERE c.organization_id = v_org)) THEN
   RAISE EXCEPTION 'Company AI cap reached.' USING ERRCODE = 'TC150';
  END IF;
 EXCEPTION WHEN SQLSTATE 'TC150' THEN
  v_res := NULL;
 END;
 IF v_res IS NOT NULL THEN RETURN v_res; END IF;
 INSERT INTO public.ai_helper_requests (organization_id, user_id, feature, month, status, refusal, input_digest, input_bytes, settled_at, key_source)
 VALUES (v_org, auth.uid(), 'assistant', v_month, 'refused', 'cap', p_input_digest, p_input_bytes, now(), CASE WHEN v_tolra THEN 'tolra' ELSE 'own' END)
 RETURNING id INTO v_id;
 PERFORM public._ai_helper_audit(v_org, 'ai_helper_refused', 'ai_helper_requests', v_id::TEXT,
   jsonb_build_object('feature', 'assistant', 'reason', 'cap', 'estimate_pence', p_estimate_pence));
 RETURN jsonb_build_object('ok', FALSE, 'reason', 'cap', 'request_id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER), public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve(TEXT,INTEGER,TEXT,INTEGER), public.ai_helper_reserve_assistant(INTEGER,TEXT,INTEGER) TO authenticated;

-- 7. Admin: the two switches and the own-key monthly cap (101's function). A cap below what the company has already spent plus reserved this
--    month is refused (22023, hint cap_below_usage), as ai_helper_tolra_set_cap refuses for the Tolra cap. The usage row is locked while checking,
--    so a reservation cannot slip in between the check and the save. Same signature, grants, definer, search path and audit row as 101.
--    Lock order: the usage row, then the settings row (no other function takes the settings row before the usage row).
CREATE OR REPLACE FUNCTION public.ai_helper_save_settings(p_roundup BOOLEAN, p_rfq BOOLEAN, p_cap_pence INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public._ai_helper_caller(ARRAY['admin']);
  v_month DATE := date_trunc('month', now() AT TIME ZONE 'Europe/London')::DATE;
  v_used  INTEGER;
BEGIN
  IF p_roundup IS NULL OR p_rfq IS NULL OR p_cap_pence IS NULL OR p_cap_pence NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Choose both switches and a monthly limit between £0 and £1000.' USING ERRCODE = '22023';
  END IF;
  SELECT u.spent_pence + u.reserved_pence INTO v_used FROM public.ai_helper_usage u WHERE u.organization_id = v_org AND u.month = v_month FOR UPDATE;
  IF p_cap_pence < coalesce(v_used, 0) THEN
    RAISE EXCEPTION 'The limit cannot be below used and reserved AI.' USING ERRCODE = '22023', HINT = 'cap_below_usage';
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

-- 8. Self-check before COMMIT: the settings rows are exactly as they were; the default is 1000.
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
