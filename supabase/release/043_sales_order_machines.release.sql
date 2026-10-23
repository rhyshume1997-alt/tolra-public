-- 043_sales_order_machines.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 043: the machines a sales-order line will run on, carried to the job when the order converts, and editable after (M2).
--
-- Rhys's requirement C: "each line can have the machine(s) it will run on and a time estimate (hours). When the sales order converts to
-- a job, machine and estimate carry over and stay editable."
--
-- 1. sales_order_line_machines: one row per order, line and machine with the estimated hours. The order's lines are made lazily
--    (ensure_sales_order_lines, 034) and rebuilt when the order's value changes before anything is despatched, so a plan row keeps
--    the ORDER and the line's position (line_key) as well as the line itself (cleared if the line is rebuilt, re-attached by position
--    when the plan is next read or written). Prices never sit here: read by the four company roles, written only by
--    set_sales_order_line_machines (admin and office, the people who own sales orders) while the order is not yet converted.
-- 2. job_machines.source_so_line_id: where a carried row came from (the first line by position when several lines share a machine;
--    the full breakdown is in the CARRY_MACHINES audit event).
-- 3. carry_so_machines(order, job): the plan summed per machine into job_machines for the job the order was converted to (the job has
--    one row per machine, 042's rule; a machine's hours across the lines may not exceed 1000, refused when set). Carrying does NOT book
--    the schedule: an order has no start date, and a blind booking would clash; "Book on schedule" on the job does that in one step. Once
--    per job: a job with a plan, or carried to before, is refused, so what the workshop changed on the job is never undone by the order.
-- 4. convert_sales_order: the 034 body, plus the carry after the order is marked converted. Its result ({job_id, job_no, created}) is
--    unchanged; the app reads what was carried from job_machines.
-- 5. set_job_machines(job, machines, clash_override, clashes, override_reason): the plan on the job, editable by admin, office and
--    workshop after conversion (and on any job): hours changed, machines added or removed, and a machine booked on the schedule when a
--    start is given (a booking already made moves with it; its day plan is cleared when its start or hours change). Under the per-company
--    lock, clashes are found with the schedule's own rule (042: booking_intervals, booking_clashes); the app's list is a hint. Refused
--    unless an admin books anyway with a reason (audited with the bookings found, the actor and the time). The order's plan is not written back: after conversion the job is
--    the source of truth and the order shows its plan as ordered.
--
-- Every write starts with assert_privileged_aal() (033); the new table carries the admin_mfa and support_read_only statement triggers
-- (033, 036), the same-company triggers, and the audit trigger. Those two statement guards (here, on 042's job_machines and on 037's
-- job_rework) are re-made with a column list that leaves out the order-line link, which is cleared by referential action when the
-- order's lines are rebuilt inside a read path. Nothing about sales_order_lines, machine_bookings or jobs policies changes; the
-- worksheet-version fields are unchanged.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. The machines an order line runs on ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_order_line_machines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id),
  sales_order_id      UUID NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  sales_order_line_id UUID REFERENCES public.sales_order_lines(id) ON DELETE SET NULL,
  line_key            INTEGER NOT NULL CHECK (line_key >= 0),
  machine_id          UUID NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  estimated_hours     NUMERIC NOT NULL CHECK (estimated_hours >= 0 AND estimated_hours <= 1000),
  position            INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_line_machines_one_per_line UNIQUE (sales_order_id, line_key, machine_id)
);
CREATE INDEX IF NOT EXISTS idx_so_line_machines_org ON public.sales_order_line_machines (organization_id);
CREATE INDEX IF NOT EXISTS idx_so_line_machines_order ON public.sales_order_line_machines (sales_order_id, line_key, position);
CREATE INDEX IF NOT EXISTS idx_so_line_machines_machine ON public.sales_order_line_machines (machine_id);
CREATE INDEX IF NOT EXISTS idx_so_line_machines_line ON public.sales_order_line_machines (sales_order_line_id) WHERE sales_order_line_id IS NOT NULL;

ALTER TABLE public.sales_order_line_machines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sales_order_line_machines rbac select" ON public.sales_order_line_machines;
CREATE POLICY "sales_order_line_machines rbac select" ON public.sales_order_line_machines FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
-- The sales-orders section gate (036) applies, as it does to the order's lines.
DROP POLICY IF EXISTS "sales_order_line_machines section access" ON public.sales_order_line_machines;
CREATE POLICY "sales_order_line_machines section access" ON public.sales_order_line_machines AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.section_allowed('sales-orders'))) WITH CHECK ((SELECT public.section_allowed('sales-orders')));
REVOKE ALL ON public.sales_order_line_machines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sales_order_line_machines TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_sales_order_id ON public.sales_order_line_machines;
CREATE TRIGGER zz_same_org_sales_order_id BEFORE INSERT OR UPDATE ON public.sales_order_line_machines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('sales_orders', 'sales_order_id');
DROP TRIGGER IF EXISTS zz_same_org_sales_order_line_id ON public.sales_order_line_machines;
CREATE TRIGGER zz_same_org_sales_order_line_id BEFORE INSERT OR UPDATE ON public.sales_order_line_machines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('sales_order_lines', 'sales_order_line_id');
DROP TRIGGER IF EXISTS zz_same_org_machine_id ON public.sales_order_line_machines;
CREATE TRIGGER zz_same_org_machine_id BEFORE INSERT OR UPDATE ON public.sales_order_line_machines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machines', 'machine_id');

DROP TRIGGER IF EXISTS audit_sales_order_line_machines_changes ON public.sales_order_line_machines;
CREATE TRIGGER audit_sales_order_line_machines_changes AFTER INSERT OR UPDATE OR DELETE ON public.sales_order_line_machines
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- The read-only-support and second-step guards cover every write the office makes here, but NOT the line link being cleared: that
-- happens by referential action (ON DELETE SET NULL, a statement of its own even when no row matches) when ensure_sales_order_lines
-- rebuilds the lines inside a READ path (despatch_lines, 034), which 034 deliberately kept free of these guards. UPDATE OF lists every
-- column but sales_order_line_id.
DROP TRIGGER IF EXISTS support_read_only ON public.sales_order_line_machines;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE OF organization_id, sales_order_id, line_key, machine_id, estimated_hours, position, created_by, created_at
  ON public.sales_order_line_machines
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.sales_order_line_machines;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE OF organization_id, sales_order_id, line_key, machine_id, estimated_hours, position, created_by, created_at
  ON public.sales_order_line_machines
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Where a job's machine came from ---------------------------------------------------------------------
ALTER TABLE public.job_machines ADD COLUMN IF NOT EXISTS source_so_line_id UUID REFERENCES public.sales_order_lines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_job_machines_source_line ON public.job_machines (source_so_line_id) WHERE source_so_line_id IS NOT NULL;
DROP TRIGGER IF EXISTS zz_same_org_source_so_line_id ON public.job_machines;
CREATE TRIGGER zz_same_org_source_so_line_id BEFORE INSERT OR UPDATE ON public.job_machines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('sales_order_lines', 'source_so_line_id');
-- 042's statement guards on job_machines, re-made with a column list for the same reason as above: clearing source_so_line_id by
-- referential action when an order's lines are rebuilt (a read path) must not ask for the second step or refuse a support session.
-- Every other write to job_machines is guarded exactly as 042 left it.
DROP TRIGGER IF EXISTS support_read_only ON public.job_machines;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE OF organization_id, job_id, machine_id, estimated_hours, booking_id, position, created_by, created_at
  ON public.job_machines
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.job_machines;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE OF organization_id, job_id, machine_id, estimated_hours, booking_id, position, created_by, created_at
  ON public.job_machines
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
-- The same, found while testing this, for 037's job_rework.sales_order_line_id (ON DELETE SET NULL): its statement guards fired on that
-- referential clear, so an admin at aal1 in a company that requires the second step could not open Despatch or Inspection on an order
-- whose value had changed since its lines were made (a rebuild, not a write of theirs). Every other write to job_rework is guarded as 037
-- and 036 left it.
DROP TRIGGER IF EXISTS support_read_only ON public.job_rework;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE OF id, organization_id, job_id, inspection_id, status, reason, instructions, affects_all,
    quantity_affected, quantity_scrapped, quantity_remade, assigned_to, raised_by, raised_at, started_by, started_at, finished_by, finished_at, closed_by,
    closed_at, closed_how, batch_ref, follow_up_of, quantity_carried
  ON public.job_rework
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.job_rework;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE OF id, organization_id, job_id, inspection_id, status, reason, instructions, affects_all,
    quantity_affected, quantity_scrapped, quantity_remade, assigned_to, raised_by, raised_at, started_by, started_at, finished_by, finished_at, closed_by,
    closed_at, closed_how, batch_ref, follow_up_of, quantity_carried
  ON public.job_rework
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Setting the machines on an order line -------------------------------------------------------------
-- p_line: one of the order's lines (make them first with ensure_sales_order_lines). p_machines: [{"machine_id": uuid, "hours": number
-- 0..1000}], at most 10, each machine once, active and in the caller's company; replaces that line's plan. Refused once the order is
-- converted (hint order_converted): the job's plan is edited on the job. Rows whose line was rebuilt are re-attached by position first;
-- rows whose position no longer exists (the quote's lines collapsed to one summary line) are removed, so nothing stale is carried.
-- A machine's hours summed across the order's lines may not exceed 1000 (what one job_machines row can hold): refused here, not capped.
CREATE OR REPLACE FUNCTION public.set_sales_order_line_machines(p_order UUID, p_line UUID, p_machines JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_order    public.sales_orders%ROWTYPE;
  v_line     public.sales_order_lines%ROWTYPE;
  v_machines JSONB := coalesce(p_machines, '[]'::JSONB);
  v_elem     JSONB;
  v_machine  UUID;
  v_name     TEXT;
  v_hours    NUMERIC;
  v_pos      INTEGER := 0;
  v_seen     UUID[] := ARRAY[]::UUID[];
  v_before   JSONB;
  v_stale    JSONB;
  v_over     TEXT;
  v_done     JSONB := '[]'::JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can set the machines on a sales order' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_machines) <> 'array' OR jsonb_array_length(v_machines) > 10 THEN
    RAISE EXCEPTION 'Up to 10 machines per line.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status = 'converted' OR v_order.converted_to_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'This order has been converted to a job: change the machines on the job.' USING ERRCODE = '42501', HINT = 'order_converted';
  END IF;
  SELECT * INTO v_line FROM public.sales_order_lines WHERE id = p_line AND sales_order_id = p_order AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order line not found' USING ERRCODE = 'P0002';
  END IF;

  -- Lines rebuilt since the plan was made: re-attach by position.
  UPDATE public.sales_order_line_machines m SET sales_order_line_id = l.id
  FROM public.sales_order_lines l
  WHERE m.sales_order_id = p_order AND m.sales_order_line_id IS NULL AND l.sales_order_id = p_order AND l.position = m.line_key;

  WITH stale AS (
    DELETE FROM public.sales_order_line_machines m
    WHERE m.sales_order_id = p_order AND NOT EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.sales_order_id = p_order AND l.position = m.line_key)
    RETURNING m.line_key, m.machine_id, m.estimated_hours
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('line_key', s.line_key, 'machine_id', s.machine_id, 'hours', s.estimated_hours) ORDER BY s.line_key), '[]'::JSONB)
    INTO v_stale FROM stale s;

  SELECT coalesce(jsonb_agg(jsonb_build_object('machine_id', m.machine_id, 'hours', m.estimated_hours) ORDER BY m.position), '[]'::JSONB) INTO v_before
  FROM public.sales_order_line_machines m WHERE m.sales_order_id = p_order AND m.line_key = v_line.position;
  DELETE FROM public.sales_order_line_machines WHERE sales_order_id = p_order AND line_key = v_line.position;

  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(v_machines) AS e LOOP
    IF jsonb_typeof(v_elem) <> 'object' OR coalesce(jsonb_typeof(v_elem -> 'hours'), 'missing') <> 'number' OR coalesce(jsonb_typeof(v_elem -> 'machine_id'), 'missing') <> 'string' THEN
      RAISE EXCEPTION 'Each machine needs a machine and its hours.' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_machine := (v_elem ->> 'machine_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Each machine needs a machine and its hours.' USING ERRCODE = '22023';
    END;
    v_hours := (v_elem ->> 'hours')::NUMERIC;
    IF v_hours < 0 OR v_hours > 1000 THEN
      RAISE EXCEPTION 'Hours must be between 0 and 1000.' USING ERRCODE = '22023';
    END IF;
    IF v_machine = ANY (v_seen) THEN
      RAISE EXCEPTION 'Each machine can be added once.' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_machine;
    SELECT m.name INTO v_name FROM public.machines m WHERE m.id = v_machine AND m.organization_id = v_org AND coalesce(m.active, TRUE);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.sales_order_line_machines (organization_id, sales_order_id, sales_order_line_id, line_key, machine_id, estimated_hours, position, created_by)
    VALUES (v_org, p_order, v_line.id, v_line.position, v_machine, v_hours, v_pos, auth.uid());
    v_done := v_done || jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'hours', v_hours);
    v_pos := v_pos + 1;
  END LOOP;

  -- Across the order's lines, one machine may not carry more than one job_machines row can hold.
  SELECT string_agg(mc.name || ' (' || trim_scale(t.total)::TEXT || ' h)', ', ' ORDER BY mc.name) INTO v_over
  FROM (SELECT m.machine_id, sum(m.estimated_hours) AS total FROM public.sales_order_line_machines m WHERE m.sales_order_id = p_order GROUP BY m.machine_id HAVING sum(m.estimated_hours) > 1000) t
  JOIN public.machines mc ON mc.id = t.machine_id;
  IF v_over IS NOT NULL THEN
    RAISE EXCEPTION 'Across this order''s lines a machine would carry more than 1000 hours: %. Lower the hours.', v_over USING ERRCODE = '22023';
  END IF;

  PERFORM security_audit.log_named_event(v_org, 'SET_SO_LINE_MACHINES', 'sales_orders', p_order::TEXT,
    jsonb_build_object('so_number', v_order.so_number, 'line_id', v_line.id, 'line_key', v_line.position, 'line', left(v_line.description, 200),
                       'before', v_before, 'after', v_done, 'stale_removed', v_stale));
  RETURN jsonb_build_object('line_id', v_line.id, 'line_key', v_line.position, 'machines', v_done);
END
$$;
REVOKE ALL ON FUNCTION public.set_sales_order_line_machines(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sales_order_line_machines(UUID, UUID, JSONB) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Carrying the plan to the job --------------------------------------------------------------------------
-- The order's plan summed per machine into the job the order was converted to (and only that job). No booking is made. One carry per
-- job: a job that already has a machine plan, or was carried to before (CARRY_MACHINES event), is refused (hint job_has_plan), so a
-- machine the workshop took off the job after conversion can't be put back by carrying again. Rows whose line position no longer exists
-- (lines rebuilt to a summary line) are dropped first, never carried. Called by convert_sales_order; callable by admin and office for an
-- order converted before this migration (its job then gets the plan the order holds, once).
CREATE OR REPLACE FUNCTION public.carry_so_machines(p_order UUID, p_job UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_order   public.sales_orders%ROWTYPE;
  v_job_no  TEXT;
  v_base    INTEGER;
  v_count   INTEGER := 0;
  v_hours   NUMERIC := 0;
  v_done    JSONB := '[]'::JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can carry an order''s machines to its job' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT j.job_no INTO v_job_no FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.converted_to_job_id IS DISTINCT FROM p_job THEN
    RAISE EXCEPTION 'That job was not made from this order.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_machines jm WHERE jm.job_id = p_job)
     OR EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.organization_id = v_org AND a.action = 'CARRY_MACHINES' AND a.entity_table = 'jobs' AND a.entity_id = p_job::TEXT) THEN
    RAISE EXCEPTION 'This job already has its machine plan: change it on the job.' USING ERRCODE = '42501', HINT = 'job_has_plan';
  END IF;

  UPDATE public.sales_order_line_machines m SET sales_order_line_id = l.id
  FROM public.sales_order_lines l
  WHERE m.sales_order_id = p_order AND m.sales_order_line_id IS NULL AND l.sales_order_id = p_order AND l.position = m.line_key;
  IF EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.sales_order_id = p_order) THEN
    DELETE FROM public.sales_order_line_machines m
    WHERE m.sales_order_id = p_order AND NOT EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.sales_order_id = p_order AND l.position = m.line_key);
  END IF;

  v_base := 0;
  WITH plan AS (
    SELECT m.machine_id, sum(m.estimated_hours) AS hours,
           (array_agg(m.sales_order_line_id ORDER BY m.line_key, m.position))[1] AS source_line,
           min(m.line_key) AS first_line, min(m.position) AS first_pos,
           jsonb_agg(jsonb_build_object('line_key', m.line_key, 'line_id', m.sales_order_line_id, 'hours', m.estimated_hours) ORDER BY m.line_key, m.position) AS lines
    FROM public.sales_order_line_machines m
    WHERE m.sales_order_id = p_order AND m.organization_id = v_org
    GROUP BY m.machine_id
  ), carried AS (
    INSERT INTO public.job_machines (organization_id, job_id, machine_id, estimated_hours, booking_id, position, created_by, source_so_line_id)
    SELECT v_org, p_job, p.machine_id, p.hours, NULL, v_base + row_number() OVER (ORDER BY p.first_line, p.first_pos) - 1, auth.uid(), p.source_line
    FROM plan p
    ON CONFLICT (job_id, machine_id) DO NOTHING
    RETURNING machine_id, estimated_hours
  )
  SELECT count(*), coalesce(sum(c.estimated_hours), 0),
         coalesce(jsonb_agg(jsonb_build_object('machine_id', c.machine_id, 'machine', mc.name, 'hours', c.estimated_hours, 'lines', p.lines) ORDER BY p.first_line, p.first_pos), '[]'::JSONB)
    INTO v_count, v_hours, v_done
  FROM carried c JOIN plan p ON p.machine_id = c.machine_id JOIN public.machines mc ON mc.id = c.machine_id;

  IF v_count > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'CARRY_MACHINES', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job_no, 'so_number', v_order.so_number, 'order_id', p_order, 'machines', v_done));
  END IF;
  RETURN jsonb_build_object('machines_carried', v_count, 'hours_carried', v_hours, 'machines', v_done);
END
$$;
REVOKE ALL ON FUNCTION public.carry_so_machines(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.carry_so_machines(UUID, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Converting an order to its job, now carrying the machines -----------------------------------------
-- The 034 body (018, 033 job-number lock; admin or office), plus the carry once the order is marked converted. Its result ({job_id, job_no,
-- created}) is exactly as before; what was carried is read from job_machines (and the CARRY_MACHINES event).
CREATE OR REPLACE FUNCTION public.convert_sales_order(p_order UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_order   public.sales_orders%ROWTYPE;
  v_job     public.jobs%ROWTYPE;
  v_quote   TEXT;
  v_job_no  TEXT;
  v_num     TEXT;
  v_lines   TEXT;
  v_count   INT;
  v_qty     NUMERIC;
  v_spec    TEXT;
  v_now     TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can convert sales orders' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;

  -- Already converted (either side of the link): hand back that job, change nothing.
  SELECT j.* INTO v_job FROM public.jobs j
  WHERE j.organization_id = v_org AND (j.id = v_order.converted_to_job_id OR j.converted_from_sales_order_id = p_order)
  ORDER BY (j.id = v_order.converted_to_job_id) DESC NULLS LAST, j.created_at
  LIMIT 1;
  IF FOUND THEN
    IF v_order.converted_to_job_id IS DISTINCT FROM v_job.id THEN
      UPDATE public.sales_orders SET converted_to_job_id = v_job.id, converted_at = coalesce(converted_at, v_now) WHERE id = p_order;
    END IF;
    RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', FALSE);
  END IF;

  -- Job number: the quote's number when free, otherwise the next J number. The row lock above only serialises calls for
  -- ONE order; two orders for the same quote would both find J-1393 free. One lock per company, held to the end of this
  -- transaction, makes the "is it free" check and the insert a single step.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  v_quote := v_order.quote_ref;
  IF coalesce(v_quote, '') = '' AND v_order.quote_id IS NOT NULL THEN
    SELECT q.quote_ref INTO v_quote FROM public.quotes q WHERE q.id = v_order.quote_id AND q.organization_id = v_org;
  END IF;
  v_num := substring(coalesce(v_quote, '') FROM '^\s*[Qq][Uu][Oo][-\s]?(\d+)\s*$');
  IF v_num IS NOT NULL THEN
    v_job_no := 'J-' || CASE WHEN length(ltrim(v_num, '0')) < 4 THEN lpad(coalesce(nullif(ltrim(v_num, '0'), ''), '0'), 4, '0') ELSE ltrim(v_num, '0') END;
    IF EXISTS (SELECT 1 FROM public.jobs WHERE organization_id = v_org AND job_no = v_job_no) THEN
      v_job_no := NULL;
    END IF;
  END IF;
  IF v_job_no IS NULL THEN
    v_job_no := public.next_doc_number('J');
  END IF;

  -- What the workshop needs from the quote: descriptions and quantities, never prices.
  IF v_order.quote_id IS NOT NULL THEN
    SELECT string_agg('- ' || btrim(l.description) || ' x ' || trim_scale(l.quantity)::TEXT, E'\n' ORDER BY l.position, l.id),
           count(*), max(l.quantity)
      INTO v_lines, v_count, v_qty
    FROM public.quote_line_items l
    WHERE l.quote_id = v_order.quote_id AND l.organization_id = v_org;
  END IF;
  v_spec := 'Sales order ' || v_order.so_number
    || CASE WHEN v_order.delivery_date IS NOT NULL THEN '; customer delivery required ' || to_char(v_order.delivery_date, 'DD/MM/YYYY') ELSE '' END
    || '.'
    || CASE WHEN v_lines IS NOT NULL THEN E'\n' || coalesce(v_quote, 'Quote') || E':\n' || v_lines ELSE '' END;

  INSERT INTO public.jobs (
    organization_id, job_no, quote_id, customer, description, stage, due_date, status, specification, drawings,
    customer_po, quote_ref, date_received, date_required, quantity_required, converted_from_sales_order_id, converted_at)
  VALUES (
    v_org, v_job_no, v_order.quote_id, v_order.customer, 'Converted from ' || v_order.so_number, 'material',
    v_order.delivery_date, 'on_track', v_spec, '[]'::JSONB,
    v_order.so_number, nullif(v_quote, ''), v_order.order_date, v_order.delivery_date,
    CASE WHEN v_count = 1 AND v_qty >= 1 AND v_qty = trunc(v_qty) THEN v_qty::INT END,
    p_order, v_now)
  RETURNING * INTO v_job;

  INSERT INTO public.job_values (job_id, organization_id, value) VALUES (v_job.id, v_org, coalesce(v_order.total_value, 0));

  -- The quote's drawings travel with the job: a reference to each file attached to the quote (same company folder; nothing is
  -- copied), so the worksheet lists them and the shop floor can open them (job_files, section 3 below).
  IF coalesce(v_quote, '') <> '' THEN
    INSERT INTO public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, source_attachment_id, created_by)
    SELECT v_org, v_job.id, 'drawing', left(coalesce(nullif(btrim(regexp_replace(a.file_name, '\.[^.]*$', '')), ''), 'Drawing'), 200),
           left(coalesce(nullif(btrim(a.file_name), ''), 'Drawing'), 255), 'quote-attachments', a.file_path, a.id, auth.uid()
    FROM public.quote_attachments a
    WHERE a.organization_id = v_org AND a.quote_ref = v_quote AND split_part(a.file_path, '/', 1) = v_org::TEXT
    ORDER BY a.created_at, a.id
    ON CONFLICT (job_id, storage_bucket, storage_path) DO NOTHING;
  END IF;

  UPDATE public.sales_orders SET status = 'converted', converted_to_job_id = v_job.id, converted_at = v_now WHERE id = p_order;

  -- The machines and hours planned on the order's lines, summed per machine on the job (043). No booking: "Book on schedule" on the job.
  PERFORM public.carry_so_machines(p_order, v_job.id);

  RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public.convert_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_sales_order(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. Editing the machines on a job -------------------------------------------------------------------------
-- p_machines: [{"machine_id": uuid, "hours": number 0..1000, "start_at": timestamptz (optional)}], at most 10, each machine once, active
-- and in the caller's company; replaces the job's plan. A machine with a start is booked on the schedule from it (a booking already made
-- for that machine moves to it; its day plan is cleared when its start or hours change); without a start, a booking already made keeps
-- its start and takes the new hours. A booking that is running or complete is left alone (the plan's hours still change). A machine left
-- out is removed, with its booking when that booking is still only booked.
-- Lock order: the per-company job-no advisory lock FIRST (the same lock, as the first lock, as create_job and save_machine_booking take;
-- convert_sales_order holds its order row before it and never waits on a jobs row another transaction could hold), then the job's row,
-- then the booking rows it moves. Clashes are found under that lock with the schedule's own rule (042, booking_intervals: working days,
-- hours per day, day plans, Europe/London) against every active booking on the machine but the one that moves (booking_clashes); the
-- app's list (p_clashes, at most 200 entries and 20000 characters) is a hint, recorded only. Any clash: refused (42501, hint machine_clash)
-- unless the caller is an admin, p_clash_override is true and p_override_reason is given (3 to 500 characters); then audited as
-- OVERRIDE_MACHINE_CLASH on each booking written over (by save_machine_booking, with the reason, the bookings found, the actor and the time;
-- the job's SET_JOB_MACHINES event carries the same under "override"). Every booking write goes
-- through save_machine_booking / delete_machine_booking (042): under the same lock (re-entered), with their checks, and their rule that
-- the job's plan row FOLLOWS its booking (new hours go to the row; a removed booking leaves the row unlinked) is the only writer of a
-- linked row's hours, so the row and its booking can't drift and nothing is written twice. This function adds and removes rows, sets
-- their position, links a new booking, and writes the hours only of a row that has no booking write in this call.
DROP FUNCTION IF EXISTS public.set_job_machines(UUID, JSONB, BOOLEAN, JSONB);
CREATE OR REPLACE FUNCTION public.set_job_machines(p_job UUID, p_machines JSONB, p_clash_override BOOLEAN, p_clashes JSONB, p_override_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_job        public.jobs%ROWTYPE;
  v_machines   JSONB := coalesce(p_machines, '[]'::JSONB);
  v_clashes    JSONB := coalesce(p_clashes, '[]'::JSONB);
  v_reason     TEXT := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_admin      BOOLEAN;
  v_clash_nos  TEXT[] := ARRAY[]::TEXT[];
  v_found      TEXT[];
  v_conf       JSONB;
  v_conflicts  JSONB := '[]'::JSONB;
  v_plan       JSONB := '[]'::JSONB;
  v_elem       JSONB;
  v_machine    UUID;
  v_name       TEXT;
  v_hpd        NUMERIC;
  v_wdays      INTEGER[];
  v_hours      NUMERIC;
  v_start      TIMESTAMPTZ;
  v_eff_start  TIMESTAMPTZ;
  v_check      BOOLEAN;
  v_link       public.job_machines%ROWTYPE;
  v_booking    public.machine_bookings%ROWTYPE;
  v_booking_id UUID;
  v_link_id    UUID;
  v_bstatus    TEXT;
  v_saved      JSONB;
  v_gone       RECORD;
  v_mine       TSTZRANGE[];
  v_pos        INTEGER := 0;
  v_seen       UUID[] := ARRAY[]::UUID[];
  v_before     JSONB;
  v_done       JSONB := '[]'::JSONB;
  v_removed    JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can change a job''s machines' USING ERRCODE = '42501';
  END IF;
  v_admin := public.has_org_role(ARRAY['admin']);
  IF jsonb_typeof(v_machines) <> 'array' THEN
    RAISE EXCEPTION 'Machines must be a list.' USING ERRCODE = '22023';
  ELSIF jsonb_array_length(v_machines) > 10 THEN
    RAISE EXCEPTION 'Up to 10 machines per job.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_clashes) <> 'array' THEN
    RAISE EXCEPTION 'Clashes must be a list.' USING ERRCODE = '22023';
  ELSIF jsonb_array_length(v_clashes) > 200 THEN
    RAISE EXCEPTION 'Too many clashes listed (up to 200).' USING ERRCODE = '22023';
  ELSIF length(v_clashes::TEXT) > 20000 THEN
    RAISE EXCEPTION 'The clash list is too long (up to 20000 characters).' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give a reason for booking over another job (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'override_reason';
  END IF;

  -- Lock first (the company lock, as create_job and save_machine_booking take it first), then the job's row, then look, then write.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  -- Check every machine and find what another booking occupies over its time, before anything is written.
  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(v_machines) AS e LOOP
    IF jsonb_typeof(v_elem) <> 'object' OR coalesce(jsonb_typeof(v_elem -> 'hours'), 'missing') <> 'number' OR coalesce(jsonb_typeof(v_elem -> 'machine_id'), 'missing') <> 'string'
       OR (v_elem ? 'start_at' AND jsonb_typeof(v_elem -> 'start_at') NOT IN ('string', 'null')) THEN
      RAISE EXCEPTION 'Each machine needs a machine and its hours (and, to book it, a start).' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_machine := (v_elem ->> 'machine_id')::UUID;
      v_start := (v_elem ->> 'start_at')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Each machine needs a machine and its hours (and, to book it, a start).' USING ERRCODE = '22023';
    END;
    v_hours := (v_elem ->> 'hours')::NUMERIC;
    IF v_hours < 0 OR v_hours > 1000 THEN
      RAISE EXCEPTION 'Hours must be between 0 and 1000.' USING ERRCODE = '22023';
    END IF;
    IF v_start IS NOT NULL AND (v_start < TIMESTAMPTZ '2000-01-01 00:00:00+00' OR v_start >= TIMESTAMPTZ '2101-01-01 00:00:00+00') THEN
      RAISE EXCEPTION 'A start must be between 2000 and 2100.' USING ERRCODE = '22023';
    END IF;
    IF v_machine = ANY (v_seen) THEN
      RAISE EXCEPTION 'Each machine can be added once.' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_machine;
    SELECT m.name, m.hours_per_day, m.working_days INTO v_name, v_hpd, v_wdays
    FROM public.machines m WHERE m.id = v_machine AND m.organization_id = v_org AND coalesce(m.active, TRUE);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'P0002';
    END IF;

    -- What this row does to the schedule: a new booking (a start given), a booked booking moved or resized, or nothing.
    v_link_id := NULL; v_booking_id := NULL; v_bstatus := NULL; v_eff_start := v_start; v_check := v_start IS NOT NULL;
    SELECT * INTO v_link FROM public.job_machines jm WHERE jm.job_id = p_job AND jm.machine_id = v_machine;
    IF FOUND THEN
      v_link_id := v_link.id;
      IF v_link.booking_id IS NOT NULL THEN
        SELECT * INTO v_booking FROM public.machine_bookings b WHERE b.id = v_link.booking_id AND b.organization_id = v_org FOR UPDATE;
        IF FOUND THEN
          v_booking_id := v_booking.id;
          v_bstatus := v_booking.status;
          IF v_booking.status = 'booked' THEN
            v_eff_start := coalesce(v_start, v_booking.start_at);
            v_check := v_eff_start <> v_booking.start_at OR v_hours <> v_booking.estimated_hours;
          ELSE
            v_eff_start := NULL; -- running or complete: left as it is
            v_check := FALSE;
          END IF;
        END IF;
      END IF;
    END IF;

    v_found := NULL;
    IF v_check THEN
      -- The same inputs save_machine_booking will check with: the booking's real hours done; its day plan is cleared by that write, so none.
      v_mine := ARRAY(SELECT r FROM public.booking_intervals(v_eff_start, v_hours, v_hpd, v_wdays, NULL, 'booked',
                                                              CASE WHEN v_booking_id IS NOT NULL THEN coalesce(v_booking.hours_done, 0) ELSE 0 END, now()) AS r);
      SELECT jsonb_agg(jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'booking_id', c.booking_id, 'job_no', c.job_no,
                                          'intervals', (SELECT jsonb_agg(jsonb_build_array(lower(i), upper(i))) FROM unnest(c.intervals) AS i))),
             array_agg(DISTINCT coalesce(c.job_no, '(no job number)'))
        INTO v_conf, v_found
      FROM public.booking_clashes(v_org, v_machine, v_mine, v_booking_id, now()) AS c;
      IF v_found IS NOT NULL THEN
        v_clash_nos := v_clash_nos || v_found;
        v_conflicts := v_conflicts || v_conf;
      END IF;
    END IF;
    v_plan := v_plan || jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'hours', v_hours, 'start_at', v_eff_start, 'write', v_check,
                                           'link_id', v_link_id, 'booking_id', v_booking_id, 'booking_status', v_bstatus,
                                           'b_description', CASE WHEN v_booking_id IS NOT NULL THEN left(v_booking.description, 500) END,
                                           'b_done', CASE WHEN v_booking_id IS NOT NULL THEN v_booking.hours_done END,
                                           'b_notes', CASE WHEN v_booking_id IS NOT NULL THEN left(v_booking.notes, 2000) END,
                                           'clashes', to_jsonb(coalesce(v_found, ARRAY[]::TEXT[])));
  END LOOP;
  SELECT array_agg(DISTINCT n ORDER BY n) INTO v_clash_nos FROM unnest(v_clash_nos) AS n;
  v_clash_nos := coalesce(v_clash_nos, ARRAY[]::TEXT[]);

  -- Booking over another job: an admin's decision, with a reason, recorded; everyone else picks a free time.
  IF cardinality(v_clash_nos) > 0 THEN
    IF NOT (v_admin AND coalesce(p_clash_override, FALSE)) THEN
      RAISE EXCEPTION 'A machine is already booked at that time (%). Pick a free time (only an admin can book over another job).',
        array_to_string(v_clash_nos, ', ') USING ERRCODE = '42501', HINT = 'machine_clash';
    END IF;
    IF v_reason IS NULL OR length(v_reason) < 3 THEN
      RAISE EXCEPTION 'Give a reason for booking over another job (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'override_reason';
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('machine_id', jm.machine_id, 'hours', jm.estimated_hours, 'booking_id', jm.booking_id) ORDER BY jm.position), '[]'::JSONB)
    INTO v_before FROM public.job_machines jm WHERE jm.job_id = p_job;

  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(v_plan) AS e LOOP
    v_machine := (v_elem ->> 'machine_id')::UUID;
    v_hours := (v_elem ->> 'hours')::NUMERIC;
    v_eff_start := (v_elem ->> 'start_at')::TIMESTAMPTZ;
    v_link_id := (v_elem ->> 'link_id')::UUID;
    v_booking_id := (v_elem ->> 'booking_id')::UUID;
    IF v_link_id IS NULL THEN
      INSERT INTO public.job_machines (organization_id, job_id, machine_id, estimated_hours, booking_id, position, created_by)
      VALUES (v_org, p_job, v_machine, v_hours, NULL, v_pos, auth.uid())
      RETURNING id INTO v_link_id;
    END IF;
    IF v_booking_id IS NOT NULL THEN
      IF (v_elem ->> 'write')::BOOLEAN THEN
        -- Moved or resized through the schedule's own function: it re-checks under the same lock and its plan-follow writes the row's hours.
        -- A booking from before 042 may carry longer text than save_machine_booking takes: cut to its limits (job number 100, text 500, notes 2000).
        PERFORM public.save_machine_booking(v_booking_id, v_machine, p_job, left(v_job.job_no, 100), v_elem ->> 'b_description', v_eff_start, v_hours,
                                            (v_elem ->> 'b_done')::NUMERIC, 'booked', v_elem ->> 'b_notes', NULL, TRUE, p_clash_override, p_override_reason);
        UPDATE public.job_machines SET position = v_pos WHERE id = v_link_id AND position <> v_pos;
      ELSE
        UPDATE public.job_machines SET estimated_hours = v_hours, position = v_pos WHERE id = v_link_id AND (estimated_hours <> v_hours OR position <> v_pos);
      END IF;
    ELSIF v_eff_start IS NOT NULL THEN
      v_saved := public.save_machine_booking(NULL, v_machine, p_job, left(v_job.job_no, 100), left(coalesce(v_job.description, ''), 500), v_eff_start, v_hours,
                                             0, 'booked', NULL, NULL, FALSE, p_clash_override, p_override_reason);
      v_booking_id := (v_saved ->> 'id')::UUID;
      UPDATE public.job_machines SET estimated_hours = v_hours, booking_id = v_booking_id, position = v_pos WHERE id = v_link_id;
    ELSE
      UPDATE public.job_machines SET estimated_hours = v_hours, position = v_pos WHERE id = v_link_id AND (estimated_hours <> v_hours OR position <> v_pos);
    END IF;
    v_done := v_done || jsonb_build_object('machine_id', v_machine, 'machine', v_elem ->> 'machine', 'hours', v_hours, 'start_at', v_eff_start,
                                           'booking_id', v_booking_id, 'clashes', v_elem -> 'clashes');
    v_pos := v_pos + 1;
  END LOOP;

  -- Machines left out: off the job, and their booking off the schedule (delete_machine_booking) while it is only booked.
  v_removed := '[]'::JSONB;
  FOR v_gone IN
    SELECT jm.id, jm.machine_id, jm.estimated_hours, jm.booking_id, b.status
    FROM public.job_machines jm LEFT JOIN public.machine_bookings b ON b.id = jm.booking_id
    WHERE jm.job_id = p_job AND NOT (jm.machine_id = ANY (v_seen))
    ORDER BY jm.position
  LOOP
    DELETE FROM public.job_machines WHERE id = v_gone.id;
    IF v_gone.booking_id IS NOT NULL AND v_gone.status = 'booked' THEN
      PERFORM public.delete_machine_booking(v_gone.booking_id);
    END IF;
    v_removed := v_removed || jsonb_build_object('machine_id', v_gone.machine_id, 'hours', v_gone.estimated_hours, 'booking_id', v_gone.booking_id,
                                                 'booking_removed', v_gone.booking_id IS NOT NULL AND v_gone.status = 'booked');
  END LOOP;

  -- One OVERRIDE_MACHINE_CLASH per overridden booking, written by save_machine_booking on that booking (as the schedule does); the job's own
  -- event carries the override too (reason, bookings found, the bookings written), so the job's activity shows it without a second event.
  PERFORM security_audit.log_named_event(v_org, 'SET_JOB_MACHINES', 'jobs', p_job::TEXT,
    jsonb_build_object('job_no', v_job.job_no, 'before', v_before, 'after', v_done, 'removed', v_removed,
                       'override', CASE WHEN cardinality(v_clash_nos) > 0 THEN
                         jsonb_build_object('reason', v_reason, 'clashing_job_nos', to_jsonb(v_clash_nos), 'conflicts', v_conflicts, 'client_clashes', v_clashes,
                                            'booking_ids', (SELECT coalesce(jsonb_agg(d -> 'booking_id'), '[]'::JSONB) FROM jsonb_array_elements(v_done) d
                                                            WHERE jsonb_array_length(d -> 'clashes') > 0 AND (d ->> 'booking_id') IS NOT NULL),
                                            'actor_user_id', auth.uid(), 'at', now()) END));

  RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'machines', v_done, 'removed', v_removed);
END
$$;
REVOKE ALL ON FUNCTION public.set_job_machines(UUID, JSONB, BOOLEAN, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_job_machines(UUID, JSONB, BOOLEAN, JSONB, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 7. The second step (033) on every function this migration writes through ------------------------------
DO $do$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.set_sales_order_line_machines(uuid,uuid,jsonb)', 'public.carry_so_machines(uuid,uuid)',
    'public.convert_sales_order(uuid)', 'public.set_job_machines(uuid,jsonb,boolean,jsonb,text)']
  LOOP
    IF to_regprocedure(f) IS NULL OR position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure(f))) = 0 THEN
      RAISE EXCEPTION '043: % does not start with the second-step check', f;
    END IF;
  END LOOP;
END
$do$;

COMMIT;
