-- "(SINGLE PART) WORKSHEET" fields on jobs + private drawings bucket.
-- Prerequisite: 000_base_schema.sql (public.jobs, public.user_organization_id(), public.has_org_role()).

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS customer_po TEXT,
  ADD COLUMN IF NOT EXISTS date_received DATE,
  ADD COLUMN IF NOT EXISTS date_required DATE,
  ADD COLUMN IF NOT EXISTS quote_ref TEXT,
  ADD COLUMN IF NOT EXISTS dimension_report_no TEXT,
  ADD COLUMN IF NOT EXISTS material_cert_no TEXT,
  ADD COLUMN IF NOT EXISTS heat_cast_no TEXT,
  ADD COLUMN IF NOT EXISTS job_time_quoted_hr NUMERIC,
  ADD COLUMN IF NOT EXISTS job_time_taken_hr NUMERIC,
  ADD COLUMN IF NOT EXISTS drawing_no TEXT,
  ADD COLUMN IF NOT EXISTS quantity_required INT,
  ADD COLUMN IF NOT EXISTS material_required TEXT,
  ADD COLUMN IF NOT EXISTS material_ordered BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS material_ordered_at DATE,
  ADD COLUMN IF NOT EXISTS material_ordered_notes TEXT,
  ADD COLUMN IF NOT EXISTS material_supplier TEXT,
  ADD COLUMN IF NOT EXISTS machine_1 TEXT,
  ADD COLUMN IF NOT EXISTS program_1 TEXT,
  ADD COLUMN IF NOT EXISTS machine_2 TEXT,
  ADD COLUMN IF NOT EXISTS program_2 TEXT,
  ADD COLUMN IF NOT EXISTS machine_3 TEXT,
  ADD COLUMN IF NOT EXISTS program_3 TEXT,
  ADD COLUMN IF NOT EXISTS setup_time_hr NUMERIC,
  ADD COLUMN IF NOT EXISTS run_time_hr NUMERIC,
  ADD COLUMN IF NOT EXISTS improvement_comments TEXT,
  ADD COLUMN IF NOT EXISTS overrun_reasons TEXT,
  ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS checked_by TEXT,
  ADD COLUMN IF NOT EXISTS signed_off_by TEXT,
  ADD COLUMN IF NOT EXISTS signed_off_at TIMESTAMPTZ;

-- Private bucket for drawings: path = <organization_id>/<job_id>/<filename>
INSERT INTO storage.buckets (id, name, public)
VALUES ('job-drawings', 'job-drawings', FALSE)
ON CONFLICT (id) DO UPDATE SET public = FALSE;

-- Viewers can read drawings; only admin/office/workshop can change them
-- (has_org_role comes from 000_base_schema.sql).
DROP POLICY IF EXISTS "job drawings org select" ON storage.objects;
CREATE POLICY "job drawings org select" ON storage.objects FOR SELECT
USING (bucket_id = 'job-drawings' AND (storage.foldername(name))[1] = public.user_organization_id()::TEXT);

DROP POLICY IF EXISTS "job drawings org insert" ON storage.objects;
CREATE POLICY "job drawings org insert" ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'job-drawings' AND (storage.foldername(name))[1] = public.user_organization_id()::TEXT AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));

DROP POLICY IF EXISTS "job drawings org update" ON storage.objects;
CREATE POLICY "job drawings org update" ON storage.objects FOR UPDATE
USING (bucket_id = 'job-drawings' AND (storage.foldername(name))[1] = public.user_organization_id()::TEXT AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
WITH CHECK (bucket_id = 'job-drawings' AND (storage.foldername(name))[1] = public.user_organization_id()::TEXT AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));

DROP POLICY IF EXISTS "job drawings org delete" ON storage.objects;
CREATE POLICY "job drawings org delete" ON storage.objects FOR DELETE
USING (bucket_id = 'job-drawings' AND (storage.foldername(name))[1] = public.user_organization_id()::TEXT AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));
