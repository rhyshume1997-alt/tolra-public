-- Migration 124 (a supplier purchase order linked to the customer quote or job it was bought for). Read only: every row should be TRUE (7).
-- Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH po AS (SELECT to_regclass('public.purchase_orders') AS rel),
col AS (
  SELECT c.column_name, c.data_type, c.is_nullable, c.numeric_precision, c.numeric_scale FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'purchase_orders' AND c.column_name IN ('quote_id', 'job_id', 'linked_net')
)
-- The three columns, nullable: two uuid links and the allocated ex-VAT amount NUMERIC(14,2).
SELECT 'columns_nullable' AS check_name,
  (SELECT count(*) = 3 AND bool_and(is_nullable = 'YES' AND CASE column_name WHEN 'linked_net' THEN data_type = 'numeric' AND numeric_precision = 14 AND numeric_scale = 2
                                                                        ELSE data_type = 'uuid' END) FROM col) AS ok
-- One foreign key each, ON DELETE SET NULL, to quotes and to jobs.
UNION ALL SELECT 'links_set_null_on_delete',
  (SELECT count(*) = 2 FROM pg_constraint c, po WHERE c.conrelid = po.rel AND c.contype = 'f' AND c.confdeltype = 'n'
     AND ((c.confrelid = to_regclass('public.quotes') AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = po.rel AND attname = 'quote_id')])
       OR (c.confrelid = to_regclass('public.jobs') AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = po.rel AND attname = 'job_id')])))
-- The allocated amount is never negative.
UNION ALL SELECT 'linked_net_not_negative',
  EXISTS (SELECT 1 FROM pg_constraint c, po WHERE c.conrelid = po.rel AND c.conname = 'purchase_orders_linked_net_check' AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) = 'CHECK ((linked_net >= (0)::numeric))')
-- Both links indexed.
UNION ALL SELECT 'links_indexed',
  to_regclass('public.idx_purchase_orders_quote_id') IS NOT NULL AND to_regclass('public.idx_purchase_orders_job_id') IS NOT NULL
-- Same company: the existing same-organisation trigger on each link, enabled, firing on the link or the company changing.
UNION ALL SELECT 'same_company_triggers',
  (SELECT count(*) = 2 FROM pg_trigger t, po WHERE t.tgrelid = po.rel AND NOT t.tgisinternal AND t.tgenabled = 'O'
     AND t.tgfoid = to_regprocedure('public.enforce_same_org_parent()')
     AND ((t.tgname = 'zz_same_org_quote_id' AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF quote_id, organization_id%enforce_same_org_parent(''quotes'', ''quote_id'')')
       OR (t.tgname = 'zz_same_org_job_id' AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF job_id, organization_id%enforce_same_org_parent(''jobs'', ''job_id'')')))
-- purchase_order_issue_lock is 124's body (the links and amount stay open after issue), still on its trigger.
UNION ALL SELECT 'issue_lock_is_124',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '9f903e888bca6d55322cc877488c1019' FROM pg_proc p WHERE p.oid = to_regprocedure('public.purchase_order_issue_lock()')), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger t, po WHERE t.tgrelid = po.rel AND t.tgname = 'purchase_order_issue_lock' AND t.tgfoid = to_regprocedure('public.purchase_order_issue_lock()'))
-- Row rules unchanged: RLS on, the four admin/office policies and the section policy; anon has nothing on the table.
UNION ALL SELECT 'row_rules_unchanged',
  (SELECT c.relrowsecurity FROM pg_class c, po WHERE c.oid = po.rel)
  AND (SELECT count(*) = 5 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'purchase_orders')
  AND (SELECT count(*) = 4 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'purchase_orders'
         AND coalesce(p.qual, p.with_check) LIKE '%current_user_organization_id()%' AND coalesce(p.qual, p.with_check) LIKE '%has_org_role(''{admin,office}''::text[])%')
  AND NOT has_table_privilege('anon', 'public.purchase_orders', 'SELECT');
