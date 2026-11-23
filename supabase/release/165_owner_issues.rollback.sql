-- Rollback of post-144 release step 165 (supabase/release/165_owner_issues.release.sql). Drops ONLY what 165 created: the three functions
-- (raise_issue, platform_list_issues, platform_update_issue) and the two tables (public.issues, public.issue_owner_notes, with their policy,
-- indexes and constraints). The database is then exactly as before 165. After it the app's Raise an issue button and the owner inbox cannot
-- save or load until 165 is applied again (turn both switches off first if rolling back a live system).
-- IT DELETES DATA: every issue and every private owner note is lost. It therefore REFUSES while either table holds a row, unless the runner
-- first says, in the same session, that deleting them is accepted:
--     SET tolra.x165_accept_deleting_issues = 'yes';
-- It also refuses if the objects are not 165's (a function of another body or security): compare them first, nothing is changed.
-- The self-check compares the same fingerprint as the release (every other function with grants, every other table, policy and trigger)
-- before and after, and requires the five objects gone. Inputs: the database. Outputs: five objects removed. Must not change: anything else.
-- Production only with Rhys's separate yes.
BEGIN;
DO $rollback_guard$
BEGIN
 IF to_regclass('public.issues') IS NOT NULL OR to_regclass('public.issue_owner_notes') IS NOT NULL THEN
  IF coalesce(current_setting('tolra.x165_accept_deleting_issues', TRUE), '') <> 'yes'
     AND (EXISTS (SELECT 1 FROM public.issues) OR (to_regclass('public.issue_owner_notes') IS NOT NULL AND EXISTS (SELECT 1 FROM public.issue_owner_notes))) THEN
   RAISE EXCEPTION '165 rollback refused: issues or owner notes exist; rolling back deletes them. SET tolra.x165_accept_deleting_issues = ''yes'' first if that is accepted.';
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('raise_issue', 'platform_list_issues', 'platform_update_issue')
              AND NOT (p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) IN ('393e29b3c90ca0a4407ebe40a54b924f', '98e13a0f91183696ec04341659749cfc', 'bca6425ea57393a49841fc343f0a435e'))) THEN
  RAISE EXCEPTION '165 rollback: a function of 165''s name is not 165''s (body, security or search_path differ); stop and compare it first, nothing was changed';
 END IF;
END $rollback_guard$;

CREATE FUNCTION pg_temp.p165_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p165fp$
  SELECT 'every other function (name, args, security, config, body, grants)'::TEXT,
         md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), p.prosecdef::TEXT, coalesce(p.proconfig::TEXT, ''), md5(p.prosrc), coalesce(p.proacl::TEXT, ''))), '' ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), ''))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND NOT (n.nspname = 'public' AND p.proname IN ('raise_issue', 'platform_list_issues', 'platform_update_issue'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 'every other table in public (names, row security, grants)',
         md5(coalesce(string_agg(concat_ws('|', c.relname, c.relrowsecurity::TEXT, coalesce(c.relacl::TEXT, '')), ';' ORDER BY c.relname), ''))
  FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname NOT IN ('issues', 'issue_owner_notes')
  UNION ALL SELECT 'every other policy',
         md5(coalesce(string_agg(concat_ws('|', p.schemaname, p.tablename, p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, '')), ';' ORDER BY p.schemaname, p.tablename, p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE NOT (p.schemaname = 'public' AND p.tablename IN ('issues', 'issue_owner_notes'))
  UNION ALL SELECT 'every other trigger',
         md5(coalesce(string_agg(concat_ws('|', t.tgrelid::regclass::TEXT, t.tgname, t.tgenabled::TEXT), ';' ORDER BY t.tgrelid::regclass::TEXT, t.tgname), ''))
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid::regclass::TEXT NOT IN ('public.issues', 'public.issue_owner_notes')
$p165fp$;
CREATE TEMP TABLE p165_before ON COMMIT DROP AS SELECT * FROM pg_temp.p165_fingerprint();

DROP FUNCTION IF EXISTS public.raise_issue(TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.platform_list_issues(UUID, TEXT, BOOLEAN, INTEGER);
DROP FUNCTION IF EXISTS public.platform_update_issue(UUID, TEXT, TEXT, TEXT);
DROP TABLE IF EXISTS public.issue_owner_notes;
DROP TABLE IF EXISTS public.issues;

DO $rollback_self_check$
BEGIN
  IF to_regclass('public.issues') IS NOT NULL OR to_regclass('public.issue_owner_notes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('raise_issue', 'platform_list_issues', 'platform_update_issue')) THEN
    RAISE EXCEPTION '165 rollback self-check: a 165 object is still there';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p165_before EXCEPT SELECT * FROM pg_temp.p165_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p165_fingerprint() EXCEPT SELECT * FROM pg_temp.p165_before) THEN
    RAISE EXCEPTION '165 rollback self-check: another function, table, policy or trigger changed';
  END IF;
END
$rollback_self_check$;
DROP TABLE pg_temp.p165_before;
DROP FUNCTION pg_temp.p165_fingerprint();
COMMIT;
