-- READ ONLY. Migration 032 (part payments on invoices): run in a read-only transaction before AND after applying 032 on a
-- hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (check | value | expected). Checks 1-4 work before 032 too (they read invoices only) and say what the migration will
-- carry over; checks 5-9 are for after it:
--   * invoices with receipts (amount_paid > 0) that are NOT flagged payment_unverified: each gets exactly one 'legacy' payment
--     row for that amount (nothing is inferred), and their total is what the legacy rows must add up to
--   * flagged payment_unverified invoices: get no row and keep behaving as before (payment still to be confirmed)
--   * invoices marked paid with amount_paid = 0: get no row either; their paid amount stays unknown until someone records it
--   * 032 applied: invoice_payments and record_invoice_payment exist
--   * the invariant: for every invoice not flagged payment_unverified, amount_paid = the sum of its payment rows (0 rows =
--     0 paid). Expected 0 invoices that break it; list them with the second query below if not.
--   * no payment row for a flagged invoice made by the migration (legacy rows on flagged invoices: expected 0)
WITH pay AS (
  SELECT to_regclass('public.invoice_payments') IS NOT NULL AS exists_
),
sums AS (
  SELECT i.id, i.amount_paid, i.payment_unverified,
         CASE WHEN (SELECT exists_ FROM pay) THEN
           (SELECT coalesce(sum(p.amount), 0) FROM public.invoice_payments p WHERE p.invoice_id = i.id)
         ELSE 0 END AS paid_rows
  FROM public.invoices i
)
SELECT 1 AS n, 'invoices with receipts, not flagged (get one legacy row each)' AS check_name,
       (SELECT count(*) FROM sums WHERE amount_paid > 0 AND NOT payment_unverified)::TEXT AS value, 'any' AS expected
UNION ALL SELECT 2, 'their amount_paid added up (the legacy rows must add up to this)',
       (SELECT coalesce(sum(amount_paid), 0) FROM sums WHERE amount_paid > 0 AND NOT payment_unverified)::TEXT, 'record it; after 032 the same figure is the sum of those invoices'' payment rows'
UNION ALL SELECT 3, 'invoices flagged payment_unverified (no payment rows, unknown stays unknown)',
       (SELECT count(*) FROM sums WHERE payment_unverified)::TEXT, 'any'
UNION ALL SELECT 4, 'invoices marked paid with amount_paid = 0 (no row; amount unknown until recorded)',
       (SELECT count(*) FROM public.invoices WHERE lower(coalesce(status, 'draft')) = 'paid' AND amount_paid = 0)::TEXT, 'any'
UNION ALL SELECT 5, '032 applied: invoice_payments exists', (SELECT exists_ FROM pay)::TEXT, 'false before 032, true after'
UNION ALL SELECT 6, '032 applied: record_invoice_payment exists', (to_regprocedure('public.record_invoice_payment(uuid, numeric, date, text, text, uuid)') IS NOT NULL)::TEXT, 'false before 032, true after'
UNION ALL SELECT 7, 'invoices where amount_paid <> sum of payments (not flagged)',
       (SELECT count(*) FROM sums WHERE NOT payment_unverified AND amount_paid <> paid_rows)::TEXT, '0 after 032 (before 032 this counts every invoice with receipts)'
UNION ALL SELECT 8, 'legacy rows on flagged invoices',
       CASE WHEN (SELECT exists_ FROM pay) THEN (SELECT count(*) FROM public.invoice_payments p JOIN public.invoices i ON i.id = p.invoice_id WHERE p.source = 'legacy' AND i.payment_unverified)::TEXT ELSE '0' END, '0'
UNION ALL SELECT 9, 'payment rows in total / of which legacy',
       CASE WHEN (SELECT exists_ FROM pay) THEN (SELECT count(*) || ' / ' || count(*) FILTER (WHERE source = 'legacy') FROM public.invoice_payments) ELSE '0 / 0' END, 'after 032: checks 1 = the legacy count on first run (more payments are recorded later)'
ORDER BY 1;

-- Second query (only if check 7 is not 0): the invoices that break the invariant, by reference. Read only.
-- SELECT i.invoice_ref, i.status, i.total, i.amount_paid, coalesce(sum(p.amount), 0) AS payment_rows
--   FROM public.invoices i LEFT JOIN public.invoice_payments p ON p.invoice_id = i.id
--  WHERE NOT i.payment_unverified
--  GROUP BY i.id HAVING i.amount_paid <> coalesce(sum(p.amount), 0);
