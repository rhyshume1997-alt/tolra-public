-- CUTOVER OPERATIONS STEP (PREPARED, NOT RUN ON PRODUCTION). v2, after the reviewer's 11 points (26 Nov). Not a migration, not a release: no schema change.
-- Wipes the OPERATIONAL records of the named companies, deletes one named empty company, removes named test members. ONE statement batch = ONE transaction:
-- any refusal or error undoes everything. p.dry_run = true runs all of it and rolls back (the full report is in the error text).
-- Run only after: scratch rehearsal on the synthetic AND the production-shaped copy, a backup export (restore-checked), a reviewer's SAFE, and the owner's
-- explicit yes with the counts. See wipe_operational_data.PLAN.md (maintenance window, order, rollback) and wipe_storage_step.md (Storage, after the SQL).
--
-- WHAT CHANGED IN v2 (reviewer points)
--  1  Triggers: no more "disable everything except 3". Exactly the reviewed allowlist v_trigger_allow (8 delete-time guards/side-effects that refuse the owner role
--     or write other rows) is disabled; the 13 other delete-time guards are listed in v_trigger_leave and stay ENABLED (they pass through for non-browser roles; the
--     script refuses to run as anon/authenticated). Any other delete-firing trigger on a wipe table = refusal. Cycle-breaking UPDATEs are gone (cyclic tables are
--     deleted in ONE statement with data-modifying CTEs, FK checks run at the end of the statement), so no update trigger is touched. Every disabled trigger is
--     re-enabled and asserted back to its original state.
--  2  Counts: every wipe table, every company: before count, after count (must be 0), printed in full in the report.
--  3  FK / cascade guard from the real schema (inventory: supabase/cutover/wipe-evidence/): any CASCADE / SET NULL / SET DEFAULT FK from a table outside the wipe
--     list into a wipe table must be in v_fk_reviewed (only invoice_reminder_sends); anything else = refusal.
--  4  Retained tables are compared BEFORE and AFTER by row identity and hash (not counts): every KEPT table, members, user profiles, the DLN counter and hold,
--     and the audit rows that already existed. User ids are masked, so rows that only lost a deleted user's link (SET NULL) still compare equal; rows that belong
--     to a deleted user via CASCADE are the expected removals and are reported.
--  5  Users: each {id, email} must match auth.users exactly, belong to no company outside the wipe list, and every reference to them is counted before and after.
--  6  Live company: its audit rows must be exactly the approved ids, with a verified hash chain, listed in the report; the audit guard is re-enabled and asserted.
--  7  Concurrency: the wipe tables (and the retained tables read for comparison) are locked SHARE ROW EXCLUSIVE with a 10 s lock timeout before the counts are
--     checked, so nothing can be written between the check and the delete. Also run in the maintenance window in the PLAN.
--  8  Counters: only the approved prefixes QUO, J, INV, SO, PO, CRD for the named companies (explicit names); DLN and every other prefix are compared by hash.
-- Owner decisions (Rhys, 26 Nov 10:36): live company audit rows deleted; counters reset to 0 (Rhys to confirm no real document from these records was ever sent
-- to a customer or accountant); storage files removed after the SQL by the exact list in wipe_storage_step.md.
-- KEPT: users, members (except the named), organization_settings (incl. hidden_nav), company details, templates, integrations, costing defaults, time and
-- site-network settings, clock-ins, audit logs, chase steps, inspector authorisations, import mappings, platform issues, DLN counter and hold.

CREATE OR REPLACE FUNCTION pg_temp.wipe_digest(p_tbl text, p_orgs uuid[], p_users text[]) RETURNS text LANGUAGE plpgsql AS $d$
DECLARE v_cols text[]; v_cond text := 'true'; v_sql text; v_out text;
BEGIN
  -- columns that point at auth.users with ON DELETE CASCADE: those rows are the expected removals and are left out of the comparison
  SELECT coalesce(array_agg(a.attname::text), ARRAY[]::text[]) INTO v_cols
  FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass AND c.confdeltype = 'c' AND c.conrelid = ('public.' || p_tbl)::regclass AND array_length(c.conkey, 1) = 1;
  IF cardinality(v_cols) > 0 THEN
    v_cond := 'NOT (' || (SELECT string_agg(format('coalesce(s.j ->> %L, '''') = ANY($2)', cn), ' OR ') FROM unnest(v_cols) cn) || ')';
  END IF;
  v_sql := format($q$SELECT coalesce(md5(string_agg(s.m, E'\n' ORDER BY s.m)), '-') || ':' || count(*) FROM (
      SELECT to_jsonb(x) AS j,
             (SELECT jsonb_object_agg(e.key, CASE WHEN (e.value #>> '{}') = ANY($2) THEN 'null'::jsonb ELSE e.value END) FROM jsonb_each(to_jsonb(x)) e)::text AS m
      FROM public.%I x WHERE x.organization_id = ANY($1)) s WHERE %s$q$, p_tbl, v_cond);
  EXECUTE v_sql INTO v_out USING p_orgs, p_users;
  RETURN v_out;
END $d$;

CREATE OR REPLACE FUNCTION pg_temp.tolra_wipe(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $wipe$
DECLARE
  v_wipe_orgs   uuid[] := ARRAY(SELECT jsonb_array_elements_text(p->'wipe_orgs'))::uuid[];
  v_delete_org  uuid   := NULLIF(p->>'delete_org', '')::uuid;
  v_org_audit   uuid[] := ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'delete_org_audit_ids', '[]'::jsonb)))::uuid[];
  v_del_users   uuid[] := ARRAY(SELECT x->>'id' FROM jsonb_array_elements(coalesce(p->'delete_users', '[]'::jsonb)) x)::uuid[];
  v_del_text    text[] := ARRAY(SELECT x->>'id' FROM jsonb_array_elements(coalesce(p->'delete_users', '[]'::jsonb)) x);
  v_keep_admins uuid[] := ARRAY(SELECT jsonb_array_elements_text(p->'keep_admins'))::uuid[];
  v_dry         boolean := coalesce((p->>'dry_run')::boolean, true);
  v_allow_audit boolean := coalesce((p->>'allow_audit_row_delete')::boolean, false);
  v_counters    text    := coalesce(p->>'counters', 'keep');
  v_prefixes    text[]  := ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'counter_prefixes', '[]'::jsonb)));
  v_prefix_ok   CONSTANT text[] := ARRAY['QUO','J','INV','SO','PO','CRD'];
  v_wipe text[] := ARRAY['quote_attachments','quote_line_items','quotes','rfqs','sales_order_line_machines','sales_order_lines','sales_orders',
    'job_cost_declarations','job_cost_snapshots','job_costing_machine_links','job_files','job_flow_events','job_inspections','job_machines','job_part_logs',
    'job_problems','job_rework_entry_values','job_rework_entries','job_rework','job_signoffs','job_values','labour_ops','machine_bookings','machine_run_ops',
    'machine_runs','machines','operator_sessions','paused_ack_ops','jobs','delivery_note_items','delivery_notes','purchase_orders','invoice_credit_allocations',
    'invoice_payments','invoice_line_items','invoice_queue_events','invoice_job_finish_legacy','invoice_notes_legacy','invoices','credit_note_lines','credit_notes',
    'customer_credit_ledger','customers','suppliers','stock','opening_wip','record_archive_state','document_attachments','email_history','inbound_emails',
    'chase_pauses','chase_sends','import_batches','import_record_keys','import_runs','import_source_batches','import_source_rows','import_stage',
    'reopen_requests','overview_owed_snapshots'];
  v_keep text[] := ARRAY['ai_helper_requests','ai_helper_secrets','ai_helper_settings','ai_helper_tolra_companies','ai_helper_usage','attendance_event_network_ips',
    'attendance_event_networks','attendance_events','chase_steps','clock_in_network_exemptions','clock_in_network_locks','clock_in_network_refusals',
    'clock_in_network_unverified','company_setup_progress','costing_defaults','costing_machines','costing_materials','dln_numbering_pending','email_schedules',
    'email_templates','import_mappings','inspector_authorisations','integration_connect_invites','integration_connections',
    'integration_contacts','integration_mailbox_sync','integration_mappings','integration_oauth_states','integration_secrets','integration_sends','issues',
    'iso_document_versions','job_costing_settings','legacy_audit_log','mail_poll_state','organization_invites','organization_settings','site_network_members','site_network_names',
    'site_network_ops','site_network_settings','site_networks','time_day_flag_ops','time_day_flags','time_settings','time_sync_rejections','time_week_approvals',
    'user_profiles','xero_send_release','xero_transfer_hold'];
  v_special text[] := ARRAY['doc_counters','organization_members'];
  -- 1: the exact delete-time triggers switched off (table.trigger). Each one refuses the owner role or writes other rows when a wipe row is deleted.
  v_trigger_allow CONSTANT text[] := ARRAY['import_batches.import_batches_immutable','import_source_batches.import_source_batches_immutable','import_source_rows.import_source_rows_guard',
    'job_flow_events.job_flow_events_immutable','job_inspections.job_inspections_immutable','job_signoffs.job_signoffs_immutable',
    'invoice_line_items.invoice_lines_within_despatched','quotes.quote_revision_withdrawn'];
  -- 1: delete-time guards reviewed and deliberately left ON (they let non-browser roles through; proven by the rehearsal). Anything else that fires on delete = refusal.
  v_trigger_leave CONSTANT text[] := ARRAY['credit_note_lines.credit_note_lines_issue_lock','credit_notes.credit_notes_issue_lock','customers.customers_in_use_guard',
    'delivery_note_items.delivery_note_items_link_guard','delivery_notes.delivery_notes_link_guard','document_attachments.document_attachments_guard',
    'invoice_line_items.invoice_lines_issue_lock','invoices.invoice_issue_lock','job_files.job_files_guard','purchase_orders.purchase_order_issue_lock',
    'quote_line_items.quote_lines_issue_lock','quotes.quote_lifecycle_guard','suppliers.suppliers_in_use_guard'];
  v_trigger_kept_fn CONSTANT text[] := ARRAY['support_readonly_guard','require_admin_mfa_guard','log_row_change'];
  v_fk_reviewed CONSTANT text[] := ARRAY['invoice_reminder_sends'];
  v_expected jsonb := p->'expected';
  t text; o uuid; n bigint; nxt text; k text; r record; v_sql text;
  v_before jsonb := '{}'::jsonb; v_after jsonb := '{}'::jsonb; v_deleted jsonb := '{}'::jsonb;
  v_disabled jsonb := '[]'::jsonb; v_dig_before jsonb := '{}'::jsonb; v_dig_after jsonb := '{}'::jsonb; v_removed_users jsonb := '[]'::jsonb;
  v_audit_rows jsonb := '[]'::jsonb; v_userrefs_before jsonb := '[]'::jsonb; v_userrefs_after jsonb := '[]'::jsonb; v_cascade_removed jsonb := '{}'::jsonb;
  v_counter_before text; v_counter_after text; v_counter_previous jsonb := '{}'::jsonb; v_audit_snap jsonb := '{}'::jsonb; v_audit_check bigint; v_reminders bigint := 0; v_all_orgs uuid[]; v_u jsonb; v_h text; v_prev text; v_n int;
  v_cycle text[]; v_report jsonb;
BEGIN
  IF coalesce(p->>'confirm', '') <> 'WIPE OPERATIONAL DATA' THEN RAISE EXCEPTION 'wipe refused: confirm must be WIPE OPERATIONAL DATA. Nothing changed.'; END IF;
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::text) IN ('anon', 'authenticated') THEN RAISE EXCEPTION 'wipe refused: must run as the database owner or service role, not a browser role. Nothing changed.'; END IF;
  IF cardinality(v_wipe_orgs) = 0 THEN RAISE EXCEPTION 'wipe refused: no companies named. Nothing changed.'; END IF;
  IF v_counters NOT IN ('reset', 'keep') THEN RAISE EXCEPTION 'wipe refused: counters must be reset or keep. Nothing changed.'; END IF;
  IF v_counters = 'reset' AND (cardinality(v_prefixes) = 0 OR NOT (v_prefixes <@ v_prefix_ok)) THEN RAISE EXCEPTION 'wipe refused: counter_prefixes must be a non-empty subset of QUO, J, INV, SO, PO, CRD (DLN and anything else is never reset). Nothing changed.'; END IF;
  PERFORM set_config('lock_timeout', '10s', true);
  v_all_orgs := v_wipe_orgs || CASE WHEN v_delete_org IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_delete_org] END;
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = o) THEN RAISE EXCEPTION 'wipe refused: company % does not exist. Nothing changed.', o; END IF;
  END LOOP;
  IF v_delete_org IS NOT NULL AND (v_delete_org = ANY(v_wipe_orgs) OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_delete_org)) THEN
    RAISE EXCEPTION 'wipe refused: the company to delete is missing or is also in the wipe list. Nothing changed.'; END IF;
  IF v_del_users && v_keep_admins THEN RAISE EXCEPTION 'wipe refused: a kept admin is also in the delete list. Nothing changed.'; END IF;

  -- classification: every table with organization_id is known
  FOR r IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
           WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' LOOP
    IF NOT (r.table_name = ANY(v_wipe) OR r.table_name = ANY(v_keep) OR r.table_name = ANY(v_special)) THEN
      RAISE EXCEPTION 'wipe refused: table public.% has an organization_id and is not classified in this script. Nothing changed.', r.table_name; END IF;
  END LOOP;
  -- 3: FK / cascade guard. Any CASCADE / SET NULL / SET DEFAULT FK from outside the wipe list into a wipe table must be reviewed.
  FOR r IN SELECT cl.relname AS child, pl.relname AS parent, c.conname
           FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace AND cn.nspname = 'public'
           JOIN pg_class pl ON pl.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = pl.relnamespace AND pn.nspname = 'public'
           WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n', 'd') AND pl.relname = ANY(v_wipe) AND NOT (cl.relname = ANY(v_wipe)) LOOP
    IF NOT (r.child = ANY(v_fk_reviewed)) THEN RAISE EXCEPTION 'wipe refused: % -> % (%) can cascade or null into a table outside the wipe list and is not reviewed. Nothing changed.', r.child, r.parent, r.conname; END IF;
  END LOOP;
  -- 1: delete-time triggers on wipe tables must be exactly the allowlist + the reviewed leave-on list + the three kept guards
  FOR r IN SELECT c.relname AS tbl, g.tgname AS trig, f.proname AS fn
           FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public' JOIN pg_proc f ON f.oid = g.tgfoid
           WHERE NOT g.tgisinternal AND c.relname = ANY(v_wipe) AND (g.tgtype & 8) <> 0 LOOP
    IF NOT (r.fn = ANY(v_trigger_kept_fn) OR (r.tbl || '.' || r.trig) = ANY(v_trigger_allow) OR (r.tbl || '.' || r.trig) = ANY(v_trigger_leave)) THEN
      RAISE EXCEPTION 'wipe refused: unreviewed delete-time trigger %.% (function %). Nothing changed.', r.tbl, r.trig, r.fn; END IF;
  END LOOP;
  -- kept admins
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    FOREACH k IN ARRAY ARRAY(SELECT unnest(v_keep_admins)::text) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = o AND user_id = k::uuid AND role = 'admin' AND active) THEN
        RAISE EXCEPTION 'wipe refused: user % is not an active admin of company %. Nothing changed.', k, o; END IF;
    END LOOP;
  END LOOP;
  -- 5: users: exact id + email, and in no company outside the wipe list
  FOR r IN SELECT x->>'id' AS id, x->>'email' AS email FROM jsonb_array_elements(coalesce(p->'delete_users', '[]'::jsonb)) x LOOP
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = r.id::uuid AND email = r.email) THEN RAISE EXCEPTION 'wipe refused: user % does not match email %. Nothing changed.', r.id, r.email; END IF;
    IF EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = r.id::uuid AND NOT (organization_id = ANY(v_wipe_orgs))) THEN RAISE EXCEPTION 'wipe refused: user % belongs to a company outside the wipe list. Nothing changed.', r.email; END IF;
  END LOOP;

  -- 7: locks (alphabetical, 10 s timeout) on everything read for the checks and everything deleted
  FOR r IN SELECT x AS tbl FROM unnest(v_wipe || v_keep || v_special) x WHERE to_regclass('public.' || x) IS NOT NULL ORDER BY x LOOP
    EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE', r.tbl);
  END LOOP;
  LOCK TABLE security_audit.audit_log IN SHARE ROW EXCLUSIVE MODE;

  -- approved headline counts must equal the live counts
  IF v_expected IS NULL THEN RAISE EXCEPTION 'wipe refused: p.expected (the approved row counts) is required. Nothing changed.'; END IF;
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    IF v_expected -> o::text IS NULL THEN RAISE EXCEPTION 'wipe refused: p.expected has no counts for company %. Nothing changed.', o; END IF;
    FOR r IN SELECT key AS tbl, value::text::bigint AS want FROM jsonb_each(v_expected -> o::text) LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', r.tbl) INTO n USING o;
      IF n <> r.want THEN RAISE EXCEPTION 'wipe refused: % in company % has % rows, approved % . Nothing changed.', r.tbl, o, n, r.want; END IF;
    END LOOP;
  END LOOP;
  -- 2: before counts for EVERY wipe table and company
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    FOREACH t IN ARRAY v_wipe LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', t) INTO n USING o;
        v_before := jsonb_set(jsonb_set(v_before, ARRAY[o::text], coalesce(v_before -> o::text, '{}'::jsonb), true), ARRAY[o::text, t], to_jsonb(n), true);
      END IF;
    END LOOP;
  END LOOP;
  -- 4: retained snapshot by identity and hash (before)
  FOREACH t IN ARRAY (v_keep || v_special) LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND t <> 'doc_counters' THEN v_dig_before := v_dig_before || jsonb_build_object(t, pg_temp.wipe_digest(t, v_wipe_orgs, v_del_text)); END IF;
  END LOOP;
  SELECT coalesce(md5(string_agg(md5(to_jsonb(d)::text), E'\n' ORDER BY d.organization_id, d.prefix)), '-') || ':' || count(*) INTO v_counter_before
    FROM public.doc_counters d WHERE d.organization_id = ANY(v_wipe_orgs) AND NOT (d.prefix = ANY(v_prefix_ok));
  -- every audit row that already exists for the wiped companies, by id, hash and a digest of the whole row (not by time): re-checked after the wipe
  SELECT coalesce(jsonb_object_agg(a.id::text, jsonb_build_object('hash', a.hash, 'row_digest', md5(to_jsonb(a)::text))), '{}'::jsonb) INTO v_audit_snap FROM security_audit.audit_log a WHERE a.organization_id = ANY(v_wipe_orgs);
  -- 5: every reference to the named users, before
  IF cardinality(v_del_users) > 0 THEN
    FOR r IN SELECT cn.nspname AS sch, cl.relname AS rel, a.attname AS col, c.confdeltype AS od
             FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
             WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass AND cn.nspname IN ('public', 'security_audit') AND array_length(c.conkey, 1) = 1 LOOP
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I = ANY($1)', r.sch, r.rel, r.col) INTO n USING v_del_users;
      IF n > 0 THEN v_userrefs_before := v_userrefs_before || jsonb_build_object('table', r.sch || '.' || r.rel, 'column', r.col, 'rows', n, 'on_delete', CASE r.od WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' ELSE r.od::text END); END IF;
    END LOOP;
    SELECT count(*) INTO n FROM security_audit.audit_log WHERE actor_user_id = ANY(v_del_users);
    v_userrefs_before := v_userrefs_before || jsonb_build_object('table', 'security_audit.audit_log', 'column', 'actor_user_id (no FK)', 'rows', n, 'on_delete', 'rows stay');
  END IF;
  -- 6: the live company's audit rows: exactly the approved ids, hash chain verified
  IF v_delete_org IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM security_audit.audit_log WHERE organization_id = v_delete_org AND NOT (id = ANY(v_org_audit)))
       OR (SELECT count(*) FROM security_audit.audit_log WHERE organization_id = v_delete_org) <> cardinality(v_org_audit) THEN
      RAISE EXCEPTION 'wipe refused: the audit rows of the company to delete are not exactly the approved list. Nothing changed.'; END IF;
    v_prev := NULL;
    FOR r IN SELECT * FROM security_audit.audit_log WHERE organization_id = v_delete_org ORDER BY created_at LOOP
      v_h := encode(extensions.digest(coalesce(r.previous_hash, '') || coalesce(r.organization_id::text, '') || coalesce(r.actor_user_id::text, '') || r.action || r.entity_table || coalesce(r.entity_id, '') || coalesce(r.old_data::text, '') || coalesce(r.new_data::text, '') || coalesce(r.metadata::text, '') || r.created_at::text, 'sha256'), 'hex');
      IF r.previous_hash IS DISTINCT FROM v_prev OR r.hash IS DISTINCT FROM v_h THEN RAISE EXCEPTION 'wipe refused: the audit hash chain of the company to delete does not verify at row %. Nothing changed.', r.id; END IF;
      v_prev := r.hash;
      v_audit_rows := v_audit_rows || jsonb_build_object('id', r.id, 'created_at', r.created_at, 'action', r.action, 'actor', r.actor_user_id, 'previous_hash', r.previous_hash, 'hash', r.hash, 'chain_verified', true);
    END LOOP;
    IF jsonb_array_length(v_audit_rows) > 0 AND NOT v_allow_audit THEN RAISE EXCEPTION 'wipe refused: the company to delete has % append-only audit rows; needs allow_audit_row_delete = true (owner decision). Nothing changed.', jsonb_array_length(v_audit_rows); END IF;
  END IF;

  -- 1: switch off ONLY the allowlisted delete-time triggers
  FOR r IN SELECT c.relname AS tbl, g.tgname AS trig, g.tgenabled AS en FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
           WHERE NOT g.tgisinternal AND (c.relname || '.' || g.tgname) = ANY(v_trigger_allow) LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', r.tbl, r.trig);
    v_disabled := v_disabled || jsonb_build_object('table', r.tbl, 'trigger', r.trig, 'was', r.en);
  END LOOP;

  -- delete child-first; a foreign-key cycle is deleted in ONE statement (data-modifying CTEs, checks at statement end), so no UPDATE trigger is needed
  CREATE TEMP TABLE IF NOT EXISTS _w (tname text PRIMARY KEY, done boolean NOT NULL DEFAULT false) ON COMMIT DROP;
  DELETE FROM _w;
  INSERT INTO _w SELECT x, false FROM unnest(v_wipe) x WHERE to_regclass('public.' || x) IS NOT NULL;
  IF to_regclass('public.invoice_reminder_sends') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.invoice_reminder_sends s WHERE s.invoice_id IN (SELECT id FROM public.invoices WHERE organization_id = ANY($1))' INTO v_reminders USING v_wipe_orgs;
  END IF;
  LOOP
    SELECT w.tname INTO nxt FROM _w w WHERE NOT w.done AND NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid AND cl.relnamespace = 'public'::regnamespace JOIN _w ch ON ch.tname = cl.relname
      WHERE c.contype = 'f' AND c.confrelid = ('public.' || w.tname)::regclass AND c.conrelid <> c.confrelid AND NOT ch.done) LIMIT 1;
    IF nxt IS NULL THEN
      EXIT WHEN NOT EXISTS (SELECT 1 FROM _w WHERE NOT done);
      SELECT array_agg(tname ORDER BY tname) INTO v_cycle FROM _w WHERE NOT done;
      v_sql := 'WITH ' || (SELECT string_agg(format('d_%s AS (DELETE FROM public.%I WHERE organization_id = ANY($1) RETURNING 1)', tname, tname), ', ' ORDER BY tname) FROM _w WHERE NOT done) || ' SELECT 1';
      EXECUTE v_sql USING v_wipe_orgs;
      UPDATE _w SET done = true WHERE NOT done;
      v_deleted := v_deleted || jsonb_build_object('_cycle_deleted_in_one_statement', to_jsonb(v_cycle));
      EXIT;
    END IF;
    FOREACH o IN ARRAY v_wipe_orgs LOOP
      EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', nxt) USING o;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        v_deleted := jsonb_set(v_deleted, ARRAY[o::text], coalesce(v_deleted -> o::text, '{}'::jsonb), true);
        v_deleted := jsonb_set(v_deleted, ARRAY[o::text, nxt], to_jsonb(n), true);
      END IF;
    END LOOP;
    UPDATE _w SET done = true WHERE tname = nxt;
  END LOOP;
  -- 2: after counts for every wipe table and company must all be 0
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    FOR r IN SELECT tname FROM _w ORDER BY tname LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', r.tname) INTO n USING o;
      IF n <> 0 THEN RAISE EXCEPTION 'wipe failed: % still has % rows for %. Nothing changed.', r.tname, n, o; END IF;
      v_after := jsonb_set(jsonb_set(v_after, ARRAY[o::text], coalesce(v_after -> o::text, '{}'::jsonb), true), ARRAY[o::text, r.tname], to_jsonb(n), true);
    END LOOP;
  END LOOP;

  -- 8: counters: only the approved prefixes, by explicit name, for the named companies
  IF v_counters = 'reset' THEN
    -- the six counters' previous values, per company, kept in the audit rows and the report before they are reset
    SELECT coalesce(jsonb_object_agg(x.organization_id::text, x.pv), '{}'::jsonb) INTO v_counter_previous FROM (SELECT d.organization_id, jsonb_object_agg(d.prefix, d.last) AS pv FROM public.doc_counters d WHERE d.organization_id = ANY(v_wipe_orgs) AND d.prefix = ANY(v_prefixes) GROUP BY d.organization_id) x;
    UPDATE public.doc_counters SET last = 0 WHERE organization_id = ANY(v_wipe_orgs) AND prefix = ANY(v_prefixes);
    IF EXISTS (SELECT 1 FROM public.doc_counters WHERE organization_id = ANY(v_wipe_orgs) AND prefix = ANY(v_prefixes) AND last <> 0) THEN RAISE EXCEPTION 'wipe failed: a counter did not reset. Nothing changed.'; END IF;
  END IF;

  -- members and users
  IF cardinality(v_del_users) > 0 THEN
    DELETE FROM public.organization_members WHERE organization_id = ANY(v_wipe_orgs) AND user_id = ANY(v_del_users);
    FOR r IN SELECT u AS uid FROM unnest(v_del_users) u LOOP
      IF EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = r.uid) THEN RAISE EXCEPTION 'wipe failed: user % still belongs to a company. Nothing changed.', r.uid; END IF;
      DELETE FROM auth.users WHERE id = r.uid;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 1 THEN RAISE EXCEPTION 'wipe failed: user % delete removed % rows. Nothing changed.', r.uid, n; END IF;
      v_removed_users := v_removed_users || to_jsonb(r.uid::text);
    END LOOP;
    -- every reference after: only the audit log (no FK) may still name them
    FOR r IN SELECT cn.nspname AS sch, cl.relname AS rel, a.attname AS col
             FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
             WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass AND cn.nspname IN ('public', 'security_audit') AND array_length(c.conkey, 1) = 1 LOOP
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I = ANY($1)', r.sch, r.rel, r.col) INTO n USING v_del_users;
      IF n > 0 THEN RAISE EXCEPTION 'wipe failed: % rows in %.% still name a deleted user. Nothing changed.', n, r.rel, r.col; END IF;
    END LOOP;
  END IF;

  -- the empty company (6: audit guard re-enabled and asserted)
  IF v_delete_org IS NOT NULL THEN
    FOR r IN SELECT c.relname AS tbl FROM information_schema.columns x JOIN pg_class c ON c.relname = x.table_name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
             WHERE x.table_schema = 'public' AND x.column_name = 'organization_id' AND x.table_name NOT IN ('organization_members','organization_settings','overview_owed_snapshots') LOOP
      EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', r.tbl) INTO n USING v_delete_org;
      IF n <> 0 THEN RAISE EXCEPTION 'wipe refused: the company to delete still has % rows in %. Nothing changed.', n, r.tbl; END IF;
    END LOOP;
    IF jsonb_array_length(v_audit_rows) > 0 THEN
      ALTER TABLE security_audit.audit_log DISABLE TRIGGER audit_log_prevent_mutation;
      DELETE FROM security_audit.audit_log WHERE organization_id = v_delete_org;
      ALTER TABLE security_audit.audit_log ENABLE TRIGGER audit_log_prevent_mutation;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'security_audit.audit_log'::regclass AND tgname = 'audit_log_prevent_mutation' AND tgenabled = 'O') THEN RAISE EXCEPTION 'wipe failed: the audit guard is not enabled again. Nothing changed.'; END IF;
    END IF;
    DELETE FROM public.organizations WHERE id = v_delete_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'wipe failed: company delete removed % rows. Nothing changed.', n; END IF;
  END IF;

  -- 1: re-enable every disabled trigger and assert it is back to its original state
  FOR r IN SELECT x->>'table' AS tbl, x->>'trigger' AS trig, x->>'was' AS was FROM jsonb_array_elements(v_disabled) x LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', r.tbl, r.trig);
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || r.tbl)::regclass AND g.tgname = r.trig AND g.tgenabled::text = r.was) THEN RAISE EXCEPTION 'wipe failed: trigger %.% is not back to its original state. Nothing changed.', r.tbl, r.trig; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgenabled = 'D' AND c.relnamespace IN ('public'::regnamespace, 'security_audit'::regnamespace)) THEN
    RAISE EXCEPTION 'wipe failed: a trigger is still disabled. Nothing changed.'; END IF;

  -- 4: retained comparison AFTER, by identity and hash
  FOREACH t IN ARRAY (v_keep || v_special) LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND t <> 'doc_counters' THEN
      v_dig_after := v_dig_after || jsonb_build_object(t, pg_temp.wipe_digest(t, v_wipe_orgs, v_del_text));
      IF (v_dig_after ->> t) IS DISTINCT FROM (v_dig_before ->> t) THEN RAISE EXCEPTION 'wipe failed: retained table % differs after the wipe (before %, after %). Nothing changed.', t, v_dig_before ->> t, v_dig_after ->> t; END IF;
    END IF;
  END LOOP;
  SELECT coalesce(md5(string_agg(md5(to_jsonb(d)::text), E'\n' ORDER BY d.organization_id, d.prefix)), '-') || ':' || count(*) INTO v_counter_after
    FROM public.doc_counters d WHERE d.organization_id = ANY(v_wipe_orgs) AND NOT (d.prefix = ANY(v_prefix_ok));
  IF v_counter_after IS DISTINCT FROM v_counter_before THEN RAISE EXCEPTION 'wipe failed: a counter outside the approved prefixes changed (DLN or other). Nothing changed.'; END IF;
  SELECT count(*) INTO v_audit_check FROM security_audit.audit_log a JOIN jsonb_each(v_audit_snap) e ON e.key = a.id::text AND e.value ->> 'hash' = a.hash AND e.value ->> 'row_digest' = md5(to_jsonb(a)::text);
  IF v_audit_check <> (SELECT count(*) FROM jsonb_object_keys(v_audit_snap)) THEN RAISE EXCEPTION 'wipe failed: % of % existing audit rows of the wiped companies are missing or changed. Nothing changed.', (SELECT count(*) FROM jsonb_object_keys(v_audit_snap)) - v_audit_check, (SELECT count(*) FROM jsonb_object_keys(v_audit_snap)); END IF;
  FOREACH k IN ARRAY ARRAY(SELECT unnest(v_keep_admins)::text) LOOP
    FOREACH o IN ARRAY v_wipe_orgs LOOP
      IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = o AND user_id = k::uuid AND role = 'admin' AND active) THEN RAISE EXCEPTION 'wipe failed: kept admin % lost admin on %. Nothing changed.', k, o; END IF;
    END LOOP;
  END LOOP;
  FOREACH o IN ARRAY v_wipe_orgs LOOP
    INSERT INTO security_audit.audit_log (organization_id, action, entity_table, entity_id, new_data, metadata)
    VALUES (o, 'DATA_WIPE', 'public', 'operational', coalesce(v_deleted -> o::text, '{}'::jsonb),
            jsonb_build_object('script', 'supabase/cutover/wipe_operational_data.sql', 'version', 2, 'counters', v_counters, 'prefixes', to_jsonb(v_prefixes), 'counters_previous', coalesce(v_counter_previous -> o::text, '{}'::jsonb), 'db_user', current_user, 'dry_run', v_dry));
  END LOOP;
  v_report := jsonb_build_object('dry_run', v_dry, 'version', 2,
    'reconciliation', jsonb_build_object('before_every_wipe_table_per_company', v_before, 'after_all_zero', v_after, 'deleted', v_deleted),
    'retained_compared_by_hash', v_dig_before, 'retained_equal_after', true,
    'doc_counters_outside_approved_prefixes_equal', v_counter_before, 'counter_prefixes_reset', CASE WHEN v_counters = 'reset' THEN to_jsonb(v_prefixes) ELSE '[]'::jsonb END,
    'triggers_disabled_then_restored', v_disabled, 'triggers_left_enabled_by_review', to_jsonb(v_trigger_leave),
    'user_references_before', v_userrefs_before, 'users_deleted', v_removed_users,
    'live_company', CASE WHEN v_delete_org IS NULL THEN NULL ELSE jsonb_build_object('id', v_delete_org, 'audit_rows_verified_then_deleted', v_audit_rows) END,
    'invoice_reminder_sends_cascaded', v_reminders, 'existing_audit_rows_verified_by_id_hash_digest', v_audit_check, 'counters_previous', v_counter_previous);
  -- dry_run (the default, true unless the caller says false) runs every step and every check, then ROLLS BACK by raising DRY_RUN_ROLLED_BACK with the full report in the DETAIL: nothing is kept (no deletes, no DATA_WIPE audit rows).
  IF v_dry THEN RAISE EXCEPTION USING MESSAGE = 'DRY_RUN_ROLLED_BACK', DETAIL = v_report::text; END IF;
  RETURN v_report;
END
$wipe$;
-- RUN, in the same session, right after the two function definitions (the owner approves the exact numbers first; see the PLAN):
-- SELECT pg_temp.tolra_wipe('{...}'::jsonb);   -- dry_run true first (it rolls back and shows the report in the error text)
-- To see the full report of a REAL run without keeping it (rehearsal): DO $$ BEGIN PERFORM pg_temp.tolra_wipe('{... "dry_run": false ...}'::jsonb); RAISE EXCEPTION 'REPORT'; END $$;
