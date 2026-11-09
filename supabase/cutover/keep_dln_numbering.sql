-- CUTOVER OPERATIONS STEP for a company that ALREADY numbers its delivery notes in Tolra and keeps that series (for example another live
-- company on the same database when release 147 is installed). NOT for JNR's pad continuation: that is set_dln_next_number.sql.
-- Release 147 holds every company that existed when it was installed; this lifts the hold for ONE company and leaves its DLN counter
-- exactly as it is. Refuses, changing nothing: unknown company; company not held; missing or wrong confirmation.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -v company_slug=<slug> -v confirm_keep='KEEP CURRENT DLN NUMBERING' \
--        -f supabase/cutover/keep_dln_numbering.sql
\set ON_ERROR_STOP 1
BEGIN;
SELECT set_config('tolra_cutover.company_slug', :'company_slug', true) AS company_slug,
       set_config('tolra_cutover.confirm_keep', :'confirm_keep', true) AS confirm_keep;
DO $dln_keep_numbering$
DECLARE
  v_slug text := current_setting('tolra_cutover.company_slug', true);
  v_conf text := current_setting('tolra_cutover.confirm_keep', true);
  v_org  uuid;
  v_name text;
  v_last int;
  v_n    int;
BEGIN
  IF coalesce(v_conf, '') <> 'KEEP CURRENT DLN NUMBERING' THEN
    RAISE EXCEPTION 'DLN keep refused: needs -v confirm_keep=''KEEP CURRENT DLN NUMBERING''. Nothing changed.';
  END IF;
  SELECT id, name INTO v_org, v_name FROM public.organizations WHERE slug = v_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DLN keep refused: there is no company with slug "%". Nothing changed.', coalesce(v_slug, '');
  END IF;
  IF to_regclass('public.dln_numbering_pending') IS NULL THEN
    RAISE EXCEPTION 'DLN keep refused: release 147 is not installed, so there is no hold to lift. Nothing changed.';
  END IF;
  SELECT last INTO v_last FROM public.doc_counters WHERE organization_id = v_org AND prefix = 'DLN' FOR UPDATE;
  EXECUTE 'DELETE FROM public.dln_numbering_pending WHERE organization_id = $1' USING v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'DLN keep refused: % is not held (its numbering is already set or it was made after release 147). Nothing changed.', v_name;
  END IF;
  INSERT INTO security_audit.audit_log (organization_id, action, entity_table, entity_id, old_data, new_data, metadata)
  VALUES (v_org, 'DLN_HOLD_RELEASED', 'doc_counters', v_org::text, jsonb_build_object('prefix', 'DLN', 'last', v_last, 'held', true),
          jsonb_build_object('prefix', 'DLN', 'last', v_last, 'held', false),
          jsonb_build_object('source', 'cutover_operations', 'script', 'supabase/cutover/keep_dln_numbering.sql', 'db_user', current_user));
  RAISE NOTICE 'DLN keep done for %: hold lifted, counter left at %.', v_name, coalesce(v_last::text, 'none (next DLN-0001)');
END
$dln_keep_numbering$;
COMMIT;
