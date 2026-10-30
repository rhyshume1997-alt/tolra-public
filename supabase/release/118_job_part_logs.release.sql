-- 118_job_part_logs.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 118: parts done on a job, logged from My jobs (the operator's tablet) and shown as "N of M" on My jobs, Whole floor and the Job Board
-- (Rhys, with ChatGPT's "Build Overview Figures" item 3).
-- Before: the job says how many parts are wanted (jobs.quantity_required, M) and nothing says how many are made, so the office and the next
-- operator have to ask.
-- After: public.job_part_logs is an append-only log, one row per tap: the job, a quantity (positive to add parts, negative to take parts off
-- again), an optional note (a negative entry must say why, 3 to 250 characters), who logged it and when.
--   * LOG: log_job_parts(job, quantity, note, client_op_id) for admin, office and workshop. Office and admin may log on any job of their company;
--     a workshop person only on a job assigned to them (jobs.assigned_to, as My jobs lists them). A viewer cannot. Only on a job that is not
--     finished (a rework job counts as not finished, as My jobs lists it). The job must have a quantity (M).
--   * THE TOTAL IS KEPT BETWEEN 0 AND M: an entry that would take the total below 0 or above jobs.quantity_required is refused (22003) and
--     nothing is written. Two taps at once are taken one after the other (a lock per job), so the total can never overshoot.
--   * A CORRECTION IS A NEGATIVE ENTRY: nothing is ever edited or deleted; a wrong tap is put right with a negative entry and a note, and both stay.
--   * THE CLIENT OP ID IS THE KEY: the same id again returns the same entry and writes nothing more (a tablet that lost its connection after the
--     tap was saved can send it again); the same id with a different job, quantity or note is refused (22023).
--   * READ: every signed-in member of the company (admin, office, workshop and viewer) reads the company's log, so the count shows on the Job Board
--     and Whole floor. job_parts_done(jobs) answers the totals per job (it runs with the caller's own rights, so the row rules still apply).
--     Nobody signed in can insert, change or delete a row directly (no write grant): only log_job_parts writes.
--   * HISTORY: log_job_parts writes a named event on the JOB in the same transaction (LOG_JOB_PARTS, through security_audit.log_named_event, as
--     the photo events of 040 do), so it appears in the job's activity beside its other events (record_activity reads entity_table 'jobs').
--     The table also carries the standard row audit trigger.
--   * NOTHING ELSE CHANGES: logging parts never starts, pauses, finishes, holds or fails a job, never frees or stops a machine, and never touches
--     inspection, release, despatch or invoicing. Parts logged are parts logged: not parts passed, delivered or invoiced.
-- A support session stays read-only (the statement trigger every company table carries). Admin sign-in needs its second step (assert_privileged_aal
-- and the admin_mfa trigger, as job_flow_events).
-- Needs 000 (organizations, jobs, auth.users), 013 (security_audit.log_row_change), 015 (enforce_same_org_parent), 033 (assert_privileged_aal,
-- require_admin_mfa_guard), 035 (security_audit.log_named_event) and 036 (current_user_organization_id, has_org_role, support_readonly_guard).
-- Replaces no existing object. Safe to run again. Until this is applied the app hides every parts control and "N of M" (the table is missing),
-- so deploy order does not matter.
-- NUMBERING: 118 is a working number. At the time of writing origin/main's highest is 115; 116 (the Overview's owed snapshots) is reserved by
-- the branch design/overview-item1 and 117 (a Problem on a job) by design/myjobs-item2, neither yet on main. If either lands under another
-- number, renumber this file and its release, rollback and verify files and the preflight marker together (scripts/check-migrations.mjs).
-- The table holds company, job and person ids, a count, a short note and times.
-- =====================================================================================================

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.jobs') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.support_readonly_guard()') IS NULL OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL
     OR to_regprocedure('public.enforce_same_org_parent()') IS NULL OR to_regprocedure('public.assert_privileged_aal()') IS NULL
     OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('security_audit.log_row_change()') IS NULL THEN
    RAISE EXCEPTION '118 needs 000 (organizations, jobs), 013, 015, 033, 035 (log_named_event) and 036 (the helpers and guards it uses)';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 1. The table: one row per tap, never changed.
CREATE TABLE IF NOT EXISTS public.job_part_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id          UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  quantity        INTEGER NOT NULL CHECK (quantity <> 0 AND quantity BETWEEN -100000 AND 100000),
  note            TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 250),
  logged_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_op_id    UUID NOT NULL,
  UNIQUE (organization_id, client_op_id),
  CONSTRAINT job_part_logs_correction_says_why CHECK (quantity > 0 OR (note IS NOT NULL AND length(note) >= 3))
);
CREATE INDEX IF NOT EXISTS job_part_logs_by_job ON public.job_part_logs (organization_id, job_id);

ALTER TABLE public.job_part_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_part_logs rbac select" ON public.job_part_logs;
CREATE POLICY "job_part_logs rbac select" ON public.job_part_logs FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
REVOKE ALL ON public.job_part_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_part_logs TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_part_logs;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_part_logs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS audit_job_part_logs_changes ON public.job_part_logs;
CREATE TRIGGER audit_job_part_logs_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_part_logs
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.job_part_logs;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.job_part_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.job_part_logs;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.job_part_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 2. Log parts. Returns the entry's id. A client op id used before returns that entry and writes nothing more; the same id with another job,
-- quantity or note is refused (22023). Refused (42501): not signed in to a company, a viewer, a workshop person on a job not assigned to them.
-- A job of another company is not found (P0002). A finished job (not in rework) is refused (55000); a job with no quantity is refused (22023);
-- a total that would go below 0 or above the quantity required is refused (22003).
CREATE OR REPLACE FUNCTION public.log_job_parts(p_job UUID, p_quantity INTEGER, p_note TEXT, p_client_op_id UUID)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_user     UUID := auth.uid();
  v_note     TEXT := nullif(btrim(p_note), '');
  v_id       UUID;
  v_job_no   TEXT;
  v_assign   UUID;
  v_finished TIMESTAMPTZ;
  v_stage    TEXT;
  v_required INTEGER;
  v_total    BIGINT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_job IS NULL OR p_client_op_id IS NULL OR p_quantity IS NULL OR p_quantity = 0 OR abs(p_quantity) > 100000
     OR length(coalesce(v_note, '')) > 250 OR (p_quantity < 0 AND length(coalesce(v_note, '')) < 3) THEN
    RAISE EXCEPTION 'Invalid parts entry' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('job_parts_op:' || v_org::TEXT || ':' || p_client_op_id::TEXT, 0));
  SELECT id INTO v_id FROM public.job_part_logs WHERE organization_id = v_org AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.job_part_logs
                   WHERE id = v_id AND job_id = p_job AND logged_by IS NOT DISTINCT FROM v_user AND quantity = p_quantity AND note IS NOT DISTINCT FROM v_note) THEN
      RAISE EXCEPTION 'That request key was used for a different entry.' USING ERRCODE = '22023';
    END IF;
    RETURN v_id;
  END IF;
  SELECT j.job_no, j.assigned_to, j.finished_at, j.stage, j.quantity_required INTO v_job_no, v_assign, v_finished, v_stage, v_required
  FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_assign IS DISTINCT FROM v_user AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'That job is not assigned to you.' USING ERRCODE = '42501';
  END IF;
  IF v_finished IS NOT NULL AND v_stage IS DISTINCT FROM 'rework' THEN
    RAISE EXCEPTION 'That job is finished.' USING ERRCODE = '55000';
  END IF;
  IF v_required IS NULL OR v_required < 1 THEN
    RAISE EXCEPTION 'That job has no quantity to count against.' USING ERRCODE = '22023';
  END IF;
  -- One tap at a time per job, so the total below is the total this entry is added to.
  PERFORM pg_advisory_xact_lock(hashtextextended('job_parts_job:' || p_job::TEXT, 0));
  SELECT coalesce(sum(quantity), 0) INTO v_total FROM public.job_part_logs WHERE organization_id = v_org AND job_id = p_job;
  IF v_total + p_quantity < 0 THEN
    RAISE EXCEPTION 'That would take the total below 0.' USING ERRCODE = '22003';
  END IF;
  IF v_total + p_quantity > v_required THEN
    RAISE EXCEPTION 'That would take the total above the quantity required.' USING ERRCODE = '22003';
  END IF;
  INSERT INTO public.job_part_logs (organization_id, job_id, quantity, note, logged_by, client_op_id)
  VALUES (v_org, p_job, p_quantity, v_note, v_user, p_client_op_id)
  RETURNING id INTO v_id;
  PERFORM security_audit.log_named_event(v_org, 'LOG_JOB_PARTS', 'jobs', p_job::TEXT,
    jsonb_build_object('log_id', v_id, 'job_no', v_job_no, 'quantity', p_quantity, 'note', v_note, 'total_after', v_total + p_quantity, 'quantity_required', v_required));
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.log_job_parts(UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_job_parts(UUID, INTEGER, TEXT, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. The totals, per job. Runs with the caller's own rights (not definer), so the row rules above decide what is counted: a person of another
-- company counts nothing of this one. A job with no entries has no row (the app reads that as 0 of M).
CREATE OR REPLACE FUNCTION public.job_parts_done(p_jobs UUID[])
RETURNS TABLE (job_id UUID, parts_done INTEGER)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT l.job_id, sum(l.quantity)::INTEGER
  FROM public.job_part_logs l
  WHERE l.job_id = ANY (p_jobs)
  GROUP BY l.job_id
$$;
REVOKE ALL ON FUNCTION public.job_parts_done(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_parts_done(UUID[]) TO authenticated;

COMMIT;
