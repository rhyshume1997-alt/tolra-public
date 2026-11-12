-- Read only: after release 156 (invoice numbers unique per company whatever their capital letters; registered in supabase/release-plan.json
-- as phase 156, after 154), every row must say true. Proves: the case-insensitive unique index is in place and valid; 005's and 006's exact
-- indexes are kept; the SliQ prepare step, next_doc_number and the reconcile rows are 156's, with their grants as before; no company has two
-- invoice numbers that differ only in capital letters; release preflight's 156 marker condition holds.
SELECT 'index: invoices_invoice_ref_ci_uniq is the valid, ready unique index on (organization_id, lower(invoice_ref))' AS check_name,
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.invoices_invoice_ref_ci_uniq') AND i.indrelid = 'public.invoices'::regclass
            AND i.indisunique AND i.indisvalid AND i.indisready
            AND pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX invoices_invoice_ref_ci_uniq ON public.invoices USING btree (organization_id, lower(invoice_ref))') AS ok
UNION ALL SELECT 'indexes: 005''s invoices_invoice_ref_unique and 006''s invoices_invoice_ref_org_uniq are still there',
  to_regclass('public.invoices_invoice_ref_unique') IS NOT NULL AND to_regclass('public.invoices_invoice_ref_org_uniq') IS NOT NULL
UNION ALL SELECT 'import: import_sliq_prepare is 156''s and refuses invoice_ref_case_duplicate',
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_sliq_prepare(uuid,text,jsonb,text)')
            AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '24411fb681e2be3fc2ba3bcd007e71ac' AND p.prosrc LIKE '%invoice_ref_case_duplicate%')
UNION ALL SELECT 'import: import_sliq_prepare and import_sliq_reconcile_rows are callable by no API role (anon, authenticated, service_role)',
  NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public.import_sliq_prepare(uuid,text,jsonb,text)', 'public.import_sliq_reconcile_rows(uuid)']) AS f(sig),
                     unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
              WHERE to_regprocedure(f.sig) IS NULL OR has_function_privilege(r.role, to_regprocedure(f.sig), 'EXECUTE'))
UNION ALL SELECT 'numbering: next_doc_number is 156''s (an INV number is taken whatever its capitals), definer, callable by signed-in users, not anon',
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.next_doc_number(text)') AND p.prosecdef AND p.proconfig IS NOT NULL
            AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '75dffec8a6b52c01267aa22a64802da0')
  AND has_function_privilege('authenticated', 'public.next_doc_number(text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.next_doc_number(text)', 'EXECUTE')
UNION ALL SELECT 'reconcile: import_sliq_reconcile_rows is 156''s (duplicate invoice numbers counted whatever their capitals)',
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_sliq_reconcile_rows(uuid)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '3288cdc2d98acba018c8e417bddd77bb')
UNION ALL SELECT 'data: no company has two invoice numbers that differ only in capital letters',
  NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.invoice_ref IS NOT NULL GROUP BY i.organization_id, lower(i.invoice_ref) HAVING count(DISTINCT i.invoice_ref) > 1)
UNION ALL SELECT 'marker: release preflight''s "post-144 marker 156 invoice_ref_case" condition holds',
  coalesce((EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.invoices_invoice_ref_ci_uniq') AND i.indisunique AND i.indisvalid AND i.indisready
             AND pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX invoices_invoice_ref_ci_uniq ON public.invoices USING btree (organization_id, lower(invoice_ref))')
      AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_sliq_prepare(uuid,text,jsonb,text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '24411fb681e2be3fc2ba3bcd007e71ac')
      AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.next_doc_number(text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '75dffec8a6b52c01267aa22a64802da0')
      AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_sliq_reconcile_rows(uuid)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '3288cdc2d98acba018c8e417bddd77bb')), FALSE);
