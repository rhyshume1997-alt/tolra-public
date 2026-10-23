-- READ ONLY. Migration 059 (a delivery note sent out makes a draft invoice; sent but not invoiced): run in a read-only transaction AFTER
-- applying 059 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Every row is a fact about the schema or the data and must be "true".
WITH
fn AS (SELECT p.proname, p.prosecdef, p.proconfig, p.provolatile, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
internal(sig) AS (VALUES ('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)'), ('public.delivery_note_draft_block(uuid)'),
                         ('public.delivery_note_try_draft(uuid,uuid,text)'), ('public.delivery_note_auto_invoice()'))
SELECT * FROM (
  SELECT 1 AS n, 'invoice_queue_events: row-level security, a select policy for admin and office and the invoices-section restrictive policy' AS check_name,
      ((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.invoice_queue_events'))
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invoice_queue_events' AND policyname = 'invoice_queue_events rbac select'
                     AND cmd = 'SELECT' AND qual LIKE '%current_user_organization_id()%' AND qual LIKE '%admin%office%' AND qual NOT LIKE '%workshop%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invoice_queue_events' AND policyname = 'invoice_queue_events section access'
                     AND permissive = 'RESTRICTIVE' AND qual LIKE '%section_allowed(''invoices''%')
       AND (SELECT count(*) = 2 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invoice_queue_events'))::text AS value,
      'true' AS expected
  UNION ALL SELECT 2, 'invoice_queue_events: authenticated may only select; anon and PUBLIC nothing (rows are written by the database only)',
      (NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'invoice_queue_events' AND grantee IN ('anon', 'PUBLIC'))
       AND (SELECT coalesce(array_agg(DISTINCT privilege_type::text), ARRAY[]::text[]) = ARRAY['SELECT'] FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'invoice_queue_events' AND grantee = 'authenticated'))::text, 'true'
  UNION ALL SELECT 3, 'invoice_queue_events: same-company links (note, invoice), audit trail and support read-only triggers',
      (SELECT count(*) = 4 FROM pg_trigger WHERE tgrelid = to_regclass('public.invoice_queue_events') AND NOT tgisinternal
         AND tgname IN ('zz_same_org_delivery_note_id', 'zz_same_org_invoice_id', 'audit_invoice_queue_events_changes', 'support_read_only'))::text, 'true'
  UNION ALL SELECT 4, 'The four internal functions exist, are SECURITY DEFINER with a pinned search_path, and no API role (anon, authenticated, service_role) may run them',
      (SELECT bool_and(to_regprocedure(sig) IS NOT NULL
                       AND (SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public'] FROM fn WHERE fn.oid = to_regprocedure(sig))
                       AND NOT has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE')
                       AND NOT has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE')
                       AND NOT has_function_privilege('service_role', to_regprocedure(sig), 'EXECUTE')) FROM internal)::text, 'true'
  UNION ALL SELECT 5, 'create_invoice_from_delivery_notes: same signature and result, SECURITY DEFINER, pinned search_path, second step, admin/office, invoices section, calls the internal draft',
      (SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, public'] AND pg_get_function_result(oid) = 'jsonb'
              AND position('assert_privileged_aal' IN pg_get_functiondef(oid)) > 0 AND position('section_allowed(''invoices'')' IN pg_get_functiondef(oid)) > 0
              AND position('ARRAY[''admin'', ''office'']' IN pg_get_functiondef(oid)) > 0 AND position('invoice_from_delivery_notes_draft' IN pg_get_functiondef(oid)) > 0
              AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
       FROM fn WHERE oid = to_regprocedure('public.create_invoice_from_delivery_notes(uuid[],date,date,text)'))::text, 'true'
  UNION ALL SELECT 6, 'The internal draft keeps 034''s rules: notes locked in id order, sent out, not on a live invoice (void and cancelled excepted), made from an order; one customer and one VAT setting',
      (SELECT position('ORDER BY id FOR UPDATE' IN d) > 0 AND position('''void'', ''voided'', ''cancelled'', ''canceled''' IN d) > 0
              AND position('sales_order_line_id IS NULL' IN d) > 0 AND position('different customers' IN d) > 0 AND position('disagree on VAT' IN d) > 0
              AND position('current_user_organization_id()' IN d) > 0
       FROM (SELECT pg_get_functiondef(to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)')) AS d) x)::text, 'true'
  UNION ALL SELECT 7, 'uninvoiced_delivery_notes(): SECURITY DEFINER, STABLE, pinned search_path, admin/office and the invoices section; authenticated may run it, anon not',
      (SELECT prosecdef AND provolatile = 's' AND proconfig @> ARRAY['search_path=pg_catalog, public']
              AND position('ARRAY[''admin'', ''office'']' IN pg_get_functiondef(oid)) > 0 AND position('section_allowed(''invoices'')' IN pg_get_functiondef(oid)) > 0
              AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
       FROM fn WHERE oid = to_regprocedure('public.uninvoiced_delivery_notes()'))::text, 'true'
  UNION ALL SELECT 8, 'delivery_notes_auto_invoice: AFTER UPDATE OF status on delivery_notes, per row, enabled, only on a move into despatched/delivered/signed',
      (SELECT count(*) = 1 FROM pg_trigger t WHERE t.tgrelid = 'public.delivery_notes'::regclass AND t.tgname = 'delivery_notes_auto_invoice' AND t.tgenabled = 'O'
         AND t.tgfoid = to_regprocedure('public.delivery_note_auto_invoice()')
         AND pg_get_triggerdef(t.oid) LIKE 'CREATE TRIGGER delivery_notes_auto_invoice AFTER UPDATE OF status ON public.delivery_notes FOR EACH ROW WHEN %despatched%delivered%signed%')::text, 'true'
  UNION ALL SELECT 9, 'A void or cancelled invoice drafts nothing (034: its notes are freed for a person): no trigger on invoices calls the automatic draft, and no invoice_void_redraft',
      (to_regprocedure('public.invoice_void_redraft()') IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'public.invoices'::regclass AND NOT t.tgisinternal
                         AND (t.tgname = 'invoices_void_redraft' OR position('delivery_note_try_draft' IN p.prosrc) > 0)))::text, 'true'
  UNION ALL SELECT 10, 'A failed draft never blocks the despatch: the attempt is in its own exception block and the failure is recorded (or warned about)',
      (SELECT position('EXCEPTION WHEN OTHERS' IN d) > 0 AND position('''failed''' IN d) > 0 AND position('RAISE WARNING' IN d) > 0
       FROM (SELECT pg_get_functiondef(to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)')) AS d) x)::text, 'true'
  UNION ALL SELECT 11, 'No delivery note of an internal job is on a live invoice',
      (NOT EXISTS (SELECT 1 FROM public.delivery_notes d JOIN public.invoices i ON i.id = d.invoice_id JOIN public.jobs j ON j.id = d.job_id
                   WHERE j.is_internal AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')))::text, 'true'
  UNION ALL SELECT 12, 'Every automatic attempt belongs to its note''s company, and every draft it made to the same company',
      (NOT EXISTS (SELECT 1 FROM public.invoice_queue_events q JOIN public.delivery_notes d ON d.id = q.delivery_note_id WHERE d.organization_id <> q.organization_id)
       AND NOT EXISTS (SELECT 1 FROM public.invoice_queue_events q JOIN public.invoices i ON i.id = q.invoice_id WHERE i.organization_id <> q.organization_id))::text, 'true'
) checks
ORDER BY n;
