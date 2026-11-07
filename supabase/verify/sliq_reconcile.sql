-- SliQ import reconciliation (D1). READ ONLY. Paste into the Supabase SQL editor and run as ONE statement.
-- 1. Replace the one placeholder below (the organisation id of the company that was imported).
-- 2. Run. The result is a three-column list (metric, key, value). Copy it as CSV or JSON and give it to the
--    reconcile function (lib/sliq-reconcile), which compares it with the validator totals and fills in the signing sheet.
-- Run it BEFORE the import too, and keep the doc_counters rows from that run: they are the "counters before" figures.
-- All money is whole pence. Outstanding = invoiced minus paid minus credits (credited_amount on the invoice).
-- Nothing here writes: the first statement makes the transaction read only, and every statement is a SELECT.
BEGIN READ ONLY;

WITH p AS (
  SELECT '00000000-0000-0000-0000-000000000000'::uuid AS org   -- replace with the real organisation id
),
inv AS (
  SELECT i.id, i.invoice_ref, i.customer, i.total, i.credited_amount, i.amount_paid
  FROM public.invoices i JOIN p ON i.organization_id = p.org
),
pay AS (
  SELECT x.id, x.invoice_id, x.amount, x.paid_on
  FROM public.invoice_payments x JOIN p ON x.organization_id = p.org
),
paid AS (
  SELECT invoice_id, sum(amount) AS paid FROM pay GROUP BY invoice_id
),
inv_bal AS (
  SELECT i.id, i.invoice_ref, i.customer,
         round(coalesce(i.total, 0) / 0.01)::bigint AS total_p,
         coalesce(round(pd.paid / 0.01), 0)::bigint AS paid_p,
         round(coalesce(i.credited_amount, 0) / 0.01)::bigint AS credit_p
  FROM inv i LEFT JOIN paid pd ON pd.invoice_id = i.id
),
cust AS (
  SELECT c.id, c.name, c.email FROM public.customers c JOIN p ON c.organization_id = p.org
),
refs AS (
  SELECT invoice_ref,
         substring(invoice_ref FROM '^INV-(\d{1,9})$')::int AS n
  FROM inv
),
dup_cust_name AS (
  SELECT lower(btrim(name)) AS k, count(1) AS n FROM cust GROUP BY 1 HAVING count(1) > 1
),
dup_cust_email AS (
  SELECT lower(btrim(email)) AS k, count(1) AS n FROM cust
  WHERE email IS NOT NULL AND btrim(email) <> '' GROUP BY 1 HAVING count(1) > 1
),
dup_inv_ref AS (
  SELECT invoice_ref AS k, count(1) AS n FROM inv GROUP BY 1 HAVING count(1) > 1
),
dup_pay AS (
  SELECT x.invoice_id::text || '|' || coalesce(x.paid_on::text, 'none') || '|' || round(x.amount / 0.01)::bigint::text AS k,
         count(1) AS n
  FROM pay x GROUP BY x.invoice_id, x.paid_on, round(x.amount / 0.01) HAVING count(1) > 1
),
orphan AS (
  SELECT x.id FROM pay x LEFT JOIN inv i ON i.id = x.invoice_id WHERE i.id IS NULL
),
overpaid AS (
  SELECT invoice_ref, total_p, paid_p, credit_p FROM inv_bal WHERE paid_p + credit_p > total_p
)
SELECT metric, key, value FROM (
  SELECT 1 AS o, 'count' AS metric, 'customers' AS key, (SELECT count(1) FROM cust)::text AS value
  UNION ALL SELECT 1, 'count', 'invoices', (SELECT count(1) FROM inv)::text
  UNION ALL SELECT 1, 'count', 'payments', (SELECT count(1) FROM pay)::text
  UNION ALL SELECT 1, 'count', 'credit_notes',
    (SELECT count(1) FROM public.credit_notes c JOIN p ON c.organization_id = p.org)::text
  UNION ALL SELECT 2, 'total_pence', 'invoiced', (SELECT coalesce(sum(total_p), 0) FROM inv_bal)::text
  UNION ALL SELECT 2, 'total_pence', 'paid', (SELECT coalesce(sum(paid_p), 0) FROM inv_bal)::text
  UNION ALL SELECT 2, 'total_pence', 'credits', (SELECT coalesce(sum(credit_p), 0) FROM inv_bal)::text
  UNION ALL SELECT 2, 'total_pence', 'outstanding',
    (SELECT coalesce(sum(total_p - paid_p - credit_p), 0) FROM inv_bal)::text
  UNION ALL SELECT 3, 'customer_outstanding_pence', lower(btrim(customer)),
    sum(total_p - paid_p - credit_p)::text FROM inv_bal GROUP BY lower(btrim(customer))
  UNION ALL SELECT 4, 'invoice_ref', 'min_number', (SELECT min(n) FROM refs)::text
  UNION ALL SELECT 4, 'invoice_ref', 'max_number', (SELECT max(n) FROM refs)::text
  UNION ALL SELECT 4, 'invoice_ref', 'not_INV_format', (SELECT count(1) FROM refs WHERE n IS NULL)::text
  UNION ALL SELECT 5, 'counter_last', d.prefix, d.last::text
    FROM public.doc_counters d JOIN p ON d.organization_id = p.org
  UNION ALL SELECT 6, 'dup_customer_name', 'groups', (SELECT count(1) FROM dup_cust_name)::text
  UNION ALL SELECT 6, 'dup_customer_name_detail', k, n::text FROM dup_cust_name
  UNION ALL SELECT 6, 'dup_customer_email', 'groups', (SELECT count(1) FROM dup_cust_email)::text
  UNION ALL SELECT 6, 'dup_customer_email_detail', k, n::text FROM dup_cust_email
  UNION ALL SELECT 6, 'dup_invoice_ref', 'groups', (SELECT count(1) FROM dup_inv_ref)::text
  UNION ALL SELECT 6, 'dup_invoice_ref_detail', k, n::text FROM dup_inv_ref
  UNION ALL SELECT 6, 'dup_payment', 'groups', (SELECT count(1) FROM dup_pay)::text
  UNION ALL SELECT 6, 'dup_payment_detail', k, n::text FROM dup_pay
  UNION ALL SELECT 7, 'orphan_payments', 'count', (SELECT count(1) FROM orphan)::text
  UNION ALL SELECT 8, 'overpaid_invoices', 'count', (SELECT count(1) FROM overpaid)::text
  UNION ALL SELECT 8, 'overpaid_invoices_detail', invoice_ref,
    (paid_p + credit_p - total_p)::text FROM overpaid
) r
ORDER BY o, metric, key;

ROLLBACK;
