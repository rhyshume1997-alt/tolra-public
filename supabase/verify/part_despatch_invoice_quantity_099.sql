-- Migration 099 (a draft invoice bills what was despatched; the same despatched quantity is never on two invoices). Read only: every
-- row should be TRUE (10). Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH body AS (
  SELECT p.oid, p.proname, p.prosecdef, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS md5
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.oid IN (to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)'), to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)'),
                  to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)'), to_regprocedure('public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)'),
                  to_regprocedure('public.order_line_billing(uuid,uuid)'), to_regprocedure('public.order_lines_lock(uuid[])'),
                  to_regprocedure('public.invoice_add_delivery_note(uuid,uuid,uuid)'), to_regprocedure('public.invoice_lines_within_despatched()'),
                  to_regprocedure('public.invoice_lines_link_kept()'), to_regprocedure('public.draft_invoice_balances(uuid)'))
)
-- The four replaced functions are 099's (security as before: definer, but replace_draft_invoice invoker).
SELECT 'replaced_functions_are_099' AS check_name,
       (SELECT count(*) FROM body WHERE (proname, md5, prosecdef) IN (('invoice_from_delivery_notes_draft', '135a95ccc2934df3fee8811c3d7047a7', TRUE),
                                                                     ('job_finish_draft_invoice', 'af2b452bdda21370c6988fa7f363024b', TRUE),
                                                                     ('delivery_note_try_draft', '86586da39cd1064a47265a1180480d27', TRUE),
                                                                     ('replace_draft_invoice', '10b805353825ebc49549d103a36eb900', FALSE))) = 4 AS ok
-- The new functions are 099's.
UNION ALL SELECT 'new_functions_are_099',
  (SELECT count(*) FROM body WHERE (proname, md5) IN (('order_line_billing', 'a63d4dcf42fab53ccf4f1d79ece210fb'), ('order_lines_lock', '38f5fa487f90503173947d1482ec8702'),
                                                      ('invoice_add_delivery_note', 'a735a4284535bf38b4896bee77e790f9'), ('invoice_lines_within_despatched', '7ab94be36ac601fa32e44919a53501b5'),
                                                      ('invoice_lines_link_kept', 'd74165cd4b7d867bf248825e4fdaa4e5'), ('draft_invoice_balances', '3c365c28042b8cc97f5ee495586475f7'))) = 6
-- The link column, nullable, to sales_order_lines (ON DELETE RESTRICT), indexed.
UNION ALL SELECT 'link_column',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_line_items' AND column_name = 'sales_order_line_id' AND is_nullable = 'YES' AND data_type = 'uuid')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.invoice_line_items'::regclass AND c.contype = 'f' AND c.confrelid = 'public.sales_order_lines'::regclass AND c.confdeltype = 'r')
  AND to_regclass('public.idx_invoice_line_items_order_line') IS NOT NULL
-- The three triggers on invoice_line_items are enabled.
UNION ALL SELECT 'line_triggers',
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.invoice_line_items'::regclass AND tgenabled = 'O'
     AND tgname IN ('invoice_lines_within_despatched', 'invoice_lines_link_kept', 'zz_same_org_sales_order_line_id')) = 3
-- The legacy Job Finish table: RLS on, no policy, no API grant, the support read-only trigger.
UNION ALL SELECT 'legacy_table_internal',
  coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.invoice_job_finish_legacy')), FALSE)
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invoice_job_finish_legacy')
  AND NOT has_table_privilege('authenticated', 'public.invoice_job_finish_legacy', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.invoice_job_finish_legacy', 'SELECT')
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.invoice_job_finish_legacy') AND tgname = 'support_read_only' AND tgenabled = 'O')
-- Every Job Finish draft the audit log records (still there and with no linked line) is in the legacy table.
UNION ALL SELECT 'legacy_job_finish_drafts_recorded',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a JOIN public.invoices i ON i.id::TEXT = a.metadata ->> 'invoice_id'
              WHERE a.action = 'JOB_DRAFT_INVOICE' AND a.metadata ->> 'outcome' = 'drafted'
                AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items l WHERE l.invoice_id = i.id AND l.sales_order_line_id IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM public.invoice_job_finish_legacy f WHERE f.invoice_id = i.id))
-- Internal helpers: no API role.
UNION ALL SELECT 'internal_helpers_no_api_role',
  NOT EXISTS (SELECT 1 FROM body WHERE proname IN ('order_line_billing', 'order_lines_lock', 'invoice_add_delivery_note', 'invoice_from_delivery_notes_draft',
                                                   'job_finish_draft_invoice', 'delivery_note_try_draft', 'invoice_lines_within_despatched', 'invoice_lines_link_kept')
                AND (has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE')))
-- The editor's two calls: signed-in only.
UNION ALL SELECT 'editor_calls_signed_in_only',
  (SELECT count(*) FROM body WHERE proname IN ('draft_invoice_balances', 'replace_draft_invoice')
     AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) = 2
-- No live invoice bills more of an order line than was despatched, counting only lines linked since 099.
UNION ALL SELECT 'no_linked_line_over_despatched',
  NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT il.sales_order_line_id AS id FROM public.invoice_line_items il WHERE il.sales_order_line_id IS NOT NULL) s
              CROSS JOIN LATERAL public.order_line_billing(s.id, NULL) b
              WHERE b.invoiced > b.despatched
                AND EXISTS (SELECT 1 FROM public.invoice_line_items il JOIN public.invoices i ON i.id = il.invoice_id
                            WHERE il.sales_order_line_id = s.id AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')
                              AND NOT EXISTS (SELECT 1 FROM public.invoice_job_finish_legacy f WHERE f.invoice_id = i.id)))
-- RLS on invoice_line_items is unchanged in shape: still on, no permissive FOR ALL policy.
UNION ALL SELECT 'invoice_line_items_rls',
  (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.invoice_line_items'::regclass)
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invoice_line_items' AND cmd = 'ALL' AND permissive = 'PERMISSIVE');
