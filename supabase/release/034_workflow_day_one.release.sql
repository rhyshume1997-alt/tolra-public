-- 034_workflow_day_one.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 034: workflow day-one gaps (PR W). One migration for every database change in the batch.
--
-- 1. Office staff work on sales orders and invoices (W1). Until now both were admin-only. The office role now reads and
--    writes sales orders (and converts them to jobs), and reads and writes invoices and their lines, issues a draft and
--    records payments (record_invoice_payment already allowed office). Still admin-only, unchanged: reversing a payment,
--    confirm_invoice_payments, deleting a sales order, settings and the year-end export. The page-access switch
--    (section_allowed) is unchanged and still applies to everyone. The activity trail and the audit-event rules follow.
--
-- 2. Inspection evidence and release rules (W5). Each inspection is now a record of its own (job_inspections: result pass /
--    fail / concession, measured notes, an optional photo or file in the job-drawings bucket, who, when, the release decision
--    and the worksheet version it was made against), written only by record_job_inspection. A job reaches Done (inspected_at,
--    stage 'complete') only through a pass, or a concession recorded by an admin with a reason; the browser roles can no
--    longer set those columns directly. Any later change to the worksheet or the quantity (the fields that raise
--    worksheet_version) withdraws the sign-off in the same statement: inspected_at and inspected_by are cleared and the job
--    is back to awaiting inspection. A failed inspection on a released job withdraws the release too.
--    Only an admin, or a person an admin has made an inspector (organization_members.can_inspect, off by default, set by
--    set_member_inspector), records inspections. A job can require its certificates attached and its checklist ticked before a
--    pass (certs_required, checklist_required, off by default), and the result must name the worksheet version it was
--    inspected against, so a stale pass is refused. The name stored is a display name, never an e-mail address, and the record
--    history shows an e-mail address to admin and office only.
--
-- 3. Drawings carry from quote to job, with revisions and a cert pack (W3). convert_sales_order (018, 033) copied
--    descriptions only; it now also gives the job a job_files row for every file attached to the quote (a reference to the
--    quote's file, not a copy), and a storage read rule lets the shop floor open exactly those files. Each drawing has a
--    revision label; bump_drawing_revision replaces it with a newer row (the worksheet shows the latest). Material
--    certificates attach to the job as a cert pack (kind 'cert'), listed on the delivery note screen. An attached file never
--    changes (a new revision is a new row), revisions are approved by an admin only, a revision change after release withdraws
--    the release, and once a delivery note for the job has gone out its cert pack is frozen (job_files_guard).
--
-- 4. Linked despatch and invoicing with remaining quantities (W2). A delivery note no longer needs an invoice number
--    first: it is made from a sales order, or from a job (which means the order it came from), by create_delivery_note, with the
--    quantity despatched on each order line, and takes the next DLN number. The order's lines are now rows of their own
--    (sales_order_lines, made when first needed by ensure_sales_order_lines); despatch_lines shows what remains per line, without
--    prices. Despatching more than is left on a line is refused (the lines are locked, so two notes made at once can't
--    exceed it), and so is despatching a job that hasn't passed inspection (W5). create_invoice_from_delivery_notes makes a
--    draft invoice from one or more notes, one line per order line at the order's price and VAT; a note can be on one invoice
--    only. Triggers keep the links (item to order line, note to invoice) out of the browser's hands.
--    The release is checked again, with the job row locked, when a note is marked sent out or signed. A note that has been sent out
--    is frozen: its items and details can't be edited or deleted, it only moves forward, and only its signature and e-mail record
--    can still be written.
--
-- 5. Credit notes (W4; absent until now). credit_notes and credit_note_lines hold a credit against one issued invoice: lines, VAT
--    (worked out on the server from the lines), the CN- number series and the issue lock of an invoice. Applying a credit is an
--    allocation (invoice_credit_allocations), not a payment: invoices.amount_paid stays exactly the sum of invoice_payments, the
--    credits applied are totalled in invoices.credited_amount, and the balance due is total - payments - credits. A credit note's
--    amounts and invoice are fixed by create_credit_note (the header can't be edited), the VAT of an invoice line is shared out over
--    its credits so they add up to it exactly, and issuing re-checks the header against the lines and the caps. Issuing applies the
--    whole credit to the invoice in the same transaction: what the invoice owed is settled and any excess is customer credit. A credit
--    that would take an invoice's credit notes above its total is refused when it is made and when it is issued. The payment functions
--    and the issued-invoice lock count the credits too.
--
-- 6. The second step (033) on every privileged operation above. assert_privileged_aal() is the first statement of each privileged
--    function this migration adds or replaces, and the tables it adds that admins and office change (and the delivery notes) get
--    033's admin_mfa statement trigger: with require_admin_mfa on, an admin at aal1 is refused even calling the API directly.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. Office access to sales orders and invoices -------------------------------------------------------
DO $do$
DECLARE
  r RECORD;
BEGIN
  -- (table, may read / insert / update, may delete)
  FOR r IN SELECT * FROM (VALUES
    ('sales_orders',       'ARRAY[''admin'', ''office'']', 'ARRAY[''admin'']'),
    ('invoices',           'ARRAY[''admin'', ''office'']', 'ARRAY[''admin'', ''office'']'),
    ('invoice_line_items', 'ARRAY[''admin'', ''office'']', 'ARRAY[''admin'', ''office'']')
  ) AS t(tbl, work, del)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' rbac select', r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = public.current_user_organization_id() AND public.has_org_role(%s))',
                   r.tbl || ' rbac select', r.tbl, r.work);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' rbac insert', r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(%s))',
                   r.tbl || ' rbac insert', r.tbl, r.work);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' rbac update', r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (organization_id = public.current_user_organization_id() AND public.has_org_role(%s)) WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(%s))',
                   r.tbl || ' rbac update', r.tbl, r.work, r.work);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' rbac delete', r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (organization_id = public.current_user_organization_id() AND public.has_org_role(%s))',
                   r.tbl || ' rbac delete', r.tbl, r.del);
  END LOOP;
END
$do$;
-- Payments are read by the people who record them (the rows are still written only by the functions).
DROP POLICY IF EXISTS "invoice_payments rbac select" ON public.invoice_payments;
CREATE POLICY "invoice_payments rbac select" ON public.invoice_payments FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));

-- Issuing a draft invoice: admin or office (027), and the INV number is theirs to take (006, next_doc_number).
CREATE OR REPLACE FUNCTION public.issue_invoice(p_invoice UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_inv RECORD;
  v_ref TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can issue invoices' USING ERRCODE = '42501';
  END IF;
  SELECT id, status, invoice_ref, customer INTO v_inv
  FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_inv.status, 'draft') <> 'draft' THEN
    RETURN v_inv.invoice_ref; -- already issued: same number, nothing changes
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_line_items WHERE invoice_id = p_invoice) THEN
    RAISE EXCEPTION 'Add at least one line item before issuing' USING ERRCODE = '22023';
  END IF;
  PERFORM public.check_document_totals('invoices', p_invoice, v_org);
  v_ref := public.next_doc_number('INV');
  UPDATE public.invoices
     SET status = 'issued', invoice_ref = v_ref,
         issuer_snapshot = public.issuer_snapshot(v_org), customer_snapshot = public.customer_snapshot(v_org, v_inv.customer)
   WHERE id = p_invoice;
  RETURN v_ref;
END
$$;
REVOKE ALL ON FUNCTION public.issue_invoice(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_invoice(UUID) TO authenticated;

-- Document numbers (006): office staff may take INV numbers now that they issue invoices, and delivery notes have a series of their
-- own, DLN (admin, office, workshop), so a delivery note no longer waits for an invoice, and credit notes have CN (admin, office). Nothing else about
-- numbering changes.
CREATE OR REPLACE FUNCTION public.next_doc_number(p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org      UUID := public.current_user_organization_id();
  n        INT;
  result   TEXT;
  taken    BOOLEAN;
  attempts INT := 0;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_prefix IS NULL OR p_prefix NOT IN ('QUO', 'INV', 'J', 'PO', 'RFQ', 'DLN', 'CN') THEN
    RAISE EXCEPTION 'invalid document prefix' USING ERRCODE = '22023';
  END IF;

  -- You can only take numbers for documents you are allowed to create (a viewer cannot burn numbers).
  IF NOT public.has_org_role(CASE p_prefix
        WHEN 'INV' THEN ARRAY['admin', 'office']
        WHEN 'J'   THEN ARRAY['admin', 'office', 'workshop']
        WHEN 'DLN' THEN ARRAY['admin', 'office', 'workshop']
        ELSE            ARRAY['admin', 'office']
      END) THEN
    RAISE EXCEPTION 'not authorised for % numbers', p_prefix USING ERRCODE = '42501';
  END IF;

  LOOP
    INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
    VALUES (org, p_prefix, 1)
    ON CONFLICT (organization_id, prefix) DO UPDATE SET last = c.last + 1
    RETURNING c.last INTO n;

    -- lpad() would truncate numbers above 9999, so only pad short numbers.
    result := p_prefix || '-' || CASE WHEN n < 10000 THEN lpad(n::TEXT, 4, '0') ELSE n::TEXT END;

    -- Skip numbers that already exist (rows imported or seeded after the counters were seeded, or jobs that
    -- took a quote's number). Counters only move forward, so a skipped number is simply never reused.
    taken := CASE p_prefix
      WHEN 'QUO' THEN EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = result)
      WHEN 'INV' THEN EXISTS (SELECT 1 FROM public.invoices WHERE organization_id = org AND invoice_ref = result)
      WHEN 'J'   THEN EXISTS (SELECT 1 FROM public.jobs     WHERE organization_id = org AND job_no = result)
                   OR EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = 'QUO' || substr(result, 2))
      WHEN 'DLN' THEN EXISTS (SELECT 1 FROM public.delivery_notes WHERE organization_id = org AND dn_number = result)
      WHEN 'CN'  THEN EXISTS (SELECT 1 FROM public.credit_notes WHERE organization_id = org AND credit_ref = result)
      ELSE FALSE
    END;
    EXIT WHEN NOT taken;

    attempts := attempts + 1;
    IF attempts > 10000 THEN
      RAISE EXCEPTION 'could not allocate a free % number', p_prefix;
    END IF;
  END LOOP;

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.next_doc_number(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_doc_number(TEXT) TO authenticated;

-- Converting an order to its job (018, 033 job-number lock): admin or office. Otherwise exactly as 033.
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

  RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public.convert_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_sales_order(UUID) TO authenticated;

-- The record history (024) shows sales orders and invoices to office staff who may open them. Otherwise exactly as 024.
CREATE OR REPLACE FUNCTION public.record_activity(p_table TEXT, p_id UUID, p_limit INTEGER DEFAULT 200)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, actor_name TEXT, actor_email TEXT, action TEXT, entity_table TEXT,
               entity_id TEXT, changes JSONB, snapshot JSONB, metadata JSONB)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_allowed BOOLEAN;
  v_ref     TEXT;
  v_exists  BOOLEAN;
  v_values  BOOLEAN := public.has_org_role(ARRAY['admin', 'office']);
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  v_allowed := CASE p_table
    WHEN 'quotes'          THEN public.has_org_role(ARRAY['admin', 'office']) AND public.section_allowed('quotes')
    WHEN 'jobs'            THEN public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer'])
    WHEN 'sales_orders'    THEN public.has_org_role(ARRAY['admin', 'office']) AND public.section_allowed('sales-orders')
    WHEN 'invoices'        THEN public.has_org_role(ARRAY['admin', 'office']) AND public.section_allowed('invoices')
    WHEN 'purchase_orders' THEN public.has_org_role(ARRAY['admin', 'office']) AND public.section_allowed('purchase-orders')
    WHEN 'delivery_notes'  THEN public.has_org_role(ARRAY['admin', 'office', 'workshop'])
    ELSE NULL
  END;
  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'Unknown record type' USING ERRCODE = '22023';
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  -- The record must belong to this organisation (p_table is one of the names above, never caller text).
  -- (EXECUTE doesn't set FOUND, hence the explicit flag.)
  EXECUTE format('SELECT TRUE, %s FROM public.%I WHERE id = $1 AND organization_id = $2',
                 CASE WHEN p_table = 'quotes' THEN 'quote_ref' ELSE 'NULL::TEXT' END, p_table)
    INTO v_exists, v_ref USING p_id, v_org;
  IF v_exists IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.id, a.created_at,
         -- Only admin and office see an e-mail address in the history: for workshop and viewers a person with no name is 'Staff member'.
         CASE WHEN v_values THEN coalesce(nullif(p.full_name, ''), a.actor_email, CASE WHEN a.actor_user_id IS NULL THEN 'System' END)
              ELSE coalesce(CASE WHEN position('@' IN coalesce(p.full_name, '')) = 0 THEN nullif(p.full_name, '') END,
                            CASE WHEN a.actor_user_id IS NULL THEN 'System' ELSE 'Staff member' END) END,
         CASE WHEN v_values THEN a.actor_email END, a.action, a.entity_table, a.entity_id,
         security_audit.redact_unless(v_values, CASE WHEN a.action = 'UPDATE' THEN security_audit.activity_changes(a.old_data, a.new_data) END),
         security_audit.redact_unless(v_values,
           CASE WHEN a.action IN ('INSERT', 'DELETE') THEN security_audit.activity_snapshot(coalesce(a.new_data, a.old_data))
                WHEN coalesce(a.metadata ->> 'source', '') = 'write_audit' THEN security_audit.activity_snapshot(coalesce(a.new_data, '{}'))
           END),
         security_audit.redact_unless(v_values, a.metadata - 'source')
  FROM security_audit.audit_log a
  LEFT JOIN public.user_profiles p ON p.id = a.actor_user_id
  WHERE a.organization_id = v_org
    AND (
      -- the record itself (row changes, and app events that name it)
      (a.entity_table = p_table AND (a.entity_id = p_id::TEXT
         OR (v_ref IS NOT NULL AND v_ref = ANY (string_to_array(a.entity_id, ',')))
         OR (a.metadata -> 'ids') ? p_id::TEXT))
      -- its child rows
      OR (a.entity_table IN ('quote_line_items', 'invoice_line_items', 'delivery_note_items', 'machine_bookings', 'job_values', 'quote_attachments')
          AND security_audit.activity_parent(a.entity_table, a.old_data, a.new_data)
              IN (p_id::TEXT, CASE WHEN v_ref IS NOT NULL THEN 'quote_ref:' || v_ref END)
          AND (a.entity_table <> 'job_values' OR v_values))
    )
    -- the database's own row change already records app-level create / update events
    AND NOT (coalesce(a.metadata ->> 'source', '') = 'write_audit' AND a.action IN ('CREATE', 'UPDATE', 'INSERT', 'DELETE'))
    -- an update that changed only bookkeeping columns says nothing
    AND NOT (a.action = 'UPDATE' AND security_audit.activity_changes(a.old_data, a.new_data) = '{}'::JSONB)
    -- ... nor does one that changed only money, for someone who may not see money
    AND NOT (NOT v_values AND a.action = 'UPDATE'
             AND security_audit.redact_money(security_audit.activity_changes(a.old_data, a.new_data)) = '{}'::JSONB)
  ORDER BY a.created_at DESC, a.id
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.record_activity(TEXT, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_activity(TEXT, UUID, INTEGER) TO authenticated;

-- Audit-event rules (023, 033): office staff may log events for sales orders and invoices. Otherwise exactly as 033.
CREATE OR REPLACE FUNCTION public.audit_event_allowed(p_action TEXT, p_table TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_read  TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin', 'office'] WHEN 'sales_orders' THEN ARRAY['admin', 'office']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop', 'viewer'] WHEN 'machines' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
  END;
  v_write TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'machines' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin', 'office'] WHEN 'sales_orders' THEN ARRAY['admin', 'office']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop'] WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
  END;
BEGIN
  IF p_action = 'CHANGE_OWN_PASSWORD' THEN
    RETURN p_table = 'user_profiles';
  END IF;
  IF p_action IN ('CREATE_USER', 'SET_USER_PASSWORD', 'UPDATE_USERNAME', 'UPDATE_USER_ACCESS', 'DEACTIVATE_USER',
                  'REACTIVATE_USER', 'INVITE_USER', 'PASSWORD_RESET_PREPARED', 'RESET_MFA') THEN
    RETURN p_table = 'user_profiles' AND public.has_org_role(ARRAY['admin']);
  END IF;
  IF p_action IN ('EXPORT', 'PRINT_PACK', 'DOWNLOAD_PDF', 'DOWNLOAD_ATTACHMENT', 'EMAIL_COPIED') THEN
    RETURN v_read IS NOT NULL AND public.has_org_role(v_read);
  END IF;
  IF p_action IN ('CREATE', 'UPDATE', 'DELETE', 'SEND', 'DESPATCH', 'ACCEPT', 'REJECT', 'UPDATE_WORKSHEET',
                  'UPLOAD_DRAWING', 'CONVERT_TO_JOB', 'SEND_TO_WORKSHOP', 'MARK_RECEIVED', 'MARK_PAID', 'MARK_SIGNED',
                  'UPLOAD_ATTACHMENT', 'EMAIL_SENT_MANUALLY', 'DRAFT_CHASERS', 'CREATE_SUPPLIER', 'DELETE_SUPPLIER',
                  'ORGANIZATION_SETTINGS_UPDATE') THEN
    RETURN v_write IS NOT NULL AND public.has_org_role(v_write);
  END IF;
  RETURN FALSE;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Inspection evidence and release rules -------------------------------------------------------------
-- Who may inspect (an admin ticks it per person; off by default) and what a job needs before a pass (both off by default).
ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS can_inspect BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS certs_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS checklist_required BOOLEAN NOT NULL DEFAULT FALSE;

-- The name that signs a job off is a display name, never an e-mail address (workshop and viewers can read it). Existing values
-- that look like an address are replaced by a neutral placeholder, and the column can't hold one again.
UPDATE public.jobs SET inspected_by = 'Inspector' WHERE inspected_by LIKE '%@%';
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_inspected_by_no_email' AND conrelid = 'public.jobs'::regclass) THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_inspected_by_no_email CHECK (inspected_by IS NULL OR position('@' IN inspected_by) = 0);
  END IF;
END
$do$;

CREATE TABLE IF NOT EXISTS public.job_inspections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES public.organizations(id),
  job_id             UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  result             TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'concession')),
  release_decision   TEXT NOT NULL CHECK (release_decision IN ('released', 'held')),
  measured_notes     TEXT NOT NULL CHECK (length(btrim(measured_notes)) BETWEEN 1 AND 2000),
  attachment_path    TEXT,
  attachment_name    TEXT,
  concession_reason  TEXT CHECK (concession_reason IS NULL OR length(btrim(concession_reason)) BETWEEN 1 AND 500),
  inspector_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  inspector_name     TEXT NOT NULL CHECK (length(btrim(inspector_name)) BETWEEN 1 AND 100 AND position('@' IN inspector_name) = 0),
  inspected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  worksheet_version  INTEGER NOT NULL,
  CONSTRAINT job_inspections_decision_follows_result CHECK ((result = 'fail') = (release_decision = 'held')),
  CONSTRAINT job_inspections_concession_has_reason CHECK (result <> 'concession' OR concession_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_job_inspections_job ON public.job_inspections (job_id, inspected_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_inspections_org ON public.job_inspections (organization_id);

-- Same company; everyone who can open the job can read its inspections. No insert, update or delete grant for the API: rows
-- are written by record_job_inspection only and are never changed afterwards.
ALTER TABLE public.job_inspections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_inspections rbac select" ON public.job_inspections;
CREATE POLICY "job_inspections rbac select" ON public.job_inspections FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
REVOKE ALL ON public.job_inspections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_inspections TO authenticated;
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_inspections;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_inspections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');

-- Records one inspection and, for a pass or an admin's concession, releases the job (Done). Organisation and inspector come
-- from the session. The job row is locked first. A failed inspection holds the job (and withdraws an earlier release).
-- Returns { inspection_id, result, release_decision, inspected_at }.
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
  -- The photo or file was uploaded to this job's folder in the job-drawings bucket; nothing else can be attached.
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
  IF v_job.inspected_at IS NOT NULL AND p_result <> 'fail' THEN
    RAISE EXCEPTION '% has already been released.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  -- The result must be for the job as the inspector saw it: if the worksheet, quantity or a drawing revision has changed since the
  -- dialog was opened, the pass is stale and refused (a failure is always recorded).
  IF p_result <> 'fail' AND p_expected_version IS DISTINCT FROM v_job.worksheet_version THEN
    RAISE EXCEPTION '% changed after you opened it (the worksheet, quantity or a drawing revision). Open it again and inspect the current version.', v_job.job_no USING ERRCODE = '22023';
  END IF;
  -- What the job requires before a pass (an admin's concession, with its reason, is the way past them).
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

  -- The name on the record is a display name, never an e-mail address: the person's full name, or a neutral placeholder.
  SELECT p.email, nullif(btrim(regexp_replace(coalesce(p.full_name, ''), '[[:cntrl:]]+', ' ', 'g')), '') INTO v_email, v_who FROM public.user_profiles p WHERE p.id = v_user;
  IF v_who IS NULL OR position('@' IN v_who) > 0 THEN
    v_who := 'Inspector';
  END IF;
  v_who := left(v_who, 100);

  INSERT INTO public.job_inspections (organization_id, job_id, result, release_decision, measured_notes, attachment_path, attachment_name,
                                      concession_reason, inspector_id, inspector_name, inspected_at, worksheet_version)
  VALUES (v_org, p_job, p_result, CASE WHEN p_result = 'fail' THEN 'held' ELSE 'released' END, v_notes, v_path, v_name,
          v_reason, v_user, v_who, v_now, v_job.worksheet_version)
  RETURNING id INTO v_id;

  PERFORM set_config('quoteflow.job_inspection', p_job::TEXT, TRUE);
  IF p_result = 'fail' THEN
    IF v_job.inspected_at IS NOT NULL THEN
      UPDATE public.jobs SET inspected_at = NULL, inspected_by = NULL, stage = CASE WHEN stage = 'complete' THEN 'inspection' ELSE stage END WHERE id = p_job;
    END IF;
  ELSE
    UPDATE public.jobs SET inspected_at = v_now, inspected_by = v_who, stage = 'complete' WHERE id = p_job;
  END IF;
  PERFORM set_config('quoteflow.job_inspection', '', TRUE);

  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'INSPECT_JOB', 'jobs', p_job::TEXT,
          jsonb_build_object('source', 'write_audit', 'inspection_id', v_id, 'job_no', v_job.job_no, 'result', p_result,
                             'release_decision', CASE WHEN p_result = 'fail' THEN 'held' ELSE 'released' END,
                             'concession_reason', v_reason, 'attachment', v_name));
  RETURN jsonb_build_object('inspection_id', v_id, 'result', p_result, 'release_decision', CASE WHEN p_result = 'fail' THEN 'held' ELSE 'released' END,
                            'inspected_at', v_now);
END
$$;
REVOKE ALL ON FUNCTION public.record_job_inspection(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_job_inspection(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated;

-- Who may record an inspection. Admins always may; office and workshop staff only when an admin has made them an inspector for this
-- company (organization_members.can_inspect, off by default, so after release an admin ticks it for each person who signs off).
-- Read-only for the browser roles: the flag changes only here, by an admin, and is audited.
CREATE OR REPLACE FUNCTION public.set_member_inspector(p_user UUID, p_value BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_uid   UUID := auth.uid();
  v_old   BOOLEAN;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can choose who may record inspections.' USING ERRCODE = '42501';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'Say whether this person may record inspections.' USING ERRCODE = '22023';
  END IF;
  SELECT can_inspect INTO v_old FROM public.organization_members WHERE user_id = p_user AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found in this organisation' USING ERRCODE = 'P0002';
  END IF;
  IF v_old IS DISTINCT FROM p_value THEN
    UPDATE public.organization_members SET can_inspect = p_value, updated_at = now() WHERE user_id = p_user AND organization_id = v_org;
    INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
    VALUES (v_org, v_uid, nullif(auth.jwt() ->> 'email', ''), 'SET_INSPECTOR', 'organization_members', p_user::TEXT,
            jsonb_build_object('source', 'write_audit', 'can_inspect', p_value, 'was', v_old));
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.set_member_inspector(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_inspector(UUID, BOOLEAN) TO authenticated;


-- The release rules on the job row, for the browser roles (anon, authenticated): the service role and the database owner
-- (the importer, the SQL editor) are exempt, as for the other locks.
--   * inspected_at / inspected_by change only inside record_job_inspection (which names the job in
--     quoteflow.job_inspection for its own statement), and a job reaches stage 'complete' only when it is released;
--   * after sign-off, any change that raises worksheet_version (a worksheet field or the quantity, see 022) withdraws it:
--     inspected_at and inspected_by are cleared and a 'complete' job goes back to 'inspection', awaiting inspection.
-- It is named so that it runs after jobs_worksheet_version, which has already counted the change.
CREATE OR REPLACE FUNCTION public.jobs_release_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_via BOOLEAN := current_setting('quoteflow.job_inspection', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.inspected_at IS NOT NULL OR NEW.inspected_by IS NOT NULL OR NEW.stage = 'complete' THEN
      RAISE EXCEPTION 'A job is released by recording its inspection (a pass, or an admin''s concession).' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.certs_required IS DISTINCT FROM OLD.certs_required OR NEW.checklist_required IS DISTINCT FROM OLD.checklist_required)
     AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Job %: only admin and office staff change what its inspection requires.', OLD.job_no USING ERRCODE = '42501';
  END IF;
  IF NOT v_via AND (NEW.inspected_at IS DISTINCT FROM OLD.inspected_at OR NEW.inspected_by IS DISTINCT FROM OLD.inspected_by) THEN
    RAISE EXCEPTION 'Job %: the inspection result is recorded with Record inspection, not by editing the job.', OLD.job_no USING ERRCODE = '42501';
  END IF;
  IF NOT v_via AND OLD.inspected_at IS NOT NULL AND NEW.worksheet_version IS DISTINCT FROM OLD.worksheet_version THEN
    NEW.inspected_at := NULL;
    NEW.inspected_by := NULL;
    IF NEW.stage = 'complete' THEN
      NEW.stage := 'inspection';
    END IF;
  END IF;
  IF NEW.stage = 'complete' AND OLD.stage IS DISTINCT FROM 'complete' AND NEW.inspected_at IS NULL THEN
    RAISE EXCEPTION 'Job %: it moves to Done when its inspection is passed or an admin has recorded a concession.', OLD.job_no USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS jobs_worksheet_version_release ON public.jobs;
CREATE TRIGGER jobs_worksheet_version_release BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_release_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Drawings and the cert pack on the job ----------------------------------------------------------------
-- One row per file attached to a job. kind 'drawing': a customer drawing, carried over from the quote on conversion as a
-- REFERENCE to the quote's file (storage_bucket 'quote-attachments'; nothing is copied) or uploaded to the job (bucket
-- 'job-drawings'). kind 'cert': a material certificate in the job's cert pack, shown on the delivery note screen. A drawing has
-- a revision label; a newer revision is a new row that supersedes the old one (the worksheet shows the latest, the older
-- ones stay listed). Rows are of one company, and the file has to sit in that company's folder.
CREATE TABLE IF NOT EXISTS public.job_files (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES public.organizations(id),
  job_id               UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('drawing', 'cert')),
  ref                  TEXT NOT NULL CHECK (length(btrim(ref)) BETWEEN 1 AND 200),
  revision             TEXT CHECK (revision IS NULL OR length(btrim(revision)) BETWEEN 1 AND 20),
  file_name            TEXT NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  storage_bucket       TEXT NOT NULL CHECK (storage_bucket IN ('job-drawings', 'quote-attachments')),
  storage_path         TEXT NOT NULL CHECK (length(storage_path) BETWEEN 1 AND 500),
  source_attachment_id UUID,
  superseded_at        TIMESTAMPTZ,
  superseded_by        UUID,
  created_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_files_in_company_folder CHECK (split_part(storage_path, '/', 1) = organization_id::TEXT),
  CONSTRAINT job_files_certs_have_no_revision CHECK (kind = 'drawing' OR revision IS NULL),
  CONSTRAINT job_files_one_row_per_file UNIQUE (job_id, storage_bucket, storage_path)
);
CREATE INDEX IF NOT EXISTS idx_job_files_job ON public.job_files (job_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_job_files_org_path ON public.job_files (organization_id, storage_bucket, storage_path);

ALTER TABLE public.job_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_files rbac select" ON public.job_files;
CREATE POLICY "job_files rbac select" ON public.job_files FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
DROP POLICY IF EXISTS "job_files rbac insert" ON public.job_files;
CREATE POLICY "job_files rbac insert" ON public.job_files FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));
DROP POLICY IF EXISTS "job_files rbac update" ON public.job_files;
CREATE POLICY "job_files rbac update" ON public.job_files FOR UPDATE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));
DROP POLICY IF EXISTS "job_files rbac delete" ON public.job_files;
CREATE POLICY "job_files rbac delete" ON public.job_files FOR DELETE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
REVOKE ALL ON public.job_files FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_files TO authenticated;
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_files;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_files
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS audit_job_files_changes ON public.job_files;
CREATE TRIGGER audit_job_files_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_files
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- A drawing the quote carried stays in the quote's folder: the people on the shop floor can open it through the job. The existing
-- quote-attachments rules (admin, office) are unchanged; this adds a read of exactly the files a job of the same company refers to.
DO $do$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '034: storage schema not found, skipping the job drawing read rule';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS "quote-attachments referenced by jobs" ON storage.objects;
  CREATE POLICY "quote-attachments referenced by jobs" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'quote-attachments'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer'])
           AND EXISTS (SELECT 1 FROM public.job_files f
                       WHERE f.organization_id = public.current_user_organization_id()
                         AND f.storage_bucket = 'quote-attachments' AND f.storage_path = name));
END
$do$;

-- An attached file is evidence, so it does not change (browser roles; the importer and service role are exempt):
--   * a row's file, name and place never change; a revision label is set once (empty to a label, admin only) and never altered,
--     because a new revision is a new row (bump_drawing_revision, admin only) that supersedes the old one;
--   * a drawing is never removed; a certificate can be taken out of the pack by admin and office (the delete policy) until a
--     delivery note for the job has gone out: the pack listed on a sent note is despatch evidence, so certificates can't then be
--     added or removed;
--   * deleting the job itself still removes its rows (the cascade).
CREATE OR REPLACE FUNCTION public.job_files_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row  public.job_files%ROWTYPE;
  v_sent BOOLEAN := FALSE;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP IN ('INSERT', 'DELETE') AND v_row.kind = 'cert' THEN
    SELECT EXISTS (SELECT 1 FROM public.jobs j
                   JOIN public.delivery_notes d ON d.organization_id = j.organization_id AND d.status IN ('despatched', 'delivered', 'signed')
                                               AND (d.job_id = j.id OR (d.job_id IS NULL AND d.job_ref = j.job_no))
                   WHERE j.id = v_row.job_id) INTO v_sent;
    IF v_sent THEN
      RAISE EXCEPTION 'A delivery note for this job has gone out with its certificates, so the cert pack can''t be changed.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.superseded_at IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'A file is replaced by uploading the next revision, not by marking it.' USING ERRCODE = '42501';
    END IF;
    IF NEW.revision IS NOT NULL AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only an admin approves a drawing revision.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['revision', 'superseded_at', 'superseded_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision', 'superseded_at', 'superseded_by']) THEN
      RAISE EXCEPTION 'An attached file can''t be changed: a new revision is a new file.' USING ERRCODE = '42501';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision THEN
      IF OLD.revision IS NOT NULL OR NEW.revision IS NULL THEN
        RAISE EXCEPTION 'A revision can''t be changed once it is set: upload the next revision as a new file.' USING ERRCODE = '42501';
      END IF;
      IF NOT public.has_org_role(ARRAY['admin']) THEN
        RAISE EXCEPTION 'Only an admin approves a drawing revision.' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by)
       AND (OLD.superseded_at IS NOT NULL OR current_setting('quoteflow.drawing_bump', TRUE) IS DISTINCT FROM OLD.id::TEXT) THEN
      RAISE EXCEPTION 'A file is replaced by uploading the next revision, not by marking it.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.kind = 'drawing' THEN
    RAISE EXCEPTION 'An attached drawing can''t be removed; upload the next revision instead.' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS job_files_guard ON public.job_files;
CREATE TRIGGER job_files_guard BEFORE INSERT OR UPDATE OR DELETE ON public.job_files
  FOR EACH ROW EXECUTE FUNCTION public.job_files_guard();

-- A drawing revision changes what the job is built and inspected to. jobs_worksheet_version (022) also counts a change flagged by
-- quoteflow.drawing_revision, so a new revision (or the first label) withdraws the release in the same statement (see
-- jobs_release_guard) and makes any inspection result entered against the earlier version stale.
CREATE OR REPLACE FUNCTION public.jobs_worksheet_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Fields edited on the worksheet (lib/job-worksheet.ts worksheetToPatch).
  v_fields CONSTANT TEXT[] := ARRAY[
    'description', 'material_ordered', 'checklist', 'customer_po', 'date_received', 'date_required', 'quote_ref',
    'dimension_report_no', 'material_cert_no', 'heat_cast_no', 'drawing_no', 'material_required', 'material_ordered_at',
    'material_ordered_notes', 'material_supplier', 'machine_1', 'program_1', 'machine_2', 'program_2', 'machine_3',
    'program_3', 'improvement_comments', 'overrun_reasons', 'checked_by', 'signed_off_by', 'signed_off_at',
    'job_time_quoted_hr', 'job_time_taken_hr', 'quantity_required', 'setup_time_hr', 'run_time_hr'];
  v_old JSONB := to_jsonb(OLD);
  v_new JSONB;
  v_key TEXT;
  v_changed BOOLEAN := current_setting('quoteflow.drawing_revision', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT;
BEGIN
  -- One required date: whichever of the two dates changed sets the other.
  IF NEW.date_required IS DISTINCT FROM OLD.date_required THEN
    NEW.due_date := NEW.date_required;
  ELSIF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    NEW.date_required := NEW.due_date;
  END IF;

  v_new := to_jsonb(NEW);
  IF NOT v_changed THEN
    FOREACH v_key IN ARRAY v_fields LOOP
      IF v_new -> v_key IS DISTINCT FROM v_old -> v_key THEN
        v_changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  NEW.worksheet_version := OLD.worksheet_version + CASE WHEN v_changed THEN 1 ELSE 0 END;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.job_files_revision_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF NEW.kind <> 'drawing' OR (TG_OP = 'INSERT' AND NEW.revision IS NULL) OR (TG_OP = 'UPDATE' AND NEW.revision IS NOT DISTINCT FROM OLD.revision) THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('quoteflow.drawing_revision', NEW.job_id::TEXT, TRUE);
  UPDATE public.jobs SET description = description WHERE id = NEW.job_id;
  PERFORM set_config('quoteflow.drawing_revision', '', TRUE);
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS job_files_revision_change ON public.job_files;
CREATE TRIGGER job_files_revision_change AFTER INSERT OR UPDATE ON public.job_files
  FOR EACH ROW EXECUTE FUNCTION public.job_files_revision_change();

-- The files of a job, and the photos of an inspection, can't be overwritten or deleted in storage by the browser roles.
DO $do$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '034: storage schema not found, skipping the attached file rules';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS "attached job files are not overwritten" ON storage.objects;
  CREATE POLICY "attached job files are not overwritten" ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
    USING (NOT (bucket_id IN ('job-drawings', 'quote-attachments')
                AND (EXISTS (SELECT 1 FROM public.job_files f WHERE f.storage_bucket = bucket_id AND f.storage_path = name)
                     OR EXISTS (SELECT 1 FROM public.job_inspections i WHERE i.attachment_path = name))));
  DROP POLICY IF EXISTS "attached job files are not deleted" ON storage.objects;
  CREATE POLICY "attached job files are not deleted" ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
    USING (NOT (bucket_id IN ('job-drawings', 'quote-attachments')
                AND (EXISTS (SELECT 1 FROM public.job_files f WHERE f.storage_bucket = bucket_id AND f.storage_path = name)
                     OR EXISTS (SELECT 1 FROM public.job_inspections i WHERE i.attachment_path = name))));
END
$do$;

-- A new revision of a drawing: the new file (uploaded to the job's folder in job-drawings) becomes the current row and the old
-- one is marked superseded, in one step. Returns the new row's id. Admin only (approval, see job_files_guard). Runs with the
-- caller's rights, so the policies above apply. The release is withdrawn by job_files_revision_change.
CREATE OR REPLACE FUNCTION public.bump_drawing_revision(p_file UUID, p_revision TEXT, p_file_name TEXT, p_storage_path TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org  UUID := public.current_user_organization_id();
  v_rev  TEXT := nullif(btrim(p_revision), '');
  v_name TEXT := nullif(btrim(p_file_name), '');
  v_old  public.job_files%ROWTYPE;
  v_new  UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin approves a drawing revision.' USING ERRCODE = '42501';
  END IF;
  IF v_rev IS NULL OR length(v_rev) > 20 THEN
    RAISE EXCEPTION 'Give the new revision (up to 20 characters).' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_old FROM public.job_files WHERE id = p_file AND organization_id = v_org AND kind = 'drawing' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Drawing not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'That revision has already been replaced by a newer one.' USING ERRCODE = '22023';
  END IF;
  IF lower(v_rev) = lower(coalesce(v_old.revision, '')) THEN
    RAISE EXCEPTION 'The drawing is already at revision %.', v_rev USING ERRCODE = '22023';
  END IF;
  IF v_name IS NULL OR p_storage_path IS NULL OR p_storage_path NOT LIKE v_org::TEXT || '/' || v_old.job_id::TEXT || '/%' THEN
    RAISE EXCEPTION 'Upload the new revision to this job first.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.job_files (organization_id, job_id, kind, ref, revision, file_name, storage_bucket, storage_path, created_by)
  VALUES (v_org, v_old.job_id, 'drawing', v_old.ref, v_rev, v_name, 'job-drawings', p_storage_path, auth.uid())
  RETURNING id INTO v_new;
  PERFORM set_config('quoteflow.drawing_bump', v_old.id::TEXT, TRUE);
  UPDATE public.job_files SET superseded_at = now(), superseded_by = v_new WHERE id = v_old.id;
  PERFORM set_config('quoteflow.drawing_bump', '', TRUE);
  RETURN v_new;
END
$$;
REVOKE ALL ON FUNCTION public.bump_drawing_revision(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bump_drawing_revision(UUID, TEXT, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Despatch linked to the order, invoicing linked to the delivery notes ---------------------------------
-- The order's lines. A sales order has had only a total (and, if it came from a quote, the quote's lines). The lines are now
-- rows of their own, made when the order is first despatched or invoiced (ensure_sales_order_lines): the quote's lines when
-- they add up to the order's value, otherwise one line for the order's value, as the order's PDF prints it. Once a delivery
-- note refers to a line, the line is fixed.
CREATE TABLE IF NOT EXISTS public.sales_order_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES public.organizations(id),
  sales_order_id       UUID NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL DEFAULT 0,
  description          TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity             NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_price           NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  vat_pct              NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_pct >= 0 AND vat_pct <= 100),
  vat_exempt           BOOLEAN NOT NULL DEFAULT FALSE,
  source_quote_line_id UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_order_lines_order ON public.sales_order_lines (sales_order_id, position);
-- Same people as the order itself (prices are not for the workshop; they despatch through despatch_lines, which shows none).
ALTER TABLE public.sales_order_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sales_order_lines rbac select" ON public.sales_order_lines;
CREATE POLICY "sales_order_lines rbac select" ON public.sales_order_lines FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
DROP POLICY IF EXISTS "sales_order_lines section access" ON public.sales_order_lines;
CREATE POLICY "sales_order_lines section access" ON public.sales_order_lines AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.section_allowed('sales-orders'))) WITH CHECK ((SELECT public.section_allowed('sales-orders')));
REVOKE ALL ON public.sales_order_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sales_order_lines TO authenticated;
DROP TRIGGER IF EXISTS zz_same_org_sales_order_id ON public.sales_order_lines;
CREATE TRIGGER zz_same_org_sales_order_id BEFORE INSERT OR UPDATE ON public.sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('sales_orders', 'sales_order_id');

-- How a despatch and its invoice are linked.
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL;
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL;
ALTER TABLE public.delivery_note_items ADD COLUMN IF NOT EXISTS sales_order_line_id UUID REFERENCES public.sales_order_lines(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_delivery_note_items_order_line ON public.delivery_note_items (sales_order_line_id) WHERE sales_order_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_notes_invoice ON public.delivery_notes (invoice_id) WHERE invoice_id IS NOT NULL;
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.delivery_notes;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE OF job_id, organization_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS zz_same_org_invoice_id ON public.delivery_notes;
CREATE TRIGGER zz_same_org_invoice_id BEFORE INSERT OR UPDATE OF invoice_id, organization_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('invoices', 'invoice_id');
DROP TRIGGER IF EXISTS zz_same_org_sales_order_line_id ON public.delivery_note_items;
CREATE TRIGGER zz_same_org_sales_order_line_id BEFORE INSERT OR UPDATE OF sales_order_line_id, organization_id ON public.delivery_note_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('sales_order_lines', 'sales_order_line_id');

-- Delivery note numbers that don't wait for an invoice: DLN-0001, ... (a note made from an invoice number keeps DLN-<invoice number>).
-- (Changed in the numbering function above: 'DLN' for admin, office and workshop, skipping numbers already used.)

-- The lines of an order (or of the order a job came from), made once and then fixed: the quote's lines when they add up to the
-- order's value, otherwise one line for the value. Called by the despatch and invoice functions; runs for admin, office and
-- workshop and only for their own company's orders. Lines no delivery note refers to yet are rebuilt if the order's value
-- changed. Returns the order id.
CREATE OR REPLACE FUNCTION public.ensure_sales_order_lines(p_order UUID)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_order public.sales_orders%ROWTYPE;
  v_have  NUMERIC;
  v_quote NUMERIC;
  v_n     INT;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*), coalesce(sum(round(quantity * unit_price, 2)), 0) INTO v_n, v_have FROM public.sales_order_lines WHERE sales_order_id = p_order;
  IF v_n > 0 THEN
    IF v_have = coalesce(v_order.total_value, 0) OR EXISTS (
         SELECT 1 FROM public.delivery_note_items i JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id WHERE l.sales_order_id = p_order) THEN
      RETURN p_order;
    END IF;
    DELETE FROM public.sales_order_lines WHERE sales_order_id = p_order;
  END IF;
  IF v_order.quote_id IS NOT NULL THEN
    SELECT coalesce(sum(round(quantity * unit_price, 2)), 0) INTO v_quote FROM public.quote_line_items WHERE quote_id = v_order.quote_id AND organization_id = v_org;
    IF v_quote = coalesce(v_order.total_value, 0) AND v_quote > 0 THEN
      INSERT INTO public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price, vat_pct, vat_exempt, source_quote_line_id)
      SELECT v_org, p_order, row_number() OVER (ORDER BY q.position, q.id) - 1, left(btrim(q.description), 500), q.quantity, q.unit_price, q.vat_pct, q.vat_exempt, q.id
      FROM public.quote_line_items q WHERE q.quote_id = v_order.quote_id AND q.organization_id = v_org AND btrim(q.description) <> '' AND q.quantity > 0;
      RETURN p_order;
    END IF;
  END IF;
  INSERT INTO public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
  VALUES (v_org, p_order, 0, left('Customer order ' || coalesce(nullif(btrim(v_order.customer_po), ''), v_order.so_number), 500), 1, coalesce(v_order.total_value, 0), v_order.vat_pct, v_order.vat_exempt);
  RETURN p_order;
END
$$;
REVOKE ALL ON FUNCTION public.ensure_sales_order_lines(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_sales_order_lines(UUID) TO authenticated;

-- What is left to despatch on an order (or on the order a job came from): per line the quantity ordered, the quantity on delivery
-- notes already, and what remains. No prices, so the workshop can use it. Returns nothing for a job without an order.
CREATE OR REPLACE FUNCTION public.despatch_lines(p_order UUID, p_job UUID DEFAULT NULL)
RETURNS TABLE (line_id UUID, line_position INTEGER, description TEXT, ordered NUMERIC, despatched NUMERIC, remaining NUMERIC)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_order UUID := p_order;
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
  PERFORM public.ensure_sales_order_lines(v_order);
  RETURN QUERY
  SELECT l.id, l.position, l.description, l.quantity,
         coalesce((SELECT sum(i.quantity) FROM public.delivery_note_items i WHERE i.sales_order_line_id = l.id), 0)::NUMERIC,
         (l.quantity - coalesce((SELECT sum(i.quantity) FROM public.delivery_note_items i WHERE i.sales_order_line_id = l.id), 0))::NUMERIC
  FROM public.sales_order_lines l
  WHERE l.sales_order_id = v_order AND l.organization_id = v_org
  ORDER BY l.position, l.id;
END
$$;
REVOKE ALL ON FUNCTION public.despatch_lines(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.despatch_lines(UUID, UUID) TO authenticated;

-- Makes a delivery note from a sales order (or from a job, which means the order it came from), with the quantity despatched
-- on each line: p_lines is [{ "line_id": ..., "quantity": ... }]. The order's lines are locked first, so two notes made at once
-- can't between them despatch more than was ordered; more than what is left on a line is refused, and nothing is created. A job
-- that hasn't passed inspection can't be despatched (W5). The number comes from the DLN series, no invoice needed. Admin, office
-- and workshop. Returns { id, dn_number }.
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
    SELECT * INTO v_job FROM public.jobs WHERE id = v_job_id AND organization_id = v_org FOR SHARE;
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
  -- The job this order became: it must have passed inspection before anything goes out. The job row is locked (FOR SHARE) while the
  -- note is made, so the release can't be withdrawn between this check and the note; marking the note sent checks it again.
  IF v_job_id IS NULL THEN
    v_job_id := v_order.converted_to_job_id;
    IF v_job_id IS NOT NULL THEN
      SELECT * INTO v_job FROM public.jobs WHERE id = v_job_id AND organization_id = v_org FOR SHARE;
      IF NOT FOUND THEN
        v_job_id := NULL;
      END IF;
    END IF;
  ELSIF v_order.converted_to_job_id IS NOT NULL AND v_order.converted_to_job_id <> v_job_id THEN
    RAISE EXCEPTION 'That job isn''t the one made from sales order %.', v_order.so_number USING ERRCODE = '22023';
  END IF;
  IF v_job_id IS NOT NULL AND v_job.inspected_at IS NULL THEN
    RAISE EXCEPTION '% hasn''t passed inspection (or had a concession recorded by an admin), so it can''t be despatched.', v_job.job_no USING ERRCODE = '22023';
  END IF;

  PERFORM public.ensure_sales_order_lines(v_order_id);
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

-- Despatch lines and the invoice link change only through the functions here: the browser roles can't link an item to an order
-- line, change the quantity or the link of a linked item, delete the items of an invoiced note, point a note at an invoice, or
-- delete a note that has been invoiced. (A draft invoice that is deleted frees its notes: the link is cleared by the foreign key.)
CREATE OR REPLACE FUNCTION public.delivery_note_items_link_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_via BOOLEAN;
  v_dn  UUID;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_dn := CASE WHEN TG_OP = 'DELETE' THEN OLD.delivery_note_id ELSE NEW.delivery_note_id END;
  v_via := current_setting('quoteflow.delivery_note', TRUE) IS NOT DISTINCT FROM v_dn::TEXT;
  -- A note that has been sent out, delivered or signed is a record of what went: its items are frozen.
  IF EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.id = v_dn AND d.status IN ('despatched', 'delivered', 'signed'))
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.id = OLD.delivery_note_id AND d.status IN ('despatched', 'delivered', 'signed'))) THEN
    RAISE EXCEPTION 'This delivery note has been sent out, so its items can''t be changed.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.sales_order_line_id IS NOT NULL AND NOT v_via THEN
    RAISE EXCEPTION 'Items are linked to an order line by making the delivery note from the sales order.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.sales_order_line_id IS NOT NULL OR NEW.sales_order_line_id IS NOT NULL)
     AND (NEW.sales_order_line_id IS DISTINCT FROM OLD.sales_order_line_id OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.delivery_note_id IS DISTINCT FROM OLD.delivery_note_id) THEN
    RAISE EXCEPTION 'The quantity despatched on a delivery note made from an order can''t be changed: delete the note and make it again.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
       SELECT 1 FROM public.delivery_notes d JOIN public.invoices i ON i.id = d.invoice_id
       WHERE d.id = OLD.delivery_note_id AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')) THEN
    RAISE EXCEPTION 'This delivery note has been invoiced, so its items can''t be changed.' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS delivery_note_items_link_guard ON public.delivery_note_items;
CREATE TRIGGER delivery_note_items_link_guard BEFORE INSERT OR UPDATE OR DELETE ON public.delivery_note_items
  FOR EACH ROW EXECUTE FUNCTION public.delivery_note_items_link_guard();

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
  v_released TIMESTAMPTZ;
  v_job_no   TEXT;
  v_found    BOOLEAN := FALSE;
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
    IF NEW.job_id IS NOT NULL THEN
      SELECT j.inspected_at, j.job_no, TRUE INTO v_released, v_job_no, v_found FROM public.jobs j WHERE j.id = NEW.job_id AND j.organization_id = NEW.organization_id FOR SHARE;
    ELSIF nullif(btrim(NEW.job_ref), '') IS NOT NULL THEN
      SELECT j.inspected_at, j.job_no, TRUE INTO v_released, v_job_no, v_found FROM public.jobs j WHERE j.job_no = btrim(NEW.job_ref) AND j.organization_id = NEW.organization_id ORDER BY j.created_at LIMIT 1 FOR SHARE;
    END IF;
    IF coalesce(v_found, FALSE) AND v_released IS NULL THEN
      RAISE EXCEPTION '% hasn''t passed inspection (or its release was withdrawn), so delivery note % can''t be sent out.', v_job_no, OLD.dn_number USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS delivery_notes_link_guard ON public.delivery_notes;
CREATE TRIGGER delivery_notes_link_guard BEFORE INSERT OR UPDATE OR DELETE ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.delivery_notes_link_guard();

-- A draft invoice from one or more delivery notes made from orders: one line per order line, the quantity despatched on the
-- chosen notes at the order's own unit price and VAT, so nothing is typed again and the totals are the order's to the penny.
-- Every note must be linked to an order, have gone out, and not be on an invoice already (an invoice that is void or cancelled
-- lets its notes be invoiced again); all must be for one customer and agree on VAT. Locks the notes, so the same note can't be
-- invoiced twice. Admin and office. Returns { invoice_id, subtotal, vat, total, lines }.
CREATE OR REPLACE FUNCTION public.create_invoice_from_delivery_notes(p_notes UUID[], p_invoice_date DATE, p_due_date DATE, p_terms TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_ids     UUID[] := ARRAY(SELECT DISTINCT n FROM unnest(p_notes) AS n WHERE n IS NOT NULL);
  v_found   INT;
  v_dn      RECORD;
  v_cust    TEXT;
  v_reg     BOOLEAN := public.org_vat_registered(public.current_user_organization_id());
  v_vat_on  BOOLEAN;
  v_flags   INT;
  v_orders  INT;
  v_jobs    INT;
  v_lines   JSONB;
  v_net     NUMERIC;
  v_vat     NUMERIC;
  v_first   RECORD;
  v_so      RECORD;
  v_invoice UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
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
  END LOOP;

  SELECT count(DISTINCT coalesce(d.customer, '')), min(d.customer) INTO v_found, v_cust FROM public.delivery_notes d WHERE d.id = ANY (v_ids);
  IF v_found > 1 THEN
    RAISE EXCEPTION 'The delivery notes are for different customers: invoice each customer separately.' USING ERRCODE = '22023';
  END IF;

  -- One invoice line per order line: the total despatched on the chosen notes, at the order's price and VAT.
  SELECT count(DISTINCT o.vat_enabled), count(DISTINCT o.id), bool_or(o.vat_enabled) INTO v_flags, v_orders, v_vat_on
  FROM public.delivery_note_items i
  JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id
  JOIN public.sales_orders o ON o.id = l.sales_order_id
  WHERE i.delivery_note_id = ANY (v_ids);
  IF v_flags > 1 THEN
    RAISE EXCEPTION 'The orders disagree on VAT: invoice them separately.' USING ERRCODE = '22023';
  END IF;
  v_vat_on := coalesce(v_vat_on, FALSE) AND v_reg;

  SELECT jsonb_agg(jsonb_build_object('position', g.n - 1, 'description', g.description, 'quantity', g.quantity, 'unit_price', g.unit_price,
                                      'vat_pct', g.vat_pct, 'vat_exempt', g.vat_exempt) ORDER BY g.n),
         coalesce(sum(round(g.quantity * g.unit_price, 2)), 0),
         coalesce(sum(CASE WHEN g.vat_exempt THEN 0 ELSE round(round(g.quantity * g.unit_price, 2) * g.vat_pct / 100, 2) END), 0)
    INTO v_lines, v_net, v_vat
  FROM (
    SELECT row_number() OVER (ORDER BY o.so_number, l.position, l.id) AS n, l.description, sum(i.quantity) AS quantity, l.unit_price, l.vat_pct, l.vat_exempt
    FROM public.delivery_note_items i
    JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id
    JOIN public.sales_orders o ON o.id = l.sales_order_id
    WHERE i.delivery_note_id = ANY (v_ids)
    GROUP BY o.so_number, l.position, l.id
  ) g;
  v_vat := CASE WHEN v_vat_on THEN v_vat ELSE 0 END;

  SELECT l.description, sum(i.quantity) AS quantity, l.unit_price INTO v_first
  FROM public.delivery_note_items i JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id JOIN public.sales_orders o ON o.id = l.sales_order_id
  WHERE i.delivery_note_id = ANY (v_ids) GROUP BY o.so_number, l.position, l.id ORDER BY o.so_number, l.position, l.id LIMIT 1;
  SELECT o.quote_ref, o.customer_po INTO v_so
  FROM public.sales_orders o WHERE o.id = (SELECT d.sales_order_id FROM public.delivery_notes d WHERE d.id = ANY (v_ids) ORDER BY d.dn_number LIMIT 1);
  SELECT count(DISTINCT d.job_id) INTO v_jobs FROM public.delivery_notes d WHERE d.id = ANY (v_ids) AND d.job_id IS NOT NULL;

  v_invoice := public.create_with_lines(
    'invoices',
    jsonb_strip_nulls(jsonb_build_object(
      'customer', v_cust, 'description', v_first.description, 'quantity', v_first.quantity, 'unit_price', v_first.unit_price,
      'subtotal', v_net, 'carriage', 0, 'vat', v_vat, 'total', v_net + v_vat, 'vat_enabled', v_vat_on, 'carriage_vat', v_vat_on,
      'invoice_date', p_invoice_date, 'due_date', p_due_date, 'terms', nullif(btrim(p_terms), ''),
      'quote_ref', CASE WHEN v_orders = 1 THEN v_so.quote_ref END, 'customer_po', CASE WHEN v_orders = 1 THEN v_so.customer_po END,
      'job_id', CASE WHEN v_jobs = 1 THEN (SELECT d.job_id FROM public.delivery_notes d WHERE d.id = ANY (v_ids) AND d.job_id IS NOT NULL LIMIT 1) END,
      'status', 'draft', 'amount_paid', 0)),
    'invoice_line_items', 'invoice_id', v_lines);

  FOR v_dn IN SELECT unnest(v_ids) AS id LOOP
    PERFORM set_config('quoteflow.delivery_note_invoice', v_dn.id::TEXT, TRUE);
    UPDATE public.delivery_notes SET invoice_id = v_invoice WHERE id = v_dn.id;
  END LOOP;
  PERFORM set_config('quoteflow.delivery_note_invoice', '', TRUE);
  RETURN jsonb_build_object('invoice_id', v_invoice, 'subtotal', v_net, 'vat', v_vat, 'total', v_net + v_vat, 'lines', jsonb_array_length(v_lines));
END
$$;
REVOKE ALL ON FUNCTION public.create_invoice_from_delivery_notes(UUID[], DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_delivery_notes(UUID[], DATE, DATE, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Credit notes -----------------------------------------------------------------------------------------
-- A credit note is made against one issued invoice: lines, VAT, the CN- number series, and the same issue lock as an invoice
-- (once issued it can't be changed or deleted). Applying a credit to its invoice is an ALLOCATION, never a payment row: payments
-- stay what was received (invoices.amount_paid is still exactly the sum of invoice_payments); the credits applied are kept in
-- invoice_credit_allocations and totalled in invoices.credited_amount, and the balance due is
-- total - payments - credited_amount + refunded_amount (below zero it is customer credit, see below). An invoice paid off by a credit alone
-- has the status 'credited'.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS credited_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credited_amount >= 0);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0);

CREATE TABLE IF NOT EXISTS public.credit_notes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  invoice_id        UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  credit_ref        TEXT,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued')),
  customer          TEXT NOT NULL,
  credit_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  reason            TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  subtotal          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  vat               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (vat >= 0),
  total             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  vat_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  allocated_amount  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
  issuer_snapshot   JSONB,
  customer_snapshot JSONB,
  issued_at         TIMESTAMPTZ,
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_notes_issued_have_number CHECK (status = 'draft' OR credit_ref IS NOT NULL),
  CONSTRAINT credit_notes_allocated_within_total CHECK (allocated_amount <= total)
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_ref_org_uniq ON public.credit_notes (organization_id, credit_ref) WHERE credit_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON public.credit_notes (invoice_id);

CREATE TABLE IF NOT EXISTS public.credit_note_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  credit_note_id  UUID NOT NULL REFERENCES public.credit_notes(id) ON DELETE CASCADE,
  invoice_line_id UUID REFERENCES public.invoice_line_items(id) ON DELETE RESTRICT,
  position        INTEGER NOT NULL DEFAULT 0,
  description     TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity        NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_price      NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  vat_pct         NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_pct >= 0 AND vat_pct <= 100),
  vat_exempt      BOOLEAN NOT NULL DEFAULT FALSE,
  -- The VAT this line credits, worked out when the credit note is made (create_credit_note): the invoice line's VAT, shared out over all the
  -- credits for that line so that together they add up to it exactly (the last credit takes the rounding remainder).
  vat_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_note ON public.credit_note_lines (credit_note_id, position);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_invoice_line ON public.credit_note_lines (invoice_line_id) WHERE invoice_line_id IS NOT NULL;

-- One row per credit applied to an invoice. Append-only: written by allocate_credit_note, never changed.
CREATE TABLE IF NOT EXISTS public.invoice_credit_allocations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  invoice_id      UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  credit_note_id  UUID NOT NULL REFERENCES public.credit_notes(id) ON DELETE RESTRICT,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  allocated_on    DATE NOT NULL,
  request_id      UUID,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_credit_allocations_request_uniq ON public.invoice_credit_allocations (organization_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_credit_allocations_invoice ON public.invoice_credit_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_credit_allocations_credit ON public.invoice_credit_allocations (credit_note_id);

-- Same company, same people and the same page switch as invoices (admin and office; "invoices" hidden hides these too).
DO $do$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('credit_notes', TRUE), ('credit_note_lines', TRUE), ('invoice_credit_allocations', FALSE)) AS t(tbl, writable)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' rbac select', r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY[''admin'', ''office'']))', r.tbl || ' rbac select', r.tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' section access', r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.section_allowed(''invoices''))) WITH CHECK ((SELECT public.section_allowed(''invoices'')))', r.tbl || ' section access', r.tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', r.tbl);
    IF r.writable THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' rbac insert', r.tbl);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY[''admin'', ''office'']))', r.tbl || ' rbac insert', r.tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' rbac update', r.tbl);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY[''admin'', ''office''])) WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY[''admin'', ''office'']))', r.tbl || ' rbac update', r.tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' rbac delete', r.tbl);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY[''admin'', ''office'']))', r.tbl || ' rbac delete', r.tbl);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', r.tbl);
    ELSE
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', r.tbl);
    END IF;
  END LOOP;
END
$do$;
DROP TRIGGER IF EXISTS zz_same_org_invoice_id ON public.credit_notes;
CREATE TRIGGER zz_same_org_invoice_id BEFORE INSERT OR UPDATE OF invoice_id, organization_id ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('invoices', 'invoice_id');
DROP TRIGGER IF EXISTS zz_same_org_invoice_line_id ON public.credit_note_lines;
CREATE TRIGGER zz_same_org_invoice_line_id BEFORE INSERT OR UPDATE OF invoice_line_id, organization_id ON public.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('invoice_line_items', 'invoice_line_id');
DROP TRIGGER IF EXISTS zz_same_org_credit_note_id ON public.credit_note_lines;
CREATE TRIGGER zz_same_org_credit_note_id BEFORE INSERT OR UPDATE ON public.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('credit_notes', 'credit_note_id');
DROP TRIGGER IF EXISTS zz_same_org_invoice_id ON public.invoice_credit_allocations;
CREATE TRIGGER zz_same_org_invoice_id BEFORE INSERT OR UPDATE ON public.invoice_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('invoices', 'invoice_id');
DROP TRIGGER IF EXISTS zz_same_org_credit_note_id ON public.invoice_credit_allocations;
CREATE TRIGGER zz_same_org_credit_note_id BEFORE INSERT OR UPDATE ON public.invoice_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('credit_notes', 'credit_note_id');
DROP TRIGGER IF EXISTS audit_credit_notes_changes ON public.credit_notes;
CREATE TRIGGER audit_credit_notes_changes AFTER INSERT OR UPDATE OR DELETE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS audit_credit_note_lines_changes ON public.credit_note_lines;
CREATE TRIGGER audit_credit_note_lines_changes AFTER INSERT OR UPDATE OR DELETE ON public.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- The issue lock for credit notes, for the browser roles (the importer and the service role are exempt, so finished credit notes can be loaded): a credit note is created as a draft by
-- create_credit_note only, which sets its amounts, customer and invoice from the invoice's lines; those fields (and the snapshots, number and
-- status) are then fixed: a draft's reason and date are the only things that can be edited. Only issue_credit_note makes it issued
-- (number, snapshots, issue time); only allocate_credit_note changes allocated_amount; an issued credit note can't otherwise
-- change or be deleted, and its lines can't change.
CREATE OR REPLACE FUNCTION public.credit_note_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_open CONSTANT TEXT[] := ARRAY['updated_at', 'updated_by'];
  v_draft_editable CONSTANT TEXT[] := ARRAY['reason', 'credit_date', 'updated_at', 'updated_by'];
  v_via_issue BOOLEAN;
  v_via_allocation BOOLEAN;
BEGIN
  -- Only the browser roles are held to this; the importer, the database owner and the service role write finished records.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.credit_ref IS NOT NULL OR NEW.allocated_amount <> 0 OR NEW.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new credit note is saved as a draft and then issued.' USING ERRCODE = '42501';
    END IF;
    -- The header's amounts come from the lines and the invoice: only create_credit_note writes one.
    IF current_setting('quoteflow.credit_lines', TRUE) IS DISTINCT FROM NEW.id::TEXT THEN
      RAISE EXCEPTION 'A credit note is made with New credit note, from the invoice''s lines.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  v_via_issue := current_setting('quoteflow.credit_note', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  v_via_allocation := current_setting('quoteflow.credit_allocation', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF OLD.status = 'draft' THEN
    IF TG_OP = 'UPDATE' AND NOT v_via_issue THEN
      IF NEW.status <> 'draft' OR NEW.credit_ref IS NOT NULL OR NEW.issued_at IS NOT NULL OR NEW.allocated_amount <> 0 THEN
        RAISE EXCEPTION 'A credit note is issued with Issue credit note.' USING ERRCODE = '42501';
      END IF;
      IF (to_jsonb(NEW) - v_draft_editable) IS DISTINCT FROM (to_jsonb(OLD) - v_draft_editable) THEN
        RAISE EXCEPTION 'The invoice, customer and amounts of a credit note come from its lines and can''t be edited: delete the draft and make it again.' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit note % has been issued, so it can''t be deleted.', OLD.credit_ref USING ERRCODE = '42501';
  END IF;
  IF NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount AND NOT v_via_allocation THEN
    RAISE EXCEPTION 'Credit note %: a credit is applied to its invoice with Apply credit.', OLD.credit_ref USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_open - 'allocated_amount') IS DISTINCT FROM (to_jsonb(OLD) - v_open - 'allocated_amount') THEN
    RAISE EXCEPTION 'Credit note % has been issued: it can''t be changed.', OLD.credit_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS credit_notes_issue_lock ON public.credit_notes;
CREATE TRIGGER credit_notes_issue_lock BEFORE INSERT OR UPDATE OR DELETE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.credit_note_issue_lock();

CREATE OR REPLACE FUNCTION public.credit_note_lines_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old UUID := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.credit_note_id END;
  v_new UUID := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.credit_note_id END;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IN ('anon', 'authenticated') THEN
    -- Both the credit note a line is leaving and the one it is moving to count: a line can't be moved out of, or into, an issued one.
    IF EXISTS (SELECT 1 FROM public.credit_notes c WHERE c.id IN (v_old, v_new) AND c.status <> 'draft') THEN
      RAISE EXCEPTION 'That credit note has been issued, so its lines can''t be changed.' USING ERRCODE = '42501';
    END IF;
    -- Lines are written by create_credit_note only (which checks them against the invoice); a draft that is wrong is deleted and made
    -- again. Deleting the draft itself removes its lines (the parent is already gone when the cascade reaches them).
    IF current_setting('quoteflow.credit_lines', TRUE) IS DISTINCT FROM coalesce(v_new, v_old)::TEXT
       AND NOT (TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.credit_notes c WHERE c.id = v_old)) THEN
      RAISE EXCEPTION 'The lines of a credit note are set when it is made, from the invoice''s lines.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS credit_note_lines_issue_lock ON public.credit_note_lines;
CREATE TRIGGER credit_note_lines_issue_lock BEFORE INSERT OR UPDATE OR DELETE ON public.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION public.credit_note_lines_issue_lock();

-- The caps on the credit notes of one invoice, worked out from their LINES (never from a credit note's header): per invoice line, the
-- quantity, the net and the VAT credited in all (every credit note of the invoice, drafts too) can't pass what was invoiced, and the
-- credit notes together can't be for more than the invoice's total.
CREATE OR REPLACE FUNCTION public.check_credit_note_caps(p_invoice UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_vat_on  BOOLEAN;
  v_total   NUMERIC;
  v_credits NUMERIC;
  r         RECORD;
BEGIN
  SELECT i.vat_enabled AND CASE WHEN i.issuer_snapshot IS NULL THEN public.org_vat_registered(v_org)
                                ELSE NOT (i.issuer_snapshot -> 'vatRegistered' IS NOT DISTINCT FROM 'false'::JSONB) END, i.total
    INTO v_vat_on, v_total FROM public.invoices i WHERE i.id = p_invoice AND i.organization_id = v_org;
  -- Each invoice line: the quantity, the net and the VAT credited so far can't pass what was invoiced.
  FOR r IN
    SELECT il.description, il.quantity AS q, round(il.quantity * il.unit_price, 2) AS n,
           CASE WHEN il.vat_exempt OR NOT v_vat_on THEN 0 ELSE round(round(il.quantity * il.unit_price, 2) * il.vat_pct / 100, 2) END AS v,
           coalesce(sum(l.quantity), 0) AS cq, coalesce(sum(round(l.quantity * l.unit_price, 2)), 0) AS cn, coalesce(sum(l.vat_amount), 0) AS cv
    FROM public.invoice_line_items il
    JOIN public.credit_note_lines l ON l.invoice_line_id = il.id
    JOIN public.credit_notes c ON c.id = l.credit_note_id AND c.invoice_id = p_invoice
    WHERE il.invoice_id = p_invoice
    GROUP BY il.id
  LOOP
    IF r.cq > r.q THEN
      RAISE EXCEPTION 'More credited than invoiced on "%": % invoiced, % credited in all.', left(r.description, 60), trim_scale(r.q), trim_scale(r.cq) USING ERRCODE = '22023';
    END IF;
    IF r.cn > r.n THEN
      RAISE EXCEPTION 'More credited than invoiced on "%": % net invoiced, % credited in all.', left(r.description, 60), chr(163) || to_char(r.n, 'FM999999990.00'), chr(163) || to_char(r.cn, 'FM999999990.00') USING ERRCODE = '22023';
    END IF;
    IF r.cv > r.v THEN
      RAISE EXCEPTION 'More VAT credited than was charged on "%": % charged, % credited in all.', left(r.description, 60), chr(163) || to_char(r.v, 'FM999999990.00'), chr(163) || to_char(r.cv, 'FM999999990.00') USING ERRCODE = '22023';
    END IF;
  END LOOP;
  SELECT coalesce(sum(round(l.quantity * l.unit_price, 2) + l.vat_amount), 0) INTO v_credits
    FROM public.credit_note_lines l JOIN public.credit_notes c ON c.id = l.credit_note_id WHERE c.invoice_id = p_invoice;
  IF v_credits > v_total THEN
    RAISE EXCEPTION 'That credits more than the invoice: credit notes of % in all against an invoice of %.', chr(163) || to_char(v_credits, 'FM999999990.00'), chr(163) || to_char(v_total, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.check_credit_note_caps(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_credit_note_caps(UUID) TO authenticated;

-- A draft credit note against an issued invoice. p_lines is [{ invoice_line_id, quantity, unit_price (optional, at most the invoiced price) }]:
-- each line is one of the invoice's own lines, and its description, VAT rate and exemption are the invoice's (the caller can't choose them).
-- VAT counts only if the invoice charged it and the company was VAT registered when it was issued. The quantity, net and VAT credited on a
-- line, with the credit notes already made for it, can't pass what was invoiced; the invoice row is locked first so two credit notes made at once
-- are checked one after the other. Totals are worked out here from the lines. The VAT of an invoice line is shared out over its credits
-- (credit_note_lines.vat_amount): each credit takes the VAT on everything credited so far, less what the earlier credits took, and a credit that
-- takes the last of the line's quantity takes whatever is left of the line's VAT, so the credits for a line always add up to exactly the VAT the
-- invoice charged on it (2 at £50.03 charge £20.01 VAT; credited one at a time that is £10.01 and then £10.00, not £10.01 twice).
-- Admin and office. Returns the credit note's id.
CREATE OR REPLACE FUNCTION public.create_credit_note(p_invoice UUID, p_reason TEXT, p_credit_date DATE, p_lines JSONB)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_inv    RECORD;
  v_item   JSONB;
  v_il     public.invoice_line_items%ROWTYPE;
  v_pos    INT := 0;
  v_qty    NUMERIC;
  v_price  NUMERIC;
  v_net    NUMERIC := 0;
  v_vat    NUMERIC := 0;
  v_line   NUMERIC;
  v_line_vat NUMERIC;
  v_vats   NUMERIC[] := ARRAY[]::NUMERIC[];
  v_il_net NUMERIC;
  v_il_vat NUMERIC;
  v_pq     NUMERIC;
  v_pn     NUMERIC;
  v_pv     NUMERIC;
  v_target NUMERIC;
  v_vat_on BOOLEAN;
  v_seen   UUID[] := ARRAY[]::UUID[];
  v_id     UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 OR jsonb_array_length(p_lines) > 100 THEN
    RAISE EXCEPTION 'Add between one and a hundred lines to the credit note.' USING ERRCODE = '22023';
  END IF;
  IF p_credit_date IS NULL THEN
    RAISE EXCEPTION 'The credit note needs a date.' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_reason, '')) > 500 THEN
    RAISE EXCEPTION 'The reason can be at most 500 characters.' USING ERRCODE = '22023';
  END IF;
  SELECT id, invoice_ref, status, customer, total, vat_enabled, issuer_snapshot INTO v_inv FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF lower(coalesce(v_inv.status, 'draft')) IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'written_off') THEN
    RAISE EXCEPTION '% is % and can''t be credited.', coalesce(v_inv.invoice_ref, 'This invoice'), coalesce(v_inv.status, 'a draft') USING ERRCODE = '22023';
  END IF;
  -- The tax treatment of the invoice as it was issued.
  v_vat_on := v_inv.vat_enabled AND CASE WHEN v_inv.issuer_snapshot IS NULL THEN public.org_vat_registered(v_org)
                                         ELSE NOT (v_inv.issuer_snapshot -> 'vatRegistered' IS NOT DISTINCT FROM 'false'::JSONB) END;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR coalesce(v_item ->> 'invoice_line_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Every line must be one of the invoice''s lines, with a quantity.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_il FROM public.invoice_line_items WHERE id = (v_item ->> 'invoice_line_id')::UUID AND invoice_id = p_invoice AND organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A line isn''t on %.', coalesce(v_inv.invoice_ref, 'the invoice') USING ERRCODE = '22023';
    END IF;
    IF v_il.id = ANY (v_seen) THEN
      RAISE EXCEPTION 'A line is listed twice.' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_il.id;
    BEGIN
      v_qty := (v_item ->> 'quantity')::NUMERIC;
      v_price := coalesce((v_item ->> 'unit_price')::NUMERIC, v_il.unit_price);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Every line needs a quantity and, if given, a price.' USING ERRCODE = '22023';
    END;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> round(v_qty, 3) OR v_price < 0 OR v_price <> round(v_price, 2) OR v_price > v_il.unit_price THEN
      RAISE EXCEPTION 'Every line needs a quantity above zero (three decimal places at most) and a price in pounds and pence, no more than was invoiced.' USING ERRCODE = '22023';
    END IF;
    v_line := round(v_qty * v_price, 2);
    v_net := v_net + v_line;
    v_line_vat := 0;
    IF v_vat_on AND NOT v_il.vat_exempt THEN
      -- What the invoice line charged, and what the credit notes already made for it (drafts too; the invoice is locked) have taken.
      v_il_net := round(v_il.quantity * v_il.unit_price, 2);
      v_il_vat := round(v_il_net * v_il.vat_pct / 100, 2);
      SELECT coalesce(sum(l.quantity), 0), coalesce(sum(round(l.quantity * l.unit_price, 2)), 0), coalesce(sum(l.vat_amount), 0)
        INTO v_pq, v_pn, v_pv FROM public.credit_note_lines l WHERE l.invoice_line_id = v_il.id;
      v_target := CASE WHEN v_pq + v_qty >= v_il.quantity AND v_pn + v_line >= v_il_net - 0.01 THEN v_il_vat
                       ELSE least(v_il_vat, round((v_pn + v_line) * v_il.vat_pct / 100, 2)) END;
      v_line_vat := greatest(0, v_target - v_pv);
    END IF;
    v_vat := v_vat + v_line_vat;
    v_vats := v_vats || v_line_vat;
  END LOOP;
  IF v_net + v_vat <= 0 THEN
    RAISE EXCEPTION 'The credit note has to be for more than nothing.' USING ERRCODE = '22023';
  END IF;

  -- The header is written here and nowhere else (the lock trigger refuses any other insert and any later change to its amounts).
  v_id := gen_random_uuid();
  PERFORM set_config('quoteflow.credit_lines', v_id::TEXT, TRUE);
  INSERT INTO public.credit_notes (id, organization_id, invoice_id, customer, credit_date, reason, subtotal, vat, total, vat_enabled, created_by, updated_by)
  VALUES (v_id, v_org, p_invoice, v_inv.customer, p_credit_date, nullif(btrim(p_reason), ''), v_net, v_vat, v_net + v_vat, v_vat_on, auth.uid(), auth.uid());
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_il FROM public.invoice_line_items WHERE id = (v_item ->> 'invoice_line_id')::UUID;
    INSERT INTO public.credit_note_lines (organization_id, credit_note_id, invoice_line_id, position, description, quantity, unit_price, vat_pct, vat_exempt, vat_amount)
    VALUES (v_org, v_id, v_il.id, v_pos, v_il.description, (v_item ->> 'quantity')::NUMERIC, coalesce((v_item ->> 'unit_price')::NUMERIC, v_il.unit_price), v_il.vat_pct, v_il.vat_exempt, v_vats[v_pos + 1]);
    v_pos := v_pos + 1;
  END LOOP;
  PERFORM set_config('quoteflow.credit_lines', '', TRUE);
  PERFORM public.check_credit_note_caps(p_invoice);
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.create_credit_note(UUID, TEXT, DATE, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_credit_note(UUID, TEXT, DATE, JSONB) TO authenticated;

-- Issues a draft credit note and applies it to its invoice, in one transaction (nothing is issued without being applied, nothing applied
-- without being issued): gives it the next CN number, freezes it with the issuer's and customer's details as they are now, and records
-- the whole credit against the invoice (allocate_credit_note). What the invoice still owed is paid off by it; whatever is beyond that is
-- customer credit on the invoice (paid + credited - refunded - total), which shows on the invoice and can be refunded or applied to another
-- invoice of the customer: it is never left unapplied or hidden.
-- Before anything is written the credit note is worked out again from its LINES and the invoice, never from its header: the header must
-- match the lines to the penny (net, VAT, total), each line must be one of the invoice's own lines (its description, rate and exemption the
-- invoice's, a price no higher than invoiced, VAT within a penny or two of the rate and no VAT on an exempt line or an invoice without it),
-- and the caps hold again, now that the invoice is locked. Issuing it again returns its number. Admin and office.
CREATE OR REPLACE FUNCTION public.issue_credit_note(p_credit UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_invoice UUID;
  v_cn      public.credit_notes%ROWTYPE;
  v_inv     RECORD;
  v_ref     TEXT;
  v_vat_on  BOOLEAN;
  v_net     NUMERIC;
  v_vat     NUMERIC;
  v_bad     INTEGER;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  -- The invoice is locked first, then the credit note (the order allocate_credit_note uses), so the two never wait for each other.
  SELECT invoice_id INTO v_invoice FROM public.credit_notes WHERE id = p_credit AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT id, invoice_ref, status, customer, total, vat_enabled, issuer_snapshot INTO v_inv FROM public.invoices WHERE id = v_invoice AND organization_id = v_org FOR UPDATE;
  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_credit AND organization_id = v_org FOR UPDATE;
  IF v_cn.status <> 'draft' THEN
    RETURN v_cn.credit_ref;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.credit_note_lines WHERE credit_note_id = p_credit) THEN
    RAISE EXCEPTION 'Add at least one line before issuing.' USING ERRCODE = '22023';
  END IF;
  IF lower(coalesce(v_inv.status, 'draft')) IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'written_off') THEN
    RAISE EXCEPTION '% is % and can''t be credited.', coalesce(v_inv.invoice_ref, 'The invoice'), coalesce(v_inv.status, 'a draft') USING ERRCODE = '22023';
  END IF;

  -- The credit note again, from its lines and the invoice.
  v_vat_on := v_inv.vat_enabled AND CASE WHEN v_inv.issuer_snapshot IS NULL THEN public.org_vat_registered(v_org)
                                         ELSE NOT (v_inv.issuer_snapshot -> 'vatRegistered' IS NOT DISTINCT FROM 'false'::JSONB) END;
  SELECT coalesce(sum(round(l.quantity * l.unit_price, 2)), 0), coalesce(sum(l.vat_amount), 0) INTO v_net, v_vat FROM public.credit_note_lines l WHERE l.credit_note_id = p_credit;
  SELECT count(*) INTO v_bad
    FROM public.credit_note_lines l
    LEFT JOIN public.invoice_line_items il ON il.id = l.invoice_line_id AND il.invoice_id = v_invoice AND il.organization_id = v_org
    WHERE l.credit_note_id = p_credit
      AND (il.id IS NULL OR l.organization_id <> v_org OR l.description IS DISTINCT FROM il.description OR l.vat_pct IS DISTINCT FROM il.vat_pct OR l.vat_exempt IS DISTINCT FROM il.vat_exempt
           OR l.unit_price > il.unit_price
           OR (l.vat_exempt OR NOT v_vat_on) AND l.vat_amount <> 0
           OR NOT (l.vat_exempt OR NOT v_vat_on) AND abs(l.vat_amount - round(l.quantity * l.unit_price, 2) * l.vat_pct / 100) > 0.02);
  IF v_bad > 0 OR v_cn.customer IS DISTINCT FROM v_inv.customer OR v_cn.vat_enabled IS DISTINCT FROM v_vat_on
     OR v_cn.subtotal IS DISTINCT FROM v_net OR v_cn.vat IS DISTINCT FROM v_vat OR v_cn.total IS DISTINCT FROM v_net + v_vat OR v_net + v_vat <= 0 THEN
    RAISE EXCEPTION 'This credit note does not match its lines and the invoice (it is for % but its lines come to %): nothing was issued. Delete the draft and make it again.',
      chr(163) || to_char(v_cn.total, 'FM999999990.00'), chr(163) || to_char(v_net + v_vat, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  -- The caps again, now that the invoice is locked: every line, and the invoice's total, against all the credit notes made for it.
  PERFORM public.check_credit_note_caps(v_invoice);

  v_ref := public.next_doc_number('CN');
  PERFORM set_config('quoteflow.credit_note', p_credit::TEXT, TRUE);
  UPDATE public.credit_notes
     SET status = 'issued', credit_ref = v_ref, issued_at = now(),
         issuer_snapshot = coalesce(v_inv.issuer_snapshot, public.issuer_snapshot(v_org)), customer_snapshot = public.customer_snapshot(v_org, v_cn.customer)
   WHERE id = p_credit;
  PERFORM set_config('quoteflow.credit_note', '', TRUE);
  -- Apply all of it to the invoice in the same transaction: the invoice settles by what it owed and the rest is customer credit.
  PERFORM public.allocate_credit_note(p_credit, v_cn.total, gen_random_uuid());
  RETURN v_ref;
END
$$;
REVOKE ALL ON FUNCTION public.issue_credit_note(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_credit_note(UUID) TO authenticated;

-- Applies an issued credit note (or what is left of one) to its invoice. issue_credit_note calls it for the whole credit note, in its own
-- transaction, so nothing is ever issued and left unapplied; it can still be called for a remainder. A row in invoice_credit_allocations
-- (not a payment), the credit note's allocated_amount and the invoice's credited_amount go up together, and the invoice becomes 'paid' (if
-- payments were also received) or 'credited' (if the credit alone settles it) when nothing is left to pay. The part of the credit that the
-- invoice still owed is what settles it; any more than that is customer credit on the invoice (payments + credits - refunds - total), not
-- lost and not capped away. Locks the invoice, then the credit note, like the payment functions. Refuses more than the credit note has
-- left, an invoice whose payments don't add up to its amount paid, and a repeated request id returns the first allocation. Admin and office.
-- Returns { allocation_id, credited_amount, applied_to_balance, balance_due, customer_credit, status }.
CREATE OR REPLACE FUNCTION public.allocate_credit_note(p_credit UUID, p_amount NUMERIC, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_invoice UUID;
  v_cn      public.credit_notes%ROWTYPE;
  v_inv     RECORD;
  v_label   TEXT;
  v_sum     NUMERIC(12,2);
  v_new_credit NUMERIC(12,2);
  v_applied NUMERIC(12,2);
  v_balance NUMERIC(12,2);
  v_new_status TEXT;
  v_paid_at TIMESTAMPTZ;
  v_alloc   UUID;
  v_prior   RECORD;
  v_email   TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required.' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'The credit to apply must be more than zero.' USING ERRCODE = '22023';
  END IF;
  IF p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'The credit can have at most two decimal places (pence); it is not rounded.' USING ERRCODE = '22023';
  END IF;

  SELECT invoice_id INTO v_invoice FROM public.credit_notes WHERE id = p_credit AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT id, invoice_ref, status, total, amount_paid, credited_amount, refunded_amount, paid_at INTO v_inv FROM public.invoices WHERE id = v_invoice AND organization_id = v_org FOR UPDATE;
  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_credit AND organization_id = v_org FOR UPDATE;
  v_label := coalesce(v_inv.invoice_ref, 'This invoice');

  SELECT id, credit_note_id, amount INTO v_prior FROM public.invoice_credit_allocations WHERE organization_id = v_org AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.credit_note_id <> p_credit THEN
      RAISE EXCEPTION 'That request id was used for another credit note.' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('allocation_id', v_prior.id, 'credited_amount', v_inv.credited_amount,
                              'balance_due', greatest(0, v_inv.total - v_inv.amount_paid - v_inv.credited_amount + v_inv.refunded_amount),
                              'customer_credit', greatest(0, v_inv.amount_paid + v_inv.credited_amount - v_inv.refunded_amount - v_inv.total),
                              'status', v_inv.status, 'repeated', TRUE);
  END IF;
  IF v_cn.status <> 'issued' THEN
    RAISE EXCEPTION 'Issue the credit note before applying it.' USING ERRCODE = '22023';
  END IF;
  IF lower(coalesce(v_inv.status, 'draft')) IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'written_off') THEN
    RAISE EXCEPTION '% is % and can''t take a credit.', v_label, coalesce(v_inv.status, 'a draft') USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO v_sum FROM public.invoice_payments WHERE invoice_id = v_invoice;
  IF v_sum IS DISTINCT FROM v_inv.amount_paid THEN
    RAISE EXCEPTION '% shows % paid but its payments add up to %: nothing was applied. Ask for the payments to be checked.',
      v_label, chr(163) || to_char(v_inv.amount_paid, 'FM999999990.00'), chr(163) || to_char(v_sum, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  IF p_amount > v_cn.total - v_cn.allocated_amount THEN
    RAISE EXCEPTION 'That is more than the credit note has left (% of % still to apply): nothing was applied.',
      chr(163) || to_char(v_cn.total - v_cn.allocated_amount, 'FM999999990.00'), chr(163) || to_char(v_cn.total, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.invoice_credit_allocations (organization_id, invoice_id, credit_note_id, amount, allocated_on, request_id, created_by)
  VALUES (v_org, v_invoice, p_credit, p_amount, v_today, p_request_id, v_user)
  RETURNING id INTO v_alloc;

  PERFORM set_config('quoteflow.credit_allocation', p_credit::TEXT, TRUE);
  UPDATE public.credit_notes SET allocated_amount = allocated_amount + p_amount WHERE id = p_credit;
  PERFORM set_config('quoteflow.credit_allocation', '', TRUE);

  -- balance = total - payments - credits applied + refunds. Below zero, what the customer has paid or been credited beyond the invoice is
  -- customer credit (customer_credit_ledger): it can be refunded or applied to another invoice of theirs, and is never lost.
  v_new_credit := v_inv.credited_amount + p_amount;
  v_applied := least(p_amount, greatest(0, v_inv.total - v_sum - v_inv.credited_amount + v_inv.refunded_amount)); -- what the invoice still owed; the rest of the credit is customer credit
  v_balance := v_inv.total - v_sum - v_new_credit + v_inv.refunded_amount;
  v_new_status := CASE WHEN v_balance <= 0 THEN CASE WHEN v_sum > 0 THEN 'paid' ELSE 'credited' END ELSE v_inv.status END;
  v_paid_at := CASE WHEN v_new_status = 'paid' THEN coalesce(v_inv.paid_at, (v_today + TIME '12:00') AT TIME ZONE 'UTC') ELSE v_inv.paid_at END;
  PERFORM set_config('quoteflow.invoice_payment', v_invoice::TEXT, TRUE);
  UPDATE public.invoices SET credited_amount = v_new_credit, status = v_new_status, paid_at = v_paid_at WHERE id = v_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'APPLY_CREDIT', 'invoices', v_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'allocation_id', v_alloc, 'credit_note_id', p_credit, 'credit_ref', v_cn.credit_ref,
                             'invoice_ref', v_inv.invoice_ref, 'amount', p_amount, 'applied_to_balance', v_applied, 'balance_due', greatest(0, v_balance),
                             'customer_credit', greatest(0, -v_balance), 'status', v_new_status));
  RETURN jsonb_build_object('allocation_id', v_alloc, 'credited_amount', v_new_credit, 'applied_to_balance', v_applied, 'balance_due', greatest(0, v_balance), 'customer_credit', greatest(0, -v_balance), 'status', v_new_status);
END
$$;
REVOKE ALL ON FUNCTION public.allocate_credit_note(UUID, NUMERIC, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.allocate_credit_note(UUID, NUMERIC, UUID) TO authenticated;

-- ---- Customer credit: what a customer has paid or been credited beyond an invoice ---------------------------------------------
-- balance = total - payments - credits applied + refunds. When it is below zero the difference is the customer's credit on that
-- account. It never disappears and is never netted silently: it is refunded (admin only) or applied to another invoice of the same
-- customer, and each of those is a row of the append-only customer_credit_ledger (who, when, how much, why), audited.
-- invoices.refunded_amount is the total of the ledger rows that took credit out of the invoice; invoices.credited_amount is the credit
-- notes applied to it plus the customer credit applied to it from other invoices.
CREATE TABLE IF NOT EXISTS public.customer_credit_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  kind            TEXT NOT NULL CHECK (kind IN ('refund', 'transfer')),
  invoice_id      UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  to_invoice_id   UUID REFERENCES public.invoices(id) ON DELETE RESTRICT,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method          TEXT CHECK (method IS NULL OR method IN ('BACS', 'cheque', 'card', 'cash', 'other')),
  reference       TEXT CHECK (reference IS NULL OR length(reference) <= 100),
  reason          TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  paid_on         DATE,
  request_id      UUID,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_credit_ledger_transfer_has_target CHECK ((kind = 'transfer') = (to_invoice_id IS NOT NULL)),
  CONSTRAINT customer_credit_ledger_refund_has_date CHECK (kind <> 'refund' OR paid_on IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_credit_ledger_request_uniq ON public.customer_credit_ledger (organization_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_credit_ledger_invoice ON public.customer_credit_ledger (invoice_id);
CREATE INDEX IF NOT EXISTS idx_customer_credit_ledger_to ON public.customer_credit_ledger (to_invoice_id) WHERE to_invoice_id IS NOT NULL;
ALTER TABLE public.customer_credit_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_credit_ledger rbac select" ON public.customer_credit_ledger;
CREATE POLICY "customer_credit_ledger rbac select" ON public.customer_credit_ledger FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
DROP POLICY IF EXISTS "customer_credit_ledger section access" ON public.customer_credit_ledger;
CREATE POLICY "customer_credit_ledger section access" ON public.customer_credit_ledger AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.section_allowed('invoices'))) WITH CHECK ((SELECT public.section_allowed('invoices')));
REVOKE ALL ON public.customer_credit_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_credit_ledger TO authenticated;
DROP TRIGGER IF EXISTS zz_same_org_invoice_id ON public.customer_credit_ledger;
CREATE TRIGGER zz_same_org_invoice_id BEFORE INSERT OR UPDATE ON public.customer_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('invoices', 'invoice_id');
DROP TRIGGER IF EXISTS zz_same_org_to_invoice_id ON public.customer_credit_ledger;
CREATE TRIGGER zz_same_org_to_invoice_id BEFORE INSERT OR UPDATE ON public.customer_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('invoices', 'to_invoice_id');
-- A refund is money leaving: with the optional admin two-step rule on, it needs the second step, like reversing a payment. 033's
-- require_admin_mfa_guard() is a STATEMENT trigger function (it returns NULL, which in a row trigger would silently skip the row),
-- so the ledger gets 033's per-statement admin_mfa trigger in section 6, and refund_customer_credit starts with the check itself.
DROP TRIGGER IF EXISTS customer_credit_refund_admin_mfa ON public.customer_credit_ledger;

-- Refunds the customer's credit on one invoice (the amount by which payments and credits applied exceed what was invoiced, less what has
-- already left it). Admin only. Records the ledger row, raises invoices.refunded_amount and audits REFUND_CUSTOMER_CREDIT in one
-- transaction. The invoice is locked first; a repeated request id returns the first refund. Returns { ledger_id, customer_credit, balance_due, status }.
CREATE OR REPLACE FUNCTION public.refund_customer_credit(p_invoice UUID, p_amount NUMERIC, p_paid_on DATE, p_method TEXT, p_reference TEXT, p_reason TEXT, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_today  DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_method TEXT := nullif(btrim(p_method), '');
  v_ref    TEXT := nullif(btrim(p_reference), '');
  v_reason TEXT := nullif(btrim(p_reason), '');
  v_inv    RECORD;
  v_sum    NUMERIC(12,2);
  v_credit NUMERIC(12,2);
  v_id     UUID;
  v_prior  RECORD;
  v_email  TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required.' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'The refund must be more than zero, in pounds and pence.' USING ERRCODE = '22023';
  END IF;
  IF p_paid_on IS NULL OR p_paid_on > v_today THEN
    RAISE EXCEPTION 'The date the refund was paid is required and can''t be in the future.' USING ERRCODE = '22023';
  END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('BACS', 'cheque', 'card', 'cash', 'other') THEN
    RAISE EXCEPTION 'The refund method must be BACS, cheque, card, cash or other.' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(v_ref, '')) > 100 OR length(coalesce(v_reason, '')) > 500 THEN
    RAISE EXCEPTION 'The reference is at most 100 characters and the reason 500.' USING ERRCODE = '22023';
  END IF;
  SELECT id, invoice_ref, status, total, amount_paid, credited_amount, refunded_amount INTO v_inv FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT id, invoice_id INTO v_prior FROM public.customer_credit_ledger WHERE organization_id = v_org AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.invoice_id <> p_invoice THEN
      RAISE EXCEPTION 'That request id was used for another invoice.' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ledger_id', v_prior.id, 'customer_credit', greatest(0, v_inv.amount_paid + v_inv.credited_amount - v_inv.refunded_amount - v_inv.total), 'status', v_inv.status, 'repeated', TRUE);
  END IF;
  IF lower(coalesce(v_inv.status, 'draft')) IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'written_off') THEN
    RAISE EXCEPTION '% is % and has no credit to refund.', coalesce(v_inv.invoice_ref, 'This invoice'), coalesce(v_inv.status, 'a draft') USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO v_sum FROM public.invoice_payments WHERE invoice_id = p_invoice;
  IF v_sum IS DISTINCT FROM v_inv.amount_paid THEN
    RAISE EXCEPTION '% shows % paid but its payments add up to %: nothing was refunded. Ask for the payments to be checked.',
      coalesce(v_inv.invoice_ref, 'This invoice'), chr(163) || to_char(v_inv.amount_paid, 'FM999999990.00'), chr(163) || to_char(v_sum, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  v_credit := v_sum + v_inv.credited_amount - v_inv.refunded_amount - v_inv.total;
  IF v_credit <= 0 THEN
    RAISE EXCEPTION '% has no customer credit to refund.', coalesce(v_inv.invoice_ref, 'This invoice') USING ERRCODE = '22023';
  END IF;
  IF p_amount > v_credit THEN
    RAISE EXCEPTION 'That is more than the customer credit on % (% available): nothing was refunded.', coalesce(v_inv.invoice_ref, 'this invoice'), chr(163) || to_char(v_credit, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.customer_credit_ledger (organization_id, kind, invoice_id, amount, method, reference, reason, paid_on, request_id, created_by)
  VALUES (v_org, 'refund', p_invoice, p_amount, v_method, v_ref, v_reason, p_paid_on, p_request_id, v_user)
  RETURNING id INTO v_id;
  PERFORM set_config('quoteflow.invoice_payment', p_invoice::TEXT, TRUE);
  UPDATE public.invoices SET refunded_amount = refunded_amount + p_amount WHERE id = p_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'REFUND_CUSTOMER_CREDIT', 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'ledger_id', v_id, 'invoice_ref', v_inv.invoice_ref, 'amount', p_amount, 'paid_on', p_paid_on,
                             'method', v_method, 'reference', v_ref, 'reason', v_reason, 'customer_credit', v_credit - p_amount));
  RETURN jsonb_build_object('ledger_id', v_id, 'customer_credit', v_credit - p_amount, 'status', v_inv.status);
END
$$;
REVOKE ALL ON FUNCTION public.refund_customer_credit(UUID, NUMERIC, DATE, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_customer_credit(UUID, NUMERIC, DATE, TEXT, TEXT, TEXT, UUID) TO authenticated;

-- Applies customer credit from one invoice to another open invoice of the same customer (same company). The target can't be given more
-- than it still owes. Locks both invoices in a fixed order. Admin and office. Ledger row of kind 'transfer', audited APPLY_CUSTOMER_CREDIT.
-- Returns { ledger_id, from_credit, to_balance_due, to_status }.
CREATE OR REPLACE FUNCTION public.apply_customer_credit(p_from UUID, p_to UUID, p_amount NUMERIC, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_from    RECORD;
  v_to      RECORD;
  v_sum_f   NUMERIC(12,2);
  v_sum_t   NUMERIC(12,2);
  v_credit  NUMERIC(12,2);
  v_balance NUMERIC(12,2);
  v_status  TEXT;
  v_paid_at TIMESTAMPTZ;
  v_id      UUID;
  v_prior   RECORD;
  v_email   TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN
    RAISE EXCEPTION 'Choose a different invoice to apply the credit to.' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'The credit to apply must be more than zero, in pounds and pence.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.invoices WHERE id IN (p_from, p_to) AND organization_id = v_org ORDER BY id FOR UPDATE;
  SELECT id, invoice_ref, status, customer, total, amount_paid, credited_amount, refunded_amount INTO v_from FROM public.invoices WHERE id = p_from AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT id, invoice_ref, status, customer, total, amount_paid, credited_amount, refunded_amount, paid_at INTO v_to FROM public.invoices WHERE id = p_to AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT id, invoice_id, to_invoice_id INTO v_prior FROM public.customer_credit_ledger WHERE organization_id = v_org AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.invoice_id <> p_from OR v_prior.to_invoice_id IS DISTINCT FROM p_to THEN
      RAISE EXCEPTION 'That request id was used for something else.' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ledger_id', v_prior.id, 'repeated', TRUE);
  END IF;
  IF v_from.customer IS DISTINCT FROM v_to.customer OR coalesce(v_from.customer, '') = '' THEN
    RAISE EXCEPTION 'Customer credit can only be applied to another invoice of the same customer.' USING ERRCODE = '22023';
  END IF;
  IF lower(coalesce(v_from.status, 'draft')) IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'written_off') THEN
    RAISE EXCEPTION '% is % and has no credit to apply.', coalesce(v_from.invoice_ref, 'This invoice'), coalesce(v_from.status, 'a draft') USING ERRCODE = '22023';
  END IF;
  IF lower(coalesce(v_to.status, 'draft')) IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off', 'paid') THEN
    RAISE EXCEPTION '% is % and can''t take a credit.', coalesce(v_to.invoice_ref, 'That invoice'), coalesce(v_to.status, 'a draft') USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO v_sum_f FROM public.invoice_payments WHERE invoice_id = p_from;
  SELECT coalesce(sum(amount), 0) INTO v_sum_t FROM public.invoice_payments WHERE invoice_id = p_to;
  IF v_sum_f IS DISTINCT FROM v_from.amount_paid OR v_sum_t IS DISTINCT FROM v_to.amount_paid THEN
    RAISE EXCEPTION 'An invoice''s payments don''t add up to its amount paid: nothing was applied. Ask for the payments to be checked.' USING ERRCODE = '22023';
  END IF;
  v_credit := v_sum_f + v_from.credited_amount - v_from.refunded_amount - v_from.total;
  IF v_credit <= 0 THEN
    RAISE EXCEPTION '% has no customer credit to apply.', coalesce(v_from.invoice_ref, 'This invoice') USING ERRCODE = '22023';
  END IF;
  IF p_amount > v_credit THEN
    RAISE EXCEPTION 'That is more than the customer credit on % (% available): nothing was applied.', coalesce(v_from.invoice_ref, 'this invoice'), chr(163) || to_char(v_credit, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  v_balance := v_to.total - v_sum_t - v_to.credited_amount + v_to.refunded_amount;
  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'That is more than the balance due on % (% of %): nothing was applied.', coalesce(v_to.invoice_ref, 'that invoice'), chr(163) || to_char(greatest(v_balance, 0), 'FM999999990.00'), chr(163) || to_char(v_to.total, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.customer_credit_ledger (organization_id, kind, invoice_id, to_invoice_id, amount, request_id, created_by)
  VALUES (v_org, 'transfer', p_from, p_to, p_amount, p_request_id, v_user)
  RETURNING id INTO v_id;
  v_status := CASE WHEN v_balance - p_amount <= 0 THEN CASE WHEN v_sum_t > 0 THEN 'paid' ELSE 'credited' END ELSE v_to.status END;
  v_paid_at := CASE WHEN v_status = 'paid' THEN coalesce(v_to.paid_at, (v_today + TIME '12:00') AT TIME ZONE 'UTC') ELSE v_to.paid_at END;
  PERFORM set_config('quoteflow.invoice_payment', p_from::TEXT, TRUE);
  UPDATE public.invoices SET refunded_amount = refunded_amount + p_amount WHERE id = p_from;
  PERFORM set_config('quoteflow.invoice_payment', p_to::TEXT, TRUE);
  UPDATE public.invoices SET credited_amount = credited_amount + p_amount, status = v_status, paid_at = v_paid_at WHERE id = p_to;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'APPLY_CUSTOMER_CREDIT', 'invoices', p_to::TEXT,
          jsonb_build_object('source', 'write_audit', 'ledger_id', v_id, 'from_invoice', v_from.invoice_ref, 'to_invoice', v_to.invoice_ref, 'amount', p_amount,
                             'balance_due', v_balance - p_amount, 'status', v_status));
  RETURN jsonb_build_object('ledger_id', v_id, 'from_credit', v_credit - p_amount, 'to_balance_due', v_balance - p_amount, 'to_status', v_status);
END
$$;
REVOKE ALL ON FUNCTION public.apply_customer_credit(UUID, UUID, NUMERIC, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_customer_credit(UUID, UUID, NUMERIC, UUID) TO authenticated;

-- What each customer is owed back: per customer, the credit across their issued invoices (payments and credits applied beyond the invoice,
-- less refunds and credit applied elsewhere). Runs with the caller's rights, so admin and office see their own company only.
CREATE OR REPLACE FUNCTION public.customer_credit(p_customer TEXT DEFAULT NULL)
RETURNS TABLE (customer TEXT, credit NUMERIC, invoices INTEGER)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT i.customer, sum(i.amount_paid + i.credited_amount - i.refunded_amount - i.total)::NUMERIC, count(*)::INTEGER
  FROM public.invoices i
  WHERE i.organization_id = public.current_user_organization_id()
    AND lower(coalesce(i.status, 'draft')) NOT IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'written_off')
    AND NOT i.payment_unverified
    AND i.amount_paid + i.credited_amount - i.refunded_amount - i.total > 0
    AND (p_customer IS NULL OR i.customer = p_customer)
  GROUP BY i.customer
  ORDER BY i.customer
$$;
REVOKE ALL ON FUNCTION public.customer_credit(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_credit(TEXT) TO authenticated;

-- Payments, now counting the credits applied to the invoice (032, with one more term in the balance and in the status). Otherwise exactly as 032.
CREATE OR REPLACE FUNCTION public.record_invoice_payment(p_invoice UUID, p_amount NUMERIC, p_paid_on DATE, p_method TEXT, p_reference TEXT, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_inv     RECORD;
  v_status  TEXT;
  v_label   TEXT;
  v_ref     TEXT := nullif(btrim(p_reference), '');
  v_method  TEXT := nullif(btrim(p_method), '');
  v_sum     NUMERIC(12,2);
  v_balance NUMERIC(12,2);
  v_new_sum NUMERIC(12,2);
  v_new_status TEXT;
  v_paid_at TIMESTAMPTZ;
  v_payment UUID;
  v_email   TEXT;
  v_prior   RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required.' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'The payment must be more than zero.' USING ERRCODE = '22023';
  END IF;
  IF p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'The payment can have at most two decimal places (pence); it is not rounded.' USING ERRCODE = '22023';
  END IF;
  IF p_paid_on IS NULL THEN
    RAISE EXCEPTION 'The date the payment was received is required.' USING ERRCODE = '22023';
  END IF;
  IF p_paid_on > v_today THEN
    RAISE EXCEPTION 'The payment date can''t be in the future.' USING ERRCODE = '22023';
  END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('BACS', 'cheque', 'card', 'cash', 'other') THEN
    RAISE EXCEPTION 'The payment method must be BACS, cheque, card, cash or other.' USING ERRCODE = '22023';
  END IF;
  IF length(v_ref) > 100 THEN
    RAISE EXCEPTION 'The payment reference can be at most 100 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT id, invoice_ref, status, total, amount_paid, credited_amount, refunded_amount INTO v_inv
  FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  -- The same request again (with the invoice locked, so also when two arrive together): the first one stands.
  SELECT id, invoice_id INTO v_prior FROM public.invoice_payments WHERE organization_id = v_org AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.invoice_id <> p_invoice THEN
      RAISE EXCEPTION 'That request id was used for another invoice.' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(sum(amount), 0) INTO v_sum FROM public.invoice_payments WHERE invoice_id = p_invoice;
    RETURN jsonb_build_object('payment_id', v_prior.id, 'amount_paid', v_sum, 'balance_due', v_inv.total - v_sum - (v_inv.credited_amount - v_inv.refunded_amount),
                              'status', v_inv.status, 'repeated', TRUE);
  END IF;
  v_status := lower(coalesce(v_inv.status, 'draft'));
  v_label := coalesce(v_inv.invoice_ref, 'This invoice');
  IF v_status = 'draft' THEN
    RAISE EXCEPTION '% is still a draft: issue it before recording a payment.', v_label USING ERRCODE = '22023';
  END IF;
  IF v_status IN ('void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off') THEN
    RAISE EXCEPTION '% is % and can''t take a payment.', v_label, v_status USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_sum FROM public.invoice_payments WHERE invoice_id = p_invoice;
  IF v_sum IS DISTINCT FROM v_inv.amount_paid THEN
    RAISE EXCEPTION '% shows % paid but its payments add up to %: nothing was recorded. Ask for the payments to be checked.',
      v_label, chr(163) || to_char(v_inv.amount_paid, 'FM999999990.00'), chr(163) || to_char(v_sum, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  v_balance := v_inv.total - v_sum - (v_inv.credited_amount - v_inv.refunded_amount); -- credits applied to the invoice (034) are not payments, but they settle it
  IF v_balance <= 0 THEN
    RAISE EXCEPTION '% is already paid in full.', v_label USING ERRCODE = '22023';
  END IF;
  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'That is more than the balance due on % (% of %): nothing was recorded.',
      v_label, chr(163) || to_char(v_balance, 'FM999999990.00'), chr(163) || to_char(v_inv.total, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, reference, source, created_by, request_id)
  VALUES (v_org, p_invoice, p_amount, p_paid_on, v_method, v_ref, 'recorded', v_user, p_request_id)
  RETURNING id INTO v_payment;

  v_new_sum := v_sum + p_amount;
  v_new_status := CASE WHEN v_new_sum + (v_inv.credited_amount - v_inv.refunded_amount) >= v_inv.total THEN 'paid' ELSE 'partial' END;
  -- The date that clears the invoice, held at midday UTC so it reads as the same day in any UK time zone.
  v_paid_at := CASE WHEN v_new_status = 'paid' THEN (p_paid_on + TIME '12:00') AT TIME ZONE 'UTC' END;
  PERFORM set_config('quoteflow.invoice_payment', p_invoice::TEXT, TRUE);
  -- payment_unverified is left as it is: one receipt doesn't prove that earlier payments weren't made. An admin settles that
  -- with confirm_invoice_payments.
  UPDATE public.invoices SET amount_paid = v_new_sum, status = v_new_status, paid_at = v_paid_at
   WHERE id = p_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'RECORD_PAYMENT', 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'payment_id', v_payment, 'invoice_ref', v_inv.invoice_ref, 'amount', p_amount,
                             'paid_on', p_paid_on, 'method', v_method, 'reference', v_ref, 'balance_due', v_inv.total - v_new_sum - (v_inv.credited_amount - v_inv.refunded_amount),
                             'status', v_new_status));
  RETURN jsonb_build_object('payment_id', v_payment, 'amount_paid', v_new_sum, 'balance_due', v_inv.total - v_new_sum - (v_inv.credited_amount - v_inv.refunded_amount), 'status', v_new_status);
END
$$;
REVOKE ALL ON FUNCTION public.record_invoice_payment(UUID, NUMERIC, DATE, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(UUID, NUMERIC, DATE, TEXT, TEXT, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_invoice_payment(p_payment UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_reason  TEXT := nullif(btrim(p_reason), '');
  v_invoice UUID;
  v_pay     RECORD;
  v_inv     RECORD;
  v_label   TEXT;
  v_status  TEXT;
  v_new_sum NUMERIC(12,2);
  v_new_status TEXT;
  v_new_paid_at TIMESTAMPTZ;
  v_reversal UUID;
  v_email   TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reverse a payment.' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason can be at most 500 characters.' USING ERRCODE = '22023';
  END IF;
  -- Lock the invoice before reading the payment, as record_invoice_payment does, so the two never interleave.
  SELECT invoice_id INTO v_invoice FROM public.invoice_payments WHERE id = p_payment AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT id, invoice_ref, status, total, paid_at, credited_amount, refunded_amount INTO v_inv FROM public.invoices WHERE id = v_invoice AND organization_id = v_org FOR UPDATE;
  SELECT id, amount, paid_on, method, reference, source, reverses_payment_id INTO v_pay FROM public.invoice_payments WHERE id = p_payment;
  v_label := coalesce(v_inv.invoice_ref, 'This invoice');
  IF v_pay.reverses_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'That is a reversal, which can''t itself be reversed. Record the payment again instead.' USING ERRCODE = '22023';
  END IF;
  IF v_pay.source = 'legacy' THEN
    RAISE EXCEPTION 'That payment was carried over from before part payments were recorded, so it can''t be reversed here.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoice_payments WHERE reverses_payment_id = p_payment) THEN
    RAISE EXCEPTION 'That payment has already been reversed.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, reference, source, reverses_payment_id, void_reason, created_by)
  VALUES (v_org, v_invoice, -v_pay.amount, v_today, v_pay.method, v_pay.reference, 'recorded', p_payment, v_reason, v_user)
  RETURNING id INTO v_reversal;

  SELECT coalesce(sum(amount), 0) INTO v_new_sum FROM public.invoice_payments WHERE invoice_id = v_invoice;
  v_status := lower(coalesce(v_inv.status, 'draft'));
  v_new_status := CASE
    WHEN v_status IN ('void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off') THEN v_inv.status -- the status isn't the payments' to change
    WHEN v_new_sum + (v_inv.credited_amount - v_inv.refunded_amount) >= v_inv.total THEN CASE WHEN v_new_sum > 0 THEN 'paid' ELSE 'credited' END
    WHEN v_new_sum > 0 THEN 'partial'
    ELSE 'issued' END;
  v_new_paid_at := CASE WHEN v_new_status = 'paid' THEN v_inv.paid_at END;
  PERFORM set_config('quoteflow.invoice_payment', v_invoice::TEXT, TRUE);
  UPDATE public.invoices SET amount_paid = v_new_sum, status = v_new_status, paid_at = v_new_paid_at WHERE id = v_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'REVERSE_PAYMENT', 'invoices', v_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'payment_id', p_payment, 'reversal_id', v_reversal, 'invoice_ref', v_inv.invoice_ref,
                             'amount', v_pay.amount, 'paid_on', v_pay.paid_on, 'method', v_pay.method, 'reference', v_pay.reference,
                             'reason', v_reason, 'balance_due', v_inv.total - v_new_sum - (v_inv.credited_amount - v_inv.refunded_amount), 'status', v_new_status));
  RETURN jsonb_build_object('reversal_id', v_reversal, 'amount_paid', v_new_sum, 'balance_due', v_inv.total - v_new_sum - (v_inv.credited_amount - v_inv.refunded_amount), 'status', v_new_status);
END
$$;
REVOKE ALL ON FUNCTION public.reverse_invoice_payment(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_invoice_payment(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_invoice_payments(p_invoice UUID, p_note TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_user  UUID := auth.uid();
  v_note  TEXT := nullif(btrim(p_note), '');
  v_inv   RECORD;
  v_email TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NULL OR length(v_note) > 500 THEN
    RAISE EXCEPTION 'A note of up to 500 characters is required to confirm the payments.' USING ERRCODE = '22023';
  END IF;
  SELECT id, invoice_ref, status, total, amount_paid, credited_amount, refunded_amount, payment_unverified INTO v_inv
  FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_inv.payment_unverified THEN
    RAISE EXCEPTION '% has no payment waiting to be confirmed.', coalesce(v_inv.invoice_ref, 'This invoice') USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('quoteflow.invoice_payment', p_invoice::TEXT, TRUE);
  UPDATE public.invoices SET payment_unverified = FALSE WHERE id = p_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);
  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'CONFIRM_PAYMENTS', 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'invoice_ref', v_inv.invoice_ref, 'amount_paid', v_inv.amount_paid,
                             'balance_due', v_inv.total - v_inv.amount_paid - (v_inv.credited_amount - v_inv.refunded_amount), 'note', v_note));
  RETURN jsonb_build_object('amount_paid', v_inv.amount_paid, 'balance_due', v_inv.total - v_inv.amount_paid - (v_inv.credited_amount - v_inv.refunded_amount), 'status', v_inv.status);
END
$$;
REVOKE ALL ON FUNCTION public.confirm_invoice_payments(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_invoice_payments(UUID, TEXT) TO authenticated;

-- The issued-invoice lock (032), with credited_amount treated like amount_paid. Otherwise exactly as 032.
CREATE OR REPLACE FUNCTION public.invoice_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_date', 'job_id', 'payment_unverified', 'updated_at', 'updated_by'];
  v_receipts CONSTANT TEXT[] := ARRAY['amount_paid', 'paid_at', 'credited_amount', 'refunded_amount'];
  v_via_payment BOOLEAN;
BEGIN
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t be deleted.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t go back to draft.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  v_via_payment := current_setting('quoteflow.invoice_payment', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF NOT v_via_payment THEN
    IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.credited_amount IS DISTINCT FROM OLD.credited_amount OR NEW.refunded_amount IS DISTINCT FROM OLD.refunded_amount THEN
      RAISE EXCEPTION 'Invoice %: payments are recorded with Record payment and credits applied with Apply credit, not by editing the amounts.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF OLD.payment_unverified AND NOT NEW.payment_unverified THEN
      RAISE EXCEPTION 'Invoice %: payments are confirmed with Confirm payments complete, not by editing the flag.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND (lower(coalesce(NEW.status, '')) IN ('paid', 'partial', 'credited') OR lower(coalesce(OLD.status, '')) IN ('paid', 'partial', 'credited')) THEN
      RAISE EXCEPTION 'Invoice %: it becomes part paid, paid or credited only when a payment is recorded or a credit applied.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - v_open - v_receipts) IS DISTINCT FROM (to_jsonb(OLD) - v_open - v_receipts) THEN
    RAISE EXCEPTION 'Invoice % has been issued: its amounts, customer and details can''t be changed (only payment and status).', OLD.invoice_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- Credit note numbers: CN-0001, ... (next_doc_number, section 1 above, takes 'CN' for admin and office).

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. The second step (033) for the workflow's privileged operations ---------------------------------------
-- 033 makes public.assert_privileged_aal() the first statement of every privileged function: with the company's
-- require_admin_mfa on, an admin whose token is not aal2 is refused even when calling the RPC directly. This migration
-- replaces some of those functions (issue_invoice, convert_sales_order, the three payment functions) and adds new ones, so
-- each of them carries the call in its body above: credit notes (create, issue, allocate), refunds and applying customer
-- credit, despatch (create_delivery_note) and invoicing from it, inspections and concessions, drawing revisions and the
-- inspector flag. The check below stops the migration if any of them is missing it.
-- The tables this migration adds that admins and office change, and the delivery notes (marking a note sent out or signed is
-- an update of the note), get the same statement trigger as 033's. sales_order_lines does not: the browser roles have no
-- write grant on it, and it is written only as a by-product of reading what is left to despatch (ensure_sales_order_lines),
-- which reading must not be held back by.
DO $do$
DECLARE
  t TEXT;
  f TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.job_inspections', 'public.job_files', 'public.delivery_notes', 'public.delivery_note_items', 'public.credit_notes',
    'public.credit_note_lines', 'public.invoice_credit_allocations', 'public.customer_credit_ledger']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS admin_mfa ON %s', t);
    EXECUTE format('CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard()', t);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.issue_invoice(uuid)', 'public.convert_sales_order(uuid)',
    'public.record_invoice_payment(uuid,numeric,date,text,text,uuid)', 'public.reverse_invoice_payment(uuid,text)',
    'public.confirm_invoice_payments(uuid,text)',
    'public.record_job_inspection(uuid,text,text,text,text,text,integer)', 'public.set_member_inspector(uuid,boolean)',
    'public.bump_drawing_revision(uuid,text,text,text)',
    'public.create_delivery_note(uuid,uuid,date,date,text,text,jsonb)', 'public.create_invoice_from_delivery_notes(uuid[],date,date,text)',
    'public.create_credit_note(uuid,text,date,jsonb)', 'public.issue_credit_note(uuid)', 'public.allocate_credit_note(uuid,numeric,uuid)',
    'public.refund_customer_credit(uuid,numeric,date,text,text,text,uuid)', 'public.apply_customer_credit(uuid,uuid,numeric,uuid)']
  LOOP
    IF to_regprocedure(f) IS NULL OR position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure(f))) = 0 THEN
      RAISE EXCEPTION '034: % does not start with the second-step check', f;
    END IF;
  END LOOP;
END
$do$;

COMMIT;
