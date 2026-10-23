-- READ ONLY. Run on the OLD project (JNREng) in the SQL editor. Legacy side of the import reconciliation
-- (docs/RELEASE-CHECKLIST.md section 5). One result table: every quote and invoice with its stored amounts, then
-- row counts and money totals. Export it (Download CSV) and keep it with the release evidence.
WITH docs AS (
  SELECT 1 AS grp, 'quote' AS kind, q.quote_ref AS ref, q.status, q.total_value::NUMERIC AS total, NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat,
         q.quantity::TEXT || ' x ' || coalesce(q.unit_price::TEXT, 'no unit price') AS detail
  FROM public.quotes q
  UNION ALL
  SELECT 1, 'invoice', i.invoice_ref, i.status, i.total, i.subtotal, i.vat,
         'paid_date ' || coalesce(i.paid_date::DATE::TEXT, 'none')
  FROM public.invoices i
),
counts AS (
  SELECT 2 AS grp, 'count' AS kind, t AS ref, NULL::TEXT AS status, n::NUMERIC AS total, NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat, NULL::TEXT AS detail
  FROM (VALUES
    ('customers', (SELECT count(*) FROM public.customers)), ('suppliers', (SELECT count(*) FROM public.suppliers)),
    ('stock', (SELECT count(*) FROM public.stock)), ('rfqs', (SELECT count(*) FROM public.rfqs)),
    ('quotes', (SELECT count(*) FROM public.quotes)), ('invoices', (SELECT count(*) FROM public.invoices)),
    ('jobs', (SELECT count(*) FROM public.jobs)), ('sales_orders', (SELECT count(*) FROM public.sales_orders)),
    ('purchase_orders', (SELECT count(*) FROM public.purchase_orders)), ('delivery_notes', (SELECT count(*) FROM public.delivery_notes)),
    ('email_history', (SELECT count(*) FROM public.email_history)), ('audit_log', (SELECT count(*) FROM security_audit.audit_log))
  ) v(t, n)
),
money AS (
  SELECT 3 AS grp, 'money' AS kind, m AS ref, NULL::TEXT AS status, amount AS total, NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat, NULL::TEXT AS detail
  FROM (VALUES
    ('invoices marked paid: total', (SELECT coalesce(sum(total), 0) FROM public.invoices WHERE status = 'paid')),
    ('invoices not marked paid: total (owed or still to confirm)', (SELECT coalesce(sum(total), 0) FROM public.invoices WHERE coalesce(status, '') <> 'paid' AND coalesce(status, '') NOT IN ('draft', 'void', 'cancelled'))),
    ('quotes: total face value', (SELECT coalesce(sum(total_value), 0) FROM public.quotes))
  ) v(m, amount)
)
SELECT kind, ref, status, total, subtotal, vat, detail FROM (SELECT * FROM docs UNION ALL SELECT * FROM counts UNION ALL SELECT * FROM money) x
ORDER BY grp, kind, ref;
