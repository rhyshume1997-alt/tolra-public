-- 141 rollback: ONLY with Rhys's approval. Removes the opening WIP record: the table (with its policy, triggers and index). Every opening WIP row
-- is lost (nothing else reads them; keep the importer's wip-verification.csv and SliQ's own figures). The table's row audit entries stay in
-- security_audit.audit_log, which nothing can edit. 141 replaced no existing object, so nothing else is touched. A later SliQ import with WIP
-- rows is then refused (the table is missing).
-- Run the whole text as one transaction, then the release preflight (marker 141 shows "not applied").
BEGIN;
DO $ca_rollback_verify$
DECLARE checked record;
BEGIN
 FOR checked IN
-- Migration 141 (opening WIP from SliQ, kept on its own: public.opening_wip). Read only: every row should be TRUE (9).
SELECT 'table_present_rls_on' AS check_name,
  coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.opening_wip')), FALSE) AS ok
UNION ALL SELECT 'columns',
  (SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'opening_wip')
    = 'as_of:date:YES,description:text:YES,id:uuid:NO,imported_at:timestamp with time zone:NO,job_id:uuid:YES,organization_id:uuid:NO,'
      'quantity:numeric:YES,source:text:NO,source_job_ref:text:YES,source_key:text:NO,source_reference:text:YES,value:numeric:YES'
-- One read policy: admin and office of the session's company, each helper inside a sub-select (asked once per statement, as 131
-- requires of every policy). No other policy. The md5 is 141's exact policy text (the same read rule as 131's "invoices rbac select").
UNION ALL SELECT 'one_select_policy_admin_office',
  (SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd, ',' ORDER BY policyname) FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'opening_wip') = 'opening_wip rbac select PERMISSIVE SELECT'
  AND (SELECT md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'opening_wip')
      = '6a18e9fed9ee8dd956c314df2b296562'
-- Signed-in people read (the policy filters), write nothing; anon nothing.
UNION ALL SELECT 'grants_read_only',
  has_table_privilege('authenticated', 'public.opening_wip', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.opening_wip', 'INSERT, UPDATE, DELETE, TRUNCATE')
  AND NOT has_table_privilege('anon', 'public.opening_wip', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
UNION ALL SELECT 'repeat_key_unique',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.opening_wip') AND conname = 'opening_wip_source_key_unique' AND contype = 'u')
UNION ALL SELECT 'job_link_set_null_same_org',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.opening_wip') AND contype = 'f' AND confrelid = to_regclass('public.jobs') AND confdeltype = 'n')
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.opening_wip') AND tgname = 'zz_same_org_job_id' AND NOT tgisinternal)
UNION ALL SELECT 'audit_support_mfa_triggers',
  (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = to_regclass('public.opening_wip') AND NOT t.tgisinternal
     AND ((t.tgname = 'audit_opening_wip_changes' AND p.proname = 'log_row_change')
       OR (t.tgname = 'support_read_only' AND p.proname = 'support_readonly_guard')
       OR (t.tgname = 'admin_mfa' AND p.proname = 'require_admin_mfa_guard'))) = 3
UNION ALL SELECT 'source_is_sliq_only',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.opening_wip') AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%source = ''sliq''%')
-- Nothing else reads it: no view, function or trigger outside the table's own refers to opening_wip.
UNION ALL SELECT 'nothing_reads_it',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'security_audit') AND p.prosrc LIKE '%opening_wip%')
  AND NOT EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND definition LIKE '%opening_wip%')
 LOOP
  IF checked.ok IS DISTINCT FROM true THEN RAISE EXCEPTION '141 rollback: reviewed shape differs, stop: %',checked.check_name; END IF;
 END LOOP;
END; $ca_rollback_verify$;
-- CA fail-closed rollback: the original owner file stays unchanged on its branch.
DO $ca_preserve_wip$
BEGIN
 IF to_regclass('public.opening_wip') IS NULL THEN RAISE EXCEPTION '141 rollback: table missing, stop and review'; END IF;
 IF EXISTS(SELECT 1 FROM public.opening_wip) THEN
  RAISE EXCEPTION '141 rollback refused: opening WIP exists; preserve import evidence and get a separate recovery decision';
 END IF;
END; $ca_preserve_wip$;

DROP TABLE IF EXISTS public.opening_wip;

DO $$
BEGIN
  IF to_regclass('public.opening_wip') IS NOT NULL THEN
    RAISE EXCEPTION '141 rollback: public.opening_wip is still there';
  END IF;
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION '141 rollback: the jobs table is missing';
  END IF;
END
$$;

COMMIT;
