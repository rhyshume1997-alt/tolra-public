-- Post-144 release step 165 (Raise an issue for every signed-in user, and the platform owner's issues inbox; registered in
-- supabase/release-plan.json as phase 165, after 163; CI's post-144 step installs it). One transaction; never part of baseline replay. Not applied
-- anywhere hosted. Canonical source: supabase/proposals/p165_owner_issues.sql (its body between BEGIN; and COMMIT; is copied below verbatim;
-- scripts/check-release-plan.mjs fails if they drift). Number 164 belongs to the Companies screen and is not used or needed here.
-- WHAT IT DOES: adds two tables (public.issues, public.issue_owner_notes) and three functions (public.raise_issue, public.platform_list_issues,
-- public.platform_update_issue). The app's "Raise an issue" button and the /platform/issues inbox call them; until this is applied the
-- app's calls fail and the feature stays off (it is also off by default in the app: see below).
-- WHAT IT DOES NOT DO: nothing existing is altered or dropped; no e-mail is sent; nothing calls AI; no existing row is read or written.
-- SWITCHES (both off by default): raise_issue refuses unless the company's hidden_nav holds 'issues:on'; the owner inbox needs the server
-- flag OWNER_ISSUES_ENABLED exactly "true". Applying this file turns neither on.
-- HOW IT BEHAVES: see the header of the proposal. Companies read only their own company's rows (row security) and can write nothing
-- directly; the owner's notes and PR link live in a table no browser role can read; the platform functions need is_platform_admin() and aal2.
-- STATE: the release REFUSES, changing nothing, if either table or any function of these names already exists (installed or drifted); the
-- preflight marker tells whether 165 is applied. Verify: supabase/verify/owner_issues_165.sql (every row true). Rollback:
-- supabase/release/165_owner_issues.rollback.sql (refuses while any issue exists unless the runner accepts deleting them). Production only with
-- Rhys's separate yes on this exact file after a fresh backup.
-- Inputs: the database. Outputs: the two tables and three functions. Must not change: any other function, table, policy or trigger (the self-check
-- compares a fingerprint of all of them, with grants, before and after).
BEGIN;
DO $post_release_guard$
BEGIN
 IF to_regclass('public.organizations') IS NULL OR to_regclass('public.user_profiles') IS NULL OR to_regclass('public.organization_settings') IS NULL
    OR to_regclass('security_audit.platform_admins') IS NULL THEN
  RAISE EXCEPTION '165: organizations, user_profiles, organization_settings or the platform owner list is missing; stop and run release preflight';
 END IF;
 IF to_regprocedure('public.is_platform_admin()') IS NULL OR to_regprocedure('public.assert_platform_aal()') IS NULL
    OR to_regprocedure('public.my_session()') IS NULL OR to_regprocedure('public.current_user_organization_id()') IS NULL THEN
  RAISE EXCEPTION '165: a helper it calls (is_platform_admin, assert_platform_aal, my_session or current_user_organization_id) is missing; stop and run release preflight';
 END IF;
 IF to_regclass('public.issues') IS NOT NULL OR to_regclass('public.issue_owner_notes') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('raise_issue', 'platform_list_issues', 'platform_update_issue')) THEN
  RAISE EXCEPTION '165: public.issues, public.issue_owner_notes, raise_issue, platform_list_issues or platform_update_issue already exists (installed or drifted); stop and compare it first, nothing was changed';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything 165 must not touch. The self-check requires the identical fingerprint. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p165_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p165fp$
  SELECT 'every other function (name, args, security, config, body, grants)'::TEXT,
         md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), p.prosecdef::TEXT, coalesce(p.proconfig::TEXT, ''), md5(p.prosrc), coalesce(p.proacl::TEXT, ''))), '' ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), ''))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND NOT (n.nspname = 'public' AND p.proname IN ('raise_issue', 'platform_list_issues', 'platform_update_issue'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 'every other table in public (names, row security, grants)',
         md5(coalesce(string_agg(concat_ws('|', c.relname, c.relrowsecurity::TEXT, coalesce(c.relacl::TEXT, '')), ';' ORDER BY c.relname), ''))
  FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname NOT IN ('issues', 'issue_owner_notes')
  UNION ALL SELECT 'every other policy',
         md5(coalesce(string_agg(concat_ws('|', p.schemaname, p.tablename, p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, '')), ';' ORDER BY p.schemaname, p.tablename, p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE NOT (p.schemaname = 'public' AND p.tablename IN ('issues', 'issue_owner_notes'))
  UNION ALL SELECT 'every other trigger',
         md5(coalesce(string_agg(concat_ws('|', t.tgrelid::regclass::TEXT, t.tgname, t.tgenabled::TEXT), ';' ORDER BY t.tgrelid::regclass::TEXT, t.tgname), ''))
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid::regclass::TEXT NOT IN ('public.issues', 'public.issue_owner_notes')
$p165fp$;
CREATE TEMP TABLE p165_before ON COMMIT DROP AS SELECT * FROM pg_temp.p165_fingerprint();

-- ---- The proposal's body, unchanged ---------------------------------------------------------------------------------------------
-- ---- 1. The tables --------------------------------------------------------------------------------------------------------------
CREATE TABLE public.issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  page            TEXT NOT NULL CONSTRAINT issues_page_len CHECK (char_length(page) BETWEEN 1 AND 300),
  body            TEXT NOT NULL CONSTRAINT issues_body_len CHECK (char_length(body) BETWEEN 1 AND 2000),
  urgent          BOOLEAN NOT NULL DEFAULT FALSE,
  status          TEXT NOT NULL DEFAULT 'new' CONSTRAINT issues_status CHECK (status IN ('new', 'looking', 'fixing', 'fixed', 'closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  CONSTRAINT issues_closed_at_fits CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX issues_org_created_idx ON public.issues (organization_id, created_at DESC);
CREATE INDEX issues_status_created_idx ON public.issues (status, created_at DESC);
CREATE INDEX issues_user_created_idx ON public.issues (user_id, created_at DESC);

CREATE TABLE public.issue_owner_notes (
  issue_id   UUID PRIMARY KEY REFERENCES public.issues(id) ON DELETE CASCADE,
  notes      TEXT NOT NULL DEFAULT '' CONSTRAINT issue_owner_notes_len CHECK (char_length(notes) <= 4000),
  pr_url     TEXT CONSTRAINT issue_owner_notes_pr_url CHECK (pr_url IS NULL OR (char_length(pr_url) <= 500 AND pr_url ~ '^https://[^[:space:]]+$')),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- 2. Row security and grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_owner_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.issues, public.issue_owner_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.issues TO authenticated;
-- A company reads only its own session company's issues (the select is wrapped so it is evaluated once per statement, as 131 does).
CREATE POLICY "issues company select" ON public.issues FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()));
-- public.issue_owner_notes: row security on, NO policy and NO grant for any browser role. Only the platform functions below reach it.

-- ---- 3. Raise an issue (any signed-in person) -----------------------------------------------------------------------------------
CREATE FUNCTION public.raise_issue(p_page TEXT, p_body TEXT, p_urgent BOOLEAN DEFAULT FALSE)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_session JSONB;
  v_org     UUID;
  v_page    TEXT := btrim(coalesce(p_page, ''));
  v_body    TEXT := btrim(coalesce(p_body, ''));
  v_id      UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  v_session := public.my_session();
  v_org := nullif(v_session ->> 'organization_id', '')::UUID;
  IF v_org IS NULL OR coalesce((v_session ->> 'support')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501', HINT = 'not_permitted';
  END IF;
  IF NOT coalesce((SELECT 'issues:on' = ANY (s.hidden_nav) FROM public.organization_settings s WHERE s.organization_id = v_org), FALSE) THEN
    RAISE EXCEPTION 'Raising an issue is switched off for this company' USING ERRCODE = '42501', HINT = 'issues_off';
  END IF;
  IF p_urgent IS NULL OR char_length(v_body) NOT BETWEEN 1 AND 2000 OR char_length(v_page) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Invalid issue' USING ERRCODE = '22023', HINT = 'invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('issues-rate:' || v_uid::TEXT, 0));
  IF (SELECT count(*) FROM public.issues i WHERE i.user_id = v_uid AND i.created_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'Too many issues raised; try again later' USING ERRCODE = '22023', HINT = 'too_many';
  END IF;
  INSERT INTO public.issues (organization_id, user_id, page, body, urgent)
  VALUES (v_org, v_uid, v_page, v_body, p_urgent)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.raise_issue(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_issue(TEXT, TEXT, BOOLEAN) TO authenticated;

-- ---- 4. The owner's inbox (platform owner only) ---------------------------------------------------------------------------------
CREATE FUNCTION public.platform_list_issues(p_org UUID DEFAULT NULL, p_status TEXT DEFAULT NULL, p_urgent BOOLEAN DEFAULT NULL, p_limit INTEGER DEFAULT 200)
RETURNS TABLE (
  issue_id UUID, organization_id UUID, organization_name TEXT, raised_by_name TEXT, raised_by_email TEXT, page TEXT, body TEXT,
  urgent BOOLEAN, status TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, owner_notes TEXT, pr_url TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_platform_aal();
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('new', 'looking', 'fixing', 'fixed', 'closed') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT i.id, i.organization_id, o.name, u.full_name, u.email, i.page, i.body, i.urgent, i.status, i.created_at, i.updated_at, i.closed_at,
         coalesce(n.notes, ''), n.pr_url
  FROM public.issues i
  JOIN public.organizations o ON o.id = i.organization_id
  LEFT JOIN public.user_profiles u ON u.id = i.user_id
  LEFT JOIN public.issue_owner_notes n ON n.issue_id = i.id
  WHERE (p_org IS NULL OR i.organization_id = p_org)
    AND (p_status IS NULL OR i.status = p_status)
    AND (p_urgent IS NULL OR i.urgent = p_urgent)
  ORDER BY i.created_at DESC, i.id
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.platform_list_issues(UUID, TEXT, BOOLEAN, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_issues(UUID, TEXT, BOOLEAN, INTEGER) TO authenticated;

CREATE FUNCTION public.platform_update_issue(p_id UUID, p_status TEXT, p_notes TEXT, p_pr_url TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_notes  TEXT := coalesce(p_notes, '');
  v_pr     TEXT := nullif(btrim(coalesce(p_pr_url, '')), '');
  v_issue  public.issues%ROWTYPE;
BEGIN
  PERFORM public.assert_platform_aal();
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_status IS NULL OR p_status NOT IN ('new', 'looking', 'fixing', 'fixed', 'closed') OR char_length(v_notes) > 4000
     OR (v_pr IS NOT NULL AND (char_length(v_pr) > 500 OR v_pr !~ '^https://[^[:space:]]+$')) THEN
    RAISE EXCEPTION 'Invalid issue update' USING ERRCODE = '22023';
  END IF;
  UPDATE public.issues i
     SET status = p_status,
         updated_at = now(),
         closed_at = CASE WHEN p_status = 'closed' THEN coalesce(i.closed_at, now()) ELSE NULL END
   WHERE i.id = p_id
  RETURNING * INTO v_issue;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issue not found' USING ERRCODE = 'P0002', HINT = 'issue_not_found';
  END IF;
  INSERT INTO public.issue_owner_notes (issue_id, notes, pr_url, updated_by, updated_at)
  VALUES (p_id, v_notes, v_pr, auth.uid(), now())
  ON CONFLICT (issue_id) DO UPDATE SET notes = EXCLUDED.notes, pr_url = EXCLUDED.pr_url, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  RETURN jsonb_build_object('issue_id', v_issue.id, 'status', v_issue.status, 'updated_at', v_issue.updated_at, 'closed_at', v_issue.closed_at,
                            'owner_notes', v_notes, 'pr_url', v_pr);
END
$$;
REVOKE ALL ON FUNCTION public.platform_update_issue(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_update_issue(UUID, TEXT, TEXT, TEXT) TO authenticated;

DO $p165_self_check$
BEGIN
  IF to_regclass('public.issues') IS NULL OR to_regclass('public.issue_owner_notes') IS NULL THEN
    RAISE EXCEPTION '165 self-check: a table is missing';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('raise_issue', 'platform_list_issues', 'platform_update_issue')) <> 3 THEN
    RAISE EXCEPTION '165 self-check: there must be exactly one function of each name';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.raise_issue(text,text,boolean)') AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '393e29b3c90ca0a4407ebe40a54b924f')
     OR NOT has_function_privilege('authenticated', to_regprocedure('public.raise_issue(text,text,boolean)'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.raise_issue(text,text,boolean)'), 'EXECUTE') OR has_function_privilege('public', to_regprocedure('public.raise_issue(text,text,boolean)'), 'EXECUTE') THEN
    RAISE EXCEPTION '165 self-check: public.raise_issue(text,text,boolean) must be security definer with search_path pg_catalog, public, 165''s body (md5 393e29b3...), executable by signed-in users only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.platform_list_issues(uuid,text,boolean,integer)') AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '98e13a0f91183696ec04341659749cfc')
     OR NOT has_function_privilege('authenticated', to_regprocedure('public.platform_list_issues(uuid,text,boolean,integer)'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.platform_list_issues(uuid,text,boolean,integer)'), 'EXECUTE') OR has_function_privilege('public', to_regprocedure('public.platform_list_issues(uuid,text,boolean,integer)'), 'EXECUTE') THEN
    RAISE EXCEPTION '165 self-check: public.platform_list_issues(uuid,text,boolean,integer) must be security definer with search_path pg_catalog, public, 165''s body (md5 98e13a0f...), executable by signed-in users only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.platform_update_issue(uuid,text,text,text)') AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'bca6425ea57393a49841fc343f0a435e')
     OR NOT has_function_privilege('authenticated', to_regprocedure('public.platform_update_issue(uuid,text,text,text)'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.platform_update_issue(uuid,text,text,text)'), 'EXECUTE') OR has_function_privilege('public', to_regprocedure('public.platform_update_issue(uuid,text,text,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION '165 self-check: public.platform_update_issue(uuid,text,text,text) must be security definer with search_path pg_catalog, public, 165''s body (md5 bca6425e...), executable by signed-in users only';
  END IF;
  IF NOT (SELECT bool_and(c.relrowsecurity) FROM pg_catalog.pg_class c WHERE c.oid IN ('public.issues'::regclass, 'public.issue_owner_notes'::regclass)) THEN
    RAISE EXCEPTION '165 self-check: row security must be on for both tables';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'issues') <> 1
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'issue_owner_notes') THEN
    RAISE EXCEPTION '165 self-check: issues must have exactly its one select policy and issue_owner_notes none';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.issues', 'SELECT')
     OR has_table_privilege('authenticated', 'public.issues', 'INSERT') OR has_table_privilege('authenticated', 'public.issues', 'UPDATE') OR has_table_privilege('authenticated', 'public.issues', 'DELETE')
     OR has_table_privilege('anon', 'public.issues', 'SELECT') OR has_table_privilege('public', 'public.issues', 'SELECT')
     OR has_table_privilege('authenticated', 'public.issue_owner_notes', 'SELECT') OR has_table_privilege('authenticated', 'public.issue_owner_notes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.issue_owner_notes', 'UPDATE') OR has_table_privilege('authenticated', 'public.issue_owner_notes', 'DELETE')
     OR has_table_privilege('anon', 'public.issue_owner_notes', 'SELECT') THEN
    RAISE EXCEPTION '165 self-check: signed-in users may only SELECT public.issues; nobody in a browser may touch public.issue_owner_notes';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p165_before EXCEPT SELECT * FROM pg_temp.p165_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p165_fingerprint() EXCEPT SELECT * FROM pg_temp.p165_before) THEN
    RAISE EXCEPTION '165 self-check: another function, table, policy or trigger changed';
  END IF;
END
$p165_self_check$;
DROP TABLE pg_temp.p165_before;
DROP FUNCTION pg_temp.p165_fingerprint();
COMMIT;
