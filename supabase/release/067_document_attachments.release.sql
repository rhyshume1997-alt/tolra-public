-- 067_document_attachments.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 067: files on delivery notes and purchase orders; the customer's PO on a quote travels to its job; a draft invoice corrected
-- in one step; a delivery note put on its job's draft invoice.
--
-- John's asks (18 Oct 2026): photos and files on delivery notes and purchase orders; the customer's PO document attached to the
-- quote and carried into the job pack; a draft invoice can be changed before it is issued ("not everything is always billed");
-- the delivery note attached to the invoice.
--
-- 1. quote_attachments.kind: 'file' (every existing row, the default) or 'customer_po' (the customer's purchase order). Set when the
--    file is uploaded and never changed by the browser roles (quote_attachments_kind_guard). Who may add, read and remove quote
--    files is unchanged (006: admin and office; 012: the quotes section).
-- 2. job_files.kind gains 'customer_po': a REFERENCE to the quote's file (bucket quote-attachments; nothing is copied), like a
--    drawing carried from the quote (034). It has no revision and always names its quote attachment.
--    * convert_sales_order (058) is unchanged: it still copies every quote file to the job as a drawing reference. A BEFORE INSERT
--      trigger (a_job_files_customer_po) turns the reference into kind 'customer_po' (ref 'Customer PO') when its source is a
--      customer-PO attachment of the same company and path.
--    * A customer PO uploaded to the quote AFTER the job exists is referenced on every job of that quote (same company and
--      quote_ref) by an AFTER INSERT trigger on quote_attachments, run as the uploader (admin or office).
--    * RESTRICTIVE insert policy "job_files quote file references", for EVERY job_files row that points into the quote-attachments
--      bucket (drawing or customer PO), checked by job_file_quote_reference_ok (SECURITY DEFINER, role only): the person adding it
--      is admin or office of the row's company, and the row names a quote file of that company by its id AND its path; a reference
--      to a customer-PO file is kind 'customer_po' and only that (no drawing row can point at the PO's file). The helper ignores
--      hidden sections, so convert_sales_order (058, INVOKER) and the later-PO trigger work for an admin or office user whose quotes
--      section is hidden. Before 067 the workshop could add a drawing row naming any path in its company's quote folder and then
--      read that file through 034's storage rule; it now can't make any quote-file reference (its own drawings and certificates go
--      to the job-drawings bucket, unchanged).
--    * Who reads it: admin, office and workshop, as the quote's drawings (job_files select, 034; 034's storage rule "quote-attachments
--      referenced by jobs"). Viewers don't: a RESTRICTIVE select policy hides 'customer_po' rows from them (as 040 hides photos),
--      and 034's storage rule looks the file up in job_files under the reader's own row rules, so a viewer can't open the file.
--      The quote file can't be overwritten or deleted while a job refers to it (034). Admin and office may take the reference off a
--      job (034's delete policy; the guard only keeps drawings and sent cert packs).
-- 3. document_attachments: one row per file on a delivery note OR a purchase order (exactly one parent, a real foreign key each,
--    ON DELETE CASCADE), stored in the new private bucket document-attachments at
--      <organization_id>/delivery-notes/<delivery_note_id>/<file>   or   <organization_id>/purchase-orders/<purchase_order_id>/<file>
--    (CHECK constraint). Same company only (RLS and same-organisation triggers). Roles mirror who can edit the parent today (006):
--      delivery note: admin, office, workshop read, add and remove;   purchase order: admin and office, purchase-orders section.
--    A file is never changed (no UPDATE grant or policy): remove it and attach it again. A delivery note that has gone out
--    (despatched, delivered, signed) keeps its files as despatch evidence: files can still be added (a signed copy, a photo of
--    the load) but not removed (document_attachments_guard, browser roles). Viewers see neither. Admin and office see a delivery
--    note's files from the invoice it is on (they can already read delivery notes).
--    Storage: bucket document-attachments (private, 20 MB, PDF / PNG / JPEG / WebP, as 006 set for the other buckets) with
--    policies scoped to the company folder and the parent's folder and role; an upload must name a parent of the company that the
--    uploader can read; a stored object can't be overwritten (no UPDATE policy) and can't be deleted while its row exists (the row
--    is removed first, under the rules above). 033's active-session and 036's read-only-support rules apply as to every bucket.
-- 4. replace_draft_invoice(invoice, expected_updated_at, header, lines): replaces a DRAFT invoice's lines and its editable header
--    fields in one transaction, as replace_draft_quote (021) does for quotes. SECURITY INVOKER: row-level security (admin and
--    office, invoices section) and every existing trigger apply, including 027's issue lock and the admin MFA rule. Refuses an
--    invoice that is no longer a draft (42501), one changed since it was opened (PT409), an unknown header field, no lines or more
--    than 500, a bad line (check_priced_line), a due date before the invoice date, a negative carriage, and totals that don't
--    match the lines (check_document_totals). Issued invoices stay locked exactly as before (019/027); nothing about them changes.
--    The header's description, quantity and unit_price are a summary of line 1 written by the app and by 059; the database has never
--    checked them against the lines (create_with_lines, 019/021, and replace_draft_quote, 021, don't), and what is billed is read
--    from the lines (check_document_totals, issue, the PDF). This function keeps that rule: it takes them as sent, and the app sends
--    line 1 (lib/draft-invoice-edit.ts).
-- 5. link_delivery_note_to_invoice(note, invoice) (SECURITY DEFINER): puts a delivery note on a DRAFT invoice of the same company,
--    job and customer (second step; admin or office; invoices section), through 034's link path, so 059 drafts no second invoice
--    when the note goes out. create_delivery_note (037) and 059 are unchanged.
--
-- Forward only, safe to run more than once. Nothing is backfilled: no quote file is a customer PO until someone uploads one as such.
-- The previous app build keeps working with 067 applied: its quote uploads insert kind 'file' by default, and it never reads the
-- new table or function.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. quote_attachments.kind ----------------------------------------------------------------------------------
ALTER TABLE public.quote_attachments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'file';
ALTER TABLE public.quote_attachments DROP CONSTRAINT IF EXISTS quote_attachments_kind_check;
ALTER TABLE public.quote_attachments ADD CONSTRAINT quote_attachments_kind_check CHECK (kind IN ('file', 'customer_po'));
CREATE INDEX IF NOT EXISTS idx_quote_attachments_customer_po ON public.quote_attachments (organization_id, quote_ref) WHERE kind = 'customer_po';

-- What a quote file is never changes once uploaded (browser roles; the importer and service role are exempt): a job may already
-- refer to it as the customer's PO, or as a drawing.
CREATE OR REPLACE FUNCTION public.quote_attachments_kind_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IN ('anon', 'authenticated') AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'A quote file stays what it was uploaded as: remove it and upload it again as the customer''s PO.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.quote_attachments_kind_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS quote_attachments_kind_guard ON public.quote_attachments;
CREATE TRIGGER quote_attachments_kind_guard BEFORE UPDATE OF kind ON public.quote_attachments
  FOR EACH ROW EXECUTE FUNCTION public.quote_attachments_kind_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. job_files kind 'customer_po' -------------------------------------------------------------------------------
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_kind_check;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_kind_check CHECK (kind IN ('drawing', 'cert', 'photo', 'customer_po'));
ALTER TABLE public.job_files DROP CONSTRAINT IF EXISTS job_files_customer_po_shape;
ALTER TABLE public.job_files ADD CONSTRAINT job_files_customer_po_shape CHECK (
  kind <> 'customer_po' OR (storage_bucket = 'quote-attachments' AND revision IS NULL AND source_attachment_id IS NOT NULL));

-- The quote's files are copied to a new job as drawing references (convert_sales_order, 058, unchanged). The customer's PO among
-- them becomes a 'customer_po' reference here. Definer: it reads the one quote attachment named by the row (same company, same
-- path) whoever inserts; it changes nothing else and only ever on a drawing reference to the quote-attachments bucket.
CREATE OR REPLACE FUNCTION public.job_files_customer_po_kind()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind = 'drawing' AND NEW.storage_bucket = 'quote-attachments' AND NEW.source_attachment_id IS NOT NULL AND NEW.revision IS NULL
     AND EXISTS (SELECT 1 FROM public.quote_attachments a
                 WHERE a.id = NEW.source_attachment_id AND a.organization_id = NEW.organization_id
                   AND a.kind = 'customer_po' AND a.file_path = NEW.storage_path) THEN
    NEW.kind := 'customer_po';
    NEW.ref := 'Customer PO';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.job_files_customer_po_kind() FROM PUBLIC, anon, authenticated;
-- Named to run before job_files_guard and job_files_revision_change (BEFORE triggers run in name order), so both see the final kind.
DROP TRIGGER IF EXISTS a_job_files_customer_po ON public.job_files;
CREATE TRIGGER a_job_files_customer_po BEFORE INSERT ON public.job_files
  FOR EACH ROW EXECUTE FUNCTION public.job_files_customer_po_kind();

-- May a job_files row point at this quote file? Admin or office of the row's company (the caller's session company), and a quote
-- file of that company with this id AND this path; a customer-PO file only as kind 'customer_po', and no drawing on the path of a
-- customer-PO file. Definer so that the check reads quote_attachments whatever sections the person has hidden (the row rules on
-- quote_attachments include the quotes section, 012); it answers only for the caller's own company and reveals nothing else.
CREATE OR REPLACE FUNCTION public.job_file_quote_reference_ok(p_org UUID, p_kind TEXT, p_path TEXT, p_source UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    p_org = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin', 'office'])
    AND p_kind IN ('drawing', 'customer_po')
    AND EXISTS (SELECT 1 FROM public.quote_attachments a
                WHERE a.id = p_source AND a.organization_id = p_org AND a.file_path = p_path
                  AND (a.kind = 'customer_po') = (p_kind = 'customer_po'))
    AND (p_kind = 'customer_po' OR NOT EXISTS (SELECT 1 FROM public.quote_attachments c
                                               WHERE c.organization_id = p_org AND c.file_path = p_path AND c.kind = 'customer_po')),
    FALSE)
$$;
REVOKE ALL ON FUNCTION public.job_file_quote_reference_ok(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.job_file_quote_reference_ok(UUID, TEXT, TEXT, UUID) TO authenticated;

-- Every reference to a quote file (drawing or customer PO) passes the check above. RESTRICTIVE: it only takes access away. The
-- BEFORE INSERT trigger above has already made a conversion copy of the PO kind 'customer_po' when this is checked.
DROP POLICY IF EXISTS "job_files customer po from the quote" ON public.job_files;
DROP POLICY IF EXISTS "job_files quote file references" ON public.job_files;
CREATE POLICY "job_files quote file references" ON public.job_files AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (storage_bucket <> 'quote-attachments'
              OR public.job_file_quote_reference_ok(organization_id, kind, storage_path, source_attachment_id));

-- Viewers see a job's drawings and certificates (034) but not the customer's PO, as 040 keeps photos from them. 034's storage rule
-- finds the file through job_files under the reader's row rules, so this also keeps the file itself from a viewer.
DROP POLICY IF EXISTS "job_files customer po not for viewers" ON public.job_files;
CREATE POLICY "job_files customer po not for viewers" ON public.job_files AS RESTRICTIVE FOR SELECT TO authenticated
  USING (kind <> 'customer_po' OR public.has_org_role(ARRAY['admin', 'office', 'workshop']));

-- A customer PO uploaded once the job exists: referenced on every job of that quote. Runs as the uploader (admin or office; the
-- quote_attachments policies), so job_files' own policies and guard apply as for any reference.
CREATE OR REPLACE FUNCTION public.quote_attachments_customer_po_to_jobs()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind = 'customer_po' AND split_part(NEW.file_path, '/', 1) = NEW.organization_id::TEXT AND btrim(coalesce(NEW.quote_ref, '')) <> '' THEN
    INSERT INTO public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, source_attachment_id, created_by)
    SELECT NEW.organization_id, j.id, 'customer_po', 'Customer PO', left(coalesce(nullif(btrim(NEW.file_name), ''), 'Customer PO'), 255),
           'quote-attachments', NEW.file_path, NEW.id, auth.uid()
    FROM public.jobs j
    WHERE j.organization_id = NEW.organization_id AND j.quote_ref = NEW.quote_ref
    ORDER BY j.created_at, j.id
    ON CONFLICT (job_id, storage_bucket, storage_path) DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.quote_attachments_customer_po_to_jobs() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS quote_attachments_customer_po_to_jobs ON public.quote_attachments;
CREATE TRIGGER quote_attachments_customer_po_to_jobs AFTER INSERT ON public.quote_attachments
  FOR EACH ROW EXECUTE FUNCTION public.quote_attachments_customer_po_to_jobs();

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Files on delivery notes and purchase orders -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_attachments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  delivery_note_id  UUID REFERENCES public.delivery_notes(id) ON DELETE CASCADE,
  purchase_order_id UUID REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  file_name         TEXT NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  storage_path      TEXT NOT NULL UNIQUE CHECK (length(storage_path) BETWEEN 1 AND 500),
  mime_type         TEXT CHECK (mime_type IS NULL OR mime_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  size_bytes        BIGINT CHECK (size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 20971520)),
  uploaded_by       UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_attachments_one_parent CHECK ((delivery_note_id IS NULL) <> (purchase_order_id IS NULL)),
  CONSTRAINT document_attachments_in_parent_folder CHECK (
    (delivery_note_id IS NOT NULL AND starts_with(storage_path, organization_id::TEXT || '/delivery-notes/' || delivery_note_id::TEXT || '/')
       AND length(storage_path) > length(organization_id::TEXT || '/delivery-notes/' || delivery_note_id::TEXT || '/'))
    OR (purchase_order_id IS NOT NULL AND starts_with(storage_path, organization_id::TEXT || '/purchase-orders/' || purchase_order_id::TEXT || '/')
       AND length(storage_path) > length(organization_id::TEXT || '/purchase-orders/' || purchase_order_id::TEXT || '/')))
);
CREATE INDEX IF NOT EXISTS idx_document_attachments_delivery_note ON public.document_attachments (delivery_note_id, created_at) WHERE delivery_note_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_attachments_purchase_order ON public.document_attachments (purchase_order_id, created_at) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_attachments_org ON public.document_attachments (organization_id, created_at);

ALTER TABLE public.document_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_attachments rbac select" ON public.document_attachments;
CREATE POLICY "document_attachments rbac select" ON public.document_attachments FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((delivery_note_id IS NOT NULL AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
              OR (purchase_order_id IS NOT NULL AND public.has_org_role(ARRAY['admin', 'office']) AND (SELECT public.section_allowed('purchase-orders')))));
DROP POLICY IF EXISTS "document_attachments rbac insert" ON public.document_attachments;
CREATE POLICY "document_attachments rbac insert" ON public.document_attachments FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_user_organization_id() AND uploaded_by = auth.uid()
              AND ((delivery_note_id IS NOT NULL AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
                   OR (purchase_order_id IS NOT NULL AND public.has_org_role(ARRAY['admin', 'office']) AND (SELECT public.section_allowed('purchase-orders')))));
DROP POLICY IF EXISTS "document_attachments rbac delete" ON public.document_attachments;
CREATE POLICY "document_attachments rbac delete" ON public.document_attachments FOR DELETE TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((delivery_note_id IS NOT NULL AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
              OR (purchase_order_id IS NOT NULL AND public.has_org_role(ARRAY['admin', 'office']) AND (SELECT public.section_allowed('purchase-orders')))));
REVOKE ALL ON public.document_attachments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.document_attachments TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_delivery_note_id ON public.document_attachments;
CREATE TRIGGER zz_same_org_delivery_note_id BEFORE INSERT OR UPDATE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('delivery_notes', 'delivery_note_id');
DROP TRIGGER IF EXISTS zz_same_org_purchase_order_id ON public.document_attachments;
CREATE TRIGGER zz_same_org_purchase_order_id BEFORE INSERT OR UPDATE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('purchase_orders', 'purchase_order_id');
DROP TRIGGER IF EXISTS audit_document_attachments_changes ON public.document_attachments;
CREATE TRIGGER audit_document_attachments_changes AFTER INSERT OR UPDATE OR DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.document_attachments;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.document_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.document_attachments;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.document_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- A delivery note that has gone out keeps its files (browser roles; deleting the note itself, which 034 allows only before it goes
-- out, still removes them by the cascade).
CREATE OR REPLACE FUNCTION public.document_attachments_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_dn RECORD;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN OLD;
  END IF;
  IF OLD.delivery_note_id IS NOT NULL THEN
    SELECT d.dn_number, d.status INTO v_dn FROM public.delivery_notes d WHERE d.id = OLD.delivery_note_id;
    IF FOUND AND v_dn.status IN ('despatched', 'delivered', 'signed') THEN
      RAISE EXCEPTION 'Delivery note % has been sent out, so its files can''t be removed (new ones can still be added).', v_dn.dn_number USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION public.document_attachments_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS document_attachments_guard ON public.document_attachments;
CREATE TRIGGER document_attachments_guard BEFORE DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.document_attachments_guard();

-- The bucket and its rules (Storage is present on Supabase; a plain Postgres without it skips this part, as 006/034 do).
DO $do$
BEGIN
  IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE '067: storage schema not found, skipping the document-attachments bucket';
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('document-attachments', 'document-attachments', FALSE, 20971520, ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
  ON CONFLICT (id) DO UPDATE SET public = FALSE, file_size_limit = 20971520,
                                 allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

  DROP POLICY IF EXISTS "document-attachments org select" ON storage.objects;
  CREATE POLICY "document-attachments org select" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'document-attachments'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND (((storage.foldername(name))[2] = 'delivery-notes' AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
                OR ((storage.foldername(name))[2] = 'purchase-orders' AND public.has_org_role(ARRAY['admin', 'office']) AND (SELECT public.section_allowed('purchase-orders')))));

  -- An upload goes into the folder of a delivery note or purchase order of the company that the uploader can read.
  DROP POLICY IF EXISTS "document-attachments org insert" ON storage.objects;
  CREATE POLICY "document-attachments org insert" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'document-attachments'
                AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
                AND (((storage.foldername(name))[2] = 'delivery-notes' AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])
                      AND EXISTS (SELECT 1 FROM public.delivery_notes d
                                  WHERE d.id::TEXT = (storage.foldername(name))[3] AND d.organization_id = public.current_user_organization_id()))
                     OR ((storage.foldername(name))[2] = 'purchase-orders' AND public.has_org_role(ARRAY['admin', 'office']) AND (SELECT public.section_allowed('purchase-orders'))
                         AND EXISTS (SELECT 1 FROM public.purchase_orders p
                                     WHERE p.id::TEXT = (storage.foldername(name))[3] AND p.organization_id = public.current_user_organization_id()))));

  -- No UPDATE policy: a stored file is never overwritten or moved. A file is deleted only once its row has gone (the row's rules
  -- decide who may remove it and when).
  DROP POLICY IF EXISTS "document-attachments org delete" ON storage.objects;
  CREATE POLICY "document-attachments org delete" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'document-attachments'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND (((storage.foldername(name))[2] = 'delivery-notes' AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
                OR ((storage.foldername(name))[2] = 'purchase-orders' AND public.has_org_role(ARRAY['admin', 'office']) AND (SELECT public.section_allowed('purchase-orders'))))
           AND NOT EXISTS (SELECT 1 FROM public.document_attachments a WHERE a.storage_path = objects.name));
  DROP POLICY IF EXISTS "document attachments are not deleted while listed" ON storage.objects;
  CREATE POLICY "document attachments are not deleted while listed" ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
    USING (bucket_id <> 'document-attachments' OR NOT EXISTS (SELECT 1 FROM public.document_attachments a WHERE a.storage_path = objects.name));
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. A draft invoice corrected in one step -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.replace_draft_invoice(p_invoice UUID, p_expected_updated_at TIMESTAMPTZ, p_header JSONB, p_lines JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_inv     public.invoices%ROWTYPE;
  v_line    JSONB;
  v_idx     INT := 0;
  v_now     TIMESTAMPTZ := clock_timestamp();
  v_allowed CONSTANT TEXT[] := ARRAY['description', 'quantity', 'unit_price', 'subtotal', 'carriage', 'vat', 'total', 'invoice_date',
                                     'due_date', 'tax_point', 'terms', 'customer_po'];
  v_key     TEXT;
  v_date    DATE;
  v_due     DATE;
  v_carr    NUMERIC;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_inv.status, 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t be changed: correct it with a credit note.', v_inv.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF v_inv.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'This draft invoice was changed by someone else since you opened it. Reload it and make your changes again.' USING ERRCODE = 'PT409';
  END IF;
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'header must be an object and lines an array' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_header) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'field "%" can''t be changed here', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Keep at least one line on the invoice (delete the draft if nothing is to be billed).' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'too many lines (max 500)' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_date := CASE WHEN p_header ? 'invoice_date' THEN (p_header ->> 'invoice_date')::DATE ELSE v_inv.invoice_date END;
    v_due  := CASE WHEN p_header ? 'due_date' THEN (p_header ->> 'due_date')::DATE ELSE v_inv.due_date END;
    v_carr := CASE WHEN p_header ? 'carriage' THEN coalesce((p_header ->> 'carriage')::NUMERIC, 0) ELSE coalesce(v_inv.carriage, 0) END;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Dates must be real dates and carriage a number' USING ERRCODE = '22023';
  END;
  IF v_date IS NULL OR v_due IS NULL OR v_due < v_date THEN
    RAISE EXCEPTION 'Give an invoice date and a due date that is not before it.' USING ERRCODE = '22023';
  END IF;
  IF v_carr < 0 OR scale(trim_scale(v_carr)) > 2 THEN
    RAISE EXCEPTION 'Carriage is in pounds and pence and can''t be negative' USING ERRCODE = '22023';
  END IF;

  UPDATE public.invoices i SET
    description = CASE WHEN p_header ? 'description' THEN p_header ->> 'description' ELSE i.description END,
    quantity    = CASE WHEN p_header ? 'quantity' THEN (p_header ->> 'quantity')::NUMERIC ELSE i.quantity END,
    unit_price  = CASE WHEN p_header ? 'unit_price' THEN (p_header ->> 'unit_price')::NUMERIC ELSE i.unit_price END,
    subtotal    = CASE WHEN p_header ? 'subtotal' THEN (p_header ->> 'subtotal')::NUMERIC ELSE i.subtotal END,
    carriage    = v_carr,
    vat         = CASE WHEN p_header ? 'vat' THEN (p_header ->> 'vat')::NUMERIC ELSE i.vat END,
    total       = CASE WHEN p_header ? 'total' THEN (p_header ->> 'total')::NUMERIC ELSE i.total END,
    invoice_date = v_date,
    due_date    = v_due,
    tax_point   = CASE WHEN p_header ? 'tax_point' THEN nullif(p_header ->> 'tax_point', '')::DATE ELSE i.tax_point END,
    terms       = CASE WHEN p_header ? 'terms' THEN p_header ->> 'terms' ELSE i.terms END,
    customer_po = CASE WHEN p_header ? 'customer_po' THEN nullif(btrim(p_header ->> 'customer_po'), '') ELSE i.customer_po END,
    updated_at  = v_now,
    updated_by  = auth.uid()
  WHERE i.id = p_invoice;

  DELETE FROM public.invoice_line_items WHERE invoice_id = p_invoice;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    PERFORM public.check_priced_line(v_line);
    INSERT INTO public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
    VALUES (v_org, p_invoice, v_idx, btrim(v_line ->> 'description'), (v_line ->> 'quantity')::NUMERIC, (v_line ->> 'unit_price')::NUMERIC,
            coalesce((v_line ->> 'vat_pct')::NUMERIC, 20), coalesce((v_line ->> 'vat_exempt')::BOOLEAN, FALSE));
    v_idx := v_idx + 1;
  END LOOP;

  -- The stored subtotal, VAT and total must be what the lines, carriage and the invoice's own VAT settings give (027's rule at issue).
  PERFORM public.check_document_totals('invoices', p_invoice, v_org);
  UPDATE public.invoices SET issuer_snapshot = public.issuer_snapshot(v_org), customer_snapshot = public.customer_snapshot(v_org, customer)
  WHERE id = p_invoice;
  RETURN v_now;
END
$$;
REVOKE ALL ON FUNCTION public.replace_draft_invoice(UUID, TIMESTAMPTZ, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_draft_invoice(UUID, TIMESTAMPTZ, JSONB, JSONB) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. A delivery note attached to its draft invoice ----------------------------------------------------------------
-- John: "delivery note attached to the invoice". A note made for a job that already has a draft invoice (create_delivery_note, 037,
-- unchanged) can be put on that draft, so that when it goes out 059 leaves it alone (delivery_note_try_draft already skips a note on
-- a live invoice: no second draft). The invoice's lines are not changed: what is billed is edited on the draft (section 4). The
-- note's items are deliberately not added as lines: the draft usually bills them already (made from the order, or by 059 for an
-- earlier note), and nothing ties an invoice line to a note item, so adding them could bill the same parts twice.
-- Definer, like 034/059's invoicing functions, because the link is written only through a function (delivery_notes_link_guard). It
-- checks: the second step (033) as create_delivery_note does; admin or office (who can both make delivery notes and read invoices)
-- and the invoices section not hidden; the note and the invoice both of the caller's company (else "not found", nothing about the
-- other company is revealed); the invoice still a DRAFT; the note on no live invoice and with no hand-typed invoice reference; the
-- same job (the invoice's job is the note's job, or the job its order became) and the same customer (ignoring case and repeated
-- spaces, as 059). Locks the note, then the invoice (as 059 does). Linking the note to the invoice it is already on returns 'linked'
-- again and changes nothing.
CREATE OR REPLACE FUNCTION public.link_delivery_note_to_invoice(p_note UUID, p_invoice UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org  UUID := public.current_user_organization_id();
  v_dn   RECORD;
  v_inv  RECORD;
  v_live BOOLEAN;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT d.id, d.dn_number, d.customer, d.job_id, d.sales_order_id, d.invoice_id, d.invoice_ref INTO v_dn
  FROM public.delivery_notes d WHERE d.id = p_note AND d.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery note not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT i.id, i.status, i.invoice_ref, i.customer, i.job_id INTO v_inv
  FROM public.invoices i WHERE i.id = p_invoice AND i.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dn.invoice_id = v_inv.id THEN
    RETURN jsonb_build_object('outcome', 'linked', 'delivery_note_id', v_dn.id, 'invoice_id', v_inv.id);
  END IF;
  IF coalesce(v_inv.status, 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued: a delivery note can only be put on a draft invoice.', v_inv.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF v_dn.invoice_id IS NOT NULL THEN
    SELECT lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled') INTO v_live FROM public.invoices i WHERE i.id = v_dn.invoice_id;
    IF coalesce(v_live, FALSE) THEN
      RAISE EXCEPTION 'Delivery note % is already on another invoice.', v_dn.dn_number USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_dn.invoice_id IS NULL AND nullif(btrim(v_dn.invoice_ref), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Delivery note % records invoice %, so it can''t be put on another one.', v_dn.dn_number, v_dn.invoice_ref USING ERRCODE = '22023';
  END IF;
  IF v_inv.job_id IS NULL OR NOT (
       v_dn.job_id = v_inv.job_id
       OR (v_dn.sales_order_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = v_inv.job_id AND j.organization_id = v_org
                                                         AND j.converted_from_sales_order_id = v_dn.sales_order_id))) THEN
    RAISE EXCEPTION 'Delivery note % is not for the job this invoice is for.', v_dn.dn_number USING ERRCODE = '22023';
  END IF;
  IF lower(regexp_replace(btrim(coalesce(v_dn.customer, '')), '\s+', ' ', 'g')) IS DISTINCT FROM lower(regexp_replace(btrim(coalesce(v_inv.customer, '')), '\s+', ' ', 'g')) THEN
    RAISE EXCEPTION 'Delivery note % is for a different customer from the invoice.', v_dn.dn_number USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('quoteflow.delivery_note_invoice', v_dn.id::TEXT, TRUE);
  UPDATE public.delivery_notes SET invoice_id = v_inv.id WHERE id = v_dn.id;
  PERFORM set_config('quoteflow.delivery_note_invoice', '', TRUE);
  RETURN jsonb_build_object('outcome', 'linked', 'delivery_note_id', v_dn.id, 'invoice_id', v_inv.id);
END
$$;
REVOKE ALL ON FUNCTION public.link_delivery_note_to_invoice(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_delivery_note_to_invoice(UUID, UUID) TO authenticated;

COMMIT;
