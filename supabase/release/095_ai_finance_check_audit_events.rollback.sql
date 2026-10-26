-- 095 rollback: ONLY with Rhys's approval. Puts back 076's public.audit_event_allowed and 035's public.write_audit byte for byte (same
-- signatures, security and grants): the audit log then refuses the four finance-check events again (42501) and the check answers
-- "Check not available". Rows already written stay (the audit log is append-only). Every other event is unaffected either way. Run the
-- whole text as one transaction, then the release preflight (marker 095 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_aea TEXT;
  v_wa  TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.audit_event_allowed(text,text)') INTO v_aea;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)') INTO v_wa;
  -- 7e8d3965... / a6531bb5...: 095's bodies; 35078684... / 959f7598...: 076's and 035's (a second run of this rollback).
  IF v_aea IS NULL OR v_aea NOT IN ('7e8d396511ddb056daa61953bfccd12b', '35078684fa2379d7708c06fa7994dcf3') THEN
    RAISE EXCEPTION '095 rollback: audit_event_allowed (md5 %) is neither 095''s nor 076''s; stop and compare', coalesce(v_aea, 'missing');
  END IF;
  IF v_wa IS NULL OR v_wa NOT IN ('a6531bb5559ae9936387729bb91071a0', '959f759894cd9dbefbf8d25768530197') THEN
    RAISE EXCEPTION '095 rollback: write_audit (md5 %) is neither 095''s nor 035''s; stop and compare', coalesce(v_wa, 'missing');
  END IF;
END
$$;

-- 076's audit_event_allowed, verbatim (supabase/migrations/076_data_import.sql section 4).
CREATE OR REPLACE FUNCTION public.audit_event_allowed(p_action TEXT, p_table TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_read  TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin', 'office'] WHEN 'sales_orders' THEN ARRAY['admin', 'office']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop', 'viewer'] WHEN 'machines' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
    -- 076: the payments export (032's invoice_payments) and the weekly hours export (052's time_week_approvals).
    WHEN 'invoice_payments' THEN ARRAY['admin', 'office'] WHEN 'time_week_approvals' THEN ARRAY['admin', 'office']
  END;
  v_write TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'machines' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin', 'office'] WHEN 'sales_orders' THEN ARRAY['admin', 'office']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop'] WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
  END;
BEGIN
  IF p_action = 'CHANGE_OWN_PASSWORD' THEN
    RETURN p_table = 'user_profiles';
  END IF;
  IF p_action IN ('CREATE_USER', 'SET_USER_PASSWORD', 'UPDATE_USERNAME', 'UPDATE_USER_ACCESS', 'DEACTIVATE_USER',
                  'REACTIVATE_USER', 'INVITE_USER', 'PASSWORD_RESET_PREPARED', 'RESET_MFA') THEN
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
$function$;

-- 035's write_audit, verbatim (supabase/migrations/035_who_did_what.sql).
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

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '35078684fa2379d7708c06fa7994dcf3' OR p.prosecdef OR p.provolatile <> 's'
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.audit_event_allowed(text,text)')) THEN
    RAISE EXCEPTION '095 rollback: audit_event_allowed is not 076''s afterwards';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '959f759894cd9dbefbf8d25768530197' OR NOT p.prosecdef OR p.provolatile <> 'v'
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, security_audit']
             OR has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)')) THEN
    RAISE EXCEPTION '095 rollback: write_audit is not 035''s afterwards';
  END IF;
END
$$;
COMMIT;
