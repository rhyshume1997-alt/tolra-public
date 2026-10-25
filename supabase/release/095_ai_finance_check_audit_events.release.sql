-- 095_ai_finance_check_audit_events.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 095: the audit log accepts Tolra AI agent 1's four events (the suggest-only pre-issue finance check, AI_FINANCE_CHECK_ENABLED,
-- branch public/ai-finance-check). Until this is applied write_audit refuses them (42501) and the check answers "Check not available"
-- (lib/ai/finance-check/audit.ts: the check never runs unaudited). NUMBERING (provisional): 094 is the Activity fix (one row per change,
-- branch public/activity-094); the per-user display preferences, once 094 then 095, move to 096. Needs 076 (audit_event_allowed) and
-- 035 (write_audit). INDEPENDENT OF 094: 094 replaces only public.org_activity, 095 only audit_event_allowed and write_audit, so they
-- touch no common object and apply in either order (the release order is 094 then 095). Touches none of 081 to 093's objects.
--
-- WHAT CHANGES. Two functions, each its predecessor's text with one added block (marked 095). No table, row, trigger, policy or grant.
--   a. public.audit_event_allowed (076's): four action names, ai_finance_check_requested, ai_finance_check_completed, ai_suggestion_accepted, ai_suggestion_rejected,
--      allowed only on invoices, purchase_orders and credit_notes, for admin and office (the roles the route accepts,
--      lib/ai/finance-check/request.ts FINANCE_CHECK_ROLES). Every other action, table and role answer is unchanged.
--   b. public.write_audit (035's): for those four actions only, the call must be exactly what writeAiAudit sends. No old or new row; the
--      document's id (a UUID); metadata with checker "rules-v1" and the kind its table holds (invoice, purchase_order, credit_note), and
--      requested:          {kind, checker}
--      completed:          {kind, checker, count, codes}  count a whole number (0 to 999999), codes distinct suggestion codes, no more than count
--      accepted, rejected: {kind, checker, suggestion_id, code}  code a suggestion code, suggestion_id "<code>:<scope>" (request.ts's pattern)
--      and no other key (ids, the kind, codes and counts only: no names, amounts or document text). The codes are check.ts's
--      SUGGESTION_CODES. Anything else is refused as an unknown event is (42501 "You can't record that event."). Every other event goes
--      through write_audit exactly as before; the stored row is written as before (source write_audit, the caller's company).
-- GUARD (section 1): audit_event_allowed must be 076's (or already 095's) and write_audit 035's (or already 095's), md5 with every
-- whitespace character removed. Safe to run again.
-- SELF-CHECK (section 4): both bodies are 095's; audit_event_allowed invoker and STABLE, write_audit definer; search_paths as before;
-- write_audit signed-in only.
-- Rollback: supabase/release/095_ai_finance_check_audit_events.rollback.sql (076's and 035's functions back; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: the functions being replaced are 076's and 035's (or already 095's).
DO $$
DECLARE
  v_aea TEXT;
  v_wa  TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.audit_event_allowed(text,text)') INTO v_aea;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)') INTO v_wa;
  -- 35078684fa2379d7708c06fa7994dcf3: 076's audit_event_allowed; 7e8d396511ddb056daa61953bfccd12b: this file's (section 2); both with every whitespace character removed.
  IF v_aea IS NULL OR v_aea NOT IN ('35078684fa2379d7708c06fa7994dcf3', '7e8d396511ddb056daa61953bfccd12b') THEN
    RAISE EXCEPTION '095: public.audit_event_allowed is not 076''s (md5 without whitespace %); stop and compare it first', coalesce(v_aea, 'missing');
  END IF;
  -- 959f759894cd9dbefbf8d25768530197: 035's write_audit; a6531bb5559ae9936387729bb91071a0: this file's (section 3).
  IF v_wa IS NULL OR v_wa NOT IN ('959f759894cd9dbefbf8d25768530197', 'a6531bb5559ae9936387729bb91071a0') THEN
    RAISE EXCEPTION '095: public.write_audit is not 035''s (md5 without whitespace %); stop and compare it first', coalesce(v_wa, 'missing');
  END IF;
  IF to_regclass('public.credit_notes') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL THEN
    RAISE EXCEPTION '095: public.credit_notes (034) or has_org_role(text[]) is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. audit_event_allowed: 076's (supabase/migrations/076_data_import.sql section 4) plus the block marked 095.
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
  -- 095: Tolra AI agent 1, the pre-issue finance check (suggest only; lib/ai/finance-check/audit.ts). Its four events, on the three
  -- documents it checks only, for the roles that may run it (admin and office). write_audit (095) holds their metadata to the app's shape.
  IF p_action IN ('ai_finance_check_requested', 'ai_finance_check_completed', 'ai_suggestion_accepted', 'ai_suggestion_rejected') THEN
    RETURN p_table IN ('invoices', 'purchase_orders', 'credit_notes') AND public.has_org_role(ARRAY['admin', 'office']);
  END IF;
  RETURN FALSE;
END
$function$;

-- -----------------------------------------------------------------------------------------------------
-- 3. write_audit: 035's (supabase/migrations/035_who_did_what.sql) plus the block marked 095.
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

  -- 095: the finance-check events (audit_event_allowed, 095) carry ids, the kind, codes and counts only, exactly as
  -- lib/ai/finance-check/audit.ts sends them: no old or new row, the document's id, checker rules-v1, the kind its table holds, and
  -- requested {kind, checker}; completed {kind, checker, count, codes}; accepted / rejected {kind, checker, suggestion_id, code}.
  -- No other key: no names, amounts or document text. Every other event is checked exactly as before.
  IF btrim(p_action) IN ('ai_finance_check_requested', 'ai_finance_check_completed', 'ai_suggestion_accepted', 'ai_suggestion_rejected')
     AND (CASE
       WHEN p_old IS NOT NULL OR p_new IS NOT NULL OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
            OR p_entity_id IS NULL OR p_entity_id !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
            OR p_metadata -> 'checker' IS DISTINCT FROM '"rules-v1"'::JSONB
            OR p_metadata -> 'kind' IS DISTINCT FROM CASE btrim(p_entity_table) WHEN 'invoices' THEN '"invoice"'::JSONB
                                                       WHEN 'purchase_orders' THEN '"purchase_order"'::JSONB WHEN 'credit_notes' THEN '"credit_note"'::JSONB END
         THEN FALSE
       WHEN btrim(p_action) = 'ai_finance_check_requested'
         THEN ARRAY(SELECT k FROM jsonb_object_keys(p_metadata) k ORDER BY k COLLATE "C") = ARRAY['checker', 'kind']
       WHEN btrim(p_action) = 'ai_finance_check_completed'
         THEN ARRAY(SELECT k FROM jsonb_object_keys(p_metadata) k ORDER BY k COLLATE "C") = ARRAY['checker', 'codes', 'count', 'kind']
              AND CASE WHEN jsonb_typeof(p_metadata -> 'count') = 'number' AND (p_metadata ->> 'count') ~ '^[0-9]{1,6}$'
                            AND jsonb_typeof(p_metadata -> 'codes') = 'array'
                       THEN jsonb_array_length(p_metadata -> 'codes') <= (p_metadata ->> 'count')::INT
                            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_metadata -> 'codes') c
                                            WHERE jsonb_typeof(c) <> 'string' OR (c #>> '{}') <> ALL (ARRAY['qty_mismatch', 'price_mismatch', 'vat_mismatch', 'totals_mismatch', 'missing_customer_po', 'possible_duplicate', 'credit_exceeds_balance', 'delivery_not_despatched']))
                            AND (SELECT count(DISTINCT c) = count(*) FROM jsonb_array_elements(p_metadata -> 'codes') c)
                       ELSE FALSE END
       ELSE ARRAY(SELECT k FROM jsonb_object_keys(p_metadata) k ORDER BY k COLLATE "C") = ARRAY['checker', 'code', 'kind', 'suggestion_id']
            AND CASE WHEN jsonb_typeof(p_metadata -> 'code') = 'string' AND jsonb_typeof(p_metadata -> 'suggestion_id') = 'string'
                     THEN (p_metadata ->> 'code') = ANY (ARRAY['qty_mismatch', 'price_mismatch', 'vat_mismatch', 'totals_mismatch', 'missing_customer_po', 'possible_duplicate', 'credit_exceeds_balance', 'delivery_not_despatched'])
                          AND (p_metadata ->> 'suggestion_id') ~ '^[a-z_]+:[A-Za-z0-9:_-]{1,100}$'
                          AND starts_with(p_metadata ->> 'suggestion_id', (p_metadata ->> 'code') || ':')
                     ELSE FALSE END
     END) IS NOT TRUE THEN
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

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check: both bodies are 095's, with their security, volatility and search_paths as before; write_audit signed-in only.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '7e8d396511ddb056daa61953bfccd12b' OR p.prosecdef OR p.provolatile <> 's'
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.audit_event_allowed(text,text)')) THEN
    RAISE EXCEPTION '095: audit_event_allowed is not 095''s after the replace';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'a6531bb5559ae9936387729bb91071a0' OR NOT p.prosecdef OR p.provolatile <> 'v'
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, security_audit']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)')) THEN
    RAISE EXCEPTION '095: write_audit is not 095''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)') AND a.grantee = 0) THEN
    RAISE EXCEPTION '095: write_audit is not signed-in only';
  END IF;
END
$$;

COMMIT;
