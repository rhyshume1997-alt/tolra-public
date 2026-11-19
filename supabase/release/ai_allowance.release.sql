-- AI allowance release (per-company monthly AI request allowance by tier). NO RELEASE NUMBER: 161 belongs to open draft PR #536, so this is
-- listed under other_proposals in supabase/release-plan.json, not as a numbered phase, with no preflight marker, CI step or fixture entry.
-- One transaction; never part of baseline replay. Not applied anywhere hosted. Production only with Rhys's separate yes. AI stays off:
-- nothing in the app calls the new function.
-- Canonical source: supabase/proposals/p_ai_allowance.sql (its body between BEGIN; and COMMIT; is copied below verbatim between the
-- fingerprint and the self-check; read its header for the rule, the tier sizes and the decision left for Rhys).
-- INPUTS: none. OUTPUTS: public.organizations.ai_allowance_tier (nullable, CHECK small/medium/large, no browser write grant) and
-- public.ai_helper_reserve_allowance(TEXT,INTEGER,TEXT,INTEGER) (definer, authenticated only).
-- MUST NOT CHANGE: ai_helper_reserve and ai_helper_reserve_assistant (md5s 48b3f830... and 3c415227..., 150's bodies), any other function,
-- grant, policy or trigger, the other columns of organizations, the authenticated UPDATE grants on organizations (name, updated_at only).
-- REFUSES, changing nothing, unless: release 150 is in place (the two reservers carry 150's exact bodies, definer, search_path pg_catalog,
-- public), ai_helper_requests and organizations exist, and the helper _ai_helper_caller exists. Running it again changes nothing.
-- Rollback (reviewed text, no file yet): DROP FUNCTION public.ai_helper_reserve_allowance(TEXT,INTEGER,TEXT,INTEGER);
--   ALTER TABLE public.organizations DROP COLUMN ai_allowance_tier;  (loses tier choices only).
BEGIN;
DO $post_release_guard$
DECLARE
  f TEXT;
BEGIN
 IF to_regclass('public.organizations') IS NULL OR to_regclass('public.ai_helper_requests') IS NULL OR to_regprocedure('public._ai_helper_caller(text[])') IS NULL THEN
  RAISE EXCEPTION 'ai_allowance: organizations, ai_helper_requests or _ai_helper_caller is missing; stop and check release preflight';
 END IF;
 IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)')) IS DISTINCT FROM '48b3f8302686bc6310402b117ea09ad5'
    OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)')) IS DISTINCT FROM '3c415227fefdeda349442ff870a88e64' THEN
  RAISE EXCEPTION 'ai_allowance: ai_helper_reserve or ai_helper_reserve_assistant is not release 150''s body (release 150 missing or edited); stop and compare them first';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.ai_helper_reserve(text,integer,text,integer)', 'public.ai_helper_reserve_assistant(integer,text,integer)'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(f) AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) THEN
   RAISE EXCEPTION 'ai_allowance: % is not SECURITY DEFINER with search_path pg_catalog, public; stop and compare it first', f;
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'organizations' AND grantee IN ('anon', 'authenticated') AND privilege_type = 'UPDATE' AND column_name NOT IN ('name', 'updated_at')) THEN
  RAISE EXCEPTION 'ai_allowance: a browser role can already update an organizations column other than name and updated_at; stop and compare the grants first';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything this release must not touch: every other function's grants, bodies and settings, relation grants in public,
-- policies and triggers, and the other columns of organizations. The self-check requires the identical fingerprint. Session-only helper,
-- dropped before COMMIT. The one new function is excluded by name so a re-run (when it already exists) compares like with like.
CREATE FUNCTION pg_temp.pai_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $paifp$
  SELECT 'other function grants'::TEXT, md5(coalesce(string_agg(p.oid::regprocedure::TEXT || '=' || coalesce(p.proacl::TEXT, 'default') || '/' || p.proowner::TEXT, E'\n' ORDER BY p.oid::regprocedure::TEXT), ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT (n.nspname = 'public' AND p.proname = 'ai_helper_reserve_allowance')
  UNION ALL SELECT 'other function bodies', md5(coalesce(string_agg(p.oid::regprocedure::TEXT || '=' || md5(p.prosrc) || p.prosecdef::TEXT || coalesce(p.proconfig::TEXT, ''), E'\n' ORDER BY p.oid::regprocedure::TEXT), ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT (n.nspname = 'public' AND p.proname = 'ai_helper_reserve_allowance')
  UNION ALL SELECT 'public relation grants', md5(coalesce(string_agg(c.oid::regclass::TEXT || '=' || coalesce(c.relacl::TEXT, 'default'), E'\n' ORDER BY c.oid::regclass::TEXT), ''))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL SELECT 'policies', md5(coalesce(string_agg(pol.polrelid::regclass::TEXT || '.' || pol.polname || ':' || pol.polcmd::TEXT || pol.polroles::TEXT || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''), E'\n' ORDER BY pol.polrelid::regclass::TEXT, pol.polname), ''))
  FROM pg_policy pol
  UNION ALL SELECT 'triggers', md5(coalesce(string_agg(t.tgrelid::regclass::TEXT || '.' || t.tgname || ':' || t.tgenabled::TEXT || pg_get_triggerdef(t.oid), E'\n' ORDER BY t.tgrelid::regclass::TEXT, t.tgname), ''))
  FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'organizations other columns', md5(coalesce(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::TEXT || ':' || coalesce(a.attacl::TEXT, 'default'), E'\n' ORDER BY a.attname), ''))
  FROM pg_attribute a WHERE a.attrelid = 'public.organizations'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'ai_allowance_tier'
$paifp$;
CREATE TEMP TABLE pai_before ON COMMIT DROP AS SELECT * FROM pg_temp.pai_fingerprint();

-- ---- 1. The tier column and the allowance reserve function (canonical proposal body, verbatim) ----------------------------------

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

DO $pai_self_check$
DECLARE
  v_fn OID := to_regprocedure('public.ai_helper_reserve_allowance(text,integer,text,integer)');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'ai_allowance_tier' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'ai_allowance self-check: organizations.ai_allowance_tier is missing, not nullable text, or has a default';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.organizations'::regclass AND conname = 'organizations_ai_allowance_tier_check' AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%small%' AND pg_get_constraintdef(oid) LIKE '%medium%' AND pg_get_constraintdef(oid) LIKE '%large%') THEN
    RAISE EXCEPTION 'ai_allowance self-check: the tier CHECK constraint is missing or wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'ai_allowance_tier' AND grantee IN ('anon', 'authenticated') AND privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')) THEN
    RAISE EXCEPTION 'ai_allowance self-check: a browser role can write the tier column';
  END IF;
  IF v_fn IS NULL OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'ai_allowance self-check: ai_helper_reserve_allowance is missing or not SECURITY DEFINER with search_path pg_catalog, public';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_allowance self-check: ai_helper_reserve_allowance must be executable by authenticated only';
  END IF;
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)')) IS DISTINCT FROM '48b3f8302686bc6310402b117ea09ad5'
     OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)')) IS DISTINCT FROM '3c415227fefdeda349442ff870a88e64' THEN
    RAISE EXCEPTION 'ai_allowance self-check: a 150 reserve body changed';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.pai_before EXCEPT SELECT * FROM pg_temp.pai_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.pai_fingerprint() EXCEPT SELECT * FROM pg_temp.pai_before) THEN
    RAISE EXCEPTION 'ai_allowance self-check: another function, grant, policy, trigger or organizations column changed';
  END IF;
END
$pai_self_check$;
DROP TABLE pg_temp.pai_before;
DROP FUNCTION pg_temp.pai_fingerprint();
COMMIT;
