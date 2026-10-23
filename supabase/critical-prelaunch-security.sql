-- LEGACY, ONLY FOR THE OLD JNREng PROJECT (the legacy project).
-- A NEW Supabase project must NOT run this file: migrations/000_base_schema.sql contains everything it provided
-- (and uses uuid ids). It is kept for history. It also assumes the old tables already exist (bigint ids).
--
-- ============================================
-- QUOTEFLOW AI - CRITICAL PRE-LAUNCH SECURITY PATCH
-- Safe to run more than once in Supabase SQL Editor.
-- ============================================

ALTER TABLE delivery_notes
  ADD COLUMN IF NOT EXISTS signed_by_name TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signature_notes TEXT,
  ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS converted_from_sales_order_id UUID REFERENCES sales_orders(id),
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS specification TEXT,
  ADD COLUMN IF NOT EXISTS drawings JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS converted_to_job_id UUID REFERENCES jobs(id),
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

ALTER TABLE sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_status_check;

ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_status_check
  CHECK (status IN ('open', 'confirmed', 'in_production', 'despatched', 'converted', 'closed'));

ALTER TABLE email_history
  DROP CONSTRAINT IF EXISTS email_history_related_to_type_check;

ALTER TABLE email_history
  ADD CONSTRAINT email_history_related_to_type_check
  CHECK (related_to_type IN ('invoice', 'quote', 'sales_order', 'purchase_order', 'delivery_note', 'rfq', 'job', 'general'));
