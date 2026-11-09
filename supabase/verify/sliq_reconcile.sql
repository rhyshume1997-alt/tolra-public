-- SliQ import reconciliation (D1). READ ONLY. Paste into the Supabase SQL editor and run as ONE statement.
-- 1. Replace the one placeholder below (the organisation id of the company that was imported).
-- 2. Run. The result is a three-column list (metric, key, value). Copy it as CSV or JSON and give it to the
--    reconcile function (lib/sliq-reconcile), which compares it with the validator totals and fills in the signing sheet.
-- Run it BEFORE the import too, and keep the doc_counters rows from that run: they are the "counters before" figures.
-- All money is whole pence. Outstanding follows the app (034): per invoice greatest(0, total - paid - credited + refunded), with void,
-- cancelled, written-off and draft invoices left out; the excess is customer credit. Per customer, the key is the account code from the
-- SliQ import map (release 152) or the name; an invoice whose customer name matches no customer or several is "unresolved".
-- With the placeholder left in, or an id that names no company, it stops with an error instead of answering zeros.
-- Needs release 152: the rows come from public.import_sliq_reconcile_rows (the same function the browser card reads through
-- import_sliq_reconcile), so the SQL editor and the card can never disagree.
-- Nothing here writes: the first statement makes the transaction read only, and every statement is a SELECT.
BEGIN READ ONLY;

SELECT r.metric, r.key, r.value
FROM public.import_sliq_reconcile_rows('00000000-0000-0000-0000-000000000000'::uuid) r   -- replace with the real organisation id
ORDER BY r.metric, r.key;

ROLLBACK;
