-- =====================================================================================================
-- 052: weekly review and approval of hours. Time and pay plan, PR 3 (docs/plans/time-and-pay.md section 8; John's answers of Sun 18 Oct
-- 2026: John approves the hours, weekly, per person).
--
-- 1. time_week_approvals: one row per approval of one person's week (Monday, Europe/London), never changed or removed. It records who
--    approved, when, the figures they saw (totals: basic and overtime hours, breaks, days worked, flags; worked out by the app,
--    lib/time-sheet.ts) and the REVISION of what they are worked out from: a fingerprint of that person's clock records and job time in
--    the week (and a day either side, as the sheet reads them) and of the company's hours settings that change the figures (breaks,
--    overtime rules, bank holiday region). Approving again after a change adds a new row; the latest row is the approval.
-- 2. time_week_status(week, user): per person, the current revision, the latest approval, and the state: 'not_approved', 'approved', or
--    'changed_since_approval' (a correction after approval changed the revision). Workshop: their own row only; admin and office: everyone
--    in the company with a role that records time (admin, office, workshop) or with records that week. Viewer: refused.
-- 3. approve_time_week(user, week, revision, totals, note): the company's approver roles only (time_settings.approver_roles, default
--    admin; 050). Refused when the revision the approver saw is no longer current (someone changed the week meanwhile: reload and look
--    again), for a week that hasn't started, for someone outside the company. Audited TIME_WEEK_APPROVED. It holds the person's clock and
--    labour locks (050, 051) while it works out the revision and records the approval; every clock and labour write takes one of them
--    before it asks whether the week is approved, so an approval and a write of the same person never cross (051 LOCK ORDER).
-- 4. time_week_locked (050's placeholder, replaced): TRUE once the person's week has an approval. From then on the person can't correct
--    that week themselves (050 and 051 ask this); an admin still can, and the week shows 'changed_since_approval' until approved again.
--    time_week_locked_at (050's placeholder, replaced): TRUE for a time in an approved week AT OR BEFORE an approval of it, so the
--    person's own clock actions, sheet Start/Stop and Job Board Start/Pause/Finish (051) can't write a back-dated time into hours
--    already approved (a device sending a time up to 14 days old): refused, hint week_approved. Doing it now (after the approval) is
--    recorded and shows as 'changed_since_approval'. Admins are never refused.
--
-- No pay, no money, no export: the accountant's export comes later, once the new accountant's format is known (plan section 7).
-- SECURITY DEFINER, pinned search_path, assert_privileged_aal(), the caller's company and role checked first. Additive: one table, six
-- functions (two replaced: time_week_locked and time_week_locked_at, 050's internal placeholders). Forward only, safe to run more than once. Needs 050 and 051.
-- Rollback: docs/RELEASE.md "Migration 052".
-- =====================================================================================================

CREATE TABLE IF NOT EXISTS public.time_week_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  week_start      DATE NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  revision        TEXT NOT NULL CHECK (revision ~ '^[0-9a-f]{32}$'),
  totals          JSONB NOT NULL CHECK (jsonb_typeof(totals) = 'object' AND octet_length(totals::TEXT) <= 16384),
  note            TEXT CHECK (note IS NULL OR length(note) <= 500),
  approved_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_time_week_approvals_person ON public.time_week_approvals (organization_id, user_id, week_start, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_week_approvals_week ON public.time_week_approvals (organization_id, week_start);

ALTER TABLE public.time_week_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "time_week_approvals rbac select" ON public.time_week_approvals;
CREATE POLICY "time_week_approvals rbac select" ON public.time_week_approvals FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.time_week_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.time_week_approvals TO authenticated;

DROP TRIGGER IF EXISTS audit_time_week_approvals_changes ON public.time_week_approvals;
CREATE TRIGGER audit_time_week_approvals_changes AFTER INSERT OR UPDATE OR DELETE ON public.time_week_approvals
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.time_week_approvals;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.time_week_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.time_week_approvals;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.time_week_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- An approval is a record: never changed or removed (also not by the owner). Approving again adds a row.
CREATE OR REPLACE FUNCTION public.time_week_approvals_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'An approval is a record: it is never changed or removed. Approve the week again instead.' USING ERRCODE = '42501', HINT = 'approval_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.time_week_approvals_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS time_week_approvals_immutable ON public.time_week_approvals;
CREATE TRIGGER time_week_approvals_immutable BEFORE UPDATE OR DELETE ON public.time_week_approvals
  FOR EACH ROW EXECUTE FUNCTION public.time_week_approvals_immutable();
DROP TRIGGER IF EXISTS time_week_approvals_no_truncate ON public.time_week_approvals;
CREATE TRIGGER time_week_approvals_no_truncate BEFORE TRUNCATE ON public.time_week_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION public.time_week_approvals_immutable();

-- ---- The revision of a person's week ----------------------------------------------------------------------------------------------
-- A fingerprint (md5) of everything the week's figures are worked out from: the person's clock records from local Monday 00:00 minus a day
-- to the next Monday 00:00 plus a day (lib/time-sheet.ts EDGE_MARGIN_HOURS), their job time overlapping it, with every field a
-- correction or a void changes, and the company's settings that change the figures (time_settings: breaks, overtime, bank holiday
-- region; not who approves or the long-session flag). Any change to them gives a new revision. Internal.
CREATE OR REPLACE FUNCTION public.time_week_revision(p_org UUID, p_user UUID, p_week DATE)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH w AS (
    SELECT (p_week::TIMESTAMP AT TIME ZONE 'Europe/London') - INTERVAL '24 hours' AS lo,
           ((p_week + 7)::TIMESTAMP AT TIME ZONE 'Europe/London') + INTERVAL '24 hours' AS hi
  )
  SELECT md5(
    coalesce((SELECT string_agg(concat_ws('|', e.id, e.action, e.at, e.supersedes), ';' ORDER BY e.id)
              FROM public.attendance_events e, w
              WHERE e.organization_id = p_org AND e.user_id = p_user AND e.at >= w.lo AND e.at < w.hi), '')
    || '#' ||
    coalesce((SELECT string_agg(concat_ws('|', s.id, s.job_id, s.started_at, s.ended_at, s.voided_at), ';' ORDER BY s.id)
              FROM public.operator_sessions s, w
              WHERE s.organization_id = p_org AND s.user_id = p_user AND s.started_at < w.hi AND (s.ended_at IS NULL OR s.ended_at > w.lo)), '')
    || '#' ||
    -- A company with no settings row yet has the defaults (050's column defaults): the same text, so saving them changes nothing.
    (SELECT concat_ws('|', coalesce(t.breaks_paid, FALSE), coalesce(t.lunch_minutes, 30), coalesce(t.break_minutes, 15),
                      coalesce(t.break_min_day_hours, 6::NUMERIC(4,2)), coalesce(t.daily_overtime_hours, 8::NUMERIC(4,2)),
                      coalesce(t.saturday_overtime, TRUE), coalesce(t.sunday_overtime, TRUE), coalesce(t.bank_holiday_overtime, TRUE),
                      coalesce(t.overtime_multiplier, 1.5::NUMERIC(3,2)), coalesce(t.bank_holiday_region, 'england-and-wales'))
     FROM (SELECT 1) d LEFT JOIN public.time_settings t ON t.organization_id = p_org))
$$;
REVOKE ALL ON FUNCTION public.time_week_revision(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- 050's placeholder, now real: the person's week is locked for them once it has been approved.
CREATE OR REPLACE FUNCTION public.time_week_locked(p_org UUID, p_user UUID, p_week DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.time_week_approvals a WHERE a.organization_id = p_org AND a.user_id = p_user AND a.week_start = p_week)
$$;
REVOKE ALL ON FUNCTION public.time_week_locked(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- 050's placeholder, now real: a time in the person's approved week at or before an approval of it (hours already reviewed).
CREATE OR REPLACE FUNCTION public.time_week_locked_at(p_org UUID, p_user UUID, p_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.time_week_approvals a
                 WHERE a.organization_id = p_org AND a.user_id = p_user AND a.week_start = public.time_week_of(p_at) AND a.approved_at >= p_at)
$$;
REVOKE ALL ON FUNCTION public.time_week_locked_at(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- ---- Status of a week ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.time_week_status(p_week DATE, p_user UUID DEFAULT NULL)
RETURNS TABLE (user_id UUID, revision TEXT, state TEXT, approved_revision TEXT, approved_at TIMESTAMPTZ, approved_by UUID, totals JSONB, note TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.time_caller_org();
  v_all    BOOLEAN := public.has_org_role(ARRAY['admin', 'office']);
BEGIN
  IF p_week IS NULL OR extract(isodow FROM p_week) <> 1 THEN
    RAISE EXCEPTION 'A week starts on a Monday.' USING ERRCODE = '22023', HINT = 'bad_week';
  END IF;
  IF p_user IS NOT NULL AND p_user <> auth.uid() AND NOT v_all THEN
    RAISE EXCEPTION 'You can only see your own hours.' USING ERRCODE = '42501', HINT = 'own_only';
  END IF;
  RETURN QUERY
  WITH people AS (
    SELECT m.user_id FROM public.organization_members m
    WHERE m.organization_id = v_org AND NOT m.support AND (m.active AND (m.role IN ('admin', 'office', 'workshop') OR m.secondary_role IN ('admin', 'office', 'workshop'))
                                                          OR EXISTS (SELECT 1 FROM public.attendance_events e WHERE e.organization_id = v_org AND e.user_id = m.user_id
                                                                       AND public.time_week_of(e.at) = p_week)
                                                          OR EXISTS (SELECT 1 FROM public.operator_sessions s WHERE s.organization_id = v_org AND s.user_id = m.user_id
                                                                       AND public.time_week_of(s.started_at) = p_week))
      AND (CASE WHEN p_user IS NOT NULL THEN m.user_id = p_user WHEN v_all THEN TRUE ELSE m.user_id = auth.uid() END)
  ),
  latest AS (
    SELECT DISTINCT ON (a.user_id) a.user_id, a.revision, a.approved_at, a.approved_by, a.totals, a.note
    FROM public.time_week_approvals a
    WHERE a.organization_id = v_org AND a.week_start = p_week AND a.user_id IN (SELECT p.user_id FROM people p)
    ORDER BY a.user_id, a.approved_at DESC, a.id
  )
  SELECT p.user_id, r.rev,
         CASE WHEN l.user_id IS NULL THEN 'not_approved' WHEN l.revision = r.rev THEN 'approved' ELSE 'changed_since_approval' END,
         l.revision, l.approved_at, l.approved_by, l.totals, l.note
  FROM people p
  CROSS JOIN LATERAL (SELECT public.time_week_revision(v_org, p.user_id, p_week) AS rev) r
  LEFT JOIN latest l ON l.user_id = p.user_id
  ORDER BY p.user_id;
END
$$;
REVOKE ALL ON FUNCTION public.time_week_status(DATE, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.time_week_status(DATE, UUID) TO authenticated;

-- ---- Approve ------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_time_week(p_user UUID, p_week DATE, p_revision TEXT, p_totals JSONB, p_note TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID;
  v_roles TEXT[];
  v_rev   TEXT;
  v_row   public.time_week_approvals%ROWTYPE;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  SELECT s.approver_roles INTO v_roles FROM public.time_settings s WHERE s.organization_id = v_org;
  IF NOT public.has_org_role(coalesce(v_roles, ARRAY['admin']::TEXT[])) THEN
    RAISE EXCEPTION 'Only % can approve hours.', array_to_string(coalesce(v_roles, ARRAY['admin']::TEXT[]), ' or ') USING ERRCODE = '42501', HINT = 'not_approver';
  END IF;
  IF p_week IS NULL OR extract(isodow FROM p_week) <> 1 THEN
    RAISE EXCEPTION 'A week starts on a Monday.' USING ERRCODE = '22023', HINT = 'bad_week';
  END IF;
  IF p_week > (now() AT TIME ZONE 'Europe/London')::DATE THEN
    RAISE EXCEPTION 'That week hasn''t started yet.' USING ERRCODE = '22023', HINT = 'future_week';
  END IF;
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = v_org AND m.user_id = p_user AND NOT m.support) THEN
    RAISE EXCEPTION 'That person is not in this company.' USING ERRCODE = 'P0002', HINT = 'not_member';
  END IF;
  IF p_totals IS NULL OR jsonb_typeof(p_totals) <> 'object' OR octet_length(p_totals::TEXT) > 16384 THEN
    RAISE EXCEPTION 'The figures approved are missing.' USING ERRCODE = '22023', HINT = 'bad_totals';
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 500 THEN
    RAISE EXCEPTION 'The note is too long (500 characters at most).' USING ERRCODE = '22023', HINT = 'note_too_long';
  END IF;
  -- The person's records can't change while we compare and record: the company's audit-chain lock, their clock lock, then their
  -- labour lock (050's attendance_lock and 051's labour_lock; every clock and labour write takes the company lock before its person
  -- lock and asks whether the week is approved only once it holds that: 051 LOCK ORDER), so no deadlock. The revision is worked out in a
  -- statement that starts after all are held: it includes every clock or labour write that committed while this waited (then the
  -- approver's revision is stale), and a write still waiting will see this approval when it gets the lock.
  PERFORM public.attendance_lock(v_org, p_user);
  PERFORM public.labour_lock(v_org, p_user);
  v_rev := public.time_week_revision(v_org, p_user, p_week);
  IF p_revision IS DISTINCT FROM v_rev THEN
    RAISE EXCEPTION 'These hours changed while you were looking at them. Reload, check them and approve again.' USING ERRCODE = '22023', HINT = 'stale_revision';
  END IF;
  INSERT INTO public.time_week_approvals (organization_id, user_id, week_start, revision, totals, note, approved_by)
  VALUES (v_org, p_user, p_week, v_rev, p_totals, nullif(btrim(p_note), ''), auth.uid())
  RETURNING * INTO v_row;
  PERFORM security_audit.log_named_event(v_org, 'TIME_WEEK_APPROVED', 'time_week_approvals', v_row.id::TEXT,
    jsonb_build_object('user_id', p_user, 'week_start', p_week, 'revision', v_rev, 'totals', p_totals));
  RETURN jsonb_build_object('approval_id', v_row.id, 'user_id', p_user, 'week_start', p_week, 'revision', v_rev, 'approved_at', v_row.approved_at,
                            'approved_by', v_row.approved_by, 'state', 'approved');
END
$$;
REVOKE ALL ON FUNCTION public.approve_time_week(UUID, DATE, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_time_week(UUID, DATE, TEXT, JSONB, TEXT) TO authenticated;
