-- CUTOVER OPERATIONS STEP, run ONCE on cutover day (C16 runbook). NOT a migration, NOT a release: it changes no schema, only one
-- company's DLN document counter, so the next delivery note is DLN-(John's last pad number + 1).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -v company_slug=<slug> -v last_pad_number=<John's last pad number> \
--        -f supabase/cutover/set_dln_next_number.sql
--
-- If John does NOT want to continue the pad series, Tolra starts at DLN-0001 only on an explicit, separate confirmation (the verifier signs):
--   ... -v last_pad_number=0 -v confirm_start_at_dln_0001='START AT DLN-0001' -f supabase/cutover/set_dln_next_number.sql
-- That is refused if any DLN note already exists or the counter has already moved. The confirmation is ignored for a positive number.
--
-- Release 147 holds every company that existed when it was installed (public.dln_numbering_pending): no delivery note can be made until
-- this step (or keep_dln_numbering.sql) has run. This step lifts the company's hold in the same transaction, and records whether it was held.
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
\if :{?confirm_start_at_dln_0001}
\else
\set confirm_start_at_dln_0001 ''
\endif
BEGIN;
SELECT set_config('tolra_cutover.dln_last_pad_number', :'last_pad_number', true) AS last_pad_number,
       set_config('tolra_cutover.company_slug', :'company_slug', true) AS company_slug,
       set_config('tolra_cutover.confirm_start_at_dln_0001', :'confirm_start_at_dln_0001', true) AS confirm_start_at_dln_0001;
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
  v_held boolean := false;
  v_conf text := current_setting('tolra_cutover.confirm_start_at_dln_0001', true);
BEGIN
  IF v_raw IS NULL OR v_raw !~ '^(0|[1-9][0-9]{0,8})$' THEN
    RAISE EXCEPTION 'DLN step refused: last pad number "%" is not a positive whole number (1 to 999999999, no leading zero). Nothing changed.', coalesce(v_raw, '');
  END IF;
  v_n := v_raw::int;
  IF v_n = 0 AND coalesce(v_conf, '') <> 'START AT DLN-0001' THEN
    RAISE EXCEPTION 'DLN step refused: 0 means not continuing the pad and starting at DLN-0001; that needs -v confirm_start_at_dln_0001=''START AT DLN-0001''. Nothing changed.';
  END IF;
  SELECT id, name INTO v_org, v_name FROM public.organizations WHERE slug = v_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DLN step refused: there is no company with slug "%". Nothing changed.', coalesce(v_slug, '');
  END IF;

  -- The company's DLN counter row, locked as next_doc_number locks it.
  INSERT INTO public.doc_counters (organization_id, prefix, last) VALUES (v_org, 'DLN', 0) ON CONFLICT (organization_id, prefix) DO NOTHING;
  SELECT last INTO v_old FROM public.doc_counters WHERE organization_id = v_org AND prefix = 'DLN' FOR UPDATE;

  SELECT count(*) FILTER (WHERE action IN ('DLN_COUNTER_SET', 'DLN_HOLD_RELEASED')) - count(*) FILTER (WHERE action = 'DLN_COUNTER_UNDONE') INTO v_runs
  FROM security_audit.audit_log WHERE organization_id = v_org AND entity_table = 'doc_counters' AND entity_id = v_org::text;
  IF v_runs > 0 THEN
    RAISE EXCEPTION 'DLN step refused: it has already been run for % (see security_audit.audit_log DLN_COUNTER_SET or DLN_HOLD_RELEASED). Nothing changed.', v_name;
  END IF;
  IF v_n = 0 AND v_old <> 0 THEN
    RAISE EXCEPTION 'DLN step refused: the counter for % is already at %, so it can''t start at DLN-0001. Nothing changed.', v_name, v_old;
  END IF;
  IF v_n > 0 AND v_old >= v_n THEN
    RAISE EXCEPTION 'DLN step refused: the counter for % is at %, so % would move it backwards or stay the same. Nothing changed.', v_name, v_old, v_n;
  END IF;
  SELECT max(substring(dn_number FROM '^DLN-(\d{1,12})$')::bigint) INTO v_high
  FROM public.delivery_notes WHERE organization_id = v_org AND dn_number ~ '^DLN-\d{1,12}$';
  IF v_high IS NOT NULL AND v_high >= v_n + 1 THEN
    RAISE EXCEPTION 'DLN step refused: % already has DLN-% (at or above the target %). Nothing changed.', v_name,
      CASE WHEN v_high < 10000 THEN lpad(v_high::text, 4, '0') ELSE v_high::text END, v_n + 1;
  END IF;

  UPDATE public.doc_counters SET last = v_n WHERE organization_id = v_org AND prefix = 'DLN';
  -- Lift release 147's hold for this company (absent table: 147 not installed, nothing to lift).
  IF to_regclass('public.dln_numbering_pending') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.dln_numbering_pending WHERE organization_id = $1' USING v_org;
    GET DIAGNOSTICS v_runs = ROW_COUNT;
    v_held := v_runs > 0;
  END IF;
  v_next := 'DLN-' || CASE WHEN v_n + 1 < 10000 THEN lpad((v_n + 1)::text, 4, '0') ELSE (v_n + 1)::text END;
  INSERT INTO security_audit.audit_log (organization_id, actor_email, action, entity_table, entity_id, old_data, new_data, metadata)
  VALUES (v_org, NULL, 'DLN_COUNTER_SET', 'doc_counters', v_org::text, jsonb_build_object('prefix', 'DLN', 'last', v_old, 'held', v_held),
          jsonb_build_object('prefix', 'DLN', 'last', v_n, 'next', v_next),
          jsonb_build_object('source', 'cutover_operations', 'script', 'supabase/cutover/set_dln_next_number.sql', 'last_pad_number', v_n,
                             'highest_existing_dln', v_high, 'start_at_dln_0001', v_n = 0, 'db_user', current_user));
  RAISE NOTICE 'DLN step done for %: counter % -> %, next delivery note %; delivery notes unlocked (was held: %).', v_name, v_old, v_n, v_next, v_held;
END
$dln_day_of_counter$;
COMMIT;
