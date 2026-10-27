-- =====================================================================================================
-- 099: a draft invoice bills what was despatched, and the same despatched quantity is never on two invoices (Rhys, with ChatGPT and
-- Grok). NUMBERING (provisional): working number 099; the number is assigned at merge. Needs 059 (invoice_from_delivery_notes_draft),
-- 073 (replace_draft_invoice) and 081 (job_finish_draft_invoice, delivery_note_try_draft). Touches none of 082 to 095's objects.
--
-- THE RULE. An order line's quantity is billed as it is despatched. A draft invoice's quantity for an order line is what was sent out on
-- delivery notes and is not yet on another live invoice (a draft counts while it exists; a void or cancelled invoice frees what it
-- billed). A part despatch leaves the rest outstanding for a later invoice. Issued invoices and stored records are never changed.
--
-- WHAT CHANGES.
-- a. invoice_line_items.sales_order_line_id (new, nullable): the order line an invoice line bills; same company as the line.
--    invoice_line_items.line_kind (new): 'order' (it bills an order line, linked) or 'manual' (typed by hand: tooling, carriage, any
--    standalone charge; never linked). Lines made before 099 keep NULL (not classified); new lines default to 'manual'. Only the
--    drafting functions below put a link on a line (they set the transaction flag quoteflow.invoice_line_link while they write); any
--    other insert that carries a link (create_with_lines, a direct write) is refused 42501 'order_link_by_drafting'. A line's kind and
--    link are never changed in place (22023 'order_link_kept'): delete the line instead.
-- b. public.order_line_billing(line, except_invoice) (internal): ordered, despatched (items on notes sent out: despatched, delivered
--    or signed), invoiced and unbilled_notes for one order line. INVOICED is, over every live invoice (not void or cancelled;
--    except_invoice left out), the GREATEST of three figures per invoice: its live lines linked to the order line; for an invoice made
--    before 099 only (c), the order line's items on delivery notes on that invoice; and, for a Job Finish invoice made before 099 (c),
--    the order line's full quantity. Plus the order line's items on sent-out notes on no invoice that carry a hand-typed invoice
--    reference (invoiced elsewhere, as 059 treats them). So on an invoice made from 099 on only its linked lines count: reducing or
--    deleting a line of an unissued draft frees that quantity at once. UNBILLED_NOTES: the order line's items on sent-out notes on no
--    live invoice and with no hand-typed reference (each will be drafted itself). OUTSTANDING = despatched - invoiced (never below 0).
-- c. LEGACY (rows made before 099 stay unlinked; nothing is changed). Two snapshots, taken once (when the table is first made, so a
--    second run of this file adds nothing): public.invoice_notes_legacy, every invoice that had a delivery note on it, whose notes
--    count as invoiced on it (exact for every 059 draft and every "invoice from delivery notes"); public.invoice_job_finish_legacy,
--    every Job Finish draft 081 made (found from the append-only audit log, JOB_DRAFT_INVOICE drafted), which counts the whole order as
--    invoiced while it is live. So nothing billed before 099 can be billed again; a legacy invoice that billed less is still counted
--    at the full figure (the safe side: it blocks, never double-bills). Voiding such an invoice frees its quantities. Both tables:
--    internal, no API access.
-- d. The check, on every write of a linked invoice line by any role (invoice_lines_within_despatched, AFTER INSERT, UPDATE or DELETE):
--    under a per-order-line transaction lock (also taken by a reduction or a delete, so a raise waiting on it sees what it freed), an
--    increase on a live invoice must leave the order line's invoiced within its despatched, else 22023 'over_despatched'.
--    invoice_lines_kind_guard (BEFORE INSERT or UPDATE) enforces (a).
-- e. invoice_from_delivery_notes_draft (059's body, the lines step changed): one line per order line of the chosen notes' orders, linked,
--    for the order line's outstanding less what other sent-out notes not yet drafted hold. That is what the chosen notes took plus any
--    quantity freed from a draft of the order (the next draft takes it). A line with nothing left is left off; nothing left at all is
--    refused (22023 'nothing_outstanding'). Everything else as 059.
-- f. job_finish_draft_invoice (081's body, the lines step changed): bills each order line's outstanding (despatched, not invoiced),
--    linked, and puts the order's sent-out notes that are on no live invoice on the draft. OPEN QUESTION for the reviewers, one
--    branch (marked "OPEN QUESTION" below): a job finished with nothing despatched gets no draft ('nothing-despatched'); the delivery
--    note path drafts when it ships, and (j) lists the job meanwhile. As before: nothing for an internal job, a job without an order,
--    or a job with a live invoice.
-- g. delivery_note_try_draft (081's body, its job step changed): a note whose job has a live DRAFT goes on that draft and adds, as (e),
--    what it despatched plus any freed quantity of its order (invoice_add_delivery_note, internal); a note whose job has only issued
--    invoices gets a draft of its own when anything is left to bill, else (an 081 Job Finish invoice billed it) goes on the oldest live
--    one, as 081.
-- h. replace_draft_invoice (073's body, the lines step changed): a line may carry sales_order_line_id: one already on this draft, or
--    any line of the draft's orders (the orders of its linked lines, of its delivery notes, and of its job), so freed quantity can be
--    added back. If the draft has linked lines, a save that sends no link at all (an app build from before 099) is refused 22023
--    'reload_needed', so links are never dropped by an old screen. Quantities are held by (d).
-- i. public.draft_invoice_balances(invoice) (API, admin and office of the caller's company, invoices section): for each line of a
--    draft, its order line, ordered, despatched, on other invoices and the most this draft may bill; then each other line of the
--    draft's orders with quantity despatched and not invoiced (line_position NULL), which the editor offers to add.
--    public.draft_invoice_order_lines(invoice) (API, same callers) names the lines a draft may bill, for (h) and (i).
-- j. public.jobs_awaiting_despatch_or_invoice() (API, admin and office of the caller's company): every Complete job (not internal)
--    whose order still has quantity to despatch or despatched and not invoiced (or no order lines made yet): the dashboard's
--    "Needs attention".
-- MANUAL RECONCILIATION RULE (release notes; not enforceable in the database). The database holds every ORDER line to what was
-- despatched and not invoiced, and frees a quantity the moment it is reduced or deleted on an unissued draft. It cannot tell a
-- genuine manual charge (tooling, carriage, an extra) from the same goods typed back in by hand: if someone deletes an order line from
-- a draft and retypes it as a manual line, the goods are billed on the manual line AND are free to be billed again by the next draft of
-- the order. So: goods from an order are never typed as manual lines; to bill less, reduce or delete the order line; to bill freed goods,
-- use "Despatched, not yet invoiced" in the draft editor or let the next delivery note's draft take them. Before issuing, the person
-- issuing checks that no manual line describes goods from the order; "Complete jobs not yet fully despatched or invoiced" on the
-- dashboard lists every job whose despatched goods are not all on an invoice.
-- RLS: unchanged on every existing table; the new tables have RLS on and no policy or grant (definer code only), and the support
-- read-only trigger every company table carries.
--
-- GUARD (section 1): the four replaced functions must be 059's / 081's / 073's (or already 099's), md5 with every whitespace character
-- removed. Safe to run again (the legacy snapshots are taken only on the first run). SELF-CHECK (last section). Rollback: supabase/release/099_part_despatch_invoice_quantity.rollback.sql
-- (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard.
DO $$
DECLARE
  v_dn TEXT;
  v_jf TEXT;
  v_td TEXT;
  v_rd TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_dn FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_jf FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_td FROM pg_proc p WHERE p.oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_rd FROM pg_proc p WHERE p.oid = to_regprocedure('public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)');
  -- First of each pair: the predecessor's body (059, 081, 081, 073); second: this file's. All with every whitespace character removed.
  IF v_dn IS NULL OR v_dn NOT IN ('cff9113a2490bda9b901764974adfa0a', 'd467a505ab13a1cc1b1fa51cd8922f58') THEN
    RAISE EXCEPTION '099: public.invoice_from_delivery_notes_draft is not 059''s (md5 without whitespace %); stop and compare it first', coalesce(v_dn, 'missing');
  END IF;
  IF v_jf IS NULL OR v_jf NOT IN ('492fa39d76311ecfc78ce860a5f1160b', '8c4d3694cec4ac679916f916afc41985') THEN
    RAISE EXCEPTION '099: public.job_finish_draft_invoice is not 081''s (md5 without whitespace %); stop and compare it first', coalesce(v_jf, 'missing');
  END IF;
  IF v_td IS NULL OR v_td NOT IN ('52a9771fec832f0e20e9d780e7561caa', 'c1464c01f419d1866e7143a41076e7d0') THEN
    RAISE EXCEPTION '099: public.delivery_note_try_draft is not 081''s (md5 without whitespace %); stop and compare it first', coalesce(v_td, 'missing');
  END IF;
  IF v_rd IS NULL OR v_rd NOT IN ('bc56dd3aa75000c36f959955b71026ca', '8e8e4cc70d1cd7ad4c3268c49e52f305') THEN
    RAISE EXCEPTION '099: public.replace_draft_invoice is not 073''s (md5 without whitespace %); stop and compare it first', coalesce(v_rd, 'missing');
  END IF;
  IF to_regclass('public.sales_order_lines') IS NULL OR to_regclass('public.invoice_queue_events') IS NULL
     OR to_regprocedure('public.check_invoice_line(jsonb)') IS NULL OR to_regprocedure('public.enforce_same_org_parent()') IS NULL
     OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '099: needs 034, 035, 059, 073 and 081 applied first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The link from an invoice line to the order line it bills.
ALTER TABLE public.invoice_line_items ADD COLUMN IF NOT EXISTS sales_order_line_id UUID REFERENCES public.sales_order_lines(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_order_line ON public.invoice_line_items (sales_order_line_id) WHERE sales_order_line_id IS NOT NULL;
DROP TRIGGER IF EXISTS zz_same_org_sales_order_line_id ON public.invoice_line_items;
CREATE TRIGGER zz_same_org_sales_order_line_id BEFORE INSERT OR UPDATE OF sales_order_line_id, organization_id ON public.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('sales_order_lines', 'sales_order_line_id');
-- The line's kind: lines made before 099 keep NULL; every new line is 'order' (linked) or 'manual' (never linked).
ALTER TABLE public.invoice_line_items ADD COLUMN IF NOT EXISTS line_kind TEXT;
ALTER TABLE public.invoice_line_items ALTER COLUMN line_kind SET DEFAULT 'manual';
ALTER TABLE public.invoice_line_items DROP CONSTRAINT IF EXISTS invoice_line_items_line_kind;
ALTER TABLE public.invoice_line_items ADD CONSTRAINT invoice_line_items_line_kind
  CHECK (line_kind IS NULL OR (line_kind IN ('order', 'manual') AND (line_kind = 'order') = (sales_order_line_id IS NOT NULL)));

-- -----------------------------------------------------------------------------------------------------
-- 3. The legacy snapshots, taken once (when each table is first made): Job Finish drafts made by 081 (they billed the order's full
-- quantities), found from the append-only audit log; and every invoice that has a delivery note on it (its notes count as invoiced).
DO $do$
BEGIN
  IF to_regclass('public.invoice_job_finish_legacy') IS NULL THEN
    CREATE TABLE public.invoice_job_finish_legacy (
      invoice_id      UUID PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
      organization_id UUID NOT NULL REFERENCES public.organizations(id),
      sales_order_id  UUID NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE
    );
    INSERT INTO public.invoice_job_finish_legacy (invoice_id, organization_id, sales_order_id)
    SELECT DISTINCT ON (i.id) i.id, i.organization_id, s.id
    FROM security_audit.audit_log a
    JOIN public.invoices i ON i.id::TEXT = a.metadata ->> 'invoice_id' AND i.organization_id = a.organization_id
    JOIN public.sales_orders s ON s.id::TEXT = a.metadata ->> 'sales_order_id' AND s.organization_id = a.organization_id
    WHERE a.action = 'JOB_DRAFT_INVOICE' AND a.metadata ->> 'outcome' = 'drafted'
      AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items l WHERE l.invoice_id = i.id AND l.sales_order_line_id IS NOT NULL)
    ORDER BY i.id, a.created_at
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;
  IF to_regclass('public.invoice_notes_legacy') IS NULL THEN
    CREATE TABLE public.invoice_notes_legacy (
      invoice_id      UUID PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
      organization_id UUID NOT NULL REFERENCES public.organizations(id)
    );
    INSERT INTO public.invoice_notes_legacy (invoice_id, organization_id)
    SELECT DISTINCT i.id, i.organization_id FROM public.invoices i JOIN public.delivery_notes d ON d.invoice_id = i.id AND d.organization_id = i.organization_id
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;
END
$do$;
CREATE INDEX IF NOT EXISTS idx_invoice_job_finish_legacy_order ON public.invoice_job_finish_legacy (sales_order_id);
ALTER TABLE public.invoice_job_finish_legacy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_job_finish_legacy FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS support_read_only ON public.invoice_job_finish_legacy;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_job_finish_legacy
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
ALTER TABLE public.invoice_notes_legacy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_notes_legacy FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS support_read_only ON public.invoice_notes_legacy;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_notes_legacy
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();

-- -----------------------------------------------------------------------------------------------------
-- 4. What an order line has had despatched and invoiced (internal). See (b) and (c) in the header.
CREATE OR REPLACE FUNCTION public.order_line_billing(p_line UUID, p_except_invoice UUID)
RETURNS TABLE (ordered NUMERIC, despatched NUMERIC, invoiced NUMERIC, unbilled_notes NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH l AS (
    SELECT s.id, s.organization_id, s.sales_order_id, s.quantity FROM public.sales_order_lines s WHERE s.id = p_line
  ), live AS (
    SELECT i.id,
           EXISTS (SELECT 1 FROM public.invoice_notes_legacy n WHERE n.invoice_id = i.id) AS notes_count,
           EXISTS (SELECT 1 FROM public.invoice_job_finish_legacy f WHERE f.invoice_id = i.id AND f.sales_order_id = l.sales_order_id) AS full_order
    FROM public.invoices i, l
    WHERE i.organization_id = l.organization_id AND i.id IS DISTINCT FROM p_except_invoice
      AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')
      AND (EXISTS (SELECT 1 FROM public.invoice_line_items il WHERE il.invoice_id = i.id AND il.sales_order_line_id = l.id)
           OR EXISTS (SELECT 1 FROM public.invoice_notes_legacy n WHERE n.invoice_id = i.id)
           OR EXISTS (SELECT 1 FROM public.invoice_job_finish_legacy f WHERE f.invoice_id = i.id AND f.sales_order_id = l.sales_order_id))
  ), per_invoice AS (
    SELECT GREATEST(
      coalesce((SELECT sum(il.quantity) FROM public.invoice_line_items il WHERE il.invoice_id = v.id AND il.sales_order_line_id = l.id), 0),
      CASE WHEN v.notes_count
           THEN coalesce((SELECT sum(x.quantity) FROM public.delivery_notes d JOIN public.delivery_note_items x ON x.delivery_note_id = d.id
                          WHERE d.invoice_id = v.id AND x.sales_order_line_id = l.id), 0) ELSE 0 END,
      CASE WHEN v.full_order THEN l.quantity ELSE 0 END) AS q
    FROM live v, l
  )
  SELECT l.quantity,
         coalesce((SELECT sum(x.quantity) FROM public.delivery_note_items x JOIN public.delivery_notes d ON d.id = x.delivery_note_id
                   WHERE x.sales_order_line_id = l.id AND d.status IN ('despatched', 'delivered', 'signed')), 0),
         coalesce((SELECT sum(q) FROM per_invoice), 0)
         + coalesce((SELECT sum(x.quantity) FROM public.delivery_note_items x JOIN public.delivery_notes d ON d.id = x.delivery_note_id
                     WHERE x.sales_order_line_id = l.id AND d.status IN ('despatched', 'delivered', 'signed')
                       AND d.invoice_id IS NULL AND nullif(btrim(d.invoice_ref), '') IS NOT NULL), 0),
         coalesce((SELECT sum(x.quantity) FROM public.delivery_note_items x JOIN public.delivery_notes d ON d.id = x.delivery_note_id
                   WHERE x.sales_order_line_id = l.id AND d.status IN ('despatched', 'delivered', 'signed')
                     AND NOT (d.invoice_id IS NULL AND nullif(btrim(d.invoice_ref), '') IS NOT NULL)
                     AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = d.invoice_id
                                       AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled'))), 0)
  FROM l
$$;
REVOKE ALL ON FUNCTION public.order_line_billing(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 5. The per-order-line lock every writer of a linked line takes (in id order), so two can't both bill the same outstanding quantity.
CREATE OR REPLACE FUNCTION public.order_lines_lock(p_lines UUID[])
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_line UUID;
BEGIN
  FOR v_line IN SELECT DISTINCT x FROM unnest(coalesce(p_lines, ARRAY[]::UUID[])) AS x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('order-line-invoice:' || v_line::TEXT, 0));
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION public.order_lines_lock(UUID[]) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 6. The check on every linked invoice line, and the kind and link guard.
CREATE OR REPLACE FUNCTION public.invoice_lines_within_despatched()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_line  UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.sales_order_line_id ELSE NEW.sales_order_line_id END;
  v_all   RECORD;
  v_other RECORD;
  v_here  NUMERIC;
  v_desc  TEXT;
BEGIN
  IF v_line IS NULL THEN
    RETURN NULL;
  END IF;
  -- Every change to a linked line takes the order line's lock, a reduction or a delete too: a raise waiting on it then sees what it freed.
  PERFORM public.order_lines_lock(ARRAY[v_line]);
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id AND NEW.quantity <= OLD.quantity) THEN
    RETURN NULL; -- less (or the same) on the same invoice: never more than before
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = NEW.invoice_id AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')) THEN
    RETURN NULL;
  END IF;
  -- A new query after the lock: it sees what any writer that held the lock before has committed.
  SELECT * INTO v_all FROM public.order_line_billing(v_line, NULL);
  IF v_all.invoiced > v_all.despatched THEN
    SELECT * INTO v_other FROM public.order_line_billing(v_line, NEW.invoice_id);
    SELECT coalesce(sum(il.quantity), 0) INTO v_here FROM public.invoice_line_items il WHERE il.invoice_id = NEW.invoice_id AND il.sales_order_line_id = v_line;
    SELECT s.description INTO v_desc FROM public.sales_order_lines s WHERE s.id = v_line;
    RAISE EXCEPTION '"%": % despatched, % already on other invoices, so this invoice can bill at most % (it has %). The rest is billed when it is despatched.',
      v_desc, trim_scale(v_all.despatched), trim_scale(v_other.invoiced), trim_scale(GREATEST(v_all.despatched - v_other.invoiced, 0)), trim_scale(v_here)
      USING ERRCODE = '22023', HINT = 'over_despatched';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.invoice_lines_within_despatched() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoice_lines_within_despatched ON public.invoice_line_items;
CREATE TRIGGER invoice_lines_within_despatched AFTER INSERT OR DELETE OR UPDATE OF quantity, sales_order_line_id, invoice_id ON public.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION public.invoice_lines_within_despatched();

-- The kind and link of a line (see (a)): an order link only from the drafting functions; a manual line never linked; neither changed.
CREATE OR REPLACE FUNCTION public.invoice_lines_kind_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sales_order_line_id IS DISTINCT FROM OLD.sales_order_line_id OR NEW.line_kind IS DISTINCT FROM OLD.line_kind THEN
      RAISE EXCEPTION 'An invoice line keeps its kind and the order line it bills: delete the line instead.' USING ERRCODE = '22023', HINT = 'order_link_kept';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.sales_order_line_id IS NOT NULL THEN
    IF current_setting('quoteflow.invoice_line_link', TRUE) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'A line billing an order line is made from what was despatched (a delivery note, Job Finish or the draft editor), not typed in.'
        USING ERRCODE = '42501', HINT = 'order_link_by_drafting';
    END IF;
    NEW.line_kind := 'order'; -- a linked line is an order line, whatever was sent (a manual line is never linked)
  ELSE
    IF NEW.line_kind = 'order' THEN
      RAISE EXCEPTION 'An order line needs the order line it bills.' USING ERRCODE = '22023', HINT = 'order_line_needs_link';
    END IF;
    NEW.line_kind := coalesce(NEW.line_kind, 'manual');
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.invoice_lines_kind_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoice_lines_kind_guard ON public.invoice_line_items;
CREATE TRIGGER invoice_lines_kind_guard BEFORE INSERT OR UPDATE ON public.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION public.invoice_lines_kind_guard();

-- -----------------------------------------------------------------------------------------------------
-- 7. A sent-out note onto its job's DRAFT (internal): each line of the note's orders adds, as invoice_from_delivery_notes_draft bills,
-- what the note despatched plus any quantity freed from a draft of the order (to the draft's line for that order line, or a new line at
-- the order's price and VAT), the note goes on the draft, and the draft's totals are worked out again as check_document_totals reads
-- them (its carriage and VAT settings kept). Returns the quantity added.
CREATE OR REPLACE FUNCTION public.invoice_add_delivery_note(p_org UUID, p_invoice UUID, p_note UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inv    RECORD;
  v_g      RECORD;
  v_total  NUMERIC := 0;
  v_line   UUID;
  v_net    NUMERIC;
  v_vat    NUMERIC;
  v_first  RECORD;
  v_orders UUID[];
BEGIN
  SELECT i.id, i.status, i.vat_enabled, i.carriage_vat, coalesce(i.carriage, 0) AS carriage INTO v_inv
  FROM public.invoices i WHERE i.id = p_invoice AND i.organization_id = p_org FOR UPDATE;
  IF NOT FOUND OR lower(coalesce(v_inv.status, 'draft')) <> 'draft' THEN
    RAISE EXCEPTION 'The job''s draft invoice was not found.' USING ERRCODE = 'P0002';
  END IF;
  v_orders := ARRAY(SELECT DISTINCT l.sales_order_id FROM public.delivery_note_items x JOIN public.sales_order_lines l ON l.id = x.sales_order_line_id
                    WHERE x.delivery_note_id = p_note AND l.organization_id = p_org);
  PERFORM public.order_lines_lock(ARRAY(SELECT l.id FROM public.sales_order_lines l WHERE l.sales_order_id = ANY (v_orders)));
  PERFORM set_config('quoteflow.invoice_line_link', 'on', TRUE);
  FOR v_g IN
    SELECT l.id, l.description, l.unit_price, l.vat_pct, l.vat_exempt,
           GREATEST(b.despatched - b.invoiced - b.unbilled_notes
                    + coalesce((SELECT sum(x.quantity) FROM public.delivery_note_items x WHERE x.delivery_note_id = p_note AND x.sales_order_line_id = l.id), 0), 0) AS add
    FROM public.sales_order_lines l
    JOIN public.sales_orders o ON o.id = l.sales_order_id
    CROSS JOIN LATERAL public.order_line_billing(l.id, NULL) b
    WHERE l.sales_order_id = ANY (v_orders)
    ORDER BY o.so_number, l.position, l.id
  LOOP
    IF v_g.add > 0 THEN
      SELECT il.id INTO v_line FROM public.invoice_line_items il
      WHERE il.invoice_id = p_invoice AND il.sales_order_line_id = v_g.id ORDER BY il.position, il.id LIMIT 1;
      IF v_line IS NOT NULL THEN
        UPDATE public.invoice_line_items SET quantity = quantity + v_g.add WHERE id = v_line;
      ELSE
        INSERT INTO public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt, sales_order_line_id)
        SELECT p_org, p_invoice, coalesce(max(il.position) + 1, 0), v_g.description, v_g.add, v_g.unit_price, v_g.vat_pct, v_g.vat_exempt, v_g.id
        FROM public.invoice_line_items il WHERE il.invoice_id = p_invoice;
      END IF;
      v_total := v_total + v_g.add;
    END IF;
  END LOOP;
  PERFORM set_config('quoteflow.invoice_line_link', '', TRUE);

  PERFORM set_config('quoteflow.delivery_note_invoice', p_note::TEXT, TRUE);
  UPDATE public.delivery_notes SET invoice_id = p_invoice WHERE id = p_note;
  PERFORM set_config('quoteflow.delivery_note_invoice', '', TRUE);

  IF v_total > 0 THEN
    SELECT coalesce(sum(round(il.quantity * il.unit_price, 2)), 0),
           coalesce(sum(CASE WHEN il.vat_exempt THEN 0 ELSE round(round(il.quantity * il.unit_price, 2) * il.vat_pct / 100, 2) END), 0)
      INTO v_net, v_vat FROM public.invoice_line_items il WHERE il.invoice_id = p_invoice;
    v_vat := CASE WHEN v_inv.vat_enabled AND public.org_vat_registered(p_org)
                  THEN v_vat + CASE WHEN v_inv.carriage_vat THEN round(v_inv.carriage * public.org_standard_vat_rate(p_org) / 100, 2) ELSE 0 END
                  ELSE 0 END;
    SELECT il.description, il.quantity, il.unit_price INTO v_first FROM public.invoice_line_items il
    WHERE il.invoice_id = p_invoice AND il.quantity > 0 ORDER BY il.position, il.id LIMIT 1;
    UPDATE public.invoices SET subtotal = v_net, vat = v_vat, total = v_net + v_inv.carriage + v_vat,
      description = v_first.description, quantity = v_first.quantity, unit_price = v_first.unit_price
    WHERE id = p_invoice;
    PERFORM public.check_document_totals('invoices', p_invoice, p_org);
  END IF;
  RETURN v_total;
END
$$;
REVOKE ALL ON FUNCTION public.invoice_add_delivery_note(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 8. The draft from delivery notes: 059's body (supabase/migrations/059_delivery_note_auto_invoice.sql section 1); the lines step
-- (marked 099) bills, linked, each line of the chosen notes' orders: what the notes took plus any quantity freed from a draft.
CREATE OR REPLACE FUNCTION public.invoice_from_delivery_notes_draft(p_org UUID, p_notes UUID[], p_invoice_date DATE, p_due_date DATE, p_terms TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := p_org;
  v_ids     UUID[] := ARRAY(SELECT DISTINCT n FROM unnest(p_notes) AS n WHERE n IS NOT NULL);
  v_found   INT;
  v_dn      RECORD;
  v_cust    TEXT;
  v_reg     BOOLEAN := public.org_vat_registered(p_org);
  v_vat_on  BOOLEAN;
  v_flags   INT;
  v_orders  INT;
  v_jobs    INT;
  v_lines   JSONB;
  v_net     NUMERIC;
  v_vat     NUMERIC;
  v_so      RECORD;
  v_invoice UUID;
BEGIN
  -- create_with_lines writes the invoice into the session's company: the company named here must be that one.
  IF v_org IS NULL OR v_org IS DISTINCT FROM public.current_user_organization_id() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF coalesce(array_length(v_ids, 1), 0) = 0 OR array_length(v_ids, 1) > 50 THEN
    RAISE EXCEPTION 'Choose between one and fifty delivery notes.' USING ERRCODE = '22023';
  END IF;
  IF p_invoice_date IS NULL OR p_due_date IS NULL OR p_due_date < p_invoice_date THEN
    RAISE EXCEPTION 'Give an invoice date and a due date that is not before it.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.delivery_notes WHERE id = ANY (v_ids) AND organization_id = v_org ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_found FROM public.delivery_notes WHERE id = ANY (v_ids) AND organization_id = v_org;
  IF v_found <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'Delivery note not found' USING ERRCODE = 'P0002';
  END IF;

  FOR v_dn IN SELECT d.id, d.dn_number, d.status, d.customer, d.invoice_id, i.status AS invoice_status, i.invoice_ref
              FROM public.delivery_notes d LEFT JOIN public.invoices i ON i.id = d.invoice_id WHERE d.id = ANY (v_ids) ORDER BY d.dn_number LOOP
    IF v_dn.invoice_id IS NOT NULL AND lower(coalesce(v_dn.invoice_status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled') THEN
      RAISE EXCEPTION '% is already on %: it can''t be invoiced twice.', v_dn.dn_number, coalesce(v_dn.invoice_ref, 'a draft invoice') USING ERRCODE = '22023';
    END IF;
    IF v_dn.status NOT IN ('despatched', 'delivered', 'signed') THEN
      RAISE EXCEPTION '% hasn''t gone out yet: mark it as sent out before invoicing it.', v_dn.dn_number USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.delivery_note_items WHERE delivery_note_id = v_dn.id) THEN
      RAISE EXCEPTION '% has no items.', v_dn.dn_number USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.delivery_note_items WHERE delivery_note_id = v_dn.id AND sales_order_line_id IS NULL) THEN
      RAISE EXCEPTION '% has items that weren''t made from an order, so their prices aren''t known. Invoice it by hand.', v_dn.dn_number USING ERRCODE = '22023';
    END IF;
    IF public.delivery_note_draft_block(v_dn.id) = 'internal-job' THEN
      RAISE EXCEPTION '% is for an internal job, which is never invoiced.', v_dn.dn_number USING ERRCODE = '42501', HINT = 'internal_job';
    END IF;
  END LOOP;

  -- One customer: the same name, ignoring case and repeated spaces (the invoice takes one of the spellings).
  SELECT count(DISTINCT lower(regexp_replace(btrim(coalesce(d.customer, '')), '\s+', ' ', 'g'))), min(d.customer) INTO v_found, v_cust
  FROM public.delivery_notes d WHERE d.id = ANY (v_ids);
  IF v_found > 1 THEN
    RAISE EXCEPTION 'The delivery notes are for different customers: invoice each customer separately.' USING ERRCODE = '22023';
  END IF;

  SELECT count(DISTINCT o.vat_enabled), count(DISTINCT o.id), bool_or(o.vat_enabled) INTO v_flags, v_orders, v_vat_on
  FROM public.delivery_note_items i
  JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id
  JOIN public.sales_orders o ON o.id = l.sales_order_id
  WHERE i.delivery_note_id = ANY (v_ids);
  IF v_flags > 1 THEN
    RAISE EXCEPTION 'The orders disagree on VAT: invoice them separately.' USING ERRCODE = '22023';
  END IF;
  v_vat_on := coalesce(v_vat_on, FALSE) AND v_reg;

  -- 099: one invoice line per line of the chosen notes' orders, at the order's price and VAT, linked to it, under the order lines'
  -- locks: the order line's outstanding (despatched, not on a live invoice) less what other sent-out notes not yet drafted hold, so what
  -- the chosen notes took plus any quantity freed from a draft. A line with nothing left is left off; nothing left at all is refused.
  PERFORM public.order_lines_lock(ARRAY(SELECT l.id FROM public.sales_order_lines l WHERE l.sales_order_id IN (
    SELECT l2.sales_order_id FROM public.delivery_note_items i JOIN public.sales_order_lines l2 ON l2.id = i.sales_order_line_id WHERE i.delivery_note_id = ANY (v_ids))));
  SELECT jsonb_agg(jsonb_build_object('position', g.n - 1, 'description', g.description, 'quantity', g.quantity, 'unit_price', g.unit_price,
                                      'vat_pct', g.vat_pct, 'vat_exempt', g.vat_exempt, 'sales_order_line_id', g.line_id) ORDER BY g.n),
         coalesce(sum(round(g.quantity * g.unit_price, 2)), 0),
         coalesce(sum(CASE WHEN g.vat_exempt THEN 0 ELSE round(round(g.quantity * g.unit_price, 2) * g.vat_pct / 100, 2) END), 0)
    INTO v_lines, v_net, v_vat
  FROM (
    SELECT row_number() OVER (ORDER BY c.so_number, c.position, c.line_id) AS n, c.*
    FROM (
      SELECT o.so_number, l.position, l.id AS line_id, l.description,
             GREATEST(b.despatched - b.invoiced - b.unbilled_notes
                      + coalesce((SELECT sum(i.quantity) FROM public.delivery_note_items i WHERE i.delivery_note_id = ANY (v_ids) AND i.sales_order_line_id = l.id), 0), 0) AS quantity,
             l.unit_price, l.vat_pct, l.vat_exempt
      FROM public.sales_order_lines l
      JOIN public.sales_orders o ON o.id = l.sales_order_id
      CROSS JOIN LATERAL public.order_line_billing(l.id, NULL) b
      WHERE l.sales_order_id IN (SELECT l2.sales_order_id FROM public.delivery_note_items i JOIN public.sales_order_lines l2 ON l2.id = i.sales_order_line_id
                                 WHERE i.delivery_note_id = ANY (v_ids))
    ) c
    WHERE c.quantity > 0
  ) g;
  IF v_lines IS NULL THEN
    RAISE EXCEPTION 'Everything on % is already on another invoice: nothing is left to bill.',
      (SELECT string_agg(d.dn_number, ', ' ORDER BY d.dn_number) FROM public.delivery_notes d WHERE d.id = ANY (v_ids))
      USING ERRCODE = '22023', HINT = 'nothing_outstanding';
  END IF;
  v_vat := CASE WHEN v_vat_on THEN v_vat ELSE 0 END;

  SELECT o.quote_ref, o.customer_po INTO v_so
  FROM public.sales_orders o WHERE o.id = (SELECT d.sales_order_id FROM public.delivery_notes d WHERE d.id = ANY (v_ids) ORDER BY d.dn_number LIMIT 1);
  SELECT count(DISTINCT d.job_id) INTO v_jobs FROM public.delivery_notes d WHERE d.id = ANY (v_ids) AND d.job_id IS NOT NULL;

  PERFORM set_config('quoteflow.invoice_line_link', 'on', TRUE);
  v_invoice := public.create_with_lines(
    'invoices',
    jsonb_strip_nulls(jsonb_build_object(
      'customer', v_cust, 'description', v_lines -> 0 ->> 'description', 'quantity', (v_lines -> 0 ->> 'quantity')::NUMERIC,
      'unit_price', (v_lines -> 0 ->> 'unit_price')::NUMERIC,
      'subtotal', v_net, 'carriage', 0, 'vat', v_vat, 'total', v_net + v_vat, 'vat_enabled', v_vat_on, 'carriage_vat', v_vat_on,
      'invoice_date', p_invoice_date, 'due_date', p_due_date, 'terms', nullif(btrim(p_terms), ''),
      'quote_ref', CASE WHEN v_orders = 1 THEN v_so.quote_ref END, 'customer_po', CASE WHEN v_orders = 1 THEN v_so.customer_po END,
      'job_id', CASE WHEN v_jobs = 1 THEN (SELECT d.job_id FROM public.delivery_notes d WHERE d.id = ANY (v_ids) AND d.job_id IS NOT NULL LIMIT 1) END,
      'status', 'draft', 'amount_paid', 0)),
    'invoice_line_items', 'invoice_id', v_lines);
  PERFORM set_config('quoteflow.invoice_line_link', '', TRUE);

  FOR v_dn IN SELECT unnest(v_ids) AS id LOOP
    PERFORM set_config('quoteflow.delivery_note_invoice', v_dn.id::TEXT, TRUE);
    UPDATE public.delivery_notes SET invoice_id = v_invoice WHERE id = v_dn.id;
  END LOOP;
  PERFORM set_config('quoteflow.delivery_note_invoice', '', TRUE);
  RETURN jsonb_build_object('invoice_id', v_invoice, 'subtotal', v_net, 'vat', v_vat, 'total', v_net + v_vat, 'lines', jsonb_array_length(v_lines));
END
$$;
REVOKE ALL ON FUNCTION public.invoice_from_delivery_notes_draft(UUID, UUID[], DATE, DATE, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 9. The draft made when a job is finished: 081's body (supabase/migrations/081_job_flow_release.sql section 9); the lines step
-- (marked 099) bills each order line's outstanding quantity (despatched, not on another live invoice), linked, and puts the order's
-- sent-out notes that are on no live invoice on it. Never raises (as 081).
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
  v_terms   TEXT;
  v_days    INT;
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_invoice UUID;
  v_note    RECORD;
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
    -- 099: each order line's outstanding quantity (despatched, not on another live invoice), under the order lines' locks, linked.
    PERFORM public.order_lines_lock(ARRAY(SELECT l.id FROM public.sales_order_lines l WHERE l.sales_order_id = v_order AND l.organization_id = p_org));
    SELECT jsonb_agg(jsonb_build_object('position', g.n - 1, 'description', g.description, 'quantity', g.quantity, 'unit_price', g.unit_price,
                                        'vat_pct', g.vat_pct, 'vat_exempt', g.vat_exempt, 'sales_order_line_id', g.id) ORDER BY g.n),
           coalesce(sum(round(g.quantity * g.unit_price, 2)), 0),
           coalesce(sum(CASE WHEN g.vat_exempt THEN 0 ELSE round(round(g.quantity * g.unit_price, 2) * g.vat_pct / 100, 2) END), 0)
      INTO v_lines, v_net, v_vat
    FROM (SELECT row_number() OVER (ORDER BY c.position, c.id) AS n, c.*
          FROM (SELECT l.id, l.position, l.description, GREATEST(b.despatched - b.invoiced, 0) AS quantity, l.unit_price, l.vat_pct, l.vat_exempt
                FROM public.sales_order_lines l CROSS JOIN LATERAL public.order_line_billing(l.id, NULL) b
                WHERE l.sales_order_id = v_order AND l.organization_id = p_org AND l.quantity > 0) c
          WHERE c.quantity > 0) g;
    IF v_lines IS NULL THEN
      -- OPEN QUESTION (099, for the reviewers): the job is finished with nothing despatched and not yet invoiced. The rule decided is
      -- "the draft bills what was despatched", so no draft is made now: the delivery note path drafts each part as it is sent out.
      -- Flipping this one branch (drafting the undespatched order quantity here) would need that draft's lines unlinked and the invoice
      -- recorded in invoice_job_finish_legacy (as an 081 draft is), so nothing could be billed twice.
      RETURN 'nothing-despatched';
    END IF;
    v_vat := CASE WHEN v_vat_on THEN v_vat ELSE 0 END;

    SELECT coalesce(nullif(btrim(s.company_profile ->> 'defaultInvoiceTerms'), ''), '30 days') INTO v_terms
    FROM public.organization_settings s WHERE s.organization_id = p_org;
    v_terms := left(coalesce(v_terms, '30 days'), 200);
    v_days := CASE WHEN v_terms ~* 'receipt' THEN 0 ELSE coalesce(least(substring(v_terms FROM '(\d{1,4})')::INT, 366), 30) END;

    PERFORM set_config('quoteflow.invoice_line_link', 'on', TRUE);
    v_invoice := public.create_with_lines(
      'invoices',
      jsonb_strip_nulls(jsonb_build_object(
        'customer', v_so.customer, 'description', v_lines -> 0 ->> 'description', 'quantity', (v_lines -> 0 ->> 'quantity')::NUMERIC,
        'unit_price', (v_lines -> 0 ->> 'unit_price')::NUMERIC,
        'subtotal', v_net, 'carriage', 0, 'vat', v_vat, 'total', v_net + v_vat, 'vat_enabled', v_vat_on, 'carriage_vat', v_vat_on,
        'invoice_date', v_today, 'due_date', v_today + v_days, 'terms', v_terms,
        'quote_ref', v_so.quote_ref, 'customer_po', v_so.customer_po, 'job_id', p_job, 'status', 'draft', 'amount_paid', 0)),
      'invoice_line_items', 'invoice_id', v_lines);
    PERFORM set_config('quoteflow.invoice_line_link', '', TRUE);
    -- 099: the order's sent-out notes on no live invoice (and with no hand-typed invoice reference) go on the draft that bills them. A
    -- note being changed at this moment is skipped (its own send-out puts it on this draft).
    FOR v_note IN
      SELECT d.id FROM public.delivery_notes d LEFT JOIN public.invoices i ON i.id = d.invoice_id
      WHERE d.organization_id = p_org AND (d.sales_order_id = v_order OR d.job_id = p_job) AND d.status IN ('despatched', 'delivered', 'signed')
        AND (d.invoice_id IS NULL OR lower(coalesce(i.status, 'draft')) IN ('void', 'voided', 'cancelled', 'canceled'))
        AND nullif(btrim(d.invoice_ref), '') IS NULL
        AND EXISTS (SELECT 1 FROM public.delivery_note_items x WHERE x.delivery_note_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM public.delivery_note_items x LEFT JOIN public.sales_order_lines l ON l.id = x.sales_order_line_id
                        WHERE x.delivery_note_id = d.id AND l.sales_order_id IS DISTINCT FROM v_order)
      ORDER BY d.id
      FOR UPDATE OF d SKIP LOCKED
    LOOP
      PERFORM set_config('quoteflow.delivery_note_invoice', v_note.id::TEXT, TRUE);
      UPDATE public.delivery_notes SET invoice_id = v_invoice WHERE id = v_note.id;
    END LOOP;
    PERFORM set_config('quoteflow.delivery_note_invoice', '', TRUE);
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
-- 10. The automatic draft from a delivery note: 081's body (supabase/migrations/081_job_flow_release.sql section 17); its job step
-- (marked 099) adds the note to the job's draft, or drafts it alone when the job's invoices are issued and anything on it is outstanding.
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
  v_added  NUMERIC;
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
    -- 099: the note's job has a live DRAFT (one per job): the note goes on it and adds what it despatched that is not yet invoiced.
    SELECT i.id INTO v_job_inv
    FROM public.delivery_notes d JOIN public.invoices i ON i.job_id = d.job_id AND i.organization_id = d.organization_id
    WHERE d.id = p_note AND d.job_id IS NOT NULL AND lower(coalesce(i.status, 'draft')) = 'draft'
    ORDER BY i.created_at, i.id
    LIMIT 1;
    IF v_job_inv IS NOT NULL THEN
      v_added := public.invoice_add_delivery_note(p_org, v_job_inv, p_note);
      PERFORM security_audit.log_named_event(p_org, 'LINK_JOB_INVOICE', 'delivery_notes', p_note::TEXT,
        jsonb_build_object('invoice_id', v_job_inv, 'cause', p_cause, 'added', v_added));
      RETURN 'linked';
    END IF;
    -- 099: the job's invoices are issued. Nothing of the note's orders left to bill (an 081 Job Finish invoice billed the whole order):
    -- the note goes on the oldest live one, as 081. Otherwise the note gets a draft of its own below, for what is left (as (e)).
    SELECT i.id INTO v_job_inv
    FROM public.delivery_notes d JOIN public.invoices i ON i.job_id = d.job_id AND i.organization_id = d.organization_id
    WHERE d.id = p_note AND d.job_id IS NOT NULL AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')
    ORDER BY i.created_at, i.id
    LIMIT 1;
    IF v_job_inv IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.sales_order_lines l CROSS JOIN LATERAL public.order_line_billing(l.id, NULL) b
         WHERE l.sales_order_id IN (SELECT l2.sales_order_id FROM public.delivery_note_items x JOIN public.sales_order_lines l2 ON l2.id = x.sales_order_line_id
                                    WHERE x.delivery_note_id = p_note)
           AND b.despatched - b.invoiced - b.unbilled_notes
               + coalesce((SELECT sum(x.quantity) FROM public.delivery_note_items x WHERE x.delivery_note_id = p_note AND x.sales_order_line_id = l.id), 0) > 0) THEN
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
-- 10b. The order lines a draft may bill (API: the editor's save and read use it; admin and office of the caller's company): every line
-- of the draft's orders (the orders of its linked lines, of its delivery notes and of its job). None for an invoice made before 099,
-- which bills its goods on unlinked lines (adding linked lines to it could bill them twice); it keeps only the links it has.
CREATE OR REPLACE FUNCTION public.draft_invoice_order_lines(p_invoice UUID)
RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_job UUID;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT i.job_id INTO v_job FROM public.invoices i WHERE i.id = p_invoice AND i.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoice_notes_legacy n WHERE n.invoice_id = p_invoice)
     OR EXISTS (SELECT 1 FROM public.invoice_job_finish_legacy f WHERE f.invoice_id = p_invoice) THEN
    RETURN ARRAY[]::UUID[];
  END IF;
  RETURN ARRAY(
    SELECT l.id FROM public.sales_order_lines l
    WHERE l.organization_id = v_org AND l.sales_order_id IN (
      SELECT s.sales_order_id FROM public.invoice_line_items il JOIN public.sales_order_lines s ON s.id = il.sales_order_line_id WHERE il.invoice_id = p_invoice
      UNION SELECT l2.sales_order_id FROM public.delivery_notes d JOIN public.delivery_note_items x ON x.delivery_note_id = d.id
              JOIN public.sales_order_lines l2 ON l2.id = x.sales_order_line_id WHERE d.invoice_id = p_invoice
      UNION SELECT j.converted_from_sales_order_id FROM public.jobs j WHERE j.id = v_job AND j.organization_id = v_org
      UNION SELECT o.id FROM public.sales_orders o WHERE o.converted_to_job_id = v_job AND o.organization_id = v_org)
    ORDER BY l.id);
END
$$;
REVOKE ALL ON FUNCTION public.draft_invoice_order_lines(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.draft_invoice_order_lines(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 11. Editing a draft: 073's replace_draft_invoice (supabase/migrations/073_invoice_screen.sql section 1); the lines step (marked 099)
-- keeps each line's order-line link, and may link a line to any line of the draft's orders (freed quantity added back). Quantities on
-- linked lines are held to the outstanding balance by invoice_lines_within_despatched.
CREATE OR REPLACE FUNCTION public.replace_draft_invoice(p_invoice UUID, p_expected_updated_at TIMESTAMPTZ, p_header JSONB, p_lines JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_inv     public.invoices%ROWTYPE;
  v_line    JSONB;
  v_idx     INT := 0;
  v_now     TIMESTAMPTZ := clock_timestamp();
  v_allowed CONSTANT TEXT[] := ARRAY['description', 'quantity', 'unit_price', 'subtotal', 'carriage', 'vat', 'total', 'invoice_date',
                                     'due_date', 'tax_point', 'terms', 'customer_po', 'invoice_note', 'delivery_address'];
  v_key     TEXT;
  v_date    DATE;
  v_due     DATE;
  v_carr    NUMERIC;
  v_links   UUID[];
  v_link    UUID;
  v_lock    UUID;
  v_allowed_links UUID[];
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_inv.status, 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t be changed: correct it with a credit note.', v_inv.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF v_inv.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'This draft invoice was changed by someone else since you opened it. Reload it and make your changes again.' USING ERRCODE = 'PT409';
  END IF;
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'header must be an object and lines an array' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_header) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'field "%" can''t be changed here', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Keep at least one line on the invoice (delete the draft if nothing is to be billed).' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'too many lines (max 500)' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_date := CASE WHEN p_header ? 'invoice_date' THEN (p_header ->> 'invoice_date')::DATE ELSE v_inv.invoice_date END;
    v_due  := CASE WHEN p_header ? 'due_date' THEN (p_header ->> 'due_date')::DATE ELSE v_inv.due_date END;
    v_carr := CASE WHEN p_header ? 'carriage' THEN coalesce((p_header ->> 'carriage')::NUMERIC, 0) ELSE coalesce(v_inv.carriage, 0) END;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Dates must be real dates and carriage a number' USING ERRCODE = '22023';
  END;
  IF v_date IS NULL OR v_due IS NULL OR v_due < v_date THEN
    RAISE EXCEPTION 'Give an invoice date and a due date that is not before it.' USING ERRCODE = '22023';
  END IF;
  IF v_carr < 0 OR scale(trim_scale(v_carr)) > 2 THEN
    RAISE EXCEPTION 'Carriage is in pounds and pence and can''t be negative' USING ERRCODE = '22023';
  END IF;
  IF p_header ? 'invoice_note' AND (length(btrim(coalesce(p_header ->> 'invoice_note', ''))) > 200 OR coalesce(p_header ->> 'invoice_note', '') ~ '[\r\n]') THEN
    RAISE EXCEPTION 'The invoice note is one line of at most 200 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_header ? 'delivery_address' AND length(btrim(coalesce(p_header ->> 'delivery_address', ''))) > 500 THEN
    RAISE EXCEPTION 'The delivery address is at most 500 characters.' USING ERRCODE = '22023';
  END IF;
  -- 099: the order lines this draft bills (its linked lines). A save that sends no link at all while the draft has some is from a
  -- screen made before 099: refused, so a link is never dropped. A line may be linked to one of these or to any line of the draft's
  -- orders (the orders of its linked lines, of its delivery notes and of its job); never to anything else.
  v_links := ARRAY(SELECT DISTINCT il.sales_order_line_id FROM public.invoice_line_items il WHERE il.invoice_id = p_invoice AND il.sales_order_line_id IS NOT NULL);
  v_allowed_links := public.draft_invoice_order_lines(p_invoice);
  IF cardinality(v_links) > 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) e WHERE jsonb_typeof(e.value) = 'object' AND e.value ? 'sales_order_line_id') THEN
    RAISE EXCEPTION 'This draft bills despatched quantities and the page is out of date: reload it and make your changes again. Nothing was changed.'
      USING ERRCODE = '22023', HINT = 'reload_needed';
  END IF;
  FOR v_lock IN SELECT DISTINCT x FROM unnest(v_links || v_allowed_links) AS x ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('order-line-invoice:' || v_lock::TEXT, 0));
  END LOOP;

  UPDATE public.invoices i SET
    description = CASE WHEN p_header ? 'description' THEN p_header ->> 'description' ELSE i.description END,
    quantity    = CASE WHEN p_header ? 'quantity' THEN (p_header ->> 'quantity')::NUMERIC ELSE i.quantity END,
    unit_price  = CASE WHEN p_header ? 'unit_price' THEN (p_header ->> 'unit_price')::NUMERIC ELSE i.unit_price END,
    subtotal    = CASE WHEN p_header ? 'subtotal' THEN (p_header ->> 'subtotal')::NUMERIC ELSE i.subtotal END,
    carriage    = v_carr,
    vat         = CASE WHEN p_header ? 'vat' THEN (p_header ->> 'vat')::NUMERIC ELSE i.vat END,
    total       = CASE WHEN p_header ? 'total' THEN (p_header ->> 'total')::NUMERIC ELSE i.total END,
    invoice_date = v_date,
    due_date    = v_due,
    tax_point   = CASE WHEN p_header ? 'tax_point' THEN nullif(p_header ->> 'tax_point', '')::DATE ELSE i.tax_point END,
    terms       = CASE WHEN p_header ? 'terms' THEN p_header ->> 'terms' ELSE i.terms END,
    customer_po = CASE WHEN p_header ? 'customer_po' THEN nullif(btrim(p_header ->> 'customer_po'), '') ELSE i.customer_po END,
    invoice_note = CASE WHEN p_header ? 'invoice_note' THEN nullif(btrim(p_header ->> 'invoice_note'), '') ELSE i.invoice_note END,
    delivery_address = CASE WHEN p_header ? 'delivery_address' THEN nullif(btrim(p_header ->> 'delivery_address'), '') ELSE i.delivery_address END,
    updated_at  = v_now,
    updated_by  = auth.uid()
  WHERE i.id = p_invoice;

  DELETE FROM public.invoice_line_items WHERE invoice_id = p_invoice;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    PERFORM public.check_invoice_line(v_line);
    BEGIN
      v_link := nullif(v_line ->> 'sales_order_line_id', '')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Line %: its order line is not valid.', v_idx + 1 USING ERRCODE = '22023';
    END;
    IF v_link IS NOT NULL AND NOT (v_link = ANY (v_links || v_allowed_links)) THEN
      RAISE EXCEPTION 'Line %: it can bill only a line of this draft''s own orders.', v_idx + 1
        USING ERRCODE = '22023', HINT = 'order_link_kept';
    END IF;
    PERFORM set_config('quoteflow.invoice_line_link', CASE WHEN v_link IS NULL THEN '' ELSE 'on' END, TRUE);
    INSERT INTO public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt, sales_order_line_id)
    VALUES (v_org, p_invoice, v_idx, btrim(v_line ->> 'description'), (v_line ->> 'quantity')::NUMERIC, (v_line ->> 'unit_price')::NUMERIC,
            coalesce((v_line ->> 'vat_pct')::NUMERIC, 20), coalesce((v_line ->> 'vat_exempt')::BOOLEAN, FALSE), v_link);
    v_idx := v_idx + 1;
  END LOOP;
  PERFORM set_config('quoteflow.invoice_line_link', '', TRUE);

  -- The stored subtotal, VAT and total must be what the lines, carriage and the invoice's own VAT settings give (027's rule at issue).
  PERFORM public.check_document_totals('invoices', p_invoice, v_org);
  UPDATE public.invoices SET issuer_snapshot = public.issuer_snapshot(v_org), customer_snapshot = public.customer_snapshot(v_org, customer)
  WHERE id = p_invoice;
  RETURN v_now;
END
$$;
REVOKE ALL ON FUNCTION public.replace_draft_invoice(UUID, TIMESTAMPTZ, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_draft_invoice(UUID, TIMESTAMPTZ, JSONB, JSONB) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 12. What the draft editor shows: for each line of a draft (position order), its order line and, for a linked line, the order line's
-- ordered and despatched quantities, what is on other live invoices, and the most this draft may bill (despatched less other invoices);
-- then (line_position NULL) each other line of the draft's orders with quantity despatched and not invoiced, which can be added.
CREATE OR REPLACE FUNCTION public.draft_invoice_balances(p_invoice UUID)
RETURNS TABLE (line_position INTEGER, sales_order_line_id UUID, description TEXT, unit_price NUMERIC, vat_pct NUMERIC, vat_exempt BOOLEAN,
               ordered NUMERIC, despatched NUMERIC, on_other_invoices NUMERIC, available NUMERIC)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = p_invoice AND i.organization_id = v_org) THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  SELECT il.position, il.sales_order_line_id, l.description, l.unit_price, l.vat_pct, l.vat_exempt,
         b.ordered, b.despatched, b.invoiced, GREATEST(b.despatched - b.invoiced, 0)
  FROM public.invoice_line_items il
  LEFT JOIN public.sales_order_lines l ON l.id = il.sales_order_line_id
  LEFT JOIN LATERAL public.order_line_billing(il.sales_order_line_id, p_invoice) b ON il.sales_order_line_id IS NOT NULL
  WHERE il.invoice_id = p_invoice AND il.organization_id = v_org
  ORDER BY il.position, il.id;
  RETURN QUERY
  SELECT NULL::INTEGER, l.id, l.description, l.unit_price, l.vat_pct, l.vat_exempt,
         b.ordered, b.despatched, b.invoiced, GREATEST(b.despatched - b.invoiced, 0)
  FROM public.sales_order_lines l
  JOIN public.sales_orders o ON o.id = l.sales_order_id
  CROSS JOIN LATERAL public.order_line_billing(l.id, p_invoice) b
  WHERE l.organization_id = v_org
    AND l.id = ANY (public.draft_invoice_order_lines(p_invoice))
    AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items il WHERE il.invoice_id = p_invoice AND il.sales_order_line_id = l.id)
    AND b.despatched > b.invoiced
  ORDER BY o.so_number, l.position, l.id;
END
$$;
REVOKE ALL ON FUNCTION public.draft_invoice_balances(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.draft_invoice_balances(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 12b. "Needs attention" (j): every Complete job (not internal) of the caller's company whose order still has quantity to despatch, or
-- quantity despatched and not invoiced, or no order lines made yet (to_despatch NULL: nothing despatched).
CREATE OR REPLACE FUNCTION public.jobs_awaiting_despatch_or_invoice()
RETURNS TABLE (job_id UUID, job_no TEXT, customer TEXT, completed_at TIMESTAMPTZ, to_despatch NUMERIC, to_invoice NUMERIC)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH j AS (
    SELECT j.id, j.job_no, j.customer, j.inspected_at,
           coalesce(j.converted_from_sales_order_id,
                    (SELECT s.id FROM public.sales_orders s WHERE s.converted_to_job_id = j.id AND s.organization_id = v_org ORDER BY s.created_at, s.id LIMIT 1)) AS order_id
    FROM public.jobs j
    WHERE j.organization_id = v_org AND NOT coalesce(j.is_internal, FALSE) AND public.flow_status(j) = 'complete'
  ), t AS (
    SELECT j.id, count(l.id) AS n, sum(GREATEST(l.quantity - b.despatched, 0)) AS d, sum(GREATEST(b.despatched - b.invoiced, 0)) AS i
    FROM j
    LEFT JOIN public.sales_order_lines l ON l.sales_order_id = j.order_id AND l.organization_id = v_org
    LEFT JOIN LATERAL public.order_line_billing(l.id, NULL) b ON l.id IS NOT NULL
    WHERE j.order_id IS NOT NULL
    GROUP BY j.id
  )
  SELECT j.id, j.job_no, j.customer, j.inspected_at, CASE WHEN t.n = 0 THEN NULL ELSE t.d END, coalesce(t.i, 0)
  FROM j JOIN t ON t.id = j.id
  WHERE t.n = 0 OR t.d > 0 OR t.i > 0
  ORDER BY j.inspected_at, j.id;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_awaiting_despatch_or_invoice() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jobs_awaiting_despatch_or_invoice() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 13. Self-check (the same checks as supabase/verify/part_despatch_invoice_quantity_099.sql).
DO $$
DECLARE
  f TEXT;
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)')) IS DISTINCT FROM 'd467a505ab13a1cc1b1fa51cd8922f58'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)')) IS DISTINCT FROM '8c4d3694cec4ac679916f916afc41985'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)')) IS DISTINCT FROM 'c1464c01f419d1866e7143a41076e7d0'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)')) IS DISTINCT FROM '8e8e4cc70d1cd7ad4c3268c49e52f305' THEN
    RAISE EXCEPTION '099: a replaced function is not 099''s after the replace';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_line_items' AND column_name = 'sales_order_line_id')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoice_line_items'::regclass AND tgname = 'invoice_lines_within_despatched' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoice_line_items'::regclass AND tgname = 'invoice_lines_kind_guard' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_line_items' AND column_name = 'line_kind')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoice_line_items'::regclass AND tgname = 'zz_same_org_sales_order_line_id' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '099: the link column or its triggers are missing';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.invoice_job_finish_legacy', 'public.invoice_notes_legacy'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = f::regclass)
       OR has_table_privilege('authenticated', f, 'SELECT') OR has_table_privilege('anon', f, 'SELECT')
       OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = f::regclass AND tgname = 'support_read_only' AND tgenabled = 'O') THEN
      RAISE EXCEPTION '099: % is not internal', f;
    END IF;
  END LOOP;
  -- The internal helpers: no API role. The editor's read: signed-in only.
  FOREACH f IN ARRAY ARRAY['public.order_line_billing(uuid,uuid)', 'public.order_lines_lock(uuid[])', 'public.invoice_add_delivery_note(uuid,uuid,uuid)',
                           'public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)', 'public.job_finish_draft_invoice(uuid,uuid)',
                           'public.delivery_note_try_draft(uuid,uuid,text)', 'public.invoice_lines_within_despatched()', 'public.invoice_lines_kind_guard()'] LOOP
    IF to_regprocedure(f) IS NULL OR has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') OR has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION '099: % is missing or callable by an API role', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.draft_invoice_balances(uuid)', 'public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)',
                           'public.jobs_awaiting_despatch_or_invoice()', 'public.draft_invoice_order_lines(uuid)'] LOOP
    IF to_regprocedure(f) IS NULL OR NOT has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') OR has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION '099: % is missing or has the wrong grants', f;
    END IF;
  END LOOP;
END
$$;
