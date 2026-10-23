-- Step 06b: run on quoteflow-prod. READ-ONLY. JNR's rows must equal 06a (audit_log -> legacy_audit_log),
-- Marpet's must all be 0. quote_line_items / invoice_line_items are new (one per legacy quote / invoice line).
WITH o AS (SELECT
  (SELECT id FROM public.organizations WHERE slug = 'jnr-engineering') AS jnr,
  (SELECT id FROM public.organizations WHERE slug = 'marpet') AS marpet)
SELECT t, jnr, marpet FROM (
            SELECT 'customers' AS t, (SELECT count(*) FROM public.customers, o WHERE organization_id = o.jnr) AS jnr, (SELECT count(*) FROM public.customers, o WHERE organization_id = o.marpet) AS marpet
  UNION ALL SELECT 'suppliers', (SELECT count(*) FROM public.suppliers, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.suppliers, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'stock', (SELECT count(*) FROM public.stock, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.stock, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'rfqs', (SELECT count(*) FROM public.rfqs, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.rfqs, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'quotes', (SELECT count(*) FROM public.quotes, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.quotes, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'invoices', (SELECT count(*) FROM public.invoices, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.invoices, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'jobs', (SELECT count(*) FROM public.jobs, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.jobs, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'sales_orders', (SELECT count(*) FROM public.sales_orders, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.sales_orders, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'purchase_orders', (SELECT count(*) FROM public.purchase_orders, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.purchase_orders, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'delivery_notes', (SELECT count(*) FROM public.delivery_notes, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.delivery_notes, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'email_history', (SELECT count(*) FROM public.email_history, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.email_history, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'audit_log (legacy_audit_log)', (SELECT count(*) FROM public.legacy_audit_log, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.legacy_audit_log, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'quote_line_items (new)', (SELECT count(*) FROM public.quote_line_items, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.quote_line_items, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'invoice_line_items (new)', (SELECT count(*) FROM public.invoice_line_items, o WHERE organization_id = o.jnr), (SELECT count(*) FROM public.invoice_line_items, o WHERE organization_id = o.marpet)
  UNION ALL SELECT 'members (admin)', (SELECT count(*) FROM public.organization_members m, o WHERE m.organization_id = o.jnr AND m.role = 'admin' AND m.active), (SELECT count(*) FROM public.organization_members m, o WHERE m.organization_id = o.marpet AND m.role = 'admin' AND m.active)
  UNION ALL SELECT 'pending invites', (SELECT count(*) FROM public.organization_invites i, o WHERE i.organization_id = o.jnr), (SELECT count(*) FROM public.organization_invites i, o WHERE i.organization_id = o.marpet)
) x ORDER BY t;
