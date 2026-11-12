-- Read only: after release 153 (document customer link v2; registered in supabase/release-plan.json as phase 153, after 152), every row must say true.
-- What it proves: the link table and the portal switch exist with row security, are readable (never writable) by signed-in users and
-- nothing for anon or the service role; only jobs and quotes can be linked; the job, quote and customer references are ON DELETE RESTRICT
-- (never cascade) and every link stays inside its company; at most one live link per document; the guard, same-company, audit and
-- no-truncate triggers are on; only the eight reviewed functions are callable (signed-in only, SECURITY DEFINER, pinned search_path); the
-- private functions are callable by no API role; the verified view runs as its caller, shows seven columns, none of them money, and never
-- shows an unverified link; every person-made link carries who and why and was verified when made; the portal is never on without an
-- admin and a reason; every issued-document guard is still byte-for-byte the body 153 was reviewed against, on its tables, enabled; and
-- the release order holds: release 154 (which requires 153) is never present without every 153 object (154 is rolled back before 153);
-- and (PM ruling, 12 Nov 2026 14:55) the offboarding snapshot table is readable only by platform admins at aal2, append-only and never
-- row-audited into the shared log, the offboarding's DELETEs alone skip the row audit, and every CUSTOMER_PORTAL_OFFBOARDED marker in the
-- shared log is non-sensitive (no rows, names or free-text reason) and names its company's snapshot.
-- Invariants only: each row stays true after people link, verify, unlink, retire or switch the portal (the release-time "all off",
-- "only unverified backfill rows" and "nothing shown yet" checks are in the release's own self-check).
SELECT 'tables: document_customer_links, customer_portal_switch and document_customer_offboarding_snapshots exist with row security' AS check_name,
  coalesce((SELECT bool_and(c.relrowsecurity) AND count(*) = 3 FROM pg_class c
            WHERE c.oid IN (to_regclass('public.document_customer_links'), to_regclass('public.customer_portal_switch'),
                            to_regclass('public.document_customer_offboarding_snapshots'))), false) AS ok
UNION ALL SELECT 'API: links, verified view, switch and offboarding snapshots readable by signed-in users (row security decides), never writable; nothing for anon or the service role',
  coalesce(has_table_privilege('authenticated', 'public.document_customer_links', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.document_customer_links', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND has_table_privilege('authenticated', 'public.customer_portal_switch', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.customer_portal_switch', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND has_table_privilege('authenticated', 'public.document_customer_links_verified', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.document_customer_links_verified', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.document_customer_links', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('anon', 'public.customer_portal_switch', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('anon', 'public.document_customer_links_verified', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.document_customer_links', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.customer_portal_switch', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.document_customer_links_verified', 'SELECT')
    AND has_table_privilege('authenticated', 'public.document_customer_offboarding_snapshots', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.document_customer_offboarding_snapshots', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.document_customer_offboarding_snapshots', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.document_customer_offboarding_snapshots', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'), false)
UNION ALL SELECT 'jobs and quotes only: the kind check allows job and quote and nothing else; no invoice or credit note column',
  coalesce((SELECT pg_get_constraintdef(c.oid) LIKE '%''job''%' AND pg_get_constraintdef(c.oid) LIKE '%''quote''%'
                   AND pg_get_constraintdef(c.oid) NOT LIKE '%invoice%' AND pg_get_constraintdef(c.oid) NOT LIKE '%credit%'
            FROM pg_constraint c WHERE c.conrelid = to_regclass('public.document_customer_links') AND c.conname = 'document_customer_links_kind'), false)
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_customer_links'
                  AND (column_name LIKE '%invoice%' OR column_name LIKE '%credit%'))
UNION ALL SELECT 'references: the job, quote and customer are foreign keys with ON DELETE RESTRICT, and no reference cascades (links leave only by retire)',
  (SELECT count(*) = 3 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.document_customer_links') AND c.contype = 'f' AND c.confdeltype = 'r'
     AND c.confrelid IN (to_regclass('public.jobs'), to_regclass('public.quotes'), to_regclass('public.customers')))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.document_customer_links') AND c.contype = 'f' AND c.confdeltype IN ('c', 'n', 'd'))
UNION ALL SELECT 'one live link per document: the two partial unique indexes exist, and no document has two live links',
  (SELECT count(*) = 2 FROM pg_index i WHERE i.indrelid = to_regclass('public.document_customer_links') AND i.indisunique AND i.indpred IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM public.document_customer_links WHERE unlinked_at IS NULL GROUP BY doc_kind, coalesce(job_id, quote_id) HAVING count(*) > 1)
UNION ALL SELECT 'triggers: guard, same company (job, quote, customer), row audit (insert / update, and delete) and no-truncate are on; the switch has its guard, no-truncate and row audit (insert / update, and delete)',
  (SELECT count(*) = 7 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.document_customer_links') AND NOT t.tgisinternal AND t.tgenabled = 'O'
     AND (t.tgname, t.tgfoid) IN (('document_customer_links_guard', to_regprocedure('public.document_customer_links_guard()')),
                                  ('document_customer_links_no_truncate', to_regprocedure('public.document_customer_links_no_truncate()')),
                                  ('audit_document_customer_links_changes', to_regprocedure('security_audit.log_row_change()')),
                                  ('audit_document_customer_links_deletes', to_regprocedure('security_audit.log_row_change()')),
                                  ('zz_same_org_job_id', to_regprocedure('public.enforce_same_org_parent()')),
                                  ('zz_same_org_quote_id', to_regprocedure('public.enforce_same_org_parent()')),
                                  ('zz_same_org_customer_id', to_regprocedure('public.enforce_same_org_parent()'))))
  AND (SELECT count(*) = 4 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.customer_portal_switch') AND NOT t.tgisinternal AND t.tgenabled = 'O'
     AND (t.tgname, t.tgfoid) IN (('customer_portal_switch_guard', to_regprocedure('public.customer_portal_switch_guard()')),
                                  ('customer_portal_switch_no_truncate', to_regprocedure('public.customer_portal_switch_no_truncate()')),
                                  ('audit_customer_portal_switch_changes', to_regprocedure('security_audit.log_row_change()')),
                                  ('audit_customer_portal_switch_deletes', to_regprocedure('security_audit.log_row_change()'))))
UNION ALL SELECT 'row audit: insert and update always; delete always except the platform offboarding''s own (its flag for that row''s company), on both tables; nothing else skips it',
  (SELECT count(*) = 4 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgfoid = to_regprocedure('security_audit.log_row_change()')
     AND ((t.tgrelid, t.tgname, t.tgtype) IN ((to_regclass('public.document_customer_links'), 'audit_document_customer_links_changes', 21::SMALLINT),
                                              (to_regclass('public.customer_portal_switch'), 'audit_customer_portal_switch_changes', 21::SMALLINT))
          AND t.tgqual IS NULL
       OR (t.tgrelid, t.tgname, t.tgtype) IN ((to_regclass('public.document_customer_links'), 'audit_document_customer_links_deletes', 9::SMALLINT),
                                              (to_regclass('public.customer_portal_switch'), 'audit_customer_portal_switch_deletes', 9::SMALLINT))
          AND pg_get_triggerdef(t.oid) LIKE '%WHEN ((COALESCE(current_setting(''tolra.'
              || CASE t.tgname WHEN 'audit_document_customer_links_deletes' THEN 'document_customer_link_removal' ELSE 'customer_portal_switch_write' END
              || '''::text, true), ''''::text) <> (''offboard:''::text || (old.organization_id)::text)))%'))
UNION ALL SELECT 'offboarding snapshots (PM ruling, 12 Nov 2026 14:55): read only by a platform admin at aal2; append-only (guard on update, delete, truncate); never row-audited; no reference that could block a company''s removal',
  (SELECT count(*) = 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'document_customer_offboarding_snapshots')
  AND coalesce((SELECT p.cmd = 'SELECT' AND p.permissive = 'PERMISSIVE' AND p.roles = '{authenticated}'::NAME[]
                       AND p.qual LIKE '%is_platform_admin()%' AND p.qual LIKE '%''aal''::text%' AND p.qual LIKE '%''aal2''::text%'
                       AND p.qual NOT LIKE '%organization_id%'
                FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'document_customer_offboarding_snapshots'), false)
  AND (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.document_customer_offboarding_snapshots') AND NOT t.tgisinternal
         AND t.tgenabled = 'O' AND t.tgfoid = to_regprocedure('public.document_customer_offboarding_snapshots_guard()')
         AND (t.tgname, t.tgtype) IN (('document_customer_offboarding_snapshots_guard', 27::SMALLINT), ('document_customer_offboarding_snapshots_no_truncate', 34::SMALLINT)))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.document_customer_offboarding_snapshots') AND NOT t.tgisinternal
                    AND t.tgfoid <> to_regprocedure('public.document_customer_offboarding_snapshots_guard()'))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND to_regclass('public.document_customer_offboarding_snapshots') IN (c.conrelid, c.confrelid))
UNION ALL SELECT 'offboarding marker: every CUSTOMER_PORTAL_OFFBOARDED row in the shared audit log carries no rows, switch row or free-text reason, and names a snapshot of its own company',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.action = 'CUSTOMER_PORTAL_OFFBOARDED'
                AND (a.old_data IS NOT NULL OR a.new_data IS NOT NULL
                     OR EXISTS (SELECT 1 FROM jsonb_object_keys(a.metadata) k
                                WHERE k NOT IN ('source', 'snapshot_id', 'count', 'switch_removed', 'reason_category', 'actor'))
                     OR NOT EXISTS (SELECT 1 FROM public.document_customer_offboarding_snapshots s
                                    WHERE s.id::TEXT = a.metadata ->> 'snapshot_id' AND s.organization_id = a.organization_id)))
UNION ALL SELECT 'same company: every link names a document and a customer of its own company, of the kind it says',
  NOT EXISTS (SELECT 1 FROM public.document_customer_links l
              LEFT JOIN public.jobs j ON j.id = l.job_id LEFT JOIN public.quotes q ON q.id = l.quote_id
              LEFT JOIN public.customers c ON c.id = l.customer_id
              WHERE c.organization_id IS DISTINCT FROM l.organization_id
                 OR (l.doc_kind = 'job' AND j.organization_id IS DISTINCT FROM l.organization_id)
                 OR (l.doc_kind = 'quote' AND q.organization_id IS DISTINCT FROM l.organization_id))
UNION ALL SELECT 'who and why: person-made links carry who and a reason and were verified when made; verifies and unlinks carry who, when and why; backfill links name no person',
  (SELECT count(*) = 4 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.document_customer_links') AND c.contype = 'c'
     AND c.conname IN ('document_customer_links_who_and_why', 'document_customer_links_verify_whole', 'document_customer_links_unlink_whole',
                       'document_customer_links_names'))
  AND NOT EXISTS (SELECT 1 FROM public.document_customer_links WHERE (source <> 'backfill' AND (linked_by IS NULL OR btrim(coalesce(link_reason, '')) = ''
                                                                     OR verified_at IS DISTINCT FROM linked_at))
                  OR (source = 'backfill' AND linked_by IS NOT NULL)
                  OR (verified_at IS NOT NULL AND (verified_by IS NULL OR btrim(coalesce(verify_reason, '')) = ''))
                  OR (unlinked_at IS NOT NULL AND (unlinked_by IS NULL OR btrim(coalesce(unlink_reason, '')) = '')))
UNION ALL SELECT 'names: a manual or backfill link names the customer the document names; a name override names a different one',
  NOT EXISTS (SELECT 1 FROM public.document_customer_links
              WHERE (source = 'name_override') = (lower(btrim(document_customer_text)) = lower(btrim(customer_name_at_link))))
UNION ALL SELECT 'functions: only link, name-override link, verify, unlink, retire, portal status, portal switch and the platform offboarding are callable (signed-in only), all SECURITY DEFINER with a pinned search_path',
  (SELECT count(*) = 8 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND (p.proname LIKE '%document_customer%' OR p.proname LIKE 'customer_portal%') AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  AND (SELECT count(*) = 8 FROM pg_proc p WHERE p.prosecdef AND p.proconfig::TEXT LIKE '%search_path=pg_catalog, public%'
       AND p.oid IN (to_regprocedure('public.link_document_customer(text,uuid,uuid,text)'), to_regprocedure('public.link_document_customer_name_override(text,uuid,uuid,text,boolean)'),
                     to_regprocedure('public.verify_document_customer_links(uuid[],text)'), to_regprocedure('public.unlink_document_customer(text,uuid,text)'),
                     to_regprocedure('public.retire_document_customer_links(text,uuid,text)'),
                     to_regprocedure('public.customer_portal_status()'), to_regprocedure('public.customer_portal_set_enabled(boolean,text)'),
                     to_regprocedure('public.platform_offboard_document_customer_links(uuid,text)')))
  AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE '%document_customer%' OR p.proname LIKE 'customer_portal%')
                  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')))
UNION ALL SELECT 'private: the backfill, the actor and reason checks and the five trigger functions are callable by no API role',
  (SELECT count(*) = 8 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public._document_customer_link_backfill(uuid)'), to_regprocedure('public._document_customer_link_actor(text[],boolean)'),
                     to_regprocedure('public._document_customer_link_reason(text)'), to_regprocedure('public.document_customer_links_guard()'),
                     to_regprocedure('public.document_customer_links_no_truncate()'), to_regprocedure('public.customer_portal_switch_guard()'),
                     to_regprocedure('public.customer_portal_switch_no_truncate()'), to_regprocedure('public.document_customer_offboarding_snapshots_guard()'))
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))
UNION ALL SELECT 'verified view: runs as its caller and shows exactly seven columns, none of them a cost, margin, balance, total, status or approval; never an unverified or unlinked link',
  coalesce((SELECT 'security_invoker=true' = ANY (c.reloptions) FROM pg_class c WHERE c.oid = to_regclass('public.document_customer_links_verified')), false)
  AND coalesce((SELECT array_agg(column_name::TEXT ORDER BY ordinal_position) FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'document_customer_links_verified')
               = ARRAY['id', 'organization_id', 'doc_kind', 'document_id', 'customer_id', 'source', 'verified_at'], false)
  AND coalesce((SELECT NOT EXISTS (SELECT 1 FROM public.document_customer_links_verified v JOIN public.document_customer_links l ON l.id = v.id
                                   WHERE l.verified_at IS NULL OR l.unlinked_at IS NOT NULL)), false)
UNION ALL SELECT 'off by default: no row means off; a company is on only after an admin switched it with a reason',
  (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.customer_portal_switch') AND c.conname = 'customer_portal_switch_reason')
  AND coalesce((SELECT column_default = 'false' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customer_portal_switch' AND column_name = 'enabled'), false)
  AND NOT EXISTS (SELECT 1 FROM public.customer_portal_switch WHERE enabled AND (changed_by IS NULL OR btrim(reason) = ''))
UNION ALL SELECT 'issued-document guards: all 17 are byte-for-byte the bodies 153 was reviewed against (md5 of the body without whitespace)',
  NOT EXISTS (SELECT 1 FROM (VALUES
     ('public.invoice_issue_lock()', 'aa8c9f3ae3035d0ed566723a28edd827'), ('public.invoice_lines_issue_lock()', 'b3673253b58e588dfe8a58730155f6c2'),
     ('public.invoice_issue_guard()', 'a601d6b3464100729d4c9b5055d6633e'), ('public.issue_requires_matching_totals()', 'b4916aa4cdae320a157e810372f79b2e'),
     ('public.quote_lifecycle_guard()', '3c01d528076221cdac11c72f7327ab02'), ('public.quote_lines_issue_lock()', 'a53b1982a3a9d995d1f3770e4dcbc2af'),
     ('public.quote_version_guard()', 'f31c7937ac32d3615a5b144b5e6d064c'), ('public.quote_revision_withdrawn()', 'ad87b0b819e1ce1352e1c79a2a49fdc8'),
     ('public.documents_start_as_drafts()', 'e923e0bc1a8c1e28a29ae912dc551fd2'), ('public.credit_note_issue_lock()', '8e0ff460c60a94bb1164dc39dd77aae1'),
     ('public.credit_note_lines_issue_lock()', '369bbaa5c6979d4bb9d70c5cbf68d9bd'), ('public.delivery_notes_link_guard()', '4c57607b1909f060d689df9ea5a99128'),
     ('public.delivery_note_items_link_guard()', '612a2bc924a8ea1916ce1a66101ced97'), ('public.purchase_order_issue_lock()', '9f903e888bca6d55322cc877488c1019'),
     ('public.jobs_internal_immutable()', 'f05940d0ef168da81021a95aa3716718'), ('public.customers_in_use_guard()', 'f0eacba59c9e666f82083ff030cc966c'),
     ('public.enforce_same_org_parent()', '4152a78c6de9e2473c49ce6c6e45c30f')) AS e(sig, body)
   LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
   WHERE p.oid IS NULL OR md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> e.body)
UNION ALL SELECT 'issued-document guards: each still runs from at least one enabled trigger, and no trigger that runs one is disabled',
  (SELECT count(DISTINCT t.tgfoid) = 17 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
     AND t.tgfoid IN (SELECT to_regprocedure(s) FROM unnest(ARRAY['public.invoice_issue_lock()', 'public.invoice_lines_issue_lock()', 'public.invoice_issue_guard()',
       'public.issue_requires_matching_totals()', 'public.quote_lifecycle_guard()', 'public.quote_lines_issue_lock()', 'public.quote_version_guard()',
       'public.quote_revision_withdrawn()', 'public.documents_start_as_drafts()', 'public.credit_note_issue_lock()', 'public.credit_note_lines_issue_lock()',
       'public.delivery_notes_link_guard()', 'public.delivery_note_items_link_guard()', 'public.purchase_order_issue_lock()', 'public.jobs_internal_immutable()',
       'public.customers_in_use_guard()', 'public.enforce_same_org_parent()']) AS s))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled = 'D'
     AND t.tgfoid IN (SELECT to_regprocedure(s) FROM unnest(ARRAY['public.invoice_issue_lock()', 'public.invoice_lines_issue_lock()', 'public.invoice_issue_guard()',
       'public.issue_requires_matching_totals()', 'public.quote_lifecycle_guard()', 'public.quote_lines_issue_lock()', 'public.quote_version_guard()',
       'public.quote_revision_withdrawn()', 'public.documents_start_as_drafts()', 'public.credit_note_issue_lock()', 'public.credit_note_lines_issue_lock()',
       'public.delivery_notes_link_guard()', 'public.delivery_note_items_link_guard()', 'public.purchase_order_issue_lock()', 'public.jobs_internal_immutable()',
       'public.customers_in_use_guard()', 'public.enforce_same_org_parent()']) AS s))
UNION ALL SELECT 'document tables untouched in shape: no column, user trigger or policy on jobs, quotes, invoices, credit notes or customers names 153''s objects',
  NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE NOT t.tgisinternal AND t.tgrelid IN (to_regclass('public.jobs'), to_regclass('public.quotes'), to_regclass('public.invoices'),
                                                         to_regclass('public.credit_notes'), to_regclass('public.customers'))
                AND (p.proname LIKE '%document_customer%' OR p.proname LIKE 'customer_portal%'))
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('jobs', 'quotes', 'invoices', 'credit_notes', 'customers')
                  AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%document_customer%')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('jobs', 'quotes', 'invoices', 'credit_notes', 'customers')
                  AND (column_name LIKE '%document_customer%' OR column_name LIKE '%portal%'))
UNION ALL SELECT 'release order: release 154 (which requires 153) is never present without every 153 object; 154 is rolled back before 153',
  NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_secrets' AND column_name = 'provider')
       OR to_regprocedure('public.ai_helper_set_provider_key(text,text,text)') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('ai_helper_tolra_control_deactivated_154', 'ai_helper_tolra_companies_deactivated_154')))
  OR (to_regclass('public.document_customer_links') IS NOT NULL AND to_regclass('public.document_customer_links_verified') IS NOT NULL
      AND to_regclass('public.customer_portal_switch') IS NOT NULL AND to_regclass('public.document_customer_offboarding_snapshots') IS NOT NULL
      AND to_regprocedure('public.link_document_customer(text,uuid,uuid,text)') IS NOT NULL
      AND to_regprocedure('public.retire_document_customer_links(text,uuid,text)') IS NOT NULL
      AND to_regprocedure('public.platform_offboard_document_customer_links(uuid,text)') IS NOT NULL);
