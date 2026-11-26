-- Rollback of p171 (supabase/proposals/p171_iso_editable_documents.sql). Drops ONLY what p171 added: the functions save_iso_document,
-- approve_iso_document, iso_document_caller, iso_document_versions_guard and the table public.iso_document_versions (its trigger, policy,
-- constraints and index go with it). REFUSES, changing nothing, while the table holds any row: the versions are the company's own record and
-- exist nowhere else, and this file never deletes records (export them first, or have the owner decide). Safe to run when p171 is absent
-- (nothing to do) and safe to run twice. After it, the app treats the table as missing ("Editing is not available yet") and shows the read-only
-- generated drafts. Inputs: the database. Outputs: five objects removed. Must not change: anything else. Production only with a separate yes.
BEGIN;
DO $rollback_guard$
BEGIN
  IF to_regclass('public.iso_document_versions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.iso_document_versions) THEN
      RAISE EXCEPTION 'p171 rollback: % ISO document version(s) exist; they exist nowhere else and this file never deletes records, so nothing was changed',
        (SELECT count(*) FROM public.iso_document_versions);
    END IF;
  END IF;
END
$rollback_guard$;
DROP FUNCTION IF EXISTS public.save_iso_document(TEXT, JSONB, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.approve_iso_document(TEXT, INTEGER, TEXT);
DROP TABLE IF EXISTS public.iso_document_versions;
DROP FUNCTION IF EXISTS public.iso_document_versions_guard();
DROP FUNCTION IF EXISTS public.iso_document_caller();
COMMIT;
