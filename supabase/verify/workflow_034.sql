-- READ ONLY. Migration 034 (workflow day-one gaps): run in a read-only transaction AFTER applying 034 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). All "true" except the counts, whose expected value is in the last column.
WITH
fn AS (SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'security_audit')),
trg AS (SELECT t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal),
alloc AS (SELECT invoice_id, sum(amount) AS total FROM public.invoice_credit_allocations GROUP BY invoice_id),
alloc_cn AS (SELECT credit_note_id, sum(amount) AS total FROM public.invoice_credit_allocations GROUP BY credit_note_id),
line_sent AS (SELECT sales_order_line_id AS id, sum(quantity) AS qty FROM public.delivery_note_items WHERE sales_order_line_id IS NOT NULL GROUP BY sales_order_line_id)
SELECT * FROM (VALUES
  (1, 'New tables exist (inspections, job files, order lines, credit notes and lines, allocations)',
      (SELECT count(*) = 7 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('job_inspections', 'job_files', 'sales_order_lines', 'credit_notes', 'credit_note_lines', 'invoice_credit_allocations', 'customer_credit_ledger')
       AND (SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (('organization_members', 'can_inspect'), ('jobs', 'certs_required'), ('jobs', 'checklist_required'))))::text, 'true'),
  (2, 'Functions exist (inspection, drawings, despatch, invoicing from notes, credit notes)',
      (SELECT count(DISTINCT proname) = 15 FROM fn WHERE proname IN ('set_member_inspector', 'job_files_guard', 'check_credit_note_caps', 'refund_customer_credit', 'apply_customer_credit', 'record_job_inspection', 'bump_drawing_revision', 'ensure_sales_order_lines', 'despatch_lines', 'create_delivery_note',
        'create_invoice_from_delivery_notes', 'create_credit_note', 'issue_credit_note', 'allocate_credit_note', 'jobs_release_guard'))::text, 'true'),
  (3, 'Guard triggers exist (job release, job files, delivery note links, credit note lock)',
      (SELECT count(*) = 7 FROM trg WHERE tgname IN ('job_files_guard', 'job_files_revision_change', 'jobs_worksheet_version_release', 'delivery_note_items_link_guard', 'delivery_notes_link_guard', 'credit_notes_issue_lock', 'credit_note_lines_issue_lock'))::text, 'true'),
  (4, 'The issued-invoice lock counts credits applied',
      (SELECT position('credited_amount' IN prosrc) > 0 FROM fn WHERE proname = 'invoice_issue_lock')::text, 'true'),
  (5, 'Office can read invoices and sales orders (policies)',
      (SELECT count(*) = 2 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('invoices', 'sales_orders') AND policyname LIKE '% rbac select' AND qual LIKE '%office%')::text, 'true'),
  (6, 'Invoices whose credited_amount is not the credit allocations plus customer credit applied to them, or whose refunded_amount is not the ledger rows that left them (expected 0)',
      (SELECT count(*) FROM public.invoices i WHERE i.credited_amount IS DISTINCT FROM coalesce((SELECT a.total FROM alloc a WHERE a.invoice_id = i.id), 0) + coalesce((SELECT sum(l.amount) FROM public.customer_credit_ledger l WHERE l.to_invoice_id = i.id), 0)
         OR i.refunded_amount IS DISTINCT FROM coalesce((SELECT sum(l.amount) FROM public.customer_credit_ledger l WHERE l.invoice_id = i.id), 0))::text, '0'),
  (7, 'Credit notes whose allocated_amount is not the sum of their allocations (expected 0)',
      (SELECT count(*) FROM public.credit_notes c WHERE c.allocated_amount IS DISTINCT FROM coalesce((SELECT a.total FROM alloc_cn a WHERE a.credit_note_id = c.id), 0))::text, '0'),
  (8, 'Invoices not flagged payment_unverified whose amount_paid is not the sum of their payments (expected 0; credits never count as payments)',
      (SELECT count(*) FROM public.invoices i WHERE NOT i.payment_unverified AND i.amount_paid IS DISTINCT FROM coalesce((SELECT sum(p.amount) FROM public.invoice_payments p WHERE p.invoice_id = i.id), 0))::text, '0'),
  (9, 'Order lines despatched for more than was ordered (expected 0)',
      (SELECT count(*) FROM public.sales_order_lines l JOIN line_sent s ON s.id = l.id WHERE s.qty > l.quantity)::text, '0'),
  (10, 'Issued credit notes without a number, and invoices credited for more than their total (expected 0)',
      ((SELECT count(*) FROM public.credit_notes WHERE status = 'issued' AND credit_ref IS NULL) + (SELECT count(*) FROM public.invoices i WHERE i.credited_amount > i.total))::text, '0'),
  (11, 'Jobs released before 034 (inspected, no inspection record): informational, they stay released until next edited',
      (SELECT count(*) FROM public.jobs j WHERE j.inspected_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.job_inspections i WHERE i.job_id = j.id))::text, 'any'),
  (12, 'Inspection names that are an e-mail address (jobs.inspected_by, job_inspections.inspector_name; expected 0)',
      ((SELECT count(*) FROM public.jobs WHERE inspected_by LIKE '%@%') + (SELECT count(*) FROM public.job_inspections WHERE inspector_name LIKE '%@%'))::text, '0'),
  (13, 'Sent, delivered or signed delivery notes that have no items left (expected 0: they are frozen)',
      (SELECT count(*) FROM public.delivery_notes d WHERE d.status IN ('despatched', 'delivered', 'signed') AND d.sales_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.delivery_note_items i WHERE i.delivery_note_id = d.id))::text, '0'),
  (14, 'The second step (033): privileged workflow functions without assert_privileged_aal, and workflow tables without the admin_mfa trigger (expected 0)',
      ((SELECT 15 - count(DISTINCT proname) FROM fn WHERE proname IN ('issue_invoice', 'convert_sales_order', 'record_invoice_payment', 'reverse_invoice_payment', 'confirm_invoice_payments',
          'record_job_inspection', 'set_member_inspector', 'bump_drawing_revision', 'create_delivery_note', 'create_invoice_from_delivery_notes', 'create_credit_note', 'issue_credit_note',
          'allocate_credit_note', 'refund_customer_credit', 'apply_customer_credit') AND position('assert_privileged_aal' IN prosrc) > 0)
       + (SELECT 8 - count(DISTINCT t.tgrelid) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'admin_mfa' AND t.tgrelid IN ('public.job_inspections'::regclass, 'public.job_files'::regclass,
          'public.delivery_notes'::regclass, 'public.delivery_note_items'::regclass, 'public.credit_notes'::regclass, 'public.credit_note_lines'::regclass,
          'public.invoice_credit_allocations'::regclass, 'public.customer_credit_ledger'::regclass)))::text, '0'),
  (15, 'Credit notes whose subtotal, VAT or total is not what their lines add up to, or whose lines credit more than the invoice line charged in quantity, net or VAT (expected 0)',
      ((SELECT count(*) FROM public.credit_notes c WHERE (c.subtotal, c.vat, c.total) IS DISTINCT FROM (
          (SELECT coalesce(sum(round(l.quantity * l.unit_price, 2)), 0) FROM public.credit_note_lines l WHERE l.credit_note_id = c.id),
          (SELECT coalesce(sum(l.vat_amount), 0) FROM public.credit_note_lines l WHERE l.credit_note_id = c.id),
          (SELECT coalesce(sum(round(l.quantity * l.unit_price, 2) + l.vat_amount), 0) FROM public.credit_note_lines l WHERE l.credit_note_id = c.id)))
       + (SELECT count(*) FROM (SELECT 1 FROM public.invoice_line_items il JOIN public.credit_note_lines l ON l.invoice_line_id = il.id GROUP BY il.id
            HAVING sum(l.quantity) > max(il.quantity) OR sum(round(l.quantity * l.unit_price, 2)) > max(round(il.quantity * il.unit_price, 2))
               OR sum(l.vat_amount) > max(round(round(il.quantity * il.unit_price, 2) * il.vat_pct / 100, 2))) x))::text, '0')
) AS t(n, check_name, value, expected)
ORDER BY n;
