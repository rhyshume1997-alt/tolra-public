-- CUTOVER OPERATIONS STEP (PREPARED, NOT RUN ON PRODUCTION). Not a migration, not a release: it changes no schema.
-- Wipes the OPERATIONAL records of the named companies, deletes one named empty company, and removes named test members.
-- It is ONE statement batch = ONE transaction: any refusal or error undoes everything. Set p.dry_run = true to run all of it and then roll back
-- (the result is shown in the error text). Run it only after: a rehearsal on the scratch database, a backup export of both companies, a
-- reviewer's SAFE, and the owner's explicit yes with the row counts below. Nothing in here is run by the app.
--
-- OWNER DECISIONS (Rhys, 26 Nov 10:36): the live company's own 2 audit rows are deleted so it is fully deleted (allow_audit_row_delete = true);
-- counters are reset for QUO, J, INV, SO, PO and CRD to 0 for the two wiped companies (counters = 'reset'; DLN counter and hold untouched);
-- storage files of the wiped rows are removed by the separate step in wipe_storage_step.md AFTER this SQL has run.
--
-- WHAT IT DOES (in this order, inside the transaction)
--  0. Refuses unless: p.confirm = 'WIPE OPERATIONAL DATA'; every named company/user exists; the live row counts of the key tables EQUAL p.expected
--     (the counts the owner approved); every table with an organization_id column is classified below (a new table = refusal, never silent);
--     the two kept admins are active admins of both wiped companies; no kept user is also in the delete list.
--  1. Wipes (rows of p.wipe_orgs only) the WIPE list: customers, suppliers, RFQs, quotes (+ lines, attachments), sales orders (+ lines),
--     jobs and everything hanging off a job, machines, stock, delivery notes, purchase orders, invoices (+ lines, payments, credit notes,
--     credits), reminder sends, e-mail history, imports, archive state, owed-snapshots. Child-first (FK order worked out at run time).
--     The row-level "immutable/issued lock" guard triggers on those tables are switched off for the transaction and switched back on before
--     it ends (the list is recorded and re-checked). The audit triggers, support read-only and admin-MFA guards stay ON. The FK triggers stay ON.
--  2. Document counters: p.counters = 'reset' sets last = 0 for every prefix EXCEPT DLN; 'keep' changes nothing. DLN (and the DLN numbering
--     hold) are NEVER touched here: use supabase/cutover/set_dln_next_number.sql / keep_dln_numbering.sql.
--  3. Members: removes the named test users' membership rows in the wiped companies; deletes their auth user ONLY if they then belong to no
--     company. Refuses if any other table still points at such a user with RESTRICT / NO ACTION. (created_by style SET NULL links are fine.)
--  4. Deletes the named empty company. security_audit.audit_log is append-only (trigger) and has a NO ACTION link to organizations, so a company
--     that has audit rows cannot be deleted without deleting them. That is allowed ONLY with p.allow_audit_row_delete = true (the owner's
--     explicit yes): the rows are listed in the result first, and only that company's rows go (its hash chain is its own).
--  5. Writes one DATA_WIPE audit row per wiped company (counts), and checks the KEPT tables are unchanged (row counts, and the settings row
--     including hidden_nav is byte-identical). Anything off = exception = nothing happened.
-- KEPT: users, members (except the named ones), organization_settings (incl. hidden_nav ui-*-v2 markers), company details, e-mail templates and
-- schedules, integration setup/secrets/connections, costing defaults, time and site-network settings, clock-in records, audit logs, chase steps,
-- inspector authorisations, import mappings, platform issues, DLN counter and hold, user profiles of kept users.
-- STORAGE FILES (job drawings/photos) are not touched by SQL: the Storage API step is separate (see the plan).
CREATE OR REPLACE FUNCTION pg_temp.tolra_wipe(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $wipe$
DECLARE
  v_wipe_orgs   uuid[] := ARRAY(SELECT jsonb_array_elements_text(p->'wipe_orgs'))::uuid[];
  v_delete_org  uuid   := NULLIF(p->>'delete_org', '')::uuid;
  v_del_users   uuid[] := ARRAY(SELECT jsonb_array_elements_text(p->'delete_users'))::uuid[];
  v_keep_admins uuid[] := ARRAY(SELECT jsonb_array_elements_text(p->'keep_admins'))::uuid[];
  v_dry         boolean := coalesce((p->>'dry_run')::boolean, true);
  v_allow_audit boolean := coalesce((p->>'allow_audit_row_delete')::boolean, false);
  v_counters    text    := coalesce(p->>'counters', 'keep');
  v_wipe text[] := ARRAY['quote_attachments','quote_line_items','quotes','rfqs','sales_order_line_machines','sales_order_lines','sales_orders',
    'job_cost_declarations','job_cost_snapshots','job_costing_machine_links','job_files','job_flow_events','job_inspections','job_machines','job_part_logs',
    'job_problems','job_rework_entry_values','job_rework_entries','job_rework','job_signoffs','job_values','labour_ops','machine_bookings','machine_run_ops',
    'machine_runs','machines','operator_sessions','paused_ack_ops','jobs','delivery_note_items','delivery_notes','purchase_orders','invoice_credit_allocations',
    'invoice_payments','invoice_line_items','invoice_queue_events','invoice_job_finish_legacy','invoice_notes_legacy','invoices','credit_note_lines','credit_notes',
    'customer_credit_ledger','customers','suppliers','stock','opening_wip','record_archive_state','document_attachments','email_history','inbound_emails',
    'chase_pauses','chase_sends','import_batches','import_record_keys','import_runs','import_source_batches','import_source_rows','import_stage',
    'reopen_requests','overview_owed_snapshots'];
  -- every other table with an organization_id column; SPECIAL ones are handled by their own step.
  v_keep text[] := ARRAY['ai_helper_requests','ai_helper_secrets','ai_helper_settings','ai_helper_tolra_companies','ai_helper_usage','attendance_event_network_ips',
    'attendance_event_networks','attendance_events','chase_steps','clock_in_network_exemptions','clock_in_network_locks','clock_in_network_refusals',
    'clock_in_network_unverified','company_setup_progress','costing_defaults','costing_machines','costing_materials','dln_numbering_pending','email_schedules',
    'email_templates','import_mappings','inspector_authorisations','integration_connect_invites','integration_connections',
    'integration_contacts','iso_document_versions','integration_mailbox_sync','integration_mappings','integration_oauth_states','integration_secrets','integration_sends','issues',
    'job_costing_settings','legacy_audit_log','mail_poll_state','organization_invites','organization_settings','site_network_members','site_network_names',
    'site_network_ops','site_network_settings','site_networks','time_day_flag_ops','time_day_flags','time_settings','time_sync_rejections','time_week_approvals',
    'user_profiles','xero_send_release','xero_transfer_hold'];
  v_special text[] := ARRAY['doc_counters','organization_members'];
  v_expected jsonb := p->'expected';
  t text; o uuid; n bigint; nxt text; k text; r record;
  v_res jsonb := '{}'::jsonb; v_before jsonb := '{}'::jsonb; v_after jsonb := '{}'::jsonb; v_disabled jsonb := '[]'::jsonb;
  v_settings_before text; v_settings_after text; v_audit_rows jsonb; v_removed_users jsonb := '[]'::jsonb; v_kept_users jsonb := '[]'::jsonb;
  v_reminders bigint := 0; v_i int;
BEGIN
  IF coalesce(p->>'confirm', '') <> 'WIPE OPERATIONAL DATA' THEN RAISE EXCEPTION 'wipe refused: confirm must be WIPE OPERATIONAL DATA. Nothing changed.'; END IF;
  IF cardinality(v_wipe_orgs) = 0 THEN RAISE EXCEPTION 'wipe refused: no companies named. Nothing changed.'; END IF;
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = o) THEN RAISE EXCEPTION 'wipe refused: company % does not exist. Nothing changed.', o; END IF;
  END LOOP;
  IF v_delete_org IS NOT NULL AND (v_delete_org = ANY(v_wipe_orgs) OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_delete_org)) THEN
    RAISE EXCEPTION 'wipe refused: the company to delete is missing or is also in the wipe list. Nothing changed.'; END IF;
  IF v_del_users && v_keep_admins THEN RAISE EXCEPTION 'wipe refused: a kept admin is also in the delete list. Nothing changed.'; END IF;

  -- 0a. every table with organization_id is classified
  FOR r IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
           WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' LOOP
    IF NOT (r.table_name = ANY(v_wipe) OR r.table_name = ANY(v_keep) OR r.table_name = ANY(v_special)) THEN
      RAISE EXCEPTION 'wipe refused: table public.% has an organization_id and is not classified in this script. Nothing changed.', r.table_name; END IF;
  END LOOP;
  -- 0b. kept admins are active admins of every wiped company
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    FOREACH k IN ARRAY ARRAY(SELECT unnest(v_keep_admins)::text) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = o AND user_id = k::uuid AND role = 'admin' AND active) THEN
        RAISE EXCEPTION 'wipe refused: user % is not an active admin of company %. Nothing changed.', k, o; END IF;
    END LOOP;
  END LOOP;
  -- 0c. counts equal what the owner approved: { "<org uuid>": { "customers": 9, ... } }
  IF v_expected IS NULL THEN RAISE EXCEPTION 'wipe refused: p.expected (the approved row counts) is required. Nothing changed.'; END IF;
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    IF v_expected -> o::text IS NULL THEN RAISE EXCEPTION 'wipe refused: p.expected has no counts for company %. Nothing changed.', o; END IF;
    FOR r IN SELECT key AS tbl, value::text::bigint AS want FROM jsonb_each(v_expected -> o::text) LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', r.tbl) INTO n USING o;
      IF n <> r.want THEN RAISE EXCEPTION 'wipe refused: % in company % has % rows, approved % . Nothing changed.', r.tbl, o, n, r.want; END IF;
    END LOOP;
  END LOOP;

  -- 0d. snapshot of the KEPT tables (row counts per company) and the settings rows
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    FOREACH t IN ARRAY v_keep LOOP
      IF to_regclass('public.' || t) IS NOT NULL AND t <> 'user_profiles' THEN
        EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', t) INTO n USING o;
        v_before := v_before || jsonb_build_object(o::text || '/' || t, n);
      END IF;
    END LOOP;
  END LOOP;
  SELECT coalesce(string_agg(md5(row_to_json(s)::text), ',' ORDER BY s.organization_id), '') INTO v_settings_before FROM public.organization_settings s WHERE s.organization_id = ANY(v_wipe_orgs);

  -- 1. switch off the row-level immutability / issued-lock guards on the WIPE tables (audit, support read-only and admin-MFA guards stay on)
  FOR r IN SELECT c.relname AS tbl, g.tgname AS trig, g.tgenabled AS en
           FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
           JOIN pg_proc f ON f.oid = g.tgfoid
           WHERE NOT g.tgisinternal AND c.relname = ANY(v_wipe) AND g.tgenabled <> 'D'
             AND f.proname NOT IN ('support_readonly_guard', 'require_admin_mfa_guard', 'log_row_change') LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', r.tbl, r.trig);
    v_disabled := v_disabled || jsonb_build_object('table', r.tbl, 'trigger', r.trig, 'was', r.en);
  END LOOP;

  -- 1b. delete child-first
  CREATE TEMP TABLE IF NOT EXISTS _w (tname text PRIMARY KEY, done boolean NOT NULL DEFAULT false) ON COMMIT DROP;
  DELETE FROM _w;
  INSERT INTO _w SELECT x, false FROM unnest(v_wipe) x WHERE to_regclass('public.' || x) IS NOT NULL;
  IF to_regclass('public.invoice_reminder_sends') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.invoice_reminder_sends s WHERE s.invoice_id IN (SELECT id FROM public.invoices WHERE organization_id = ANY($1))' INTO v_reminders USING v_wipe_orgs;
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS _broken (conid oid PRIMARY KEY) ON COMMIT DROP;
  DELETE FROM _broken;
  LOOP
    SELECT w.tname INTO nxt FROM _w w WHERE NOT w.done AND NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid AND cl.relnamespace = 'public'::regnamespace JOIN _w ch ON ch.tname = cl.relname
      WHERE c.contype = 'f' AND c.confrelid = ('public.' || w.tname)::regclass AND c.conrelid <> c.confrelid AND NOT ch.done
        AND c.oid NOT IN (SELECT conid FROM _broken)) LIMIT 1;
    IF nxt IS NULL THEN
      EXIT WHEN NOT EXISTS (SELECT 1 FROM _w WHERE NOT done);
      -- a foreign-key cycle (for example quotes <-> RFQs <-> sales orders <-> jobs): everything here is being deleted anyway, so the
      -- NULLABLE links inside the cycle are set to NULL first (the guard triggers on these tables are already off), then the order resolves.
      n := 0;
      FOR r IN SELECT c.oid AS cid, cl.relname AS child,
                      (SELECT string_agg(format('%I = NULL', a.attname), ', ') FROM unnest(c.conkey) kk JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = kk) AS setlist
               FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid AND cl.relnamespace = 'public'::regnamespace
               JOIN _w ch ON ch.tname = cl.relname AND NOT ch.done
               JOIN pg_class pl ON pl.oid = c.confrelid JOIN _w pa ON pa.tname = pl.relname AND NOT pa.done
               WHERE c.contype = 'f' AND c.conrelid <> c.confrelid AND c.oid NOT IN (SELECT conid FROM _broken)
                 AND NOT EXISTS (SELECT 1 FROM unnest(c.conkey) kk JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = kk WHERE a.attnotnull) LOOP
        EXECUTE format('UPDATE public.%I SET %s WHERE organization_id = ANY($1)', r.child, r.setlist) USING v_wipe_orgs;
        INSERT INTO _broken VALUES (r.cid);
        n := n + 1;
      END LOOP;
      IF n = 0 THEN EXIT; END IF;
      CONTINUE;
    END IF;
    FOREACH o IN ARRAY v_wipe_orgs LOOP
      EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', nxt) USING o;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        v_res := jsonb_set(v_res, ARRAY[o::text], coalesce(v_res -> o::text, '{}'::jsonb), true);
        v_res := jsonb_set(v_res, ARRAY[o::text, nxt], to_jsonb(n), true);
      END IF;
    END LOOP;
    UPDATE _w SET done = true WHERE tname = nxt;
  END LOOP;
  IF EXISTS (SELECT 1 FROM _w WHERE NOT done) THEN RAISE EXCEPTION 'wipe refused: foreign-key cycle among %. Nothing changed.', (SELECT string_agg(tname, ',') FROM _w WHERE NOT done); END IF;
  -- everything must now be empty for the wiped companies
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    FOR r IN SELECT tname FROM _w LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', r.tname) INTO n USING o;
      IF n <> 0 THEN RAISE EXCEPTION 'wipe failed: % still has % rows for %. Nothing changed.', r.tname, n, o; END IF;
    END LOOP;
  END LOOP;

  -- 2. counters (DLN never touched)
  IF v_counters = 'reset' THEN
    UPDATE public.doc_counters SET last = 0 WHERE organization_id = ANY(v_wipe_orgs) AND prefix <> 'DLN';
  ELSIF v_counters <> 'keep' THEN RAISE EXCEPTION 'wipe refused: counters must be reset or keep. Nothing changed.'; END IF;

  -- 3. members and users
  IF cardinality(v_del_users) > 0 THEN
    DELETE FROM public.organization_members WHERE organization_id = ANY(v_wipe_orgs) AND user_id = ANY(v_del_users);
    FOR r IN SELECT u AS uid FROM unnest(v_del_users) u LOOP
      IF EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = r.uid) THEN
        v_kept_users := v_kept_users || to_jsonb(r.uid::text);
      ELSIF EXISTS (SELECT 1 FROM auth.users WHERE id = r.uid) THEN
        DELETE FROM auth.users WHERE id = r.uid;  -- FK: any RESTRICT / NO ACTION reference aborts the whole run
        v_removed_users := v_removed_users || to_jsonb(r.uid::text);
      END IF;
    END LOOP;
  END IF;

  -- 4. the empty company
  IF v_delete_org IS NOT NULL THEN
    FOR r IN SELECT c.relname AS tbl FROM information_schema.columns x JOIN pg_class c ON c.relname = x.table_name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
             WHERE x.table_schema = 'public' AND x.column_name = 'organization_id' AND x.table_name NOT IN ('organization_members','organization_settings','overview_owed_snapshots') LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', r.tbl) INTO n USING v_delete_org;
      IF n <> 0 THEN RAISE EXCEPTION 'wipe refused: the company to delete still has % rows in %. Nothing changed.', n, r.tbl; END IF;
    END LOOP;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'action', action, 'actor', actor_user_id, 'hash', hash)), '[]'::jsonb) INTO v_audit_rows FROM security_audit.audit_log WHERE organization_id = v_delete_org;
    IF jsonb_array_length(v_audit_rows) > 0 THEN
      IF NOT v_allow_audit THEN RAISE EXCEPTION 'wipe refused: the company to delete has % append-only audit rows; needs allow_audit_row_delete = true (owner decision). Nothing changed.', jsonb_array_length(v_audit_rows); END IF;
      ALTER TABLE security_audit.audit_log DISABLE TRIGGER audit_log_prevent_mutation;
      DELETE FROM security_audit.audit_log WHERE organization_id = v_delete_org;
      ALTER TABLE security_audit.audit_log ENABLE TRIGGER audit_log_prevent_mutation;
    END IF;
    DELETE FROM public.organizations WHERE id = v_delete_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'wipe failed: company delete removed % rows. Nothing changed.', n; END IF;
    v_res := v_res || jsonb_build_object('deleted_company', v_delete_org, 'audit_rows_removed', coalesce(v_audit_rows, '[]'::jsonb));
  END IF;

  -- 5. switch the guards back on, verify, audit
  FOR r IN SELECT x->>'table' AS tbl, x->>'trigger' AS trig FROM jsonb_array_elements(v_disabled) x LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', r.tbl, r.trig);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgenabled = 'D' AND c.relnamespace IN ('public'::regnamespace, 'security_audit'::regnamespace)) THEN
    RAISE EXCEPTION 'wipe failed: a trigger is still disabled. Nothing changed.'; END IF;
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    FOREACH t IN ARRAY v_keep LOOP
      IF to_regclass('public.' || t) IS NOT NULL AND t <> 'user_profiles' THEN
        EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', t) INTO n USING o;
        IF n <> (v_before ->> (o::text || '/' || t))::bigint THEN RAISE EXCEPTION 'wipe failed: kept table % changed for %. Nothing changed.', t, o; END IF;
      END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY(SELECT unnest(v_keep_admins)::text) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = o AND user_id = k::uuid AND role = 'admin' AND active) THEN
        RAISE EXCEPTION 'wipe failed: kept admin % lost admin on %. Nothing changed.', k, o; END IF;
    END LOOP;
  END LOOP;
  SELECT coalesce(string_agg(md5(row_to_json(s)::text), ',' ORDER BY s.organization_id), '') INTO v_settings_after FROM public.organization_settings s WHERE s.organization_id = ANY(v_wipe_orgs);
  IF v_settings_after IS DISTINCT FROM v_settings_before THEN RAISE EXCEPTION 'wipe failed: organization_settings changed. Nothing changed.'; END IF;
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    INSERT INTO security_audit.audit_log (organization_id, action, entity_table, entity_id, new_data, metadata)
    VALUES (o, 'DATA_WIPE', 'public', 'operational', coalesce(v_res -> o::text, '{}'::jsonb),
            jsonb_build_object('script', 'supabase/cutover/wipe_operational_data.sql', 'counters', v_counters, 'db_user', current_user, 'dry_run', v_dry));
  END LOOP;
  v_res := v_res || jsonb_build_object('invoice_reminder_sends_cascaded', v_reminders, 'guards_switched_off_then_on', jsonb_array_length(v_disabled),
                                       'users_deleted', v_removed_users, 'users_kept_other_company', v_kept_users, 'counters', v_counters, 'dry_run', v_dry);
  IF v_dry THEN RAISE EXCEPTION 'DRY RUN, rolled back. Result: %', v_res::text; END IF;
  RETURN v_res;
END
$wipe$;
-- RUN (replace the JSON; for production the owner approves the exact numbers first):
-- SELECT pg_temp.tolra_wipe('{"confirm":"WIPE OPERATIONAL DATA","dry_run":true,"wipe_orgs":["<jnr>","<marpet>"],"delete_org":"<live>","delete_users":["<u1>","<u2>","<u3>"],
--   "keep_admins":["<rhys>","<john>"],"counters":"reset","allow_audit_row_delete":false,"expected":{"<jnr>":{"customers":9,"suppliers":9,...},"<marpet>":{...}}}'::jsonb);
