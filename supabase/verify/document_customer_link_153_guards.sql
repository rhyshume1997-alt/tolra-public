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
SELECT 'guard ' || e.sig || ' matches the reviewed body' AS check_name,
       coalesce(md5(regexp_replace(p.prosrc, '\s', '', 'g')), 'missing') AS actual_md5,
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
