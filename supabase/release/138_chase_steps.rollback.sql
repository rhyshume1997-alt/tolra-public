-- 138 rollback: ONLY with Rhys's approval. Drops what 138 added (chase_steps, chase_pauses, chase_sends, their guard triggers and policies,
-- chase_create_draft, chase_record_sent; the payment claim: mark_payment_claimed, resolve_payment_claim, invoices_payment_claim_guard and
-- the four invoices columns), and puts back 106's email_templates_key constraint and 076's invoice_issue_lock exactly. DATA IS LOST:
-- every company's chase steps, pauses and chase records, every open payment claim (the columns are dropped), and any saved company
-- wording for the three new keys (chase_before_due, chase_firm, chase_final: 106's constraint does not allow them, so those
-- email_templates rows are deleted first). Chase drafts already in email_history stay
-- (status 'drafted', in Approvals as ordinary drafts; Approve and send then refuses them: no chase record). Run the whole text as one
-- transaction, then the release preflight (marker 138 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  -- Only 138's own bodies (or none: a second run of this rollback).
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.chase_create_draft(uuid,uuid,uuid,text,text,text,text,uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '5452f25d1f364e3915e01db2cfed2fee' THEN
    RAISE EXCEPTION '138 rollback: chase_create_draft (md5 %) is not 138''s; stop and compare', v_md5;
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.chase_record_sent(uuid,uuid,uuid,uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '213c534d5aeb25f0d14f9070396faf76' THEN
    RAISE EXCEPTION '138 rollback: chase_record_sent (md5 %) is not 138''s; stop and compare', v_md5;
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_issue_lock()');
  IF v_md5 IS NULL OR v_md5 NOT IN ('aa8c9f3ae3035d0ed566723a28edd827', 'be26a190744e6b961c9ad71366c67099') THEN
    RAISE EXCEPTION '138 rollback: invoice_issue_lock (md5 %) is neither 138''s nor 076''s; stop and compare', coalesce(v_md5, 'missing');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid IN (to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)'), to_regprocedure('public.resolve_payment_claim(uuid,text)'), to_regprocedure('public.invoices_payment_claim_guard()'))
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) NOT IN ('1ee5cb529645fd03263bd9e481864b1d', 'd3cbee1ab48f8e29d20fe23f8d8603fd', '7f540f262f12c85432b5a5172442d005')) THEN
    RAISE EXCEPTION '138 rollback: a payment-claim function is not 138''s; stop and compare';
  END IF;
END
$$;

-- The payment claim (6b): the functions, the guard, the columns; then 076's invoice_issue_lock, verbatim (supabase/migrations/076_data_import.sql).
DROP FUNCTION IF EXISTS public.mark_payment_claimed(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.resolve_payment_claim(UUID, TEXT);
DROP TRIGGER IF EXISTS invoices_payment_claim_guard ON public.invoices;
DROP FUNCTION IF EXISTS public.invoices_payment_claim_guard();
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_payment_claim_whole;
ALTER TABLE public.invoices DROP COLUMN IF EXISTS payment_claimed_at, DROP COLUMN IF EXISTS payment_claim_source,
  DROP COLUMN IF EXISTS payment_claim_evidence, DROP COLUMN IF EXISTS payment_claim_message_id;
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
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
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

DROP FUNCTION IF EXISTS public.chase_create_draft(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.chase_record_sent(UUID, UUID, UUID, UUID);
DROP TABLE IF EXISTS public.chase_sends;
DROP TABLE IF EXISTS public.chase_pauses;
DROP TABLE IF EXISTS public.chase_steps;
DROP FUNCTION IF EXISTS public.chase_steps_guard();
DROP FUNCTION IF EXISTS public.chase_pauses_guard();

DELETE FROM public.email_templates WHERE key IN ('chase_before_due', 'chase_firm', 'chase_final');
ALTER TABLE public.email_templates DROP CONSTRAINT IF EXISTS email_templates_key;
ALTER TABLE public.email_templates ADD CONSTRAINT email_templates_key
  CHECK (key IN ('quote', 'invoice', 'purchase_order', 'delivery_note', 'invoice_reminder', 'timesheet', 'job_to_workshop', 'rfq_clarify'));

DO $$
BEGIN
  IF to_regclass('public.chase_steps') IS NOT NULL OR to_regclass('public.chase_pauses') IS NOT NULL OR to_regclass('public.chase_sends') IS NOT NULL
     OR to_regprocedure('public.chase_create_draft(uuid,uuid,uuid,text,text,text,text,uuid)') IS NOT NULL
     OR to_regprocedure('public.chase_record_sent(uuid,uuid,uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.mark_payment_claimed(uuid,text,text,text)') IS NOT NULL OR to_regprocedure('public.resolve_payment_claim(uuid,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name LIKE 'payment_claim%')
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_issue_lock()')) IS DISTINCT FROM 'be26a190744e6b961c9ad71366c67099'
     OR (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.email_templates'::regclass AND c.conname = 'email_templates_key')
        IS DISTINCT FROM 'CHECK ((key = ANY (ARRAY[''quote''::text, ''invoice''::text, ''purchase_order''::text, ''delivery_note''::text, ''invoice_reminder''::text, ''timesheet''::text, ''job_to_workshop''::text, ''rfq_clarify''::text])))' THEN
    RAISE EXCEPTION '138 rollback: not back to 106''s state';
  END IF;
END
$$;
COMMIT;
