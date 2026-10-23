-- =====================================================================================================
-- 010: VAT OPTIONS ON DOCUMENTS
-- Company level (no schema change): organization_settings.company_profile gains "vatRegistered" (default true)
-- and "defaultVatRate" (default 20), edited in Settings > Company details.
--
-- Document level: an "Add VAT" switch on quotes, invoices, sales orders and purchase orders, a VAT rate per line
-- (20 / 5 / 0 / exempt) and, on invoices, VAT on carriage at the standard rate.
--
-- Nothing is recalculated. The column defaults describe how existing documents were already printed:
--   * quotes, invoices: VAT on (lines were taxed at 20%); carriage untaxed (carriage_vat = false)
--   * sales orders, purchase orders: VAT off (they were printed ex VAT)
--   * existing lines: their stored rate (quote lines had none: 20, as printed); none exempt
-- so every stored total and every reprinted PDF of an existing or imported document stays the same. The app sets
-- the new fields explicitly on every document it creates. Safe to re-run.
-- =====================================================================================================

ALTER TABLE public.quotes          ADD COLUMN IF NOT EXISTS vat_enabled  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS vat_enabled  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS carriage_vat BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.sales_orders    ADD COLUMN IF NOT EXISTS vat_enabled  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS vat_enabled  BOOLEAN NOT NULL DEFAULT FALSE;

-- Line rates. Sales orders hold one order value (no line table), so their rate sits on the order.
-- Purchase-order lines are JSON items: { description, qty, unit_price, vat_pct, vat_exempt }.
ALTER TABLE public.quote_line_items   ADD COLUMN IF NOT EXISTS vat_pct    NUMERIC(5,2) NOT NULL DEFAULT 20;
ALTER TABLE public.quote_line_items   ADD COLUMN IF NOT EXISTS vat_exempt BOOLEAN      NOT NULL DEFAULT FALSE;
ALTER TABLE public.invoice_line_items ADD COLUMN IF NOT EXISTS vat_exempt BOOLEAN      NOT NULL DEFAULT FALSE;
ALTER TABLE public.sales_orders       ADD COLUMN IF NOT EXISTS vat_pct    NUMERIC(5,2) NOT NULL DEFAULT 20;
ALTER TABLE public.sales_orders       ADD COLUMN IF NOT EXISTS vat_exempt BOOLEAN      NOT NULL DEFAULT FALSE;

DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote_line_items', 'invoice_line_items', 'sales_orders'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_vat_pct_range') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (vat_pct >= 0 AND vat_pct <= 100)', t, t || '_vat_pct_range');
    END IF;
  END LOOP;
END
$do$;

-- Check, right after running. Expect: new_columns = 10 and the four other counts = 0 (existing documents unchanged).
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name IN ('quotes', 'invoices', 'sales_orders', 'purchase_orders') AND column_name = 'vat_enabled')
        OR (table_name = 'invoices' AND column_name = 'carriage_vat')
        OR (table_name IN ('quote_line_items', 'sales_orders') AND column_name = 'vat_pct')
        OR (table_name IN ('quote_line_items', 'invoice_line_items', 'sales_orders') AND column_name = 'vat_exempt'))) AS new_columns,
  (SELECT count(*) FROM public.invoices WHERE carriage_vat) AS invoices_with_carriage_vat,
  (SELECT count(*) FROM public.sales_orders WHERE vat_enabled) AS sales_orders_with_vat,
  (SELECT count(*) FROM public.purchase_orders WHERE vat_enabled) AS purchase_orders_with_vat,
  (SELECT count(*) FROM public.quotes WHERE NOT vat_enabled) AS quotes_without_vat;
