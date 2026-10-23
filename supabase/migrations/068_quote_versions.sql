-- =====================================================================================================
-- 068: Quote versions, partial acceptance, and a part / drawing / revision on each quote line (John, JNR).
--
-- 1. Versions. quotes.version (1 for every existing quote) and quotes.previous_version_id (the version it revises). A revision keeps
--    the quote's number with a version suffix: QUO-0123, then quote_ref 'QUO-0123 v2', 'QUO-0123 v3' (quote_ref stays unique per
--    company, so every list, order, job and PDF shows which version it is). Its job still takes J-0123 when free, and the quote's
--    attachments (filed under QUO-0123) belong to every version. revise_quote(p_quote): admin or office with the Quotes section, second step, the caller's
--    company. Locks the quote (FOR UPDATE); only a SENT quote that has not been revised yet is revised. It makes the next version as a
--    DRAFT (header, lines and part / drawing details copied; fresh snapshots; a valid-until date already past is left empty, so Send
--    gives it a new one) and marks the revised one 'superseded' (final, read
--    only, still viewable). One revision per version (unique index quotes_one_revision_each), so two people revising at once make
--    one. Audited (REVISE). Only the latest version can be decided: a superseded quote, or one that has a newer version, can't be
--    accepted or rejected (accept_quote and the lifecycle guard both refuse). A revision is made only by revise_quote
--    (quote_version_guard), and version / previous_version_id never change afterwards. Deleting a revision while it is still a
--    draft (drafts may be deleted, 020) puts the version it revised back to 'sent' (quote_revision_withdrawn).
-- 2. Partial acceptance. quote_line_items.declined (FALSE: every existing line counts as ordered). accept_quote gains p_lines (the
--    ids of the lines the customer's PO covers; NULL = all, as before). On the accepting call the other lines are marked declined;
--    nobody else can change the flag (quote_lines_issue_lock: only inside accept_quote, and on an issued quote that flag is all it may
--    change). The sales order, its lines, the job's worksheet text and so the delivery notes and invoice carry the ordered lines only:
--    create_sales_order_from_quote, ensure_sales_order_lines and convert_sales_order skip declined lines. With every line ordered
--    the order is checked against the quote's stored total exactly as 058 does; with some declined, against the ordered lines' own
--    per-line VAT rounding (lib/order-from-quote.ts does the same).
-- 3. One row per part. quote_line_items and sales_order_lines get part_number, drawing_number, drawing_revision (optional text).
--    replace_draft_quote keeps them (create_with_lines already writes any line column); on every write to a quote line they are
--    trimmed and a blank one stored as none (quote_line_part_clean). ensure_sales_order_lines copies them; the job's
--    worksheet text names them per line, and a job of one line takes its drawing number (and revision) as the worksheet's drawing no.
--
-- accept_quote(UUID, TEXT, DATE) is replaced by accept_quote(UUID, TEXT, DATE, UUID[] DEFAULT NULL): calls with three arguments work
-- unchanged. Everything else of 058 is kept: SECURITY DEFINER, pinned search_path, second step first, role + section + company,
-- the quote row lock, idempotency (an accepted quote returns its order and job, no new audit event), SO-#### numbering, one order per
-- quote, the job through convert_sales_order. Existing quotes: version 1, no previous version, every line ordered: they behave as
-- before. Forward only, safe to run more than once. Rollback: docs/RELEASE.md "068".
--
-- Builds on 067 (apply 067 first; this file stops otherwise). 067's quote_attachments_customer_po_to_jobs puts a customer PO uploaded
-- to a quote on the quote's jobs by matching jobs.quote_ref to the attachment's quote_ref. Attachments are filed under the quote's own
-- number (QUO-0123) for every version, while a job made from v2 has quote_ref 'QUO-0123 v2'; section 9 re-points the trigger at the
-- base number through jobs.quote_id (and still matches jobs.quote_ref, for jobs made before 058 linked a quote by id).
-- =====================================================================================================

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quote_attachments' AND column_name = 'kind')
     OR to_regprocedure('public.quote_attachments_customer_po_to_jobs()') IS NULL THEN
    RAISE EXCEPTION '068 stopped: apply 067 (document attachments) first. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. Columns ------------------------------------------------------------------------------------------------
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS previous_version_id UUID REFERENCES public.quotes(id);
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_version_chain' AND conrelid = 'public.quotes'::regclass) THEN
    ALTER TABLE public.quotes ADD CONSTRAINT quotes_version_chain
      CHECK (version >= 1 AND (previous_version_id IS NULL) = (version = 1) AND previous_version_id IS DISTINCT FROM id);
  END IF;
END
$do$;
CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_revision_each ON public.quotes (previous_version_id) WHERE previous_version_id IS NOT NULL;
DROP TRIGGER IF EXISTS zz_same_org_previous_version_id ON public.quotes;
CREATE TRIGGER zz_same_org_previous_version_id BEFORE INSERT OR UPDATE OF previous_version_id, organization_id ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('quotes', 'previous_version_id');

ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS declined BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS part_number TEXT;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS drawing_number TEXT;
ALTER TABLE public.quote_line_items ADD COLUMN IF NOT EXISTS drawing_revision TEXT;
ALTER TABLE public.sales_order_lines ADD COLUMN IF NOT EXISTS part_number TEXT;
ALTER TABLE public.sales_order_lines ADD COLUMN IF NOT EXISTS drawing_number TEXT;
ALTER TABLE public.sales_order_lines ADD COLUMN IF NOT EXISTS drawing_revision TEXT;
DO $do$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['quote_line_items', 'sales_order_lines'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_table || '_part_details' AND conrelid = format('public.%I', v_table)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ('
        || '(part_number IS NULL OR length(btrim(part_number)) BETWEEN 1 AND 100) AND '
        || '(drawing_number IS NULL OR length(btrim(drawing_number)) BETWEEN 1 AND 100) AND '
        || '(drawing_revision IS NULL OR length(btrim(drawing_revision)) BETWEEN 1 AND 20))', v_table, v_table || '_part_details');
    END IF;
  END LOOP;
END
$do$;

-- Part / drawing / revision as replace_draft_quote stores them, whatever writes the line (create_with_lines, a plain insert): trimmed,
-- blank = none. Runs before the row's checks, so "   " is stored as NULL instead of failing quote_line_items_part_details.
CREATE OR REPLACE FUNCTION public.quote_line_part_clean()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.part_number := nullif(btrim(NEW.part_number), '');
  NEW.drawing_number := nullif(btrim(NEW.drawing_number), '');
  NEW.drawing_revision := nullif(btrim(NEW.drawing_revision), '');
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.quote_line_part_clean() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS quote_line_part_clean ON public.quote_line_items;
CREATE TRIGGER quote_line_part_clean BEFORE INSERT OR UPDATE OF part_number, drawing_number, drawing_revision ON public.quote_line_items
  FOR EACH ROW EXECUTE FUNCTION public.quote_line_part_clean();

-- "Part P-100; Dwg D-200 rev C" (NULL when the line has none of them): the worksheet text and lib/quote-versions.ts lineReference.
CREATE OR REPLACE FUNCTION public.quote_line_reference(p_part TEXT, p_drawing TEXT, p_revision TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT nullif(concat_ws('; ',
    'Part ' || nullif(btrim(p_part), ''),
    CASE WHEN nullif(btrim(p_drawing), '') IS NOT NULL THEN 'Dwg ' || btrim(p_drawing) || coalesce(' rev ' || nullif(btrim(p_revision), ''), '')
         ELSE 'Rev ' || nullif(btrim(p_revision), '') END), '')
$$;
-- convert_sales_order (INVOKER) calls it as the signed-in user: a pure text helper, so signed-in callers may run it.
REVOKE ALL ON FUNCTION public.quote_line_reference(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quote_line_reference(TEXT, TEXT, TEXT) TO authenticated;

-- The quote's number without its version suffix ('QUO-0123 v2' -> 'QUO-0123'; version 1 is the number itself): the J number and the
-- attachments folder of every version (lib/quote-versions.ts baseQuoteRef).
CREATE OR REPLACE FUNCTION public.quote_base_ref(p_ref TEXT, p_version INTEGER)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN coalesce(p_version, 1) > 1 THEN regexp_replace(p_ref, '\s+v\d+\s*$', '') ELSE p_ref END
$$;
-- Called as the signed-in user by convert_sales_order (INVOKER) and the customer-PO trigger (067, re-pointed below): signed-in callers may run it.
REVOKE ALL ON FUNCTION public.quote_base_ref(TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quote_base_ref(TEXT, INTEGER) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Guards ------------------------------------------------------------------------------------------------
-- A revision is made only by revise_quote, and a quote's place in its chain never changes.
CREATE OR REPLACE FUNCTION public.quote_version_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.is_api_role() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF (NEW.previous_version_id IS NOT NULL OR NEW.version <> 1)
       AND coalesce(current_setting('quoteflow.revise_quote', TRUE), '') IS DISTINCT FROM NEW.previous_version_id::TEXT THEN
      RAISE EXCEPTION 'A new version of a quote is made with Revise on the quote it replaces.' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.version IS DISTINCT FROM OLD.version OR NEW.previous_version_id IS DISTINCT FROM OLD.previous_version_id THEN
    RAISE EXCEPTION 'Quote %: its version can''t be changed.', OLD.quote_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.quote_version_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS quote_version_guard ON public.quotes;
CREATE TRIGGER quote_version_guard BEFORE INSERT OR UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quote_version_guard();

-- The 020 body, plus: a quote that has a newer version can't be decided; sent -> superseded only once it has one (revise_quote);
-- superseded -> sent only when it no longer has one (its draft revision was deleted); a superseded quote is not sent again.
CREATE OR REPLACE FUNCTION public.quote_lifecycle_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_open    CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'accepted_at', 'rejected_at', 'internal_notes', 'updated_at', 'updated_by'];
  v_from    TEXT;
  v_to      TEXT;
  v_revised BOOLEAN;
BEGIN
  IF NOT public.is_api_role() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_from := coalesce(OLD.status, 'draft');
  IF TG_OP = 'DELETE' THEN
    IF v_from <> 'draft' THEN
      RAISE EXCEPTION 'Quote % has been issued, so it can''t be deleted.', OLD.quote_ref USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  v_to := coalesce(NEW.status, 'draft');
  IF v_to IS DISTINCT FROM v_from THEN
    v_revised := EXISTS (SELECT 1 FROM public.quotes q WHERE q.previous_version_id = OLD.id);
    IF v_revised AND v_to <> 'superseded' THEN
      RAISE EXCEPTION 'Quote % v% has been revised as a newer version: record the decision on the latest version.', OLD.quote_ref, OLD.version
        USING ERRCODE = '42501', HINT = 'quote_superseded';
    END IF;
    IF NOT (
         (v_from = 'draft' AND v_to IN ('sent', 'accepted', 'rejected'))
      OR (v_from = 'sent'  AND v_to IN ('accepted', 'rejected'))
      OR (v_from = 'sent'  AND v_to = 'superseded' AND v_revised)
      OR (v_from = 'superseded' AND v_to = 'sent' AND NOT v_revised)) THEN
      RAISE EXCEPTION 'Quote % can''t go from % to %.', OLD.quote_ref, v_from, v_to USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_from = 'superseded' AND v_to = 'superseded' AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'Quote % v% has been replaced by a newer version: send the latest version.', OLD.quote_ref, OLD.version USING ERRCODE = '42501';
  END IF;
  IF v_from <> 'draft' AND (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Quote % has been issued: correct a draft or copy it instead.', OLD.quote_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- The 020 body, plus: which lines the customer ordered (declined) is set only by accept_quote, and on an issued quote it is the only
-- change allowed (still nothing else of an issued quote's lines changes).
CREATE OR REPLACE FUNCTION public.quote_lines_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ref TEXT;
BEGIN
  IF public.is_api_role() THEN
    IF TG_OP <> 'DELETE' AND NEW.declined IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.declined ELSE FALSE END) THEN
      IF coalesce(current_setting('quoteflow.accept_quote', TRUE), '') IS DISTINCT FROM NEW.quote_id::TEXT THEN
        RAISE EXCEPTION 'Which lines the customer ordered is recorded when the quote is accepted.' USING ERRCODE = '42501';
      END IF;
      IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'declined') = (to_jsonb(OLD) - 'declined') THEN
        RETURN NEW;
      END IF;
    END IF;
    SELECT q.quote_ref INTO v_ref FROM public.quotes q
    WHERE q.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.quote_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.quote_id END)
      AND coalesce(q.status, 'draft') <> 'draft'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Quote % has been issued, so its lines can''t be changed.', v_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION public.quote_lines_issue_lock() FROM PUBLIC, anon, authenticated;

-- A revision deleted while still a draft: the version it revised is the latest again (sent).
CREATE OR REPLACE FUNCTION public.quote_revision_withdrawn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.quotes SET status = 'sent'
  WHERE id = OLD.previous_version_id AND organization_id = OLD.organization_id AND status = 'superseded';
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.quote_revision_withdrawn() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS quote_revision_withdrawn ON public.quotes;
CREATE TRIGGER quote_revision_withdrawn AFTER DELETE ON public.quotes
  FOR EACH ROW WHEN (OLD.previous_version_id IS NOT NULL) EXECUTE FUNCTION public.quote_revision_withdrawn();

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Revising a sent quote ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revise_quote(p_quote UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_old   public.quotes%ROWTYPE;
  v_next  public.quotes%ROWTYPE;
  v_new   UUID := gen_random_uuid();
  v_ref   TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('quotes') THEN
    RAISE EXCEPTION 'Only admin or office staff can revise a quote' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_old FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_next FROM public.quotes q WHERE q.previous_version_id = p_quote AND q.organization_id = v_org;
  IF FOUND THEN
    RAISE EXCEPTION '% v% has already been revised as v%: revise the latest version.', v_old.quote_ref, v_old.version, v_next.version
      USING ERRCODE = '22023', HINT = 'quote_superseded';
  END IF;
  IF coalesce(v_old.status, 'draft') <> 'sent' THEN
    RAISE EXCEPTION '% is %: only a sent quote is revised as a new version (edit a draft; a decided quote is final).', v_old.quote_ref,
      coalesce(v_old.status, 'draft') USING ERRCODE = '22023';
  END IF;

  -- The quote's number, then " v2", " v3", ...
  v_ref := public.quote_base_ref(v_old.quote_ref, v_old.version) || ' v' || (v_old.version + 1)::TEXT;
  IF EXISTS (SELECT 1 FROM public.quotes q WHERE q.organization_id = v_org AND q.quote_ref = v_ref) THEN
    RAISE EXCEPTION 'Another quote is already numbered %, so % can''t be revised as that version.', v_ref, v_old.quote_ref USING ERRCODE = '23505';
  END IF;

  PERFORM set_config('quoteflow.revise_quote', p_quote::TEXT, TRUE);
  INSERT INTO public.quotes (id, organization_id, quote_ref, rfq_id, customer, description, total_value, status, valid_until, internal_notes,
                             customer_notes, terms, vat_enabled, version, previous_version_id, issuer_snapshot, customer_snapshot)
  VALUES (v_new, v_org, v_ref, v_old.rfq_id, v_old.customer, v_old.description, v_old.total_value, 'draft',
          CASE WHEN v_old.valid_until >= CURRENT_DATE THEN v_old.valid_until END,  -- a date already past is dropped: Send gives a new one
          v_old.internal_notes, v_old.customer_notes, v_old.terms, v_old.vat_enabled, v_old.version + 1, p_quote,
          public.issuer_snapshot(v_org), public.customer_snapshot(v_org, v_old.customer));
  PERFORM set_config('quoteflow.revise_quote', '', TRUE);
  INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct, vat_exempt, source,
                                       part_number, drawing_number, drawing_revision)
  SELECT v_org, v_new, l.position, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt, l.source,
         l.part_number, l.drawing_number, l.drawing_revision
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org ORDER BY l.position, l.id;
  UPDATE public.quotes SET status = 'superseded' WHERE id = p_quote;

  PERFORM security_audit.log_named_event(v_org, 'REVISE', 'quotes', v_new::TEXT, jsonb_build_object(
    'quote_ref', v_ref, 'version', v_old.version + 1, 'previous_version_id', p_quote, 'previous_quote_ref', v_old.quote_ref));
  RETURN jsonb_build_object('quote_id', v_new, 'quote_ref', v_ref, 'version', v_old.version + 1,
    'previous_quote_id', p_quote, 'previous_quote_ref', v_old.quote_ref);
END
$$;
REVOKE ALL ON FUNCTION public.revise_quote(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revise_quote(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. A draft's correction keeps each line's part, drawing and revision ---------------------------------------------
-- The 021 body; the lines also take part_number, drawing_number, drawing_revision (blank = none).
CREATE OR REPLACE FUNCTION public.replace_draft_quote(p_quote UUID, p_expected_updated_at TIMESTAMPTZ, p_header JSONB, p_lines JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_quote   public.quotes%ROWTYPE;
  v_line    JSONB;
  v_idx     INT := 0;
  v_now     TIMESTAMPTZ := clock_timestamp();
  v_allowed CONSTANT TEXT[] := ARRAY['customer', 'description', 'customer_notes', 'internal_notes', 'terms', 'valid_until', 'vat_enabled', 'total_value'];
  v_key     TEXT;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_quote FROM public.quotes WHERE id = p_quote AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_quote.status, 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'Quote % has been issued: copy it to make changes.', v_quote.quote_ref USING ERRCODE = '42501';
  END IF;
  IF v_quote.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Quote % was changed by someone else since you opened it. Reload it and make your changes again.', v_quote.quote_ref
      USING ERRCODE = 'PT409';
  END IF;
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'header must be an object and lines an array' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_header) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'field "%" can''t be changed here', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one line item' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'too many lines (max 500)' USING ERRCODE = '22023';
  END IF;

  UPDATE public.quotes q SET
    customer       = CASE WHEN p_header ? 'customer' THEN p_header ->> 'customer' ELSE q.customer END,
    description    = CASE WHEN p_header ? 'description' THEN p_header ->> 'description' ELSE q.description END,
    customer_notes = CASE WHEN p_header ? 'customer_notes' THEN p_header ->> 'customer_notes' ELSE q.customer_notes END,
    internal_notes = CASE WHEN p_header ? 'internal_notes' THEN p_header ->> 'internal_notes' ELSE q.internal_notes END,
    terms          = CASE WHEN p_header ? 'terms' THEN p_header ->> 'terms' ELSE q.terms END,
    valid_until    = CASE WHEN p_header ? 'valid_until' THEN nullif(p_header ->> 'valid_until', '')::DATE ELSE q.valid_until END,
    vat_enabled    = CASE WHEN p_header ? 'vat_enabled' THEN (p_header ->> 'vat_enabled')::BOOLEAN ELSE q.vat_enabled END,
    total_value    = CASE WHEN p_header ? 'total_value' THEN (p_header ->> 'total_value')::NUMERIC ELSE q.total_value END,
    updated_at     = v_now,
    updated_by     = auth.uid()
  WHERE q.id = p_quote;

  DELETE FROM public.quote_line_items WHERE quote_id = p_quote;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    PERFORM public.check_priced_line(v_line);
    INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct, vat_exempt, source,
                                         part_number, drawing_number, drawing_revision)
    VALUES (v_org, p_quote, v_idx, btrim(v_line ->> 'description'), (v_line ->> 'quantity')::NUMERIC, (v_line ->> 'unit_price')::NUMERIC,
            coalesce((v_line ->> 'vat_pct')::NUMERIC, 20), coalesce((v_line ->> 'vat_exempt')::BOOLEAN, FALSE), coalesce(v_line ->> 'source', 'manual'),
            nullif(btrim(v_line ->> 'part_number'), ''), nullif(btrim(v_line ->> 'drawing_number'), ''), nullif(btrim(v_line ->> 'drawing_revision'), ''));
    v_idx := v_idx + 1;
  END LOOP;

  PERFORM public.check_document_totals('quotes', p_quote, v_org);
  UPDATE public.quotes SET issuer_snapshot = public.issuer_snapshot(v_org),
                           customer_snapshot = public.customer_snapshot(v_org, customer)
  WHERE id = p_quote;
  RETURN v_now;
END
$$;
REVOKE ALL ON FUNCTION public.replace_draft_quote(UUID, TIMESTAMPTZ, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_draft_quote(UUID, TIMESTAMPTZ, JSONB, JSONB) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. A quote's sales order: the ordered lines only (internal) -------------------------------------------------
-- The 058 body; every line read is an ordered one (NOT declined). With all lines ordered the checks are 058's, against the quote's
-- stored total; with some declined, against the ordered lines' own per-line rounding (the stored total is the whole quote's).
CREATE OR REPLACE FUNCTION public.create_sales_order_from_quote(p_quote UUID, p_customer_po TEXT, p_delivery_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_quote      public.quotes%ROWTYPE;
  v_po         TEXT := nullif(btrim(coalesce(p_customer_po, '')), '');
  v_by_hand    CONSTANT TEXT := 'Choose "No linked quote" and enter the order by hand.';
  v_lines      INTEGER;
  v_declined   INTEGER;
  v_value      NUMERIC;  -- the order's net value: the sum of each ordered line's net, each rounded to the penny
  v_vat_on     BOOLEAN;
  v_choice     TEXT;     -- '20' | '5' | '0' | 'exempt'
  v_kinds      INTEGER;
  v_only       TEXT;
  v_first_pct  NUMERIC;
  v_first_ex   BOOLEAN;
  v_quote_vat  NUMERIC;
  v_quote_net  NUMERIC;
  v_quote_gross NUMERIC;
  v_order_pct  NUMERIC;
  v_order_ex   BOOLEAN;
  v_order_vat  NUMERIC;
  v_order_gross NUMERIC;
  v_so_number  TEXT;
  v_so         public.sales_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;

  -- An order this quote already has (any path): that one, never a second.
  SELECT * INTO v_so FROM public.sales_orders s WHERE s.organization_id = v_org AND s.quote_id = p_quote;
  IF FOUND THEN
    RETURN jsonb_build_object('so_id', v_so.id, 'so_number', v_so.so_number, 'created', FALSE, 'provisional', v_so.customer_po IS NULL, 'reason', NULL, 'needs', NULL);
  END IF;

  -- ---- lib/order-from-quote.ts proposedTerms (ordered lines) ----
  SELECT count(*) FILTER (WHERE NOT l.declined), count(*) FILTER (WHERE l.declined),
         sum(round(coalesce(l.quantity, 0) * coalesce(l.unit_price, 0), 2)) FILTER (WHERE NOT l.declined),
         count(DISTINCT CASE WHEN l.vat_exempt THEN 'exempt' ELSE trim_scale(coalesce(l.vat_pct, 20))::TEXT END) FILTER (WHERE NOT l.declined),
         min(CASE WHEN l.vat_exempt THEN 'exempt' ELSE trim_scale(coalesce(l.vat_pct, 20))::TEXT END) FILTER (WHERE NOT l.declined)
    INTO v_lines, v_declined, v_value, v_kinds, v_only
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org;
  IF v_lines = 0 THEN
    RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand', 'reason', 'That quote has no lines to copy. ' || v_by_hand);
  END IF;
  v_vat_on := public.org_vat_registered(v_org) AND v_quote.vat_enabled IS DISTINCT FROM FALSE;
  IF NOT v_vat_on THEN
    -- VAT off: the first line's treatment is kept on the order (as toVatChoice does: 20, 5, 0 or exempt, anything else 20).
    SELECT l.vat_pct, l.vat_exempt INTO v_first_pct, v_first_ex
    FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org AND NOT l.declined ORDER BY l.position, l.id LIMIT 1;
    v_choice := CASE WHEN v_first_ex THEN 'exempt'
                     WHEN trim_scale(coalesce(v_first_pct, 20))::TEXT IN ('20', '5', '0') THEN trim_scale(coalesce(v_first_pct, 20))::TEXT
                     ELSE '20' END;
  ELSE
    IF v_kinds <> 1 THEN
      RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
        'reason', 'That quote has lines at different VAT rates. A sales order holds one VAT rate, so it can''t be linked without changing the VAT. ' || v_by_hand);
    END IF;
    IF v_only NOT IN ('20', '5', '0', 'exempt') THEN
      RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
        'reason', 'That quote uses a VAT rate (' || v_only || '%) a sales order can''t hold. ' || v_by_hand);
    END IF;
    v_choice := v_only;
  END IF;

  -- ---- lib/order-from-quote.ts orderTermsFromQuote: the order's single rounding against the quote's per-line rounding ----
  -- The quote: VAT per line (its own "Add VAT" switch; rate 20 when none is stored), rounded half away from zero, then summed.
  SELECT sum(round(coalesce(l.quantity, 0) * coalesce(l.unit_price, 0), 2)),
         CASE WHEN v_quote.vat_enabled IS DISTINCT FROM FALSE
              THEN sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(coalesce(l.quantity, 0) * coalesce(l.unit_price, 0), 2) * coalesce(l.vat_pct, 20) / 100, 2) END)
              ELSE 0 END
    INTO v_quote_net, v_quote_vat
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org AND NOT l.declined;
  v_quote_gross := CASE WHEN v_declined = 0 THEN coalesce(v_quote.total_value, v_quote_net + v_quote_vat) ELSE v_quote_net + v_quote_vat END;
  v_order_ex  := v_choice = 'exempt';
  v_order_pct := CASE WHEN v_order_ex THEN 0 ELSE v_choice::NUMERIC END;
  v_order_vat := CASE WHEN v_vat_on AND NOT v_order_ex THEN round(v_value * v_order_pct / 100, 2) ELSE 0 END;
  v_order_gross := v_value + v_order_vat;
  IF v_order_vat <> v_quote_vat OR v_order_gross <> round(v_quote_gross, 2) THEN
    RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
      'reason', 'As one sales order this quote would come to ' || public.gbp_text(v_order_gross) || ' (VAT ' || public.gbp_text(v_order_vat)
        || '), but the accepted quote is ' || public.gbp_text(v_quote_gross) || ' (VAT ' || public.gbp_text(v_quote_vat)
        || '), because the quote rounds VAT on each line. ' || v_by_hand);
  END IF;

  IF v_po IS NOT NULL AND length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;
  -- The customer's PO is the order's reference (as the Sales Orders page does); with none yet, a provisional SO-#### number.
  v_so_number := coalesce(v_po, public.next_doc_number('SO'));

  INSERT INTO public.sales_orders (organization_id, so_number, customer, customer_po, quote_id, quote_ref, status, order_date, delivery_date,
                                   total_value, vat_enabled, vat_pct, vat_exempt)
  VALUES (v_org, v_so_number, v_quote.customer, v_po, p_quote, nullif(v_quote.quote_ref, ''), 'open', CURRENT_DATE, p_delivery_date,
          v_value, v_vat_on, v_order_pct, v_order_ex)
  ON CONFLICT (organization_id, quote_id) WHERE quote_id IS NOT NULL DO NOTHING
  RETURNING * INTO v_so;
  IF NOT FOUND THEN
    -- Made meanwhile by another path (the index above): hand that one back.
    SELECT * INTO v_so FROM public.sales_orders s WHERE s.organization_id = v_org AND s.quote_id = p_quote;
    RETURN jsonb_build_object('so_id', v_so.id, 'so_number', v_so.so_number, 'created', FALSE, 'provisional', v_so.customer_po IS NULL, 'reason', NULL, 'needs', NULL);
  END IF;
  RETURN jsonb_build_object('so_id', v_so.id, 'so_number', v_so.so_number, 'created', TRUE, 'provisional', v_po IS NULL, 'reason', NULL, 'needs', NULL);
END
$$;
REVOKE ALL ON FUNCTION public.create_sales_order_from_quote(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. Accepting a quote, with the lines the customer's PO covers ------------------------------------------------
DROP FUNCTION IF EXISTS public.accept_quote(UUID, TEXT, DATE);
CREATE OR REPLACE FUNCTION public.accept_quote(p_quote UUID, p_customer_po TEXT DEFAULT NULL, p_delivery_date DATE DEFAULT NULL, p_lines UUID[] DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_quote      public.quotes%ROWTYPE;
  v_next       public.quotes%ROWTYPE;
  v_accepted   BOOLEAN := FALSE;
  v_auto       BOOLEAN;
  v_so         JSONB;
  v_so_id      UUID;
  v_order      public.sales_orders%ROWTYPE;
  v_job        JSONB;
  v_job_id     UUID;
  v_job_no     TEXT;
  v_job_new    BOOLEAN := FALSE;
  v_job_reason TEXT;
  v_po         TEXT := nullif(btrim(coalesce(p_customer_po, '')), '');
  v_declined   UUID[] := '{}';
  v_ordered    INTEGER;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('quotes') THEN
    RAISE EXCEPTION 'Only admin or office staff can record a customer''s decision on a quote' USING ERRCODE = '42501';
  END IF;
  IF v_po IS NOT NULL AND length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;
  -- Only the latest version is decided.
  SELECT * INTO v_next FROM public.quotes q WHERE q.previous_version_id = p_quote AND q.organization_id = v_org;
  IF FOUND OR v_quote.status = 'superseded' THEN
    RAISE EXCEPTION '% v% has been revised as a newer version: accept the latest version.', v_quote.quote_ref, v_quote.version
      USING ERRCODE = '22023', HINT = 'quote_superseded';
  END IF;
  IF v_quote.status = 'rejected' THEN
    RAISE EXCEPTION '% was marked as rejected; a decision can''t be changed.', v_quote.quote_ref USING ERRCODE = '22023', HINT = 'quote_decided';
  ELSIF coalesce(v_quote.status, 'draft') IN ('draft', 'sent') THEN
    -- The lines the customer's PO covers (NULL: all of them). Each must be one of this quote's lines; at least one.
    IF p_lines IS NOT NULL THEN
      IF cardinality(p_lines) = 0 THEN
        RAISE EXCEPTION 'Choose at least one line the customer ordered.' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(p_lines) c(id)
                 WHERE c.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.quote_line_items l WHERE l.id = c.id AND l.quote_id = p_quote AND l.organization_id = v_org)) THEN
        RAISE EXCEPTION 'One of the chosen lines isn''t on %. Reload the quote and choose again.', v_quote.quote_ref USING ERRCODE = '22023';
      END IF;
    END IF;
    PERFORM set_config('quoteflow.accept_quote', p_quote::TEXT, TRUE);
    UPDATE public.quote_line_items l SET declined = (p_lines IS NOT NULL AND NOT (l.id = ANY (p_lines)))
    WHERE l.quote_id = p_quote AND l.organization_id = v_org AND l.declined IS DISTINCT FROM (p_lines IS NOT NULL AND NOT (l.id = ANY (p_lines)));
    PERFORM set_config('quoteflow.accept_quote', '', TRUE);
    UPDATE public.quotes SET status = 'accepted', accepted_at = now() WHERE id = p_quote;
    v_accepted := TRUE;
  ELSIF v_quote.status <> 'accepted' THEN
    RAISE EXCEPTION '% is %; only a draft or sent quote can be accepted.', v_quote.quote_ref, v_quote.status USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(l.id ORDER BY l.position, l.id) FILTER (WHERE l.declined), '{}'), count(*) FILTER (WHERE NOT l.declined)
    INTO v_declined, v_ordered
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org;

  v_auto := coalesce((SELECT s.auto_convert_sales_orders FROM public.organization_settings s WHERE s.organization_id = v_org), TRUE);

  -- The order: only for someone who may see sales orders (036's section gate, as the table's own rules apply it).
  IF NOT public.section_allowed('sales-orders') THEN
    v_so := jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
      'reason', 'Sales orders are hidden for you, so no order was made: someone with the Sales Orders section makes it from this quote.');
  ELSE
    v_so := public.create_sales_order_from_quote(p_quote, v_po, p_delivery_date);
  END IF;
  v_so_id := (v_so ->> 'so_id')::UUID;

  IF v_so_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.sales_orders s WHERE s.id = v_so_id;
    IF (v_so ->> 'created')::BOOLEAN AND v_auto THEN
      -- The job, not started, exactly as Convert to Job makes it. A failure here leaves the order open for Convert to Job by hand.
      BEGIN
        v_job := public.convert_sales_order(v_so_id);
        v_job_id := (v_job ->> 'job_id')::UUID;
        v_job_no := v_job ->> 'job_no';
        v_job_new := coalesce((v_job ->> 'created')::BOOLEAN, FALSE);
      EXCEPTION WHEN OTHERS THEN
        v_job_reason := 'The sales order was made but its job wasn''t (' || SQLERRM || '). Use Convert to Job on the order.';
      END;
    ELSIF v_order.converted_to_job_id IS NOT NULL THEN
      SELECT j.id, j.job_no INTO v_job_id, v_job_no FROM public.jobs j WHERE j.id = v_order.converted_to_job_id AND j.organization_id = v_org;
    END IF;
  END IF;

  IF v_accepted THEN
    PERFORM security_audit.log_named_event(v_org, 'ACCEPT', 'quotes', p_quote::TEXT, jsonb_build_object(
      'quote_ref', v_quote.quote_ref, 'version', v_quote.version, 'so_id', v_so_id, 'so_number', v_so ->> 'so_number',
      'so_created', coalesce((v_so ->> 'created')::BOOLEAN, FALSE), 'provisional', v_so -> 'provisional', 'job_id', v_job_id, 'job_no', v_job_no,
      'job_created', v_job_new, 'auto_convert', v_auto, 'reason', v_so ->> 'reason', 'job_reason', v_job_reason,
      'lines_ordered', v_ordered, 'declined_lines', to_jsonb(v_declined)));
  END IF;

  RETURN jsonb_build_object(
    'quote_id', p_quote, 'quote_ref', v_quote.quote_ref, 'version', v_quote.version, 'accepted', v_accepted, 'created', v_accepted,
    'so_id', v_so_id, 'so_number', v_so ->> 'so_number', 'so_created', coalesce((v_so ->> 'created')::BOOLEAN, FALSE),
    'provisional', coalesce((v_so ->> 'provisional')::BOOLEAN, FALSE),
    'job_id', v_job_id, 'job_no', v_job_no, 'job_created', v_job_new, 'auto_convert', v_auto,
    'needs', v_so ->> 'needs', 'reason', v_so ->> 'reason', 'job_reason', v_job_reason,
    'lines_ordered', v_ordered, 'lines_declined', cardinality(v_declined));
END
$$;
REVOKE ALL ON FUNCTION public.accept_quote(UUID, TEXT, DATE, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_quote(UUID, TEXT, DATE, UUID[]) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 7. Converting an order: the ordered lines, with their part and drawing ------------------------------------------
-- The 058 body, except: the worksheet text is the ordered lines only, each with its part / drawing / revision when it has them; a job
-- of one ordered line takes that line's drawing number (and revision) as its drawing no; and for a later version of a quote the
-- J number and the attachments come from the quote's own number (QUO-0123 for 'QUO-0123 v2'). The job's quote_ref is the version's.
-- Result unchanged ({job_id, job_no, created}).
CREATE OR REPLACE FUNCTION public.convert_sales_order(p_order UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_order   public.sales_orders%ROWTYPE;
  v_job     public.jobs%ROWTYPE;
  v_quote   TEXT;
  v_base    TEXT;
  v_job_no  TEXT;
  v_num     TEXT;
  v_lines   TEXT;
  v_count   INT;
  v_qty     NUMERIC;
  v_drawing TEXT;
  v_spec    TEXT;
  v_now     TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can convert sales orders' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;

  -- Already converted (either side of the link): hand back that job, change nothing.
  SELECT j.* INTO v_job FROM public.jobs j
  WHERE j.organization_id = v_org AND (j.id = v_order.converted_to_job_id OR j.converted_from_sales_order_id = p_order)
  ORDER BY (j.id = v_order.converted_to_job_id) DESC NULLS LAST, j.created_at
  LIMIT 1;
  IF FOUND THEN
    IF v_order.converted_to_job_id IS DISTINCT FROM v_job.id THEN
      UPDATE public.sales_orders SET converted_to_job_id = v_job.id, converted_at = coalesce(converted_at, v_now) WHERE id = p_order;
    END IF;
    RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', FALSE);
  END IF;

  -- Job number: the quote's number when free, otherwise the next J number. The row lock above only serialises calls for
  -- ONE order; two orders for the same quote would both find J-1393 free. One lock per company, held to the end of this
  -- transaction, makes the "is it free" check and the insert a single step.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  v_quote := v_order.quote_ref;
  IF coalesce(v_quote, '') = '' AND v_order.quote_id IS NOT NULL THEN
    SELECT q.quote_ref INTO v_quote FROM public.quotes q WHERE q.id = v_order.quote_id AND q.organization_id = v_org;
  END IF;
  -- A later version of a quote ('QUO-0123 v2'): its number and its attachments are the quote's own (QUO-0123).
  v_base := v_quote;
  IF v_order.quote_id IS NOT NULL THEN
    SELECT public.quote_base_ref(v_quote, q.version) INTO v_base FROM public.quotes q WHERE q.id = v_order.quote_id AND q.organization_id = v_org;
    v_base := coalesce(v_base, v_quote);
  END IF;
  v_num := substring(coalesce(v_base, '') FROM '^\s*[Qq][Uu][Oo][-\s]?(\d+)\s*$');
  IF v_num IS NOT NULL THEN
    v_job_no := 'J-' || CASE WHEN length(ltrim(v_num, '0')) < 4 THEN lpad(coalesce(nullif(ltrim(v_num, '0'), ''), '0'), 4, '0') ELSE ltrim(v_num, '0') END;
    IF EXISTS (SELECT 1 FROM public.jobs WHERE organization_id = v_org AND job_no = v_job_no) THEN
      v_job_no := NULL;
    END IF;
  END IF;
  IF v_job_no IS NULL THEN
    v_job_no := public.next_doc_number('J');
  END IF;

  -- What the workshop needs from the quote: the ordered lines' descriptions, parts, drawings and quantities, never prices.
  IF v_order.quote_id IS NOT NULL THEN
    SELECT string_agg('- ' || btrim(l.description)
                        || coalesce(' [' || public.quote_line_reference(l.part_number, l.drawing_number, l.drawing_revision) || ']', '')
                        || ' x ' || trim_scale(l.quantity)::TEXT, E'\n' ORDER BY l.position, l.id),
           count(*), max(l.quantity),
           max(nullif(btrim(l.drawing_number), '') || coalesce(' rev ' || nullif(btrim(l.drawing_revision), ''), ''))
      INTO v_lines, v_count, v_qty, v_drawing
    FROM public.quote_line_items l
    WHERE l.quote_id = v_order.quote_id AND l.organization_id = v_org AND NOT l.declined;
  END IF;
  v_spec := 'Sales order ' || v_order.so_number
    || CASE WHEN v_order.delivery_date IS NOT NULL THEN '; customer delivery required ' || to_char(v_order.delivery_date, 'DD/MM/YYYY') ELSE '' END
    || '.'
    || CASE WHEN v_lines IS NOT NULL THEN E'\n' || coalesce(v_quote, 'Quote') || E':\n' || v_lines ELSE '' END;

  INSERT INTO public.jobs (
    organization_id, job_no, quote_id, customer, description, stage, due_date, status, specification, drawings,
    customer_po, quote_ref, date_received, date_required, quantity_required, drawing_no, converted_from_sales_order_id, converted_at)
  VALUES (
    v_org, v_job_no, v_order.quote_id, v_order.customer, 'Converted from ' || v_order.so_number, 'material',
    v_order.delivery_date, 'on_track', v_spec, '[]'::JSONB,
    nullif(btrim(coalesce(v_order.customer_po, '')), ''), nullif(v_quote, ''), v_order.order_date, v_order.delivery_date,
    CASE WHEN v_count = 1 AND v_qty >= 1 AND v_qty = trunc(v_qty) THEN v_qty::INT END,
    CASE WHEN v_count = 1 THEN v_drawing END,
    p_order, v_now)
  RETURNING * INTO v_job;

  INSERT INTO public.job_values (job_id, organization_id, value) VALUES (v_job.id, v_org, coalesce(v_order.total_value, 0));

  -- The quote's drawings travel with the job: a reference to each file attached to the quote (same company folder; nothing is
  -- copied), so the worksheet lists them and the shop floor can open them (job_files, section 3 below).
  IF coalesce(v_base, '') <> '' THEN
    INSERT INTO public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, source_attachment_id, created_by)
    SELECT v_org, v_job.id, 'drawing', left(coalesce(nullif(btrim(regexp_replace(a.file_name, '\.[^.]*$', '')), ''), 'Drawing'), 200),
           left(coalesce(nullif(btrim(a.file_name), ''), 'Drawing'), 255), 'quote-attachments', a.file_path, a.id, auth.uid()
    FROM public.quote_attachments a
    WHERE a.organization_id = v_org AND a.quote_ref = v_base AND split_part(a.file_path, '/', 1) = v_org::TEXT
    ORDER BY a.created_at, a.id
    ON CONFLICT (job_id, storage_bucket, storage_path) DO NOTHING;
  END IF;

  UPDATE public.sales_orders SET status = 'converted', converted_to_job_id = v_job.id, converted_at = v_now WHERE id = p_order;

  -- The machines and hours planned on the order's lines, summed per machine on the job (043). No booking: "Book on schedule" on the job.
  PERFORM public.carry_so_machines(p_order, v_job.id);

  RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public.convert_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_sales_order(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 8. An order's lines: the ordered quote lines, with their part and drawing ------------------------------------
-- The 034 body; the quote's lines are its ordered lines (NOT declined), and each carries its part / drawing / revision.
CREATE OR REPLACE FUNCTION public.ensure_sales_order_lines(p_order UUID)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_order public.sales_orders%ROWTYPE;
  v_have  NUMERIC;
  v_quote NUMERIC;
  v_n     INT;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*), coalesce(sum(round(quantity * unit_price, 2)), 0) INTO v_n, v_have FROM public.sales_order_lines WHERE sales_order_id = p_order;
  IF v_n > 0 THEN
    IF v_have = coalesce(v_order.total_value, 0) OR EXISTS (
         SELECT 1 FROM public.delivery_note_items i JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id WHERE l.sales_order_id = p_order) THEN
      RETURN p_order;
    END IF;
    DELETE FROM public.sales_order_lines WHERE sales_order_id = p_order;
  END IF;
  IF v_order.quote_id IS NOT NULL THEN
    SELECT coalesce(sum(round(quantity * unit_price, 2)), 0) INTO v_quote FROM public.quote_line_items
    WHERE quote_id = v_order.quote_id AND organization_id = v_org AND NOT declined;
    IF v_quote = coalesce(v_order.total_value, 0) AND v_quote > 0 THEN
      INSERT INTO public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price, vat_pct, vat_exempt, source_quote_line_id,
                                            part_number, drawing_number, drawing_revision)
      SELECT v_org, p_order, row_number() OVER (ORDER BY q.position, q.id) - 1, left(btrim(q.description), 500), q.quantity, q.unit_price, q.vat_pct, q.vat_exempt, q.id,
             q.part_number, q.drawing_number, q.drawing_revision
      FROM public.quote_line_items q
      WHERE q.quote_id = v_order.quote_id AND q.organization_id = v_org AND NOT q.declined AND btrim(q.description) <> '' AND q.quantity > 0;
      RETURN p_order;
    END IF;
  END IF;
  INSERT INTO public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
  VALUES (v_org, p_order, 0, left('Customer order ' || coalesce(nullif(btrim(v_order.customer_po), ''), v_order.so_number), 500), 1, coalesce(v_order.total_value, 0), v_order.vat_pct, v_order.vat_exempt);
  RETURN p_order;
END
$$;
REVOKE ALL ON FUNCTION public.ensure_sales_order_lines(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_sales_order_lines(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 9. 067's customer PO to the quote's jobs, for every version ----------------------------------------------------
-- The 067 body, except which jobs: those made from any version of the quote (jobs.quote_id, matched on the quote's own number, which
-- is where every version files its attachments), as well as those whose quote_ref is the attachment's (jobs made before 058 linked a
-- quote by id). Still INVOKER, run as the uploader (admin or office): job_files' policies and guard apply as for any reference.
CREATE OR REPLACE FUNCTION public.quote_attachments_customer_po_to_jobs()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind = 'customer_po' AND split_part(NEW.file_path, '/', 1) = NEW.organization_id::TEXT AND btrim(coalesce(NEW.quote_ref, '')) <> '' THEN
    INSERT INTO public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, source_attachment_id, created_by)
    SELECT NEW.organization_id, j.id, 'customer_po', 'Customer PO', left(coalesce(nullif(btrim(NEW.file_name), ''), 'Customer PO'), 255),
           'quote-attachments', NEW.file_path, NEW.id, auth.uid()
    FROM public.jobs j
    WHERE j.organization_id = NEW.organization_id
      AND (j.quote_ref = NEW.quote_ref
           OR EXISTS (SELECT 1 FROM public.quotes q
                      WHERE q.id = j.quote_id AND q.organization_id = j.organization_id
                        AND public.quote_base_ref(q.quote_ref, q.version) = NEW.quote_ref))
    ORDER BY j.created_at, j.id
    ON CONFLICT (job_id, storage_bucket, storage_path) DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.quote_attachments_customer_po_to_jobs() FROM PUBLIC, anon, authenticated;
