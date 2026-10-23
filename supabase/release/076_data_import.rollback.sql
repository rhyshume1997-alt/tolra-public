-- 076 rollback: ONLY with Rhys's approval, and only while no import has been committed and no large import is open (a committed
-- batch is the record of what came in, and its keys are what stops a second run doubling it and what an undo needs: once one exists,
-- forward-fix instead). Records an import created stay:
-- they are ordinary records. Run the whole text as one transaction, then `notify pgrst, 'reload schema';` and the release preflight
-- (076 shows "not applied"). The seven replaced functions go back exactly as 075 left them (033, 019, 068, 027, 034).
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batches WHERE status IN ('committed', 'undo')) OR EXISTS (SELECT 1 FROM public.import_runs WHERE status NOT IN ('cancelled')) THEN
    RAISE EXCEPTION '076 holds committed or open imports: do not roll back; forward-fix instead';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.import_undo(uuid, uuid);
DROP FUNCTION IF EXISTS public.import_undo_part(uuid, uuid);
DROP FUNCTION IF EXISTS public.import_commit_part(uuid, uuid);
DROP FUNCTION IF EXISTS public.import_validate(uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.import_stage_part(uuid, integer, jsonb);
DROP FUNCTION IF EXISTS public.import_part_payload(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.import_plan(jsonb, integer);
DROP FUNCTION IF EXISTS public.import_merge_stage(uuid, uuid);
DROP FUNCTION IF EXISTS public.import_company_data(jsonb, boolean, uuid);
DROP FUNCTION IF EXISTS public.import_failure(jsonb, text, text, text);
DROP FUNCTION IF EXISTS public.import_replay(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.import_check_payload(jsonb);
DROP FUNCTION IF EXISTS public.import_admin_org();
DROP FUNCTION IF EXISTS public.import_company_data_run(uuid, uuid, uuid, jsonb, text, uuid, text, uuid, integer, integer);
DROP TABLE IF EXISTS public.import_stage;
DROP TABLE IF EXISTS public.import_runs;
DROP TABLE IF EXISTS public.import_record_keys;
DROP TABLE IF EXISTS public.import_batches;
DROP TABLE IF EXISTS public.import_mappings;
DROP FUNCTION IF EXISTS public.import_batches_immutable();
DROP FUNCTION IF EXISTS public.import_mappings_stamp();
DROP FUNCTION IF EXISTS public.import_bool(text);
DROP FUNCTION IF EXISTS public.import_date(text);
DROP FUNCTION IF EXISTS public.import_num(text);
DROP FUNCTION IF EXISTS public.import_clean_record(jsonb);
DROP FUNCTION IF EXISTS public.import_clean_text(text);
DROP FUNCTION IF EXISTS public.import_norm_name(text);
CREATE OR REPLACE FUNCTION public.documents_start_as_drafts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_bad TEXT[];
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF coalesce(v_row ->> 'status', 'draft') <> 'draft' THEN
    v_bad := array_append(v_bad, 'status');
  END IF;
  -- What only the issue / send / accept / payment steps set.
  IF TG_TABLE_NAME = 'invoices' THEN
    IF v_row ->> 'invoice_ref' IS NOT NULL THEN v_bad := array_append(v_bad, 'invoice_ref'); END IF;
    IF v_row ->> 'sent_date' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_date'); END IF;
    IF v_row ->> 'paid_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'paid_at'); END IF;
    IF coalesce((v_row ->> 'amount_paid')::NUMERIC, 0) <> 0 THEN v_bad := array_append(v_bad, 'amount_paid'); END IF;
  ELSIF TG_TABLE_NAME = 'quotes' THEN
    IF v_row ->> 'sent_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_at'); END IF;
    IF v_row ->> 'accepted_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'accepted_at'); END IF;
    IF v_row ->> 'rejected_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'rejected_at'); END IF;
  ELSE
    IF v_row ->> 'sent_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_at'); END IF;
    IF v_row ->> 'received_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'received_at'); END IF;
  END IF;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'A new % must be saved as a draft and then issued (not set: %).', replace(TG_TABLE_NAME, '_', ' '), array_to_string(v_bad, ', ')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.invoice_lines_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_ref TEXT;
BEGIN
  IF public.is_api_role() THEN
    SELECT i.invoice_ref INTO v_ref FROM public.invoices i
    WHERE i.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.invoice_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.invoice_id END)
      AND coalesce(i.status, 'draft') <> 'draft'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Invoice % has been issued, so its lines can''t be changed.', v_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
CREATE OR REPLACE FUNCTION public.quote_lines_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_ref TEXT;
BEGIN
  IF public.is_api_role() THEN
    IF TG_OP <> 'DELETE' AND NEW.declined IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.declined ELSE FALSE END) THEN
      IF coalesce(current_setting('quoteflow.accept_quote', TRUE), '') IS DISTINCT FROM NEW.quote_id::TEXT THEN
        RAISE EXCEPTION 'Which lines the customer ordered is recorded when the quote is accepted.' USING ERRCODE = '42501';
      END IF;
      IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'declined') = (to_jsonb(OLD) - 'declined') THEN
        RETURN NEW;
      END IF;
    END IF;
    SELECT q.quote_ref INTO v_ref FROM public.quotes q
    WHERE q.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.quote_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.quote_id END)
      AND coalesce(q.status, 'draft') <> 'draft'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Quote % has been issued, so its lines can''t be changed.', v_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
CREATE OR REPLACE FUNCTION public.invoice_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_date', 'job_id', 'payment_unverified', 'updated_at', 'updated_by'];
  v_receipts CONSTANT TEXT[] := ARRAY['amount_paid', 'paid_at', 'credited_amount', 'refunded_amount'];
  v_via_payment BOOLEAN;
BEGIN
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t be deleted.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t go back to draft.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  v_via_payment := current_setting('quoteflow.invoice_payment', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF NOT v_via_payment THEN
    IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.credited_amount IS DISTINCT FROM OLD.credited_amount OR NEW.refunded_amount IS DISTINCT FROM OLD.refunded_amount THEN
      RAISE EXCEPTION 'Invoice %: payments are recorded with Record payment and credits applied with Apply credit, not by editing the amounts.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF OLD.payment_unverified AND NOT NEW.payment_unverified THEN
      RAISE EXCEPTION 'Invoice %: payments are confirmed with Confirm payments complete, not by editing the flag.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND (lower(coalesce(NEW.status, '')) IN ('paid', 'partial', 'credited') OR lower(coalesce(OLD.status, '')) IN ('paid', 'partial', 'credited')) THEN
      RAISE EXCEPTION 'Invoice %: it becomes part paid, paid or credited only when a payment is recorded or a credit applied.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - v_open - v_receipts) IS DISTINCT FROM (to_jsonb(OLD) - v_open - v_receipts) THEN
    RAISE EXCEPTION 'Invoice % has been issued: its amounts, customer and details can''t be changed (only payment and status).', OLD.invoice_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.quote_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_open    CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'accepted_at', 'rejected_at', 'internal_notes', 'updated_at', 'updated_by'];
  v_from    TEXT;
  v_to      TEXT;
  v_revised BOOLEAN;
BEGIN
  IF NOT public.is_api_role() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_from := coalesce(OLD.status, 'draft');
  IF TG_OP = 'DELETE' THEN
    IF v_from <> 'draft' THEN
      RAISE EXCEPTION 'Quote % has been issued, so it can''t be deleted.', OLD.quote_ref USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  v_to := coalesce(NEW.status, 'draft');
  IF v_to IS DISTINCT FROM v_from THEN
    v_revised := EXISTS (SELECT 1 FROM public.quotes q WHERE q.previous_version_id = OLD.id);
    IF v_revised AND v_to <> 'superseded' THEN
      RAISE EXCEPTION 'Quote % v% has been revised as a newer version: record the decision on the latest version.', OLD.quote_ref, OLD.version
        USING ERRCODE = '42501', HINT = 'quote_superseded';
    END IF;
    IF NOT (
         (v_from = 'draft' AND v_to IN ('sent', 'accepted', 'rejected'))
      OR (v_from = 'sent'  AND v_to IN ('accepted', 'rejected'))
      OR (v_from = 'sent'  AND v_to = 'superseded' AND v_revised)
      OR (v_from = 'superseded' AND v_to = 'sent' AND NOT v_revised)) THEN
      RAISE EXCEPTION 'Quote % can''t go from % to %.', OLD.quote_ref, v_from, v_to USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_from = 'superseded' AND v_to = 'superseded' AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'Quote % v% has been replaced by a newer version: send the latest version.', OLD.quote_ref, OLD.version USING ERRCODE = '42501';
  END IF;
  IF v_from <> 'draft' AND (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Quote % has been issued: correct a draft or copy it instead.', OLD.quote_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.purchase_order_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  -- Still open after issue: progress (status, sent/received times), the supplier's delivery date and notes.
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'received_at', 'expected_delivery', 'notes', 'updated_at', 'updated_by'];
BEGIN
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Purchase order % has been issued, so it can''t be deleted.', OLD.po_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Purchase order % has been issued, so it can''t go back to draft.', OLD.po_ref USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Purchase order % has been issued: its supplier, items and value can''t be changed (delivery date, notes and progress can).', OLD.po_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.audit_event_allowed(p_action text, p_table text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
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
COMMIT;
