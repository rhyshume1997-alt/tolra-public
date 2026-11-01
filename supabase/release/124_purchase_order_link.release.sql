-- 124_purchase_order_link.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 124: a supplier purchase order can say which customer quote or job it was bought for, so the quote and the job can show what was bought in
-- and the profit (Rhys and John, 1 Nov: John buys an item from a supplier, e.g. stainless bar, and sells it on; he wants sell minus buy to be
-- visible without a sales order). Needs 000 (purchase_orders, quotes, jobs), 006/015 (enforce_same_org_parent) and 076
-- (purchase_order_issue_lock, the newest body: no later migration replaces it). Touches no other migration's objects.
--
-- WHAT CHANGES. On public.purchase_orders only:
--   a. quote_id UUID -> quotes(id) ON DELETE SET NULL, and job_id UUID -> jobs(id) ON DELETE SET NULL. Both nullable (every existing PO stays
--      unlinked: no row is updated), each with a partial index (the quote and the job read their linked orders by it).
--   b. linked_net NUMERIC(14,2), nullable, >= 0: the part of the order's ex-VAT value that is for the linked quote/job, when only some of the
--      order is (one PO covering several jobs, or only some lines). NULL means the whole order. The app never counts more than the order's own
--      ex-VAT value. No row is updated.
--   c. Same company: a link to another company's quote or job is refused (zz_same_org_quote_id, zz_same_org_job_id: the existing
--      public.enforce_same_org_parent, unchanged, as 015 adds it to every other business link; 23514 "cross-organisation reference rejected").
--      They fire only when the link or the company changes.
--   d. purchase_order_issue_lock: 076's body with quote_id, job_id and linked_net added to what may still change after the order is issued.
--      They are internal (the supplier's PDF, email and print never show them), and without this a quote or job deleted while an issued
--      order points at it could not be deleted (ON DELETE SET NULL updates the order, and the lock refused any other column). Supplier,
--      items and value stay fixed after issue exactly as before; the drafts-only and no-delete rules are unchanged.
-- ROW RULES. Unchanged: the existing purchase_orders policies (admin and office of the session's company, section purchase-orders) cover the
-- new columns. No grant changes. A workshop person or viewer still reads no purchase order.
-- GUARD (section 1): the tables are there, enforce_same_org_parent is there, and purchase_order_issue_lock's body is 076's (or already this
-- file's), md5 with every whitespace character removed. Safe to run again. SELF-CHECK (section 5).
-- Verify: supabase/verify/purchase_order_link_124.sql (every row TRUE).
-- Rollback: supabase/release/124_purchase_order_link.rollback.sql (drops the two triggers, the indexes and the three columns, so every link
-- and allocated amount is lost; puts back 076's purchase_order_issue_lock; only with Rhys's approval).
-- NUMBERING: 123 (quotes.customer_po) is being built separately and is not on main. 124 does not depend on 123 and 123 does not touch
-- purchase_orders. In supabase/verify/release_preflight.sql the '124 ...' marker must stay the LAST marker (numeric order): when 123 lands,
-- its marker goes before 124's (scratchpad ma2/sort-markers.py does this), and the catalogue snapshot is regenerated with both.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: the tables and enforce_same_org_parent are there; purchase_order_issue_lock is 076's (or already this file's).
DO $$
DECLARE
  v_lock TEXT;
BEGIN
  IF to_regclass('public.purchase_orders') IS NULL OR to_regclass('public.quotes') IS NULL OR to_regclass('public.jobs') IS NULL
     OR to_regprocedure('public.enforce_same_org_parent()') IS NULL THEN
    RAISE EXCEPTION '124 needs 000 (purchase_orders, quotes, jobs) and 006/015 (enforce_same_org_parent)';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.purchase_order_issue_lock()') INTO v_lock;
  -- 27924815917836092f18d3dd58d87c23: 076's purchase_order_issue_lock; 9f903e888bca6d55322cc877488c1019: this file's (section 4).
  IF v_lock IS NULL OR v_lock NOT IN ('27924815917836092f18d3dd58d87c23', '9f903e888bca6d55322cc877488c1019') THEN
    RAISE EXCEPTION '124: public.purchase_order_issue_lock is not 076''s (md5 without whitespace %); stop and compare it first', coalesce(v_lock, 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The columns and their indexes. ADD COLUMN IF NOT EXISTS skips the whole clause (and its constraint) when the column is there.
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES public.quotes(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS linked_net NUMERIC(14,2) CONSTRAINT purchase_orders_linked_net_check CHECK (linked_net >= 0);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_quote_id ON public.purchase_orders (quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_job_id ON public.purchase_orders (job_id) WHERE job_id IS NOT NULL;

-- -----------------------------------------------------------------------------------------------------
-- 3. Same company: the existing same-organisation trigger function (unchanged) on both links, as 015 does for every other link.
DROP TRIGGER IF EXISTS zz_same_org_quote_id ON public.purchase_orders;
CREATE TRIGGER zz_same_org_quote_id BEFORE INSERT OR UPDATE OF quote_id, organization_id ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('quotes', 'quote_id');
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.purchase_orders;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE OF job_id, organization_id ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');

-- -----------------------------------------------------------------------------------------------------
-- 4. purchase_order_issue_lock: 076's body; the links and the allocated amount may still change after issue (one line changed, one comment).
--    Same name, signature, trigger, search_path and owner (CREATE OR REPLACE keeps the trigger and the grants).
CREATE OR REPLACE FUNCTION public.purchase_order_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  -- Still open after issue: progress (status, sent/received times), the supplier's delivery date and notes.
  -- 124: and the internal link to the customer's quote or job, with the part of the value that is for it (never on the supplier's PDF).
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'received_at', 'expected_delivery', 'notes', 'updated_at', 'updated_by', 'quote_id', 'job_id', 'linked_net'];
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

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check before COMMIT (the same checks as supabase/verify/purchase_order_link_124.sql).
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'purchase_orders'
        AND ((column_name IN ('quote_id', 'job_id') AND data_type = 'uuid') OR (column_name = 'linked_net' AND data_type = 'numeric')) AND is_nullable = 'YES') <> 3 THEN
    RAISE EXCEPTION '124: purchase_orders.quote_id, job_id and linked_net are not all there (nullable)';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.purchase_orders'::regclass AND c.contype = 'f' AND c.confdeltype = 'n'
        AND ((c.confrelid = 'public.quotes'::regclass AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.purchase_orders'::regclass AND attname = 'quote_id')])
          OR (c.confrelid = 'public.jobs'::regclass AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.purchase_orders'::regclass AND attname = 'job_id')]))) <> 2 THEN
    RAISE EXCEPTION '124: the quote_id and job_id foreign keys (ON DELETE SET NULL) are not exactly one each';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.purchase_orders'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
        AND t.tgfoid = to_regprocedure('public.enforce_same_org_parent()') AND t.tgname IN ('zz_same_org_quote_id', 'zz_same_org_job_id')) <> 2 THEN
    RAISE EXCEPTION '124: the two same-company triggers are not both there';
  END IF;
  IF to_regclass('public.idx_purchase_orders_quote_id') IS NULL OR to_regclass('public.idx_purchase_orders_job_id') IS NULL THEN
    RAISE EXCEPTION '124: the link indexes are missing';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.purchase_order_issue_lock()'))
       IS DISTINCT FROM '9f903e888bca6d55322cc877488c1019' THEN
    RAISE EXCEPTION '124: purchase_order_issue_lock is not 124''s after the replace';
  END IF;
END
$$;

COMMIT;
