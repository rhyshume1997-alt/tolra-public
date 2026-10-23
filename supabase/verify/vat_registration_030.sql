-- READ ONLY. Migration 030 (totals follow VAT registration): run in a read-only transaction before AND after
-- applying 030 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (check | value | expected):
--   * companies by registration (only JSON false is "not registered", the app's rule: vatRegistered !== false)
--   * drafts 030 would refuse to issue/send: draft invoices and quotes in a NOT registered company whose stored totals
--     include VAT. Before 030 these could still be issued; after 030 they are refused until corrected (draft invoice:
--     delete and recreate; draft quote: open it and save again). Expected 0; anything else, list them with the
--     second query below before applying.
--   * 030 applied: public.org_vat_registered exists and check_document_totals uses it. Before: false; after: true.
WITH reg AS (
  SELECT s.organization_id,
         NOT (s.company_profile -> 'vatRegistered' IS NOT DISTINCT FROM 'false'::jsonb) AS registered
  FROM public.organization_settings s
),
quo_lines AS (
  SELECT quote_id AS id, sum(round(quantity * unit_price, 2)) AS net
  FROM public.quote_line_items GROUP BY quote_id
),
blocked AS (
  SELECT 'invoice' AS kind, i.id
  FROM public.invoices i JOIN reg r ON r.organization_id = i.organization_id
  WHERE coalesce(i.status, 'draft') = 'draft' AND NOT r.registered AND coalesce(i.vat, 0) <> 0
  UNION ALL
  SELECT 'quote', q.id
  FROM public.quotes q JOIN reg r ON r.organization_id = q.organization_id LEFT JOIN quo_lines l ON l.id = q.id
  WHERE coalesce(q.status, 'draft') = 'draft' AND NOT r.registered AND q.total_value IS DISTINCT FROM coalesce(l.net, 0)
)
SELECT 1 AS n, 'companies VAT registered' AS check_name, (SELECT count(*) FROM reg WHERE registered)::TEXT AS value, 'any' AS expected
UNION ALL SELECT 2, 'companies NOT VAT registered (vatRegistered = JSON false)', (SELECT count(*) FROM reg WHERE NOT registered)::TEXT, 'any; 0 means 030 changes nothing for existing data'
UNION ALL SELECT 3, 'draft invoices 030 would refuse', (SELECT count(*) FROM blocked WHERE kind = 'invoice')::TEXT, '0 (else list them, second query)'
UNION ALL SELECT 4, 'draft quotes 030 would refuse', (SELECT count(*) FROM blocked WHERE kind = 'quote')::TEXT, '0 (else list them, second query)'
UNION ALL SELECT 5, '030 applied: org_vat_registered exists', (to_regprocedure('public.org_vat_registered(uuid)') IS NOT NULL)::TEXT, 'false before 030, true after'
UNION ALL SELECT 6, '030 applied: check_document_totals uses it',
  (SELECT position('org_vat_registered' IN pg_get_functiondef('public.check_document_totals(text, uuid, uuid)'::regprocedure)) > 0)::TEXT,
  'false before 030, true after'
ORDER BY 1;

-- Second query (only if checks 3 or 4 are not 0): the drafts to correct, by reference. Read only.
-- SELECT 'invoice' AS kind, i.id, i.customer, i.subtotal, i.carriage, i.vat, i.total, i.created_at
--   FROM public.invoices i JOIN public.organization_settings s ON s.organization_id = i.organization_id
--  WHERE coalesce(i.status, 'draft') = 'draft' AND s.company_profile -> 'vatRegistered' = 'false'::jsonb AND coalesce(i.vat, 0) <> 0
-- UNION ALL
-- SELECT 'quote', q.id, q.customer, NULL, NULL, NULL, q.total_value, q.created_at
--   FROM public.quotes q JOIN public.organization_settings s ON s.organization_id = q.organization_id
--  WHERE coalesce(q.status, 'draft') = 'draft' AND s.company_profile -> 'vatRegistered' = 'false'::jsonb AND q.vat_enabled;
