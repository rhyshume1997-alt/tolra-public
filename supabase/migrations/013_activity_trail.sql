-- =====================================================================================================
-- 013: ACTIVITY TRAIL
--
-- Builds on security_audit.audit_log (000/006): append-only (a trigger refuses UPDATE / DELETE, clients can't
-- INSERT), hash-chained, one row per insert / update / delete on the business tables, written by the database
-- itself, so nothing done through the app can skip it.
--
-- 1. Row-change auditing also for the child rows shown on a record's timeline: quote lines and attachments,
--    invoice lines, delivery-note lines, machine bookings.
-- 2. security_audit.activity_changes(): which fields changed, with short before / after values (never whole rows).
-- 3. public.record_activity(table, id): the timeline of one quote / job / sales order / invoice / PO / delivery
--    note and its child rows, for anyone allowed to see that record (same roles and page access as its RLS).
-- 4. public.org_activity(...): the admin-only Activity page, filtered by person, record type and date.
-- Both return only this organisation's rows. Nothing here can change or delete an entry.
-- Run after 012. Safe to re-run.
-- =====================================================================================================

-- ----- 1. audit triggers on child tables --------------------------------------------------------------
DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote_line_items', 'quote_attachments', 'invoice_line_items', 'delivery_note_items', 'machine_bookings']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_' || t || '_changes', t);
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change()',
                     'audit_' || t || '_changes', t);
    END IF;
  END LOOP;
END
$do$;

-- The record a child row belongs to ("quote_ref:Q-1" for attachments, which are linked by reference).
CREATE OR REPLACE FUNCTION security_audit.activity_parent(p_table TEXT, p_old JSONB, p_new JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_table
    WHEN 'quote_line_items'    THEN coalesce(p_new ->> 'quote_id', p_old ->> 'quote_id')
    WHEN 'invoice_line_items'  THEN coalesce(p_new ->> 'invoice_id', p_old ->> 'invoice_id')
    WHEN 'delivery_note_items' THEN coalesce(p_new ->> 'delivery_note_id', p_old ->> 'delivery_note_id')
    WHEN 'machine_bookings'    THEN coalesce(p_new ->> 'job_id', p_old ->> 'job_id')
    WHEN 'job_values'          THEN coalesce(p_new ->> 'job_id', p_old ->> 'job_id')
    WHEN 'quote_attachments'   THEN 'quote_ref:' || coalesce(p_new ->> 'quote_ref', p_old ->> 'quote_ref')
  END
$$;

CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON security_audit.audit_log (organization_id, entity_table, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_parent_idx ON security_audit.audit_log
  (organization_id, security_audit.activity_parent(entity_table, old_data, new_data), created_at DESC)
  WHERE entity_table IN ('quote_line_items', 'invoice_line_items', 'delivery_note_items', 'machine_bookings', 'job_values', 'quote_attachments');

-- ----- 2. changed fields --------------------------------------------------------------------------------
-- Short text for a value: arrays and objects are summarised, long text is cut.
CREATE OR REPLACE FUNCTION security_audit.activity_value(p_value JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN 'null'::JSONB
    WHEN jsonb_typeof(p_value) = 'string' THEN to_jsonb(left(p_value #>> '{}', 160))
    WHEN jsonb_typeof(p_value) IN ('number', 'boolean') THEN p_value
    ELSE to_jsonb(left(p_value::TEXT, 160))
  END
$$;

-- { field: { "from": v, "to": v } } for scalar fields; { field: { "added": [...], "removed": [...] } } for arrays
-- (e.g. drawings); { field: { "changed": true } } for objects (e.g. the worksheet checklist, with the ticked keys).
-- Bookkeeping columns are left out.
CREATE OR REPLACE FUNCTION security_audit.activity_changes(p_old JSONB, p_new JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_object_agg(k, CASE
           WHEN jsonb_typeof(p_new -> k) = 'array' OR jsonb_typeof(p_old -> k) = 'array' THEN jsonb_build_object(
             'added',   coalesce((SELECT jsonb_agg(security_audit.activity_value(e)) FROM jsonb_array_elements(coalesce(p_new -> k, '[]')) e
                                  WHERE NOT coalesce(p_old -> k, '[]') @> jsonb_build_array(e)), '[]'),
             'removed', coalesce((SELECT jsonb_agg(security_audit.activity_value(e)) FROM jsonb_array_elements(coalesce(p_old -> k, '[]')) e
                                  WHERE NOT coalesce(p_new -> k, '[]') @> jsonb_build_array(e)), '[]'))
           WHEN jsonb_typeof(p_new -> k) = 'object' OR jsonb_typeof(p_old -> k) = 'object' THEN jsonb_build_object(
             'changed', TRUE,
             'keys', coalesce((SELECT jsonb_agg(kk) FROM (
                        SELECT kk FROM jsonb_object_keys(coalesce(p_new -> k, '{}') || coalesce(p_old -> k, '{}')) kk
                        WHERE (p_new -> k -> kk) IS DISTINCT FROM (p_old -> k -> kk) LIMIT 20) x), '[]'))
           ELSE jsonb_build_object('from', security_audit.activity_value(p_old -> k), 'to', security_audit.activity_value(p_new -> k))
         END), '{}'::JSONB)
  FROM (
    SELECT k FROM jsonb_object_keys(coalesce(p_new, '{}') || coalesce(p_old, '{}')) k
    WHERE k NOT IN ('id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'position')
      AND (p_new -> k) IS DISTINCT FROM (p_old -> k)
  ) keys
$$;

-- Key fields kept on a create / delete so the timeline can say what was created (never the whole row).
CREATE OR REPLACE FUNCTION security_audit.activity_snapshot(p_row JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_object_agg(k, security_audit.activity_value(p_row -> k)), '{}'::JSONB)
  FROM unnest(ARRAY['quote_ref', 'invoice_ref', 'so_number', 'po_ref', 'po_number', 'dn_number', 'job_no', 'customer',
                    'supplier', 'description', 'status', 'quantity', 'unit_price', 'file_name', 'start_at', 'name', 'email']) k
  WHERE p_row ? k AND jsonb_typeof(p_row -> k) <> 'null'
$$;

CREATE OR REPLACE FUNCTION security_audit.activity_label(p_row JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT left(coalesce(p_row ->> 'quote_ref', p_row ->> 'invoice_ref', p_row ->> 'so_number', p_row ->> 'po_ref',
                       p_row ->> 'po_number', p_row ->> 'dn_number', p_row ->> 'job_no', p_row ->> 'name',
                       p_row ->> 'full_name', p_row ->> 'email', p_row ->> 'file_name', p_row ->> 'description'), 80)
$$;

-- ----- 3. record_activity -------------------------------------------------------------------------------
-- Same access as the record's own RLS: role, page access (012) and organisation.
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
    WHEN 'sales_orders'    THEN public.has_org_role(ARRAY['admin']) AND public.section_allowed('sales-orders')
    WHEN 'invoices'        THEN public.has_org_role(ARRAY['admin']) AND public.section_allowed('invoices')
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
         coalesce(nullif(p.full_name, ''), a.actor_email, CASE WHEN a.actor_user_id IS NULL THEN 'System' END),
         a.actor_email, a.action, a.entity_table, a.entity_id,
         CASE WHEN a.action = 'UPDATE' THEN security_audit.activity_changes(a.old_data, a.new_data) END,
         CASE WHEN a.action IN ('INSERT', 'DELETE') THEN security_audit.activity_snapshot(coalesce(a.new_data, a.old_data))
              WHEN coalesce(a.metadata ->> 'source', '') = 'write_audit' THEN security_audit.activity_snapshot(coalesce(a.new_data, '{}'))
         END,
         a.metadata - 'source'
  FROM security_audit.audit_log a
  LEFT JOIN public.user_profiles p ON p.id = a.actor_user_id
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
  ORDER BY a.created_at DESC, a.id
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.record_activity(TEXT, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_activity(TEXT, UUID, INTEGER) TO authenticated;

-- ----- 4. org_activity (admins) -------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER);
CREATE FUNCTION public.org_activity(
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
         coalesce(nullif(p.full_name, ''), a.actor_email, CASE WHEN a.actor_user_id IS NULL THEN 'System' END),
         a.actor_email, a.action, a.entity_table, a.entity_id,
         CASE a.entity_table
           WHEN 'quote_line_items' THEN 'quotes' WHEN 'quote_attachments' THEN 'quotes'
           WHEN 'invoice_line_items' THEN 'invoices' WHEN 'delivery_note_items' THEN 'delivery_notes'
           WHEN 'machine_bookings' THEN 'jobs' WHEN 'job_values' THEN 'jobs'
           ELSE a.entity_table END,
         CASE WHEN a.entity_table IN ('quote_line_items', 'invoice_line_items', 'delivery_note_items', 'machine_bookings', 'job_values')
              THEN security_audit.activity_parent(a.entity_table, a.old_data, a.new_data)
              ELSE a.entity_id END,
         coalesce(pl.parent_label, security_audit.activity_label(coalesce(a.new_data, a.old_data))),
         CASE WHEN a.action = 'UPDATE' THEN security_audit.activity_changes(a.old_data, a.new_data) END,
         CASE WHEN a.action IN ('INSERT', 'DELETE') THEN security_audit.activity_snapshot(coalesce(a.new_data, a.old_data))
              WHEN coalesce(a.metadata ->> 'source', '') = 'write_audit' THEN security_audit.activity_snapshot(coalesce(a.new_data, '{}'))
         END,
         a.metadata - 'source'
  FROM security_audit.audit_log a
  LEFT JOIN public.user_profiles p ON p.id = a.actor_user_id
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

-- Check. Expect: child_triggers = 5, functions = 2, append_only = 1, client_writes = false.
SELECT
  (SELECT count(*) FROM pg_trigger WHERE tgname IN ('audit_quote_line_items_changes', 'audit_quote_attachments_changes',
     'audit_invoice_line_items_changes', 'audit_delivery_note_items_changes', 'audit_machine_bookings_changes')) AS child_triggers,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('record_activity', 'org_activity')) AS functions,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'audit_log_prevent_mutation') AS append_only,
  has_table_privilege('authenticated', 'security_audit.audit_log', 'INSERT, UPDATE, DELETE') AS client_writes;
