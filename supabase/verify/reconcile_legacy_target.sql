-- READ ONLY. Target side of the import reconciliation (docs/RELEASE-CHECKLIST.md section 5). Run on the database
-- that holds the imported company (the disposable restore first, production only after sign-off). Change the slug
-- on the next line if needed. One result table, same shape as reconcile_legacy_source.sql plus the new figures:
--   lines_total  what the document's lines add up to (a difference from total is listed by document_totals.sql: the
--                stored total is kept, the document can't be reprinted or issued until reviewed);
--   owed / to_confirm  money owed under the receivables rule; "Payment to confirm" invoices are EXCLUDED from owed,
--                aging and chasers until someone records the payment or confirms it is still owed.
WITH params AS (SELECT 'jnr-engineering'::TEXT AS slug),
org AS (SELECT o.id FROM public.organizations o, params p WHERE o.slug = p.slug),
qlines AS (
  SELECT quote_id, sum(round(quantity * unit_price, 2) + CASE WHEN vat_exempt THEN 0 ELSE round(round(quantity * unit_price, 2) * vat_pct / 100, 2) END) AS gross
  FROM public.quote_line_items GROUP BY quote_id
),
ilines AS (
  SELECT invoice_id, sum(round(quantity * unit_price, 2)) AS net,
         sum(CASE WHEN vat_exempt THEN 0 ELSE round(round(quantity * unit_price, 2) * vat_pct / 100, 2) END) AS vat
  FROM public.invoice_line_items GROUP BY invoice_id
),
docs AS (
  SELECT 1 AS grp, 'quote' AS kind, q.quote_ref AS ref, q.status, q.total_value AS total, NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat,
         CASE WHEN q.vat_enabled THEN l.gross ELSE NULL END AS lines_total, NULL::BOOLEAN AS to_confirm, NULL::NUMERIC AS amount_paid
  FROM public.quotes q JOIN org ON org.id = q.organization_id LEFT JOIN qlines l ON l.quote_id = q.id
  UNION ALL
  SELECT 1, 'invoice', i.invoice_ref, i.status, i.total, i.subtotal, i.vat,
         l.net + coalesce(i.carriage, 0) + CASE WHEN i.vat_enabled THEN l.vat ELSE 0 END, i.payment_unverified, i.amount_paid
  FROM public.invoices i JOIN org ON org.id = i.organization_id LEFT JOIN ilines l ON l.invoice_id = i.id
),
counts AS (
  SELECT 2 AS grp, 'count' AS kind, t AS ref, NULL::TEXT AS status, n::NUMERIC AS total, NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat,
         NULL::NUMERIC AS lines_total, NULL::BOOLEAN AS to_confirm, NULL::NUMERIC AS amount_paid
  FROM (VALUES
    ('customers', (SELECT count(*) FROM public.customers c JOIN org ON org.id = c.organization_id)),
    ('suppliers', (SELECT count(*) FROM public.suppliers s JOIN org ON org.id = s.organization_id)),
    ('stock', (SELECT count(*) FROM public.stock s JOIN org ON org.id = s.organization_id)),
    ('rfqs', (SELECT count(*) FROM public.rfqs r JOIN org ON org.id = r.organization_id)),
    ('quotes', (SELECT count(*) FROM public.quotes q JOIN org ON org.id = q.organization_id)),
    ('invoices', (SELECT count(*) FROM public.invoices i JOIN org ON org.id = i.organization_id)),
    ('jobs', (SELECT count(*) FROM public.jobs j JOIN org ON org.id = j.organization_id)),
    ('sales_orders', (SELECT count(*) FROM public.sales_orders s JOIN org ON org.id = s.organization_id)),
    ('purchase_orders', (SELECT count(*) FROM public.purchase_orders p JOIN org ON org.id = p.organization_id)),
    ('delivery_notes', (SELECT count(*) FROM public.delivery_notes d JOIN org ON org.id = d.organization_id)),
    ('email_history', (SELECT count(*) FROM public.email_history e JOIN org ON org.id = e.organization_id)),
    ('audit_log', (SELECT count(*) FROM public.legacy_audit_log a JOIN org ON org.id = a.organization_id))
  ) v(t, n)
),
money AS (
  SELECT 3 AS grp, 'money' AS kind, m AS ref, NULL::TEXT AS status, amount AS total, NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat,
         NULL::NUMERIC AS lines_total, NULL::BOOLEAN AS to_confirm, NULL::NUMERIC AS amount_paid
  FROM (VALUES
    ('invoices marked paid: total', (SELECT coalesce(sum(total), 0) FROM docs WHERE kind = 'invoice' AND status = 'paid')),
    ('invoices not marked paid: total (owed or still to confirm)', (SELECT coalesce(sum(total), 0) FROM docs WHERE kind = 'invoice' AND coalesce(status, '') <> 'paid' AND coalesce(status, '') NOT IN ('draft', 'void', 'cancelled'))),
    ('  of which owed (confirmed): balance', (SELECT coalesce(sum(greatest(total - coalesce(amount_paid, 0), 0)), 0) FROM docs WHERE kind = 'invoice' AND coalesce(status, '') NOT IN ('paid', 'draft', 'void', 'cancelled') AND NOT coalesce(to_confirm, false))),
    ('  of which payment to confirm: total (excluded from owed and chasers)', (SELECT coalesce(sum(total), 0) FROM docs WHERE kind = 'invoice' AND coalesce(to_confirm, false))),
    ('  payment to confirm: count', (SELECT count(*)::NUMERIC FROM docs WHERE kind = 'invoice' AND coalesce(to_confirm, false))),
    ('documents whose lines differ from their stored total: count', (SELECT count(*)::NUMERIC FROM docs WHERE kind IN ('quote', 'invoice') AND lines_total IS DISTINCT FROM total AND lines_total IS NOT NULL)),
    ('quotes: total face value', (SELECT coalesce(sum(total), 0) FROM docs WHERE kind = 'quote'))
  ) v(m, amount)
)
SELECT kind, ref, status, total, subtotal, vat, lines_total, to_confirm, amount_paid
FROM (SELECT * FROM docs UNION ALL SELECT * FROM counts UNION ALL SELECT * FROM money) x
ORDER BY grp, kind, ref;
