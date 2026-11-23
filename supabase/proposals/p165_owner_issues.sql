-- =====================================================================================================
-- p165 (post-144 release 165, after 163 in supabase/release-plan.json): "Raise an issue" for every signed-in user and an owner-only
-- issues inbox. Modules C and E of the Tolra owner-issues work; they share this one table, so they are one release.
-- PROPOSAL ONLY. Not applied anywhere hosted. Packaged verbatim (the body inside its transaction) into
-- supabase/release/165_owner_issues.release.sql, which adds the prerequisite guard, a before/after fingerprint and the self-check.
-- Verify: supabase/verify/owner_issues_165.sql (every row true). Rollback: supabase/release/165_owner_issues.rollback.sql.
--
-- INPUTS: none. OUTPUTS: two tables and three functions, all new:
--   public.issues             one row per problem a person raised: company, person, page, text, urgent, status, created.
--   public.issue_owner_notes  the platform owner's PRIVATE side of an issue: notes and the link to the fixing pull request. Kept in its
--                             own table, with no grant and no policy for any browser role, so a company can never read it (a column of
--                             public.issues would be readable by the company's own row-level policy).
--   public.raise_issue(text, text, boolean)                         any signed-in person, for their own session's company.
--   public.platform_list_issues(uuid, text, boolean, integer)       platform owner only: every company, with filters.
--   public.platform_update_issue(uuid, text, text, text)            platform owner only: status, private notes, PR link, close.
-- WHAT IT DOES NOT DO: nothing existing is changed (no table, column, policy, trigger or function is altered or dropped); no e-mail is sent
--   and nothing calls AI; no data is read or written outside the two new tables; nothing is gated here except the company switch below.
-- THE SWITCH (off by default): raise_issue refuses unless the person's company has the marker 'issues:on' in
--   organization_settings.hidden_nav (the same positive-marker pattern as 'reports:on'). Without the marker nobody can raise an issue.
--   The owner functions are not company switches; the owner inbox has its own server flag (OWNER_ISSUES_ENABLED) in the app.
-- WHO CAN DO WHAT:
--   * A company's members READ (row-level security) only their own session company's rows of public.issues. Nobody in a browser can
--     insert, update or delete a row directly: the only grants on the table are SELECT to authenticated, none to anon.
--   * raise_issue: signed in, a session company, NOT a support session (a platform owner who entered a company uses the inbox, not the
--     company's form). Status is always 'new'; company and person always come from the session, never from the caller. At most 20 issues
--     per person per hour (a stuck button cannot flood the inbox). Page is 1 to 300 characters, text 1 to 2000.
--   * platform_*: is_platform_admin() and a second-step (aal2) token, both checked inside the function. Everyone else gets 42501.
-- STATUS: new, looking, fixing, fixed, closed. Closing stamps closed_at; moving back out of closed clears it.
-- MUST NOT CHANGE: any other table, policy, function or grant. The release's self-check proves every other function (with grants) and
--   every other policy is byte for byte as before.
BEGIN;

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

COMMIT;
