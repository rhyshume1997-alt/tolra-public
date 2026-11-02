-- 135_import_source_ref.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 135 (PROVISIONAL NUMBER): the SliQ number an imported invoice, quote, purchase order, job or sales order had in SliQ (the reviewer's
-- decision 2, Mon 2 Nov: duplicate SliQ numbers; extended to jobs and sales orders when the jobs import joined the core import).
-- SliQ can give two documents the same number. The importer (scripts/sliq-import) then gives each its own Tolra number, the same every
-- run (the earliest keeps INV-0100 or J-1512, the next is INV-0100-B or J-1512-B, then -C), and keeps the number SliQ printed here,
-- so the original reference is never lost. Needs only 000 (invoices, quotes, purchase_orders, jobs, sales_orders).
--
-- WHAT CHANGES.
--   a. source_ref on public.invoices, public.quotes, public.purchase_orders, public.jobs and public.sales_orders: TEXT, new,
--      nullable. CHECK <table>_source_ref_check: NULL, or trimmed and 1 to 100 characters. Read like every other column (the
--      tables' grants and policies are not changed).
--   b. public.source_ref_import_only() (new trigger function) and one BEFORE INSERT OR UPDATE OF source_ref trigger per table
--      (source_ref_import_only): a signed-in session (anon, authenticated, also inside their SECURITY DEFINER calls) cannot set
--      source_ref on a new row or change it on an existing one (42501, hint source_ref_import_only). Only the import (the database
--      owner, as public.import_legacy_tenant runs) and the service role write it. Every app path leaves it NULL, so none is refused.
-- EXISTING ROWS ARE NOT CHANGED: every document starts with source_ref NULL. No policy, grant, function or other column is touched.
-- GUARD (section 1): the five tables exist; the function, if present, is this file's (md5 with every whitespace character removed).
-- Safe to run again. SELF-CHECK (section 4). Verify: supabase/verify/import_source_ref_135.sql (every row TRUE).
-- Rollback: supabase/release/135_import_source_ref.rollback.sql (refuses while any document has a source_ref; only with Rhys's
-- approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard.
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  IF to_regclass('public.invoices') IS NULL OR to_regclass('public.quotes') IS NULL OR to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.jobs') IS NULL OR to_regclass('public.sales_orders') IS NULL THEN
    RAISE EXCEPTION '135: invoices, quotes, purchase_orders, jobs or sales_orders (000) is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('invoices', 'quotes', 'purchase_orders', 'jobs', 'sales_orders')
               AND column_name = 'source_ref' AND data_type <> 'text') THEN
    RAISE EXCEPTION '135: a source_ref column already exists with another type; stop and compare it first';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.source_ref_import_only()') INTO v_md5;
  IF v_md5 IS NOT NULL AND v_md5 <> '169cd2798340f7ba1d43b8b85e3be923' THEN
    RAISE EXCEPTION '135: public.source_ref_import_only() exists with another body (md5 %); stop and compare it first', v_md5;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The columns: nullable, trimmed, at most 100 characters. Every existing document starts with none.
ALTER TABLE public.invoices        ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE public.quotes          ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE public.jobs            ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE public.sales_orders    ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE public.invoices        DROP CONSTRAINT IF EXISTS invoices_source_ref_check;
ALTER TABLE public.invoices        ADD CONSTRAINT invoices_source_ref_check CHECK (source_ref IS NULL OR (source_ref = btrim(source_ref) AND length(source_ref) BETWEEN 1 AND 100));
ALTER TABLE public.quotes          DROP CONSTRAINT IF EXISTS quotes_source_ref_check;
ALTER TABLE public.quotes          ADD CONSTRAINT quotes_source_ref_check CHECK (source_ref IS NULL OR (source_ref = btrim(source_ref) AND length(source_ref) BETWEEN 1 AND 100));
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_source_ref_check;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_source_ref_check CHECK (source_ref IS NULL OR (source_ref = btrim(source_ref) AND length(source_ref) BETWEEN 1 AND 100));
ALTER TABLE public.jobs            DROP CONSTRAINT IF EXISTS jobs_source_ref_check;
ALTER TABLE public.jobs            ADD CONSTRAINT jobs_source_ref_check CHECK (source_ref IS NULL OR (source_ref = btrim(source_ref) AND length(source_ref) BETWEEN 1 AND 100));
ALTER TABLE public.sales_orders    DROP CONSTRAINT IF EXISTS sales_orders_source_ref_check;
ALTER TABLE public.sales_orders    ADD CONSTRAINT sales_orders_source_ref_check CHECK (source_ref IS NULL OR (source_ref = btrim(source_ref) AND length(source_ref) BETWEEN 1 AND 100));

-- -----------------------------------------------------------------------------------------------------
-- 3. Only the import writes it. A trigger function: not callable from the API.
CREATE OR REPLACE FUNCTION public.source_ref_import_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_ref IS NOT NULL THEN
      RAISE EXCEPTION 'The SliQ reference is set only by the data import.' USING ERRCODE = '42501', HINT = 'source_ref_import_only';
    END IF;
  ELSIF NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
    RAISE EXCEPTION 'The SliQ reference of an imported document cannot be changed.' USING ERRCODE = '42501', HINT = 'source_ref_import_only';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.source_ref_import_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS source_ref_import_only ON public.invoices;
CREATE TRIGGER source_ref_import_only BEFORE INSERT OR UPDATE OF source_ref ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.source_ref_import_only();
DROP TRIGGER IF EXISTS source_ref_import_only ON public.quotes;
CREATE TRIGGER source_ref_import_only BEFORE INSERT OR UPDATE OF source_ref ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.source_ref_import_only();
DROP TRIGGER IF EXISTS source_ref_import_only ON public.purchase_orders;
CREATE TRIGGER source_ref_import_only BEFORE INSERT OR UPDATE OF source_ref ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.source_ref_import_only();
DROP TRIGGER IF EXISTS source_ref_import_only ON public.jobs;
CREATE TRIGGER source_ref_import_only BEFORE INSERT OR UPDATE OF source_ref ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.source_ref_import_only();
DROP TRIGGER IF EXISTS source_ref_import_only ON public.sales_orders;
CREATE TRIGGER source_ref_import_only BEFORE INSERT OR UPDATE OF source_ref ON public.sales_orders FOR EACH ROW EXECUTE FUNCTION public.source_ref_import_only();

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check: five columns, five checks, five triggers, and the function is this file's.
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('invoices', 'quotes', 'purchase_orders', 'jobs', 'sales_orders')
        AND column_name = 'source_ref' AND data_type = 'text' AND is_nullable = 'YES') <> 5 THEN
    RAISE EXCEPTION '135 self-check: a source_ref column is missing';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('invoices_source_ref_check', 'quotes_source_ref_check', 'purchase_orders_source_ref_check',
        'jobs_source_ref_check', 'sales_orders_source_ref_check') AND convalidated) <> 5 THEN
    RAISE EXCEPTION '135 self-check: a source_ref CHECK is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgname = 'source_ref_import_only' AND NOT t.tgisinternal AND t.tgenabled = 'O'
        AND t.tgfoid = to_regprocedure('public.source_ref_import_only()')
        AND t.tgrelid IN (to_regclass('public.invoices'), to_regclass('public.quotes'), to_regclass('public.purchase_orders'),
                          to_regclass('public.jobs'), to_regclass('public.sales_orders'))) <> 5 THEN
    RAISE EXCEPTION '135 self-check: a source_ref_import_only trigger is missing';
  END IF;
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.source_ref_import_only()')) <> '169cd2798340f7ba1d43b8b85e3be923' THEN
    RAISE EXCEPTION '135 self-check: public.source_ref_import_only() is not this file''s';
  END IF;
END
$$;

COMMIT;
