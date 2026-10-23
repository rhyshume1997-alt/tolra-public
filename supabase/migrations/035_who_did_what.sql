-- =====================================================================================================
-- 035: who did what (PR C). One migration for every database change in the batch.
--
-- Shows who did what on jobs, purchase orders, invoices, quotes, sales orders, delivery notes and credit notes: display names
-- only, the caller's own company only. It reuses created_by / updated_by and the activity trail (013, 024).
--
-- 1. Milestone actor columns. started_by, finished_by and inspected_by_user (jobs); sent_by and accepted_by (quotes); issued_at and
--    issued_by, paid_by and emailed_by (invoices; emailed_by goes with the existing sent_date); confirmed_at and confirmed_by (sales
--    orders); received_by (purchase orders; received_at exists); despatched_at, despatched_by, signed_recorded_by and emailed_by
--    (delivery notes; the customer's signature stays in the existing signed_by_name, typed by staff, and signed_recorded_by is the
--    staff member who recorded it: the two are never the same field); issued_by (credit notes; issued_at exists). Every one is
--    set by a trigger from the session (auth.uid()), never by the client.
-- 2. The rules for the API roles (signed-in users). created_by is overwritten on INSERT with the caller, whatever the client sent;
--    updated_by is the caller on every INSERT and UPDATE; created_by and every actor column are SILENTLY KEPT at their old value
--    by an update (nothing is refused, so no existing screen can fail on it, and the value simply doesn't move). Actor columns
--    change only when their milestone does: set to the caller when the milestone happens (or happens again, for a re-send or a
--    new finish time), cleared when it is undone. The service role, the database owner and the SQL editor are exempt (the
--    importer keeps its own created_by values; nothing is stamped for a change nobody signed in to make).
-- 3. Named events written in the same transaction as the action (security_audit.audit_log, source write_audit): ISSUE (an invoice
--    or a credit note leaves draft), MARK_PAID (one per invoice, entity_id the invoice's own id, when it becomes paid),
--    CONFIRM (a sales order becomes confirmed), CONFIRM_STILL_OWED (an admin confirms an imported invoice has no payments; with
--    payments it stays CONFIRM_PAYMENTS), RESEND and REOPEN (below). RECORD_PAYMENT, REVERSE_PAYMENT, CONFIRM_PAYMENTS, INSPECT_JOB
--    and APPLY_CREDIT were already written inside their functions (032, 034) and are unchanged.
-- 4. Re-send and reopen. Sending a quote or an invoice again (sent_at / sent_date moves on one that was already sent) makes the
--    latest sender the sent_by / emailed_by and writes RESEND, which names the previous sender and time: the original send stays
--    in the trail. Reopening a job (finished_at cleared) clears finished_by and the inspection sign-off (inspected_at, inspected_by,
--    inspected_by_user), moves a job at the inspection or complete stage back to machining, and writes REOPEN.
-- 5. company_people(): (user_id, display_name) for the members of the caller's current company, for any signed-in role. No
--    e-mail, no username, no other company. A name that looks like an e-mail address is not returned.
-- 6. record_activity and org_activity no longer return any e-mail address (their actor_email column is always empty) and name people
--    only from company_people, for every role. write_audit refuses the payment events from a client.
-- 7. Backfill, only what the trail proves: a milestone's actor is filled from the row-change history (source database_trigger)
--    only when exactly one recorded change produced the value now on the row, by a signed-in member of the same company. The rest
--    stay empty. supabase/verify/who_did_what_035.sql counts filled and left blank.
-- 8. No e-mail address in the history or as an inspector's name. record_activity and org_activity pass every old/new value and
--    metadata through security_audit.redact_emails (an address becomes the member's display name or an em dash; the audit log itself
--    is never rewritten). Existing jobs.inspected_by and job_inspections.inspector_name values holding an @ are replaced by the
--    display name or 'Inspector', then a named no-@ rule is added to each existing table, so it holds after an upgrade too.
-- 9. confirm_invoice_payments (replaced here) starts with 033's second-step check, assert_privileged_aal().
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. The columns -------------------------------------------------------------------------------------
ALTER TABLE public.jobs            ADD COLUMN IF NOT EXISTS started_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.jobs            ADD COLUMN IF NOT EXISTS finished_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.jobs            ADD COLUMN IF NOT EXISTS inspected_by_user  UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.quotes          ADD COLUMN IF NOT EXISTS sent_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.quotes          ADD COLUMN IF NOT EXISTS accepted_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS issued_at          TIMESTAMPTZ;
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS issued_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS paid_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS emailed_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.sales_orders    ADD COLUMN IF NOT EXISTS confirmed_at       TIMESTAMPTZ;
ALTER TABLE public.sales_orders    ADD COLUMN IF NOT EXISTS confirmed_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS received_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.delivery_notes  ADD COLUMN IF NOT EXISTS despatched_at      TIMESTAMPTZ;
ALTER TABLE public.delivery_notes  ADD COLUMN IF NOT EXISTS despatched_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.delivery_notes  ADD COLUMN IF NOT EXISTS signed_recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.delivery_notes  ADD COLUMN IF NOT EXISTS emailed_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.credit_notes    ADD COLUMN IF NOT EXISTS issued_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- The history of a record lists what changed; who did it is shown by the who/when lines, so a change to only these columns
-- (and the bookkeeping ones, as before) says nothing. Otherwise exactly as 032.
CREATE OR REPLACE FUNCTION security_audit.activity_changes(p_old JSONB, p_new JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_object_agg(k, CASE
           WHEN jsonb_typeof(p_new -> k) = 'array' OR jsonb_typeof(p_old -> k) = 'array' THEN jsonb_build_object(
             'added',   coalesce((SELECT jsonb_agg(security_audit.activity_value(e)) FROM jsonb_array_elements(coalesce(nullif(p_new -> k, 'null'::JSONB), '[]')) e
                                  WHERE NOT coalesce(nullif(p_old -> k, 'null'::JSONB), '[]') @> jsonb_build_array(e)), '[]'),
             'removed', coalesce((SELECT jsonb_agg(security_audit.activity_value(e)) FROM jsonb_array_elements(coalesce(nullif(p_old -> k, 'null'::JSONB), '[]')) e
                                  WHERE NOT coalesce(nullif(p_new -> k, 'null'::JSONB), '[]') @> jsonb_build_array(e)), '[]'))
           WHEN jsonb_typeof(p_new -> k) = 'object' OR jsonb_typeof(p_old -> k) = 'object' THEN jsonb_build_object(
             'changed', TRUE,
             'keys', coalesce((SELECT jsonb_agg(kk) FROM (
                        SELECT kk FROM jsonb_object_keys(coalesce(nullif(p_new -> k, 'null'::JSONB), '{}') || coalesce(nullif(p_old -> k, 'null'::JSONB), '{}')) kk
                        WHERE (p_new -> k -> kk) IS DISTINCT FROM (p_old -> k -> kk) LIMIT 20) x), '[]'))
           ELSE jsonb_build_object('from', security_audit.activity_value(p_old -> k), 'to', security_audit.activity_value(p_new -> k))
         END), '{}'::JSONB)
  FROM (
    SELECT k FROM jsonb_object_keys(coalesce(p_new, '{}') || coalesce(p_old, '{}')) k
    WHERE k NOT IN ('id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'position',
                    'started_by', 'finished_by', 'inspected_by_user', 'sent_by', 'accepted_by', 'issued_by', 'paid_by', 'emailed_by',
                    'confirmed_by', 'received_by', 'despatched_by', 'signed_recorded_by')
      AND (p_new -> k) IS DISTINCT FROM (p_old -> k)
  ) keys
$$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. The record history: names only ---------------------------------------------------------------------
-- record_activity (013, 024, 034) returned the actor's e-mail address (actor_email) and fell back to it as the name. Now the name
-- is the person's display name from company_people (this company's members only), 'System' for a change nobody signed in to make,
-- and empty when the person has no usable name, and actor_email is always empty. The column stays in the result, empty, so the
-- function keeps its signature: an earlier migration run again (the upgrade rehearsal applies every file twice) can still replace it.
-- Nothing may read an e-mail address from this function. Everything else is exactly as 034.
-- No e-mail address leaves the history, whatever an old row holds. Rows written before this release (and before 034) can carry an
-- address in their old/new values: jobs.inspected_by was often one, and job_inspections.inspector_name could be. The audit log is
-- never rewritten; instead every value read back through record_activity and org_activity passes through here: a value that IS an
-- address becomes the display name of the company member with that address (company_people's rule: no name, or a name with an @,
-- gives none), or an em dash; an address inside longer text becomes an em dash; and any @ still left is spelt out, so nothing
-- that reads as an address remains. Walks objects and arrays. Internal: the read functions call it.
CREATE OR REPLACE FUNCTION security_audit.redact_emails(p_value JSONB, p_org UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_text TEXT;
  v_name TEXT;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      RETURN (SELECT coalesce(jsonb_object_agg(e.key, security_audit.redact_emails(e.value, p_org)), '{}'::JSONB) FROM jsonb_each(p_value) e);
    WHEN 'array' THEN
      RETURN (SELECT coalesce(jsonb_agg(security_audit.redact_emails(e.value, p_org) ORDER BY e.n), '[]'::JSONB)
              FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, n));
    WHEN 'string' THEN
      v_text := p_value #>> '{}';
      IF position('@' IN v_text) = 0 THEN
        RETURN p_value;
      END IF;
      IF btrim(v_text) ~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
        SELECT CASE WHEN nullif(btrim(pr.full_name), '') IS NULL OR pr.full_name LIKE '%@%' THEN NULL ELSE left(btrim(pr.full_name), 80) END
          INTO v_name
        FROM public.user_profiles pr JOIN public.organization_members m ON m.user_id = pr.id AND m.organization_id = p_org
        WHERE lower(pr.email) = lower(btrim(v_text))
        LIMIT 1;
        RETURN to_jsonb(coalesce(v_name, '—'));
      END IF;
      v_text := regexp_replace(v_text, '[^[:space:]@<>(),;:"'']+@[^[:space:]@<>(),;:"'']+', '—', 'g');
      RETURN to_jsonb(replace(v_text, '@', ' at '));
    ELSE
      RETURN p_value;
  END CASE;
END
$$;
REVOKE ALL ON FUNCTION security_audit.redact_emails(JSONB, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_activity(p_table TEXT, p_id UUID, p_limit INTEGER DEFAULT 200)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, actor_name TEXT, actor_email TEXT, action TEXT, entity_table TEXT,
               entity_id TEXT, changes JSONB, snapshot JSONB, metadata JSONB)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_allowed BOOLEAN;
  v_ref     TEXT;
  v_exists  BOOLEAN;
  v_values  BOOLEAN := public.has_org_role(ARRAY['admin', 'office']);
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  v_allowed := CASE p_table
    WHEN 'quotes'          THEN public.has_org_role(ARRAY['admin', 'office']) AND public.section_allowed('quotes')
    WHEN 'jobs'            THEN public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer'])
    WHEN 'sales_orders'    THEN public.has_org_role(ARRAY['admin', 'office']) AND public.section_allowed('sales-orders')
    WHEN 'invoices'        THEN public.has_org_role(ARRAY['admin', 'office']) AND public.section_allowed('invoices')
    WHEN 'purchase_orders' THEN public.has_org_role(ARRAY['admin', 'office']) AND public.section_allowed('purchase-orders')
    WHEN 'delivery_notes'  THEN public.has_org_role(ARRAY['admin', 'office', 'workshop'])
    ELSE NULL
  END;
  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'Unknown record type' USING ERRCODE = '22023';
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  -- The record must belong to this organisation (p_table is one of the names above, never caller text).
  -- (EXECUTE doesn't set FOUND, hence the explicit flag.)
  EXECUTE format('SELECT TRUE, %s FROM public.%I WHERE id = $1 AND organization_id = $2',
                 CASE WHEN p_table = 'quotes' THEN 'quote_ref' ELSE 'NULL::TEXT' END, p_table)
    INTO v_exists, v_ref USING p_id, v_org;
  IF v_exists IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.id, a.created_at,
         CASE WHEN a.actor_user_id IS NULL THEN 'System' ELSE cp.display_name END,
         NULL::TEXT,
         a.action, a.entity_table, a.entity_id,
         security_audit.redact_emails(security_audit.redact_unless(v_values, CASE WHEN a.action = 'UPDATE' THEN security_audit.activity_changes(a.old_data, a.new_data) END), v_org),
         security_audit.redact_emails(security_audit.redact_unless(v_values,
           CASE WHEN a.action IN ('INSERT', 'DELETE') THEN security_audit.activity_snapshot(coalesce(a.new_data, a.old_data))
                WHEN coalesce(a.metadata ->> 'source', '') = 'write_audit' THEN security_audit.activity_snapshot(coalesce(a.new_data, '{}'))
           END), v_org),
         security_audit.redact_emails(security_audit.redact_unless(v_values, a.metadata - 'source'), v_org)
  FROM security_audit.audit_log a
  LEFT JOIN public.company_people() cp ON cp.user_id = a.actor_user_id
  WHERE a.organization_id = v_org
    AND (
      -- the record itself (row changes, and app events that name it)
      (a.entity_table = p_table AND (a.entity_id = p_id::TEXT
         OR (v_ref IS NOT NULL AND v_ref = ANY (string_to_array(a.entity_id, ',')))
         OR (a.metadata -> 'ids') ? p_id::TEXT))
      -- its child rows
      OR (a.entity_table IN ('quote_line_items', 'invoice_line_items', 'delivery_note_items', 'machine_bookings', 'job_values', 'quote_attachments')
          AND security_audit.activity_parent(a.entity_table, a.old_data, a.new_data)
              IN (p_id::TEXT, CASE WHEN v_ref IS NOT NULL THEN 'quote_ref:' || v_ref END)
          AND (a.entity_table <> 'job_values' OR v_values))
    )
    -- the database's own row change already records app-level create / update events
    AND NOT (coalesce(a.metadata ->> 'source', '') = 'write_audit' AND a.action IN ('CREATE', 'UPDATE', 'INSERT', 'DELETE'))
    -- an update that changed only bookkeeping columns says nothing
    AND NOT (a.action = 'UPDATE' AND security_audit.activity_changes(a.old_data, a.new_data) = '{}'::JSONB)
    -- ... nor does one that changed only money, for someone who may not see money
    AND NOT (NOT v_values AND a.action = 'UPDATE'
             AND security_audit.redact_money(security_audit.activity_changes(a.old_data, a.new_data)) = '{}'::JSONB)
  ORDER BY a.created_at DESC, a.id
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.record_activity(TEXT, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_activity(TEXT, UUID, INTEGER) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. company_people ---------------------------------------------------------------------------------------
-- The people of the caller's CURRENT company and the name to show for each, for every role (workshop and viewer included: the
-- who/when lines show names to everyone who can open the record). Members only, active or not (a colleague who has left still
-- did the work). No e-mail, no username, nothing of another company. A full name that contains an @ is treated as no name.
CREATE OR REPLACE FUNCTION public.company_people()
RETURNS TABLE (user_id UUID, display_name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.user_id,
         CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END
  FROM public.organization_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.organization_id = v_org
  ORDER BY 2, 1;
END
$$;
REVOKE ALL ON FUNCTION public.company_people() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_people() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Who is recorded, and the named events ------------------------------------------------------------------
-- Writes one named event into the audit trail, in the caller's transaction (so it exists only if the change it describes does).
-- Internal: called by the trigger below, not by the API roles.
CREATE OR REPLACE FUNCTION security_audit.log_named_event(p_org UUID, p_action TEXT, p_table TEXT, p_id TEXT, p_metadata JSONB)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
BEGIN
  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_uid;
  PERFORM set_config('quoteflow.db_event', 'on', TRUE);
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (p_org, v_uid, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), p_action, p_table, p_id,
          jsonb_build_object('source', 'write_audit') || coalesce(p_metadata, '{}'::JSONB));
  PERFORM set_config('quoteflow.db_event', '', TRUE);
END
$$;
REVOKE ALL ON FUNCTION security_audit.log_named_event(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- First trigger on each table (BEFORE INSERT OR UPDATE, for the signed-in API role only): nobody but the stamp trigger below
-- decides who is recorded. On INSERT created_by and updated_by are the caller and every actor column starts empty; on UPDATE
-- created_by and every actor column keep their old value (silently: the update is not refused), updated_by is the caller.
CREATE OR REPLACE FUNCTION public.actor_keep()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_protected TEXT[] := CASE TG_TABLE_NAME
    WHEN 'jobs'            THEN ARRAY['started_by', 'finished_by', 'inspected_by_user']
    WHEN 'quotes'          THEN ARRAY['sent_by', 'accepted_by']
    WHEN 'invoices'        THEN ARRAY['issued_at', 'issued_by', 'paid_by', 'emailed_by']
    WHEN 'sales_orders'    THEN ARRAY['confirmed_at', 'confirmed_by']
    WHEN 'purchase_orders' THEN ARRAY['received_by']
    WHEN 'delivery_notes'  THEN ARRAY['despatched_at', 'despatched_by', 'signed_recorded_by', 'emailed_by']
    WHEN 'credit_notes'    THEN ARRAY['issued_by']
    ELSE ARRAY[]::TEXT[]
  END;
  v_old   JSONB;
  v_patch JSONB;
BEGIN
  IF v_uid IS NULL OR coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) <> 'authenticated' THEN
    RETURN NEW; -- the service role, the owner, the SQL editor, the importer: exempt
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT coalesce(jsonb_object_agg(c, NULL::JSONB), '{}'::JSONB) INTO v_patch FROM unnest(v_protected) c;
    v_patch := v_patch || jsonb_build_object('created_by', v_uid, 'updated_by', v_uid);
  ELSE
    v_old := to_jsonb(OLD);
    SELECT coalesce(jsonb_object_agg(c, v_old -> c), '{}'::JSONB) INTO v_patch FROM unnest(v_protected || ARRAY['created_by']) c;
    v_patch := v_patch || jsonb_build_object('updated_by', v_uid);
  END IF;
  NEW := jsonb_populate_record(NEW, v_patch);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.actor_keep() FROM PUBLIC, anon, authenticated;

-- Last trigger on each table with milestones (BEFORE INSERT OR UPDATE, signed-in API role only): records who did what from the
-- session. A timestamp that moves records the caller as its actor (empty when the timestamp is cleared); the status moves that
-- are milestones do the same and stamp their own time. Named events are written here, so they commit or roll back with the row.
-- Runs after the other triggers, so it sees the row they have settled (including a sign-off they withdrew).
CREATE OR REPLACE FUNCTION public.actor_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_org    UUID := NEW.organization_id;
  v_old    JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::JSONB END;
  v_new    JSONB := to_jsonb(NEW);
  v_patch  JSONB := '{}'::JSONB;
  v_pairs  JSONB;
  v_pair   RECORD;
  v_was    TEXT := coalesce(v_old ->> 'status', '');
  v_is     TEXT := coalesce(v_new ->> 'status', '');
  v_now    TIMESTAMPTZ := now();
BEGIN
  IF v_uid IS NULL OR coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- Milestones that are a timestamp: {timestamp column: actor column}.
  v_pairs := CASE TG_TABLE_NAME
    WHEN 'jobs'            THEN '{"started_at": "started_by", "finished_at": "finished_by", "inspected_at": "inspected_by_user"}'
    WHEN 'quotes'          THEN '{"sent_at": "sent_by", "accepted_at": "accepted_by"}'
    WHEN 'invoices'        THEN '{"sent_date": "emailed_by"}'
    WHEN 'purchase_orders' THEN '{"received_at": "received_by"}'
    WHEN 'delivery_notes'  THEN '{"signed_at": "signed_recorded_by", "emailed_at": "emailed_by"}'
    WHEN 'credit_notes'    THEN '{"issued_at": "issued_by"}'
    ELSE '{}'
  END::JSONB;
  FOR v_pair IN SELECT key AS ts, value #>> '{}' AS actor FROM jsonb_each(v_pairs) LOOP
    IF nullif(v_new -> v_pair.ts, 'null'::JSONB) IS DISTINCT FROM nullif(v_old -> v_pair.ts, 'null'::JSONB) THEN
      v_patch := v_patch || jsonb_build_object(v_pair.actor, CASE WHEN nullif(v_new -> v_pair.ts, 'null'::JSONB) IS NULL THEN NULL ELSE to_jsonb(v_uid) END);
    END IF;
  END LOOP;

  IF TG_TABLE_NAME = 'invoices' THEN
    IF v_was IN ('', 'draft') AND v_is NOT IN ('', 'draft') THEN
      v_patch := v_patch || jsonb_build_object('issued_at', v_now, 'issued_by', v_uid);
      IF TG_OP = 'UPDATE' THEN
        PERFORM security_audit.log_named_event(v_org, 'ISSUE', 'invoices', NEW.id::TEXT, jsonb_build_object('invoice_ref', v_new ->> 'invoice_ref'));
      END IF;
    END IF;
    IF v_is = 'paid' AND v_was <> 'paid' THEN
      v_patch := v_patch || jsonb_build_object('paid_by', v_uid);
      PERFORM security_audit.log_named_event(v_org, 'MARK_PAID', 'invoices', NEW.id::TEXT,
        jsonb_build_object('invoice_ref', v_new ->> 'invoice_ref', 'paid_at', v_new -> 'paid_at'));
    ELSIF v_was = 'paid' AND v_is <> 'paid' THEN
      v_patch := v_patch || jsonb_build_object('paid_by', NULL::JSONB);
    END IF;
    IF nullif(v_old -> 'sent_date', 'null'::JSONB) IS NOT NULL AND nullif(v_new -> 'sent_date', 'null'::JSONB) IS NOT NULL
       AND v_new -> 'sent_date' IS DISTINCT FROM v_old -> 'sent_date' THEN
      PERFORM security_audit.log_named_event(v_org, 'RESEND', 'invoices', NEW.id::TEXT,
        jsonb_build_object('invoice_ref', v_new ->> 'invoice_ref', 'previous_by', v_old -> 'emailed_by', 'previous_at', v_old -> 'sent_date'));
    END IF;

  ELSIF TG_TABLE_NAME = 'quotes' THEN
    IF v_was = 'sent' AND v_is = 'sent' AND nullif(v_old -> 'sent_at', 'null'::JSONB) IS NOT NULL AND nullif(v_new -> 'sent_at', 'null'::JSONB) IS NOT NULL
       AND v_new -> 'sent_at' IS DISTINCT FROM v_old -> 'sent_at' THEN
      PERFORM security_audit.log_named_event(v_org, 'RESEND', 'quotes', NEW.id::TEXT,
        jsonb_build_object('quote_ref', v_new ->> 'quote_ref', 'previous_by', v_old -> 'sent_by', 'previous_at', v_old -> 'sent_at'));
    END IF;

  ELSIF TG_TABLE_NAME = 'sales_orders' THEN
    IF v_is = 'confirmed' AND v_was <> 'confirmed' THEN
      v_patch := v_patch || jsonb_build_object('confirmed_at', v_now, 'confirmed_by', v_uid);
      PERFORM security_audit.log_named_event(v_org, 'CONFIRM', 'sales_orders', NEW.id::TEXT, jsonb_build_object('so_number', v_new ->> 'so_number'));
    ELSIF v_was = 'confirmed' AND v_is = 'open' THEN
      v_patch := v_patch || jsonb_build_object('confirmed_at', NULL::JSONB, 'confirmed_by', NULL::JSONB);
    END IF;

  ELSIF TG_TABLE_NAME = 'delivery_notes' THEN
    IF v_is IN ('despatched', 'delivered', 'signed') AND v_was NOT IN ('despatched', 'delivered', 'signed') THEN
      v_patch := v_patch || jsonb_build_object('despatched_at', v_now, 'despatched_by', v_uid);
    END IF;

  ELSIF TG_TABLE_NAME = 'credit_notes' THEN
    IF v_was IN ('', 'draft') AND v_is = 'issued' AND TG_OP = 'UPDATE' THEN
      PERFORM security_audit.log_named_event(v_org, 'ISSUE', 'credit_notes', NEW.id::TEXT, jsonb_build_object('credit_ref', v_new ->> 'credit_ref'));
    END IF;

  ELSIF TG_TABLE_NAME = 'jobs' THEN
    -- Reopening: a finished job is made unfinished. The sign-off goes with it (as it does when the worksheet changes, 034).
    IF TG_OP = 'UPDATE' AND nullif(v_old -> 'finished_at', 'null'::JSONB) IS NOT NULL AND nullif(v_new -> 'finished_at', 'null'::JSONB) IS NULL THEN
      v_patch := v_patch || jsonb_build_object('inspected_at', NULL::JSONB, 'inspected_by', NULL::JSONB, 'inspected_by_user', NULL::JSONB);
      IF v_new ->> 'stage' IN ('inspection', 'complete') THEN
        v_patch := v_patch || jsonb_build_object('stage', 'machining');
      END IF;
      PERFORM security_audit.log_named_event(v_org, 'REOPEN', 'jobs', NEW.id::TEXT,
        jsonb_build_object('job_no', v_new ->> 'job_no', 'previous_finished_by', v_old -> 'finished_by', 'previous_finished_at', v_old -> 'finished_at',
                           'sign_off_withdrawn', nullif(v_old -> 'inspected_at', 'null'::JSONB) IS NOT NULL));
    END IF;
  END IF;

  IF v_patch <> '{}'::JSONB THEN
    NEW := jsonb_populate_record(NEW, v_patch);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.actor_stamp() FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'suppliers', 'machines', 'stock', 'rfqs', 'quotes', 'sales_orders', 'jobs', 'invoices', 'purchase_orders', 'delivery_notes', 'credit_notes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS aa_actor_keep ON public.%I', t);
    EXECUTE format('CREATE TRIGGER aa_actor_keep BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.actor_keep()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['quotes', 'sales_orders', 'jobs', 'invoices', 'purchase_orders', 'delivery_notes', 'credit_notes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zzz_actor_stamp ON public.%I', t);
    EXECUTE format('CREATE TRIGGER zzz_actor_stamp BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.actor_stamp()', t);
  END LOOP;
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Confirming imported payments ---------------------------------------------------------------------------
-- confirm_invoice_payments (034): the event is CONFIRM_STILL_OWED when the invoice has no payment recorded (the admin is saying it is
-- all still owed) and CONFIRM_PAYMENTS otherwise. Otherwise exactly as 034.
CREATE OR REPLACE FUNCTION public.confirm_invoice_payments(p_invoice UUID, p_note TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_user  UUID := auth.uid();
  v_note  TEXT := nullif(btrim(p_note), '');
  v_inv   RECORD;
  v_email TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NULL OR length(v_note) > 500 THEN
    RAISE EXCEPTION 'A note of up to 500 characters is required to confirm the payments.' USING ERRCODE = '22023';
  END IF;
  SELECT id, invoice_ref, status, total, amount_paid, credited_amount, refunded_amount, payment_unverified INTO v_inv
  FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_inv.payment_unverified THEN
    RAISE EXCEPTION '% has no payment waiting to be confirmed.', coalesce(v_inv.invoice_ref, 'This invoice') USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('quoteflow.invoice_payment', p_invoice::TEXT, TRUE);
  UPDATE public.invoices SET payment_unverified = FALSE WHERE id = p_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);
  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), CASE WHEN v_inv.amount_paid = 0 THEN 'CONFIRM_STILL_OWED' ELSE 'CONFIRM_PAYMENTS' END, 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'invoice_ref', v_inv.invoice_ref, 'amount_paid', v_inv.amount_paid,
                             'balance_due', v_inv.total - v_inv.amount_paid - (v_inv.credited_amount - v_inv.refunded_amount), 'note', v_note));
  RETURN jsonb_build_object('amount_paid', v_inv.amount_paid, 'balance_due', v_inv.total - v_inv.amount_paid - (v_inv.credited_amount - v_inv.refunded_amount), 'status', v_inv.status);
END
$$;
REVOKE ALL ON FUNCTION public.confirm_invoice_payments(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_invoice_payments(UUID, TEXT) TO authenticated;

-- write_audit (023): refuses the payment events (MARK_PAID, RECORD_PAYMENT, REVERSE_PAYMENT, CONFIRM_PAYMENTS, CONFIRM_STILL_OWED,
-- APPLY_CREDIT, REFUND_CUSTOMER_CREDIT) from a client unless the database's own function has set quoteflow.db_event. Otherwise exactly as 023.
CREATE OR REPLACE FUNCTION public.write_audit(p_action text, p_entity_table text, p_entity_id text, p_old jsonb, p_new jsonb, p_metadata jsonb, p_ip text, p_user_agent text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'security_audit'
AS $function$
DECLARE
  v_uid   UUID := auth.uid();
  v_org   UUID;
  v_email TEXT;
  v_ip    INET;
  v_meta  JSONB;
BEGIN
  -- Active user of an active organisation only.
  v_org := public.current_user_organization_id();
  IF v_uid IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  IF coalesce(btrim(p_action), '') = '' OR coalesce(btrim(p_entity_table), '') = '' THEN
    RAISE EXCEPTION 'action and entity table are required' USING ERRCODE = '22023';
  END IF;

  -- Payment events are written only by the database's own action functions and triggers (they set quoteflow.db_event for their
  -- statement). A client can't make one up, whatever its role: a made-up MARK_PAID would read as a real payment in the trail.
  IF btrim(p_action) IN ('MARK_PAID', 'RECORD_PAYMENT', 'REVERSE_PAYMENT', 'CONFIRM_PAYMENTS', 'CONFIRM_STILL_OWED', 'APPLY_CREDIT',
                         'REFUND_CUSTOMER_CREDIT')
     AND coalesce(current_setting('quoteflow.db_event', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION 'Payment events are recorded by the payment functions, not by the app.' USING ERRCODE = '42501';
  END IF;

  -- Only events the caller's role could really perform on that kind of record (023, audit SEC1). A person's own
  -- password change can only be recorded against themselves.
  IF NOT public.audit_event_allowed(btrim(p_action), btrim(p_entity_table))
     OR (btrim(p_action) = 'CHANGE_OWN_PASSWORD' AND p_entity_id IS DISTINCT FROM v_uid::TEXT) THEN
    RAISE EXCEPTION 'You can''t record that event.' USING ERRCODE = '42501';
  END IF;

  -- Size caps (rows are append-only forever, so keep each one small).
  IF octet_length(coalesce(p_old::TEXT, '')) > 65536
     OR octet_length(coalesce(p_new::TEXT, '')) > 65536
     OR octet_length(coalesce(p_metadata::TEXT, '')) > 16384 THEN
    RAISE EXCEPTION 'audit payload too large' USING ERRCODE = '22023';
  END IF;

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_uid AND p.active = TRUE;
  v_email := COALESCE(NULLIF(auth.jwt() ->> 'email', ''), v_email);

  -- x-forwarded-for may hold a list ("1.2.3.4, 5.6.7.8"): keep the first entry. Unparseable -> NULL.
  BEGIN
    v_ip := NULLIF(btrim(split_part(coalesce(p_ip, ''), ',', 1)), '')::INET;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  v_meta := CASE WHEN jsonb_typeof(p_metadata) = 'object' THEN p_metadata ELSE '{}'::JSONB END
            || jsonb_build_object('source', 'write_audit');

  INSERT INTO security_audit.audit_log (
    organization_id, actor_user_id, actor_email, action, entity_table, entity_id,
    old_data, new_data, metadata, ip_address, user_agent
  )
  VALUES (
    v_org,
    v_uid,
    v_email,
    left(btrim(p_action), 64),
    left(btrim(p_entity_table), 64),
    left(p_entity_id, 128),
    p_old,
    p_new,
    v_meta,
    v_ip,
    left(p_user_agent, 256)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.write_audit(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.write_audit(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT) TO authenticated;

-- org_activity (013, admins only): names only as well, the same rule as record_activity. Otherwise exactly as 013.
CREATE OR REPLACE FUNCTION public.org_activity(
  p_from   TIMESTAMPTZ DEFAULT NULL,
  p_to     TIMESTAMPTZ DEFAULT NULL,
  p_actor  UUID        DEFAULT NULL,
  p_table  TEXT        DEFAULT NULL,
  p_before TIMESTAMPTZ DEFAULT NULL,   -- "load more": the last row shown (time + id)
  p_before_id UUID     DEFAULT NULL,
  p_limit  INTEGER     DEFAULT 100
)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, actor_user_id UUID, actor_name TEXT, actor_email TEXT, action TEXT,
               entity_table TEXT, entity_id TEXT, record_table TEXT, record_id TEXT, record_label TEXT,
               changes JSONB, snapshot JSONB, metadata JSONB)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can view the activity log' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.id, a.created_at, a.actor_user_id,
         CASE WHEN a.actor_user_id IS NULL THEN 'System' ELSE cp.display_name END,
         NULL::TEXT, a.action, a.entity_table, a.entity_id,
         CASE a.entity_table
           WHEN 'quote_line_items' THEN 'quotes' WHEN 'quote_attachments' THEN 'quotes'
           WHEN 'invoice_line_items' THEN 'invoices' WHEN 'delivery_note_items' THEN 'delivery_notes'
           WHEN 'machine_bookings' THEN 'jobs' WHEN 'job_values' THEN 'jobs'
           ELSE a.entity_table END,
         CASE WHEN a.entity_table IN ('quote_line_items', 'invoice_line_items', 'delivery_note_items', 'machine_bookings', 'job_values')
              THEN security_audit.activity_parent(a.entity_table, a.old_data, a.new_data)
              ELSE a.entity_id END,
         security_audit.redact_emails(to_jsonb(coalesce(pl.parent_label, security_audit.activity_label(coalesce(a.new_data, a.old_data)))), v_org) #>> '{}',
         security_audit.redact_emails(CASE WHEN a.action = 'UPDATE' THEN security_audit.activity_changes(a.old_data, a.new_data) END, v_org),
         security_audit.redact_emails(CASE WHEN a.action IN ('INSERT', 'DELETE') THEN security_audit.activity_snapshot(coalesce(a.new_data, a.old_data))
              WHEN coalesce(a.metadata ->> 'source', '') = 'write_audit' THEN security_audit.activity_snapshot(coalesce(a.new_data, '{}'))
         END, v_org),
         security_audit.redact_emails(a.metadata - 'source', v_org)
  FROM security_audit.audit_log a
  LEFT JOIN public.company_people() cp ON cp.user_id = a.actor_user_id
  -- Child rows (lines, attachments, bookings) are labelled with their record's number.
  LEFT JOIN LATERAL (
    SELECT CASE a.entity_table
      WHEN 'quote_line_items'    THEN (SELECT q.quote_ref FROM public.quotes q WHERE q.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND q.organization_id = v_org)
      WHEN 'invoice_line_items'  THEN (SELECT i.invoice_ref FROM public.invoices i WHERE i.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND i.organization_id = v_org)
      WHEN 'delivery_note_items' THEN (SELECT d.dn_number FROM public.delivery_notes d WHERE d.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND d.organization_id = v_org)
      WHEN 'machine_bookings'    THEN (SELECT j.job_no FROM public.jobs j WHERE j.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND j.organization_id = v_org)
      WHEN 'job_values'          THEN (SELECT j.job_no FROM public.jobs j WHERE j.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND j.organization_id = v_org)
      WHEN 'quote_attachments'   THEN coalesce(a.new_data ->> 'quote_ref', a.old_data ->> 'quote_ref')
    END AS parent_label
  ) pl ON TRUE
  WHERE a.organization_id = v_org
    AND (p_from IS NULL OR a.created_at >= p_from)
    AND (p_to IS NULL OR a.created_at < p_to)
    AND (p_before IS NULL OR (a.created_at, a.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::UUID)))
    AND (p_actor IS NULL OR a.actor_user_id = p_actor)
    AND (p_table IS NULL OR a.entity_table = p_table
         OR (p_table = 'quotes' AND a.entity_table IN ('quote_line_items', 'quote_attachments'))
         OR (p_table = 'invoices' AND a.entity_table = 'invoice_line_items')
         OR (p_table = 'delivery_notes' AND a.entity_table = 'delivery_note_items')
         OR (p_table = 'jobs' AND a.entity_table IN ('machine_bookings', 'job_values')))
    AND NOT (a.action = 'UPDATE' AND security_audit.activity_changes(a.old_data, a.new_data) = '{}'::JSONB)
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. Backfill: only what the trail proves -------------------------------------------------------------------
-- For each milestone that already happened, the actor is filled from the row-change history (security_audit.audit_log, rows the
-- database wrote itself: metadata source database_trigger) when exactly ONE recorded change produced the value now on the row,
-- it was made by a signed-in user, and that user is a member of the row's company. Two or more candidate changes, none, an
-- unsigned change (the importer, the SQL editor) or a person outside the company leave the column empty. Nothing is overwritten.
-- Runs as the database owner, so none of the triggers above stamp anything.
DO $do$
DECLARE
  m RECORD;
BEGIN
  -- A timestamp column and the actor of the change that set it: (table, timestamp column, actor column).
  FOR m IN SELECT * FROM (VALUES
    ('jobs', 'started_at', 'started_by'), ('jobs', 'finished_at', 'finished_by'),
    ('quotes', 'sent_at', 'sent_by'), ('quotes', 'accepted_at', 'accepted_by'),
    ('invoices', 'sent_date', 'emailed_by'),
    ('purchase_orders', 'received_at', 'received_by'),
    ('delivery_notes', 'signed_at', 'signed_recorded_by'), ('delivery_notes', 'emailed_at', 'emailed_by'),
    ('credit_notes', 'issued_at', 'issued_by')
  ) AS v(tbl, ts, actor)
  LOOP
    EXECUTE format($q$
      WITH hits AS (
        SELECT t.id, count(*) AS n, (array_agg(a.actor_user_id))[1] AS actor
        FROM public.%1$I t
        JOIN security_audit.audit_log a
          ON a.entity_table = %1$L AND a.entity_id = t.id::TEXT AND a.organization_id = t.organization_id
         AND a.action IN ('INSERT', 'UPDATE') AND a.actor_user_id IS NOT NULL AND a.metadata ->> 'source' = 'database_trigger'
         AND nullif(a.new_data -> %2$L, 'null'::JSONB) IS DISTINCT FROM nullif(a.old_data -> %2$L, 'null'::JSONB)
         AND CASE WHEN pg_input_is_valid(a.new_data ->> %2$L, 'timestamptz') THEN (a.new_data ->> %2$L)::TIMESTAMPTZ END = t.%2$I
        WHERE t.%3$I IS NULL AND t.%2$I IS NOT NULL
        GROUP BY t.id
      )
      UPDATE public.%1$I t SET %3$I = h.actor
      FROM hits h
      WHERE t.id = h.id AND h.n = 1
        AND EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = h.actor AND om.organization_id = t.organization_id)
    $q$, m.tbl, m.ts, m.actor);
  END LOOP;

  -- Status milestones: the change that moved the status into the milestone, and (when the row has no time yet) its time.
  FOR m IN SELECT * FROM (VALUES
    ('invoices', 'issued_by', 'issued_at', $c$coalesce(a.old_data ->> 'status', 'draft') = 'draft' AND coalesce(a.new_data ->> 'status', 'draft') <> 'draft'$c$),
    ('sales_orders', 'confirmed_by', 'confirmed_at', $c$coalesce(a.old_data ->> 'status', '') <> 'confirmed' AND a.new_data ->> 'status' = 'confirmed'$c$),
    ('delivery_notes', 'despatched_by', 'despatched_at',
       $c$coalesce(a.old_data ->> 'status', '') NOT IN ('despatched', 'delivered', 'signed') AND a.new_data ->> 'status' IN ('despatched', 'delivered', 'signed')$c$)
  ) AS v(tbl, actor, ts, cond)
  LOOP
    EXECUTE format($q$
      WITH hits AS (
        SELECT t.id, count(*) AS n, (array_agg(a.actor_user_id))[1] AS actor, (array_agg(a.created_at))[1] AS at
        FROM public.%1$I t
        JOIN security_audit.audit_log a
          ON a.entity_table = %1$L AND a.entity_id = t.id::TEXT AND a.organization_id = t.organization_id
         AND a.action IN ('INSERT', 'UPDATE') AND a.actor_user_id IS NOT NULL AND a.metadata ->> 'source' = 'database_trigger'
         AND %4$s
        WHERE t.%2$I IS NULL
        GROUP BY t.id
      )
      UPDATE public.%1$I t SET %2$I = h.actor, %3$I = coalesce(t.%3$I, h.at)
      FROM hits h
      WHERE t.id = h.id AND h.n = 1
        AND EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = h.actor AND om.organization_id = t.organization_id)
    $q$, m.tbl, m.actor, m.ts, m.cond);
  END LOOP;
END
$do$;

-- An invoice that is paid, with only recorded payments and no reversal or credit, was cleared by the payment that took the running
-- total to the invoice total: that payment's recorder is paid_by.
WITH running AS (
  SELECT p.invoice_id, p.created_by, p.created_at,
         sum(p.amount) OVER (PARTITION BY p.invoice_id ORDER BY p.created_at, p.id) AS total_so_far,
         sum(p.amount) OVER (PARTITION BY p.invoice_id ORDER BY p.created_at, p.id) - p.amount AS before_this
  FROM public.invoice_payments p
), clearing AS (
  SELECT r.invoice_id, (array_agg(r.created_by))[1] AS actor, count(*) AS n
  FROM running r JOIN public.invoices i ON i.id = r.invoice_id
  WHERE i.status = 'paid' AND i.credited_amount = 0 AND r.before_this < i.total AND r.total_so_far >= i.total
  GROUP BY r.invoice_id
)
UPDATE public.invoices i SET paid_by = c.actor
FROM clearing c
WHERE i.id = c.invoice_id AND c.n = 1 AND i.paid_by IS NULL AND c.actor IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id AND (p.source <> 'recorded' OR p.reverses_payment_id IS NOT NULL))
  AND EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = c.actor AND om.organization_id = i.organization_id);

-- A released job whose release is the one inspection record made at that moment, by a signed-in inspector of the company.
UPDATE public.jobs j SET inspected_by_user = i.inspector_id
FROM (
  SELECT job_id, inspected_at, (array_agg(inspector_id))[1] AS inspector_id, count(*) AS n
  FROM public.job_inspections WHERE release_decision = 'released' AND inspector_id IS NOT NULL
  GROUP BY job_id, inspected_at
) i
WHERE i.job_id = j.id AND i.inspected_at = j.inspected_at AND i.n = 1 AND j.inspected_by_user IS NULL AND j.inspected_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = i.inspector_id AND om.organization_id = j.organization_id);

-- -----------------------------------------------------------------------------------------------------
-- ---- 7. No e-mail address as an inspector's name, on an upgrade too ---------------------------------------------
-- 034 keeps addresses out of jobs.inspected_by and job_inspections.inspector_name, but job_inspections' rule sits in its CREATE TABLE,
-- which does nothing to a table that already exists. Existing values that hold an @ are replaced by the person's display name (the
-- inspector's, when known and usable) or 'Inspector', and then each column gets a named rule, added to the existing table, so it holds
-- after an upgrade as well as on a fresh build. Runs as the database owner, so no trigger stamps or refuses anything.
UPDATE public.job_inspections i
SET inspector_name = coalesce((SELECT left(btrim(p.full_name), 100) FROM public.user_profiles p
                               WHERE p.id = i.inspector_id AND nullif(btrim(p.full_name), '') IS NOT NULL AND position('@' IN p.full_name) = 0), 'Inspector')
WHERE position('@' IN i.inspector_name) > 0;
UPDATE public.jobs j
SET inspected_by = coalesce((SELECT left(btrim(p.full_name), 100) FROM public.user_profiles p
                             WHERE p.id = j.inspected_by_user AND nullif(btrim(p.full_name), '') IS NOT NULL AND position('@' IN p.full_name) = 0), 'Inspector')
WHERE position('@' IN j.inspected_by) > 0;
-- The updates above can leave deferred checks queued (017's link checks on jobs), and a table with queued events can't be altered:
-- run them now. Nothing after this section relies on a deferred check.
SET CONSTRAINTS ALL IMMEDIATE;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_inspections_inspector_name_no_email' AND conrelid = 'public.job_inspections'::regclass) THEN
    ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_inspector_name_no_email CHECK (position('@' IN inspector_name) = 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_inspected_by_no_email' AND conrelid = 'public.jobs'::regclass) THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_inspected_by_no_email CHECK (inspected_by IS NULL OR position('@' IN inspected_by) = 0);
  END IF;
END
$do$;

-- Check. Expect: people_function = true, keep_triggers = 12, stamp_triggers = 7, record_activity_reads_email = false.
SELECT
  (SELECT count(*) = 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'company_people') AS people_function,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'aa_actor_keep' AND NOT tgisinternal) AS keep_triggers,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'zzz_actor_stamp' AND NOT tgisinternal) AS stamp_triggers,
  (SELECT position('a.actor_email' IN prosrc) > 0 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'record_activity') AS record_activity_reads_email;
