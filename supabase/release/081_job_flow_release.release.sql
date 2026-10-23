-- 081_job_flow_release.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 081: the job flow and its release (ISO 9001 8.6 release, 8.7 nonconformance, independent inspection) (Rhys, with Grok and ChatGPT).
-- Needs 034 (job_inspections, record_job_inspection), 035 (jobs.finished_by, actor_stamp's reopen), 037 (rework, job_release_state),
-- 044/061 (finish_job) and 059 (the automatic draft from a delivery note). Independent of 075 to 080 (touches none of their objects).
--
-- THE FLOW. A job is In progress, then Finished (work done, awaiting inspection; the board's "Are you sure?" Finish stays), then
-- Complete (inspection passed). There is no "Done". public.flow_status(job) works the status out from the job's own row, so it can
-- never disagree with it (no stored copy; PostgREST reads it as the computed field flow_status of a job): 'complete' when
-- inspected_at is set (a pass, or an admin's concession) and the job is not in rework, 'finished' when finished_at is set,
-- 'in_progress' otherwise; a job in the rework stage (a failed inspection, or replacements to make) is 'in_progress' with the
-- "put back" flag (stage = 'rework'). Existing jobs map the same way, with no backfill: Done on the
-- board (inspected) is Complete, Awaiting inspection is Finished, Rework is In progress put back, the rest In progress.
--
-- WHAT CHANGES.
-- 1. Finish is recorded once. finished_at and finished_by (035) are kept: a browser role can't clear or move a finish time
--    (jobs_finish_kept); only reopen_job can clear it.
-- 2. reopen_job(job, reason): the person who finished the job undoes their own Finish while it awaits inspection; the office or an
--    admin reopens anyone's, also a Complete job (its pass is voided). A reason of at least 10 characters. Refused once a delivery
--    note for the job has gone out or its invoice has been issued (record a failed inspection instead). The finish time, the
--    sign-off and the stage go back as 035 already does it (actor_stamp: finished_by and the inspection sign-off cleared, the stage back
--    to machining, REOPEN); machine time, bookings and signatures are kept.
-- 3. Every move of the flow is a row of public.job_flow_events (finish, reopen with its reason, put_back, complete, pass_voided,
--    early_release): who, when, why, which inspection. Written by a trigger on jobs (and by release_job_early), never changed or
--    removed (also not by the service role); readable by everyone in the company; audited row by row.
-- 4. Inspection evidence and independence (job_inspections, the existing record, written once): acceptance_criteria, independent,
--    override_reason, disposition, disposition_by, finisher_ids and client_op_id, filled by job_inspections_evidence when the record is
--    written. A pass or a concession needs the acceptance criteria and the measured / checked result; the person who finished the job
--    (jobs.finished_by, or the finisher of a rework this pass closes) can't record it, unless an admin overrides with a reason of at
--    least 10 characters: the admin is the inspector as usual, and the record keeps independent = FALSE and the reason. Enforced on
--    the record itself, so every path (inspect_job, the older record_job_inspection, an offline replay) obeys it. Every inspection
--    record is immutable from now on (job_inspections_immutable), and audited row by row.
-- 5. inspect_job(...): the inspection screen's one call (online and offline replay, keyed by client_op_id: a replay answers the first
--    record). pass / concession through record_job_inspection (034/037, unchanged); fail through fail_job_inspection (037, unchanged)
--    with a disposition (8.7): rework (the rework opens), scrap (the failed quantity is scrapped; replacements are made, then inspected
--    again) or concession (an admin only: the fail is recorded, then the concession releases it). The disposition and who authorised
--    it are on the fail record. A failed job is put back to In progress (stage rework); a new inspection is needed before Complete.
-- 6. Release (8.6). job_release_state (037's body but for one line): released only when the job is Complete, or an admin released it
--    early with a reason (release_job_early; voided by a later reopen or failure, or a worksheet change). A part failure no longer
--    releases the rest by itself. Delivery note creation and despatch read it (create_delivery_note and delivery_notes_link_guard,
--    unchanged), and delivery_notes_release_gate also checks a hand-made note naming the job (job_ref) or its sales order. Passing an
--    inspection doesn't release anything by itself: a person makes and sends the delivery note.
-- 7. Invoicing. When a job is finished (a signed-in person, as 059 drafts), one DRAFT invoice is made for it from its sales order's
--    lines (no number; "Draft, awaiting inspection" on screen; nothing for an internal job, a job without an order, or a job that
--    already has a live invoice). It can be issued (numbered) only once the job is released (invoices_issue_after_release).
--    delivery_note_try_draft (059's body but for one step): a note whose job already has its invoice goes on that invoice instead of
--    getting a draft of its own; invoices_one_draft_per_job refuses a second draft for one job from any path.
-- 8. Grants as tight as before: the new tables are read-only to signed-in members of the company (RLS), written only by definer
--    code; the new API functions are for signed-in users only (each starts with assert_privileged_aal); the helpers are internal.
--
-- GUARD (section 1): job_release_state must be 037's (or already 081's) and delivery_note_try_draft 059's (or already 081's), compared
-- by md5 with every whitespace character removed (a CRLF paste matches); anything else stops the release and nothing of 081 is kept.
-- SELF-CHECK (last section): the bodies are 081's, the triggers are in place, the grants are as stated.
-- Rollback: supabase/release/081_job_flow_release.rollback.sql (only with Rhys's approval).
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- 1. The guard.
DO $$
DECLARE
  v_rs TEXT;
  v_td TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_rs FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_release_state(uuid)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_td FROM pg_proc p WHERE p.oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)');
  -- a7454c7d...: 037's job_release_state; c16ea537b0b5706ab6db6e160214e17d: this file's. ef7acce2...: 059's delivery_note_try_draft;
  -- 52a9771fec832f0e20e9d780e7561caa: this file's. All with every whitespace character removed.
  IF v_rs IS NULL OR v_rs NOT IN ('a7454c7da7ee23564436acfa6a330cd6', 'c16ea537b0b5706ab6db6e160214e17d') THEN
    RAISE EXCEPTION '081: public.job_release_state is not 037''s (md5 without whitespace %); stop and compare it first', coalesce(v_rs, 'missing');
  END IF;
  IF v_td IS NULL OR v_td NOT IN ('ef7acce200b6f0349c84f076725d77c1', '52a9771fec832f0e20e9d780e7561caa') THEN
    RAISE EXCEPTION '081: public.delivery_note_try_draft is not 059''s (md5 without whitespace %); stop and compare it first', coalesce(v_td, 'missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'finished_by')
     OR to_regprocedure('public.actor_stamp()') IS NULL OR to_regprocedure('public.finish_job(uuid,uuid,timestamptz)') IS NULL
     OR to_regclass('public.job_rework') IS NULL OR to_regclass('public.invoice_queue_events') IS NULL
     OR to_regprocedure('public.record_job_inspection(uuid,text,text,text,text,text,integer)') IS NULL
     OR to_regprocedure('public.fail_job_inspection(uuid,text,text,integer,text,text,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '081: needs 035, 037, 044/061 and 059 applied first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The job's flow status, worked out from its own row (nothing stored: existing jobs read the same way at once). A plain function of
-- the row, not a stored generated column: the triggers on jobs compare the whole row before and after (to_jsonb), and a generated
-- column reads empty there. Any signed-in member may call it (it reads only the row it is given, under the caller's own row rules).
CREATE OR REPLACE FUNCTION public.flow_status(p_job public.jobs)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p_job.stage IS NOT DISTINCT FROM 'rework' THEN 'in_progress'
              WHEN p_job.inspected_at IS NOT NULL THEN 'complete'
              WHEN p_job.finished_at IS NOT NULL THEN 'finished'
              ELSE 'in_progress' END
$$;
REVOKE ALL ON FUNCTION public.flow_status(public.jobs) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flow_status(public.jobs) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. The inspection record's evidence, independence and disposition (written once, with the record).
ALTER TABLE public.job_inspections ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT;
ALTER TABLE public.job_inspections ADD COLUMN IF NOT EXISTS independent BOOLEAN;
ALTER TABLE public.job_inspections ADD COLUMN IF NOT EXISTS override_reason TEXT;
ALTER TABLE public.job_inspections ADD COLUMN IF NOT EXISTS disposition TEXT;
ALTER TABLE public.job_inspections ADD COLUMN IF NOT EXISTS disposition_by UUID;
ALTER TABLE public.job_inspections ADD COLUMN IF NOT EXISTS finisher_ids UUID[];
ALTER TABLE public.job_inspections ADD COLUMN IF NOT EXISTS client_op_id UUID;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_inspections_criteria_shape' AND conrelid = 'public.job_inspections'::regclass) THEN
    ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_criteria_shape
      CHECK (acceptance_criteria IS NULL OR length(btrim(acceptance_criteria)) BETWEEN 1 AND 2000);
  END IF;
  -- Not independent always carries its reason (at least 10 characters); a reason only with not independent.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_inspections_override_has_reason' AND conrelid = 'public.job_inspections'::regclass) THEN
    ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_override_has_reason
      CHECK ((independent IS NOT DISTINCT FROM FALSE) = (override_reason IS NOT NULL)
             AND (override_reason IS NULL OR length(btrim(override_reason)) BETWEEN 10 AND 500));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_inspections_disposition_shape' AND conrelid = 'public.job_inspections'::regclass) THEN
    ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_disposition_shape
      CHECK ((disposition IS NULL OR (result = 'fail' AND disposition IN ('rework', 'scrap', 'concession')))
             AND (disposition IS NULL) = (disposition_by IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_inspections_client_op' AND conrelid = 'public.job_inspections'::regclass) THEN
    ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_client_op UNIQUE (organization_id, client_op_id);
  END IF;
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- 4. The flow's history: one row per move, never changed or removed. Jobs are never deleted (028: archive), so job_id is RESTRICT;
-- actor_user_id is a plain UUID (no foreign key), so removing a user never rewrites the record.
CREATE TABLE IF NOT EXISTS public.job_flow_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  job_id            UUID NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (kind IN ('finish', 'reopen', 'put_back', 'complete', 'pass_voided', 'early_release')),
  actor_user_id     UUID,
  actor_name        TEXT CHECK (actor_name IS NULL OR (length(btrim(actor_name)) BETWEEN 1 AND 100 AND position('@' IN actor_name) = 0)),
  reason            TEXT CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  inspection_id     UUID REFERENCES public.job_inspections(id) ON DELETE RESTRICT,
  worksheet_version INTEGER,
  detail            JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(detail) = 'object'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A reopen and an early release by a signed-in person always say why (a maintenance change has no person and no reason).
  CONSTRAINT job_flow_events_reason_given CHECK (kind NOT IN ('reopen', 'early_release') OR actor_user_id IS NULL OR length(btrim(coalesce(reason, ''))) >= 10)
);
CREATE INDEX IF NOT EXISTS idx_job_flow_events_job ON public.job_flow_events (job_id, seq);
CREATE INDEX IF NOT EXISTS idx_job_flow_events_org ON public.job_flow_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_flow_events_inspection ON public.job_flow_events (inspection_id) WHERE inspection_id IS NOT NULL;

ALTER TABLE public.job_flow_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_flow_events rbac select" ON public.job_flow_events;
CREATE POLICY "job_flow_events rbac select" ON public.job_flow_events FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
REVOKE ALL ON public.job_flow_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_flow_events TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_flow_events;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_flow_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS zz_same_org_inspection_id ON public.job_flow_events;
CREATE TRIGGER zz_same_org_inspection_id BEFORE INSERT OR UPDATE ON public.job_flow_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('job_inspections', 'inspection_id');
DROP TRIGGER IF EXISTS audit_job_flow_events_changes ON public.job_flow_events;
CREATE TRIGGER audit_job_flow_events_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_flow_events
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.job_flow_events;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.job_flow_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.job_flow_events;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.job_flow_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- Never changed or removed, by anyone (the definer code, the service role and the SQL editor included).
CREATE OR REPLACE FUNCTION public.job_flow_events_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'The job''s history is a record: it is never changed or removed.' USING ERRCODE = '42501', HINT = 'record_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.job_flow_events_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_flow_events_immutable ON public.job_flow_events;
CREATE TRIGGER job_flow_events_immutable BEFORE UPDATE OR DELETE ON public.job_flow_events
  FOR EACH ROW EXECUTE FUNCTION public.job_flow_events_immutable();
DROP TRIGGER IF EXISTS job_flow_events_no_truncate ON public.job_flow_events;
CREATE TRIGGER job_flow_events_no_truncate BEFORE TRUNCATE ON public.job_flow_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_flow_events_immutable();

-- -----------------------------------------------------------------------------------------------------
-- 5. Every inspection record is immutable and audited. The one change let through is the foreign key's own: removing a user
-- empties inspector_id (034's ON DELETE SET NULL); the record keeps the inspector's name.
CREATE OR REPLACE FUNCTION public.job_inspections_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.inspector_id IS NULL AND OLD.inspector_id IS NOT NULL
     AND (to_jsonb(NEW) - 'inspector_id') = (to_jsonb(OLD) - 'inspector_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An inspection is a record: it is never changed or removed. Record a new inspection instead.' USING ERRCODE = '42501', HINT = 'record_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.job_inspections_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_inspections_immutable ON public.job_inspections;
CREATE TRIGGER job_inspections_immutable BEFORE UPDATE OR DELETE ON public.job_inspections
  FOR EACH ROW EXECUTE FUNCTION public.job_inspections_immutable();
DROP TRIGGER IF EXISTS job_inspections_no_truncate ON public.job_inspections;
CREATE TRIGGER job_inspections_no_truncate BEFORE TRUNCATE ON public.job_inspections
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_inspections_immutable();
DROP TRIGGER IF EXISTS audit_job_inspections_changes ON public.job_inspections;
CREATE TRIGGER audit_job_inspections_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_inspections
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- -----------------------------------------------------------------------------------------------------
-- 6. The evidence, the independence check and the disposition, on the record itself, for the browser roles (anon, authenticated:
-- every definer function a signed-in person calls). The service role, the owner and the SQL editor are exempt (their rows are kept as
-- given). inspect_job passes what the screen sent in the transaction-local setting quoteflow.inspection_evidence, naming the job;
-- an older screen sends nothing, so its pass is refused (criteria_required) and its fail is recorded as before (no disposition).
CREATE OR REPLACE FUNCTION public.job_inspections_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_raw       TEXT := nullif(current_setting('quoteflow.inspection_evidence', TRUE), '');
  v_ev        JSONB;
  v_finished  UUID;
  v_job_no    TEXT;
  v_finishers UUID[];
  v_override  TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF v_raw IS NOT NULL THEN
    v_ev := v_raw::JSONB;
    IF v_ev ->> 'job' IS DISTINCT FROM NEW.job_id::TEXT THEN
      v_ev := NULL;
    END IF;
  END IF;
  SELECT j.finished_by, j.job_no INTO v_finished, v_job_no FROM public.jobs j WHERE j.id = NEW.job_id;
  -- Who finished it: the Finish (035's finished_by), and whoever finished a rework this inspection decides (awaiting re-inspection).
  v_finishers := array_remove(ARRAY[v_finished]
                   || ARRAY(SELECT r.finished_by FROM public.job_rework r WHERE r.job_id = NEW.job_id AND r.status = 'finished' AND r.finished_by IS NOT NULL
                            ORDER BY r.finished_at), NULL);
  NEW.finisher_ids := (SELECT array_agg(DISTINCT f) FROM unnest(v_finishers) f);
  NEW.acceptance_criteria := nullif(btrim(v_ev ->> 'criteria'), '');
  NEW.client_op_id := nullif(v_ev ->> 'client_op_id', '')::UUID;
  NEW.disposition := CASE WHEN NEW.result = 'fail' THEN nullif(v_ev ->> 'disposition', '') END;
  NEW.disposition_by := CASE WHEN NEW.disposition IS NOT NULL THEN v_uid END;
  NEW.independent := NULL;
  NEW.override_reason := NULL;
  IF NEW.acceptance_criteria IS NOT NULL AND length(NEW.acceptance_criteria) > 2000 THEN
    RAISE EXCEPTION 'The acceptance criteria are at most 2000 characters.' USING ERRCODE = '22023', HINT = 'criteria_required';
  END IF;
  IF NEW.result IN ('pass', 'concession') THEN
    IF NEW.acceptance_criteria IS NULL THEN
      RAISE EXCEPTION '%: record the acceptance criteria and the measured or checked result before it can pass. If this screen has no box for the criteria, update Tolra.', v_job_no
        USING ERRCODE = '22023', HINT = 'criteria_required';
    END IF;
    IF v_uid IS NOT NULL AND v_uid = ANY (v_finishers) THEN
      v_override := nullif(btrim(v_ev ->> 'override_reason'), '');
      IF NOT public.has_org_role(ARRAY['admin']) THEN
        RAISE EXCEPTION 'You finished %, so someone else must inspect it: the person who finished a job can''t record its pass.', v_job_no
          USING ERRCODE = '42501', HINT = 'not_independent';
      END IF;
      IF v_override IS NULL THEN
        RAISE EXCEPTION 'You finished %, so its pass isn''t independent. As an admin you can still record it: give the reason (at least 10 characters).', v_job_no
          USING ERRCODE = '42501', HINT = 'not_independent';
      END IF;
      IF length(v_override) < 10 OR length(v_override) > 500 THEN
        RAISE EXCEPTION 'The reason for inspecting your own work must be 10 to 500 characters.' USING ERRCODE = '22023', HINT = 'override_reason';
      END IF;
      NEW.independent := FALSE;
      NEW.override_reason := v_override;
    ELSE
      -- Unknown when nobody is recorded as having finished it (a job finished before 035, by an import or by maintenance).
      NEW.independent := CASE WHEN cardinality(v_finishers) = 0 THEN NULL ELSE TRUE END;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.job_inspections_evidence() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_inspections_evidence ON public.job_inspections;
CREATE TRIGGER job_inspections_evidence BEFORE INSERT ON public.job_inspections
  FOR EACH ROW EXECUTE FUNCTION public.job_inspections_evidence();

-- -----------------------------------------------------------------------------------------------------
-- 7. A Finish is recorded once (browser roles; the service role, the owner and the SQL editor are exempt as for the other locks): a
-- finish time is never cleared or moved by editing the job. reopen_job (section 11) names the job in quoteflow.job_reopen for its own
-- statement, and may only clear it.
CREATE OR REPLACE FUNCTION public.jobs_finish_kept()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reopen BOOLEAN := current_setting('quoteflow.job_reopen', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at AND NOT (v_reopen AND NEW.finished_at IS NULL) THEN
    RAISE EXCEPTION 'Job %: its finish is kept as it was recorded. To undo a Finish, reopen the job and say why.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'reopen_required';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_finish_kept() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ad_finish_kept ON public.jobs;
CREATE TRIGGER ad_finish_kept BEFORE UPDATE OF finished_at ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_finish_kept();

-- -----------------------------------------------------------------------------------------------------
-- 8. An admin's early release (8.6), still in force: the job's latest early release, made on the worksheet revision the job is on now,
-- with no reopen or failed inspection since. Internal (no API role).
CREATE OR REPLACE FUNCTION public.job_early_release_active(p_job UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.job_flow_events e JOIN public.jobs j ON j.id = e.job_id
    WHERE e.job_id = p_job AND e.kind = 'early_release' AND e.worksheet_version IS NOT DISTINCT FROM j.worksheet_version
      AND NOT EXISTS (SELECT 1 FROM public.job_flow_events v WHERE v.job_id = p_job AND v.kind IN ('reopen', 'put_back') AND v.seq > e.seq))
$$;
REVOKE ALL ON FUNCTION public.job_early_release_active(UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 9. The draft invoice made when a job is finished (internal; never raises: everything it does is undone on an error, which is
-- recorded as a JOB_DRAFT_INVOICE event, and the Finish goes on). One per job: nothing for an internal job, a job without a sales
-- order, an order with no priced lines, or a job that already has a live invoice (a draft, or any not void). At the order's prices
-- and VAT, for the order's full quantities, as 059 drafts from a delivery note; dated today in UK time with the company's default
-- terms. No number until it is issued.
CREATE OR REPLACE FUNCTION public.job_finish_draft_invoice(p_job UUID, p_org UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job     RECORD;
  v_order   UUID;
  v_so      RECORD;
  v_vat_on  BOOLEAN;
  v_lines   JSONB;
  v_net     NUMERIC;
  v_vat     NUMERIC;
  v_first   RECORD;
  v_terms   TEXT;
  v_days    INT;
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_invoice UUID;
  v_state   TEXT;
  v_msg     TEXT;
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM public.current_user_organization_id() THEN
    RETURN 'not_authorised';
  END IF;
  BEGIN
    SELECT j.id, j.job_no, j.is_internal, j.converted_from_sales_order_id INTO v_job FROM public.jobs j WHERE j.id = p_job AND j.organization_id = p_org;
    IF NOT FOUND THEN
      RETURN 'not_found';
    END IF;
    IF v_job.is_internal THEN
      RETURN 'internal-job';
    END IF;
    v_order := v_job.converted_from_sales_order_id;
    IF v_order IS NULL THEN
      SELECT s.id INTO v_order FROM public.sales_orders s WHERE s.converted_to_job_id = p_job AND s.organization_id = p_org ORDER BY s.created_at, s.id LIMIT 1;
    END IF;
    IF v_order IS NULL THEN
      RETURN 'no-order';
    END IF;
    -- One draft per job: the same key as invoices_one_draft_per_job, so two at once wait for each other.
    PERFORM pg_advisory_xact_lock(hashtextextended('job-invoice:' || p_job::TEXT, 0));
    IF EXISTS (SELECT 1 FROM public.invoices i WHERE i.job_id = p_job AND i.organization_id = p_org
                 AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')) THEN
      RETURN 'invoiced';
    END IF;
    -- The order's lines (made when first needed, 034; lines already there are used as they are).
    IF NOT EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.sales_order_id = v_order AND l.organization_id = p_org) THEN
      PERFORM public.ensure_sales_order_lines(v_order);
    END IF;
    SELECT s.id, s.customer, s.quote_ref, s.customer_po, s.vat_enabled INTO v_so FROM public.sales_orders s WHERE s.id = v_order AND s.organization_id = p_org;
    v_vat_on := coalesce(v_so.vat_enabled, FALSE) AND public.org_vat_registered(p_org);
    SELECT jsonb_agg(jsonb_build_object('position', g.n - 1, 'description', g.description, 'quantity', g.quantity, 'unit_price', g.unit_price,
                                        'vat_pct', g.vat_pct, 'vat_exempt', g.vat_exempt) ORDER BY g.n),
           coalesce(sum(round(g.quantity * g.unit_price, 2)), 0),
           coalesce(sum(CASE WHEN g.vat_exempt THEN 0 ELSE round(round(g.quantity * g.unit_price, 2) * g.vat_pct / 100, 2) END), 0)
      INTO v_lines, v_net, v_vat
    FROM (SELECT row_number() OVER (ORDER BY l.position, l.id) AS n, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt
          FROM public.sales_order_lines l WHERE l.sales_order_id = v_order AND l.organization_id = p_org AND l.quantity > 0) g;
    IF v_lines IS NULL THEN
      RETURN 'no-lines';
    END IF;
    v_vat := CASE WHEN v_vat_on THEN v_vat ELSE 0 END;
    SELECT l.description, l.quantity, l.unit_price INTO v_first
    FROM public.sales_order_lines l WHERE l.sales_order_id = v_order AND l.organization_id = p_org AND l.quantity > 0 ORDER BY l.position, l.id LIMIT 1;

    SELECT coalesce(nullif(btrim(s.company_profile ->> 'defaultInvoiceTerms'), ''), '30 days') INTO v_terms
    FROM public.organization_settings s WHERE s.organization_id = p_org;
    v_terms := left(coalesce(v_terms, '30 days'), 200);
    v_days := CASE WHEN v_terms ~* 'receipt' THEN 0 ELSE coalesce(least(substring(v_terms FROM '(\d{1,4})')::INT, 366), 30) END;

    v_invoice := public.create_with_lines(
      'invoices',
      jsonb_strip_nulls(jsonb_build_object(
        'customer', v_so.customer, 'description', v_first.description, 'quantity', v_first.quantity, 'unit_price', v_first.unit_price,
        'subtotal', v_net, 'carriage', 0, 'vat', v_vat, 'total', v_net + v_vat, 'vat_enabled', v_vat_on, 'carriage_vat', v_vat_on,
        'invoice_date', v_today, 'due_date', v_today + v_days, 'terms', v_terms,
        'quote_ref', v_so.quote_ref, 'customer_po', v_so.customer_po, 'job_id', p_job, 'status', 'draft', 'amount_paid', 0)),
      'invoice_line_items', 'invoice_id', v_lines);
    PERFORM security_audit.log_named_event(p_org, 'JOB_DRAFT_INVOICE', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'outcome', 'drafted', 'invoice_id', v_invoice, 'sales_order_id', v_order));
    RETURN 'drafted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM security_audit.log_named_event(p_org, 'JOB_DRAFT_INVOICE', 'jobs', p_job::TEXT,
      jsonb_build_object('outcome', 'failed', 'error_code', v_state, 'error_message', left(coalesce(nullif(v_msg, ''), 'unknown error'), 500)));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '081: the draft invoice for job % failed (%: %) and the failure could not be recorded', p_job, v_state, v_msg;
  END;
  RETURN 'failed';
END
$$;
REVOKE ALL ON FUNCTION public.job_finish_draft_invoice(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 10. The flow's history, written after each change of a job's finish, inspection or stage (any role: a maintenance change is
-- recorded with no person). On a Finish by a signed-in person the job's draft invoice is made (section 9).
CREATE OR REPLACE FUNCTION public.jobs_flow_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_name   TEXT;
  v_api    BOOLEAN := coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) = 'authenticated' AND auth.uid() IS NOT NULL;
  v_insp   RECORD;
  v_cause  TEXT;
BEGIN
  IF OLD.finished_at IS NOT DISTINCT FROM NEW.finished_at AND OLD.inspected_at IS NOT DISTINCT FROM NEW.inspected_at AND OLD.stage IS NOT DISTINCT FROM NEW.stage THEN
    RETURN NULL;
  END IF;
  IF v_uid IS NOT NULL THEN
    SELECT nullif(btrim(regexp_replace(coalesce(p.full_name, ''), '[[:cntrl:]]+', ' ', 'g')), '') INTO v_name FROM public.user_profiles p WHERE p.id = v_uid;
    IF v_name IS NULL OR position('@' IN v_name) > 0 THEN
      v_name := NULL;
    END IF;
    v_name := left(v_name, 100);
  END IF;

  IF OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL THEN
    INSERT INTO public.job_flow_events (organization_id, job_id, kind, actor_user_id, actor_name, worksheet_version, detail)
    VALUES (NEW.organization_id, NEW.id, 'finish', v_uid, v_name, NEW.worksheet_version, jsonb_build_object('finished_at', NEW.finished_at));
    IF v_api THEN
      PERFORM public.job_finish_draft_invoice(NEW.id, NEW.organization_id);
    END IF;
  ELSIF OLD.finished_at IS NOT NULL AND NEW.finished_at IS NULL THEN
    INSERT INTO public.job_flow_events (organization_id, job_id, kind, actor_user_id, actor_name, reason, worksheet_version, detail)
    VALUES (NEW.organization_id, NEW.id, 'reopen', v_uid, v_name,
            CASE WHEN current_setting('quoteflow.job_reopen', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT THEN nullif(current_setting('quoteflow.job_reopen_reason', TRUE), '') END,
            NEW.worksheet_version, jsonb_build_object('previous_finished_at', OLD.finished_at, 'previous_finished_by', OLD.finished_by, 'was', public.flow_status(OLD)));
  END IF;

  -- Put back: the job goes into the rework stage (a failed inspection, or replacements still to make).
  IF OLD.stage IS DISTINCT FROM 'rework' AND NEW.stage IS NOT DISTINCT FROM 'rework' THEN
    SELECT i.id, i.disposition INTO v_insp FROM public.job_inspections i WHERE i.job_id = NEW.id AND i.result = 'fail' ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1;
    INSERT INTO public.job_flow_events (organization_id, job_id, kind, actor_user_id, actor_name, inspection_id, worksheet_version, detail)
    VALUES (NEW.organization_id, NEW.id, 'put_back', v_uid, v_name, v_insp.id, NEW.worksheet_version,
            jsonb_build_object('disposition', v_insp.disposition, 'replacements', current_setting('quoteflow.job_inspection', TRUE) IS DISTINCT FROM NEW.id::TEXT));
  ELSIF OLD.stage IS NOT DISTINCT FROM 'rework' AND NEW.stage IS DISTINCT FROM 'rework' AND NEW.inspected_at IS NULL AND NEW.finished_at IS NOT NULL THEN
    -- The rework is finished: the job is Finished again, awaiting its new inspection.
    INSERT INTO public.job_flow_events (organization_id, job_id, kind, actor_user_id, actor_name, worksheet_version, detail)
    VALUES (NEW.organization_id, NEW.id, 'finish', v_uid, v_name, NEW.worksheet_version, jsonb_build_object('after_rework', TRUE));
  END IF;

  IF OLD.inspected_at IS NULL AND NEW.inspected_at IS NOT NULL THEN
    SELECT i.id, i.result, i.independent, i.override_reason INTO v_insp FROM public.job_inspections i
    WHERE i.job_id = NEW.id AND i.result IN ('pass', 'concession') ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1;
    INSERT INTO public.job_flow_events (organization_id, job_id, kind, actor_user_id, actor_name, inspection_id, reason, worksheet_version, detail)
    VALUES (NEW.organization_id, NEW.id, 'complete', v_uid, v_name, v_insp.id, v_insp.override_reason, NEW.worksheet_version,
            jsonb_build_object('result', v_insp.result, 'independent', v_insp.independent));
  ELSIF OLD.inspected_at IS NOT NULL AND NEW.inspected_at IS NULL THEN
    SELECT i.id INTO v_insp FROM public.job_inspections i
    WHERE i.job_id = NEW.id AND i.result IN ('pass', 'concession') ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1;
    v_cause := CASE WHEN NEW.finished_at IS NULL THEN 'reopened'
                    WHEN NEW.stage IS NOT DISTINCT FROM 'rework' THEN 'failed_or_replacements'
                    WHEN NEW.worksheet_version IS DISTINCT FROM OLD.worksheet_version THEN 'worksheet_changed'
                    ELSE 'withdrawn' END;
    INSERT INTO public.job_flow_events (organization_id, job_id, kind, actor_user_id, actor_name, inspection_id, worksheet_version, detail)
    VALUES (NEW.organization_id, NEW.id, 'pass_voided', v_uid, v_name, v_insp.id, NEW.worksheet_version, jsonb_build_object('cause', v_cause));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_flow_log() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_jobs_flow_log ON public.jobs;
-- No WHEN clause: the function returns at once when nothing of the flow moved (a WHEN naming the columns would tie them to the trigger).
CREATE TRIGGER zz_jobs_flow_log AFTER UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_flow_log();

-- -----------------------------------------------------------------------------------------------------
-- 11. Reopen (who, when, why). Returns { job_id, job_no, reopened, was_complete, voided_inspection_id }.
CREATE OR REPLACE FUNCTION public.reopen_job(p_job UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_reason TEXT := nullif(btrim(p_reason), '');
  v_office BOOLEAN;
  v_job    RECORD;
  v_dn     TEXT;
  v_inv    TEXT;
  v_voided UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Say why the job is reopened (10 to 500 characters).' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;
  v_office := public.has_org_role(ARRAY['admin', 'office']);
  SELECT j.id, j.job_no, j.finished_at, j.finished_by, j.inspected_at, j.stage INTO v_job
  FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.finished_at IS NULL THEN
    RAISE EXCEPTION '% isn''t finished, so there is nothing to reopen.', v_job.job_no USING ERRCODE = '22023', HINT = 'not_finished';
  END IF;
  IF v_job.stage IS NOT DISTINCT FROM 'rework' THEN
    RAISE EXCEPTION '% is already back in progress for rework: finish the rework instead.', v_job.job_no USING ERRCODE = '22023', HINT = 'in_rework';
  END IF;
  IF v_job.inspected_at IS NOT NULL AND NOT v_office THEN
    RAISE EXCEPTION '% has passed inspection: only the office or an admin can reopen it.', v_job.job_no USING ERRCODE = '42501', HINT = 'reopen_not_allowed';
  END IF;
  IF NOT v_office AND v_job.finished_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION '% was finished by someone else: ask the office or an admin to reopen it.', v_job.job_no USING ERRCODE = '42501', HINT = 'reopen_not_allowed';
  END IF;
  SELECT string_agg(d.dn_number, ', ' ORDER BY d.dn_number) INTO v_dn FROM public.delivery_notes d
  WHERE d.organization_id = v_org AND d.status IN ('despatched', 'delivered', 'signed')
    AND (d.job_id = p_job OR (d.job_id IS NULL AND nullif(btrim(d.job_ref), '') = v_job.job_no));
  IF v_dn IS NOT NULL THEN
    RAISE EXCEPTION '% has gone out (%), so it can''t be reopened. If something is wrong with it, record a failed inspection.', v_job.job_no, v_dn
      USING ERRCODE = '22023', HINT = 'already_despatched';
  END IF;
  SELECT string_agg(coalesce(i.invoice_ref, 'an invoice'), ', ') INTO v_inv FROM public.invoices i
  WHERE i.job_id = p_job AND i.organization_id = v_org AND lower(coalesce(i.status, 'draft')) NOT IN ('draft', 'void', 'voided', 'cancelled', 'canceled');
  IF v_inv IS NOT NULL THEN
    RAISE EXCEPTION '% has been invoiced (%), so it can''t be reopened.', v_job.job_no, v_inv USING ERRCODE = '22023', HINT = 'invoice_issued';
  END IF;
  IF v_job.inspected_at IS NOT NULL THEN
    SELECT i.id INTO v_voided FROM public.job_inspections i WHERE i.job_id = p_job AND i.result IN ('pass', 'concession') ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1;
  END IF;

  -- 035's actor_stamp does the rest in the same statement: finished_by and the sign-off cleared, the stage back to machining, REOPEN.
  PERFORM set_config('quoteflow.job_reopen', p_job::TEXT, TRUE);
  PERFORM set_config('quoteflow.job_reopen_reason', v_reason, TRUE);
  UPDATE public.jobs SET finished_at = NULL WHERE id = p_job;
  PERFORM set_config('quoteflow.job_reopen_reason', '', TRUE);
  PERFORM set_config('quoteflow.job_reopen', '', TRUE);
  RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'reopened', TRUE, 'was_complete', v_job.inspected_at IS NOT NULL, 'voided_inspection_id', v_voided);
END
$$;
REVOKE ALL ON FUNCTION public.reopen_job(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_job(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 12. The admin's early release (8.6 exception), with a reason. The job must be finished and not yet Complete (Finished, or put back
-- after a failure: what is held in rework stays held). Recorded as an early_release event; in force until the job is reopened, fails
-- again or its worksheet changes. Returns { job_id, job_no, released_early, already, event_id }.
CREATE OR REPLACE FUNCTION public.release_job_early(p_job UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_reason TEXT := nullif(btrim(p_reason), '');
  v_job    RECORD;
  v_name   TEXT;
  v_id     UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can release a job before it passes inspection.' USING ERRCODE = '42501', HINT = 'early_release_admin_only';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Say why it is released before inspection (10 to 500 characters).' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;
  SELECT j.id, j.job_no, j.finished_at, j.inspected_at, j.stage, j.is_internal, j.worksheet_version INTO v_job
  FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.is_internal THEN
    RAISE EXCEPTION 'Job % is internal: it is never despatched or invoiced.', v_job.job_no USING ERRCODE = '42501', HINT = 'internal_job';
  END IF;
  IF v_job.finished_at IS NULL THEN
    RAISE EXCEPTION '% isn''t finished yet: finish it first.', v_job.job_no USING ERRCODE = '22023', HINT = 'not_finished';
  END IF;
  IF v_job.inspected_at IS NOT NULL AND v_job.stage IS DISTINCT FROM 'rework' THEN
    RAISE EXCEPTION '% is Complete: it needs no early release.', v_job.job_no USING ERRCODE = '22023', HINT = 'already_complete';
  END IF;
  IF public.job_early_release_active(p_job) THEN
    SELECT e.id INTO v_id FROM public.job_flow_events e WHERE e.job_id = p_job AND e.kind = 'early_release' ORDER BY e.seq DESC LIMIT 1;
    RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'released_early', TRUE, 'already', TRUE, 'event_id', v_id);
  END IF;
  SELECT nullif(btrim(regexp_replace(coalesce(p.full_name, ''), '[[:cntrl:]]+', ' ', 'g')), '') INTO v_name FROM public.user_profiles p WHERE p.id = v_user;
  IF v_name IS NULL OR position('@' IN v_name) > 0 THEN
    v_name := NULL;
  END IF;
  INSERT INTO public.job_flow_events (organization_id, job_id, kind, actor_user_id, actor_name, reason, worksheet_version, detail)
  VALUES (v_org, p_job, 'early_release', v_user, left(v_name, 100), v_reason, v_job.worksheet_version, jsonb_build_object('stage', v_job.stage))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'released_early', TRUE, 'already', FALSE, 'event_id', v_id);
END
$$;
REVOKE ALL ON FUNCTION public.release_job_early(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_job_early(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 13. The inspection screen's call. p_result pass, fail or concession; p_criteria (the acceptance criteria) and p_measured (the
-- measured or checked result, stored as the record's measured notes) always. A pass or a concession goes to record_job_inspection
-- (who may inspect, the worksheet version, certificates and checklist, rework: all as 034/037); the record's own trigger checks the
-- evidence and the independence (p_override_reason: an admin who finished the job). A fail goes to fail_job_inspection with
-- p_failure { reason (what failed), instructions, quantity, lines, batch } and p_disposition: rework, scrap (each failed quantity is
-- scrapped at once, so replacements are made and inspected) or concession (an admin: the fail is recorded, then the concession, with
-- p_concession_reason, releases it). p_client_op_id: the offline key; a replay by the same inspector for the same job and result
-- answers the first record (replayed = true); the key used for anything else is refused (client_op_reused). The replay is looked
-- up before who may inspect and independence are checked, and inserts nothing: a pass or fail already committed is answered even if
-- the inspector has since lost the right to inspect. Only a new attempt goes through the checks (and is looked up again under the
-- job's row lock, for two sends at once).
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
  IF NOT public.has_org_role(ARRAY['admin'])
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_user AND m.organization_id = v_org AND m.active AND m.can_inspect) THEN
    RAISE EXCEPTION 'An admin has to make you an inspector before you can record inspections.' USING ERRCODE = '42501';
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
-- 14. What of a job may go out (037's body but for the released line).
CREATE OR REPLACE FUNCTION public.job_release_state(p_job UUID)
RETURNS TABLE (released BOOLEAN, quantity_required NUMERIC, held NUMERIC, missing NUMERIC, available NUMERIC, holding BOOLEAN, blocked TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_job   RECORD;
  v_live  INTEGER;
  v_whole BOOLEAN;
  v_held  NUMERIC;
  v_miss  NUMERIC;
  v_loose INTEGER;
  v_rel   BOOLEAN;
  v_block TEXT;
  v_avail NUMERIC;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT jb.inspected_at, jb.quantity_required::NUMERIC AS q, jb.worksheet_version, jb.job_no, jb.converted_from_sales_order_id AS order_id INTO v_job
  FROM public.jobs jb WHERE jb.id = p_job AND jb.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  -- A part failure releases the rest only for the job as it was inspected: a later worksheet, quantity or drawing change (034
  -- withdraws the sign-off for those) withdraws that release too, until the job is inspected again.
  SELECT count(*), coalesce(bool_or(r.affects_all OR i.worksheet_version IS DISTINCT FROM v_job.worksheet_version
                                    OR (r.sales_order_line_id IS NULL AND r.quantity_affected IS NULL)), FALSE),
         coalesce(sum(coalesce(r.quantity_affected::NUMERIC, l.quantity, v_job.q, 0)), 0)
    INTO v_live, v_whole, v_held
  FROM public.job_rework r
  LEFT JOIN public.job_inspections i ON i.id = r.inspection_id
  LEFT JOIN public.sales_order_lines l ON l.id = r.sales_order_line_id
  WHERE r.job_id = p_job AND r.status IN ('open', 'in_progress', 'finished');
  SELECT coalesce(sum(r.quantity_scrapped - r.quantity_remade - r.quantity_carried), 0) INTO v_miss
  FROM public.job_rework r WHERE r.job_id = p_job AND r.status = 'closed';
  -- 081 (ISO 9001 8.6): released only when the job is Complete (passed, or an admin's concession, with nothing in rework), or an
  -- admin released it early with a reason (job_early_release_active). A part failure no longer releases the rest by itself: the job
  -- is put back to In progress, and only an early release lets the unaffected part go (what is held stays held).
  v_rel := (v_job.inspected_at IS NOT NULL AND v_live = 0) OR public.job_early_release_active(p_job);

  IF v_job.order_id IS NOT NULL THEN
    -- Every hold on a job made from an order is against one of the order's lines. One that isn't (its line was removed when the
    -- order's lines were rebuilt) can't be weighed, so nothing goes out until it is resolved.
    SELECT count(*) INTO v_loose FROM public.job_rework r
    WHERE r.job_id = p_job AND r.sales_order_line_id IS NULL
      AND (r.status IN ('open', 'in_progress', 'finished') OR r.quantity_scrapped > r.quantity_remade + r.quantity_carried);
    IF v_loose > 0 THEN
      v_block := format('%s can''t be despatched: part of it is held in rework or waiting for replacements, but not against a line of its sales order '
                        '(the order''s lines changed after the inspection failed), so what may go out can''t be worked out. Inspect it again, '
                        'failing the order line that is affected, and make any outstanding replacements (Rework, Make the outstanding replacements).', v_job.job_no);
    END IF;
    SELECT sum(CASE WHEN NOT v_rel OR v_block IS NOT NULL THEN 0::NUMERIC ELSE greatest(sl.quantity - h.held - h.missing, 0) END) INTO v_avail
    FROM public.sales_order_lines sl
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(coalesce(r.quantity_affected::NUMERIC, sl.quantity)) FILTER (WHERE r.status IN ('open', 'in_progress', 'finished')), 0) AS held,
             coalesce(sum(r.quantity_scrapped - r.quantity_remade - r.quantity_carried) FILTER (WHERE r.status = 'closed'), 0)::NUMERIC AS missing
      FROM public.job_rework r WHERE r.job_id = p_job AND r.sales_order_line_id = sl.id) h
    WHERE sl.sales_order_id = v_job.order_id AND sl.organization_id = v_org;
    v_avail := CASE WHEN NOT v_rel OR v_block IS NOT NULL THEN 0::NUMERIC ELSE v_avail END;
  ELSE
    -- The job's own quantity. With none on the worksheet, a hold can't be weighed against it: fail closed.
    IF v_job.q IS NULL AND v_rel AND (v_live > 0 OR v_miss > 0) THEN
      v_block := format('%s can''t be despatched: it has %s replacement(s) still to make or parts in rework, but no quantity on its worksheet, so what may go out '
                        'can''t be worked out. Enter the job''s quantity on its worksheet (it is then inspected again), or make and inspect the outstanding '
                        'replacements (Rework, Make the outstanding replacements).', v_job.job_no, v_miss);
    END IF;
    v_avail := CASE WHEN NOT v_rel OR v_block IS NOT NULL THEN 0::NUMERIC WHEN v_job.q IS NULL THEN NULL ELSE greatest(v_job.q - v_held - v_miss, 0) END;
  END IF;
  RETURN QUERY SELECT v_rel, v_job.q, v_held, v_miss, v_avail, (v_live > 0 OR v_miss > 0), v_block;
END
$$;
REVOKE ALL ON FUNCTION public.job_release_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_release_state(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 15. Delivery notes (8.6): made and sent out only for a released job. create_delivery_note and the note guard (037) refuse a job that
-- isn't released through job_release_state; this gate also covers a hand-made note that names the job by number (job_ref) or its sales
-- order, when the note is made and when it goes out. The job row is locked FOR UPDATE, as the note guard and the inspection functions
-- lock it. Browser roles only (the service role, the owner and the SQL editor are exempt); an import is exempt.
CREATE OR REPLACE FUNCTION public.delivery_notes_release_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job   RECORD;
  v_found BOOLEAN := FALSE;
  v_state RECORD;
  v_why   TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (NEW.status IN ('despatched', 'delivered', 'signed') AND coalesce(OLD.status, '') NOT IN ('despatched', 'delivered', 'signed')) THEN
    RETURN NEW;
  END IF;
  IF NEW.job_id IS NOT NULL THEN
    SELECT j.id, j.job_no, j.is_internal, public.flow_status(j) AS flow_status, j.stage INTO v_job FROM public.jobs j WHERE j.id = NEW.job_id AND j.organization_id = NEW.organization_id FOR UPDATE;
    v_found := FOUND;
  ELSIF nullif(btrim(NEW.job_ref), '') IS NOT NULL THEN
    SELECT j.id, j.job_no, j.is_internal, public.flow_status(j) AS flow_status, j.stage INTO v_job FROM public.jobs j
    WHERE j.job_no = btrim(NEW.job_ref) AND j.organization_id = NEW.organization_id ORDER BY j.created_at LIMIT 1 FOR UPDATE;
    v_found := FOUND;
  ELSIF NEW.sales_order_id IS NOT NULL THEN
    SELECT j.id, j.job_no, j.is_internal, public.flow_status(j) AS flow_status, j.stage INTO v_job FROM public.sales_orders s JOIN public.jobs j ON j.id = s.converted_to_job_id
    WHERE s.id = NEW.sales_order_id AND s.organization_id = NEW.organization_id AND j.organization_id = NEW.organization_id FOR UPDATE OF j;
    v_found := FOUND;
  END IF;
  IF NOT v_found THEN
    RETURN NEW;
  END IF;
  IF v_job.is_internal THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_state FROM public.job_release_state(v_job.id);
  IF NOT v_state.released THEN
    v_why := CASE WHEN v_job.stage IS NOT DISTINCT FROM 'rework' THEN 'it failed inspection and is back in progress'
                  WHEN v_job.flow_status = 'finished' THEN 'it is Finished, awaiting inspection'
                  ELSE 'it isn''t finished yet' END;
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION '% isn''t Complete (%), so a delivery note can''t be made for it yet. It can go once it passes inspection, or an admin releases it early with a reason.',
        v_job.job_no, v_why USING ERRCODE = '22023', HINT = 'job_not_released';
    END IF;
    RAISE EXCEPTION '% isn''t Complete (%), so delivery note % can''t be sent out yet. It can go once it passes inspection, or an admin releases it early with a reason.',
      v_job.job_no, v_why, NEW.dn_number USING ERRCODE = '22023', HINT = 'job_not_released';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.delivery_notes_release_gate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS delivery_notes_release_gate ON public.delivery_notes;
CREATE TRIGGER delivery_notes_release_gate BEFORE INSERT OR UPDATE OF status ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.delivery_notes_release_gate();

-- -----------------------------------------------------------------------------------------------------
-- 16. Invoices: one draft per job, and an invoice for a job is issued (numbered) only once the job is released. Browser roles only;
-- an import is exempt. The job row is locked FOR UPDATE before it is read (reopen_job locks it too, so an issue and a reopen never
-- interleave); the draft check holds the job's invoice key (the same as job_finish_draft_invoice).
CREATE OR REPLACE FUNCTION public.invoices_job_release_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_was   TEXT;
  v_is    TEXT := lower(coalesce(NEW.status, 'draft'));
  v_job   RECORD;
  v_state RECORD;
  v_other TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT THEN
    RETURN NEW;
  END IF;
  IF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_was := CASE WHEN TG_OP = 'UPDATE' THEN lower(coalesce(OLD.status, 'draft')) END;
  -- One draft per job (a new draft, or a draft moved onto a job).
  IF v_is = 'draft' AND (TG_OP = 'INSERT' OR NEW.job_id IS DISTINCT FROM OLD.job_id) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('job-invoice:' || NEW.job_id::TEXT, 0));
    SELECT j.job_no INTO v_other FROM public.invoices i JOIN public.jobs j ON j.id = i.job_id
    WHERE i.job_id = NEW.job_id AND i.organization_id = NEW.organization_id AND i.id IS DISTINCT FROM NEW.id
      AND lower(coalesce(i.status, 'draft')) = 'draft' LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION '% already has a draft invoice (no number yet): add to that one instead of making a second.', v_other
        USING ERRCODE = '22023', HINT = 'job_has_draft';
    END IF;
  END IF;
  -- Issued: out of draft into anything but void.
  IF TG_OP = 'UPDATE' AND v_was = 'draft' AND v_is NOT IN ('draft', 'void', 'voided', 'cancelled', 'canceled') THEN
    SELECT j.id, j.job_no, public.flow_status(j) AS flow_status, j.stage, j.is_internal INTO v_job FROM public.jobs j
    WHERE j.id = NEW.job_id AND j.organization_id = NEW.organization_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF NOT v_job.is_internal THEN
      SELECT * INTO v_state FROM public.job_release_state(v_job.id);
      IF NOT v_state.released THEN
        RAISE EXCEPTION '% isn''t Complete (%): its invoice stays a draft until the job passes inspection, or an admin releases it early with a reason.',
          v_job.job_no, CASE WHEN v_job.stage IS NOT DISTINCT FROM 'rework' THEN 'it failed inspection and is back in progress'
                             WHEN v_job.flow_status = 'finished' THEN 'Finished, awaiting inspection'
                             ELSE 'not finished yet' END
          USING ERRCODE = '22023', HINT = 'job_not_complete';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.invoices_job_release_gate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_job_release_gate ON public.invoices;
CREATE TRIGGER invoices_job_release_gate BEFORE INSERT OR UPDATE OF status, job_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_job_release_gate();

-- -----------------------------------------------------------------------------------------------------
-- 17. The automatic draft from a delivery note (059's body but for one step: a note whose job already has its invoice goes on it).
CREATE OR REPLACE FUNCTION public.delivery_note_try_draft(p_note UUID, p_org UUID, p_cause TEXT)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_note   RECORD;
  v_block  TEXT;
  v_terms  TEXT;
  v_days   INT;
  v_today  DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_made   JSONB;
  v_state  TEXT;
  v_msg    TEXT;
  v_job_inv UUID;
BEGIN
  BEGIN
    -- The note's row lock: already held by the note's own update, which called this.
    SELECT d.id, d.status, d.invoice_id, d.invoice_ref, i.status AS invoice_status INTO v_note
    FROM public.delivery_notes d LEFT JOIN public.invoices i ON i.id = d.invoice_id
    WHERE d.id = p_note AND d.organization_id = p_org
    FOR UPDATE OF d;
    IF NOT FOUND THEN
      RETURN 'not_found';
    END IF;
    IF v_note.status NOT IN ('despatched', 'delivered', 'signed') THEN
      RETURN 'not_sent';
    END IF;
    -- Idempotent: a note on a live invoice (a draft included) is left alone.
    IF v_note.invoice_id IS NOT NULL AND lower(coalesce(v_note.invoice_status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled') THEN
      RETURN 'invoiced';
    END IF;
    -- A hand-typed invoice reference (a hand-made note, or an import from the old system) means it was invoiced elsewhere.
    IF v_note.invoice_id IS NULL AND nullif(btrim(v_note.invoice_ref), '') IS NOT NULL THEN
      RETURN 'invoice_ref';
    END IF;
    -- 081: the note's job already has its invoice (the draft made when the job was finished, or any live invoice made for the job):
    -- the note goes on that one, so one job never gets a second draft. A draft first, then the oldest.
    SELECT i.id INTO v_job_inv
    FROM public.delivery_notes d JOIN public.invoices i ON i.job_id = d.job_id AND i.organization_id = d.organization_id
    WHERE d.id = p_note AND d.job_id IS NOT NULL AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')
    ORDER BY (lower(coalesce(i.status, 'draft')) = 'draft') DESC, i.created_at, i.id
    LIMIT 1;
    IF v_job_inv IS NOT NULL THEN
      PERFORM set_config('quoteflow.delivery_note_invoice', p_note::TEXT, TRUE);
      UPDATE public.delivery_notes SET invoice_id = v_job_inv WHERE id = p_note;
      PERFORM set_config('quoteflow.delivery_note_invoice', '', TRUE);
      PERFORM security_audit.log_named_event(p_org, 'LINK_JOB_INVOICE', 'delivery_notes', p_note::TEXT,
        jsonb_build_object('invoice_id', v_job_inv, 'cause', p_cause));
      RETURN 'linked';
    END IF;
    v_block := public.delivery_note_draft_block(p_note);
    IF v_block IS NOT NULL THEN
      RETURN v_block;
    END IF;

    SELECT coalesce(nullif(btrim(s.company_profile ->> 'defaultInvoiceTerms'), ''), '30 days') INTO v_terms
    FROM public.organization_settings s WHERE s.organization_id = p_org;
    v_terms := left(coalesce(v_terms, '30 days'), 200);
    -- As the invoices page reads terms: "on receipt" is due today, else the first number in it is days, else 30.
    v_days := CASE WHEN v_terms ~* 'receipt' THEN 0 ELSE coalesce(least(substring(v_terms FROM '(\d{1,4})')::INT, 366), 30) END;

    v_made := public.invoice_from_delivery_notes_draft(p_org, ARRAY[p_note], v_today, v_today + v_days, v_terms);
    INSERT INTO public.invoice_queue_events (organization_id, delivery_note_id, invoice_id, cause, outcome, created_by)
    VALUES (p_org, p_note, (v_made ->> 'invoice_id')::UUID, p_cause, 'drafted', auth.uid());
    RETURN 'drafted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  -- Everything of the attempt is undone; what went wrong is kept, and the caller's change goes on.
  BEGIN
    INSERT INTO public.invoice_queue_events (organization_id, delivery_note_id, cause, outcome, error_code, error_message, created_by)
    VALUES (p_org, p_note, p_cause, 'failed', v_state, left(coalesce(nullif(v_msg, ''), 'unknown error'), 500), auth.uid());
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '059: the draft invoice for delivery note % failed (%: %) and the failure could not be recorded', p_note, v_state, v_msg;
  END;
  RETURN 'failed';
END
$$;
REVOKE ALL ON FUNCTION public.delivery_note_try_draft(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 18. Self-check before COMMIT (the same checks as supabase/verify/job_flow_081.sql).
DO $$
DECLARE
  f TEXT;
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_release_state(uuid)')) IS DISTINCT FROM 'c16ea537b0b5706ab6db6e160214e17d' THEN
    RAISE EXCEPTION '081: job_release_state is not 081''s after the replace';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)')) IS DISTINCT FROM '52a9771fec832f0e20e9d780e7561caa' THEN
    RAISE EXCEPTION '081: delivery_note_try_draft is not 081''s after the replace';
  END IF;
  -- The API functions: signed-in users only, each starting with the second-step check.
  FOREACH f IN ARRAY ARRAY['public.reopen_job(uuid,text)', 'public.release_job_early(uuid,text)',
                           'public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)'] LOOP
    IF to_regprocedure(f) IS NULL OR position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure(f))) = 0
       OR NOT has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') OR has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION '081: % is missing, lacks the second-step check, or has the wrong grants', f;
    END IF;
  END LOOP;
  -- The internal helpers and trigger functions: no API role.
  FOREACH f IN ARRAY ARRAY['public.job_early_release_active(uuid)', 'public.job_finish_draft_invoice(uuid,uuid)', 'public.jobs_flow_log()',
                           'public.jobs_finish_kept()', 'public.job_inspections_evidence()', 'public.job_inspections_immutable()',
                           'public.job_flow_events_immutable()', 'public.delivery_notes_release_gate()', 'public.invoices_job_release_gate()'] LOOP
    IF to_regprocedure(f) IS NULL OR has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') OR has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION '081: % is missing or callable from the API', f;
    END IF;
  END LOOP;
  IF has_function_privilege('service_role', to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)'), 'EXECUTE') THEN
    RAISE EXCEPTION '081: job_finish_draft_invoice is callable by the service role';
  END IF;
  -- job_release_state keeps its security and grants (037).
  IF NOT (SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=pg_catalog, public']
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_release_state(uuid)')) THEN
    RAISE EXCEPTION '081: job_release_state''s security or grants changed';
  END IF;
  -- The new table: RLS on, read only for signed-in members, nothing for anon.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.job_flow_events'::regclass)
     OR has_table_privilege('anon', 'public.job_flow_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_flow_events', 'INSERT') OR has_table_privilege('authenticated', 'public.job_flow_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.job_flow_events', 'DELETE') OR NOT has_table_privilege('authenticated', 'public.job_flow_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_inspections', 'INSERT') OR has_table_privilege('authenticated', 'public.job_inspections', 'UPDATE') THEN
    RAISE EXCEPTION '081: job_flow_events or job_inspections grants are not as stated';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname IN ('ad_finish_kept', 'zz_jobs_flow_log') AND t.tgrelid = 'public.jobs'::regclass) <> 2
     OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.job_inspections'::regclass
           AND t.tgname IN ('job_inspections_evidence', 'job_inspections_immutable', 'job_inspections_no_truncate', 'audit_job_inspections_changes')) <> 4
     OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.job_flow_events'::regclass
           AND t.tgname IN ('job_flow_events_immutable', 'job_flow_events_no_truncate', 'audit_job_flow_events_changes', 'support_read_only', 'admin_mfa',
                            'zz_same_org_job_id', 'zz_same_org_inspection_id')) <> 7
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'delivery_notes_release_gate' AND t.tgrelid = 'public.delivery_notes'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'invoices_job_release_gate' AND t.tgrelid = 'public.invoices'::regclass) THEN
    RAISE EXCEPTION '081: a trigger is missing';
  END IF;
  IF to_regprocedure('public.flow_status(public.jobs)') IS NULL OR has_function_privilege('anon', to_regprocedure('public.flow_status(public.jobs)'), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure('public.flow_status(public.jobs)'), 'EXECUTE') THEN
    RAISE EXCEPTION '081: public.flow_status(jobs) is missing or its grants are not as stated';
  END IF;
END
$$;

COMMIT;
