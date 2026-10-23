-- READ ONLY. Quotes and invoices whose stored header totals differ from what their lines add up to under the
-- current rounding policy (net per line rounded to the penny, VAT per line, carriage VAT at the standard rate when
-- switched on; half away from zero). Expected: few or no rows. Rows are historical facts to review, NOT to
-- overwrite: issued documents keep the face value they were sent with.
WITH std AS (
  SELECT s.organization_id,
         CASE WHEN jsonb_typeof(s.company_profile -> 'defaultVatRate') = 'number'
               AND (s.company_profile ->> 'defaultVatRate')::NUMERIC BETWEEN 0 AND 100
              THEN (s.company_profile ->> 'defaultVatRate')::NUMERIC ELSE 20 END AS rate
  FROM public.organization_settings s
),
inv_lines AS (
  SELECT invoice_id AS id, sum(round(quantity * unit_price, 2)) AS net,
         sum(CASE WHEN vat_exempt THEN 0 ELSE round(round(quantity * unit_price, 2) * vat_pct / 100, 2) END) AS vat
  FROM public.invoice_line_items GROUP BY invoice_id
),
quo_lines AS (
  SELECT quote_id AS id, sum(round(quantity * unit_price, 2)) AS net,
         sum(CASE WHEN vat_exempt THEN 0 ELSE round(round(quantity * unit_price, 2) * vat_pct / 100, 2) END) AS vat
  FROM public.quote_line_items GROUP BY quote_id
)
SELECT 'invoice' AS kind, i.organization_id, i.invoice_ref AS ref, i.status,
       i.subtotal AS stored_subtotal, l.net AS lines_subtotal,
       i.vat AS stored_vat,
       CASE WHEN i.vat_enabled THEN l.vat + CASE WHEN i.carriage_vat THEN round(coalesce(i.carriage, 0) * coalesce(std.rate, 20) / 100, 2) ELSE 0 END ELSE 0 END AS lines_vat,
       i.total AS stored_total
FROM public.invoices i
JOIN inv_lines l ON l.id = i.id
LEFT JOIN std ON std.organization_id = i.organization_id
WHERE i.subtotal IS DISTINCT FROM l.net
   OR i.vat IS DISTINCT FROM CASE WHEN i.vat_enabled THEN l.vat + CASE WHEN i.carriage_vat THEN round(coalesce(i.carriage, 0) * coalesce(std.rate, 20) / 100, 2) ELSE 0 END ELSE 0 END
UNION ALL
SELECT 'quote', q.organization_id, q.quote_ref, q.status,
       NULL, l.net, NULL, CASE WHEN q.vat_enabled THEN l.vat ELSE 0 END, q.total_value
FROM public.quotes q
JOIN quo_lines l ON l.id = q.id
WHERE q.total_value IS DISTINCT FROM l.net + CASE WHEN q.vat_enabled THEN l.vat ELSE 0 END
ORDER BY 1, 2, 3;
