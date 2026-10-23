-- =====================================================================================================
-- 023: the audit log only accepts events the caller could really have performed (audit B7a: SEC1, A5).
--
-- Before: any active member, viewers included, could call write_audit with any action on any table ("MARK_PAID
-- invoices", "DELETE customers"), so the log could hold claims nobody made. Actor and organisation were already
-- taken from the session and can't be chosen.
-- Now public.audit_event_allowed(action, table) decides, using the same roles as the data rules:
--   * read events (EXPORT, PRINT_PACK, DOWNLOAD_PDF, DOWNLOAD_ATTACHMENT, EMAIL_COPIED): roles that can read that
--     kind of record;
--   * write events (CREATE, UPDATE, SEND, MARK_PAID, ...): roles that can change that kind of record;
--   * user management events: admins; CHANGE_OWN_PASSWORD: anyone, about themselves only;
--   * anything else: refused.
-- Rows written by the database's own triggers are unaffected and remain the authoritative record of changes.
-- Same signature and grants for write_audit. Forward only, safe to run more than once.
-- =====================================================================================================

CREATE OR REPLACE FUNCTION public.audit_event_allowed(p_action TEXT, p_table TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_read  TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin'] WHEN 'sales_orders' THEN ARRAY['admin']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop', 'viewer'] WHEN 'machines' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
  END;
  v_write TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'machines' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin'] WHEN 'sales_orders' THEN ARRAY['admin']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop'] WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
  END;
BEGIN
  IF p_action = 'CHANGE_OWN_PASSWORD' THEN
    RETURN p_table = 'user_profiles';
  END IF;
  IF p_action IN ('CREATE_USER', 'SET_USER_PASSWORD', 'UPDATE_USERNAME', 'UPDATE_USER_ACCESS', 'DEACTIVATE_USER',
                  'REACTIVATE_USER', 'INVITE_USER', 'PASSWORD_RESET_PREPARED') THEN
    RETURN p_table = 'user_profiles' AND public.has_org_role(ARRAY['admin']);
  END IF;
  IF p_action IN ('EXPORT', 'PRINT_PACK', 'DOWNLOAD_PDF', 'DOWNLOAD_ATTACHMENT', 'EMAIL_COPIED') THEN
    RETURN v_read IS NOT NULL AND public.has_org_role(v_read);
  END IF;
  IF p_action IN ('CREATE', 'UPDATE', 'DELETE', 'SEND', 'DESPATCH', 'ACCEPT', 'REJECT', 'UPDATE_WORKSHEET',
                  'UPLOAD_DRAWING', 'CONVERT_TO_JOB', 'SEND_TO_WORKSHOP', 'MARK_RECEIVED', 'MARK_PAID', 'MARK_SIGNED',
                  'UPLOAD_ATTACHMENT', 'EMAIL_SENT_MANUALLY', 'DRAFT_CHASERS', 'CREATE_SUPPLIER', 'DELETE_SUPPLIER',
                  'ORGANIZATION_SETTINGS_UPDATE') THEN
    RETURN v_write IS NOT NULL AND public.has_org_role(v_write);
  END IF;
  RETURN FALSE;
END
$$;

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
