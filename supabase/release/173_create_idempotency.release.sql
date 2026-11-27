-- Post-144 release package 173 (CR-010, CR-011, CR-012, CR-013, CR-020: forward-only creation idempotency for quotes, invoices, sales orders, purchase orders, and jobs).
-- Canonical source: supabase/proposals/p173_create_idempotency.sql (its body between BEGIN; and COMMIT; is copied below verbatim).
-- Not applied anywhere hosted. Verify with supabase/verify/create_idempotency_173.sql. Rollback: supabase/release/173_create_idempotency.rollback.sql.
-- Inputs: existing quotes, invoices, sales_orders, purchase_orders, jobs, create_with_lines, create_job, next_doc_number.
-- Outputs: five nullable request_id UUID columns, five partial unique indexes, five immutability triggers + trigger function, four idempotent create RPCs.
-- Must not change: any existing row, existing column, existing trigger, or existing function body.
BEGIN;
DO $post_release_guard$
BEGIN
  IF to_regclass('public.quotes') IS NULL
     OR to_regclass('public.invoices') IS NULL
     OR to_regclass('public.sales_orders') IS NULL
     OR to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION '173: one or more target tables (quotes, invoices, sales_orders, purchase_orders, jobs) are missing; stop and run release preflight';
  END IF;
  IF to_regprocedure('public.create_with_lines(text,jsonb,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.create_job(text,text,boolean,uuid,date,jsonb,boolean,jsonb,text)') IS NULL
     OR to_regprocedure('public.next_doc_number(text)') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL THEN
    RAISE EXCEPTION '173: required prerequisite functions (create_with_lines, create_job, next_doc_number, current_user_organization_id) are missing; apply migrations through 073 first';
  END IF;
END
$post_release_guard$;

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_org_request_uniq
  ON public.quotes (organization_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_request_uniq
  ON public.invoices (organization_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_org_request_uniq
  ON public.sales_orders (organization_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_org_request_uniq
  ON public.purchase_orders (organization_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_org_request_uniq
  ON public.jobs (organization_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_request_id_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'request_id cannot be changed once recorded.'
      USING ERRCODE = '42501', HINT = 'request_id_immutable';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.create_request_id_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quotes_request_id_immutable ON public.quotes;
CREATE TRIGGER quotes_request_id_immutable
  BEFORE UPDATE OF request_id ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.create_request_id_immutable();

DROP TRIGGER IF EXISTS invoices_request_id_immutable ON public.invoices;
CREATE TRIGGER invoices_request_id_immutable
  BEFORE UPDATE OF request_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.create_request_id_immutable();

DROP TRIGGER IF EXISTS sales_orders_request_id_immutable ON public.sales_orders;
CREATE TRIGGER sales_orders_request_id_immutable
  BEFORE UPDATE OF request_id ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.create_request_id_immutable();

DROP TRIGGER IF EXISTS purchase_orders_request_id_immutable ON public.purchase_orders;
CREATE TRIGGER purchase_orders_request_id_immutable
  BEFORE UPDATE OF request_id ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.create_request_id_immutable();

DROP TRIGGER IF EXISTS jobs_request_id_immutable ON public.jobs;
CREATE TRIGGER jobs_request_id_immutable
  BEFORE UPDATE OF request_id ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.create_request_id_immutable();

-- CR-010 (quotes) & CR-011 (draft invoices): idempotent wrapper over public.create_with_lines.
-- SECURITY INVOKER so existing RLS policies and create_with_lines validations govern every write.
CREATE OR REPLACE FUNCTION public.create_with_lines_idempotent(
  p_request_id UUID,
  p_parent TEXT,
  p_header JSONB,
  p_child TEXT,
  p_fk TEXT,
  p_lines JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_prior UUID;
  v_hdr   JSONB;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'p_request_id is required' USING ERRCODE = '22023';
  END IF;
  IF NOT ((p_parent, p_child, p_fk) IN (
        VALUES ('quotes', 'quote_line_items', 'quote_id'),
               ('invoices', 'invoice_line_items', 'invoice_id')
      )) THEN
    RAISE EXCEPTION 'create_with_lines_idempotent: table combination not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION 'p_header must be a JSON object' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('create_with_lines:' || p_parent || ':' || v_org::TEXT || ':' || p_request_id::TEXT, 0));

  EXECUTE format('SELECT id FROM public.%I WHERE organization_id = $1 AND request_id = $2', p_parent)
    INTO v_prior USING v_org, p_request_id;
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;

  v_hdr := p_header || jsonb_build_object('request_id', p_request_id);
  IF p_parent = 'quotes' AND nullif(btrim(coalesce(v_hdr ->> 'quote_ref', '')), '') IS NULL THEN
    v_hdr := v_hdr || jsonb_build_object('quote_ref', public.next_doc_number('QUO'));
  END IF;

  RETURN public.create_with_lines(p_parent, v_hdr, p_child, p_fk, p_lines);
END
$$;
REVOKE ALL ON FUNCTION public.create_with_lines_idempotent(UUID, TEXT, JSONB, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_with_lines_idempotent(UUID, TEXT, JSONB, TEXT, TEXT, JSONB) TO authenticated;

-- CR-012: idempotent manual sales-order creation. SECURITY INVOKER so RLS governs the insert.
CREATE OR REPLACE FUNCTION public.create_sales_order_idempotent(
  p_request_id UUID,
  p_header JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org       UUID := public.current_user_organization_id();
  v_uid       UUID := auth.uid();
  v_id        UUID;
  v_so_number TEXT;
  v_hdr       JSONB;
  v_pcols     TEXT[];
  v_key       TEXT;
  v_cols      TEXT;
  v_sel       TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'p_request_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION 'p_header must be a JSON object' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('sales_orders:' || v_org::TEXT || ':' || p_request_id::TEXT, 0));

  SELECT id, so_number INTO v_id, v_so_number
  FROM public.sales_orders
  WHERE organization_id = v_org AND request_id = p_request_id;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_id, 'so_number', v_so_number, 'replayed', TRUE);
  END IF;

  SELECT array_agg(attname::TEXT) INTO v_pcols
  FROM pg_attribute
  WHERE attrelid = 'public.sales_orders'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

  v_hdr := p_header - 'id' - 'organization_id' - 'created_by' - 'updated_by' - 'request_id';
  FOR v_key IN SELECT jsonb_object_keys(v_hdr) LOOP
    IF v_key !~ '^[a-z_][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'invalid column name in header: %', v_key USING ERRCODE = '22023';
    END IF;
    IF NOT (v_key = ANY (v_pcols)) THEN
      RAISE EXCEPTION 'unknown column "%" for sales_orders', v_key USING ERRCODE = '42703';
    END IF;
  END LOOP;

  IF nullif(btrim(coalesce(v_hdr ->> 'so_number', '')), '') IS NULL THEN
    v_hdr := v_hdr || jsonb_build_object('so_number', public.next_doc_number('SO'));
  END IF;
  v_hdr := v_hdr || jsonb_build_object('organization_id', v_org, 'request_id', p_request_id);
  IF 'created_by' = ANY (v_pcols) THEN v_hdr := v_hdr || jsonb_build_object('created_by', v_uid); END IF;
  IF 'updated_by' = ANY (v_pcols) THEN v_hdr := v_hdr || jsonb_build_object('updated_by', v_uid); END IF;

  SELECT string_agg(quote_ident(k), ', '), string_agg('r.' || quote_ident(k), ', ')
  INTO v_cols, v_sel
  FROM jsonb_object_keys(v_hdr) AS k;

  EXECUTE format(
    'INSERT INTO public.sales_orders (%s) SELECT %s FROM jsonb_populate_record(NULL::public.sales_orders, $1) AS r RETURNING id, so_number',
    v_cols, v_sel
  )
  INTO v_id, v_so_number USING v_hdr;

  RETURN jsonb_build_object('id', v_id, 'so_number', v_so_number, 'replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.create_sales_order_idempotent(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sales_order_idempotent(UUID, JSONB) TO authenticated;

-- CR-013: idempotent purchase-order creation. SECURITY INVOKER so RLS governs the insert.
CREATE OR REPLACE FUNCTION public.create_purchase_order_idempotent(
  p_request_id UUID,
  p_header JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_uid    UUID := auth.uid();
  v_id     UUID;
  v_po_ref TEXT;
  v_hdr    JSONB;
  v_pcols  TEXT[];
  v_key    TEXT;
  v_cols   TEXT;
  v_sel    TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'p_request_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION 'p_header must be a JSON object' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('purchase_orders:' || v_org::TEXT || ':' || p_request_id::TEXT, 0));

  SELECT id, po_ref INTO v_id, v_po_ref
  FROM public.purchase_orders
  WHERE organization_id = v_org AND request_id = p_request_id;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_id, 'po_ref', v_po_ref, 'replayed', TRUE);
  END IF;

  SELECT array_agg(attname::TEXT) INTO v_pcols
  FROM pg_attribute
  WHERE attrelid = 'public.purchase_orders'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

  v_hdr := p_header - 'id' - 'organization_id' - 'created_by' - 'updated_by' - 'request_id';
  FOR v_key IN SELECT jsonb_object_keys(v_hdr) LOOP
    IF v_key !~ '^[a-z_][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'invalid column name in header: %', v_key USING ERRCODE = '22023';
    END IF;
    IF NOT (v_key = ANY (v_pcols)) THEN
      RAISE EXCEPTION 'unknown column "%" for purchase_orders', v_key USING ERRCODE = '42703';
    END IF;
  END LOOP;

  v_po_ref := nullif(btrim(coalesce(v_hdr ->> 'po_ref', '')), '');
  IF v_po_ref IS NULL THEN
    v_po_ref := public.next_doc_number('PO');
    v_hdr := v_hdr || jsonb_build_object('po_ref', v_po_ref);
  END IF;
  IF nullif(btrim(coalesce(v_hdr ->> 'po_number', '')), '') IS NULL THEN
    v_hdr := v_hdr || jsonb_build_object('po_number', v_po_ref);
  END IF;
  v_hdr := v_hdr || jsonb_build_object('organization_id', v_org, 'request_id', p_request_id);
  IF 'created_by' = ANY (v_pcols) THEN v_hdr := v_hdr || jsonb_build_object('created_by', v_uid); END IF;
  IF 'updated_by' = ANY (v_pcols) THEN v_hdr := v_hdr || jsonb_build_object('updated_by', v_uid); END IF;

  SELECT string_agg(quote_ident(k), ', '), string_agg('r.' || quote_ident(k), ', ')
  INTO v_cols, v_sel
  FROM jsonb_object_keys(v_hdr) AS k;

  EXECUTE format(
    'INSERT INTO public.purchase_orders (%s) SELECT %s FROM jsonb_populate_record(NULL::public.purchase_orders, $1) AS r RETURNING id, po_ref',
    v_cols, v_sel
  )
  INTO v_id, v_po_ref USING v_hdr;

  RETURN jsonb_build_object('id', v_id, 'po_ref', v_po_ref, 'replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.create_purchase_order_idempotent(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_order_idempotent(UUID, JSONB) TO authenticated;

-- CR-020: idempotent manual job creation wrapper over public.create_job.
-- Checks prior request_id under the per-company job-no advisory lock before clash checks or job number allocation.
CREATE OR REPLACE FUNCTION public.create_job_idempotent(
  p_request_id UUID,
  p_customer TEXT,
  p_description TEXT,
  p_internal BOOLEAN,
  p_related UUID,
  p_required DATE,
  p_machines JSONB,
  p_clash_override BOOLEAN,
  p_clashes JSONB,
  p_override_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_id      UUID;
  v_job_no  TEXT;
  v_created JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can create jobs' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'p_request_id is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));

  SELECT id, job_no INTO v_id, v_job_no
  FROM public.jobs
  WHERE organization_id = v_org AND request_id = p_request_id;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('job_id', v_id, 'job_no', v_job_no, 'replayed', TRUE);
  END IF;

  v_created := public.create_job(
    p_customer, p_description, p_internal, p_related, p_required,
    p_machines, p_clash_override, p_clashes, p_override_reason
  );

  UPDATE public.jobs
  SET request_id = p_request_id
  WHERE id = (v_created ->> 'job_id')::UUID
    AND organization_id = v_org
    AND request_id IS NULL;

  RETURN v_created || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.create_job_idempotent(UUID, TEXT, TEXT, BOOLEAN, UUID, DATE, JSONB, BOOLEAN, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_job_idempotent(UUID, TEXT, TEXT, BOOLEAN, UUID, DATE, JSONB, BOOLEAN, JSONB, TEXT) TO authenticated;

DO $p173_self_check$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('quotes', 'invoices', 'sales_orders', 'purchase_orders', 'jobs')
        AND column_name = 'request_id'
        AND data_type = 'uuid'
        AND is_nullable = 'YES') <> 5 THEN
    RAISE EXCEPTION '173 self-check: request_id uuid column missing on one or more target tables';
  END IF;
  IF (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('quotes_org_request_uniq', 'invoices_org_request_uniq', 'sales_orders_org_request_uniq', 'purchase_orders_org_request_uniq', 'jobs_org_request_uniq')) <> 5 THEN
    RAISE EXCEPTION '173 self-check: one or more partial unique indexes on (organization_id, request_id) are missing';
  END IF;
  IF to_regprocedure('public.create_request_id_immutable()') IS NULL
     OR to_regprocedure('public.create_with_lines_idempotent(uuid,text,jsonb,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.create_sales_order_idempotent(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.create_purchase_order_idempotent(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.create_job_idempotent(uuid,text,text,boolean,uuid,date,jsonb,boolean,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '173 self-check: one or more release 173 functions are missing';
  END IF;
END
$p173_self_check$;

COMMIT;
