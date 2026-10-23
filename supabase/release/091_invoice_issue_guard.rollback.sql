-- Rollback of 091 (a draft invoice is issued only by issue_invoice, never by editing its status or number). ONE transaction: run the
-- whole text; if anything fails, nothing of it is kept. Only with Rhys's approval. Removes the trigger zz_invoice_via_issue on
-- public.invoices and its function public.invoice_issue_guard(), and puts back 034's issue_invoice exactly (without the
-- quoteflow.invoice_issue setting); its grants are unchanged. Nothing else was created or changed by 091, and no data is touched.
-- Afterwards admin and office can again move a draft invoice straight to issued (or sent / written off) with an invoice number of their
-- own choosing in one API request, or set a draft's number, bypassing issue_invoice (089 still refuses paid / part paid / credited).
-- STOPS (nothing changed) while the function exists with a body other than 091's, or issue_invoice is neither 091's nor 034's.
-- Safe to run twice. Then `notify pgrst, 'reload schema';` and the release preflight (marker 091 "not applied").
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.invoice_issue_guard()')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'a601d6b3464100729d4c9b5055d6633e') THEN
    RAISE EXCEPTION '091 rollback: public.invoice_issue_guard() is not 091''s; stop and compare';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.issue_invoice(uuid)'))
       NOT IN ('ee9b9005e060379ce9dcc8e45a7afd42', '54622e5030816649217b963fb7ab5419') THEN
    RAISE EXCEPTION '091 rollback: public.issue_invoice(uuid) is neither 091''s nor 034''s; stop and compare';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS zz_invoice_via_issue ON public.invoices;
DROP FUNCTION IF EXISTS public.invoice_issue_guard();

-- 034's issue_invoice, exactly as supabase/migrations/034_workflow_day_one.sql creates it.
-- Issuing a draft invoice: admin or office (027), and the INV number is theirs to take (006, next_doc_number).
CREATE OR REPLACE FUNCTION public.issue_invoice(p_invoice UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_inv RECORD;
  v_ref TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can issue invoices' USING ERRCODE = '42501';
  END IF;
  SELECT id, status, invoice_ref, customer INTO v_inv
  FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_inv.status, 'draft') <> 'draft' THEN
    RETURN v_inv.invoice_ref; -- already issued: same number, nothing changes
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_line_items WHERE invoice_id = p_invoice) THEN
    RAISE EXCEPTION 'Add at least one line item before issuing' USING ERRCODE = '22023';
  END IF;
  PERFORM public.check_document_totals('invoices', p_invoice, v_org);
  v_ref := public.next_doc_number('INV');
  UPDATE public.invoices
     SET status = 'issued', invoice_ref = v_ref,
         issuer_snapshot = public.issuer_snapshot(v_org), customer_snapshot = public.customer_snapshot(v_org, v_inv.customer)
   WHERE id = p_invoice;
  RETURN v_ref;
END
$$;
REVOKE ALL ON FUNCTION public.issue_invoice(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_invoice(UUID) TO authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.invoice_issue_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'zz_invoice_via_issue' AND t.tgrelid = 'public.invoices'::regclass) THEN
    RAISE EXCEPTION '091 rollback: the trigger or its function is still there';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.issue_invoice(uuid)'))
       IS DISTINCT FROM '54622e5030816649217b963fb7ab5419' THEN
    RAISE EXCEPTION '091 rollback: issue_invoice is not 034''s after the rollback';
  END IF;
END
$$;

COMMIT;
