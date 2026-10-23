-- =====================================================================================================
-- 024: record history doesn't show money to people who may not see it (audit B7a: SEC8).
--
-- Workshop and viewer staff can open a job's history (and workshop a delivery note's). Current job values live in
-- job_values (009), whose history is already hidden from them, but older audit rows can still carry money: jobs.value
-- changes from before 009, imported history, and amounts an app event put in its metadata.
-- Now record_activity removes money-named fields (value, price, cost, amount, total, VAT, paid, balance, rate, ...)
-- at any depth from changes, snapshots and metadata unless the caller is admin or office, and drops an update that
-- changed nothing else. The stored audit log is unchanged; admin and office still see everything.
-- org_activity is admin-only and unchanged. Same signature and grants. Forward only, safe to run more than once.
-- =====================================================================================================

-- A key names money if one of its underscore-separated words does (unit_price, total_value, vat_pct, amount_paid).
CREATE OR REPLACE FUNCTION security_audit.is_money_key(p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT lower(p_key) ~ '(^|_)(value|values|price|prices|pricing|cost|costs|costing|amount|amounts|total|totals|subtotal|vat|net|gross|margin|markup|paid|balance|rate|rates|charge|charges|fee|fees|pence|gbp|money|invoice_value|order_value)($|_)'
$$;

CREATE OR REPLACE FUNCTION security_audit.redact_money(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_out JSONB;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(e.key, security_audit.redact_money(e.value)), '{}'::JSONB) INTO v_out
      FROM jsonb_each(p_value) e
      WHERE NOT security_audit.is_money_key(e.key);
      RETURN v_out;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(security_audit.redact_money(e.value) ORDER BY e.n), '[]'::JSONB) INTO v_out
      FROM jsonb_array_elements(p_value) WITH ORDINALITY e(value, n);
      RETURN v_out;
    ELSE
      RETURN p_value;
  END CASE;
END
$$;

CREATE OR REPLACE FUNCTION security_audit.redact_unless(p_allowed BOOLEAN, p_value JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_allowed OR p_value IS NULL THEN p_value ELSE security_audit.redact_money(p_value) END
$$;

REVOKE ALL ON FUNCTION security_audit.is_money_key(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION security_audit.redact_money(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION security_audit.redact_unless(BOOLEAN, JSONB) FROM PUBLIC;

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
         security_audit.redact_unless(v_values, CASE WHEN a.action = 'UPDATE' THEN security_audit.activity_changes(a.old_data, a.new_data) END),
         security_audit.redact_unless(v_values,
           CASE WHEN a.action IN ('INSERT', 'DELETE') THEN security_audit.activity_snapshot(coalesce(a.new_data, a.old_data))
                WHEN coalesce(a.metadata ->> 'source', '') = 'write_audit' THEN security_audit.activity_snapshot(coalesce(a.new_data, '{}'))
           END),
         security_audit.redact_unless(v_values, a.metadata - 'source')
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
    -- ... nor does one that changed only money, for someone who may not see money
    AND NOT (NOT v_values AND a.action = 'UPDATE'
             AND security_audit.redact_money(security_audit.activity_changes(a.old_data, a.new_data)) = '{}'::JSONB)
  ORDER BY a.created_at DESC, a.id
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.record_activity(TEXT, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_activity(TEXT, UUID, INTEGER) TO authenticated;
