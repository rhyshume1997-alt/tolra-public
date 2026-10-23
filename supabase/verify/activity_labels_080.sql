-- Migration 080 (the Activity log names each record by its own number; a job made from a sales order is described by its quote's
-- work, and jobs still on 'Converted from SO-...' get that text). Read only: every row should be TRUE.
-- Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, regexp_replace(p.prosrc, '\s', '', 'g') AS body
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('security_audit.activity_label(text,jsonb)'), to_regprocedure('security_audit.activity_label(jsonb)'),
                  to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)'),
                  to_regprocedure('public.convert_sales_order(uuid)'))
),
label2 AS (SELECT * FROM f WHERE oid = to_regprocedure('security_audit.activity_label(text,jsonb)')),
label1 AS (SELECT * FROM f WHERE oid = to_regprocedure('security_audit.activity_label(jsonb)')),
org AS (SELECT * FROM f WHERE oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)')),
conv AS (SELECT * FROM f WHERE oid = to_regprocedure('public.convert_sales_order(uuid)')),
-- Jobs still described 'Converted from ' || their sales order's number, with the text conversion now writes (NULL: the quote has no
-- ordered line with a description). The same query as 080's backfill.
placeholder AS (
  SELECT DISTINCT ON (j.id) j.id, (SELECT left(string_agg(w.text, '; ' ORDER BY w.first_position, w.text), 300)
                    FROM (SELECT btrim(l.description) AS text, min(l.position) AS first_position
                          FROM public.quote_line_items l
                          WHERE l.quote_id = s.quote_id AND l.organization_id = s.organization_id AND NOT l.declined AND btrim(l.description) <> ''
                          GROUP BY btrim(l.description)) w) AS work
  FROM public.jobs j
  JOIN public.sales_orders s ON s.organization_id = j.organization_id AND (s.id = j.converted_from_sales_order_id OR s.converted_to_job_id = j.id)
  WHERE s.quote_id IS NOT NULL AND j.description = 'Converted from ' || s.so_number
  ORDER BY j.id, (s.id = j.converted_from_sales_order_id) DESC NULLS LAST, s.created_at, s.id
)
SELECT 'label_function_is_080' AS check_name, (SELECT md5(body) = '50674bed5bd63ddf3cf1c7b9c6e0fd05' AND provolatile = 'i' AND NOT prosecdef
                                                       AND proconfig = ARRAY['search_path=pg_catalog'] FROM label2) AS ok
UNION ALL SELECT 'label_function_internal', (SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                                                    AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM label2)
-- 013's one-argument label is untouched (anything else that calls it is unchanged).
UNION ALL SELECT 'one_argument_label_unchanged', (SELECT md5(body) = 'e59a450040f48ab414a190e59ae83524' FROM label1)
-- Each document by its own number; never another document's.
UNION ALL SELECT 'labels_by_own_number',
  security_audit.activity_label('jobs', '{"quote_ref": "QUO-0009", "job_no": "J-0010"}') = 'J-0010'
  AND security_audit.activity_label('sales_orders', '{"quote_ref": "QUO-0009", "so_number": "SO-0002"}') = 'SO-0002'
  AND security_audit.activity_label('invoices', '{"quote_ref": "QUO-0009", "invoice_ref": "INV-0007"}') = 'INV-0007'
  AND security_audit.activity_label('delivery_notes', '{"invoice_ref": "INV-0007", "dn_number": "DN-0003"}') = 'DN-0003'
  AND security_audit.activity_label('credit_notes', '{"credit_ref": "CRD-0001"}') = 'CRD-0001'
  AND security_audit.activity_label('purchase_orders', '{"po_ref": "PO-0004", "po_number": "4471"}') = 'PO-0004'
  AND security_audit.activity_label('quotes', '{"quote_ref": "QUO-0009", "so_number": "SO-0002"}') = 'QUO-0009'
  AND security_audit.activity_label('jobs', '{"quote_ref": "QUO-0009", "description": "Tooling"}') = 'Tooling'
  AND security_audit.activity_label('customers', '{"name": "Acme", "quote_ref": "Q"}') IS NOT DISTINCT FROM security_audit.activity_label('{"name": "Acme", "quote_ref": "Q"}')
UNION ALL SELECT 'org_activity_is_080', (SELECT md5(body) = 'ae7e2416ce0a54b0d8ccb721aeb2d245' FROM org)
-- 035's body exactly, but for the table passed to activity_label (once).
UNION ALL SELECT 'org_activity_only_label_changed', (SELECT md5(replace(body, 'activity_label(a.entity_table,coalesce(', 'activity_label(coalesce(')) = '292d6e2612099e36dd107422bd50e1b5'
                                                            AND (length(body) - length(replace(body, 'activity_label(a.entity_table,', ''))) = length('activity_label(a.entity_table,') FROM org)
-- Who may see what is unchanged: admins only inside, SECURITY DEFINER, same search_path, callable by signed-in users only.
UNION ALL SELECT 'org_activity_security_unchanged', (SELECT prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
                                                            AND body LIKE '%has_org_role(ARRAY[''admin''])%' AND body LIKE '%redact_emails(%'
                                                            AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                                                            AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM org)
UNION ALL SELECT 'convert_sales_order_is_080', (SELECT md5(body) = 'dc8165549871bd15047765ac4fba811e' FROM conv)
UNION ALL SELECT 'convert_sales_order_security_unchanged', (SELECT NOT prosecdef AND provolatile = 'v' AND proconfig = ARRAY['search_path=pg_catalog, public']
                                                                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                                                                   AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM conv)
-- The backfill: no job left on the placeholder while its quote has ordered lines (one whose quote has none keeps it).
UNION ALL SELECT 'no_job_on_placeholder_with_quote_lines', NOT EXISTS (SELECT 1 FROM placeholder WHERE work IS NOT NULL);
