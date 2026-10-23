-- 005: fields and line-item tables needed to print invoices, delivery notes and sales orders.
-- Idempotent: safe to run more than once. Run after 000_base_schema.sql and 001-004. Run this BEFORE supabase/fixtures/demo_documents.sql.
--
-- Document numbering used by the app (see lib/numbering.ts):
--   quotes QUO-####, invoices INV-####, delivery notes DLN-#### (same number as the invoice), jobs J-#### (same number as the quote).

-- 1) INVOICES: the details printed on an invoice ----------------------------------
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_date DATE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS terms TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS quote_ref TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS customer_po TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS carriage NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_pct NUMERIC(5,2) NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_line_items_invoice_idx ON public.invoice_line_items (invoice_id, position);

ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_line_items org isolation" ON public.invoice_line_items;
CREATE POLICY "invoice_line_items org isolation" ON public.invoice_line_items FOR ALL
  USING (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin']))
  WITH CHECK (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin']));

-- 2) DELIVERY NOTES: what the pages read, plus the ship/tax dates and items on the printed note
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS customer TEXT;
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS job_ref TEXT;
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS invoice_ref TEXT;
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS tax_date DATE;
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS ship_date DATE;
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS ship_via TEXT;

CREATE TABLE IF NOT EXISTS public.delivery_note_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  delivery_note_id UUID NOT NULL REFERENCES public.delivery_notes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_note_items_note_idx ON public.delivery_note_items (delivery_note_id, position);

ALTER TABLE public.delivery_note_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "delivery_note_items org isolation" ON public.delivery_note_items;
CREATE POLICY "delivery_note_items org isolation" ON public.delivery_note_items FOR ALL
  USING (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
  WITH CHECK (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));

-- 3) SALES ORDERS: the sales orders page reads a plain customer name
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS customer TEXT;

-- One document number per organisation, so two people saving at once can't
-- both take the same QUO-/INV-/DLN-/J- number (the second save fails instead).
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('quotes', 'quote_ref'),
    ('invoices', 'invoice_ref'),
    ('delivery_notes', 'dn_number'),
    ('jobs', 'job_no')
  ) AS v(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = t.col
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = 'organization_id'
    ) THEN
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (organization_id, %I) WHERE %I IS NOT NULL',
        t.tbl || '_' || t.col || '_unique', t.tbl, t.col, t.col
      );
    END IF;
  END LOOP;
END $$;
