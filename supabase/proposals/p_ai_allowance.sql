-- =====================================================================================================
-- p_ai_allowance: a per-company monthly AI request allowance by tier. PROPOSAL ONLY. Not applied anywhere hosted. Rhys must approve
-- before any production SQL, and AI stays off: nothing in the app calls the new function, no key is added, no flag is flipped, no
-- existing function is changed.
-- NO RELEASE NUMBER YET: number 161 belongs to open draft PR #536 (customer sign-off), so this is listed under other_proposals in
-- supabase/release-plan.json, not as a numbered phase. A number is allocated only when Rhys decides the order (after 150, whose two
-- reserve bodies it requires). Packaged verbatim (the body inside its transaction) into supabase/release/ai_allowance.release.sql,
-- which adds the guard, a before/after fingerprint and the self-check.
--
-- INPUTS: public.organizations (read), public.ai_helper_requests (read), the existing reservers ai_helper_reserve and
--   ai_helper_reserve_assistant (called, not changed).
-- OUTPUTS:
--   1. public.organizations.ai_allowance_tier TEXT NULL, CHECK in ('small','medium','large'). NULL = no tier. Browser roles can read it for
--      their own company (the table's existing SELECT) but cannot write it: authenticated has UPDATE on name and updated_at only, and this
--      adds no grant. It is set by the platform (service role / SQL editor) after a separate decision, never by this proposal.
--   2. public.ai_helper_reserve_allowance(p_feature, p_estimate_pence, p_input_digest, p_input_bytes) RETURNS JSONB, SECURITY DEFINER,
--      search_path pg_catalog, public, EXECUTE for authenticated only (admin and office, not support: _ai_helper_caller decides).
--      p_feature is 'roundup', 'rfq' or 'assistant'.
--
-- THE RULE (same numbers and meaning as lib/ai-helper/allowance.ts, which nothing calls yet):
--   small 100, medium 400, large 1500 REQUESTS per company per UTC calendar month ("YYYY-MM").
--   Unknown or missing tier means NO allowance: the call is refused with reason 'no_allowance' and nothing is reserved.
--   A request counts when its ai_helper_requests row was created in this UTC month with a status other than 'refused' (a refusal reserved
--   nothing and cost nothing, so it never uses allowance; reserved, expired, suggested, failed, approved and rejected all count).
--   The first request of a new UTC month starts at zero: the month is part of the count's date range, nothing is reset or stored.
--   At the limit the call is refused with reason 'allowance' (used, limit and period returned) and nothing is reserved.
--   Within the allowance the call goes on to the EXISTING reserver unchanged, so the existing pence cap (least of the own-key and Tolra caps,
--   150's rules), the key checks and the audit rows still decide the rest. The pence cap is therefore still enforced on every allowed call,
--   and companies or code paths that do not call this function keep exactly today's behaviour through ai_helper_reserve.
-- WHY IT DOES NOT REPLACE ai_helper_reserve: those two bodies are pinned by md5 in 146, 150 and supabase/verify/release_preflight.sql.
--   A new function composes with them and changes none of them.
-- RACES: a transaction-level advisory lock on (company, UTC month) is taken before the count and held until the transaction ends, past
--   the reserver's insert, so two concurrent calls cannot both see used = limit - 1. The lock is taken first and nothing else takes it, so
--   it cannot form a deadlock with the reservers' own lock order.
-- REFUSALS WRITE NO ROW: ai_helper_requests.refusal only allows 'cap' and 'no_key' and widening that CHECK is outside this proposal.
--
-- DECISION FOR RHYS (not made by this file): the brief says "unknown tier means no allowance, existing pence cap stays the fallback".
--   Read here as: unknown tier is refused by THIS function; the pence cap is the fallback because ai_helper_reserve still runs unchanged
--   for every caller that does not use this function. If instead an unknown tier should fall through to the pence cap alone, change the
--   one RETURN inside the 'no_allowance' branch to delegate; nothing else would change.
-- MUST NOT CHANGE: the tier sizes without a product decision; ai_helper_reserve, ai_helper_reserve_assistant and their md5s; the
--   authenticated UPDATE grant list on organizations (name, updated_at); any policy, trigger or other function.
-- Rollback (reviewed text, not a file): DROP FUNCTION public.ai_helper_reserve_allowance(TEXT,INTEGER,TEXT,INTEGER);
--   ALTER TABLE public.organizations DROP COLUMN ai_allowance_tier;  (the column holds tier choices only; dropping loses those choices.)
-- Run again, it changes nothing.
-- =====================================================================================================
BEGIN;

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS ai_allowance_tier TEXT;
DO $tier_check$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.organizations'::regclass AND conname = 'organizations_ai_allowance_tier_check') THEN
  ALTER TABLE public.organizations ADD CONSTRAINT organizations_ai_allowance_tier_check
    CHECK (ai_allowance_tier IS NULL OR ai_allowance_tier IN ('small', 'medium', 'large'));
 END IF;
END $tier_check$;

CREATE OR REPLACE FUNCTION public.ai_helper_reserve_allowance(p_feature TEXT, p_estimate_pence INTEGER, p_input_digest TEXT, p_input_bytes INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
 v_org    UUID := public._ai_helper_caller(ARRAY['admin','office']);
 v_now    TIMESTAMPTZ := now();
 v_period TEXT := to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM');
 v_start  TIMESTAMPTZ := date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 v_tier   TEXT;
 v_limit  INTEGER;
 v_used   INTEGER;
BEGIN
 IF p_feature IS NULL OR p_feature NOT IN ('roundup', 'rfq', 'assistant') THEN RAISE EXCEPTION 'Invalid feature.' USING ERRCODE = '22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ai_allowance:' || v_org::TEXT || ':' || v_period, 0));
 SELECT o.ai_allowance_tier INTO v_tier FROM public.organizations o WHERE o.id = v_org;
 v_limit := CASE v_tier WHEN 'small' THEN 100 WHEN 'medium' THEN 400 WHEN 'large' THEN 1500 ELSE NULL END;
 IF v_limit IS NULL THEN
  RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_allowance', 'period', v_period);
 END IF;
 SELECT count(*)::INTEGER INTO v_used FROM public.ai_helper_requests r
  WHERE r.organization_id = v_org AND r.created_at >= v_start AND r.created_at < v_start + interval '1 month' AND r.status <> 'refused';
 IF v_used >= v_limit THEN
  RETURN jsonb_build_object('ok', FALSE, 'reason', 'allowance', 'period', v_period, 'limit', v_limit, 'used', v_used);
 END IF;
 IF p_feature = 'assistant' THEN
  RETURN public.ai_helper_reserve_assistant(p_estimate_pence, p_input_digest, p_input_bytes);
 END IF;
 RETURN public.ai_helper_reserve(p_feature, p_estimate_pence, p_input_digest, p_input_bytes);
END $$;
REVOKE ALL ON FUNCTION public.ai_helper_reserve_allowance(TEXT,INTEGER,TEXT,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_helper_reserve_allowance(TEXT,INTEGER,TEXT,INTEGER) TO authenticated;

COMMIT;
