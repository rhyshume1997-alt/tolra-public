-- Migration 067 (files on delivery notes and purchase orders; the customer's PO travels to the job; draft invoice correction; a delivery
-- note put on its draft invoice). Read only: every row (17) should be TRUE; row 17 also
-- reports a count to review (it never fails). Pairs with the release text
-- supabase/release/067_document_attachments.release.sql, sha256 fabaf182432e6c2978bc6e8c2756210cff1f4b0b7ee3c9cf7330673fb6b338e7.
SELECT 'quote_attachments_kind' AS check_name, EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'quote_attachments' AND column_name = 'kind' AND is_nullable = 'NO' AND column_default = '''file''::text'
) AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.quote_attachments'::regclass AND conname = 'quote_attachments_kind_check') AS ok
UNION ALL SELECT 'existing_quote_files_are_files', NOT EXISTS (SELECT 1 FROM public.quote_attachments WHERE kind NOT IN ('file', 'customer_po'))
UNION ALL SELECT 'job_files_customer_po_kind', EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_files'::regclass AND conname = 'job_files_kind_check'
    AND pg_get_constraintdef(oid) LIKE '%customer_po%'
) AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.job_files'::regclass AND conname = 'job_files_customer_po_shape')
UNION ALL SELECT 'customer_po_triggers', (
  SELECT count(*) = 3 FROM pg_trigger
  WHERE tgenabled = 'O' AND ((tgrelid = 'public.job_files'::regclass AND tgname = 'a_job_files_customer_po')
     OR (tgrelid = 'public.quote_attachments'::regclass AND tgname IN ('quote_attachments_customer_po_to_jobs', 'quote_attachments_kind_guard')))
)
-- Every reference to a quote file goes through the role-only definer check (findings of the 067 review: section-independent, and
-- the workshop can't name an arbitrary quote file); viewers don't see the customer's PO.
UNION ALL SELECT 'quote_file_reference_rule', EXISTS (
  SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_files' AND policyname = 'job_files quote file references'
    AND permissive = 'RESTRICTIVE' AND cmd = 'INSERT' AND with_check LIKE '%job_file_quote_reference_ok%' AND with_check LIKE '%quote-attachments%'
) AND NOT EXISTS (
  SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_files' AND policyname = 'job_files customer po from the quote'
)
UNION ALL SELECT 'quote_file_reference_helper', EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid = 'public.job_file_quote_reference_ok(uuid, text, text, uuid)'::regprocedure
    AND p.prosecdef AND 'search_path=pg_catalog, public' = ANY (p.proconfig)
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
)
UNION ALL SELECT 'customer_po_not_for_viewers', EXISTS (
  SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_files' AND policyname = 'job_files customer po not for viewers'
    AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT' AND qual LIKE '%customer_po%' AND qual NOT LIKE '%viewer%'
)
UNION ALL SELECT 'document_attachments_rls', (
  SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.document_attachments'::regclass
) AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_attachments') = 3
UNION ALL SELECT 'document_attachments_grants',
  has_table_privilege('authenticated', 'public.document_attachments', 'SELECT') AND has_table_privilege('authenticated', 'public.document_attachments', 'INSERT')
  AND has_table_privilege('authenticated', 'public.document_attachments', 'DELETE') AND NOT has_table_privilege('authenticated', 'public.document_attachments', 'UPDATE')
  AND NOT has_table_privilege('anon', 'public.document_attachments', 'SELECT')
UNION ALL SELECT 'document_attachments_triggers', (
  SELECT count(*) = 6 FROM pg_trigger WHERE tgrelid = 'public.document_attachments'::regclass AND tgenabled = 'O'
    AND tgname IN ('zz_same_org_delivery_note_id', 'zz_same_org_purchase_order_id', 'audit_document_attachments_changes', 'support_read_only',
                   'admin_mfa', 'document_attachments_guard')
)
UNION ALL SELECT 'bucket_private', EXISTS (
  SELECT 1 FROM storage.buckets WHERE id = 'document-attachments' AND NOT public AND file_size_limit = 20971520
    AND allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
UNION ALL SELECT 'bucket_policies', (
  SELECT count(*) = 4 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname IN ('document-attachments org select', 'document-attachments org insert', 'document-attachments org delete', 'document attachments are not deleted while listed')
) AND NOT EXISTS (
  SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'UPDATE' AND permissive = 'PERMISSIVE'
    AND (qual LIKE '%document-attachments%' OR with_check LIKE '%document-attachments%')
)
UNION ALL SELECT 'replace_draft_invoice', EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid = 'public.replace_draft_invoice(uuid, timestamptz, jsonb, jsonb)'::regprocedure
    AND NOT p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
)
UNION ALL SELECT 'link_delivery_note_to_invoice', EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid = 'public.link_delivery_note_to_invoice(uuid, uuid)'::regprocedure
    AND p.prosecdef AND 'search_path=pg_catalog, public' = ANY (p.proconfig)
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
)
UNION ALL SELECT 'internal_functions_only', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('quote_attachments_kind_guard', 'job_files_customer_po_kind', 'quote_attachments_customer_po_to_jobs', 'document_attachments_guard')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
)
-- Issued invoices are still locked (019/027 triggers present and enabled).
UNION ALL SELECT 'issued_invoice_locks_kept', (
  SELECT count(*) = 2 FROM pg_trigger WHERE tgenabled = 'O'
    AND ((tgrelid = 'public.invoices'::regclass AND tgname = 'invoice_issue_lock') OR (tgrelid = 'public.invoice_line_items'::regclass AND tgname = 'invoice_lines_issue_lock'))
)
-- Informational, never a failure: job_files rows pointing into quote-attachments with no quote file of the same company matching by id
-- AND path. 067 refuses new ones; any found were made before 067 (the workshop could then list any file of the company's quote
-- folder on a job). The count is in the name; look at any rows found (RELEASE.md, 067).
UNION ALL SELECT 'review_unmatched_quote_file_refs=' || (
  SELECT count(*) FROM public.job_files f
  WHERE f.storage_bucket = 'quote-attachments'
    AND NOT EXISTS (SELECT 1 FROM public.quote_attachments a
                    WHERE a.id = f.source_attachment_id AND a.organization_id = f.organization_id AND a.file_path = f.storage_path)
), TRUE;
