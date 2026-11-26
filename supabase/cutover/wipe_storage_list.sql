-- READ-ONLY. Run on production BEFORE the wipe SQL (afterwards the rows that point at the files are gone). Lists every Storage object tied to a row that the
-- wipe deletes: job_files (drawings and photos), document_attachments and quote_attachments of the two wiped companies. Logos (org-logos) are NOT listed.
-- The result must equal the list in wipe_storage_step.md. Changes nothing.
SELECT 'job_files' AS source, f.storage_bucket AS bucket, f.storage_path AS name, o.id AS object_id, o.metadata->>'size' AS size
FROM public.job_files f LEFT JOIN storage.objects o ON o.bucket_id = f.storage_bucket AND o.name = f.storage_path
WHERE f.organization_id IN ('264fe031-5381-4d70-a8fd-113c1713bc65','2a213c03-c440-450d-9217-e2bbfcaff6b5')
UNION ALL
SELECT 'document_attachments', o.bucket_id, d.storage_path, o.id, o.metadata->>'size'
FROM public.document_attachments d LEFT JOIN storage.objects o ON o.name = d.storage_path
WHERE d.organization_id IN ('264fe031-5381-4d70-a8fd-113c1713bc65','2a213c03-c440-450d-9217-e2bbfcaff6b5')
UNION ALL
SELECT 'quote_attachments', o.bucket_id, q.file_path, o.id, o.metadata->>'size'
FROM public.quote_attachments q LEFT JOIN storage.objects o ON o.name = q.file_path
WHERE q.organization_id IN ('264fe031-5381-4d70-a8fd-113c1713bc65','2a213c03-c440-450d-9217-e2bbfcaff6b5')
ORDER BY 1, 2, 3;
