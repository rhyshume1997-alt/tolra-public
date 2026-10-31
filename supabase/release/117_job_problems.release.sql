-- 117_job_problems.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 117: a Problem on a job, raised from My jobs (the operator's tablet) and cleared by the office (Rhys, with ChatGPT's "Build Overview Figures" item 2).
-- Before: an operator who finds the material wrong, the drawing unclear or a machine down can only tell someone. Nothing is written down, the Job Board
-- shows nothing, and the office hears nothing.
-- After: public.job_problems keeps one row per problem: the job, a reason (material, drawing, machine, quality, tooling or other), an optional note
-- (500 characters at most), who raised it and when, and later who cleared it, when and what was done.
--   * RAISE: report_job_problem(job, reason, note, request_id) for admin, office and workshop. Office and admin may raise one on any job of their
--     company; a workshop person only on a job assigned to them (jobs.assigned_to, as My jobs lists them). A viewer cannot. The request id is the key:
--     the same request again returns the same problem and writes nothing more, the same id with a different job, reason or note is refused.
--   * CLEAR: resolve_job_problem(problem, note) for admin and office only (a note of 3 to 500 characters saying what was done). A workshop person,
--     a viewer and a support session cannot. The row stays (status resolved, who, when, the note); nothing is ever deleted through the app.
--   * READ: every signed-in member of the company (admin, office, workshop and viewer) reads the company's problems, so the flag shows on the Job
--     Board and on My jobs. Nobody signed in can insert, change or delete a row directly (no write grant): only the two functions write.
--   * HISTORY: each of the two functions writes a named event on the JOB in the same transaction (REPORT_JOB_PROBLEM, RESOLVE_JOB_PROBLEM, through
--     security_audit.log_named_event, as the photo events of 040 do), so both appear in the job's activity beside its other events (record_activity
--     reads entity_table 'jobs'). The table also carries the standard row audit trigger.
--   * NOTHING ELSE CHANGES: a Problem never starts, pauses, finishes, holds or fails a job, never frees or stops a machine and never touches
--     inspection or release. The operator uses Pause as before when work has to stop.
-- A support session stays read-only (the statement trigger every company table carries). Admin sign-in needs its second step (assert_privileged_aal
-- and the admin_mfa trigger, as job_flow_events).
-- Needs 000 (organizations, jobs, auth.users), 013 (security_audit.log_row_change), 015 (enforce_same_org_parent), 033 (assert_privileged_aal,
-- require_admin_mfa_guard), 035 (security_audit.log_named_event) and 036 (current_user_organization_id, has_org_role, support_readonly_guard).
-- Replaces no existing object. Safe to run again. Until this is applied the app hides every Problem control and the Needs attention rule is empty
-- (the table is missing), so deploy order does not matter.
-- NUMBERING: 117 is a working number. 116 (the Overview's owed snapshots) is taken by the open Overview PR (design/overview-item1), not yet on main.
-- The table holds company, job and person ids, a reason, two short notes and times.
-- =====================================================================================================

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.jobs') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.support_readonly_guard()') IS NULL OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL
     OR to_regprocedure('public.enforce_same_org_parent()') IS NULL OR to_regprocedure('public.assert_privileged_aal()') IS NULL
     OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('security_audit.log_row_change()') IS NULL THEN
    RAISE EXCEPTION '117 needs 000 (organizations, jobs), 013, 015, 033, 035 (log_named_event) and 036 (the helpers and guards it uses)';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 1. The table: one row per problem.
CREATE TABLE IF NOT EXISTS public.job_problems (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id          UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason IN ('material', 'drawing', 'machine', 'quality', 'tooling', 'other')),
  note            TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  reported_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(resolution_note) BETWEEN 3 AND 500),
  request_id      UUID NOT NULL,
  UNIQUE (organization_id, request_id),
  CONSTRAINT job_problems_state_shape CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolution_note IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS job_problems_open_by_job ON public.job_problems (organization_id, job_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS job_problems_open_by_time ON public.job_problems (organization_id, reported_at DESC) WHERE status = 'open';

ALTER TABLE public.job_problems ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_problems rbac select" ON public.job_problems;
CREATE POLICY "job_problems rbac select" ON public.job_problems FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
REVOKE ALL ON public.job_problems FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_problems TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_problems;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_problems
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS audit_job_problems_changes ON public.job_problems;
CREATE TRIGGER audit_job_problems_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_problems
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.job_problems;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.job_problems
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.job_problems;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.job_problems
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 2. Raise a problem. Returns the problem's id. A request id used before returns that problem and writes nothing more (a tablet that lost its
-- connection after the problem was saved can send it again); the same id with another job, reason or note is refused (22023).
-- Refused (42501): not signed in to a company, a viewer, a workshop person on a job not assigned to them. A job of another company is not found (P0002).
CREATE OR REPLACE FUNCTION public.report_job_problem(p_job UUID, p_reason TEXT, p_note TEXT, p_request_id UUID)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_note   TEXT := nullif(btrim(p_note), '');
  v_id     UUID;
  v_job_no TEXT;
  v_assign UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_job IS NULL OR p_request_id IS NULL OR p_reason IS NULL
     OR p_reason NOT IN ('material', 'drawing', 'machine', 'quality', 'tooling', 'other')
     OR length(coalesce(v_note, '')) > 500 THEN
    RAISE EXCEPTION 'Invalid problem report' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('job_problem:' || v_org::TEXT || ':' || p_request_id::TEXT, 0));
  SELECT id INTO v_id FROM public.job_problems WHERE organization_id = v_org AND request_id = p_request_id;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.job_problems
                   WHERE id = v_id AND job_id = p_job AND reported_by IS NOT DISTINCT FROM v_user AND reason = p_reason AND note IS NOT DISTINCT FROM v_note) THEN
      RAISE EXCEPTION 'That request key was used for a different problem.' USING ERRCODE = '22023';
    END IF;
    RETURN v_id;
  END IF;
  SELECT j.job_no, j.assigned_to INTO v_job_no, v_assign FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_assign IS DISTINCT FROM v_user AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'That job is not assigned to you.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.job_problems (organization_id, job_id, reason, note, reported_by, request_id)
  VALUES (v_org, p_job, p_reason, v_note, v_user, p_request_id)
  RETURNING id INTO v_id;
  PERFORM security_audit.log_named_event(v_org, 'REPORT_JOB_PROBLEM', 'jobs', p_job::TEXT,
    jsonb_build_object('problem_id', v_id, 'job_no', v_job_no, 'reason', p_reason, 'note', v_note));
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.report_job_problem(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_job_problem(UUID, TEXT, TEXT, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. Clear a problem (admin and office only): the status becomes resolved, with who, when and what was done (3 to 500 characters). A problem that
-- is not open (already cleared, or another company's) is not found (P0002); anyone else is refused (42501).
CREATE OR REPLACE FUNCTION public.resolve_job_problem(p_problem UUID, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_note   TEXT := btrim(p_note);
  v_job    UUID;
  v_reason TEXT;
  v_job_no TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin and office staff clear a problem.' USING ERRCODE = '42501';
  END IF;
  IF p_problem IS NULL OR length(coalesce(v_note, '')) < 3 OR length(v_note) > 500 THEN
    RAISE EXCEPTION 'Say what was done: 3 to 500 characters.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.job_problems
  SET status = 'resolved', resolved_at = now(), resolved_by = v_user, resolution_note = v_note
  WHERE id = p_problem AND organization_id = v_org AND status = 'open'
  RETURNING job_id, reason INTO v_job, v_reason;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Open problem not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT j.job_no INTO v_job_no FROM public.jobs j WHERE j.id = v_job;
  PERFORM security_audit.log_named_event(v_org, 'RESOLVE_JOB_PROBLEM', 'jobs', v_job::TEXT,
    jsonb_build_object('problem_id', p_problem, 'job_no', v_job_no, 'reason', v_reason, 'resolution_note', v_note));
END
$$;
REVOKE ALL ON FUNCTION public.resolve_job_problem(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_job_problem(UUID, TEXT) TO authenticated;

COMMIT;
