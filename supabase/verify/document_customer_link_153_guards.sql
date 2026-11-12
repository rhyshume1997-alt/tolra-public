-- Read only. BEFORE release 153, on the database it is about to run on: is each of the 17 issued-document guard functions byte-for-byte
-- (md5 of the body without whitespace, the release_preflight method) the body 153 was reviewed against? One row per guard; the last
-- column must be true on all 17 rows. The release's own guard refuses the same mismatch inside its transaction; this file lets the
-- mismatch be seen, with the real md5, before anyone schedules the release.
-- Order of use (PM correction "verify all 17 guard fingerprints against a real database before production SQL"):
--   1. the local disposable stack at 152 (the test:db fixture, through 152): all 17 true, actual_md5 recorded in the PR;
--   2. production, read only, through the release preflight route, only when Rhys says so: all 17 true. If any row is false, STOP:
--      compare that function's body on production with the reviewed one; only after review may its production md5 be added to the
--      pins (as release_preflight already allows two reviewed values for some functions). Never edit a guard to make it match.
-- Touches nothing; needs no 153 object (safe before and after 153).
-- Live state, not source (PM, 12 Nov 2026): besides the pinned body md5 (ok), each row also reads from the catalogue the md5 of the
-- function's full definition (pg_get_functiondef: language, SECURITY DEFINER, SET search_path, volatility and body) plus its owner and
-- grants (definition_md5), and the number and md5 of the enabled state and pg_get_triggerdef of every user trigger that runs it
-- (triggers, triggers_md5), leaving out triggers on 153's own two tables (153 adds three enforce_same_org_parent triggers there). Those
-- three columns have no pinned value yet: the DB proof requires them identical at 152 and with 153 installed (153 changed no guard
-- definition and no trigger that runs one), and prints them so a reviewed run can pin them. The last column must still be true on all 17.
SELECT 'guard ' || e.sig || ' matches the reviewed body' AS check_name,
       coalesce(md5(regexp_replace(p.prosrc, '\s', '', 'g')), 'missing') AS actual_md5,
       coalesce(md5(pg_get_functiondef(p.oid) || '|' || p.proowner::regrole::TEXT || '|' || coalesce(p.proacl::TEXT, '')), 'missing') AS definition_md5,
       (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgfoid = p.oid AND NOT t.tgisinternal
          AND NOT (c.relnamespace = 'public'::regnamespace AND c.relname IN ('document_customer_links', 'customer_portal_switch')))::INT AS triggers,
       coalesce((SELECT md5(string_agg(n.nspname || '.' || c.relname || '.' || t.tgname || ':' || t.tgenabled::TEXT || ':' || pg_get_triggerdef(t.oid), E'\n'
                                       ORDER BY n.nspname, c.relname, t.tgname))
                 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE t.tgfoid = p.oid AND NOT t.tgisinternal
                   AND NOT (c.relnamespace = 'public'::regnamespace AND c.relname IN ('document_customer_links', 'customer_portal_switch'))), 'none') AS triggers_md5,
       coalesce(md5(regexp_replace(p.prosrc, '\s', '', 'g')) = e.body, false) AS ok
FROM (VALUES
  (1, 'public.invoice_issue_lock()', 'aa8c9f3ae3035d0ed566723a28edd827'), (2, 'public.invoice_lines_issue_lock()', 'b3673253b58e588dfe8a58730155f6c2'),
  (3, 'public.invoice_issue_guard()', 'a601d6b3464100729d4c9b5055d6633e'), (4, 'public.issue_requires_matching_totals()', 'b4916aa4cdae320a157e810372f79b2e'),
  (5, 'public.quote_lifecycle_guard()', '3c01d528076221cdac11c72f7327ab02'), (6, 'public.quote_lines_issue_lock()', 'a53b1982a3a9d995d1f3770e4dcbc2af'),
  (7, 'public.quote_version_guard()', 'f31c7937ac32d3615a5b144b5e6d064c'), (8, 'public.quote_revision_withdrawn()', 'ad87b0b819e1ce1352e1c79a2a49fdc8'),
  (9, 'public.documents_start_as_drafts()', 'e923e0bc1a8c1e28a29ae912dc551fd2'), (10, 'public.credit_note_issue_lock()', '8e0ff460c60a94bb1164dc39dd77aae1'),
  (11, 'public.credit_note_lines_issue_lock()', '369bbaa5c6979d4bb9d70c5cbf68d9bd'), (12, 'public.delivery_notes_link_guard()', '4c57607b1909f060d689df9ea5a99128'),
  (13, 'public.delivery_note_items_link_guard()', '612a2bc924a8ea1916ce1a66101ced97'), (14, 'public.purchase_order_issue_lock()', '9f903e888bca6d55322cc877488c1019'),
  (15, 'public.jobs_internal_immutable()', 'f05940d0ef168da81021a95aa3716718'), (16, 'public.customers_in_use_guard()', 'f0eacba59c9e666f82083ff030cc966c'),
  (17, 'public.enforce_same_org_parent()', '4152a78c6de9e2473c49ce6c6e45c30f')) AS e(n, sig, body)
LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
ORDER BY e.n;
