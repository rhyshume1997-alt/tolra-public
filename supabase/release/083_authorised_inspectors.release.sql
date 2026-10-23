-- 083_authorised_inspectors.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 083: ISO 9001 PR C (Rhys, Tue 20 Oct; Grok and ChatGPT): 7.2 authorised inspectors, and 8.2 / 8.5.1 the drawing revision only where
-- the job needs it. Worksheet version pinning stays parked; no corrective-action row (nonconformances are recorded by 081).
-- Applies after 081 and 082. Rules: lowest friction on the floor; every change in the audit log (who, when, why); records never erased;
-- RLS, company isolation, two-step sign-in and the API grants as tight as before.
--
-- WHAT CHANGES. The inspectors list is the company's members with organization_members.can_inspect (034) on: 034's flag is extended,
-- not replaced (set_member_inspector, the Admin > Users tick and the test fixtures keep working).
-- 1. public.inspector_authorisations: the list's history. Each change to can_inspect, by any path (the new set_authorised_inspector,
--    034's set_member_inspector, the service role, the SQL editor), adds a row (added / removed, scope, reason, by, when), written by
--    a trigger on organization_members so it can't be skipped. Rows are never changed or removed. Admin and office read them.
-- 2. public.set_authorised_inspector(user, authorised, scope, reason): admin only, two-step sign-in, a reason of 10 to 500
--    characters; only an active admin, office or workshop member can be added. Audited as SET_INSPECTOR with the reason.
-- 3. Only someone on the list records an inspection PASS (job_inspections result 'pass') or co-signs a sign-off as the inspector
--    (job_signoffs kind 'inspector'): a BEFORE INSERT trigger on both tables refuses anyone else, whatever function writes the row,
--    so an offline replay is checked when it reaches the server. The check locks the inspector's member row FOR SHARE: a removal
--    committed first refuses the pass; a pass in flight first is kept and the removal waits for it. Signed-in sessions only, as for
--    the other release locks: the database owner and the service role are exempt.
-- 4. inspect_job (081) is 081's body but for its interim check ("an admin, or someone ticked"): only someone on the list records an
--    inspection through it, admins included. 081's admin override for inspecting one's own work stays as 081 defines it.
-- 5. jobs.drawing_revision_required (off by default) and jobs.drawing_revision: a job that requires it can't become Complete without
--    a drawing revision; set_job_drawing_revision sets both (admin and office decide the requirement; admin, office and workshop enter
--    the revision; a reason for every change but the first entry and switching it on; refused on a Complete job). When it is off,
--    nothing changes.
-- 6. Backfill: everyone who could record a pass before 083 still can. Each active admin (not support access) is put on the list;
--    each member already ticked gets a history row. Nobody gains a right they didn't have. No job is changed.
-- GUARD (section 1): inspect_job must be 081's (or already 083's), compared by md5 with every whitespace character removed; 083's own
-- functions, if present, must be 083's. Anything else stops the release and nothing of 083 is kept. Safe to run again.
-- Rollback: supabase/release/083_authorised_inspectors.rollback.sql (081's inspect_job back; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 083 builds on is there.
DO $$
BEGIN
  IF to_regclass('public.job_inspections') IS NULL OR to_regclass('public.job_signoffs') IS NULL THEN
    RAISE EXCEPTION '083: job_inspections (034) or job_signoffs (045) is missing';
  END IF;
  IF to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION '083: needs 081 (inspect_job) applied first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organization_members' AND column_name = 'can_inspect') THEN
    RAISE EXCEPTION '083: organization_members.can_inspect (034) is missing';
  END IF;
  IF to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL
     OR to_regprocedure('public.support_readonly_guard()') IS NULL
     OR to_regprocedure('security_audit.log_row_change()') IS NULL OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '083: a helper it needs (034 to 065) is missing';
  END IF;
  -- On a second run its own functions are 083's (md5 with every whitespace character removed: a CRLF paste matches); a function of
  -- the same name with any other body stops the release and nothing of 083 is kept.
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE (p.oid = to_regprocedure('public.set_authorised_inspector(uuid,boolean,text,text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '3feb78aa2e974acc776b223963a8440e')
                OR (p.oid = to_regprocedure('public.inspection_pass_authorised()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'a3280e8e083ff65f62334c60d78fd997')
                OR (p.oid = to_regprocedure('public.organization_members_inspector_history()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '6719f28c0191905b51448888d0916dca')
                OR (p.oid = to_regprocedure('public.iso_083_record_immutable()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '2908fd0ebbd6f135c2e15bd36c679b62')
                OR (p.oid = to_regprocedure('public.set_job_drawing_revision(uuid,boolean,text,text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'b51f521600f522860edfdcb6d22363df')
                OR (p.oid = to_regprocedure('public.jobs_drawing_revision_guard()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '5594dd93affd98aa4428f980b97d33b2')) THEN
    RAISE EXCEPTION '083: a function 083 creates already exists with another body; stop and compare it first';
  END IF;
  IF coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
               WHERE p.oid = to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)')), 'missing')
     NOT IN ('c8dd01f7f385e60e1a4597e5f1da8fe8', 'b411b17ef7cb8a5f3700957d9a7a264f') THEN
    RAISE EXCEPTION '083: public.inspect_job is not 081''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. 7.2 Authorised inspectors.
-- 2a. The history of the list: one row per change of organization_members.can_inspect. Never changed or removed.
CREATE TABLE IF NOT EXISTS public.inspector_authorisations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  user_id         UUID NOT NULL,
  change          TEXT NOT NULL CHECK (change IN ('added', 'removed')),
  scope           TEXT CHECK (scope IS NULL OR (length(btrim(scope)) BETWEEN 1 AND 200 AND scope !~ '[[:cntrl:]]')),
  reason          TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  changed_by      UUID,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inspector_authorisations_member ON public.inspector_authorisations (organization_id, user_id, changed_at DESC);

ALTER TABLE public.inspector_authorisations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inspector_authorisations rbac select" ON public.inspector_authorisations;
CREATE POLICY "inspector_authorisations rbac select" ON public.inspector_authorisations FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
REVOKE ALL ON public.inspector_authorisations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inspector_authorisations TO authenticated;

-- A record: never changed or removed, by anyone (definer code and the service role included).
CREATE OR REPLACE FUNCTION public.iso_083_record_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'This is a quality record: it is never changed or removed.' USING ERRCODE = '42501', HINT = 'record_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.iso_083_record_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inspector_authorisations_immutable ON public.inspector_authorisations;
CREATE TRIGGER inspector_authorisations_immutable BEFORE UPDATE OR DELETE ON public.inspector_authorisations
  FOR EACH ROW EXECUTE FUNCTION public.iso_083_record_immutable();
DROP TRIGGER IF EXISTS audit_inspector_authorisations_changes ON public.inspector_authorisations;
CREATE TRIGGER audit_inspector_authorisations_changes AFTER INSERT OR DELETE OR UPDATE ON public.inspector_authorisations
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.inspector_authorisations;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.inspector_authorisations
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.inspector_authorisations;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.inspector_authorisations
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 2b. Every change of can_inspect, by any path, is written to the history. The reason and scope come from the function that made
-- the change (quoteflow.inspector_reason / quoteflow.inspector_scope, this transaction only); a change made without one (034's
-- Admin > Users tick, the SQL editor) says so.
CREATE OR REPLACE FUNCTION public.organization_members_inspector_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.can_inspect IS NOT DISTINCT FROM OLD.can_inspect THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND NOT NEW.can_inspect THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.inspector_authorisations (organization_id, user_id, change, scope, reason, changed_by)
  VALUES (NEW.organization_id, NEW.user_id, CASE WHEN NEW.can_inspect THEN 'added' ELSE 'removed' END,
          CASE WHEN NEW.can_inspect THEN nullif(btrim(current_setting('quoteflow.inspector_scope', TRUE)), '') END,
          coalesce(nullif(btrim(current_setting('quoteflow.inspector_reason', TRUE)), ''), 'No reason recorded (changed outside Admin > Inspectors)'),
          auth.uid());
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.organization_members_inspector_history() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_inspector_history ON public.organization_members;
CREATE TRIGGER zz_inspector_history AFTER INSERT OR UPDATE OF can_inspect ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.organization_members_inspector_history();

-- -----------------------------------------------------------------------------------------------------
-- 2c. Adding or removing an authorised inspector (admin only, two-step sign-in, with a reason). Returns { user_id, can_inspect }.
CREATE OR REPLACE FUNCTION public.set_authorised_inspector(p_user UUID, p_authorised BOOLEAN, p_scope TEXT, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_uid    UUID := auth.uid();
  v_reason TEXT := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_scope  TEXT := nullif(btrim(regexp_replace(coalesce(p_scope, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_member RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can choose who may record inspections.' USING ERRCODE = '42501';
  END IF;
  IF p_authorised IS NULL THEN
    RAISE EXCEPTION 'Say whether this person is to be added to the inspectors list or removed from it.' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give the reason (10 to 500 characters), for example the training or experience it rests on.' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;
  IF v_scope IS NOT NULL AND length(v_scope) > 200 THEN
    RAISE EXCEPTION 'The scope is up to 200 characters.' USING ERRCODE = '22023';
  END IF;
  SELECT m.user_id, m.role, m.secondary_role, m.active, m.support, m.can_inspect INTO v_member
  FROM public.organization_members m WHERE m.user_id = p_user AND m.organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR v_member.support THEN
    RAISE EXCEPTION 'User not found in this organisation' USING ERRCODE = 'P0002';
  END IF;
  IF v_member.can_inspect = p_authorised THEN
    RAISE EXCEPTION '%', CASE WHEN p_authorised THEN 'This person is already on the inspectors list.' ELSE 'This person is not on the inspectors list.' END
      USING ERRCODE = '22023', HINT = 'no_change';
  END IF;
  IF p_authorised AND (NOT v_member.active OR NOT ('admin' IN (v_member.role, coalesce(v_member.secondary_role, '')) OR 'office' IN (v_member.role, coalesce(v_member.secondary_role, ''))
                                                   OR 'workshop' IN (v_member.role, coalesce(v_member.secondary_role, '')))) THEN
    RAISE EXCEPTION 'Only an active admin, office or workshop member can be an inspector.' USING ERRCODE = '22023', HINT = 'not_eligible';
  END IF;

  PERFORM set_config('quoteflow.inspector_reason', v_reason, TRUE);
  PERFORM set_config('quoteflow.inspector_scope', coalesce(v_scope, ''), TRUE);
  UPDATE public.organization_members SET can_inspect = p_authorised, updated_at = now() WHERE user_id = p_user AND organization_id = v_org;
  PERFORM set_config('quoteflow.inspector_reason', '', TRUE);
  PERFORM set_config('quoteflow.inspector_scope', '', TRUE);

  PERFORM security_audit.log_named_event(v_org, 'SET_INSPECTOR', 'organization_members', p_user::TEXT,
    jsonb_build_object('can_inspect', p_authorised, 'was', v_member.can_inspect, 'scope', CASE WHEN p_authorised THEN v_scope END, 'reason', v_reason));
  RETURN jsonb_build_object('user_id', p_user, 'can_inspect', p_authorised);
END
$$;
REVOKE ALL ON FUNCTION public.set_authorised_inspector(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_authorised_inspector(UUID, BOOLEAN, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 2d. Only an authorised inspector records a pass or co-signs as the inspector, whatever function writes the row (an offline
-- replay included). Signed-in sessions only (anon, authenticated, also inside definer functions), as for the other release locks:
-- the database owner and the service role (fixtures, the SQL editor) are exempt. The member row is locked FOR SHARE, so a removal
-- and a pass in flight are ordered: whichever commits first decides.
CREATE OR REPLACE FUNCTION public.inspection_pass_authorised()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row  JSONB := to_jsonb(NEW);
  v_user UUID;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'job_inspections' THEN
    IF v_row ->> 'result' IS DISTINCT FROM 'pass' THEN
      RETURN NEW;
    END IF;
    v_user := (v_row ->> 'inspector_id')::UUID;
  ELSE
    IF v_row ->> 'kind' IS DISTINCT FROM 'inspector' THEN
      RETURN NEW;
    END IF;
    v_user := (v_row ->> 'signed_by')::UUID;
  END IF;
  PERFORM 1 FROM public.organization_members m
  WHERE m.organization_id = NEW.organization_id AND m.user_id = v_user AND m.active AND NOT m.support AND m.can_inspect
  FOR SHARE;
  IF v_user IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'Only an authorised inspector can record an inspection pass. An admin adds inspectors in Admin > Users > Inspectors.'
      USING ERRCODE = '42501', HINT = 'not_authorised_inspector';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.inspection_pass_authorised() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_inspection_pass_authorised ON public.job_inspections;
CREATE TRIGGER zz_inspection_pass_authorised BEFORE INSERT ON public.job_inspections
  FOR EACH ROW EXECUTE FUNCTION public.inspection_pass_authorised();
DROP TRIGGER IF EXISTS zz_inspection_pass_authorised ON public.job_signoffs;
CREATE TRIGGER zz_inspection_pass_authorised BEFORE INSERT ON public.job_signoffs
  FOR EACH ROW EXECUTE FUNCTION public.inspection_pass_authorised();

-- -----------------------------------------------------------------------------------------------------
-- 2e. inspect_job (081): 081's body byte for byte but for its interim check, "an admin, or someone ticked as an inspector": from 083
-- only someone on the authorised inspectors list records an inspection through it, admins included (081's admin override for
-- inspecting one's own work is unchanged: the admin is on the list). Same signature, SECURITY DEFINER, search_path and grants.
CREATE OR REPLACE FUNCTION public.inspect_job(p_job UUID, p_result TEXT, p_criteria TEXT, p_measured TEXT, p_expected_version INTEGER,
                                              p_attachment_path TEXT DEFAULT NULL, p_attachment_name TEXT DEFAULT NULL, p_concession_reason TEXT DEFAULT NULL,
                                              p_override_reason TEXT DEFAULT NULL, p_disposition TEXT DEFAULT NULL, p_failure JSONB DEFAULT NULL,
                                              p_client_op_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_user     UUID := auth.uid();
  v_criteria TEXT := nullif(btrim(p_criteria), '');
  v_measured TEXT := nullif(btrim(p_measured), '');
  v_override TEXT := nullif(btrim(p_override_reason), '');
  v_disp     TEXT := nullif(btrim(p_disposition), '');
  v_fail     JSONB := CASE WHEN p_failure IS NULL OR jsonb_typeof(p_failure) = 'null' THEN '{}'::JSONB ELSE p_failure END;
  v_job      RECORD;
  v_prior    RECORD;
  v_out      JSONB;
  v_conc     JSONB;
  v_rework   RECORD;
  v_qty      INTEGER;
  v_id       UUID;
  v_rec      RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  -- A committed record for this offline key: answer it, before any other check, and insert nothing.
  IF p_client_op_id IS NOT NULL THEN
    SELECT i.id, i.job_id, i.result, i.inspector_id, i.release_decision, i.inspected_at, i.independent INTO v_prior
    FROM public.job_inspections i WHERE i.organization_id = v_org AND i.client_op_id = p_client_op_id;
    IF FOUND THEN
      IF v_prior.job_id = p_job AND v_prior.inspector_id = v_user AND v_prior.result = p_result THEN
        RETURN jsonb_build_object('inspection_id', v_prior.id, 'result', v_prior.result, 'release_decision', v_prior.release_decision,
                                  'inspected_at', v_prior.inspected_at, 'independent', v_prior.independent, 'replayed', TRUE);
      END IF;
      RAISE EXCEPTION 'This inspection was already sent for something else, so it wasn''t recorded again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
  END IF;
  -- 083 (ISO 9001 7.2): only someone on the authorised inspectors list records an inspection, admins included.
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_user AND m.organization_id = v_org AND m.active AND NOT m.support AND m.can_inspect) THEN
    RAISE EXCEPTION 'Only an authorised inspector can record an inspection. An admin adds inspectors in Admin > Users > Inspectors.' USING ERRCODE = '42501', HINT = 'not_authorised_inspector';
  END IF;
  IF p_result IS NULL OR p_result NOT IN ('pass', 'fail', 'concession') THEN
    RAISE EXCEPTION 'The result must be pass, fail or concession.' USING ERRCODE = '22023';
  END IF;
  IF v_criteria IS NULL OR length(v_criteria) > 2000 THEN
    RAISE EXCEPTION 'Give the acceptance criteria (what it was checked against, up to 2000 characters).' USING ERRCODE = '22023', HINT = 'criteria_required';
  END IF;
  IF v_measured IS NULL OR length(v_measured) > 2000 THEN
    RAISE EXCEPTION 'Give the measured or checked result (up to 2000 characters).' USING ERRCODE = '22023', HINT = 'criteria_required';
  END IF;
  IF v_override IS NOT NULL AND (length(v_override) < 10 OR length(v_override) > 500) THEN
    RAISE EXCEPTION 'The reason for inspecting your own work must be 10 to 500 characters.' USING ERRCODE = '22023', HINT = 'override_reason';
  END IF;
  IF jsonb_typeof(v_fail) <> 'object' THEN
    RAISE EXCEPTION 'What failed must be given as an object.' USING ERRCODE = '22023';
  END IF;
  IF p_result = 'fail' THEN
    IF v_disp IS NULL OR v_disp NOT IN ('rework', 'scrap', 'concession') THEN
      RAISE EXCEPTION 'Say what happens to what failed: rework, scrap or concession.' USING ERRCODE = '22023', HINT = 'disposition_required';
    END IF;
    IF nullif(btrim(v_fail ->> 'reason'), '') IS NULL THEN
      RAISE EXCEPTION 'Say what failed.' USING ERRCODE = '22023', HINT = 'disposition_required';
    END IF;
    IF v_disp = 'concession' AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'A concession has to be authorised by an admin.' USING ERRCODE = '42501', HINT = 'concession_admin_only';
    END IF;
  ELSIF v_disp IS NOT NULL THEN
    RAISE EXCEPTION 'A disposition is only for a failed inspection.' USING ERRCODE = '22023', HINT = 'disposition_required';
  END IF;

  SELECT j.id, j.job_no, j.worksheet_version INTO v_job FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  -- The offline key again, under the job's row lock (two sends at once: the second waits, then finds the first's record).
  IF p_client_op_id IS NOT NULL THEN
    SELECT i.id, i.job_id, i.result, i.inspector_id, i.release_decision, i.inspected_at, i.independent INTO v_prior
    FROM public.job_inspections i WHERE i.organization_id = v_org AND i.client_op_id = p_client_op_id;
    IF FOUND THEN
      IF v_prior.job_id = p_job AND v_prior.inspector_id = v_user AND v_prior.result = p_result THEN
        RETURN jsonb_build_object('inspection_id', v_prior.id, 'result', v_prior.result, 'release_decision', v_prior.release_decision,
                                  'inspected_at', v_prior.inspected_at, 'independent', v_prior.independent, 'replayed', TRUE);
      END IF;
      RAISE EXCEPTION 'This inspection was already sent for something else, so it wasn''t recorded again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
  END IF;

  PERFORM set_config('quoteflow.inspection_evidence',
    jsonb_build_object('job', p_job, 'criteria', v_criteria, 'override_reason', v_override, 'disposition', v_disp, 'client_op_id', p_client_op_id)::TEXT, TRUE);
  IF p_result IN ('pass', 'concession') THEN
    v_out := public.record_job_inspection(p_job, p_result, v_measured, p_attachment_path, p_attachment_name, p_concession_reason, p_expected_version);
  ELSE
    v_out := public.fail_job_inspection(p_job, v_measured, v_fail ->> 'reason', (v_fail ->> 'quantity')::INTEGER,
               coalesce(nullif(btrim(v_fail ->> 'instructions'), ''),
                        CASE v_disp WHEN 'scrap' THEN 'Scrap the failed parts and make replacements, then send it for inspection again.'
                                    WHEN 'concession' THEN 'None: accepted on concession.'
                                    ELSE NULL END),
               p_attachment_path, p_attachment_name, CASE WHEN v_fail ? 'lines' THEN v_fail -> 'lines' END, nullif(btrim(v_fail ->> 'batch'), ''));
    IF v_disp = 'scrap' THEN
      FOR v_rework IN SELECT r.id, r.quantity_affected FROM public.job_rework r
                      WHERE r.id IN (SELECT (x #>> '{}')::UUID FROM jsonb_array_elements(v_out -> 'rework_ids') x) ORDER BY r.raised_at, r.id LOOP
        IF v_rework.quantity_affected IS NULL THEN
          RAISE EXCEPTION '% failed without a quantity, so it can''t be scrapped as a whole: say how many failed.', v_job.job_no USING ERRCODE = '22023', HINT = 'scrap_needs_quantity';
        END IF;
        v_qty := v_rework.quantity_affected;
        PERFORM public.scrap_job_quantity(v_rework.id, v_qty, v_fail ->> 'reason');
      END LOOP;
    ELSIF v_disp = 'concession' THEN
      -- The concession is its own record (034), on the job as it is now; the offline key stays on the fail record.
      PERFORM set_config('quoteflow.inspection_evidence',
        jsonb_build_object('job', p_job, 'criteria', v_criteria, 'override_reason', v_override)::TEXT, TRUE);
      v_conc := public.record_job_inspection(p_job, 'concession', v_measured, NULL, NULL, p_concession_reason,
                                             (SELECT j.worksheet_version FROM public.jobs j WHERE j.id = p_job));
      v_out := v_out || jsonb_build_object('concession', v_conc, 'release_decision', 'released');
    END IF;
  END IF;
  PERFORM set_config('quoteflow.inspection_evidence', '', TRUE);

  v_id := (v_out ->> 'inspection_id')::UUID;
  SELECT i.independent, i.override_reason, i.disposition INTO v_rec FROM public.job_inspections i WHERE i.id = v_id;
  RETURN v_out || jsonb_build_object('independent', v_rec.independent, 'not_independent_reason', v_rec.override_reason,
                                     'disposition', v_rec.disposition, 'replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.inspect_job(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspect_job(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. 8.2 / 8.5.1 The drawing revision, only where the job needs it (Rhys, Grok and ChatGPT, Tue 20 Oct). jobs.drawing_revision_required
-- (off by default: nothing changes for a job that doesn't need it) and jobs.drawing_revision (up to 20 characters). When the job
-- requires it, it can't become Complete (inspected_at set: a pass or a concession) without one. Both are set with
-- set_job_drawing_revision (below), never by a direct write from a signed-in session.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS drawing_revision_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS drawing_revision TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_drawing_revision_shape' AND conrelid = 'public.jobs'::regclass) THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_drawing_revision_shape
      CHECK (drawing_revision IS NULL OR (length(btrim(drawing_revision)) BETWEEN 1 AND 20 AND drawing_revision !~ '[[:cntrl:]]'));
  END IF;
END
$$;

-- On every job write from a signed-in session (anon, authenticated; also inside definer functions, as for the other release locks;
-- the owner and the service role are exempt): the two columns change only through set_job_drawing_revision (which names the job in
-- quoteflow.job_drawing_revision for its own statement), and a job that requires a drawing revision becomes Complete only with one.
CREATE OR REPLACE FUNCTION public.jobs_drawing_revision_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') OR TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF current_setting('quoteflow.job_drawing_revision', TRUE) IS DISTINCT FROM NEW.id::TEXT
     AND (NEW.drawing_revision IS DISTINCT FROM OLD.drawing_revision OR NEW.drawing_revision_required IS DISTINCT FROM OLD.drawing_revision_required) THEN
    RAISE EXCEPTION 'Job %: the drawing revision is set under Drawing revision on the job.', OLD.job_no USING ERRCODE = '42501', HINT = 'drawing_revision_via_rpc';
  END IF;
  IF NEW.drawing_revision_required AND nullif(btrim(NEW.drawing_revision), '') IS NULL
     AND NEW.inspected_at IS NOT NULL AND OLD.inspected_at IS NULL THEN
    RAISE EXCEPTION '% needs its drawing revision before it can be Complete: enter it under Drawing revision on the job.', OLD.job_no
      USING ERRCODE = '22023', HINT = 'drawing_revision_required';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_drawing_revision_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_zz_drawing_revision ON public.jobs;
CREATE TRIGGER jobs_zz_drawing_revision BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_drawing_revision_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3b. Setting it. Whether the job requires a drawing revision: admin and office. The revision itself: admin, office and workshop.
-- A reason (10 to 500 characters) for every change but the first revision entered and switching the requirement on. NULL leaves
-- either as it is; a revision is replaced, never cleared. Refused once
-- the job is Complete (reopen it first). A new revision counts as a worksheet change (quoteflow.drawing_revision, 034), so a pass
-- made against the old one is stale. Audited as SET_DRAWING_REVISION with the reason. Returns { job_id, drawing_revision_required,
-- drawing_revision, changed }.
CREATE OR REPLACE FUNCTION public.set_job_drawing_revision(p_job UUID, p_required BOOLEAN, p_revision TEXT, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_uid    UUID := auth.uid();
  v_rev    TEXT := nullif(btrim(p_revision), '');
  v_reason TEXT := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_job    RECORD;
  v_req    BOOLEAN;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_rev IS NOT NULL AND (length(v_rev) > 20 OR v_rev ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'The drawing revision is up to 20 characters.' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason is up to 500 characters.' USING ERRCODE = '22023';
  END IF;
  SELECT j.id, j.job_no, j.inspected_at, j.drawing_revision, j.drawing_revision_required INTO v_job
  FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  -- NULL (or blank) leaves each as it is: a revision once entered is replaced, never cleared.
  v_req := coalesce(p_required, v_job.drawing_revision_required);
  v_rev := coalesce(v_rev, v_job.drawing_revision);
  IF v_req IS NOT DISTINCT FROM v_job.drawing_revision_required AND v_rev IS NOT DISTINCT FROM v_job.drawing_revision THEN
    RETURN jsonb_build_object('job_id', p_job, 'drawing_revision_required', v_req, 'drawing_revision', v_rev, 'changed', FALSE);
  END IF;
  IF v_req IS DISTINCT FROM v_job.drawing_revision_required AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin and office staff decide whether a job needs its drawing revision.' USING ERRCODE = '42501';
  END IF;
  IF v_job.inspected_at IS NOT NULL THEN
    RAISE EXCEPTION '% is Complete: reopen it before changing its drawing revision.', v_job.job_no USING ERRCODE = '22023', HINT = 'job_complete';
  END IF;
  IF ((v_rev IS DISTINCT FROM v_job.drawing_revision AND v_job.drawing_revision IS NOT NULL) OR (v_job.drawing_revision_required AND NOT v_req))
     AND (v_reason IS NULL OR length(v_reason) < 10) THEN
    RAISE EXCEPTION 'Say why (at least 10 characters).' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;

  PERFORM set_config('quoteflow.job_drawing_revision', p_job::TEXT, TRUE);
  IF v_rev IS DISTINCT FROM v_job.drawing_revision THEN
    PERFORM set_config('quoteflow.drawing_revision', p_job::TEXT, TRUE);
  END IF;
  UPDATE public.jobs SET drawing_revision = v_rev, drawing_revision_required = v_req WHERE id = p_job AND organization_id = v_org;
  PERFORM set_config('quoteflow.drawing_revision', '', TRUE);
  PERFORM set_config('quoteflow.job_drawing_revision', '', TRUE);

  PERFORM security_audit.log_named_event(v_org, 'SET_DRAWING_REVISION', 'jobs', p_job::TEXT,
    jsonb_build_object('job_no', v_job.job_no, 'drawing_revision', v_rev, 'was', v_job.drawing_revision,
                       'drawing_revision_required', v_req, 'was_required', v_job.drawing_revision_required, 'reason', v_reason));
  RETURN jsonb_build_object('job_id', p_job, 'drawing_revision_required', v_req, 'drawing_revision', v_rev, 'changed', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public.set_job_drawing_revision(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_job_drawing_revision(UUID, BOOLEAN, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. Backfill (safe to run again): the list starts as everyone who could record a pass before 083.
-- 4a. Members already ticked as inspectors get their history row (when they were ticked isn't known: the row says so).
INSERT INTO public.inspector_authorisations (organization_id, user_id, change, reason, changed_by)
SELECT m.organization_id, m.user_id, 'added', 'Already an inspector before 083 (ticked on Admin > Users); date not recorded', NULL
FROM public.organization_members m
WHERE m.can_inspect
  AND NOT EXISTS (SELECT 1 FROM public.inspector_authorisations a WHERE a.organization_id = m.organization_id AND a.user_id = m.user_id);
-- 4b. Active admins (not support access) could always record inspections: they are put on the list (the trigger writes the history).
DO $$
BEGIN
  PERFORM set_config('quoteflow.inspector_reason', 'Admin before 083: admins could always record inspections', TRUE);
  UPDATE public.organization_members m SET can_inspect = TRUE, updated_at = now()
  WHERE m.active AND NOT m.support AND NOT m.can_inspect AND 'admin' IN (m.role, coalesce(m.secondary_role, ''));
  PERFORM set_config('quoteflow.inspector_reason', '', TRUE);
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check before COMMIT (the same checks as supabase/verify/authorised_inspectors_083.sql).
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
                 AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_authorised_inspector(uuid,boolean,text,text)')) THEN
    RAISE EXCEPTION '083: set_authorised_inspector is not a signed-in-only definer function';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.iso_083_record_immutable()', 'public.organization_members_inspector_history()', 'public.inspection_pass_authorised()'] LOOP
    IF has_function_privilege('anon', to_regprocedure(v_fn), 'EXECUTE') OR has_function_privilege('authenticated', to_regprocedure(v_fn), 'EXECUTE') THEN
      RAISE EXCEPTION '083: % is callable from the API', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.set_job_drawing_revision(uuid,boolean,text,text)', 'public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)'] LOOP
    IF NOT (SELECT p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) THEN
      RAISE EXCEPTION '083: % is not a signed-in-only definer function', v_fn;
    END IF;
  END LOOP;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)')) IS DISTINCT FROM 'b411b17ef7cb8a5f3700957d9a7a264f' THEN
    RAISE EXCEPTION '083: inspect_job is not 083''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.jobs_drawing_revision_guard()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.jobs_drawing_revision_guard()'::regprocedure, 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'jobs_zz_drawing_revision' AND t.tgrelid = 'public.jobs'::regclass) THEN
    RAISE EXCEPTION '083: the drawing revision check is missing or callable from the API';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.inspector_authorisations'::regclass)
     OR has_table_privilege('authenticated', 'public.inspector_authorisations', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.inspector_authorisations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '083: inspector_authorisations has RLS off or an API write grant';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'zz_inspection_pass_authorised'
        AND t.tgrelid IN ('public.job_inspections'::regclass, 'public.job_signoffs'::regclass)) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'zz_inspector_history' AND t.tgrelid = 'public.organization_members'::regclass) THEN
    RAISE EXCEPTION '083: a trigger is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_members m WHERE m.active AND NOT m.support AND NOT m.can_inspect AND 'admin' IN (m.role, coalesce(m.secondary_role, '')))
     OR EXISTS (SELECT 1 FROM public.organization_members m WHERE m.can_inspect
                AND NOT EXISTS (SELECT 1 FROM public.inspector_authorisations a WHERE a.organization_id = m.organization_id AND a.user_id = m.user_id AND a.change = 'added')) THEN
    RAISE EXCEPTION '083: the inspectors backfill is incomplete';
  END IF;
END
$$;

COMMIT;
