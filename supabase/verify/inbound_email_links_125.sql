-- Migration 125 (inbox e-mails linked to a quote or a purchase order; suggestions only). Read only: every row should be TRUE (9). Bodies
-- are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.link_inbound_email(uuid, text, uuid, text, text)')
)
-- The five columns, with their types.
SELECT 'link_columns' AS check_name,
  (SELECT count(*) = 5 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inbound_emails'
     AND (column_name, data_type) IN (('linked_quote_id', 'uuid'), ('linked_purchase_order_id', 'uuid'), ('link_status', 'text'),
                                      ('linked_po_number', 'text'), ('link_suggestions', 'jsonb'))) AS ok
-- Both links are foreign keys with ON DELETE SET NULL, to quotes and to purchase_orders.
UNION ALL SELECT 'links_are_set_null_foreign_keys',
  (SELECT count(*) = 2 FROM pg_constraint c WHERE c.conrelid = 'public.inbound_emails'::regclass AND c.contype = 'f' AND c.confdeltype = 'n'
     AND ((c.confrelid = 'public.quotes'::regclass AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.inbound_emails'::regclass AND attname = 'linked_quote_id')])
       OR (c.confrelid = 'public.purchase_orders'::regclass AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.inbound_emails'::regclass AND attname = 'linked_purchase_order_id')])))
-- The five rules: status values, one link at most, a link only by a person (or a later approved auto match), PO length, at most 10 suggestions.
UNION ALL SELECT 'link_rules',
  (SELECT count(*) = 5 FROM pg_constraint WHERE conrelid = 'public.inbound_emails'::regclass AND contype = 'c' AND conname IN
     ('inbound_emails_link_status_check', 'inbound_emails_one_link_check', 'inbound_emails_linked_by_check', 'inbound_emails_linked_po_check',
      'inbound_emails_link_suggestions_check'))
-- The same-company trigger on each link (enforce_same_org_parent, enabled, row level, BEFORE INSERT OR UPDATE).
UNION ALL SELECT 'same_company_triggers',
  (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.inbound_emails'::regclass AND NOT tgisinternal AND tgenabled = 'O'
     AND tgfoid = to_regprocedure('public.enforce_same_org_parent()') AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 4) = 4 AND (tgtype & 16) = 16
     AND ((tgname = 'zz_same_org_linked_quote_id' AND pg_get_triggerdef(oid) LIKE '%enforce_same_org_parent(''quotes'', ''linked_quote_id'')%')
       OR (tgname = 'zz_same_org_linked_purchase_order_id' AND pg_get_triggerdef(oid) LIKE '%enforce_same_org_parent(''purchase_orders'', ''linked_purchase_order_id'')%')))
-- link_inbound_email: this file's body, volatile, definer with the pinned search_path.
UNION ALL SELECT 'link_function_is_125',
  coalesce((SELECT body = '2f7a1169a7087cf17a3f872a8f08a088' AND provolatile = 'v' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM fn), FALSE)
-- Signed-in only: authenticated may, anon and PUBLIC may not.
UNION ALL SELECT 'link_function_signed_in_only',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn), FALSE)
-- The API roles still can't write the table directly (only the two functions do).
UNION ALL SELECT 'no_direct_writes',
  NOT has_table_privilege('authenticated', 'public.inbound_emails', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.inbound_emails', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.inbound_emails', 'DELETE') AND NOT has_table_privilege('anon', 'public.inbound_emails', 'SELECT')
-- 031's read rule is unchanged: the company's admin and office users only.
UNION ALL SELECT 'read_rule_unchanged',
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inbound_emails' AND policyname = 'inbound_emails rbac select' AND cmd = 'SELECT'
            AND qual LIKE '%current_user_organization_id()%' AND qual LIKE '%admin%' AND qual LIKE '%office%')
-- Suggest only: no e-mail is linked automatically.
UNION ALL SELECT 'no_automatic_links',
  NOT EXISTS (SELECT 1 FROM public.inbound_emails WHERE link_status = 'auto');
