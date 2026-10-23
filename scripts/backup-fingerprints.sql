-- READ ONLY. Content fingerprint of the database, written into every backup (scripts/backup-run.sh) and compared after
-- a restore (scripts/restore-backup.sh), so a restore is checked against what was backed up, not only row counts.
-- One "kind<TAB>name<TAB>value" line each:
--   table  <schema.table>      md5 of every row's text, in a fixed order (public, security_audit, auth.users)
--   money  <table.column>      sum of a money column (invoices, quotes, sales orders, purchase orders, payments)
-- The values stay inside the encrypted backup; the restore prints only which names match or differ.
WITH tables AS (
  SELECT t.table_schema AS s, t.table_name AS n
  FROM information_schema.tables t
  WHERE t.table_type = 'BASE TABLE'
    AND (t.table_schema IN ('public', 'security_audit') OR (t.table_schema = 'auth' AND t.table_name = 'users'))
),
money(tbl, col) AS (
  VALUES ('invoices', 'subtotal'), ('invoices', 'vat'), ('invoices', 'total'), ('invoices', 'amount_paid'),
         ('quotes', 'total_value'), ('sales_orders', 'total_value'), ('purchase_orders', 'total_value'),
         ('invoice_line_items', 'unit_price'), ('quote_line_items', 'unit_price')
)
SELECT 'table', s || '.' || n,
       (xpath('/row/h/text()', query_to_xml(
         format('SELECT md5(coalesce(string_agg(r::text, E''\n'' ORDER BY r::text), '''')) AS h FROM %I.%I r', s, n),
         false, true, '')))[1]::TEXT
FROM tables
UNION ALL
SELECT 'money', m.tbl || '.' || m.col,
       (xpath('/row/v/text()', query_to_xml(
         format('SELECT coalesce(sum(%I), 0)::text AS v FROM public.%I', m.col, m.tbl), false, true, '')))[1]::TEXT
FROM money m
WHERE EXISTS (SELECT 1 FROM information_schema.columns c
              WHERE c.table_schema = 'public' AND c.table_name = m.tbl AND c.column_name = m.col)
ORDER BY 1, 2;
