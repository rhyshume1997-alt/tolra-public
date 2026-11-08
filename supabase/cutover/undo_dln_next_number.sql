-- CUTOVER OPERATIONS UNDO, only if the number set by set_dln_next_number.sql was wrong AND no DLN number has been taken since (no note
-- made, no number burnt by a failed save). Puts the counter back to what it was, puts release 147's hold back if the step lifted it (so no
-- note can be made until the step is run again), and records DLN_COUNTER_UNDONE (the audit log is
-- append-only: the original DLN_COUNTER_SET row stays). Refuses, changing nothing, otherwise. After the first note has a number this
-- must NOT be used: the numbers already on paper stand, and a correction is a forward-only re-run decision for Rhys.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -v company_slug=<slug> -f supabase/cutover/undo_dln_next_number.sql
\set ON_ERROR_STOP 1
BEGIN;
SELECT set_config('tolra_cutover.company_slug', :'company_slug', true) AS company_slug;
DO $dln_day_of_counter_undo$
DECLARE
  v_slug text := current_setting('tolra_cutover.company_slug', true);
  v_org  uuid;
  v_name text;
  v_last int;
  v_mark RECORD;
BEGIN
  SELECT id, name INTO v_org, v_name FROM public.organizations WHERE slug = v_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DLN undo refused: there is no company with slug "%". Nothing changed.', coalesce(v_slug, '');
  END IF;
  SELECT last INTO v_last FROM public.doc_counters WHERE organization_id = v_org AND prefix = 'DLN' FOR UPDATE;
  SELECT a.created_at, (a.old_data ->> 'last')::int AS old_last, (a.new_data ->> 'last')::int AS new_last, coalesce((a.old_data ->> 'held')::boolean, false) AS held INTO v_mark
  FROM security_audit.audit_log a WHERE a.organization_id = v_org AND a.entity_table = 'doc_counters' AND a.entity_id = v_org::text
    AND a.action IN ('DLN_COUNTER_SET', 'DLN_COUNTER_UNDONE') ORDER BY a.created_at DESC LIMIT 1;
  IF NOT FOUND OR v_mark.new_last IS NULL OR (SELECT action FROM security_audit.audit_log WHERE organization_id = v_org AND entity_table = 'doc_counters'
       AND entity_id = v_org::text AND action IN ('DLN_COUNTER_SET', 'DLN_COUNTER_UNDONE') ORDER BY created_at DESC LIMIT 1) <> 'DLN_COUNTER_SET' THEN
    RAISE EXCEPTION 'DLN undo refused: the step has not been run (or is already undone) for %. Nothing changed.', v_name;
  END IF;
  IF v_last IS DISTINCT FROM v_mark.new_last
     OR EXISTS (SELECT 1 FROM public.delivery_notes WHERE organization_id = v_org AND created_at >= v_mark.created_at) THEN
    RAISE EXCEPTION 'DLN undo refused: a number has already been taken for % since the step (counter %, set to %). It must not be undone. Nothing changed.', v_name, v_last, v_mark.new_last;
  END IF;
  UPDATE public.doc_counters SET last = v_mark.old_last WHERE organization_id = v_org AND prefix = 'DLN';
  -- Put release 147's hold back if the step lifted it, so no note can be made until the step is run again with the right number.
  IF v_mark.held AND to_regclass('public.dln_numbering_pending') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.dln_numbering_pending (organization_id) VALUES ($1) ON CONFLICT DO NOTHING' USING v_org;
  END IF;
  INSERT INTO security_audit.audit_log (organization_id, action, entity_table, entity_id, old_data, new_data, metadata)
  VALUES (v_org, 'DLN_COUNTER_UNDONE', 'doc_counters', v_org::text, jsonb_build_object('prefix', 'DLN', 'last', v_last),
          jsonb_build_object('prefix', 'DLN', 'last', v_mark.old_last),
          jsonb_build_object('source', 'cutover_operations', 'script', 'supabase/cutover/undo_dln_next_number.sql', 'db_user', current_user));
  RAISE NOTICE 'DLN undo done for %: counter % -> %.', v_name, v_last, v_mark.old_last;
END
$dln_day_of_counter_undo$;
COMMIT;
