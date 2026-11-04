-- CUTOVER OPERATIONS STEP, run ONCE on cutover day (C16 runbook). NOT a migration, NOT a release: it changes no schema, only one
-- company's DLN document counter, so the next delivery note is DLN-(John's last pad number + 1).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -v company_slug=<slug> -v last_pad_number=<John's last pad number> \
--        -f supabase/cutover/set_dln_next_number.sql
--
-- How numbers are taken (078 next_doc_number, used by create_delivery_note, by the no-order route of release 147 and by a hand-made
-- note without an invoice number): it upserts public.doc_counters (organization_id, 'DLN') to last + 1 (a row lock, so two creators
-- never get the same number), formats DLN- plus 4-digit zero padding below 10000 (DLN-0001, DLN-4522) and the plain number from 10000
-- (DLN-10000), and skips a number already on a note. This script sets that same row's `last` to the pad number, under the same row
-- lock, so a note being made at the same moment is either wholly before (and counted below) or after (and numbered from here).
--
-- Refuses, changing nothing (one transaction, RAISE EXCEPTION): a number that is not a whole number 1 to 999999999; a company slug that
-- does not exist; a counter that would go backwards or stay the same; any DLN-<digits> note in the company at or above the target; a
-- second run (the append-only audit row DLN_COUNTER_SET is the marker; only undo_dln_next_number.sql, before any number is taken, lifts it).
\set ON_ERROR_STOP 1
BEGIN;
SELECT set_config('tolra_cutover.dln_last_pad_number', :'last_pad_number', true) AS last_pad_number,
       set_config('tolra_cutover.company_slug', :'company_slug', true) AS company_slug;
DO $dln_day_of_counter$
DECLARE
  v_raw  text := current_setting('tolra_cutover.dln_last_pad_number', true);
  v_slug text := current_setting('tolra_cutover.company_slug', true);
  v_org  uuid;
  v_name text;
  v_n    int;
  v_old  int;
  v_high bigint;
  v_runs int;
  v_next text;
BEGIN
  IF v_raw IS NULL OR v_raw !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'DLN step refused: last pad number "%" is not a positive whole number (1 to 999999999, no leading zero). Nothing changed.', coalesce(v_raw, '');
  END IF;
  v_n := v_raw::int;
  SELECT id, name INTO v_org, v_name FROM public.organizations WHERE slug = v_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DLN step refused: there is no company with slug "%". Nothing changed.', coalesce(v_slug, '');
  END IF;

  -- The company's DLN counter row, locked as next_doc_number locks it.
  INSERT INTO public.doc_counters (organization_id, prefix, last) VALUES (v_org, 'DLN', 0) ON CONFLICT (organization_id, prefix) DO NOTHING;
  SELECT last INTO v_old FROM public.doc_counters WHERE organization_id = v_org AND prefix = 'DLN' FOR UPDATE;

  SELECT count(*) FILTER (WHERE action = 'DLN_COUNTER_SET') - count(*) FILTER (WHERE action = 'DLN_COUNTER_UNDONE') INTO v_runs
  FROM security_audit.audit_log WHERE organization_id = v_org AND entity_table = 'doc_counters' AND entity_id = v_org::text;
  IF v_runs > 0 THEN
    RAISE EXCEPTION 'DLN step refused: it has already been run for % (see security_audit.audit_log DLN_COUNTER_SET). Nothing changed.', v_name;
  END IF;
  IF v_old >= v_n THEN
    RAISE EXCEPTION 'DLN step refused: the counter for % is at %, so % would move it backwards or stay the same. Nothing changed.', v_name, v_old, v_n;
  END IF;
  SELECT max(substring(dn_number FROM '^DLN-(\d{1,12})$')::bigint) INTO v_high
  FROM public.delivery_notes WHERE organization_id = v_org AND dn_number ~ '^DLN-\d{1,12}$';
  IF v_high IS NOT NULL AND v_high >= v_n + 1 THEN
    RAISE EXCEPTION 'DLN step refused: % already has DLN-% (at or above the target %). Nothing changed.', v_name,
      CASE WHEN v_high < 10000 THEN lpad(v_high::text, 4, '0') ELSE v_high::text END, v_n + 1;
  END IF;

  UPDATE public.doc_counters SET last = v_n WHERE organization_id = v_org AND prefix = 'DLN';
  v_next := 'DLN-' || CASE WHEN v_n + 1 < 10000 THEN lpad((v_n + 1)::text, 4, '0') ELSE (v_n + 1)::text END;
  INSERT INTO security_audit.audit_log (organization_id, actor_email, action, entity_table, entity_id, old_data, new_data, metadata)
  VALUES (v_org, NULL, 'DLN_COUNTER_SET', 'doc_counters', v_org::text, jsonb_build_object('prefix', 'DLN', 'last', v_old),
          jsonb_build_object('prefix', 'DLN', 'last', v_n, 'next', v_next),
          jsonb_build_object('source', 'cutover_operations', 'script', 'supabase/cutover/set_dln_next_number.sql', 'last_pad_number', v_n,
                             'highest_existing_dln', v_high, 'db_user', current_user));
  RAISE NOTICE 'DLN step done for %: counter % -> %, next delivery note %.', v_name, v_old, v_n, v_next;
END
$dln_day_of_counter$;
COMMIT;
