-- 001: customers, supplier contact fields, quote notes, quote line items, quote attachments.
-- Idempotent: safe to run more than once. Requires 000_base_schema.sql (public.organizations, public.suppliers,
-- public.quotes, public.user_organization_id()). On the old single-tenant project the legacy root files provided those.

-- 1) CUSTOMERS ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- If customers already existed from an earlier schema, make sure the columns are present.
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id);
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS customers_org_name_idx ON public.customers (organization_id, name);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customers org isolation" ON public.customers;
CREATE POLICY "customers org isolation" ON public.customers FOR ALL
  USING (organization_id = public.user_organization_id())
  WITH CHECK (organization_id = public.user_organization_id());

-- 2) SUPPLIERS: contact fields -------------------------------------------------
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS notes TEXT;

-- 3) QUOTES: internal vs customer-facing notes ---------------------------------
-- internal_notes must never be rendered in the customer PDF or email.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS internal_notes TEXT;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS customer_notes TEXT;

-- 4) QUOTE LINE ITEMS ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quote_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  quote_id UUID NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_line_items_quote_idx ON public.quote_line_items (quote_id, position);

ALTER TABLE public.quote_line_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quote_line_items org isolation" ON public.quote_line_items;
CREATE POLICY "quote_line_items org isolation" ON public.quote_line_items FOR ALL
  USING (organization_id = public.user_organization_id())
  WITH CHECK (organization_id = public.user_organization_id());

-- 5) QUOTE ATTACHMENTS (metadata; files live in storage bucket quote-attachments)
CREATE TABLE IF NOT EXISTS public.quote_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  quote_ref TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes BIGINT,
  uploaded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_attachments_org_ref_idx ON public.quote_attachments (organization_id, quote_ref);

ALTER TABLE public.quote_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quote_attachments org isolation" ON public.quote_attachments;
CREATE POLICY "quote_attachments org isolation" ON public.quote_attachments FOR ALL
  USING (organization_id = public.user_organization_id())
  WITH CHECK (organization_id = public.user_organization_id());

-- 6) STORAGE: private bucket + org-folder policies -----------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('quote-attachments', 'quote-attachments', false, 20971520)
ON CONFLICT (id) DO NOTHING;

-- Object path convention: <organization_id>/<quote_ref>/<filename>
DROP POLICY IF EXISTS "quote-attachments org select" ON storage.objects;
CREATE POLICY "quote-attachments org select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'quote-attachments' AND (storage.foldername(name))[1] = public.user_organization_id()::text);

DROP POLICY IF EXISTS "quote-attachments org insert" ON storage.objects;
CREATE POLICY "quote-attachments org insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'quote-attachments' AND (storage.foldername(name))[1] = public.user_organization_id()::text);

DROP POLICY IF EXISTS "quote-attachments org update" ON storage.objects;
CREATE POLICY "quote-attachments org update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'quote-attachments' AND (storage.foldername(name))[1] = public.user_organization_id()::text)
  WITH CHECK (bucket_id = 'quote-attachments' AND (storage.foldername(name))[1] = public.user_organization_id()::text);

DROP POLICY IF EXISTS "quote-attachments org delete" ON storage.objects;
CREATE POLICY "quote-attachments org delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'quote-attachments' AND (storage.foldername(name))[1] = public.user_organization_id()::text);
