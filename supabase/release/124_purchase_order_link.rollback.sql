-- 124 rollback: ONLY with Rhys's approval. Drops what 124 added to public.purchase_orders: the two same-company triggers
-- (zz_same_org_quote_id, zz_same_org_job_id), the two link indexes and the three columns quote_id, job_id and linked_net (with their
-- foreign keys and check). EVERY LINK FROM A PURCHASE ORDER TO A QUOTE OR JOB, AND EVERY ALLOCATED AMOUNT, IS LOST; the orders themselves,
-- their supplier, items, value and status are untouched. Puts back 076's public.purchase_order_issue_lock() byte for byte (same signature,
-- search_path, trigger). Run the whole text as one transaction, then the release preflight (marker 124 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_lock TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.purchase_order_issue_lock()') INTO v_lock;
  -- 9f903e88...: 124's body; 27924815...: 076's (a second run of this rollback).
  IF v_lock IS NULL OR v_lock NOT IN ('9f903e888bca6d55322cc877488c1019', '27924815917836092f18d3dd58d87c23') THEN
    RAISE EXCEPTION '124 rollback: purchase_order_issue_lock (md5 %) is neither 124''s nor 076''s; stop and compare', coalesce(v_lock, 'missing');
  END IF;
END
$$;

DROP TRIGGER IF EXISTS zz_same_org_quote_id ON public.purchase_orders;
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.purchase_orders;
DROP INDEX IF EXISTS public.idx_purchase_orders_quote_id;
DROP INDEX IF EXISTS public.idx_purchase_orders_job_id;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS quote_id;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS job_id;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS linked_net;

-- 076's purchase_order_issue_lock, verbatim (supabase/migrations/076_data_import.sql).
CREATE OR REPLACE FUNCTION public.purchase_order_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  -- Still open after issue: progress (status, sent/received times), the supplier's delivery date and notes.
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'received_at', 'expected_delivery', 'notes', 'updated_at', 'updated_by'];
BEGIN
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
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

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.purchase_order_issue_lock()'))
       IS DISTINCT FROM '27924815917836092f18d3dd58d87c23'
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name IN ('quote_id', 'job_id', 'linked_net'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.purchase_orders'::regclass AND tgname IN ('zz_same_org_quote_id', 'zz_same_org_job_id')) THEN
    RAISE EXCEPTION '124 rollback: the state after it is not 076''s lock without the 124 columns and triggers';
  END IF;
END
$$;
COMMIT;
