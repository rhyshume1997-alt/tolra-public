-- Migration 099 (a draft invoice bills what was despatched; the same despatched quantity is never on two invoices). Read only: every
-- row should be TRUE (11). Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH body AS (
  SELECT p.oid, p.proname, p.prosecdef, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS md5
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.oid IN (to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)'), to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)'),
                  to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)'), to_regprocedure('public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)'),
                  to_regprocedure('public.order_line_billing(uuid,uuid)'), to_regprocedure('public.order_lines_lock(uuid[])'),
                  to_regprocedure('public.invoice_add_delivery_note(uuid,uuid,uuid)'), to_regprocedure('public.invoice_lines_within_despatched()'),
                  to_regprocedure('public.invoice_lines_kind_guard()'), to_regprocedure('public.draft_invoice_balances(uuid)'),
                  to_regprocedure('public.jobs_awaiting_despatch_or_invoice()'), to_regprocedure('public.draft_invoice_order_lines(uuid)'))
)
-- The four replaced functions are 099's (security as before: definer, but replace_draft_invoice invoker).
SELECT 'replaced_functions_are_099' AS check_name,
       (SELECT count(*) FROM body WHERE (proname, md5, prosecdef) IN (('invoice_from_delivery_notes_draft', 'd467a505ab13a1cc1b1fa51cd8922f58', TRUE),
                                                                     ('job_finish_draft_invoice', '8c4d3694cec4ac679916f916afc41985', TRUE),
                                                                     ('delivery_note_try_draft', 'c1464c01f419d1866e7143a41076e7d0', TRUE),
                                                                     ('replace_draft_invoice', '8e8e4cc70d1cd7ad4c3268c49e52f305', FALSE))) = 4 AS ok
-- The new functions are 099's.
UNION ALL SELECT 'new_functions_are_099',
  (SELECT count(*) FROM body WHERE (proname, md5) IN (('order_line_billing', '2ffae968ab1e00a1c71d30884f5b34a3'), ('order_lines_lock', '38f5fa487f90503173947d1482ec8702'),
                                                      ('invoice_add_delivery_note', '31bcd0288bac3707baa87d5300bc03d1'), ('invoice_lines_within_despatched', '582a14053c483e547077992cf667a9b5'),
                                                      ('invoice_lines_kind_guard', 'b042387be8f39ef14bc8206d398afdf2'), ('draft_invoice_balances', 'f4d3cf13dbccf537f42fb60ccaf24b17'),
                                                      ('jobs_awaiting_despatch_or_invoice', '02033e48ea48edecfd726788e2d62674'),
                                                      ('draft_invoice_order_lines', '4b940494d9531718805788db98a76703'))) = 8
-- The link column, nullable, to sales_order_lines (ON DELETE RESTRICT), indexed; the line kind ('order' linked, 'manual' never), default 'manual'.
UNION ALL SELECT 'link_column',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_line_items' AND column_name = 'sales_order_line_id' AND is_nullable = 'YES' AND data_type = 'uuid')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.invoice_line_items'::regclass AND c.contype = 'f' AND c.confrelid = 'public.sales_order_lines'::regclass AND c.confdeltype = 'r')
  AND to_regclass('public.idx_invoice_line_items_order_line') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_line_items' AND column_name = 'line_kind' AND column_default LIKE '''manual''%')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.invoice_line_items'::regclass AND c.conname = 'invoice_line_items_line_kind' AND c.convalidated)
-- The three triggers on invoice_line_items are enabled.
UNION ALL SELECT 'line_triggers',
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.invoice_line_items'::regclass AND tgenabled = 'O'
     AND tgname IN ('invoice_lines_within_despatched', 'invoice_lines_kind_guard', 'zz_same_org_sales_order_line_id')) = 3
-- The two legacy tables: RLS on, no policy, no API grant, the support read-only trigger.
UNION ALL SELECT 'legacy_tables_internal',
  (SELECT count(*) FROM pg_class c WHERE c.oid IN (to_regclass('public.invoice_job_finish_legacy'), to_regclass('public.invoice_notes_legacy')) AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)
     AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND NOT has_table_privilege('anon', c.oid, 'SELECT')
     AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only' AND t.tgenabled = 'O')) = 2
-- Every Job Finish draft the audit log records (still there and with no linked line) is in the legacy table.
UNION ALL SELECT 'legacy_job_finish_drafts_recorded',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a JOIN public.invoices i ON i.id::TEXT = a.metadata ->> 'invoice_id'
              WHERE a.action = 'JOB_DRAFT_INVOICE' AND a.metadata ->> 'outcome' = 'drafted'
                AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items l WHERE l.invoice_id = i.id AND l.sales_order_line_id IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM public.invoice_job_finish_legacy f WHERE f.invoice_id = i.id))
-- Internal helpers: no API role.
-- Every invoice that had a delivery note on it before 099 is in the notes snapshot (an invoice made since may or may not be: only
-- those made before count their notes). Checked as: no invoice older than the snapshot's newest entry with a note is missing.
UNION ALL SELECT 'legacy_notes_recorded',
  NOT EXISTS (SELECT 1 FROM public.invoices i JOIN public.delivery_notes d ON d.invoice_id = i.id
              WHERE i.created_at <= coalesce((SELECT max(x.created_at) FROM public.invoices x JOIN public.invoice_notes_legacy n ON n.invoice_id = x.id), '-infinity'::TIMESTAMPTZ)
                AND NOT EXISTS (SELECT 1 FROM public.invoice_notes_legacy n WHERE n.invoice_id = i.id)
                AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items l WHERE l.invoice_id = i.id AND l.sales_order_line_id IS NOT NULL))
UNION ALL SELECT 'internal_helpers_no_api_role',
  NOT EXISTS (SELECT 1 FROM body WHERE proname IN ('order_line_billing', 'order_lines_lock', 'invoice_add_delivery_note', 'invoice_from_delivery_notes_draft',
                                                   'job_finish_draft_invoice', 'delivery_note_try_draft', 'invoice_lines_within_despatched', 'invoice_lines_kind_guard')
                AND (has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE')))
-- The editor's three calls and the dashboard's: signed-in only.
UNION ALL SELECT 'editor_calls_signed_in_only',
  (SELECT count(*) FROM body WHERE proname IN ('draft_invoice_balances', 'replace_draft_invoice', 'jobs_awaiting_despatch_or_invoice', 'draft_invoice_order_lines')
     AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) = 4
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
