-- =====================================================================================================
-- 037: failed inspection and rework (PR E). One migration for every database change in the batch.
--
-- 1. A failed inspection puts the job into REWORK (issue #2). job_inspections (034) already records pass / fail / concession; now a
--    fail also opens a rework record (job_rework): the reason, the quantity affected (all of the job, or part of it), the rework
--    instructions, and who raised it and when. The job's stage becomes 'rework'; the rework is assigned back to the workshop (anyone
--    in the workshop, office or admin can start it). The job board shows a Rework traffic light and filter.
--    * fail_job_inspection records the failure and opens the rework. record_job_inspection keeps its signature: a fail sent through
--      it (an older screen) opens the rework for all of the job, with the notes as the reason.
--    * start_job_rework (START_REWORK), record_rework_cost (hours and material, in job_rework_entries, kept apart from the job's own
--      worksheet hours so costing can see what rework cost; the money is in job_rework_entry_values, for admin and office only),
--      scrap_job_quantity (SCRAP: a failed quantity is scrapped with a reason; a replacement then has to be remade, which shows as
--      "remaining to make"), finish_job_rework (FINISH_REWORK: the job goes back to awaiting inspection, with the replacements actually
--      made this time recorded explicitly, p_remade; those not made stay outstanding).
--    * Re-inspection is needed: a pass is refused while the rework is open; the job is released only by a pass after the rework, or by an
--      admin's concession (which closes the rework). Nothing else moves a job into or out of the rework stage. A pass or a concession
--      releases only what exists: replacements for scrapped parts that were never made stay held, until the office or an admin opens a
--      replacement rework for them (open_replacement_rework, REOPEN_REWORK): made, finished and inspected again before release.
--    * Despatch by batch (Rhys's decision): only the part or batch in rework is held, the rest of the job can go. The failure is recorded
--      against the order line (and batch) that failed, one rework per line, so a failure of one line holds only that line
--      (job_line_release). create_delivery_note, a note going out and despatch_release count it per order line, with the job row locked
--      FOR UPDATE, which fail_job_inspection and the inspection functions lock too, so a failure and a despatch never interleave
--      (section 5). Fail closed: when what is held can't be weighed (no quantity to weigh it against, or a hold no longer tied to an
--      order line), nothing of the job goes out, and the refusal says what to set (job_release_state.blocked).
--    * job_rework_summary(job) gives the job's rework picture (cycles, quantity in rework, scrapped, remaining to make, hours, material
--      items, the material cost for admin and office only, and what is held and available to despatch, per order line).
--    * Audit events FAIL_INSPECTION, START_REWORK, SCRAP, RECORD_REWORK_COST, FINISH_REWORK and REOPEN_REWORK are written in the same
--      transaction.
--    * record_job_inspection keeps 034's signature and rules (who may inspect, the worksheet version, certificates and checklist, display
--      names only); fail_job_inspection follows the same rules on who may inspect and the name recorded.
--    * The second step (033): every function here that writes starts with assert_privileged_aal(), and the three rework tables carry the
--      admin_mfa statement trigger, so an admin at aal1 is refused when the company requires the second step (open_replacement_rework
--      too).
-- 2. An updated_at that moves (issue #3 item 8). One trigger function sets updated_at on every change made by a signed-in user, on
--    the main document tables, so issuing or paying an invoice, or moving a job, moves it. The service role, the database owner and the
--    SQL editor are exempt, so the importer keeps the dates it loads.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. The rework records ---------------------------------------------------------------------------------
-- One row per failed inspection and order line that failed (one per failed inspection for a job not made from an order), or per
-- replacement rework. status: open (raised, waiting for the workshop) > in_progress (started) > finished (done, awaiting re-inspection)
-- > closed (re-inspected and passed, released on a concession, or superseded by a later failure). One rework per job and order line
-- is live at a time.
CREATE TABLE IF NOT EXISTS public.job_rework (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  job_id            UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  inspection_id     UUID REFERENCES public.job_inspections(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'finished', 'closed')),
  reason            TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  instructions      TEXT NOT NULL CHECK (length(btrim(instructions)) BETWEEN 1 AND 2000),
  affects_all       BOOLEAN NOT NULL,
  quantity_affected INTEGER CHECK (quantity_affected IS NULL OR quantity_affected > 0),
  quantity_scrapped INTEGER NOT NULL DEFAULT 0 CHECK (quantity_scrapped >= 0),
  quantity_remade   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_remade >= 0),
  assigned_to       TEXT NOT NULL DEFAULT 'workshop' CHECK (assigned_to = 'workshop'),
  raised_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  raised_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ,
  finished_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  finished_at       TIMESTAMPTZ,
  closed_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_at         TIMESTAMPTZ,
  closed_how        TEXT CHECK (closed_how IS NULL OR closed_how IN ('passed', 'concession', 'superseded')),
  -- Which part failed: the order line (for a job made from a sales order; the quantities above are then in that line's units) and,
  -- if the inspector gave one, the batch. Null line: a job not made from an order (the job's own quantity), or a line the order no
  -- longer has (the order's lines were rebuilt): such a rework can't be weighed against a line, so it holds the whole job.
  sales_order_line_id UUID REFERENCES public.sales_order_lines(id) ON DELETE SET NULL,
  batch_ref         TEXT CHECK (batch_ref IS NULL OR length(btrim(batch_ref)) BETWEEN 1 AND 100),
  -- A replacement rework (open_replacement_rework): opened for the replacements a closed rework still owed, which it carried over
  -- (quantity_carried on the closed one), so they are made and inspected before they are released.
  follow_up_of      UUID REFERENCES public.job_rework(id) ON DELETE SET NULL,
  quantity_carried  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_carried >= 0),
  CONSTRAINT job_rework_scrap_within_affected CHECK (quantity_affected IS NULL OR quantity_scrapped <= quantity_affected),
  CONSTRAINT job_rework_remade_within_scrapped CHECK (quantity_remade + quantity_carried <= quantity_scrapped),
  CONSTRAINT job_rework_closed_has_how CHECK ((status = 'closed') = (closed_how IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_job_rework_job ON public.job_rework (job_id, raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_rework_org ON public.job_rework (organization_id);
CREATE INDEX IF NOT EXISTS idx_job_rework_line ON public.job_rework (sales_order_line_id) WHERE sales_order_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_rework_follow_up ON public.job_rework (follow_up_of) WHERE follow_up_of IS NOT NULL;
-- At most one live rework per job and order line (a job not made from an order has one at most: the functions see to it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_rework_one_live ON public.job_rework (job_id, sales_order_line_id) WHERE status IN ('open', 'in_progress', 'finished');

-- What was spent on a rework, apart from the job's own hours: hours worked, material used, parts scrapped, and the replacements made
-- for scrapped parts (recorded when the rework is finished). Rows are written by the functions below and never changed.
CREATE TABLE IF NOT EXISTS public.job_rework_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  job_id          UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  rework_id       UUID NOT NULL REFERENCES public.job_rework(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('hours', 'material', 'scrap', 'remake')),
  hours           NUMERIC(8,2),
  quantity        INTEGER,
  description     TEXT CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 500),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_rework_entries_shape CHECK (
       (kind = 'hours'    AND hours > 0 AND hours <= 999 AND quantity IS NULL)
    OR (kind = 'material' AND hours IS NULL AND quantity IS NULL AND description IS NOT NULL)
    OR (kind = 'scrap'    AND hours IS NULL AND quantity > 0 AND description IS NOT NULL)
    OR (kind = 'remake'   AND hours IS NULL AND quantity > 0))
);
CREATE INDEX IF NOT EXISTS idx_job_rework_entries_rework ON public.job_rework_entries (rework_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_rework_entries_job ON public.job_rework_entries (job_id);
CREATE INDEX IF NOT EXISTS idx_job_rework_entries_org ON public.job_rework_entries (organization_id);

-- The cost of a material entry, apart from the entry: people without money access (workshop, viewer) read the entries, not this.
CREATE TABLE IF NOT EXISTS public.job_rework_entry_values (
  entry_id        UUID PRIMARY KEY REFERENCES public.job_rework_entries(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  material_cost   NUMERIC(12,2) NOT NULL CHECK (material_cost >= 0)
);
CREATE INDEX IF NOT EXISTS idx_job_rework_entry_values_org ON public.job_rework_entry_values (organization_id);

-- Same company; everyone who can open the job reads its rework; the cost is for admin and office. No insert, update or delete grant for
-- the API: rows are written by the functions below only.
ALTER TABLE public.job_rework ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_rework_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_rework_entry_values ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_rework rbac select" ON public.job_rework;
CREATE POLICY "job_rework rbac select" ON public.job_rework FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
DROP POLICY IF EXISTS "job_rework_entries rbac select" ON public.job_rework_entries;
CREATE POLICY "job_rework_entries rbac select" ON public.job_rework_entries FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
DROP POLICY IF EXISTS "job_rework_entry_values rbac select" ON public.job_rework_entry_values;
CREATE POLICY "job_rework_entry_values rbac select" ON public.job_rework_entry_values FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
REVOKE ALL ON public.job_rework, public.job_rework_entries, public.job_rework_entry_values FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_rework, public.job_rework_entries, public.job_rework_entry_values TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_rework;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_rework
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS zz_same_org_inspection_id ON public.job_rework;
CREATE TRIGGER zz_same_org_inspection_id BEFORE INSERT OR UPDATE ON public.job_rework
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('job_inspections', 'inspection_id');
DROP TRIGGER IF EXISTS zz_same_org_sales_order_line_id ON public.job_rework;
CREATE TRIGGER zz_same_org_sales_order_line_id BEFORE INSERT OR UPDATE ON public.job_rework
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('sales_order_lines', 'sales_order_line_id');
DROP TRIGGER IF EXISTS zz_same_org_follow_up_of ON public.job_rework;
CREATE TRIGGER zz_same_org_follow_up_of BEFORE INSERT OR UPDATE ON public.job_rework
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('job_rework', 'follow_up_of');
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_rework_entries;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_rework_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS zz_same_org_rework_id ON public.job_rework_entries;
CREATE TRIGGER zz_same_org_rework_id BEFORE INSERT OR UPDATE ON public.job_rework_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('job_rework', 'rework_id');
DROP TRIGGER IF EXISTS zz_same_org_entry_id ON public.job_rework_entry_values;
CREATE TRIGGER zz_same_org_entry_id BEFORE INSERT OR UPDATE ON public.job_rework_entry_values
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('job_rework_entries', 'entry_id');

DROP TRIGGER IF EXISTS audit_job_rework_changes ON public.job_rework;
CREATE TRIGGER audit_job_rework_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_rework
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS audit_job_rework_entries_changes ON public.job_rework_entries;
CREATE TRIGGER audit_job_rework_entries_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_rework_entries
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- Support access is read-only (036): every company table carries the statement trigger, the new ones too; and so does 033's second
-- step for admins.
DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_rework', 'job_rework_entries', 'job_rework_entry_values'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS support_read_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', t);
    -- With the company's require_admin_mfa on, an admin at aal1 writes none of it either (033's statement trigger).
    EXECUTE format('DROP TRIGGER IF EXISTS admin_mfa ON public.%I', t);
    EXECUTE format('CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard()', t);
  END LOOP;
END
$do$;

-- The rework stage belongs to the rework functions. For the browser roles (anon, authenticated; the service role, the database owner and
-- the SQL editor are exempt, as for the other locks): a job can't be created in the rework stage, can't be moved into it, and can't be
-- moved out of it by editing the job (Finish, Start and the like). Only the functions below name the job in quoteflow.job_rework.
CREATE OR REPLACE FUNCTION public.jobs_rework_stage_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF current_setting('quoteflow.job_rework', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage = 'rework' THEN
      RAISE EXCEPTION 'A job goes into rework when its inspection fails.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage AND (NEW.stage = 'rework' OR OLD.stage = 'rework') THEN
    RAISE EXCEPTION 'Job %: it goes into rework when its inspection fails, and leaves it when the rework is finished or an admin records a concession.', OLD.job_no USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS jobs_rework_stage_guard ON public.jobs;
CREATE TRIGGER jobs_rework_stage_guard BEFORE INSERT OR UPDATE OF stage ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_rework_stage_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. What the board and the costing read ------------------------------------------------------------------
-- The rework picture of one job. The material cost is for admin and office only (null for the rest). Not a table, so there is nothing
-- to join: cycles, what is in rework now, what has been scrapped, what remains to be made again, the hours and the material, and what
-- of the job may go out now (released, quantity_held, quantity_available, per order line in lines, and blocked: why nothing may go
-- when the quantities can't be worked out; see job_release_state and job_line_release).
CREATE OR REPLACE FUNCTION public.job_rework_summary(p_job UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_costs BOOLEAN := public.has_org_role(ARRAY['admin', 'office']);
  v_job   RECORD;
  v_live  RECORD;
  v_state RECORD;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT id, quantity_required INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  -- The live rework the board shows first (there is one per failed order line; all of them are in lines and in job_rework).
  SELECT id, status INTO v_live FROM public.job_rework WHERE job_id = p_job AND organization_id = v_org AND status IN ('open', 'in_progress', 'finished')
  ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, raised_at LIMIT 1;
  SELECT * INTO v_state FROM public.job_release_state(p_job);
  RETURN jsonb_build_object(
    'job_id', p_job,
    'quantity_required', v_job.quantity_required,
    'cycles', (SELECT count(DISTINCT coalesce(inspection_id, id)) FROM public.job_rework WHERE job_id = p_job AND organization_id = v_org),
    'live_rework_id', v_live.id,
    'live_status', v_live.status,
    'live_count', (SELECT count(*) FROM public.job_rework WHERE job_id = p_job AND organization_id = v_org AND status IN ('open', 'in_progress', 'finished')),
    'quantity_in_rework', coalesce((SELECT sum(coalesce(quantity_affected, 0) - quantity_scrapped) FROM public.job_rework
                                    WHERE job_id = p_job AND organization_id = v_org AND status IN ('open', 'in_progress')), 0),
    'quantity_scrapped', coalesce((SELECT sum(quantity_scrapped) FROM public.job_rework WHERE job_id = p_job AND organization_id = v_org AND follow_up_of IS NULL), 0),
    'remaining_to_make', coalesce((SELECT sum(quantity_scrapped - quantity_remade - quantity_carried) FROM public.job_rework WHERE job_id = p_job AND organization_id = v_org), 0),
    -- What may go out now (job_release_state): released at all, held (in a live rework, or replacements still to make), available,
    -- and per order line (job_line_release). blocked says why nothing may go, and what to set, when the quantities can't be worked out.
    'released', v_state.released,
    'quantity_held', v_state.held + v_state.missing,
    'quantity_available', v_state.available,
    'blocked', v_state.blocked,
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('line_id', l.line_id, 'description', l.description, 'ordered', l.ordered, 'held', l.held,
                                                           'missing', l.missing, 'available', l.available, 'batches', l.batches) ORDER BY l.line_position, l.line_id)
                       FROM public.job_line_release(p_job) l), '[]'::JSONB),
    'rework_hours', coalesce((SELECT sum(hours) FROM public.job_rework_entries WHERE job_id = p_job AND organization_id = v_org AND kind = 'hours'), 0),
    'material_items', (SELECT count(*) FROM public.job_rework_entries WHERE job_id = p_job AND organization_id = v_org AND kind = 'material'),
    'material_cost', CASE WHEN v_costs THEN coalesce((SELECT sum(v.material_cost) FROM public.job_rework_entry_values v
                                                      JOIN public.job_rework_entries e ON e.id = v.entry_id
                                                      WHERE e.job_id = p_job AND e.organization_id = v_org), 0) END
  );
END
$$;
REVOKE ALL ON FUNCTION public.job_rework_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_rework_summary(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Failing an inspection, and the inspection that follows -----------------------------------------------
-- Records a failed inspection and opens the rework: the inspection record (as record_job_inspection writes it), then the rework
-- (reason, quantity affected, instructions, assigned to the workshop), then the job's stage becomes 'rework' and any release is
-- withdrawn for the job as a whole. Admin, and the office and workshop people an admin has made inspectors (034). The job row is
-- locked first (despatch locks it too).
--
-- WHAT failed is recorded against the part that failed, so only that part is held (job_line_release):
--   * a job made from a sales order: the order line (and the batch, if given). p_lines is a list of { line_id, quantity, batch }:
--     each line that failed, how many of it (null: all of that line) in the line's own units, and its batch (p_batch when not
--     given). One rework is opened per line; the other lines stay fully available. Without p_lines: p_quantity null fails all of
--     the job (a rework per order line, each for the whole line); a p_quantity is accepted only when the order has one line whose
--     quantity is the job's (the units then agree), and is that line's; otherwise the line has to be named.
--   * a job not made from an order: p_quantity of the job's own quantity (null: all of it), as before; p_lines is refused.
-- After a PART failure the rest of the job, which this inspection passed, may still go out. A rework that was finished and is
-- awaiting re-inspection is closed: as superseded when this failure covers its line (or the whole job), as passed when it doesn't
-- (this inspection passed the rest).
-- Returns { inspection_id, rework_id (the first), rework_ids, lines, result, release_decision, inspected_at, quantity_affected,
-- affects_all, quantity_available }.
DROP FUNCTION IF EXISTS public.fail_job_inspection(UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.fail_job_inspection(p_job UUID, p_notes TEXT, p_reason TEXT, p_quantity INTEGER, p_instructions TEXT, p_attachment_path TEXT, p_attachment_name TEXT,
                                                      p_lines JSONB DEFAULT NULL, p_batch TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_notes   TEXT := nullif(btrim(p_notes), '');
  v_reason  TEXT := nullif(btrim(p_reason), '');
  v_instr   TEXT := nullif(btrim(p_instructions), '');
  v_path    TEXT := nullif(btrim(p_attachment_path), '');
  v_batch   TEXT := nullif(btrim(p_batch), '');
  v_name    TEXT;
  v_job     RECORD;
  v_email   TEXT;
  v_who     TEXT;
  v_insp    UUID;
  v_rework  UUID;
  v_all     BOOLEAN;
  v_qty     INTEGER;
  v_order   UUID;
  v_so      TEXT;
  v_nlines  INTEGER := 0;
  v_line    public.sales_order_lines%ROWTYPE;
  v_item    JSONB;
  v_q       INTEGER;
  v_b       TEXT;
  v_whole   BOOLEAN := TRUE;
  v_seen    UUID[] := ARRAY[]::UUID[];
  v_targets JSONB := '[]'::JSONB;
  v_ids     UUID[] := ARRAY[]::UUID[];
  v_now     TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  -- Who may inspect (034): admins, and the people an admin has made inspectors.
  IF NOT public.has_org_role(ARRAY['admin'])
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_user AND m.organization_id = v_org AND m.active AND m.can_inspect) THEN
    RAISE EXCEPTION 'An admin has to make you an inspector before you can record inspections.' USING ERRCODE = '42501';
  END IF;
  IF v_notes IS NULL OR length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'Measured notes are required (up to 2000 characters).' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Give the reason it failed (up to 1000 characters).' USING ERRCODE = '22023';
  END IF;
  IF v_instr IS NULL OR length(v_instr) > 2000 THEN
    RAISE EXCEPTION 'Give the rework instructions for the workshop (up to 2000 characters).' USING ERRCODE = '22023';
  END IF;
  IF v_batch IS NOT NULL AND length(v_batch) > 100 THEN
    RAISE EXCEPTION 'The batch is at most 100 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) = 'null' THEN
    p_lines := NULL;
  END IF;
  IF p_lines IS NOT NULL AND (jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) > 200) THEN
    RAISE EXCEPTION 'The order lines that failed must be a list (200 at most).' USING ERRCODE = '22023';
  END IF;
  IF p_lines IS NOT NULL AND jsonb_array_length(p_lines) = 0 THEN
    p_lines := NULL;
  END IF;
  IF p_quantity IS NOT NULL AND p_quantity < 1 THEN
    RAISE EXCEPTION 'The quantity that failed must be at least 1.' USING ERRCODE = '22023';
  END IF;
  IF v_path IS NOT NULL THEN
    IF v_path NOT LIKE v_org::TEXT || '/' || p_job::TEXT || '/inspection/%' OR length(v_path) > 400 THEN
      RAISE EXCEPTION 'The attachment must be uploaded to this job''s inspection folder.' USING ERRCODE = '22023';
    END IF;
    v_name := left(coalesce(nullif(btrim(p_attachment_name), ''), regexp_replace(v_path, '^.*/', '')), 200);
  END IF;

  -- The job row is locked first: despatch (create_delivery_note, and a note going out) locks it too, so a failure and a despatch
  -- never interleave. Whichever comes second sees what the first did.
  SELECT id, job_no, finished_at, inspected_at, worksheet_version, quantity_required, converted_from_sales_order_id INTO v_job
  FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.finished_at IS NULL THEN
    RAISE EXCEPTION '% is not finished yet: finish the job before inspecting it.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_rework WHERE job_id = p_job AND status IN ('open', 'in_progress')) THEN
    RAISE EXCEPTION '% is already in rework: finish the rework before inspecting it again.', v_job.job_no USING ERRCODE = '22023';
  END IF;

  -- What failed: the order line(s) and batch for a job made from an order, the job's own quantity otherwise.
  SELECT s.id, s.so_number INTO v_order, v_so FROM public.sales_orders s WHERE s.id = v_job.converted_from_sales_order_id AND s.organization_id = v_org;
  IF v_order IS NOT NULL THEN
    -- The order's lines are made when first needed (034); the failure is recorded against them, so they are made now.
    PERFORM public.ensure_sales_order_lines(v_order);
    SELECT count(*) INTO v_nlines FROM public.sales_order_lines WHERE sales_order_id = v_order AND organization_id = v_org;
  END IF;
  IF p_lines IS NOT NULL THEN
    IF v_order IS NULL THEN
      RAISE EXCEPTION '% wasn''t made from a sales order: give the quantity that failed instead of order lines.', v_job.job_no USING ERRCODE = '22023';
    END IF;
    IF p_quantity IS NOT NULL THEN
      RAISE EXCEPTION 'Give the quantity that failed or the order lines that failed, not both.' USING ERRCODE = '22023';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
      IF jsonb_typeof(v_item) <> 'object' OR coalesce(v_item ->> 'line_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Every order line that failed needs its line_id.' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_line FROM public.sales_order_lines WHERE id = (v_item ->> 'line_id')::UUID AND sales_order_id = v_order AND organization_id = v_org;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A line isn''t on sales order %, which % was made from.', v_so, v_job.job_no USING ERRCODE = '22023';
      END IF;
      IF v_line.id = ANY (v_seen) THEN
        RAISE EXCEPTION 'A line is listed twice.' USING ERRCODE = '22023';
      END IF;
      v_seen := v_seen || v_line.id;
      IF v_item -> 'quantity' IS NULL OR jsonb_typeof(v_item -> 'quantity') = 'null' THEN
        -- All of that line (its quantity, when it is a whole number; otherwise the whole line is held by its own quantity).
        v_q := CASE WHEN v_line.quantity = trunc(v_line.quantity) AND v_line.quantity <= 2147483647 THEN v_line.quantity::INTEGER END;
      ELSE
        BEGIN
          v_q := (v_item ->> 'quantity')::INTEGER;
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION 'The quantity that failed on a line must be a whole number.' USING ERRCODE = '22023';
        END;
        IF v_q < 1 THEN
          RAISE EXCEPTION 'The quantity that failed must be at least 1.' USING ERRCODE = '22023';
        END IF;
        IF v_q > v_line.quantity THEN
          RAISE EXCEPTION 'More failed (%) than "%" has on the order (%).', v_q, left(v_line.description, 60), trim_scale(v_line.quantity) USING ERRCODE = '22023';
        END IF;
      END IF;
      v_b := coalesce(nullif(btrim(v_item ->> 'batch'), ''), v_batch);
      IF v_b IS NOT NULL AND length(v_b) > 100 THEN
        RAISE EXCEPTION 'The batch is at most 100 characters.' USING ERRCODE = '22023';
      END IF;
      v_whole := v_whole AND (v_q IS NULL OR v_q = v_line.quantity);
      v_targets := v_targets || jsonb_build_array(jsonb_build_object('line_id', v_line.id, 'quantity', v_q, 'batch', v_b, 'description', v_line.description));
    END LOOP;
    v_all := v_whole AND jsonb_array_length(v_targets) = v_nlines;
  ELSIF v_order IS NOT NULL THEN
    IF p_quantity IS NULL THEN
      -- All of the job: every line of the order, each whole.
      SELECT coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'description', l.description, 'batch', v_batch,
                                                   'quantity', CASE WHEN l.quantity = trunc(l.quantity) AND l.quantity <= 2147483647 THEN l.quantity::INTEGER END)
                                ORDER BY l.position, l.id), '[]'::JSONB)
        INTO v_targets FROM public.sales_order_lines l WHERE l.sales_order_id = v_order AND l.organization_id = v_org;
      v_all := TRUE;
    ELSE
      -- A quantity of the job: only when the order has one line and its quantity is the job's, so the units agree.
      IF v_nlines <> 1 THEN
        RAISE EXCEPTION '% was made from sales order %, which has % lines: choose the order line that failed and how many of it.', v_job.job_no, v_so, v_nlines USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_line FROM public.sales_order_lines WHERE sales_order_id = v_order AND organization_id = v_org;
      IF v_job.quantity_required IS NOT NULL AND v_job.quantity_required <> v_line.quantity THEN
        RAISE EXCEPTION '% has % on its worksheet but % on its sales order line, so a part failure can''t be matched to the order: say how many of the order line failed, or correct the quantity on the worksheet.',
          v_job.job_no, v_job.quantity_required, trim_scale(v_line.quantity) USING ERRCODE = '22023';
      END IF;
      IF p_quantity > v_line.quantity THEN
        RAISE EXCEPTION 'More failed (%) than the job''s quantity (%).', p_quantity, trim_scale(v_line.quantity) USING ERRCODE = '22023';
      END IF;
      v_targets := jsonb_build_array(jsonb_build_object('line_id', v_line.id, 'quantity', p_quantity, 'batch', v_batch, 'description', v_line.description));
      v_all := p_quantity = v_line.quantity;
    END IF;
  ELSE
    -- Not made from an order: the job's own quantity.
    IF p_quantity IS NOT NULL THEN
      IF v_job.quantity_required IS NULL THEN
        RAISE EXCEPTION '% has no quantity on its worksheet: enter it first, or fail all of the job.', v_job.job_no USING ERRCODE = '22023';
      END IF;
      IF p_quantity > v_job.quantity_required THEN
        RAISE EXCEPTION 'More failed (%) than the job''s quantity (%).', p_quantity, v_job.quantity_required USING ERRCODE = '22023';
      END IF;
    END IF;
    v_all := p_quantity IS NULL OR p_quantity = v_job.quantity_required;
    v_targets := jsonb_build_array(jsonb_build_object('line_id', NULL, 'quantity', coalesce(p_quantity, v_job.quantity_required), 'batch', v_batch));
  END IF;
  SELECT CASE WHEN bool_and(t ->> 'quantity' IS NOT NULL) THEN sum((t ->> 'quantity')::INTEGER) END INTO v_qty FROM jsonb_array_elements(v_targets) t;

  -- The name on the record is a display name, never an e-mail address (034's rule).
  SELECT p.email, nullif(btrim(regexp_replace(coalesce(p.full_name, ''), '[[:cntrl:]]+', ' ', 'g')), '') INTO v_email, v_who FROM public.user_profiles p WHERE p.id = v_user;
  IF v_who IS NULL OR position('@' IN v_who) > 0 THEN
    v_who := 'Inspector';
  END IF;
  v_who := left(v_who, 100);

  INSERT INTO public.job_inspections (organization_id, job_id, result, release_decision, measured_notes, attachment_path, attachment_name,
                                      concession_reason, inspector_id, inspector_name, inspected_at, worksheet_version)
  VALUES (v_org, p_job, 'fail', 'held', v_notes, v_path, v_name, NULL, v_user, v_who, v_now, v_job.worksheet_version)
  RETURNING id INTO v_insp;

  -- Reworks awaiting re-inspection: superseded where this failure covers them, passed where it doesn't (it passed the rest).
  UPDATE public.job_rework r SET status = 'closed', closed_by = v_user, closed_at = v_now,
         closed_how = CASE WHEN v_all OR r.sales_order_line_id IS NULL
                                OR r.sales_order_line_id IN (SELECT (t ->> 'line_id')::UUID FROM jsonb_array_elements(v_targets) t WHERE t ->> 'line_id' IS NOT NULL)
                           THEN 'superseded' ELSE 'passed' END
  WHERE r.job_id = p_job AND r.organization_id = v_org AND r.status = 'finished';
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_targets) LOOP
    INSERT INTO public.job_rework (organization_id, job_id, inspection_id, status, reason, instructions, affects_all, quantity_affected,
                                   sales_order_line_id, batch_ref, raised_by, raised_at)
    VALUES (v_org, p_job, v_insp, 'open', v_reason, v_instr, v_all, (v_item ->> 'quantity')::INTEGER,
            (v_item ->> 'line_id')::UUID, v_item ->> 'batch', v_user, v_now)
    RETURNING id INTO v_rework;
    v_ids := v_ids || v_rework;
  END LOOP;

  -- The job as a whole is back to awaiting a pass (the board shows Rework); what may still go out is decided per order line by
  -- job_line_release: after a PART failure the rest of the job, which this inspection passed, stays released.
  PERFORM set_config('quoteflow.job_inspection', p_job::TEXT, TRUE);
  PERFORM set_config('quoteflow.job_rework', p_job::TEXT, TRUE);
  UPDATE public.jobs SET inspected_at = NULL, inspected_by = NULL, stage = 'rework' WHERE id = p_job;
  PERFORM set_config('quoteflow.job_rework', '', TRUE);
  PERFORM set_config('quoteflow.job_inspection', '', TRUE);

  PERFORM security_audit.log_named_event(v_org, 'FAIL_INSPECTION', 'jobs', p_job::TEXT,
    jsonb_build_object('inspection_id', v_insp, 'rework_id', v_ids[1], 'rework_ids', to_jsonb(v_ids), 'job_no', v_job.job_no, 'reason', v_reason, 'quantity', v_qty,
                       'all_of_job', v_all, 'instructions', v_instr, 'assigned_to', 'workshop', 'batch', v_batch,
                       'lines', (SELECT jsonb_agg(jsonb_build_object('line_id', t -> 'line_id', 'line', left(t ->> 'description', 60), 'quantity', t -> 'quantity', 'batch', t -> 'batch'))
                                 FROM jsonb_array_elements(v_targets) t WHERE t ->> 'line_id' IS NOT NULL)));
  RETURN jsonb_build_object('inspection_id', v_insp, 'rework_id', v_ids[1], 'rework_ids', to_jsonb(v_ids), 'result', 'fail', 'release_decision', 'held', 'inspected_at', v_now,
                            'quantity_affected', v_qty, 'affects_all', v_all,
                            'lines', (SELECT jsonb_agg(jsonb_build_object('line_id', t -> 'line_id', 'quantity', t -> 'quantity', 'batch', t -> 'batch'))
                                      FROM jsonb_array_elements(v_targets) t WHERE t ->> 'line_id' IS NOT NULL),
                            'quantity_available', (SELECT s.available FROM public.job_release_state(p_job) s));
END
$$;
REVOKE ALL ON FUNCTION public.fail_job_inspection(UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fail_job_inspection(UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated;

-- record_job_inspection (034) with the rework rules. Same signature as 034 (with the worksheet version the inspector opened). A fail
-- goes to fail_job_inspection (for all of the job, with the notes as the reason, the way an older screen sends it). A pass is refused
-- while the rework is open or started (finish it first). A pass after the rework closes it as passed; an admin's concession releases
-- the job at any time and closes whatever rework is live. Either way only what is there is released: replacements for scrapped parts
-- that were never made stay held (job_release_state), and the result says how many are released and how many held. Otherwise
-- exactly as 034: who may inspect, the version check, certificates and checklist before a pass, and display names only.
CREATE OR REPLACE FUNCTION public.record_job_inspection(p_job UUID, p_result TEXT, p_notes TEXT, p_attachment_path TEXT, p_attachment_name TEXT, p_concession_reason TEXT, p_expected_version INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_notes  TEXT := nullif(btrim(p_notes), '');
  v_reason TEXT := nullif(btrim(p_concession_reason), '');
  v_path   TEXT := nullif(btrim(p_attachment_path), '');
  v_name   TEXT;
  v_job    RECORD;
  v_email  TEXT;
  v_who    TEXT;
  v_id     UUID;
  v_closed INTEGER;
  v_state  RECORD;
  v_now    TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_org_role(ARRAY['admin'])
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_user AND m.organization_id = v_org AND m.active AND m.can_inspect) THEN
    RAISE EXCEPTION 'An admin has to make you an inspector before you can record inspections.' USING ERRCODE = '42501';
  END IF;
  IF p_result IS NULL OR p_result NOT IN ('pass', 'fail', 'concession') THEN
    RAISE EXCEPTION 'The result must be pass, fail or concession.' USING ERRCODE = '22023';
  END IF;
  IF p_result = 'fail' THEN
    IF v_notes IS NULL OR length(v_notes) > 2000 THEN
      RAISE EXCEPTION 'Measured notes are required (up to 2000 characters).' USING ERRCODE = '22023';
    END IF;
    RETURN public.fail_job_inspection(p_job, v_notes, left(v_notes, 1000), NULL, 'See the inspection notes.', p_attachment_path, p_attachment_name);
  END IF;
  IF p_result = 'concession' AND NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can record a concession.' USING ERRCODE = '42501';
  END IF;
  IF v_notes IS NULL OR length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'Measured notes are required (up to 2000 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_result = 'concession' AND (v_reason IS NULL OR length(v_reason) > 500) THEN
    RAISE EXCEPTION 'A concession needs a reason (up to 500 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_result <> 'concession' THEN
    v_reason := NULL;
  END IF;
  IF v_path IS NOT NULL THEN
    IF v_path NOT LIKE v_org::TEXT || '/' || p_job::TEXT || '/inspection/%' OR length(v_path) > 400 THEN
      RAISE EXCEPTION 'The attachment must be uploaded to this job''s inspection folder.' USING ERRCODE = '22023';
    END IF;
    v_name := left(coalesce(nullif(btrim(p_attachment_name), ''), regexp_replace(v_path, '^.*/', '')), 200);
  END IF;

  SELECT id, job_no, finished_at, inspected_at, worksheet_version, stage, certs_required, checklist_required, checklist INTO v_job
  FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.finished_at IS NULL THEN
    RAISE EXCEPTION '% is not finished yet: finish the job before inspecting it.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  IF v_job.inspected_at IS NOT NULL THEN
    RAISE EXCEPTION '% has already been released.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  IF p_result = 'pass' AND EXISTS (SELECT 1 FROM public.job_rework WHERE job_id = p_job AND status IN ('open', 'in_progress')) THEN
    RAISE EXCEPTION '% is in rework: finish the rework, then inspect it again. Only an admin can release it on a concession before that.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS DISTINCT FROM v_job.worksheet_version THEN
    RAISE EXCEPTION '% changed after you opened it (the worksheet, quantity or a drawing revision). Open it again and inspect the current version.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  IF p_result = 'pass' THEN
    IF v_job.certs_required AND NOT EXISTS (SELECT 1 FROM public.job_files f WHERE f.job_id = p_job AND f.kind = 'cert') THEN
      RAISE EXCEPTION '% needs its material certificates attached before it can pass.', v_job.job_no USING ERRCODE = '22023';
    END IF;
    -- Keep these keys in step with CHECKLIST_ITEMS in lib/job-worksheet.ts (a unit test compares them).
    IF v_job.checklist_required AND EXISTS (
         SELECT 1 FROM unnest(ARRAY['sizes_checked', 'threads_check', 'parts_deburred', 'parts_marked', 'parts_clean', 'parts_counted']) AS k
         WHERE coalesce(v_job.checklist ->> k, '') <> 'true') THEN
      RAISE EXCEPTION '% needs every item on its checklist ticked before it can pass.', v_job.job_no USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT p.email, nullif(btrim(regexp_replace(coalesce(p.full_name, ''), '[[:cntrl:]]+', ' ', 'g')), '') INTO v_email, v_who FROM public.user_profiles p WHERE p.id = v_user;
  IF v_who IS NULL OR position('@' IN v_who) > 0 THEN
    v_who := 'Inspector';
  END IF;
  v_who := left(v_who, 100);

  INSERT INTO public.job_inspections (organization_id, job_id, result, release_decision, measured_notes, attachment_path, attachment_name,
                                      concession_reason, inspector_id, inspector_name, inspected_at, worksheet_version)
  VALUES (v_org, p_job, p_result, 'released', v_notes, v_path, v_name, v_reason, v_user, v_who, v_now, v_job.worksheet_version)
  RETURNING id INTO v_id;

  UPDATE public.job_rework SET status = 'closed', closed_by = v_user, closed_at = v_now,
                               closed_how = CASE WHEN p_result = 'concession' THEN 'concession' ELSE 'passed' END
  WHERE job_id = p_job AND organization_id = v_org AND status IN ('open', 'in_progress', 'finished');
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  PERFORM set_config('quoteflow.job_inspection', p_job::TEXT, TRUE);
  PERFORM set_config('quoteflow.job_rework', p_job::TEXT, TRUE);
  UPDATE public.jobs SET inspected_at = v_now, inspected_by = v_who, stage = 'complete' WHERE id = p_job;
  PERFORM set_config('quoteflow.job_rework', '', TRUE);
  PERFORM set_config('quoteflow.job_inspection', '', TRUE);

  -- What this release lets go out: the job less the replacements still to be made (scrapped and never remade).
  SELECT * INTO v_state FROM public.job_release_state(p_job);

  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'INSPECT_JOB', 'jobs', p_job::TEXT,
          jsonb_build_object('source', 'write_audit', 'inspection_id', v_id, 'job_no', v_job.job_no, 'result', p_result,
                             'release_decision', 'released', 'concession_reason', v_reason, 'attachment', v_name,
                             'after_rework', v_closed > 0, 'quantity_released', v_state.available, 'replacements_held', v_state.missing));
  RETURN jsonb_build_object('inspection_id', v_id, 'result', p_result, 'release_decision', 'released', 'inspected_at', v_now,
                            'quantity_released', v_state.available, 'replacements_held', v_state.missing);
END
$$;
REVOKE ALL ON FUNCTION public.record_job_inspection(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_job_inspection(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated;

-- What of a job may go out now (Rhys: hold only the part or batch in rework, not the whole job, so the rest can be despatched).
-- The job as a whole:
--   * released: the job was passed (or conceded), or only PART of it failed, which means that inspection passed the rest (while the
--     job's worksheet version is still the one inspected). A job never inspected, or failed as a whole, has nothing released;
--   * held: what live reworks (open, under way, or finished and awaiting re-inspection) cover, scrapped parts included, until a pass
--     or an admin's concession closes them; missing: replacements still to be made for parts scrapped in closed reworks (scrapped less
--     remade, less what was handed to a replacement rework). A pass or a concession releases only what is there, so these stay held;
--   * holding: anything at all is held or missing;
--   * blocked: FAIL CLOSED. When what is held can't be weighed (a job not made from an order, with no quantity on its worksheet and
--     replacements outstanding; or a rework on a job made from an order that is no longer tied to one of the order's lines), nothing
--     of the job may go out, and this says why and what to set;
--   * available: what may go out in all: for a job made from an order the sum over its lines (job_line_release); otherwise the job's
--     quantity less held less missing (null for a job with no quantity and nothing held: it goes out as a whole, as in 034); 0 when
--     not released or blocked.
-- The despatch functions and the delivery note guard read it (and job_line_release) with the job row locked FOR UPDATE.
-- Definer, for the caller's own company only: the guard runs as the signed-in user, and the workshop (which despatches) can't read
-- order lines, which would otherwise make the lines' holds invisible to it.
DROP FUNCTION IF EXISTS public.job_release_state(UUID);
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
  v_rel := (v_job.inspected_at IS NOT NULL AND v_live = 0) OR (v_live > 0 AND NOT v_whole);

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

-- What of a job made from a sales order may go out now, per order line: the line's quantity, what live reworks on THAT line hold
-- (scrapped parts included), the replacements still to make for it, and what may go out of it in all (available, counting what is
-- already on delivery notes is left to the caller). A failure on one line holds only that line: the others stay fully available.
-- available is 0 for every line while the job is not released (never inspected, or failed as a whole) or blocked (job_release_state).
-- batches: the batches recorded against what is held. No prices. Definer, the caller's own company only (as job_release_state).
-- Nothing for a job not made from an order.
CREATE OR REPLACE FUNCTION public.job_line_release(p_job UUID)
RETURNS TABLE (line_id UUID, line_position INTEGER, description TEXT, ordered NUMERIC, held NUMERIC, missing NUMERIC, available NUMERIC, batches TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_order UUID;
  v_state RECORD;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_job IS NULL THEN
    RETURN;
  END IF;
  SELECT j.converted_from_sales_order_id INTO v_order FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_order IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO v_state FROM public.job_release_state(p_job);
  RETURN QUERY
  SELECT sl.id, sl.position, sl.description, sl.quantity, least(h.held, sl.quantity), h.missing,
         CASE WHEN NOT v_state.released OR v_state.blocked IS NOT NULL THEN 0::NUMERIC ELSE greatest(sl.quantity - h.held - h.missing, 0) END,
         h.batches
  FROM public.sales_order_lines sl
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(coalesce(r.quantity_affected::NUMERIC, sl.quantity)) FILTER (WHERE r.status IN ('open', 'in_progress', 'finished')), 0) AS held,
           coalesce(sum(r.quantity_scrapped - r.quantity_remade - r.quantity_carried) FILTER (WHERE r.status = 'closed'), 0)::NUMERIC AS missing,
           string_agg(DISTINCT r.batch_ref, ', ') FILTER (WHERE r.batch_ref IS NOT NULL
                                                          AND (r.status <> 'closed' OR r.quantity_scrapped > r.quantity_remade + r.quantity_carried)) AS batches
    FROM public.job_rework r WHERE r.job_id = p_job AND r.sales_order_line_id = sl.id) h
  WHERE sl.sales_order_id = v_order AND sl.organization_id = v_org
  ORDER BY sl.position, sl.id;
END
$$;
REVOKE ALL ON FUNCTION public.job_line_release(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_line_release(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Working the rework -----------------------------------------------------------------------------------
-- Starts a rework that is waiting for the workshop (START_REWORK). Admin, office and workshop.
CREATE OR REPLACE FUNCTION public.start_job_rework(p_rework UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_rework public.job_rework%ROWTYPE;
  v_job_no TEXT;
  v_now    TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_rework FROM public.job_rework WHERE id = p_rework AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rework not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_rework.status <> 'open' THEN
    RAISE EXCEPTION 'This rework is %, so it can''t be started.', replace(v_rework.status, '_', ' ') USING ERRCODE = '22023';
  END IF;
  UPDATE public.job_rework SET status = 'in_progress', started_by = v_user, started_at = v_now WHERE id = p_rework;
  SELECT job_no INTO v_job_no FROM public.jobs WHERE id = v_rework.job_id;
  PERFORM security_audit.log_named_event(v_org, 'START_REWORK', 'jobs', v_rework.job_id::TEXT,
    jsonb_build_object('rework_id', p_rework, 'job_no', v_job_no, 'quantity', v_rework.quantity_affected));
  RETURN jsonb_build_object('rework_id', p_rework, 'status', 'in_progress', 'started_at', v_now);
END
$$;
REVOKE ALL ON FUNCTION public.start_job_rework(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_job_rework(UUID) TO authenticated;

-- Books hours and/or material against a started rework, apart from the job's own worksheet hours (RECORD_REWORK_COST). p_hours is hours
-- worked (more than 0, 999 at most); p_material says what was used; p_material_cost is its cost and may be given by admin and office
-- only. At least one of hours and material is required. Admin, office and workshop. Returns { hours_entry, material_entry }.
CREATE OR REPLACE FUNCTION public.record_rework_cost(p_rework UUID, p_hours NUMERIC, p_material TEXT, p_material_cost NUMERIC, p_note TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_user     UUID := auth.uid();
  v_material TEXT := nullif(btrim(p_material), '');
  v_note     TEXT := nullif(btrim(p_note), '');
  v_rework   public.job_rework%ROWTYPE;
  v_job_no   TEXT;
  v_hours_id UUID;
  v_mat_id   UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_material_cost IS NOT NULL AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only office and admin staff record what material cost.' USING ERRCODE = '42501';
  END IF;
  IF p_hours IS NULL AND v_material IS NULL THEN
    RAISE EXCEPTION 'Enter the hours worked, the material used, or both.' USING ERRCODE = '22023';
  END IF;
  IF p_hours IS NOT NULL AND (p_hours <= 0 OR p_hours > 999 OR p_hours <> round(p_hours, 2)) THEN
    RAISE EXCEPTION 'The hours must be more than 0 and at most 999, to two decimal places.' USING ERRCODE = '22023';
  END IF;
  IF v_material IS NOT NULL AND length(v_material) > 500 THEN
    RAISE EXCEPTION 'The material description is at most 500 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_material_cost IS NOT NULL AND (v_material IS NULL OR p_material_cost < 0 OR p_material_cost > 9999999 OR p_material_cost <> round(p_material_cost, 2)) THEN
    RAISE EXCEPTION 'A material cost needs the material it is for, and must be a sum of money of 0 or more.' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'The note is at most 500 characters.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_rework FROM public.job_rework WHERE id = p_rework AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rework not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_rework.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Hours and material are recorded while the rework is under way (this one is %).', replace(v_rework.status, '_', ' ') USING ERRCODE = '22023';
  END IF;
  IF p_hours IS NOT NULL THEN
    INSERT INTO public.job_rework_entries (organization_id, job_id, rework_id, kind, hours, description, created_by)
    VALUES (v_org, v_rework.job_id, p_rework, 'hours', p_hours, v_note, v_user) RETURNING id INTO v_hours_id;
  END IF;
  IF v_material IS NOT NULL THEN
    INSERT INTO public.job_rework_entries (organization_id, job_id, rework_id, kind, description, created_by)
    VALUES (v_org, v_rework.job_id, p_rework, 'material', v_material, v_user) RETURNING id INTO v_mat_id;
    IF p_material_cost IS NOT NULL THEN
      INSERT INTO public.job_rework_entry_values (entry_id, organization_id, material_cost) VALUES (v_mat_id, v_org, p_material_cost);
    END IF;
  END IF;
  SELECT job_no INTO v_job_no FROM public.jobs WHERE id = v_rework.job_id;
  PERFORM security_audit.log_named_event(v_org, 'RECORD_REWORK_COST', 'jobs', v_rework.job_id::TEXT,
    jsonb_build_object('rework_id', p_rework, 'job_no', v_job_no, 'hours', p_hours, 'material', v_material, 'material_cost', p_material_cost));
  RETURN jsonb_build_object('hours_entry', v_hours_id, 'material_entry', v_mat_id);
END
$$;
REVOKE ALL ON FUNCTION public.record_rework_cost(UUID, NUMERIC, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_rework_cost(UUID, NUMERIC, TEXT, NUMERIC, TEXT) TO authenticated;

-- Scraps part of the failed quantity, with a reason (SCRAP). The scrapped parts are not reworked; a replacement has to be made, so the
-- job's quantity "remaining to make" goes up by the same amount, and the quantity left to rework goes down. Not more than the failed
-- quantity can be scrapped in all. Allowed while the rework is waiting or under way. Admin, office and workshop.
-- Returns { quantity_scrapped, quantity_to_rework, remaining_to_make }.
CREATE OR REPLACE FUNCTION public.scrap_job_quantity(p_rework UUID, p_quantity INTEGER, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_reason TEXT := nullif(btrim(p_reason), '');
  v_rework public.job_rework%ROWTYPE;
  v_job_no TEXT;
  v_scrap  INTEGER;
  v_remain INTEGER;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'The quantity to scrap must be at least 1.' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give the reason for scrapping (up to 500 characters).' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_rework FROM public.job_rework WHERE id = p_rework AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rework not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_rework.status NOT IN ('open', 'in_progress') THEN
    RAISE EXCEPTION 'Parts are scrapped while the rework is waiting or under way (this one is %).', replace(v_rework.status, '_', ' ') USING ERRCODE = '22023';
  END IF;
  IF v_rework.quantity_affected IS NOT NULL AND v_rework.quantity_scrapped + p_quantity > v_rework.quantity_affected THEN
    RAISE EXCEPTION 'Only % of the failed quantity (%) is left to scrap.', v_rework.quantity_affected - v_rework.quantity_scrapped, v_rework.quantity_affected USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.job_rework_entries (organization_id, job_id, rework_id, kind, quantity, description, created_by)
  VALUES (v_org, v_rework.job_id, p_rework, 'scrap', p_quantity, v_reason, v_user);
  UPDATE public.job_rework SET quantity_scrapped = quantity_scrapped + p_quantity WHERE id = p_rework RETURNING quantity_scrapped INTO v_scrap;
  SELECT coalesce(sum(quantity_scrapped - quantity_remade - quantity_carried), 0) INTO v_remain FROM public.job_rework WHERE job_id = v_rework.job_id AND organization_id = v_org;
  SELECT job_no INTO v_job_no FROM public.jobs WHERE id = v_rework.job_id;
  PERFORM security_audit.log_named_event(v_org, 'SCRAP', 'jobs', v_rework.job_id::TEXT,
    jsonb_build_object('rework_id', p_rework, 'job_no', v_job_no, 'quantity', p_quantity, 'reason', v_reason, 'remaining_to_make', v_remain));
  RETURN jsonb_build_object('quantity_scrapped', v_scrap, 'quantity_to_rework', CASE WHEN v_rework.quantity_affected IS NULL THEN NULL ELSE v_rework.quantity_affected - v_scrap END,
                            'remaining_to_make', v_remain);
END
$$;
REVOKE ALL ON FUNCTION public.scrap_job_quantity(UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scrap_job_quantity(UUID, INTEGER, TEXT) TO authenticated;

-- Finishes a rework that is under way (FINISH_REWORK): the reworked parts are done and the job goes back to awaiting inspection (once
-- no rework on another of its order lines is still waiting or under way). The replacements made for scrapped parts are recorded as
-- they are, per finish: p_remade is how many were made this time, from 0 up to the replacements still outstanding (scrapped less
-- remade). It must be given when any are outstanding (null is taken as 0 only when none are). Each one made is an entry of kind
-- 'remake'. Replacements not made stay outstanding and their parts stay held, also after a pass or a concession (job_release_state),
-- until an admin or the office opens a replacement rework for them (open_replacement_rework). The job still needs a pass (or an
-- admin's concession) to be released. Admin, office and workshop. Returns { rework_id, status, finished_at, quantity_remade,
-- replacements_outstanding }.
CREATE OR REPLACE FUNCTION public.finish_job_rework(p_rework UUID, p_note TEXT, p_remade INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_note   TEXT := nullif(btrim(p_note), '');
  v_rework public.job_rework%ROWTYPE;
  v_job_no TEXT;
  v_hours  NUMERIC;
  v_owed   INTEGER;
  v_made   INTEGER;
  v_now    TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'The note is at most 500 characters.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_rework FROM public.job_rework WHERE id = p_rework AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rework not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_rework.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Only a rework that has been started can be finished (this one is %).', replace(v_rework.status, '_', ' ') USING ERRCODE = '22023';
  END IF;
  v_owed := v_rework.quantity_scrapped - v_rework.quantity_remade - v_rework.quantity_carried;
  IF p_remade IS NULL AND v_owed > 0 THEN
    RAISE EXCEPTION 'Say how many replacements were made for the scrapped parts (0 to %).', v_owed USING ERRCODE = '22023';
  END IF;
  v_made := coalesce(p_remade, 0);
  IF v_made < 0 OR v_made > v_owed THEN
    RAISE EXCEPTION 'Replacements made must be between 0 and % (the scrapped parts not yet remade).', v_owed USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.jobs WHERE id = v_rework.job_id AND organization_id = v_org FOR UPDATE;
  IF v_made > 0 THEN
    INSERT INTO public.job_rework_entries (organization_id, job_id, rework_id, kind, quantity, description, created_by)
    VALUES (v_org, v_rework.job_id, p_rework, 'remake', v_made, v_note, v_user);
  END IF;
  UPDATE public.job_rework SET status = 'finished', finished_by = v_user, finished_at = v_now, quantity_remade = quantity_remade + v_made WHERE id = p_rework;
  PERFORM set_config('quoteflow.job_rework', v_rework.job_id::TEXT, TRUE);
  -- Back to awaiting inspection once no rework on the job (another order line's) is still waiting or under way.
  UPDATE public.jobs SET stage = 'inspection' WHERE id = v_rework.job_id AND stage = 'rework'
    AND NOT EXISTS (SELECT 1 FROM public.job_rework o WHERE o.job_id = v_rework.job_id AND o.id <> p_rework AND o.status IN ('open', 'in_progress'));
  PERFORM set_config('quoteflow.job_rework', '', TRUE);
  SELECT job_no INTO v_job_no FROM public.jobs WHERE id = v_rework.job_id;
  SELECT coalesce(sum(hours), 0) INTO v_hours FROM public.job_rework_entries WHERE rework_id = p_rework AND kind = 'hours';
  PERFORM security_audit.log_named_event(v_org, 'FINISH_REWORK', 'jobs', v_rework.job_id::TEXT,
    jsonb_build_object('rework_id', p_rework, 'job_no', v_job_no, 'rework_hours', v_hours, 'quantity_scrapped', v_rework.quantity_scrapped,
                       'quantity_remade', v_rework.quantity_remade + v_made, 'replacements_outstanding', v_owed - v_made, 'note', v_note));
  RETURN jsonb_build_object('rework_id', p_rework, 'status', 'finished', 'finished_at', v_now,
                            'quantity_remade', v_rework.quantity_remade + v_made, 'replacements_outstanding', v_owed - v_made);
END
$$;
REVOKE ALL ON FUNCTION public.finish_job_rework(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_job_rework(UUID, TEXT, INTEGER) TO authenticated;

-- Makes the replacements a closed rework still owes (REOPEN_REWORK). A pass or a concession closes a rework with the replacements for
-- its scrapped parts not all made (a partial remake, or scrap then concede); they stay held (job_release_state), and finishing can't
-- record them any more. This opens a replacement rework for exactly what is outstanding, on the same order line and batch, marked as a
-- follow-up of the closed one, which hands its outstanding replacements over (quantity_carried), so nothing is counted twice. The new
-- rework is worked like any other: the workshop starts it, books hours and material, and finishes it recording the replacements made
-- (p_remade); the job is then inspected again, and only a pass (or an admin's concession) releases them. While it is open the job is
-- back in the rework stage and its sign-off is withdrawn, but the rest of it stays despatchable (only that line's replacements are
-- held). Admin and office. The job row is locked as by the other rework and despatch functions.
-- Returns { rework_id, follow_up_of, quantity, sales_order_line_id, batch_ref }.
CREATE OR REPLACE FUNCTION public.open_replacement_rework(p_rework UUID, p_instructions TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_instr  TEXT := nullif(btrim(p_instructions), '');
  v_rework public.job_rework%ROWTYPE;
  v_job    RECORD;
  v_owed   INTEGER;
  v_insp   UUID;
  v_new    UUID;
  v_line   TEXT;
  v_now    TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only office and admin staff reopen a rework for the outstanding replacements.' USING ERRCODE = '42501';
  END IF;
  IF v_instr IS NULL OR length(v_instr) > 2000 THEN
    RAISE EXCEPTION 'Give the instructions for making the replacements (up to 2000 characters).' USING ERRCODE = '22023';
  END IF;
  -- The job first, then the rework (as fail_job_inspection): despatch and inspection lock the same job row.
  SELECT j.id, j.job_no, j.finished_at INTO v_job FROM public.jobs j
  WHERE j.id = (SELECT r.job_id FROM public.job_rework r WHERE r.id = p_rework AND r.organization_id = v_org) AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rework not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_rework FROM public.job_rework WHERE id = p_rework AND organization_id = v_org FOR UPDATE;
  IF v_rework.status <> 'closed' THEN
    RAISE EXCEPTION 'This rework is still %: record the replacements made when it is finished.', replace(v_rework.status, '_', ' ') USING ERRCODE = '22023';
  END IF;
  v_owed := v_rework.quantity_scrapped - v_rework.quantity_remade - v_rework.quantity_carried;
  IF v_owed <= 0 THEN
    RAISE EXCEPTION 'No replacements are outstanding on this rework.' USING ERRCODE = '22023';
  END IF;
  IF v_rework.sales_order_line_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.job_rework r WHERE r.job_id = v_job.id AND r.sales_order_line_id = v_rework.sales_order_line_id AND r.status IN ('open', 'in_progress', 'finished')) THEN
      RAISE EXCEPTION '% already has a rework under way on that order line: finish it and have it inspected first.', v_job.job_no USING ERRCODE = '22023';
    END IF;
    SELECT left(l.description, 60) INTO v_line FROM public.sales_order_lines l WHERE l.id = v_rework.sales_order_line_id;
  ELSIF EXISTS (SELECT 1 FROM public.job_rework r WHERE r.job_id = v_job.id AND r.sales_order_line_id IS NULL AND r.status IN ('open', 'in_progress', 'finished')) THEN
    RAISE EXCEPTION '% already has a rework under way: finish it and have it inspected first.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  -- Inspected against the job as it is now: the newest inspection is the one the replacement rework follows (its version is checked
  -- as for any part held, job_release_state).
  SELECT i.id INTO v_insp FROM public.job_inspections i WHERE i.job_id = v_job.id AND i.organization_id = v_org ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1;

  UPDATE public.job_rework SET quantity_carried = quantity_carried + v_owed WHERE id = p_rework;
  INSERT INTO public.job_rework (organization_id, job_id, inspection_id, status, reason, instructions, affects_all, quantity_affected, quantity_scrapped,
                                 sales_order_line_id, batch_ref, follow_up_of, raised_by, raised_at)
  VALUES (v_org, v_job.id, v_insp, 'open', left('Replacements still to make: ' || v_rework.reason, 1000), v_instr, FALSE, v_owed, v_owed,
          v_rework.sales_order_line_id, v_rework.batch_ref, p_rework, v_user, v_now)
  RETURNING id INTO v_new;

  -- Back to the rework stage, the sign-off withdrawn until the replacements pass inspection (the rest of the job stays despatchable).
  PERFORM set_config('quoteflow.job_inspection', v_job.id::TEXT, TRUE);
  PERFORM set_config('quoteflow.job_rework', v_job.id::TEXT, TRUE);
  UPDATE public.jobs SET inspected_at = NULL, inspected_by = NULL, stage = 'rework' WHERE id = v_job.id;
  PERFORM set_config('quoteflow.job_rework', '', TRUE);
  PERFORM set_config('quoteflow.job_inspection', '', TRUE);

  PERFORM security_audit.log_named_event(v_org, 'REOPEN_REWORK', 'jobs', v_job.id::TEXT,
    jsonb_build_object('rework_id', v_new, 'follow_up_of', p_rework, 'job_no', v_job.job_no, 'quantity', v_owed, 'instructions', v_instr,
                       'line_id', v_rework.sales_order_line_id, 'line', v_line, 'batch', v_rework.batch_ref, 'assigned_to', 'workshop'));
  RETURN jsonb_build_object('rework_id', v_new, 'follow_up_of', p_rework, 'quantity', v_owed, 'sales_order_line_id', v_rework.sales_order_line_id, 'batch_ref', v_rework.batch_ref);
END
$$;
REVOKE ALL ON FUNCTION public.open_replacement_rework(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_replacement_rework(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Despatch by batch: only the part in rework is held --------------------------------------------------------
-- 034 decided despatch on the job as a whole (inspected_at). Rhys's decision: block only the part or batch in rework, so the rest can
-- go. The rules, all read with the job row locked FOR UPDATE (fail_job_inspection and the inspection functions lock it too, so a
-- failure and a despatch never interleave):
--   * what may go out of each order line is job_line_release's available: the line less what live reworks ON THAT LINE hold less the
--     replacements still to make for it, counting what is already on delivery notes. A failure of one line holds that line only;
--   * fail closed: when what is held can't be weighed (job_release_state's blocked), nothing goes out, with the reason and what to set;
--   * create_delivery_note refuses more than that, with the reason; a job never passed (or failed as a whole) can't be despatched;
--   * a note going out (sent, delivered or signed) is checked again: with what has already gone out on the same lines, it must fit;
--     a note with items not made from the job's order can't go out while any of the job is held;
--   * despatch_release shows, per line, what is held and what is available and why (next to 034's despatch_lines), so the screen
--     offers only what may go.
-- These replace create_delivery_note and the delivery note guard (034), with everything else in them unchanged.
CREATE OR REPLACE FUNCTION public.create_delivery_note(p_order UUID, p_job UUID, p_ship_date DATE, p_tax_date DATE, p_ship_via TEXT, p_notes TEXT, p_lines JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_order  public.sales_orders%ROWTYPE;
  v_job    public.jobs%ROWTYPE;
  v_job_id UUID := p_job;
  v_order_id UUID := p_order;
  v_item   JSONB;
  v_line   public.sales_order_lines%ROWTYPE;
  v_qty    NUMERIC;
  v_done   NUMERIC;
  v_seen   UUID[] := ARRAY[]::UUID[];
  v_dn     UUID;
  v_number TEXT;
  v_pos    INT := 0;
  v_state  RECORD;
  v_rel    RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Choose at least one line to despatch.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) > 200 THEN
    RAISE EXCEPTION 'Too many lines (200 at most).' USING ERRCODE = '22023';
  END IF;
  IF p_ship_date IS NULL OR p_tax_date IS NULL THEN
    RAISE EXCEPTION 'The ship date and tax date are required.' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_ship_via, '')) > 100 OR length(coalesce(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Ship via is at most 100 characters and notes 2000.' USING ERRCODE = '22023';
  END IF;

  IF v_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM public.jobs WHERE id = v_job_id AND organization_id = v_org FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_order_id IS NULL THEN
      v_order_id := v_job.converted_from_sales_order_id;
    END IF;
  END IF;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'There is no sales order to despatch from. Make the delivery note without an order instead.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_order FROM public.sales_orders WHERE id = v_order_id AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  -- The job this order became: what of it may go out is decided per order line (job_line_release, 037). The job row is locked FOR
  -- UPDATE before the release is read, and stays locked while the quantities are checked and the note is written, so a failure
  -- recorded at the same moment (fail_job_inspection locks the same row) comes wholly before or wholly after this note; marking the
  -- note sent checks it again.
  IF v_job_id IS NULL THEN
    v_job_id := v_order.converted_to_job_id;
    IF v_job_id IS NOT NULL THEN
      SELECT * INTO v_job FROM public.jobs WHERE id = v_job_id AND organization_id = v_org FOR UPDATE;
      IF NOT FOUND THEN
        v_job_id := NULL;
      END IF;
    END IF;
  ELSIF v_order.converted_to_job_id IS NOT NULL AND v_order.converted_to_job_id <> v_job_id THEN
    RAISE EXCEPTION 'That job isn''t the one made from sales order %.', v_order.so_number USING ERRCODE = '22023';
  END IF;

  PERFORM public.ensure_sales_order_lines(v_order_id);
  IF v_job_id IS NOT NULL THEN
    SELECT * INTO v_state FROM public.job_release_state(v_job_id);
    IF NOT v_state.released THEN
      RAISE EXCEPTION '% hasn''t passed inspection (or had a concession recorded by an admin), so it can''t be despatched.', v_job.job_no USING ERRCODE = '22023';
    END IF;
    -- Fail closed: what is held can't be weighed, so nothing goes out (the message says what to set).
    IF v_state.blocked IS NOT NULL THEN
      RAISE EXCEPTION '%', v_state.blocked USING ERRCODE = '22023';
    END IF;
  END IF;

  v_number := public.next_doc_number('DLN');
  PERFORM set_config('quoteflow.delivery_note_new', 'on', TRUE);
  INSERT INTO public.delivery_notes (organization_id, dn_number, customer, customer_id, sales_order_id, job_id, job_ref, delivery_date, ship_date, tax_date,
                                     ship_via, status, notes, created_by, updated_by)
  VALUES (v_org, v_number, v_order.customer, v_order.customer_id, v_order_id, v_job_id, v_job.job_no, p_ship_date, p_ship_date, p_tax_date,
          nullif(btrim(p_ship_via), ''), 'awaiting', nullif(btrim(p_notes), ''), v_user, v_user)
  RETURNING id INTO v_dn;
  PERFORM set_config('quoteflow.delivery_note_new', '', TRUE);

  PERFORM set_config('quoteflow.delivery_note', v_dn::TEXT, TRUE);
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR coalesce(v_item ->> 'line_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Every line needs a line_id and a quantity.' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_qty := (v_item ->> 'quantity')::NUMERIC;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Every line needs a quantity.' USING ERRCODE = '22023';
    END;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'The quantity to despatch must be more than zero.' USING ERRCODE = '22023';
    END IF;
    IF v_qty <> round(v_qty, 3) THEN
      RAISE EXCEPTION 'The quantity can have at most three decimal places.' USING ERRCODE = '22023';
    END IF;
    IF (v_item ->> 'line_id')::UUID = ANY (v_seen) THEN
      RAISE EXCEPTION 'A line is listed twice.' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || (v_item ->> 'line_id')::UUID;
    SELECT * INTO v_line FROM public.sales_order_lines WHERE id = (v_item ->> 'line_id')::UUID AND sales_order_id = v_order_id AND organization_id = v_org FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A line isn''t on sales order %.', v_order.so_number USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(sum(quantity), 0) INTO v_done FROM public.delivery_note_items WHERE sales_order_line_id = v_line.id;
    IF v_done + v_qty > v_line.quantity THEN
      RAISE EXCEPTION 'More than is left to despatch on "%": % ordered, % already on delivery notes, % left.',
        left(v_line.description, 60), trim_scale(v_line.quantity), trim_scale(v_done), trim_scale(v_line.quantity - v_done) USING ERRCODE = '22023';
    END IF;
    -- Held and missing parts of THIS line don't go out: the line can carry only what job_line_release says is available of it (its
    -- quantity less what is held in rework on it and its replacements still to make), counting what is already on delivery notes.
    -- A line it doesn't know is held whole (fail closed).
    IF v_job_id IS NOT NULL THEN
      SELECT * INTO v_rel FROM public.job_line_release(v_job_id) r WHERE r.line_id = v_line.id;
      IF NOT FOUND OR v_done + v_qty > v_rel.available THEN
        RAISE EXCEPTION 'Only % of "%" can go out now: % of it is held in rework or waiting for replacements on job %, and % is already on delivery notes.',
          trim_scale(greatest(coalesce(v_rel.available, 0) - v_done, 0)), left(v_line.description, 60), trim_scale(coalesce(v_rel.held + v_rel.missing, v_line.quantity)),
          v_job.job_no || CASE WHEN v_rel.batches IS NOT NULL THEN ' (batch ' || v_rel.batches || ')' ELSE '' END, trim_scale(v_done) USING ERRCODE = '22023';
      END IF;
    END IF;
    INSERT INTO public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity, sales_order_line_id)
    VALUES (v_org, v_dn, v_pos, v_line.description, v_qty, v_line.id);
    v_pos := v_pos + 1;
  END LOOP;
  PERFORM set_config('quoteflow.delivery_note', '', TRUE);
  RETURN jsonb_build_object('id', v_dn, 'dn_number', v_number);
END
$$;
REVOKE ALL ON FUNCTION public.create_delivery_note(UUID, UUID, DATE, DATE, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_delivery_note(UUID, UUID, DATE, DATE, TEXT, TEXT, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.delivery_notes_link_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_via      BOOLEAN;
  v_order    TEXT[] := ARRAY['pending', 'awaiting', 'despatched', 'delivered', 'signed'];
  v_old_rank INT;
  v_new_rank INT;
  v_free     TEXT[];
  v_job_no   TEXT;
  v_found    BOOLEAN := FALSE;
  v_job_id   UUID;
  v_job_so   UUID;
  v_state    RECORD;
  v_over     TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_via := current_setting('quoteflow.delivery_note_invoice', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('despatched', 'delivered', 'signed') THEN
      RAISE EXCEPTION 'Delivery note % has been sent out, so it can''t be deleted.', OLD.dn_number USING ERRCODE = '42501';
    END IF;
    IF OLD.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = OLD.invoice_id AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')) THEN
      RAISE EXCEPTION 'Delivery note % has been invoiced, so it can''t be deleted.', OLD.dn_number USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.invoice_id IS NOT NULL OR (NEW.job_id IS NOT NULL AND current_setting('quoteflow.delivery_note_new', TRUE) IS DISTINCT FROM 'on') THEN
      RAISE EXCEPTION 'A delivery note is linked to an order, a job or an invoice by the functions that make it.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id AND NOT v_via
     AND NOT (NEW.invoice_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = OLD.invoice_id)) THEN
    RAISE EXCEPTION 'A delivery note is linked to its invoice when the invoice is made from it.' USING ERRCODE = '42501';
  END IF;
  IF (NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id OR NEW.job_id IS DISTINCT FROM OLD.job_id)
     AND EXISTS (SELECT 1 FROM public.delivery_note_items i WHERE i.delivery_note_id = OLD.id AND i.sales_order_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A delivery note made from an order keeps its order and job.' USING ERRCODE = '42501';
  END IF;

  v_old_rank := coalesce(array_position(v_order, OLD.status), 0);
  v_new_rank := coalesce(array_position(v_order, NEW.status), 0);
  -- Once sent out, a note only moves forward (sent, delivered, signed); the signature and the e-mail record are the only things that
  -- can still be written, and a signed note keeps its signature. Everything else on it, and its items, is frozen.
  IF v_old_rank >= 3 THEN
    IF v_new_rank < v_old_rank THEN
      RAISE EXCEPTION 'Delivery note % has been sent out, so its status can only move forward.', OLD.dn_number USING ERRCODE = '42501';
    END IF;
    v_free := CASE WHEN OLD.status = 'signed' THEN ARRAY['emailed_at', 'updated_at', 'updated_by', 'invoice_id']
                   ELSE ARRAY['status', 'signed_by_name', 'signed_at', 'signature_notes', 'emailed_at', 'updated_at', 'updated_by', 'invoice_id'] END;
    IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
      RAISE EXCEPTION 'Delivery note % has been sent out, so it can''t be changed (only its signature and e-mail record can).', OLD.dn_number USING ERRCODE = '42501';
    END IF;
  ELSIF v_new_rank >= 3 THEN
    -- Going out: the job's release is checked again now, with the job row locked, so a release withdrawn after the note was made
    -- (a drawing revised, a result changed) stops it here. A note with no job, or whose job number matches none, is not held.
    -- Per order line (037): the job row is locked FOR UPDATE, as a failure locks it, and what may go out is read under that lock.
    IF NEW.job_id IS NOT NULL THEN
      SELECT j.id, j.job_no, j.converted_from_sales_order_id, TRUE INTO v_job_id, v_job_no, v_job_so, v_found FROM public.jobs j WHERE j.id = NEW.job_id AND j.organization_id = NEW.organization_id FOR UPDATE;
    ELSIF nullif(btrim(NEW.job_ref), '') IS NOT NULL THEN
      SELECT j.id, j.job_no, j.converted_from_sales_order_id, TRUE INTO v_job_id, v_job_no, v_job_so, v_found FROM public.jobs j WHERE j.job_no = btrim(NEW.job_ref) AND j.organization_id = NEW.organization_id ORDER BY j.created_at LIMIT 1 FOR UPDATE;
    END IF;
    IF coalesce(v_found, FALSE) THEN
      SELECT * INTO v_state FROM public.job_release_state(v_job_id);
      IF NOT v_state.released THEN
        RAISE EXCEPTION '% hasn''t passed inspection (or its release was withdrawn), so delivery note % can''t be sent out.', v_job_no, OLD.dn_number USING ERRCODE = '22023';
      END IF;
      -- Fail closed: what is held can't be weighed, so nothing of the job goes out.
      IF v_state.blocked IS NOT NULL THEN
        RAISE EXCEPTION '% Delivery note % can''t be sent out until then.', v_state.blocked, OLD.dn_number USING ERRCODE = '22023';
      END IF;
      IF v_state.holding THEN
        -- Part of the job is held: an item not made from the job's own order can't be weighed against it, so such a note waits.
        IF EXISTS (SELECT 1 FROM public.delivery_note_items i WHERE i.delivery_note_id = OLD.id
                     AND (i.sales_order_line_id IS NULL OR v_job_so IS NULL
                          OR NOT EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.id = i.sales_order_line_id AND l.sales_order_id = v_job_so))) THEN
          RAISE EXCEPTION 'Part of % is held in rework or waiting for replacements, so delivery note % can''t be sent out: make the note from the sales order, which counts what may go.', v_job_no, OLD.dn_number USING ERRCODE = '22023';
        END IF;
        -- What has gone out on each order line (other notes already sent) plus this note must fit what that line has available.
        SELECT string_agg(left(r.description, 60), ', ') INTO v_over
        FROM public.delivery_note_items i
        JOIN public.job_line_release(v_job_id) r ON r.line_id = i.sales_order_line_id
        WHERE i.delivery_note_id = OLD.id
          AND i.quantity + coalesce((SELECT sum(o.quantity) FROM public.delivery_note_items o JOIN public.delivery_notes d ON d.id = o.delivery_note_id
                                     WHERE o.sales_order_line_id = i.sales_order_line_id AND d.id <> OLD.id AND d.status IN ('despatched', 'delivered', 'signed')), 0)
              > r.available;
        IF v_over IS NOT NULL THEN
          RAISE EXCEPTION 'Part of % is held in rework or waiting for replacements, so delivery note % can''t be sent out with this much of: %.', v_job_no, OLD.dn_number, v_over USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS delivery_notes_link_guard ON public.delivery_notes;
CREATE TRIGGER delivery_notes_link_guard BEFORE INSERT OR UPDATE OR DELETE ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.delivery_notes_link_guard();

-- What of an order (or of the order a job came from) may go out now, per line: held (in rework on that line, waiting for its
-- replacements, or the job not yet passed), available, and why anything is held (reason, with the batch), next to despatch_lines
-- (034, unchanged: ordered, on notes, left). A function of its own, so that 034 can still be run again after this one (its
-- despatch_lines keeps its result). No prices. Admin, office and workshop, their own company only.
DROP FUNCTION IF EXISTS public.despatch_release(UUID, UUID);
CREATE OR REPLACE FUNCTION public.despatch_release(p_order UUID, p_job UUID DEFAULT NULL)
RETURNS TABLE (line_id UUID, held NUMERIC, available NUMERIC, reason TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_order UUID := p_order;
  v_job   UUID := p_job;
  v_rel   BOOLEAN;
  v_block TEXT;
  v_no    TEXT;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_order IS NULL AND p_job IS NOT NULL THEN
    SELECT j.converted_from_sales_order_id INTO v_order FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF v_order IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sales_orders s WHERE s.id = v_order AND s.organization_id = v_org) THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job IS NULL THEN
    SELECT s.converted_to_job_id INTO v_job FROM public.sales_orders s WHERE s.id = v_order AND s.organization_id = v_org;
  END IF;
  PERFORM public.ensure_sales_order_lines(v_order);
  IF v_job IS NOT NULL THEN
    SELECT s.released, s.blocked INTO v_rel, v_block FROM public.job_release_state(v_job) s;
    SELECT j.job_no INTO v_no FROM public.jobs j WHERE j.id = v_job;
  END IF;
  RETURN QUERY
  WITH l AS (
    SELECT sl.id, sl.position, sl.quantity,
           coalesce((SELECT sum(i.quantity) FROM public.delivery_note_items i WHERE i.sales_order_line_id = sl.id), 0)::NUMERIC AS done
    FROM public.sales_order_lines sl
    WHERE sl.sales_order_id = v_order AND sl.organization_id = v_org
  ), c AS (
    SELECT l.*, l.quantity - l.done AS left_over, r.held AS r_held, r.missing AS r_missing, r.batches,
           CASE WHEN v_job IS NULL THEN l.quantity - l.done
                WHEN NOT v_rel OR v_block IS NOT NULL THEN 0::NUMERIC
                ELSE greatest(least(l.quantity - l.done, coalesce(r.available, 0) - l.done), 0)
           END AS can_go
    FROM l LEFT JOIN public.job_line_release(v_job) r ON v_job IS NOT NULL AND r.line_id = l.id
  )
  SELECT c.id, greatest(c.left_over - c.can_go, 0), c.can_go,
         CASE WHEN c.left_over - c.can_go <= 0 THEN NULL
              WHEN v_job IS NULL THEN NULL
              WHEN v_block IS NOT NULL THEN v_block
              WHEN NOT v_rel THEN v_no || ' hasn''t passed inspection.'
              ELSE concat_ws('; ',
                     CASE WHEN c.r_held > 0 THEN trim_scale(c.r_held) || ' in rework' END,
                     CASE WHEN c.r_missing > 0 THEN trim_scale(c.r_missing) || ' replacement' || CASE WHEN c.r_missing = 1 THEN '' ELSE 's' END || ' still to make' END)
                   || CASE WHEN c.batches IS NOT NULL THEN ' (batch ' || c.batches || ')' ELSE '' END
         END
  FROM c
  ORDER BY c.position, c.id;
END
$$;
REVOKE ALL ON FUNCTION public.despatch_release(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.despatch_release(UUID, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. updated_at moves when a signed-in user changes a row ------------------------------------------------------
-- updated_at was set when a row was made and never moved, so issuing or paying an invoice, or finishing a job, left it at the creation
-- time (issue #3 item 8). One trigger function sets it to now() on every UPDATE that changes something else, for the browser roles
-- (anon, authenticated), which includes the definer functions they call (issue_invoice, record_invoice_payment, ...). The service role,
-- the database owner and the SQL editor are exempt: the importer keeps the dates it loads, and a repair leaves no false trace. An
-- update that changes nothing does not move it, one that sets updated_at itself keeps that value, and a row is moved at most once per transaction. Named to run last among the BEFORE triggers.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- A statement that set updated_at itself keeps its value, and a row already moved in this transaction is not moved again:
  -- replace_draft_quote (020, 021) hands its new updated_at back as the token the next correction must present, and then touches
  -- the row once more (the snapshots), so the stored value has to stay the one it returned.
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at OR OLD.updated_at >= transaction_timestamp() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs', 'invoices', 'quotes', 'sales_orders', 'purchase_orders', 'delivery_notes', 'credit_notes', 'rfqs', 'customers', 'suppliers'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zzzz_touch_updated_at ON public.%I', t);
    EXECUTE format('CREATE TRIGGER zzzz_touch_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', t);
  END LOOP;
END
$do$;
