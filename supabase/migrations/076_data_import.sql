-- =====================================================================================================
-- 076: data import (Admin > Data import), the SQL foundation. An admin uploads a CSV or Excel file, maps its columns, previews a dry
-- run and confirms. The app comes later; this file is the database side only. Needs 032 (invoice_payments), 033
-- (assert_privileged_aal, documents_start_as_drafts), 036 (support memberships), 068 (its quote_lines_issue_lock and
-- quote_lifecycle_guard are replaced here). Applied after 075 (it changes nothing of 050 to 075). It does not need 077 (an
-- index-friendly set_audit_hash); 077 only makes it faster.
--
-- 1. import_mappings: an admin's saved column mapping per company, kind of file and header layout. Admins of the session's company
--    read and write it directly (row rules); nobody else sees it.
-- 2. import_batches: one row per dry run, commit (of a whole small file, or of one part of a large one), or undo of a part. Never
--    changed; a committed or undo batch is never removed. Marked large (with its import_id and part) for a file in parts. Admin read.
-- 3. import_record_keys: (company, kind, match key) -> the record a committed batch created; unique per company, kind and key. These
--    are the import's own keys (as legacy_import_map is for import_legacy_tenant): matching and undo use them. Admin read.
-- 4. import_runs and import_stage: a large import's state (staging, validated, committing, committed, undoing, undone, cancelled), its
--    validated content's SHA-256 and commit plan, and the parts of the file as the app sent them (removed once the import is
--    committed, undone or cancelled). Admin read; written only by the functions below.
-- 5. import_norm_name(text): IMMUTABLE, the SQL port of normaliseName (scripts/sliq-import/ids.mjs). Parity: tests/db/data-import.test.ts.
-- 6. Every entry point: SECURITY DEFINER, pinned search_path, signed-in only; the caller must be an admin (role or second role) of the
--    session's company (has_org_role), past the second step when the company asks for it (assert_privileged_aal), and not in a support
--    session (066's rule). The company comes from the session only, never from the payload. One import call per company at a time
--    (pg_advisory_xact_lock). Keyed (p_client_op_id): the same key and request answers the first result; the key for anything else
--    is refused (client_op_reused).
--    a. SMALL import, one call: import_company_data(p_payload, p_dry_run, p_client_op_id). The dry run does the whole import inside a
--       sub-block that ends with a caught sentinel, so everything is rolled back and the answer keeps the exact counts and the size
--       (records, lines, audit rows: what the app uses to choose one call or parts). The commit is ONE transaction: all or nothing,
--       no undo needed. Supabase cancels a signed-in request after 8 s; a cancelled call is rolled back like any other failure.
--    b. LARGE import, in parts: import_stage_part(import_id, part, payload) stores each part of the file as sent;
--       import_validate(import_id, part_weight, key) checks the WHOLE file at once (every part, duplicates and payments across parts),
--       writes nothing, and only with no problem marks the import validated with a commit plan (parts of about part_weight audit rows,
--       by kind in dependency order, each invoice with its payments); import_commit_part(import_id, key) commits the next part as one
--       transaction, only from the validated content; import_undo(import_id, key) undoes the committed parts one call each, last
--       first (or cancels an import nothing of which was committed). Undo deletes ONLY records that import created (its own
--       import_record_keys rows, and the lines written with them), never a record that existed before, and never one changed or used
--       after the import (more audit rows about it than the import itself wrote, counted at its commit, so no clock decides; or a
--       newer updated_at; or any row elsewhere pointing at it): that one is refused, kept with its lines and payments, and reported.
--       An import abandoned before any commit is removed when the company stages another 24 hours later (import_undo discards one
--       at once).
--    Payload: { file_name, file_sha256, customers, suppliers, stock, quotes (with lines), sales_orders, jobs, purchase_orders,
--    invoices (with lines), payments }, each a list of records with an optional "row" (the file's row number for messages). Text
--    loses a leading apostrophe that our CSV export adds to formula-like text (lib/html.ts neutraliseCsvText).
-- 7. The rules: every row is checked first; problems are collected per row (kind, row, field, message); any problem and nothing is
--    written. Match rules (a matched row is skipped and counted matched_existing, NEVER updated): customers and suppliers by
--    external_ref (an earlier import's key) if given, else import_norm_name(name) (2+ existing = a problem); stock sku; quotes
--    quote_ref; invoices invoice_ref; POs po_ref (or po_number); jobs job_no; sales orders so_number + normalised customer; payments
--    invoice_ref + paid_on + amount + ordinal. A number already in Tolra with different content (customer, supplier or total) is a
--    problem, never an overwrite; a matched stock code, customer or supplier whose other details differ is a warning listing them;
--    the same key twice in a file is a problem. Writes are set-based, in order: customers, suppliers,
--    stock, quotes and lines, sales orders, jobs, purchase orders, invoices and lines, payments (invoice_payments, 032). An invoice's
--    amount_paid is the sum of its payments in the file (paid / partial follow); marked paid with no payments -> sent and "Payment to
--    confirm" (payment_unverified, 027). A payment for an invoice already in Tolra is a problem (Record payment): a payment is always
--    written with its invoice, which is why the plan puts each invoice's payments in its part. A commit reseeds doc_counters for the
--    session's company only (GREATEST over QUO, INV, J, PO, SO, DLN; rfqs have no number column), warns on numbers that are not
--    PREFIX-digits, records the batch and its keys and audits IMPORT_COMMITTED (IMPORT_UNDONE for an undone part). write_audit still
--    refuses both from a client.
-- 8. Issued documents. 033's documents_start_as_drafts and the issued-line locks (019, 068) refuse what an import inserts; 027's
--    invoice and purchase-order locks and 068's quote lifecycle guard refuse what an undo deletes. import_legacy_tenant.sql passes them
--    only because it runs as the database owner; inside a SECURITY DEFINER function called through the API the role setting stays
--    'authenticated' and SET ROLE is not allowed. Writing drafts and issuing them would run 027's totals check against the company's
--    CURRENT VAT registration, refusing legitimate history. So each of these guards gets ONE added line: an INSERT passes while the
--    transaction-local setting quoteflow.data_import equals the row's company, a DELETE while quoteflow.data_import_undo does. Only the
--    import (and its undo) sets them, for the session's company, around its own writes, and clears them straight after (a client can't
--    set a setting through the API: the rule 032's quoteflow.invoice_payment and 073's quoteflow.invoice_void rely on). Everything
--    else in those guards, and every other guard, is unchanged.
-- 9. audit_event_allowed (034): EXPORT and the other read events may also name invoice_payments and time_week_approvals (admin and
--    office), for the payments and weekly-hours exports.
--
-- Additive: five tables, twenty-two new functions (five callable by signed-in members, seventeen internal), seven replaced (8, 9).
-- Safe to run more than once. Rollback: supabase/release/076_data_import.rollback.sql (docs/RELEASE.md "076").
-- =====================================================================================================

-- ---- 1. Helpers (internal) ------------------------------------------------------------------------------------------------------
-- normaliseName (scripts/sliq-import/ids.mjs), ported: lower() under the "C" collation changes ASCII letters only, as JavaScript's
-- toLowerCase does for everything that survives the [^a-z0-9 ] step.
CREATE OR REPLACE FUNCTION public.import_norm_name(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT btrim(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 replace(lower(regexp_replace(normalize(coalesce(p_name, ''), NFKD), '[̀-ͯ]', '', 'g') COLLATE "C"), '&', ' and '),
                 '[^a-z0-9 ]+', ' ', 'g'),
               '\mlimited\M', 'ltd', 'g'),
             ' +', ' ', 'g'),
           ' ')
$$;
REVOKE ALL ON FUNCTION public.import_norm_name(TEXT) FROM PUBLIC, anon, authenticated;

-- A cell's text: our CSV export's leading apostrophe on formula-like text removed (lib/html.ts neutraliseCsvText adds it before =, +,
-- -, @, a tab or a carriage return, never before a plain number), surrounding white space trimmed, empty -> NULL.
CREATE OR REPLACE FUNCTION public.import_clean_text(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT nullif(btrim(CASE WHEN p ~ '^''[=+\-@\t\r]' AND substr(p, 2) !~ '^-?\d+(\.\d+)?$' THEN substr(p, 2) ELSE p END, E' \t\r\n'), '')
$$;
REVOKE ALL ON FUNCTION public.import_clean_text(TEXT) FROM PUBLIC, anon, authenticated;

-- One call per record: every scalar value of a record as import_clean_text would clean it (lists and records inside are kept as
-- they are). A cell's text: our CSV export's leading apostrophe on formula-like text removed, white space trimmed, empty -> null.
CREATE OR REPLACE FUNCTION public.import_clean_record(p JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'object' THEN
    (SELECT coalesce(jsonb_object_agg(e.key,
              CASE WHEN jsonb_typeof(e.value) IN ('string', 'number', 'boolean')
                   THEN to_jsonb(nullif(btrim(CASE WHEN t.v ~ '^''[=+\-@\t\r]' AND substr(t.v, 2) !~ '^-?\d+(\.\d+)?$' THEN substr(t.v, 2) ELSE t.v END, E' \t\r\n'), ''))
                   ELSE e.value END), '{}'::JSONB)
     FROM jsonb_each(p) e CROSS JOIN LATERAL (SELECT e.value #>> '{}' AS v) t)
  END
$$;
REVOKE ALL ON FUNCTION public.import_clean_record(JSONB) FROM PUBLIC, anon, authenticated;

-- A plain decimal (at most 12 digits before the point and 6 after), else NULL.
CREATE OR REPLACE FUNCTION public.import_num(p TEXT)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p ~ '^-?\d{1,12}(\.\d{1,6})?$' THEN p::NUMERIC END
$$;
REVOKE ALL ON FUNCTION public.import_num(TEXT) FROM PUBLIC, anon, authenticated;

-- A date written YYYY-MM-DD that exists, else NULL. A boolean (true/false, yes/no, y/n, 1/0), else NULL.
CREATE OR REPLACE FUNCTION public.import_date(p TEXT)
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p ~ '^\d{4}-\d{2}-\d{2}$' AND pg_input_is_valid(p, 'date') THEN p::DATE END
$$;
REVOKE ALL ON FUNCTION public.import_date(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.import_bool(p TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN lower(p) IN ('true', 'yes', 'y', '1') THEN TRUE WHEN lower(p) IN ('false', 'no', 'n', '0') THEN FALSE END
$$;
REVOKE ALL ON FUNCTION public.import_bool(TEXT) FROM PUBLIC, anon, authenticated;

-- ---- 2. Tables ----------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.import_mappings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders',
                                                 'invoices', 'payments')),
  header_signature TEXT NOT NULL CHECK (length(header_signature) BETWEEN 1 AND 128),
  mapping          JSONB NOT NULL CHECK (jsonb_typeof(mapping) = 'object' AND octet_length(mapping::TEXT) <= 32768),
  updated_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_mappings_one_per_layout UNIQUE (organization_id, kind, header_signature)
);
ALTER TABLE public.import_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_mappings admin select" ON public.import_mappings;
CREATE POLICY "import_mappings admin select" ON public.import_mappings FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "import_mappings admin insert" ON public.import_mappings;
CREATE POLICY "import_mappings admin insert" ON public.import_mappings FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "import_mappings admin update" ON public.import_mappings;
CREATE POLICY "import_mappings admin update" ON public.import_mappings FOR UPDATE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']))
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "import_mappings admin delete" ON public.import_mappings;
CREATE POLICY "import_mappings admin delete" ON public.import_mappings FOR DELETE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.import_mappings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_mappings TO authenticated;

-- Who saved it last and when: always the server's values, never the client's.
CREATE OR REPLACE FUNCTION public.import_mappings_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  IF public.is_api_role() THEN
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.import_mappings_stamp() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS import_mappings_stamp ON public.import_mappings;
CREATE TRIGGER import_mappings_stamp BEFORE INSERT OR UPDATE ON public.import_mappings
  FOR EACH ROW EXECUTE FUNCTION public.import_mappings_stamp();

CREATE TABLE IF NOT EXISTS public.import_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  client_op_id    UUID NOT NULL,
  import_id       UUID,
  large           BOOLEAN NOT NULL DEFAULT FALSE,
  part            INT CHECK (part IS NULL OR part >= 1),
  parts           INT CHECK (parts IS NULL OR parts >= 1),
  created_by      UUID,
  file_name       TEXT CHECK (file_name IS NULL OR length(file_name) <= 255),
  file_sha256     TEXT CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256  TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  kinds           TEXT[] NOT NULL,
  counts          JSONB NOT NULL,
  errors          JSONB NOT NULL DEFAULT '[]'::JSONB,
  warnings        JSONB NOT NULL DEFAULT '[]'::JSONB,
  result          JSONB NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('dry_run', 'committed', 'undo')),
  txn_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_batches_one_per_key UNIQUE (organization_id, client_op_id),
  CONSTRAINT import_batches_large_has_import CHECK (NOT large OR import_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_import_batches_org_created ON public.import_batches (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_import ON public.import_batches (organization_id, import_id) WHERE import_id IS NOT NULL;
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_batches admin select" ON public.import_batches;
CREATE POLICY "import_batches admin select" ON public.import_batches FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.import_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.import_batches TO authenticated;

-- A batch is a record of what happened: never changed; a committed or undo one is never removed (a dry run may be cleared by the owner).
CREATE OR REPLACE FUNCTION public.import_batches_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR OLD.status IN ('committed', 'undo') THEN
    RAISE EXCEPTION 'An import batch is a record of what was imported: it can''t be changed or removed.' USING ERRCODE = '42501', HINT = 'import_batch_immutable';
  END IF;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION public.import_batches_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS import_batches_immutable ON public.import_batches;
CREATE TRIGGER import_batches_immutable BEFORE UPDATE OR DELETE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.import_batches_immutable();

CREATE TABLE IF NOT EXISTS public.import_record_keys (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  kind            TEXT NOT NULL CHECK (kind IN ('customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders',
                                                'invoices', 'payments')),
  match_key       TEXT NOT NULL CHECK (length(match_key) BETWEEN 1 AND 600),
  record_id       UUID NOT NULL,
  batch_id        UUID NOT NULL REFERENCES public.import_batches(id),
  -- How many audit rows about this record existed when its import committed (all written by the import itself: the record was new and
  -- invisible to everyone else until then). The audit log is append only, so any later change shows as a higher count (undo).
  audit_rows      INT NOT NULL DEFAULT 0 CHECK (audit_rows >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_record_keys_pkey PRIMARY KEY (organization_id, kind, match_key)
);
CREATE INDEX IF NOT EXISTS idx_import_record_keys_batch ON public.import_record_keys (batch_id);
ALTER TABLE public.import_record_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_record_keys admin select" ON public.import_record_keys;
CREATE POLICY "import_record_keys admin select" ON public.import_record_keys FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.import_record_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.import_record_keys TO authenticated;

-- A large import (a file in parts): its state, the content it validated (SHA-256 of the merged staged parts) and the commit plan
-- (which rows go in which part). Changed only by the import functions. Admins read their company's.
CREATE TABLE IF NOT EXISTS public.import_runs (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  import_id       UUID NOT NULL,
  id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status          TEXT NOT NULL DEFAULT 'staging'
                  CHECK (status IN ('staging', 'validated', 'committing', 'committed', 'undoing', 'undone', 'cancelled')),
  file_name       TEXT CHECK (file_name IS NULL OR length(file_name) <= 255),
  file_sha256     TEXT CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  merged_sha256   TEXT CHECK (merged_sha256 IS NULL OR merged_sha256 ~ '^[0-9a-f]{64}$'),
  part_weight     INT CHECK (part_weight IS NULL OR part_weight BETWEEN 10 AND 20000),
  plan            JSONB,
  parts           INT,
  parts_committed INT NOT NULL DEFAULT 0,
  parts_undone    INT NOT NULL DEFAULT 0,
  validation      JSONB,
  refused         JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_runs_pkey PRIMARY KEY (organization_id, import_id),
  CONSTRAINT import_runs_validated_has_plan CHECK (status IN ('staging', 'cancelled') OR (plan IS NOT NULL AND parts >= 1 AND merged_sha256 IS NOT NULL))
);
ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_runs admin select" ON public.import_runs;
CREATE POLICY "import_runs admin select" ON public.import_runs FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.import_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.import_runs TO authenticated;

-- The parts of a large import as the app sent them, until the import is committed, undone or cancelled (then removed). Not
-- row-audited (the file's content would be copied into the audit log); the run and every batch are.
CREATE TABLE IF NOT EXISTS public.import_stage (
  organization_id UUID NOT NULL,
  import_id       UUID NOT NULL,
  part            INT NOT NULL CHECK (part BETWEEN 1 AND 1000),
  payload         JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  rows            INT NOT NULL,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_stage_pkey PRIMARY KEY (organization_id, import_id, part),
  CONSTRAINT import_stage_run_fkey FOREIGN KEY (organization_id, import_id) REFERENCES public.import_runs (organization_id, import_id) ON DELETE CASCADE
);
ALTER TABLE public.import_stage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_stage admin select" ON public.import_stage;
CREATE POLICY "import_stage admin select" ON public.import_stage FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.import_stage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.import_stage TO authenticated;

-- Audit (row changes: old and new, who) on the mappings, batches and runs; support read-only and admin two-step on all five. The keys
-- are not row-audited (each created record has its own audit row, and its batch is audited), nor the staged file content.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_mappings', 'import_batches', 'import_runs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_' || t || '_changes', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change()', 'audit_' || t || '_changes', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['import_mappings', 'import_batches', 'import_record_keys', 'import_runs', 'import_stage'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS support_read_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS admin_mfa ON public.%I', t);
    EXECUTE format('CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard()', t);
  END LOOP;
END
$$;

-- ---- 3. The guards an import or its undo passes: each body exactly as before, plus one line each (insert: quoteflow.data_import;
-- delete: quoteflow.data_import_undo) ------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.documents_start_as_drafts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_bad TEXT[];
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- 076: a finished record written by import_company_data for the company it holds the import for (set by it alone, cleared after).
  IF current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT THEN
    RETURN NEW;
  END IF;
  IF coalesce(v_row ->> 'status', 'draft') <> 'draft' THEN
    v_bad := array_append(v_bad, 'status');
  END IF;
  -- What only the issue / send / accept / payment steps set.
  IF TG_TABLE_NAME = 'invoices' THEN
    IF v_row ->> 'invoice_ref' IS NOT NULL THEN v_bad := array_append(v_bad, 'invoice_ref'); END IF;
    IF v_row ->> 'sent_date' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_date'); END IF;
    IF v_row ->> 'paid_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'paid_at'); END IF;
    IF coalesce((v_row ->> 'amount_paid')::NUMERIC, 0) <> 0 THEN v_bad := array_append(v_bad, 'amount_paid'); END IF;
  ELSIF TG_TABLE_NAME = 'quotes' THEN
    IF v_row ->> 'sent_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_at'); END IF;
    IF v_row ->> 'accepted_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'accepted_at'); END IF;
    IF v_row ->> 'rejected_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'rejected_at'); END IF;
  ELSE
    IF v_row ->> 'sent_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'sent_at'); END IF;
    IF v_row ->> 'received_at' IS NOT NULL THEN v_bad := array_append(v_bad, 'received_at'); END IF;
  END IF;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'A new % must be saved as a draft and then issued (not set: %).', replace(TG_TABLE_NAME, '_', ' '), array_to_string(v_bad, ', ')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.invoice_lines_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_ref TEXT;
BEGIN
  -- 076: a line of an imported invoice, inserted by import_company_data for the company it holds the import for.
  IF TG_OP = 'INSERT' AND current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT THEN
    RETURN NEW;
  END IF;
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
  IF public.is_api_role() THEN
    SELECT i.invoice_ref INTO v_ref FROM public.invoices i
    WHERE i.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.invoice_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.invoice_id END)
      AND coalesce(i.status, 'draft') <> 'draft'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Invoice % has been issued, so its lines can''t be changed.', v_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

CREATE OR REPLACE FUNCTION public.quote_lines_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_ref TEXT;
BEGIN
  -- 076: a line of an imported quote, inserted by import_company_data for the company it holds the import for.
  IF TG_OP = 'INSERT' AND current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT THEN
    RETURN NEW;
  END IF;
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
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
$function$;

-- The three delete guards an undo passes (027's invoice and purchase-order locks, 068's quote lifecycle): each body exactly as before, plus
-- the one quoteflow.data_import_undo line.
CREATE OR REPLACE FUNCTION public.invoice_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_date', 'job_id', 'payment_unverified', 'updated_at', 'updated_by'];
  v_receipts CONSTANT TEXT[] := ARRAY['amount_paid', 'paid_at', 'credited_amount', 'refunded_amount'];
  v_via_payment BOOLEAN;
BEGIN
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t be deleted.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t go back to draft.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  v_via_payment := current_setting('quoteflow.invoice_payment', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF NOT v_via_payment THEN
    IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.credited_amount IS DISTINCT FROM OLD.credited_amount OR NEW.refunded_amount IS DISTINCT FROM OLD.refunded_amount THEN
      RAISE EXCEPTION 'Invoice %: payments are recorded with Record payment and credits applied with Apply credit, not by editing the amounts.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF OLD.payment_unverified AND NOT NEW.payment_unverified THEN
      RAISE EXCEPTION 'Invoice %: payments are confirmed with Confirm payments complete, not by editing the flag.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND (lower(coalesce(NEW.status, '')) IN ('paid', 'partial', 'credited') OR lower(coalesce(OLD.status, '')) IN ('paid', 'partial', 'credited')) THEN
      RAISE EXCEPTION 'Invoice %: it becomes part paid, paid or credited only when a payment is recorded or a credit applied.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - v_open - v_receipts) IS DISTINCT FROM (to_jsonb(OLD) - v_open - v_receipts) THEN
    RAISE EXCEPTION 'Invoice % has been issued: its amounts, customer and details can''t be changed (only payment and status).', OLD.invoice_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.quote_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_open    CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'accepted_at', 'rejected_at', 'internal_notes', 'updated_at', 'updated_by'];
  v_from    TEXT;
  v_to      TEXT;
  v_revised BOOLEAN;
BEGIN
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
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
$function$;

CREATE OR REPLACE FUNCTION public.purchase_order_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  -- Still open after issue: progress (status, sent/received times), the supplier's delivery date and notes.
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'received_at', 'expected_delivery', 'notes', 'updated_at', 'updated_by'];
BEGIN
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Purchase order % has been issued, so it can''t be deleted.', OLD.po_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Purchase order % has been issued, so it can''t go back to draft.', OLD.po_ref USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Purchase order % has been issued: its supplier, items and value can''t be changed (delivery date, notes and progress can).', OLD.po_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

-- ---- 4. audit_event_allowed (034): the read events may also name invoice_payments and time_week_approvals ------------------------
CREATE OR REPLACE FUNCTION public.audit_event_allowed(p_action TEXT, p_table TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_read  TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin', 'office'] WHEN 'sales_orders' THEN ARRAY['admin', 'office']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop', 'viewer'] WHEN 'machines' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop', 'viewer']
    WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
    -- 076: the payments export (032's invoice_payments) and the weekly hours export (052's time_week_approvals).
    WHEN 'invoice_payments' THEN ARRAY['admin', 'office'] WHEN 'time_week_approvals' THEN ARRAY['admin', 'office']
  END;
  v_write TEXT[] := CASE p_table
    WHEN 'quotes' THEN ARRAY['admin', 'office'] WHEN 'quote_attachments' THEN ARRAY['admin', 'office']
    WHEN 'rfqs' THEN ARRAY['admin', 'office'] WHEN 'customers' THEN ARRAY['admin', 'office']
    WHEN 'suppliers' THEN ARRAY['admin', 'office'] WHEN 'purchase_orders' THEN ARRAY['admin', 'office']
    WHEN 'stock' THEN ARRAY['admin', 'office'] WHEN 'email_history' THEN ARRAY['admin', 'office']
    WHEN 'machines' THEN ARRAY['admin', 'office']
    WHEN 'invoices' THEN ARRAY['admin', 'office'] WHEN 'sales_orders' THEN ARRAY['admin', 'office']
    WHEN 'jobs' THEN ARRAY['admin', 'office', 'workshop'] WHEN 'delivery_notes' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'machine_bookings' THEN ARRAY['admin', 'office', 'workshop']
    WHEN 'user_profiles' THEN ARRAY['admin'] WHEN 'organization_settings' THEN ARRAY['admin', 'office']
  END;
BEGIN
  IF p_action = 'CHANGE_OWN_PASSWORD' THEN
    RETURN p_table = 'user_profiles';
  END IF;
  IF p_action IN ('CREATE_USER', 'SET_USER_PASSWORD', 'UPDATE_USERNAME', 'UPDATE_USER_ACCESS', 'DEACTIVATE_USER',
                  'REACTIVATE_USER', 'INVITE_USER', 'PASSWORD_RESET_PREPARED', 'RESET_MFA') THEN
    RETURN p_table = 'user_profiles' AND public.has_org_role(ARRAY['admin']);
  END IF;
  IF p_action IN ('EXPORT', 'PRINT_PACK', 'DOWNLOAD_PDF', 'DOWNLOAD_ATTACHMENT', 'EMAIL_COPIED') THEN
    RETURN v_read IS NOT NULL AND public.has_org_role(v_read);
  END IF;
  IF p_action IN ('CREATE', 'UPDATE', 'DELETE', 'SEND', 'DESPATCH', 'ACCEPT', 'REJECT', 'UPDATE_WORKSHEET',
                  'UPLOAD_DRAWING', 'CONVERT_TO_JOB', 'SEND_TO_WORKSHOP', 'MARK_RECEIVED', 'MARK_PAID', 'MARK_SIGNED',
                  'UPLOAD_ATTACHMENT', 'EMAIL_SENT_MANUALLY', 'DRAFT_CHASERS', 'CREATE_SUPPLIER', 'DELETE_SUPPLIER',
                  'ORGANIZATION_SETTINGS_UPDATE') THEN
    RETURN v_write IS NOT NULL AND public.has_org_role(v_write);
  END IF;
  RETURN FALSE;
END
$function$;

-- ---- 5. The import itself (internal: called only by the import functions below, inside their sub-blocks) -------------------------
-- Stages every section into temporary tables, checks every row, decides create / match / error per row. p_mode 'validate' stops there
-- (nothing written). Otherwise (no problems only) it writes and reseeds the counters; 'commit' also records the batch (with the large
-- import and part it belongs to, if any) and its keys and audits IMPORT_COMMITTED; 'dry_run' leaves that to the caller's rollback.
CREATE OR REPLACE FUNCTION public.import_company_data_run(p_org UUID, p_uid UUID, p_batch UUID, p_payload JSONB, p_mode TEXT,
                                                         p_client_op_id UUID, p_request TEXT, p_import_id UUID, p_part INT, p_parts INT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kinds CONSTANT TEXT[] := ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments'];
  v_k        TEXT;
  v_n        INT;
  v_expect   INT;
  v_counts   JSONB := '{}'::JSONB;
  v_errors   JSONB;
  v_error_n  INT;
  v_warnings JSONB;
  v_warn_n   INT;
  v_counters JSONB;
  v_present  TEXT[];
  v_result   JSONB;
  v_file     TEXT := left(public.import_clean_text(p_payload ->> 'file_name'), 255);
  v_sha      TEXT := lower(public.import_clean_text(p_payload ->> 'file_sha256'));
  v_dry_run  BOOLEAN := p_mode <> 'commit';
  v_size     JSONB;
  v_ql       INT := 0;
  v_il       INT := 0;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('validate', 'dry_run', 'commit') THEN
    RAISE EXCEPTION 'import: unknown mode %', p_mode;
  END IF;
  DROP TABLE IF EXISTS pg_temp._imp_err, pg_temp._imp_warn, pg_temp._imp_parties, pg_temp._imp_stock, pg_temp._imp_quotes,
    pg_temp._imp_quote_lines, pg_temp._imp_sales_orders, pg_temp._imp_jobs, pg_temp._imp_purchase_orders, pg_temp._imp_invoices,
    pg_temp._imp_invoice_lines, pg_temp._imp_payments, pg_temp._imp_names;
  CREATE TEMP TABLE _imp_err (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, ord INT, row_no INT, field TEXT, message TEXT) ON COMMIT DROP;
  CREATE TEMP TABLE _imp_warn (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, row_no INT, field TEXT, message TEXT) ON COMMIT DROP;

  -- ===== Customers and suppliers (one table, kind tells them apart) ==========================================================
  CREATE TEMP TABLE _imp_parties ON COMMIT DROP AS
  SELECT s.kind, e.ord::INT AS ord,
         CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
         jsonb_typeof(e.v) = 'object' AS obj,
         (cr.c ->> 'name') AS name, (cr.c ->> 'external_ref') AS external_ref,
         (cr.c ->> 'contact_name') AS contact_name, (cr.c ->> 'email') AS email,
         (cr.c ->> 'phone') AS phone, (cr.c ->> 'mobile') AS mobile,
         (cr.c ->> 'address') AS address, (cr.c ->> 'notes') AS notes,
         NULL::TEXT AS match_key, NULL::UUID AS existing_id, 0 AS existing_n, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM unnest(ARRAY['customers', 'suppliers']) s(kind)
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(p_payload -> s.kind, '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr;
  CREATE INDEX ON _imp_parties (kind, match_key);

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT c.kind, c.ord, c.row_no, f.field, f.message
  FROM _imp_parties c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('name', CASE WHEN c.obj AND c.name IS NULL THEN 'Name is required.'
                  WHEN length(c.name) > 200 THEN 'Name is longer than 200 characters.'
                  WHEN c.name IS NOT NULL AND public.import_norm_name(c.name) = '' THEN 'Name has no letters or digits.' END),
    ('external_ref', CASE WHEN length(c.external_ref) > 60 THEN 'Account reference is longer than 60 characters.' END),
    ('contact_name', CASE WHEN length(c.contact_name) > 200 THEN 'Contact is longer than 200 characters.' END),
    ('email', CASE WHEN length(c.email) > 320 THEN 'E-mail is longer than 320 characters.' END),
    ('phone', CASE WHEN length(c.phone) > 60 THEN 'Phone is longer than 60 characters.' END),
    ('mobile', CASE WHEN length(c.mobile) > 40 THEN 'Mobile is longer than 40 characters.' END),
    ('address', CASE WHEN length(c.address) > 1000 THEN 'Address is longer than 1000 characters.' END),
    ('notes', CASE WHEN length(c.notes) > 4000 THEN 'Notes are longer than 4000 characters.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;

  UPDATE _imp_parties c SET match_key = CASE WHEN c.external_ref IS NOT NULL THEN 'ref:' || c.external_ref ELSE 'name:' || public.import_norm_name(c.name) END
  WHERE c.obj AND c.name IS NOT NULL AND length(c.name) <= 200 AND coalesce(length(c.external_ref), 0) <= 60 AND public.import_norm_name(c.name) <> '';

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT d.kind, d.ord, d.row_no, CASE WHEN d.match_key LIKE 'ref:%' THEN 'external_ref' ELSE 'name' END,
         'The same ' || CASE d.kind WHEN 'customers' THEN 'customer' ELSE 'supplier' END || ' is in this file twice (also row ' || d.first_row || ').'
  FROM (SELECT c.kind, c.ord, c.row_no, c.match_key, first_value(c.row_no) OVER w AS first_row, row_number() OVER w AS rn
        FROM _imp_parties c WHERE c.match_key IS NOT NULL
        WINDOW w AS (PARTITION BY c.kind, c.match_key ORDER BY c.ord)) d
  WHERE d.rn > 1;

  -- An account reference: the record an earlier import created under it (if it is still there).
  UPDATE _imp_parties c SET existing_id = k.record_id, existing_n = 1
  FROM public.import_record_keys k
  WHERE k.organization_id = p_org AND k.kind = c.kind AND k.match_key = c.match_key AND c.match_key LIKE 'ref:%'
    AND ((c.kind = 'customers' AND EXISTS (SELECT 1 FROM public.customers x WHERE x.id = k.record_id AND x.organization_id = p_org))
      OR (c.kind = 'suppliers' AND EXISTS (SELECT 1 FROM public.suppliers x WHERE x.id = k.record_id AND x.organization_id = p_org)));
  -- No reference: the company's records with the same normalised name.
  UPDATE _imp_parties c SET existing_n = x.n, existing_id = CASE WHEN x.n = 1 THEN x.id END
  FROM (SELECT 'customers' AS kind, 'name:' || public.import_norm_name(cu.name) AS match_key, count(*)::INT AS n, (array_agg(cu.id))[1] AS id
        FROM public.customers cu WHERE cu.organization_id = p_org GROUP BY 2
        UNION ALL
        SELECT 'suppliers', 'name:' || public.import_norm_name(su.name), count(*)::INT, (array_agg(su.id))[1]
        FROM public.suppliers su WHERE su.organization_id = p_org GROUP BY 2) x
  WHERE x.kind = c.kind AND x.match_key = c.match_key AND c.match_key LIKE 'name:%';
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT c.kind, c.ord, c.row_no, 'name',
         'Matches ' || c.existing_n || ' ' || replace(c.kind, '_', ' ') || ' already in Tolra with the same name: give its account reference, or merge them first.'
  FROM _imp_parties c WHERE c.existing_n > 1;
  -- Matched, but the file's details differ from Tolra's: kept as they are in Tolra (never overwritten), and the admin is told.
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT c.kind, c.row_no, 'name', c.name || ' is already in Tolra with a different ' || d.fields || ': kept as it is, nothing is overwritten.'
  FROM _imp_parties c
  JOIN LATERAL (SELECT cu.contact_name, cu.email, cu.phone, cu.mobile, cu.address, cu.notes FROM public.customers cu WHERE c.kind = 'customers' AND cu.id = c.existing_id
                UNION ALL
                SELECT su.contact_name, su.email, su.phone, NULL, NULL, NULL FROM public.suppliers su WHERE c.kind = 'suppliers' AND su.id = c.existing_id) x ON TRUE
  CROSS JOIN LATERAL (SELECT string_agg(f.name, ', ' ORDER BY f.n) AS fields FROM (VALUES
      (1, 'contact', c.contact_name IS NOT NULL AND c.contact_name IS DISTINCT FROM x.contact_name),
      (2, 'e-mail', c.email IS NOT NULL AND c.email IS DISTINCT FROM x.email),
      (3, 'phone', c.phone IS NOT NULL AND c.phone IS DISTINCT FROM x.phone),
      (4, 'mobile', c.kind = 'customers' AND c.mobile IS NOT NULL AND c.mobile IS DISTINCT FROM x.mobile),
      (5, 'address', c.kind = 'customers' AND c.address IS NOT NULL AND c.address IS DISTINCT FROM x.address),
      (6, 'notes', c.kind = 'customers' AND c.notes IS NOT NULL AND c.notes IS DISTINCT FROM x.notes)) f(n, name, differs)
    WHERE f.differs) d
  WHERE c.existing_n = 1 AND c.existing_id IS NOT NULL AND d.fields IS NOT NULL;

  -- ===== Stock ===============================================================================================================
  CREATE TEMP TABLE _imp_stock ON COMMIT DROP AS
  SELECT x.*, public.import_num(x.unit_price_raw) AS unit_price, public.import_bool(x.auto_purchase_raw) AS auto_purchase,
         CASE WHEN x.current_stock_raw ~ '^-?\d{1,9}$' THEN x.current_stock_raw::INT END AS current_stock,
         CASE WHEN x.min_level_raw ~ '^\d{1,9}$' THEN x.min_level_raw::INT END AS min_level,
         CASE WHEN x.reorder_quantity_raw ~ '^\d{1,9}$' THEN x.reorder_quantity_raw::INT END AS reorder_quantity,
         x.sku AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'sku') AS sku, (cr.c ->> 'material') AS material,
               (cr.c ->> 'current_stock') AS current_stock_raw, (cr.c ->> 'min_level') AS min_level_raw,
               (cr.c ->> 'reorder_quantity') AS reorder_quantity_raw,
               (cr.c ->> 'unit_price') AS unit_price_raw,
               (cr.c ->> 'preferred_supplier') AS preferred_supplier,
               (cr.c ->> 'lead_time_days') AS lead_time_days,
               (cr.c ->> 'auto_purchase') AS auto_purchase_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'stock', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'stock', c.ord, c.row_no, f.field, f.message
  FROM _imp_stock c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('sku', CASE WHEN c.obj AND c.sku IS NULL THEN 'Code (SKU) is required.' WHEN length(c.sku) > 60 THEN 'Code is longer than 60 characters.' END),
    ('material', CASE WHEN c.obj AND c.material IS NULL THEN 'Description is required.' WHEN length(c.material) > 500 THEN 'Description is longer than 500 characters.' END),
    ('current_stock', CASE WHEN c.current_stock_raw IS NOT NULL AND c.current_stock IS NULL THEN 'Stock must be a whole number.' END),
    ('min_level', CASE WHEN c.min_level_raw IS NOT NULL AND c.min_level IS NULL THEN 'Minimum level must be a whole number, 0 or more.' END),
    ('reorder_quantity', CASE WHEN c.reorder_quantity_raw IS NOT NULL AND c.reorder_quantity IS NULL THEN 'Reorder quantity must be a whole number, 0 or more.' END),
    ('unit_price', CASE WHEN c.unit_price_raw IS NOT NULL AND (c.unit_price IS NULL OR c.unit_price < 0 OR c.unit_price <> round(c.unit_price, 4))
                        THEN 'Unit price must be an amount of 0 or more (at most 4 decimals).' END),
    ('preferred_supplier', CASE WHEN length(c.preferred_supplier) > 200 THEN 'Supplier is longer than 200 characters.' END),
    ('lead_time_days', CASE WHEN length(c.lead_time_days) > 60 THEN 'Lead time is longer than 60 characters.' END),
    ('auto_purchase', CASE WHEN c.auto_purchase_raw IS NOT NULL AND c.auto_purchase IS NULL THEN 'Auto purchase must be yes or no.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_stock c SET existing_id = s.id FROM public.stock s WHERE s.organization_id = p_org AND s.sku = c.sku;
  -- Matched by code but the file says something else: kept as it is in Tolra (never overwritten), and the admin is told what differs.
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'stock', c.row_no, 'sku', c.sku || ' is already in Tolra with a different ' || d.fields || ': kept as it is, nothing is overwritten.'
  FROM _imp_stock c JOIN public.stock s ON s.id = c.existing_id
  CROSS JOIN LATERAL (SELECT string_agg(f.name, ', ' ORDER BY f.n) AS fields FROM (VALUES
      (1, 'description', c.material IS NOT NULL AND c.material IS DISTINCT FROM s.material),
      (2, 'unit price', c.unit_price IS NOT NULL AND c.unit_price IS DISTINCT FROM s.unit_price),
      (3, 'supplier', c.preferred_supplier IS NOT NULL AND c.preferred_supplier IS DISTINCT FROM s.preferred_supplier),
      (4, 'lead time', c.lead_time_days IS NOT NULL AND c.lead_time_days IS DISTINCT FROM s.lead_time_days)) f(n, name, differs)
    WHERE f.differs) d
  WHERE d.fields IS NOT NULL;

  -- ===== Quotes and their lines ===============================================================================================
  CREATE TEMP TABLE _imp_quotes ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.quote_date_raw) AS quote_date, public.import_date(x.valid_until_raw) AS valid_until,
         public.import_num(x.total_raw) AS total_given, public.import_bool(x.vat_enabled_raw) AS vat_enabled_given,
         lower(regexp_replace(coalesce(x.status_raw, 'sent'), '[ -]+', '_', 'g')) AS status,
         NULL::NUMERIC AS total_value, x.quote_ref AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord, e.v,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'quote_ref') AS quote_ref, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'quote_date') AS quote_date_raw, (cr.c ->> 'valid_until') AS valid_until_raw,
               (cr.c ->> 'status') AS status_raw, (cr.c ->> 'description') AS description,
               (cr.c ->> 'terms') AS terms, (cr.c ->> 'customer_notes') AS customer_notes,
               (cr.c ->> 'internal_notes') AS internal_notes, (cr.c ->> 'total_value') AS total_raw,
               (cr.c ->> 'vat_enabled') AS vat_enabled_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'quotes', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  CREATE TEMP TABLE _imp_quote_lines ON COMMIT DROP AS
  SELECT x.*, public.import_num(x.quantity_raw) AS quantity, public.import_num(x.unit_price_raw) AS unit_price,
         public.import_num(x.vat_pct_raw) AS vat_pct, public.import_bool(x.vat_exempt_raw) AS vat_exempt
  FROM (SELECT q.ord AS q_ord, q.row_no AS q_row, l.pos::INT AS pos, jsonb_typeof(l.v) = 'object' AS obj,
               (cl.c ->> 'description') AS description,
               coalesce((cl.c ->> 'quantity'), '1') AS quantity_raw,
               coalesce((cl.c ->> 'unit_price'), '0') AS unit_price_raw,
               coalesce((cl.c ->> 'vat_pct'), '20') AS vat_pct_raw,
               coalesce((cl.c ->> 'vat_exempt'), 'false') AS vat_exempt_raw,
               (cl.c ->> 'part_number') AS part_number, (cl.c ->> 'drawing_number') AS drawing_number,
               (cl.c ->> 'drawing_revision') AS drawing_revision
        FROM _imp_quotes q
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(q.v -> 'lines') = 'array' THEN q.v -> 'lines' ELSE '[]'::JSONB END) WITH ORDINALITY l(v, pos)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(l.v) AS c OFFSET 0) cl) x;
  CREATE INDEX ON _imp_quote_lines (q_ord);
  ANALYZE _imp_quotes;
  ANALYZE _imp_quote_lines;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'quotes', c.ord, c.row_no, f.field, f.message
  FROM _imp_quotes c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('quote_ref', CASE WHEN c.obj AND c.quote_ref IS NULL THEN 'Quote number is required.' WHEN length(c.quote_ref) > 60 THEN 'Quote number is longer than 60 characters.' END),
    ('customer', CASE WHEN c.obj AND c.customer IS NULL THEN 'Customer is required.' WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('quote_date', CASE WHEN c.quote_date_raw IS NOT NULL AND c.quote_date IS NULL THEN 'Date must be a real date written YYYY-MM-DD.' END),
    ('valid_until', CASE WHEN c.valid_until_raw IS NOT NULL AND c.valid_until IS NULL THEN 'Valid until must be a real date written YYYY-MM-DD.' END),
    ('status', CASE WHEN c.status NOT IN ('draft', 'sent', 'accepted', 'rejected') THEN 'Status must be draft, sent, accepted or rejected.' END),
    ('description', CASE WHEN length(c.description) > 4000 THEN 'Description is longer than 4000 characters.' END),
    ('terms', CASE WHEN length(c.terms) > 4000 THEN 'Terms are longer than 4000 characters.' END),
    ('customer_notes', CASE WHEN length(c.customer_notes) > 4000 THEN 'Notes are longer than 4000 characters.' END),
    ('internal_notes', CASE WHEN length(c.internal_notes) > 4000 THEN 'Internal notes are longer than 4000 characters.' END),
    ('total_value', CASE WHEN c.total_raw IS NOT NULL AND (c.total_given IS NULL OR c.total_given < 0 OR c.total_given <> round(c.total_given, 2))
                         THEN 'Total must be an amount of 0 or more (pounds and pence).' END),
    ('vat_enabled', CASE WHEN c.vat_enabled_raw IS NOT NULL AND c.vat_enabled_given IS NULL THEN 'VAT must be yes or no.' END),
    ('lines', CASE WHEN c.obj AND c.v ? 'lines' AND jsonb_typeof(c.v -> 'lines') NOT IN ('array', 'null') THEN 'Lines must be a list.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'quotes', l.q_ord, l.q_row, 'lines[' || l.pos || '].' || f.field, f.message
  FROM _imp_quote_lines l
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT l.obj THEN 'Not a line.' END),
    ('description', CASE WHEN l.obj AND l.description IS NULL THEN 'Line description is required.' WHEN length(l.description) > 2000 THEN 'Line description is longer than 2000 characters.' END),
    ('quantity', CASE WHEN l.quantity IS NULL OR l.quantity <= 0 OR l.quantity <> round(l.quantity, 4) THEN 'Quantity must be more than 0 (at most 4 decimals).' END),
    ('unit_price', CASE WHEN l.unit_price IS NULL OR l.unit_price < 0 OR l.unit_price <> round(l.unit_price, 4) THEN 'Unit price must be an amount of 0 or more (at most 4 decimals).' END),
    ('vat_pct', CASE WHEN l.vat_pct IS NULL OR l.vat_pct < 0 OR l.vat_pct > 100 OR l.vat_pct <> round(l.vat_pct, 2) THEN 'VAT % must be between 0 and 100.' END),
    ('vat_exempt', CASE WHEN l.vat_exempt IS NULL THEN 'VAT exempt must be yes or no.' END),
    ('part_number', CASE WHEN length(l.part_number) > 100 THEN 'Part number is longer than 100 characters.' END),
    ('drawing_number', CASE WHEN length(l.drawing_number) > 100 THEN 'Drawing number is longer than 100 characters.' END),
    ('drawing_revision', CASE WHEN length(l.drawing_revision) > 20 THEN 'Drawing revision is longer than 20 characters.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  -- The total: as given, else from the lines (net, plus VAT when the quote charges it).
  UPDATE _imp_quotes q SET total_value = coalesce(q.total_given, s.total)
  FROM (SELECT q2.ord, sum(round(l.quantity * l.unit_price, 2)) + CASE WHEN coalesce(q2.vat_enabled_given, TRUE)
                 THEN sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END) ELSE 0 END AS total
        FROM _imp_quotes q2 LEFT JOIN _imp_quote_lines l ON l.q_ord = q2.ord AND l.quantity IS NOT NULL AND l.unit_price IS NOT NULL AND l.vat_pct IS NOT NULL AND l.vat_exempt IS NOT NULL
        GROUP BY q2.ord, q2.vat_enabled_given) s
  WHERE s.ord = q.ord;
  UPDATE _imp_quotes c SET existing_id = q.id FROM public.quotes q WHERE q.organization_id = p_org AND q.quote_ref = c.quote_ref;
  -- Numbering collision: the number is already in Tolra with other content (customer, or total when both have one). A match is only
  -- the same record again; anything else is a problem, never an overwrite.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'quotes', c.ord, c.row_no, 'quote_ref', c.quote_ref || ' is already in Tolra with a different customer or total: nothing is overwritten.'
  FROM _imp_quotes c JOIN public.quotes q ON q.id = c.existing_id
  WHERE public.import_norm_name(q.customer) <> public.import_norm_name(c.customer)
     OR (q.total_value IS NOT NULL AND c.total_value IS NOT NULL AND q.total_value <> c.total_value);

  -- ===== Sales orders ===========================================================================================================
  CREATE TEMP TABLE _imp_sales_orders ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.order_date_raw) AS order_date, public.import_date(x.delivery_date_raw) AS delivery_date,
         public.import_num(x.total_raw) AS total_value, lower(regexp_replace(coalesce(x.status_raw, 'open'), '[ -]+', '_', 'g')) AS status,
         public.import_norm_name(x.customer) AS customer_norm,
         CASE WHEN x.so_number IS NOT NULL THEN x.so_number || '|' || public.import_norm_name(x.customer) END AS match_key,
         NULL::UUID AS existing_id, 0 AS existing_n, NULL::TEXT AS action, gen_random_uuid() AS new_id, NULL::UUID AS quote_id, NULL::UUID AS customer_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'so_number') AS so_number, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'customer_po') AS customer_po, (cr.c ->> 'quote_ref') AS quote_ref,
               (cr.c ->> 'status') AS status_raw, (cr.c ->> 'order_date') AS order_date_raw,
               (cr.c ->> 'delivery_date') AS delivery_date_raw, (cr.c ->> 'total_value') AS total_raw,
               (cr.c ->> 'notes') AS notes
        FROM jsonb_array_elements(coalesce(p_payload -> 'sales_orders', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'sales_orders', c.ord, c.row_no, f.field, f.message
  FROM _imp_sales_orders c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('so_number', CASE WHEN c.obj AND c.so_number IS NULL THEN 'Order number is required.' WHEN length(c.so_number) > 60 THEN 'Order number is longer than 60 characters.' END),
    ('customer', CASE WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('customer_po', CASE WHEN length(c.customer_po) > 100 THEN 'Customer PO is longer than 100 characters.' END),
    ('quote_ref', CASE WHEN length(c.quote_ref) > 60 THEN 'Quote number is longer than 60 characters.' END),
    ('status', CASE WHEN c.status NOT IN ('open', 'confirmed', 'in_production', 'despatched', 'converted', 'closed')
                    THEN 'Status must be open, confirmed, in production, despatched, converted or closed.' END),
    ('order_date', CASE WHEN c.order_date_raw IS NOT NULL AND c.order_date IS NULL THEN 'Order date must be a real date written YYYY-MM-DD.' END),
    ('delivery_date', CASE WHEN c.delivery_date_raw IS NOT NULL AND c.delivery_date IS NULL THEN 'Delivery date must be a real date written YYYY-MM-DD.' END),
    ('total_value', CASE WHEN c.total_raw IS NOT NULL AND (c.total_value IS NULL OR c.total_value < 0 OR c.total_value <> round(c.total_value, 2))
                         THEN 'Total must be an amount of 0 or more (pounds and pence).' END),
    ('notes', CASE WHEN length(c.notes) > 4000 THEN 'Notes are longer than 4000 characters.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_sales_orders c SET existing_n = x.n, existing_id = x.id
  FROM (SELECT so.so_number || '|' || public.import_norm_name(so.customer) AS match_key, count(*)::INT AS n, (array_agg(so.id))[1] AS id
        FROM public.sales_orders so WHERE so.organization_id = p_org GROUP BY 1) x
  WHERE x.match_key = c.match_key;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'sales_orders', c.ord, c.row_no, 'so_number', 'Matches ' || c.existing_n || ' sales orders already in Tolra for this customer.'
  FROM _imp_sales_orders c WHERE c.existing_n > 1;
  -- Numbering collision: the number is already in Tolra, for another customer only. Never overwritten, never doubled.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'sales_orders', c.ord, c.row_no, 'so_number', c.so_number || ' is already in Tolra for another customer: nothing is overwritten.'
  FROM _imp_sales_orders c
  WHERE c.existing_n = 0 AND c.so_number IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.organization_id = p_org AND so.so_number = c.so_number);

  -- ===== Jobs ===================================================================================================================
  CREATE TEMP TABLE _imp_jobs ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.due_date_raw) AS due_date, public.import_date(x.date_received_raw) AS date_received,
         CASE WHEN x.quantity_raw ~ '^\d{1,9}$' THEN x.quantity_raw::INT END AS quantity_required, public.import_num(x.value_raw) AS value,
         lower(regexp_replace(coalesce(x.stage_raw, 'material'), '[ -]+', '_', 'g')) AS stage,
         lower(regexp_replace(coalesce(x.status_raw, 'on_track'), '[ -]+', '_', 'g')) AS status,
         x.job_no AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id, NULL::UUID AS quote_id, NULL::UUID AS so_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'job_no') AS job_no, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'description') AS description, (cr.c ->> 'quote_ref') AS quote_ref,
               (cr.c ->> 'so_number') AS so_number, (cr.c ->> 'customer_po') AS customer_po,
               (cr.c ->> 'stage') AS stage_raw, (cr.c ->> 'status') AS status_raw,
               (cr.c ->> 'due_date') AS due_date_raw, (cr.c ->> 'date_received') AS date_received_raw,
               (cr.c ->> 'drawing_no') AS drawing_no, (cr.c ->> 'quantity_required') AS quantity_raw,
               (cr.c ->> 'material_required') AS material_required,
               (cr.c ->> 'specification') AS specification, (cr.c ->> 'value') AS value_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'jobs', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'jobs', c.ord, c.row_no, f.field, f.message
  FROM _imp_jobs c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('job_no', CASE WHEN c.obj AND c.job_no IS NULL THEN 'Job number is required.' WHEN length(c.job_no) > 60 THEN 'Job number is longer than 60 characters.' END),
    ('customer', CASE WHEN c.obj AND c.customer IS NULL THEN 'Customer is required.' WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('description', CASE WHEN length(c.description) > 4000 THEN 'Description is longer than 4000 characters.' END),
    ('quote_ref', CASE WHEN length(c.quote_ref) > 60 THEN 'Quote number is longer than 60 characters.' END),
    ('so_number', CASE WHEN length(c.so_number) > 60 THEN 'Order number is longer than 60 characters.' END),
    ('customer_po', CASE WHEN length(c.customer_po) > 100 THEN 'Customer PO is longer than 100 characters.' END),
    ('stage', CASE WHEN c.stage NOT IN ('material', 'setup', 'machining', 'inspection')
                   THEN 'Stage must be material, setup, machining or inspection (a finished job is released by its inspection, not imported).' END),
    ('status', CASE WHEN c.status NOT IN ('on_track', 'at_risk', 'overdue') THEN 'Status must be on track, at risk or overdue.' END),
    ('due_date', CASE WHEN c.due_date_raw IS NOT NULL AND c.due_date IS NULL THEN 'Due date must be a real date written YYYY-MM-DD.' END),
    ('date_received', CASE WHEN c.date_received_raw IS NOT NULL AND c.date_received IS NULL THEN 'Date received must be a real date written YYYY-MM-DD.' END),
    ('drawing_no', CASE WHEN length(c.drawing_no) > 200 THEN 'Drawing number is longer than 200 characters.' END),
    ('quantity_required', CASE WHEN c.quantity_raw IS NOT NULL AND c.quantity_required IS NULL THEN 'Quantity must be a whole number, 0 or more.' END),
    ('material_required', CASE WHEN length(c.material_required) > 500 THEN 'Material is longer than 500 characters.' END),
    ('specification', CASE WHEN length(c.specification) > 4000 THEN 'Specification is longer than 4000 characters.' END),
    ('value', CASE WHEN c.value_raw IS NOT NULL AND (c.value IS NULL OR c.value < 0 OR c.value <> round(c.value, 2)) THEN 'Value must be an amount of 0 or more (pounds and pence).' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_jobs c SET existing_id = j.id FROM public.jobs j WHERE j.organization_id = p_org AND j.job_no = c.job_no;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'jobs', c.ord, c.row_no, 'job_no', c.job_no || ' is already in Tolra for a different customer: nothing is overwritten.'
  FROM _imp_jobs c JOIN public.jobs j ON j.id = c.existing_id
  WHERE public.import_norm_name(j.customer) <> public.import_norm_name(c.customer);

  -- ===== Purchase orders ========================================================================================================
  CREATE TEMP TABLE _imp_purchase_orders ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.order_date_raw) AS order_date, public.import_date(x.expected_raw) AS expected_delivery,
         public.import_num(x.total_raw) AS total_value, public.import_bool(x.vat_enabled_raw) AS vat_enabled,
         lower(regexp_replace(coalesce(x.status_raw, 'sent'), '[ -]+', '_', 'g')) AS status,
         x.po_ref AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'po_ref') AS po_ref, (cr.c ->> 'supplier') AS supplier,
               (cr.c ->> 'order_date') AS order_date_raw, (cr.c ->> 'expected_delivery') AS expected_raw,
               (cr.c ->> 'total_value') AS total_raw, (cr.c ->> 'status') AS status_raw,
               (cr.c ->> 'notes') AS notes, (cr.c ->> 'vat_enabled') AS vat_enabled_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'purchase_orders', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'purchase_orders', c.ord, c.row_no, f.field, f.message
  FROM _imp_purchase_orders c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('po_ref', CASE WHEN c.obj AND c.po_ref IS NULL THEN 'PO number is required.' WHEN length(c.po_ref) > 60 THEN 'PO number is longer than 60 characters.' END),
    ('supplier', CASE WHEN length(c.supplier) > 200 THEN 'Supplier is longer than 200 characters.' END),
    ('order_date', CASE WHEN c.order_date_raw IS NOT NULL AND c.order_date IS NULL THEN 'Order date must be a real date written YYYY-MM-DD.' END),
    ('expected_delivery', CASE WHEN c.expected_raw IS NOT NULL AND c.expected_delivery IS NULL THEN 'Delivery date must be a real date written YYYY-MM-DD.' END),
    ('total_value', CASE WHEN c.total_raw IS NOT NULL AND (c.total_value IS NULL OR c.total_value < 0 OR c.total_value <> round(c.total_value, 2))
                         THEN 'Total must be an amount of 0 or more (pounds and pence).' END),
    ('status', CASE WHEN c.status NOT IN ('draft', 'issued', 'sent', 'confirmed', 'partial_received', 'received', 'cancelled')
                    THEN 'Status must be draft, issued, sent, confirmed, partial received, received or cancelled.' END),
    ('notes', CASE WHEN length(c.notes) > 4000 THEN 'Notes are longer than 4000 characters.' END),
    ('vat_enabled', CASE WHEN c.vat_enabled_raw IS NOT NULL AND c.vat_enabled IS NULL THEN 'VAT must be yes or no.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_purchase_orders c SET existing_id = po.id
  FROM public.purchase_orders po WHERE po.organization_id = p_org AND (po.po_ref = c.po_ref OR po.po_number = c.po_ref);
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'purchase_orders', c.ord, c.row_no, 'po_ref', c.po_ref || ' is already in Tolra with a different supplier or total: nothing is overwritten.'
  FROM _imp_purchase_orders c JOIN public.purchase_orders po ON po.id = c.existing_id
  WHERE public.import_norm_name(po.supplier) <> public.import_norm_name(c.supplier)
     OR (po.total_value IS NOT NULL AND c.total_value IS NOT NULL AND po.total_value <> c.total_value);

  -- ===== Invoices and their lines ===============================================================================================
  CREATE TEMP TABLE _imp_invoices ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.invoice_date_raw) AS invoice_date, public.import_date(x.due_date_raw) AS due_date,
         public.import_num(x.subtotal_raw) AS subtotal_given, public.import_num(x.vat_raw) AS vat_given, public.import_num(x.total_raw) AS total_given,
         coalesce(public.import_bool(x.vat_enabled_raw), TRUE) AS vat_enabled,
         lower(regexp_replace(coalesce(x.status_raw, 'sent'), '[ -]+', '_', 'g')) AS status_given,
         NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat, NULL::NUMERIC AS total, NULL::NUMERIC AS paid, NULL::DATE AS last_paid_on,
         NULL::TEXT AS status, FALSE AS payment_unverified, NULL::UUID AS job_id,
         x.invoice_ref AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord, e.v,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'invoice_ref') AS invoice_ref, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'invoice_date') AS invoice_date_raw, (cr.c ->> 'due_date') AS due_date_raw,
               (cr.c ->> 'status') AS status_raw, (cr.c ->> 'subtotal') AS subtotal_raw,
               (cr.c ->> 'vat') AS vat_raw, (cr.c ->> 'total') AS total_raw,
               (cr.c ->> 'vat_enabled') AS vat_enabled_raw, (cr.c ->> 'terms') AS terms,
               (cr.c ->> 'customer_po') AS customer_po, (cr.c ->> 'quote_ref') AS quote_ref,
               (cr.c ->> 'job_no') AS job_no, (cr.c ->> 'description') AS description
        FROM jsonb_array_elements(coalesce(p_payload -> 'invoices', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  CREATE TEMP TABLE _imp_invoice_lines ON COMMIT DROP AS
  SELECT x.*, public.import_num(x.quantity_raw) AS quantity, public.import_num(x.unit_price_raw) AS unit_price,
         public.import_num(x.vat_pct_raw) AS vat_pct, public.import_bool(x.vat_exempt_raw) AS vat_exempt
  FROM (SELECT i.ord AS i_ord, i.row_no AS i_row, l.pos::INT AS pos, jsonb_typeof(l.v) = 'object' AS obj,
               (cl.c ->> 'description') AS description,
               coalesce((cl.c ->> 'quantity'), '1') AS quantity_raw,
               coalesce((cl.c ->> 'unit_price'), '0') AS unit_price_raw,
               coalesce((cl.c ->> 'vat_pct'), '20') AS vat_pct_raw,
               coalesce((cl.c ->> 'vat_exempt'), 'false') AS vat_exempt_raw
        FROM _imp_invoices i
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.v -> 'lines') = 'array' THEN i.v -> 'lines' ELSE '[]'::JSONB END) WITH ORDINALITY l(v, pos)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(l.v) AS c OFFSET 0) cl) x;
  CREATE INDEX ON _imp_invoices (invoice_ref, ord);
  CREATE INDEX ON _imp_invoice_lines (i_ord);
  ANALYZE _imp_invoices;
  ANALYZE _imp_invoice_lines;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'invoices', l.i_ord, l.i_row, 'lines[' || l.pos || '].' || f.field, f.message
  FROM _imp_invoice_lines l
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT l.obj THEN 'Not a line.' END),
    ('description', CASE WHEN l.obj AND l.description IS NULL THEN 'Line description is required.' WHEN length(l.description) > 2000 THEN 'Line description is longer than 2000 characters.' END),
    ('quantity', CASE WHEN l.quantity IS NULL OR l.quantity < 0 OR l.quantity <> round(l.quantity, 4) THEN 'Quantity must be 0 or more (at most 4 decimals).'
                      WHEN l.quantity = 0 AND l.unit_price IS DISTINCT FROM 0 THEN 'A line with quantity 0 is a text line: its unit price must be 0.' END),
    ('unit_price', CASE WHEN l.unit_price IS NULL OR l.unit_price < 0 OR l.unit_price <> round(l.unit_price, 4) THEN 'Unit price must be an amount of 0 or more (at most 4 decimals).' END),
    ('vat_pct', CASE WHEN l.vat_pct IS NULL OR l.vat_pct < 0 OR l.vat_pct > 100 OR l.vat_pct <> round(l.vat_pct, 2) THEN 'VAT % must be between 0 and 100.' END),
    ('vat_exempt', CASE WHEN l.vat_exempt IS NULL THEN 'VAT exempt must be yes or no.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;

  -- Totals: as given (VAT 0 and net = total when only the total is given; the missing one of net and VAT from the other two), else
  -- from the lines. Net + VAT must equal the total.
  UPDATE _imp_invoices i SET
    total = CASE WHEN i.subtotal_given IS NULL AND i.vat_given IS NULL AND i.total_given IS NULL THEN s.net + s.tax ELSE i.total_given END,
    vat = CASE WHEN i.subtotal_given IS NULL AND i.vat_given IS NULL AND i.total_given IS NULL THEN s.tax
               ELSE coalesce(i.vat_given, i.total_given - i.subtotal_given, 0) END,
    subtotal = CASE WHEN i.subtotal_given IS NULL AND i.vat_given IS NULL AND i.total_given IS NULL THEN s.net
                    ELSE coalesce(i.subtotal_given, i.total_given - coalesce(i.vat_given, 0)) END
  FROM (SELECT i2.ord, count(l.pos) AS n,
               sum(round(l.quantity * l.unit_price, 2)) AS net,
               CASE WHEN i2.vat_enabled THEN sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END) ELSE 0 END AS tax
        FROM _imp_invoices i2 LEFT JOIN _imp_invoice_lines l ON l.i_ord = i2.ord AND l.quantity IS NOT NULL AND l.unit_price IS NOT NULL AND l.vat_pct IS NOT NULL AND l.vat_exempt IS NOT NULL
        GROUP BY i2.ord, i2.vat_enabled) s
  WHERE s.ord = i.ord;
  UPDATE _imp_invoices c SET existing_id = i.id FROM public.invoices i WHERE i.organization_id = p_org AND i.invoice_ref = c.invoice_ref;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'invoices', c.ord, c.row_no, 'invoice_ref', c.invoice_ref || ' is already in Tolra with a different customer or total: nothing is overwritten.'
  FROM _imp_invoices c JOIN public.invoices i ON i.id = c.existing_id
  WHERE public.import_norm_name(i.customer) <> public.import_norm_name(c.customer)
     OR (i.total IS NOT NULL AND c.total IS NOT NULL AND i.total <> c.total);

  -- ===== Payments ===============================================================================================================
  CREATE TEMP TABLE _imp_payments ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.paid_on_raw) AS paid_on, public.import_num(x.amount_raw) AS amount,
         CASE lower(x.method_raw) WHEN 'bacs' THEN 'BACS' WHEN 'bank transfer' THEN 'BACS' WHEN 'cheque' THEN 'cheque' WHEN 'check' THEN 'cheque'
                                  WHEN 'card' THEN 'card' WHEN 'cash' THEN 'cash' WHEN 'other' THEN 'other' END AS method,
         0 AS ordinal, NULL::TEXT AS match_key, NULL::UUID AS existing_id, NULL::UUID AS invoice_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'invoice_ref') AS invoice_ref, (cr.c ->> 'paid_on') AS paid_on_raw,
               (cr.c ->> 'amount') AS amount_raw, (cr.c ->> 'method') AS method_raw,
               (cr.c ->> 'reference') AS reference
        FROM jsonb_array_elements(coalesce(p_payload -> 'payments', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;
  CREATE INDEX ON _imp_payments (ord);
  ANALYZE _imp_payments;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'payments', c.ord, c.row_no, f.field, f.message
  FROM _imp_payments c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('invoice_ref', CASE WHEN c.obj AND c.invoice_ref IS NULL THEN 'Invoice number is required.' WHEN length(c.invoice_ref) > 60 THEN 'Invoice number is longer than 60 characters.' END),
    ('paid_on', CASE WHEN c.obj AND c.paid_on_raw IS NULL THEN 'Date paid is required.' WHEN c.paid_on_raw IS NOT NULL AND c.paid_on IS NULL THEN 'Date paid must be a real date written YYYY-MM-DD.' END),
    ('amount', CASE WHEN c.obj AND c.amount_raw IS NULL THEN 'Amount is required.'
                    WHEN c.amount_raw IS NOT NULL AND (c.amount IS NULL OR c.amount <= 0 OR c.amount <> round(c.amount, 2)) THEN 'Amount must be more than 0 (pounds and pence).' END),
    ('method', CASE WHEN c.method_raw IS NOT NULL AND c.method IS NULL THEN 'Method must be BACS, cheque, card, cash or other.' END),
    ('reference', CASE WHEN length(c.reference) > 100 THEN 'Reference is longer than 100 characters.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  -- The key: invoice number, date, amount and the payment's place among the file's payments with those three.
  UPDATE _imp_payments p SET ordinal = o.n, match_key = p.invoice_ref || '|' || p.paid_on::TEXT || '|' || to_char(p.amount, 'FM999999999990.00') || '|' || o.n
  FROM (SELECT p2.ord, row_number() OVER (PARTITION BY p2.invoice_ref, p2.paid_on, p2.amount ORDER BY p2.ord)::INT AS n
        FROM _imp_payments p2 WHERE p2.invoice_ref IS NOT NULL AND p2.paid_on IS NOT NULL AND p2.amount IS NOT NULL AND p2.amount > 0) o
  WHERE o.ord = p.ord AND length(p.invoice_ref) <= 60;
  UPDATE _imp_payments p SET existing_id = k.record_id
  FROM public.import_record_keys k
  WHERE k.organization_id = p_org AND k.kind = 'payments' AND k.match_key = p.match_key
    AND EXISTS (SELECT 1 FROM public.invoice_payments x WHERE x.id = k.record_id AND x.organization_id = p_org);

  -- ===== In-file duplicates (documents and stock) =================================================================================
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT d.kind, d.ord, d.row_no, d.field, 'This number is in the file twice (also row ' || d.first_row || ').'
  FROM (SELECT y.*, first_value(y.row_no) OVER w AS first_row, row_number() OVER w AS rn
        FROM (SELECT 'stock' AS kind, 'sku' AS field, ord, row_no, match_key FROM _imp_stock
              UNION ALL SELECT 'quotes', 'quote_ref', ord, row_no, match_key FROM _imp_quotes
              UNION ALL SELECT 'sales_orders', 'so_number', ord, row_no, match_key FROM _imp_sales_orders
              UNION ALL SELECT 'jobs', 'job_no', ord, row_no, match_key FROM _imp_jobs
              UNION ALL SELECT 'purchase_orders', 'po_ref', ord, row_no, match_key FROM _imp_purchase_orders
              UNION ALL SELECT 'invoices', 'invoice_ref', ord, row_no, match_key FROM _imp_invoices) y
        WHERE y.match_key IS NOT NULL
        WINDOW w AS (PARTITION BY y.kind, y.match_key ORDER BY y.ord)) d
  WHERE d.rn > 1;

  -- ===== Decide: create, match (skipped), or error =================================================================================
  CREATE INDEX ON _imp_err (kind, ord);
  ANALYZE _imp_err;
  UPDATE _imp_parties c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = c.kind AND e.ord = c.ord) THEN 'error'
                                          WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END;
  UPDATE _imp_stock c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'stock' AND e.ord = c.ord) THEN 'error'
                                        WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END;
  UPDATE _imp_quotes c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'quotes' AND e.ord = c.ord) THEN 'error'
                                         WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END;
  UPDATE _imp_sales_orders c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'sales_orders' AND e.ord = c.ord) THEN 'error'
                                               WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END;
  UPDATE _imp_jobs c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'jobs' AND e.ord = c.ord) THEN 'error'
                                       WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END;
  UPDATE _imp_purchase_orders c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'purchase_orders' AND e.ord = c.ord) THEN 'error'
                                                  WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END;

  -- Payments: matched by key; created only with an invoice this import creates.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'payments', p.ord, p.row_no, 'invoice_ref',
         CASE WHEN i.ord IS NOT NULL AND EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord)
                THEN 'Its invoice (row ' || i.row_no || ') has problems.'
              WHEN i.ord IS NOT NULL AND i.existing_id IS NULL THEN NULL
              WHEN i.existing_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.invoices x WHERE x.organization_id = p_org AND x.invoice_ref = p.invoice_ref)
                THEN 'Invoice ' || p.invoice_ref || ' is already in Tolra: record this payment on it with Record payment.'
              ELSE 'There is no invoice ' || p.invoice_ref || ' in this file or in Tolra.' END
  FROM _imp_payments p
  LEFT JOIN LATERAL (SELECT i2.ord, i2.row_no, i2.existing_id FROM _imp_invoices i2 WHERE i2.invoice_ref = p.invoice_ref ORDER BY i2.ord LIMIT 1) i ON TRUE
  WHERE p.match_key IS NOT NULL AND p.existing_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'payments' AND e.ord = p.ord)
    AND (i.ord IS NULL OR i.existing_id IS NOT NULL OR EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord));
  UPDATE _imp_payments p SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'payments' AND e.ord = p.ord) THEN 'error'
                                           WHEN p.existing_id IS NOT NULL THEN 'match' ELSE 'create' END,
                             invoice_id = (SELECT i.new_id FROM _imp_invoices i WHERE i.invoice_ref = p.invoice_ref ORDER BY i.ord LIMIT 1);

  -- Invoices: what was paid, and the state that follows from it. No payment is invented: an invoice marked paid or part paid without
  -- payments stays sent and is flagged "Payment to confirm".
  UPDATE _imp_invoices i SET paid = coalesce(s.paid, 0), last_paid_on = s.last
  FROM (SELECT i2.ord, sum(p.amount) AS paid, max(p.paid_on) AS last
        FROM _imp_invoices i2 LEFT JOIN _imp_payments p ON p.invoice_id = i2.new_id AND p.action = 'create'
        GROUP BY i2.ord) s
  WHERE s.ord = i.ord;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'invoices', c.ord, c.row_no, f.field, f.message
  FROM _imp_invoices c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('invoice_ref', CASE WHEN c.obj AND c.invoice_ref IS NULL THEN 'Invoice number is required.' WHEN length(c.invoice_ref) > 60 THEN 'Invoice number is longer than 60 characters.' END),
    ('customer', CASE WHEN c.obj AND c.customer IS NULL THEN 'Customer is required.' WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('invoice_date', CASE WHEN c.obj AND c.invoice_date_raw IS NULL THEN 'Invoice date is required.'
                          WHEN c.invoice_date_raw IS NOT NULL AND c.invoice_date IS NULL THEN 'Invoice date must be a real date written YYYY-MM-DD.' END),
    ('due_date', CASE WHEN c.due_date_raw IS NOT NULL AND c.due_date IS NULL THEN 'Due date must be a real date written YYYY-MM-DD.' END),
    ('status', CASE WHEN c.status_given NOT IN ('issued', 'sent', 'partial', 'paid', 'void', 'cancelled', 'written_off')
                    THEN 'Status must be issued, sent, partial, paid, void, cancelled or written off (drafts and credited invoices are not imported).' END),
    ('subtotal', CASE WHEN c.subtotal_raw IS NOT NULL AND (c.subtotal_given IS NULL OR c.subtotal_given < 0 OR c.subtotal_given <> round(c.subtotal_given, 2))
                      THEN 'Net must be an amount of 0 or more (pounds and pence).' END),
    ('vat', CASE WHEN c.vat_raw IS NOT NULL AND (c.vat_given IS NULL OR c.vat_given < 0 OR c.vat_given <> round(c.vat_given, 2))
                 THEN 'VAT must be an amount of 0 or more (pounds and pence).' END),
    ('total', CASE WHEN c.total_raw IS NOT NULL AND (c.total_given IS NULL OR c.total_given < 0 OR c.total_given <> round(c.total_given, 2))
                     THEN 'Total must be an amount of 0 or more (pounds and pence).'
                   WHEN c.obj AND c.total_raw IS NULL AND (c.subtotal_raw IS NOT NULL OR c.vat_raw IS NOT NULL) THEN 'Total is required with net or VAT.'
                   WHEN c.obj AND c.total_raw IS NULL AND c.subtotal_raw IS NULL AND c.vat_raw IS NULL
                        AND NOT EXISTS (SELECT 1 FROM _imp_invoice_lines l WHERE l.i_ord = c.ord) THEN 'Total is required (or give the lines).'
                   WHEN c.total IS NOT NULL AND (c.subtotal < 0 OR c.vat < 0 OR c.subtotal + c.vat <> c.total) THEN 'Net + VAT must equal the total.'
                   WHEN c.paid > c.total THEN 'Its payments come to ' || to_char(c.paid, 'FM999999999990.00') || ', more than its total.' END),
    ('vat_enabled', CASE WHEN c.vat_enabled_raw IS NOT NULL AND public.import_bool(c.vat_enabled_raw) IS NULL THEN 'VAT must be yes or no.' END),
    ('terms', CASE WHEN length(c.terms) > 4000 THEN 'Terms are longer than 4000 characters.' END),
    ('customer_po', CASE WHEN length(c.customer_po) > 100 THEN 'Customer PO is longer than 100 characters.' END),
    ('quote_ref', CASE WHEN length(c.quote_ref) > 60 THEN 'Quote number is longer than 60 characters.' END),
    ('job_no', CASE WHEN length(c.job_no) > 60 THEN 'Job number is longer than 60 characters.' END),
    ('description', CASE WHEN length(c.description) > 4000 THEN 'Description is longer than 4000 characters.' END),
    ('lines', CASE WHEN c.obj AND c.v ? 'lines' AND jsonb_typeof(c.v -> 'lines') NOT IN ('array', 'null') THEN 'Lines must be a list.' END),
    ('payments', CASE WHEN c.paid > 0 AND c.status_given IN ('void', 'cancelled') THEN 'A void or cancelled invoice can''t have payments.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_invoices i SET
    status = CASE WHEN i.status_given IN ('void', 'cancelled', 'written_off') THEN i.status_given
                  WHEN i.paid > 0 AND i.paid >= i.total THEN 'paid'
                  WHEN i.paid > 0 THEN 'partial'
                  WHEN i.status_given = 'paid' AND i.total = 0 THEN 'paid'
                  WHEN i.status_given IN ('paid', 'partial') THEN 'sent'
                  ELSE i.status_given END,
    payment_unverified = (i.status_given IN ('paid', 'partial') AND i.paid = 0 AND i.total > 0),
    action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord) THEN 'error'
                  WHEN i.existing_id IS NOT NULL THEN 'match' ELSE 'create' END;
  -- Fresh statistics now that every row has its action (the temporary tables are not analysed on their own).
  ANALYZE _imp_parties;
  ANALYZE _imp_stock;
  ANALYZE _imp_quotes;
  ANALYZE _imp_sales_orders;
  ANALYZE _imp_jobs;
  ANALYZE _imp_purchase_orders;
  ANALYZE _imp_invoices;
  ANALYZE _imp_payments;
  -- A payment whose invoice turned out to have a problem above.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'payments', p.ord, p.row_no, 'invoice_ref', 'Its invoice (row ' || i.row_no || ') has problems.'
  FROM _imp_payments p JOIN _imp_invoices i ON i.new_id = p.invoice_id
  WHERE p.action = 'create' AND i.action = 'error';
  UPDATE _imp_payments p SET action = 'error' WHERE p.action = 'create' AND EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'payments' AND e.ord = p.ord);

  -- ===== Warnings (never stop the import) ==========================================================================================
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'invoices', i.row_no, 'status', 'Marked ' || i.status_given || ' but no payments were given: imported as sent and flagged "Payment to confirm".'
  FROM _imp_invoices i WHERE i.action = 'create' AND i.payment_unverified;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'invoices', i.row_no, 'total', 'The lines come to net ' || to_char(s.net, 'FM999999999990.00') || ', VAT ' || to_char(s.tax, 'FM999999999990.00')
         || '; the invoice says net ' || to_char(i.subtotal, 'FM999999999990.00') || ', VAT ' || to_char(i.vat, 'FM999999999990.00') || ' (the invoice''s figures are kept).'
  FROM _imp_invoices i
  JOIN (SELECT l.i_ord, sum(round(l.quantity * l.unit_price, 2)) AS net,
               sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END) AS tax
        FROM _imp_invoice_lines l GROUP BY l.i_ord) s ON s.i_ord = i.ord
  WHERE i.action = 'create' AND (s.net IS DISTINCT FROM i.subtotal OR (CASE WHEN i.vat_enabled THEN s.tax ELSE 0 END) IS DISTINCT FROM i.vat);
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT y.kind, y.row_no, y.field, y.ref || ' is not ' || y.prefix || '-<digits>: it is imported as written, and Tolra''s ' || y.prefix || ' numbers carry on from their own counter.'
  FROM (SELECT 'quotes' AS kind, row_no, 'quote_ref' AS field, quote_ref AS ref, 'QUO' AS prefix FROM _imp_quotes WHERE action = 'create'
        UNION ALL SELECT 'invoices', row_no, 'invoice_ref', invoice_ref, 'INV' FROM _imp_invoices WHERE action = 'create'
        UNION ALL SELECT 'purchase_orders', row_no, 'po_ref', po_ref, 'PO' FROM _imp_purchase_orders WHERE action = 'create'
        UNION ALL SELECT 'jobs', row_no, 'job_no', job_no, 'J' FROM _imp_jobs WHERE action = 'create'
        UNION ALL SELECT 'sales_orders', row_no, 'so_number', so_number, 'SO' FROM _imp_sales_orders WHERE action = 'create') y
  WHERE y.ref !~ ('^' || y.prefix || '-\d{1,9}$');

  -- ===== Counts and problems =======================================================================================================
  FOREACH v_k IN ARRAY v_kinds LOOP
    EXECUTE format($q$SELECT jsonb_build_object('created', count(*) FILTER (WHERE action = 'create'), 'matched_existing', count(*) FILTER (WHERE action = 'match'),
                                               'errors', count(*) FILTER (WHERE action = 'error'))
                      FROM %s%s$q$, CASE WHEN v_k IN ('customers', 'suppliers') THEN 'pg_temp._imp_parties WHERE kind = ' || quote_literal(v_k) ELSE 'pg_temp._imp_' || v_k END, '')
      INTO v_result;
    v_counts := v_counts || jsonb_build_object(v_k, v_result);
  END LOOP;
  SELECT count(*) INTO v_ql FROM _imp_quote_lines l JOIN _imp_quotes q ON q.ord = l.q_ord WHERE q.action = 'create';
  SELECT count(*) INTO v_il FROM _imp_invoice_lines l JOIN _imp_invoices i ON i.ord = l.i_ord WHERE i.action = 'create';
  v_counts := v_counts || jsonb_build_object('quote_lines', jsonb_build_object('created', v_ql), 'invoice_lines', jsonb_build_object('created', v_il));
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'row', e.row_no, 'field', e.field, 'message', e.message) ORDER BY e.seq)
                              FILTER (WHERE e.seq_rank <= 1000), '[]'::JSONB)
    INTO v_error_n, v_errors
    FROM (SELECT e2.*, row_number() OVER (ORDER BY e2.seq) AS seq_rank FROM _imp_err e2) e;
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('kind', w.kind, 'row', w.row_no, 'field', w.field, 'message', w.message) ORDER BY w.seq)
                              FILTER (WHERE w.seq_rank <= 500), '[]'::JSONB)
    INTO v_warn_n, v_warnings
    FROM (SELECT w2.*, row_number() OVER (ORDER BY w2.seq) AS seq_rank FROM _imp_warn w2) w;
  SELECT coalesce(array_agg(k ORDER BY o), ARRAY[]::TEXT[]) INTO v_present
    FROM unnest(v_kinds) WITH ORDINALITY u(k, o) WHERE jsonb_array_length(coalesce(p_payload -> k, '[]'::JSONB)) > 0;

  -- Size: records and lines in the file, and the audit rows writing them would add (each created record, line and issued invoice
  -- writes one; payments none). The time of a call follows the audit rows (docs/RELEASE.md "076", timing).
  v_size := jsonb_build_object(
    'records', (SELECT count(*) FROM _imp_parties) + (SELECT count(*) FROM _imp_stock) + (SELECT count(*) FROM _imp_quotes)
               + (SELECT count(*) FROM _imp_sales_orders) + (SELECT count(*) FROM _imp_jobs) + (SELECT count(*) FROM _imp_purchase_orders)
               + (SELECT count(*) FROM _imp_invoices) + (SELECT count(*) FROM _imp_payments),
    'lines', (SELECT count(*) FROM _imp_quote_lines) + (SELECT count(*) FROM _imp_invoice_lines),
    'audit_rows', (SELECT count(*) FROM _imp_parties WHERE action = 'create') + (SELECT count(*) FROM _imp_stock WHERE action = 'create')
                  + (SELECT count(*) FROM _imp_quotes WHERE action = 'create') + (SELECT count(*) FROM _imp_sales_orders WHERE action = 'create')
                  + (SELECT count(*) FROM _imp_jobs WHERE action = 'create') + (SELECT count(*) FROM _imp_purchase_orders WHERE action = 'create')
                  + 2 * (SELECT count(*) FROM _imp_invoices WHERE action = 'create') + v_ql + v_il);
  v_result := jsonb_build_object('ok', v_error_n = 0, 'dry_run', v_dry_run, 'mode', p_mode, 'committed', FALSE, 'batch_id', NULL,
    'import_id', p_import_id, 'part', p_part, 'parts', p_parts, 'size', v_size, 'kinds', to_jsonb(v_present),
    'file_name', v_file, 'file_sha256', v_sha, 'counts', v_counts, 'error_count', v_error_n, 'errors', v_errors,
    'warning_count', v_warn_n, 'warnings', v_warnings, 'doc_counters', NULL);
  IF v_error_n > 0 OR p_mode = 'validate' THEN
    RETURN v_result;
  END IF;

  -- ===== Write (only with no problems at all) ======================================================================================
  -- The guards let this company's finished records in while this is set (documents_start_as_drafts, the issued-line locks).
  PERFORM set_config('quoteflow.data_import', p_org::TEXT, TRUE);

  INSERT INTO public.customers (id, organization_id, name, contact_name, email, phone, mobile, address, notes, status)
  SELECT c.new_id, p_org, c.name, c.contact_name, c.email, c.phone, c.mobile, c.address, c.notes, 'active'
  FROM _imp_parties c WHERE c.kind = 'customers' AND c.action = 'create' ORDER BY c.ord;
  -- Suppliers have no address column: an address goes into the notes.
  INSERT INTO public.suppliers (id, organization_id, name, contact_name, email, phone, notes)
  SELECT c.new_id, p_org, c.name, c.contact_name, c.email, coalesce(c.phone, c.mobile),
         nullif(concat_ws(E'\n', c.notes, CASE WHEN c.address IS NOT NULL THEN 'Address: ' || c.address END), '')
  FROM _imp_parties c WHERE c.kind = 'suppliers' AND c.action = 'create' ORDER BY c.ord;
  INSERT INTO public.stock (id, organization_id, sku, material, current_stock, min_level, reorder_quantity, unit_price, preferred_supplier, lead_time_days, auto_purchase)
  SELECT c.new_id, p_org, c.sku, c.material, coalesce(c.current_stock, 0), coalesce(c.min_level, 0), coalesce(c.reorder_quantity, 0), c.unit_price,
         c.preferred_supplier, c.lead_time_days, coalesce(c.auto_purchase, FALSE)
  FROM _imp_stock c WHERE c.action = 'create' ORDER BY c.ord;

  INSERT INTO public.quotes (id, organization_id, quote_ref, customer, description, total_value, status, valid_until, terms, customer_notes,
                             internal_notes, vat_enabled, sent_at, accepted_at, rejected_at, created_at, updated_at)
  SELECT c.new_id, p_org, c.quote_ref, c.customer, c.description, c.total_value, c.status, c.valid_until, c.terms, c.customer_notes,
         c.internal_notes, coalesce(c.vat_enabled_given, TRUE),
         CASE WHEN c.status <> 'draft' THEN coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()) END,
         CASE WHEN c.status = 'accepted' THEN coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()) END,
         CASE WHEN c.status = 'rejected' THEN coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()) END,
         coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_quotes c WHERE c.action = 'create' ORDER BY c.ord;
  INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct, vat_exempt,
                                       part_number, drawing_number, drawing_revision)
  SELECT p_org, q.new_id, l.pos - 1, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt, l.part_number, l.drawing_number, l.drawing_revision
  FROM _imp_quote_lines l JOIN _imp_quotes q ON q.ord = l.q_ord WHERE q.action = 'create' ORDER BY q.ord, l.pos;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_ql THEN RAISE EXCEPTION 'import: % quote lines written, % expected', v_n, v_ql; END IF;

  -- The company's customers by normalised name (now including the ones just created): a sales order is linked to its customer when
  -- exactly one has that name.
  CREATE TEMP TABLE _imp_names ON COMMIT DROP AS
  SELECT public.import_norm_name(cu.name) AS nn, count(*)::INT AS n, (array_agg(cu.id))[1] AS id
  FROM public.customers cu WHERE cu.organization_id = p_org GROUP BY 1;
  UPDATE _imp_sales_orders s SET customer_id = n.id FROM _imp_names n WHERE n.nn = s.customer_norm AND n.n = 1 AND s.action = 'create';
  -- Its quote, when that quote has no other sales order (one per quote) and no other order in this file names it.
  UPDATE _imp_sales_orders s SET quote_id = q.id
  FROM public.quotes q
  WHERE s.action = 'create' AND q.organization_id = p_org AND q.quote_ref = s.quote_ref
    AND NOT EXISTS (SELECT 1 FROM public.sales_orders o WHERE o.organization_id = p_org AND o.quote_id = q.id)
    AND (SELECT count(*) FROM _imp_sales_orders s2 WHERE s2.action = 'create' AND s2.quote_ref = s.quote_ref) = 1;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'sales_orders', s.row_no, 'quote_ref', 'Not linked to quote ' || s.quote_ref || ' (not found, or it already has a sales order): kept as text.'
  FROM _imp_sales_orders s WHERE s.action = 'create' AND s.quote_ref IS NOT NULL AND s.quote_id IS NULL;
  INSERT INTO public.sales_orders (id, organization_id, so_number, customer, customer_id, customer_po, quote_id, quote_ref, status, order_date,
                                   delivery_date, total_value, notes, created_at, updated_at)
  SELECT c.new_id, p_org, c.so_number, c.customer, c.customer_id, c.customer_po, c.quote_id, c.quote_ref, c.status, coalesce(c.order_date, CURRENT_DATE),
         c.delivery_date, c.total_value, c.notes,
         coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_sales_orders c WHERE c.action = 'create' ORDER BY c.ord;

  -- Jobs: linked to their quote (by number) and their sales order (number and customer, one job per order).
  UPDATE _imp_jobs j SET quote_id = q.id FROM public.quotes q WHERE j.action = 'create' AND q.organization_id = p_org AND q.quote_ref = j.quote_ref;
  UPDATE _imp_jobs j SET so_id = o.id
  FROM (SELECT so.so_number, public.import_norm_name(so.customer) AS nn, (array_agg(so.id))[1] AS id, count(*) AS n
        FROM public.sales_orders so WHERE so.organization_id = p_org GROUP BY 1, 2) o
  WHERE j.action = 'create' AND o.so_number = j.so_number AND o.nn = public.import_norm_name(j.customer) AND o.n = 1
    AND NOT EXISTS (SELECT 1 FROM public.jobs x WHERE x.converted_from_sales_order_id = o.id)
    AND (SELECT count(*) FROM _imp_jobs j2 WHERE j2.action = 'create' AND j2.so_number = j.so_number
           AND public.import_norm_name(j2.customer) = public.import_norm_name(j.customer)) = 1;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'jobs', j.row_no, 'so_number', 'Not linked to sales order ' || j.so_number || ' (not found for this customer, or it already has a job).'
  FROM _imp_jobs j WHERE j.action = 'create' AND j.so_number IS NOT NULL AND j.so_id IS NULL;
  INSERT INTO public.jobs (id, organization_id, job_no, customer, description, quote_id, quote_ref, converted_from_sales_order_id, customer_po,
                           stage, status, due_date, date_received, drawing_no, quantity_required, material_required, specification, created_at, updated_at)
  SELECT c.new_id, p_org, c.job_no, c.customer, c.description, c.quote_id, c.quote_ref, c.so_id, c.customer_po, c.stage, c.status, c.due_date,
         c.date_received, c.drawing_no, c.quantity_required, c.material_required, c.specification,
         coalesce((c.date_received + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.date_received + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_jobs c WHERE c.action = 'create' ORDER BY c.ord;
  INSERT INTO public.job_values (job_id, organization_id, value)
  SELECT c.new_id, p_org, c.value FROM _imp_jobs c WHERE c.action = 'create' AND c.value IS NOT NULL;
  -- An order created by this import points back at its job.
  UPDATE public.sales_orders so SET converted_to_job_id = j.new_id
  FROM _imp_jobs j JOIN _imp_sales_orders s ON s.new_id = j.so_id AND s.action = 'create'
  WHERE j.action = 'create' AND so.id = j.so_id AND so.organization_id = p_org AND so.converted_to_job_id IS NULL;

  INSERT INTO public.purchase_orders (id, organization_id, po_ref, po_number, supplier, order_date, expected_delivery, items, total_value, status,
                                      notes, vat_enabled, created_at, updated_at)
  SELECT c.new_id, p_org, c.po_ref, c.po_ref, c.supplier, coalesce(c.order_date, CURRENT_DATE), c.expected_delivery, '[]'::JSONB, c.total_value, c.status,
         c.notes, coalesce(c.vat_enabled, FALSE),
         coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_purchase_orders c WHERE c.action = 'create' ORDER BY c.ord;

  -- Invoices: linked to their job by number (never an internal job).
  UPDATE _imp_invoices i SET job_id = j.id FROM public.jobs j
  WHERE i.action = 'create' AND j.organization_id = p_org AND j.job_no = i.job_no AND NOT j.is_internal;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'invoices', i.row_no, 'job_no', 'Not linked to job ' || i.job_no || ' (not found, or an internal job).'
  FROM _imp_invoices i WHERE i.action = 'create' AND i.job_no IS NOT NULL AND i.job_id IS NULL;
  INSERT INTO public.invoices (id, organization_id, invoice_ref, customer, description, subtotal, vat, total, status, due_date, invoice_date, terms,
                               quote_ref, customer_po, job_id, vat_enabled, amount_paid, paid_at, payment_unverified, created_at, updated_at)
  SELECT c.new_id, p_org, c.invoice_ref, c.customer, c.description, c.subtotal, c.vat, c.total, c.status, c.due_date, c.invoice_date, c.terms,
         c.quote_ref, c.customer_po, c.job_id, c.vat_enabled, c.paid,
         CASE WHEN c.status = 'paid' THEN coalesce((c.last_paid_on + TIME '12:00') AT TIME ZONE 'Europe/London', (c.invoice_date + TIME '12:00') AT TIME ZONE 'Europe/London') END,
         c.payment_unverified,
         (c.invoice_date + TIME '12:00') AT TIME ZONE 'Europe/London', (c.invoice_date + TIME '12:00') AT TIME ZONE 'Europe/London'
  FROM _imp_invoices c WHERE c.action = 'create' ORDER BY c.ord;
  INSERT INTO public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
  SELECT p_org, i.new_id, l.pos - 1, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt
  FROM _imp_invoice_lines l JOIN _imp_invoices i ON i.ord = l.i_ord WHERE i.action = 'create' ORDER BY i.ord, l.pos;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_il THEN RAISE EXCEPTION 'import: % invoice lines written, % expected', v_n, v_il; END IF;
  INSERT INTO public.invoice_payments (id, organization_id, invoice_id, amount, paid_on, method, reference, source, created_by)
  SELECT p.new_id, p_org, p.invoice_id, p.amount, p.paid_on, p.method, p.reference, 'recorded', p_uid
  FROM _imp_payments p WHERE p.action = 'create' ORDER BY p.ord;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_expect := (v_counts -> 'payments' ->> 'created')::INT;
  IF v_n <> v_expect THEN RAISE EXCEPTION 'import: % payments written, % expected', v_n, v_expect; END IF;

  PERFORM set_config('quoteflow.data_import', '', TRUE);

  -- ===== Numbering carries on after the highest PREFIX-digits number (the session's company only; a counter never moves back) =====
  -- QUO, INV, J (jobs, and quotes' QUO-n, as reseed_doc_counters), PO (po_ref and po_number), SO, DLN (delivery notes). rfqs have no
  -- number column, so RFQ has nothing to reseed from.
  INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
  SELECT p_org, v.prefix, v.n
  FROM (SELECT 'QUO' AS prefix, (SELECT max(substring(q.quote_ref FROM '^QUO-(\d{1,9})$')::INT) FROM public.quotes q WHERE q.organization_id = p_org) AS n
        UNION ALL SELECT 'INV', (SELECT max(substring(i.invoice_ref FROM '^INV-(\d{1,9})$')::INT) FROM public.invoices i WHERE i.organization_id = p_org)
        UNION ALL SELECT 'J', GREATEST((SELECT max(substring(j.job_no FROM '^J-(\d{1,9})$')::INT) FROM public.jobs j WHERE j.organization_id = p_org),
                                       (SELECT max(substring(q.quote_ref FROM '^QUO-(\d{1,9})$')::INT) FROM public.quotes q WHERE q.organization_id = p_org))
        UNION ALL SELECT 'PO', GREATEST((SELECT max(substring(po.po_ref FROM '^PO-(\d{1,9})$')::INT) FROM public.purchase_orders po WHERE po.organization_id = p_org),
                                        (SELECT max(substring(po.po_number FROM '^PO-(\d{1,9})$')::INT) FROM public.purchase_orders po WHERE po.organization_id = p_org))
        UNION ALL SELECT 'SO', (SELECT max(substring(so.so_number FROM '^SO-(\d{1,9})$')::INT) FROM public.sales_orders so WHERE so.organization_id = p_org)
        UNION ALL SELECT 'DLN', (SELECT max(substring(dn.dn_number FROM '^DLN-(\d{1,9})$')::INT) FROM public.delivery_notes dn WHERE dn.organization_id = p_org)) v
  WHERE v.n IS NOT NULL
  ON CONFLICT (organization_id, prefix) DO UPDATE SET last = GREATEST(c.last, EXCLUDED.last);
  SELECT coalesce(jsonb_object_agg(dc.prefix, dc.last ORDER BY dc.prefix), '{}'::JSONB) INTO v_counters
    FROM public.doc_counters dc WHERE dc.organization_id = p_org;

  -- Warnings found while writing (links not made) are part of the answer.
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('kind', w.kind, 'row', w.row_no, 'field', w.field, 'message', w.message) ORDER BY w.seq)
                              FILTER (WHERE w.seq_rank <= 500), '[]'::JSONB)
    INTO v_warn_n, v_warnings
    FROM (SELECT w2.*, row_number() OVER (ORDER BY w2.seq) AS seq_rank FROM _imp_warn w2) w;
  v_result := v_result || jsonb_build_object('doc_counters', v_counters, 'warning_count', v_warn_n, 'warnings', v_warnings);
  IF p_mode = 'dry_run' THEN
    RETURN v_result;
  END IF;

  -- ===== Commit: the batch, the keys of every created record, the audit event ======================================================
  v_result := v_result || jsonb_build_object('committed', TRUE, 'batch_id', p_batch);
  INSERT INTO public.import_batches (id, organization_id, client_op_id, import_id, large, part, parts, created_by, file_name, file_sha256,
                                     request_sha256, kinds, counts, errors, warnings, result, status)
  VALUES (p_batch, p_org, p_client_op_id, p_import_id, p_import_id IS NOT NULL, p_part, p_parts, p_uid, v_file, v_sha,
          p_request, v_present, v_counts, '[]'::JSONB, v_warnings, v_result, 'committed');
  INSERT INTO public.import_record_keys AS k (organization_id, kind, match_key, record_id, batch_id, audit_rows)
  SELECT p_org, y.kind, y.match_key, y.new_id, p_batch,
         (SELECT count(*) FROM security_audit.audit_log a
          WHERE a.organization_id = p_org AND a.entity_table = CASE y.kind WHEN 'payments' THEN 'invoice_payments' ELSE y.kind END
            AND a.entity_id = y.new_id::TEXT)
  FROM (SELECT kind, match_key, new_id FROM _imp_parties WHERE action = 'create'
        UNION ALL SELECT 'stock', match_key, new_id FROM _imp_stock WHERE action = 'create'
        UNION ALL SELECT 'quotes', match_key, new_id FROM _imp_quotes WHERE action = 'create'
        UNION ALL SELECT 'sales_orders', match_key, new_id FROM _imp_sales_orders WHERE action = 'create'
        UNION ALL SELECT 'jobs', match_key, new_id FROM _imp_jobs WHERE action = 'create'
        UNION ALL SELECT 'purchase_orders', match_key, new_id FROM _imp_purchase_orders WHERE action = 'create'
        UNION ALL SELECT 'invoices', match_key, new_id FROM _imp_invoices WHERE action = 'create'
        UNION ALL SELECT 'payments', match_key, new_id FROM _imp_payments WHERE action = 'create') y
  -- A key whose record has since been removed (e.g. a customer deleted by hand) now names the new record.
  ON CONFLICT (organization_id, kind, match_key) DO UPDATE SET record_id = EXCLUDED.record_id, batch_id = EXCLUDED.batch_id,
                                                                audit_rows = EXCLUDED.audit_rows, created_at = clock_timestamp();
  PERFORM security_audit.log_named_event(p_org, 'IMPORT_COMMITTED', 'import_batches', p_batch::TEXT,
    jsonb_build_object('file_name', v_file, 'file_sha256', v_sha, 'counts', v_counts, 'client_op_id', p_client_op_id, 'warning_count', v_warn_n,
                       'large', p_import_id IS NOT NULL, 'import_id', p_import_id, 'part', p_part, 'parts', p_parts));
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public.import_company_data_run(UUID, UUID, UUID, JSONB, TEXT, UUID, TEXT, UUID, INT, INT) FROM PUBLIC, anon, authenticated;

-- ---- 6. Shared checks (internal) ------------------------------------------------------------------------------------------------
-- The caller: an admin (role or second role) of the session's company, past the second step when the company asks for it, not in a
-- support session (066's rule). The company always comes from here, never from what the caller sends.
CREATE OR REPLACE FUNCTION public.import_admin_org()
RETURNS UUID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.current_user_organization_id();
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'Sign in to a company first.' USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;
  IF EXISTS (SELECT 1 FROM public._session_membership() s WHERE s.is_support) THEN
    RAISE EXCEPTION 'Support access can''t import data into a company.' USING ERRCODE = '42501', HINT = 'support_session';
  END IF;
  IF NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can import data.' USING ERRCODE = '42501', HINT = 'admin_only';
  END IF;
  RETURN v_org;
END
$$;
REVOKE ALL ON FUNCTION public.import_admin_org() FROM PUBLIC, anon, authenticated;

-- The shape of a payload (or of one staged part): known sections only (no company field), each a list, at most 25,000 records and
-- 50,000 lines. Returns the number of records; raises 22023 otherwise.
CREATE OR REPLACE FUNCTION public.import_check_payload(p_payload JSONB)
RETURNS INT
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_bad   TEXT;
  v_rows  INT;
  v_lines INT;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'The import must be one record of sections.' USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_object_keys(p_payload) k
  WHERE k NOT IN ('file_name', 'file_sha256', 'customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown section(s): %.', left(v_bad, 200) USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_each(p_payload) e(k, v)
  WHERE k NOT IN ('file_name', 'file_sha256') AND jsonb_typeof(v) NOT IN ('array', 'null');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Section(s) % must be lists.', v_bad USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;
  IF jsonb_typeof(p_payload -> 'file_name') NOT IN ('string', 'null') OR jsonb_typeof(p_payload -> 'file_sha256') NOT IN ('string', 'null')
     OR lower(public.import_clean_text(p_payload ->> 'file_sha256')) !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'file_name must be text, and file_sha256 the file''s SHA-256 (64 hex characters).' USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;
  SELECT coalesce(sum(jsonb_array_length(v)), 0) INTO v_rows FROM jsonb_each(p_payload) e(k, v) WHERE jsonb_typeof(v) = 'array';
  SELECT coalesce(sum(CASE WHEN jsonb_typeof(d.v -> 'lines') = 'array' THEN jsonb_array_length(d.v -> 'lines') ELSE 0 END), 0) INTO v_lines
  FROM (SELECT jsonb_array_elements(p_payload -> 'quotes') AS v WHERE jsonb_typeof(p_payload -> 'quotes') = 'array'
        UNION ALL SELECT jsonb_array_elements(p_payload -> 'invoices') WHERE jsonb_typeof(p_payload -> 'invoices') = 'array') d;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'There is nothing to import.' USING ERRCODE = '22023', HINT = 'nothing_to_import';
  END IF;
  IF v_rows > 25000 OR v_lines > 50000 THEN
    RAISE EXCEPTION 'Too many rows for one import (at most 25,000 records and 50,000 lines).' USING ERRCODE = '22023', HINT = 'too_many_rows';
  END IF;
  RETURN v_rows;
END
$$;
REVOKE ALL ON FUNCTION public.import_check_payload(JSONB) FROM PUBLIC, anon, authenticated;

-- The first answer for this key (the same request), or NULL when the key is new. Refuses a key used for something else. Called with
-- the company's import lock held.
CREATE OR REPLACE FUNCTION public.import_replay(p_org UUID, p_client_op_id UUID, p_request TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_prior public.import_batches%ROWTYPE;
BEGIN
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'This import needs its key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  SELECT * INTO v_prior FROM public.import_batches b WHERE b.organization_id = p_org AND b.client_op_id = p_client_op_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_prior.request_sha256 = p_request THEN
    RETURN v_prior.result || jsonb_build_object('replayed', TRUE);
  END IF;
  RAISE EXCEPTION 'This import''s key was already used for something else. Try again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
END
$$;
REVOKE ALL ON FUNCTION public.import_replay(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- The answer when the database itself refused (an error the checks did not foresee): one problem, nothing imported.
CREATE OR REPLACE FUNCTION public.import_failure(p_payload JSONB, p_mode TEXT, p_code TEXT, p_message TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('ok', FALSE, 'dry_run', p_mode <> 'commit', 'mode', p_mode, 'committed', FALSE, 'batch_id', NULL,
    'file_name', left(public.import_clean_text(p_payload ->> 'file_name'), 255), 'file_sha256', lower(public.import_clean_text(p_payload ->> 'file_sha256')),
    'counts', '{}'::JSONB, 'error_count', 1, 'warning_count', 0, 'warnings', '[]'::JSONB, 'doc_counters', NULL,
    'errors', jsonb_build_array(jsonb_build_object('kind', NULL, 'row', NULL, 'field', NULL,
      'message', 'The database refused the import, so nothing was imported: ' || left(p_message, 500), 'code', p_code)))
$$;
REVOKE ALL ON FUNCTION public.import_failure(JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ---- 7. A small import: one call, one transaction, all or nothing --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_company_data(p_payload JSONB, p_dry_run BOOLEAN, p_client_op_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_org     UUID := public.import_admin_org();
  v_batch   UUID := gen_random_uuid();
  v_mode    TEXT;
  v_request TEXT;
  v_result  JSONB;
BEGIN
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'This import needs its key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  IF p_dry_run IS NULL THEN
    RAISE EXCEPTION 'Say whether this is a dry run.' USING ERRCODE = '22023', HINT = 'bad_request';
  END IF;
  PERFORM public.import_check_payload(p_payload);
  v_mode := CASE WHEN p_dry_run THEN 'dry_run' ELSE 'commit' END;
  v_request := encode(sha256(convert_to(jsonb_build_object('dry_run', p_dry_run, 'payload', p_payload)::TEXT, 'UTF8')), 'hex');
  -- A null field reads as an absent one (a null section as an empty one).
  p_payload := jsonb_strip_nulls(p_payload);

  -- One import at a time per company; the replay is read with the lock held.
  PERFORM pg_advisory_xact_lock(hashtext('import_company_data'), hashtext(v_org::TEXT));
  v_result := public.import_replay(v_org, p_client_op_id, v_request);
  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;

  -- Everything happens in this sub-block. A dry run, or any problem, ends it with the sentinel: all of it is rolled back, and the
  -- answer (a local variable, not rolled back) is kept. An unexpected database error is caught the same way and reported as a
  -- problem; a cancelled statement (statement_timeout) is not caught and ends the whole call. Nothing is ever left half done.
  BEGIN
    v_result := public.import_company_data_run(v_org, v_uid, v_batch, p_payload, v_mode, p_client_op_id, v_request, NULL, NULL, NULL);
    IF p_dry_run OR NOT (v_result ->> 'ok')::BOOLEAN THEN
      RAISE EXCEPTION 'import rolled back' USING ERRCODE = 'QI076';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'QI076' THEN
      NULL;
    WHEN OTHERS THEN
      v_result := public.import_failure(p_payload, v_mode, SQLSTATE, SQLERRM);
  END;

  IF p_dry_run THEN
    v_result := v_result || jsonb_build_object('batch_id', v_batch);
    INSERT INTO public.import_batches (id, organization_id, client_op_id, created_by, file_name, file_sha256, request_sha256, kinds, counts, errors,
                                       warnings, result, status)
    VALUES (v_batch, v_org, p_client_op_id, v_uid, v_result ->> 'file_name', v_result ->> 'file_sha256', v_request,
            coalesce(ARRAY(SELECT jsonb_array_elements_text(v_result -> 'kinds')), ARRAY[]::TEXT[]), coalesce(v_result -> 'counts', '{}'::JSONB),
            coalesce(v_result -> 'errors', '[]'::JSONB), coalesce(v_result -> 'warnings', '[]'::JSONB), v_result, 'dry_run');
  END IF;
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.import_company_data(JSONB, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_company_data(JSONB, BOOLEAN, UUID) TO authenticated;

-- ---- 8. A large import: staged, validated whole, committed part by part, undone part by part ------------------------------------
-- The staged parts as one payload, in part order. A record without its own "row" gets its place in the whole file, so a part's
-- messages name the file's row.
CREATE OR REPLACE FUNCTION public.import_merge_stage(p_org UUID, p_import_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'file_name', (SELECT s.payload -> 'file_name' FROM public.import_stage s
                         WHERE s.organization_id = p_org AND s.import_id = p_import_id AND s.payload ? 'file_name' ORDER BY s.part LIMIT 1),
           'file_sha256', (SELECT s.payload -> 'file_sha256' FROM public.import_stage s
                           WHERE s.organization_id = p_org AND s.import_id = p_import_id AND s.payload ? 'file_sha256' ORDER BY s.part LIMIT 1)))
         || coalesce((
           SELECT jsonb_object_agg(x.k, x.items)
           FROM (SELECT y.k, jsonb_agg(CASE WHEN jsonb_typeof(y.v) = 'object' AND NOT (y.v ? 'row') THEN y.v || jsonb_build_object('row', y.n + 1) ELSE y.v END
                                       ORDER BY y.n) AS items
                 FROM (SELECT k.k, e.v, row_number() OVER (PARTITION BY k.k ORDER BY s.part, e.ord) AS n
                       FROM public.import_stage s
                       CROSS JOIN LATERAL unnest(ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments']) k(k)
                       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.payload -> k.k) = 'array' THEN s.payload -> k.k ELSE '[]'::JSONB END)
                                          WITH ORDINALITY e(v, ord)
                       WHERE s.organization_id = p_org AND s.import_id = p_import_id) y
                 GROUP BY y.k) x), '{}'::JSONB)
$$;
REVOKE ALL ON FUNCTION public.import_merge_stage(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- The commit plan: four groups in dependency order (customers, suppliers and stock; quotes; sales orders, jobs and purchase orders;
-- invoices with their payments), each cut into parts of about p_weight audit rows (a record 1, each line 1, an invoice 2: its issue
-- may add an audit event). Returns [{kind: [first, last], ...}, ...] (1-based places in the merged lists), one entry per part.
CREATE OR REPLACE FUNCTION public.import_plan(p_merged JSONB, p_weight INT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH items AS (
    SELECT g.grp, g.korder, g.k, e.ord,
           CASE WHEN g.k IN ('quotes', 'invoices')
                THEN (CASE g.k WHEN 'invoices' THEN 2 ELSE 1 END)
                     + CASE WHEN jsonb_typeof(e.v -> 'lines') = 'array' THEN jsonb_array_length(e.v -> 'lines') ELSE 0 END
                ELSE 1 END AS w
    FROM (VALUES (1, 1, 'customers'), (1, 2, 'suppliers'), (1, 3, 'stock'), (2, 1, 'quotes'),
                 (3, 1, 'sales_orders'), (3, 2, 'jobs'), (3, 3, 'purchase_orders'), (4, 1, 'invoices')) g(grp, korder, k)
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p_merged -> g.k) = 'array' THEN p_merged -> g.k ELSE '[]'::JSONB END)
                       WITH ORDINALITY e(v, ord)
  ), cut AS (
    SELECT i.*, (sum(i.w) OVER (PARTITION BY i.grp ORDER BY i.korder, i.ord ROWS UNBOUNDED PRECEDING) - i.w) / greatest(p_weight, 1) AS gpart
    FROM items i
  ), parts AS (
    SELECT c.grp, c.gpart, c.k, min(c.ord) AS lo, max(c.ord) AS hi FROM cut c GROUP BY c.grp, c.gpart, c.k
  )
  SELECT coalesce(jsonb_agg(p.slices ORDER BY p.grp, p.gpart), '[]'::JSONB)
  FROM (SELECT grp, gpart, jsonb_object_agg(k, jsonb_build_array(lo, hi)) AS slices FROM parts GROUP BY grp, gpart) p
$$;
REVOKE ALL ON FUNCTION public.import_plan(JSONB, INT) FROM PUBLIC, anon, authenticated;

-- One part's payload: its slices of the merged lists, and with an invoice slice every payment for those invoices (a payment always
-- goes in with its invoice, so the invoice is written once with what was paid).
CREATE OR REPLACE FUNCTION public.import_part_payload(p_merged JSONB, p_slices JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('file_name', p_merged -> 'file_name', 'file_sha256', p_merged -> 'file_sha256'))
         || coalesce((SELECT jsonb_object_agg(s.k, (SELECT coalesce(jsonb_agg(e.v ORDER BY e.ord), '[]'::JSONB)
                                                     FROM jsonb_array_elements(p_merged -> s.k) WITH ORDINALITY e(v, ord)
                                                     WHERE e.ord BETWEEN (s.r ->> 0)::INT AND (s.r ->> 1)::INT))
                      FROM jsonb_each(p_slices) s(k, r)), '{}'::JSONB)
         || CASE WHEN p_slices ? 'invoices' THEN jsonb_build_object('payments', (
              SELECT coalesce(jsonb_agg(p.v ORDER BY p.ord), '[]'::JSONB)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_merged -> 'payments') = 'array' THEN p_merged -> 'payments' ELSE '[]'::JSONB END)
                   WITH ORDINALITY p(v, ord)
              WHERE public.import_clean_text(p.v ->> 'invoice_ref') IN (
                SELECT public.import_clean_text(i.v ->> 'invoice_ref') FROM jsonb_array_elements(p_merged -> 'invoices') WITH ORDINALITY i(v, ord)
                WHERE i.ord BETWEEN (p_slices -> 'invoices' ->> 0)::INT AND (p_slices -> 'invoices' ->> 1)::INT)))
            ELSE '{}'::JSONB END
$$;
REVOKE ALL ON FUNCTION public.import_part_payload(JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- Stores one part of a large import as the app sent it (replacing that part if it is sent again). Only while the import is open
-- (staging, or validated: a change sends it back to staging, to be validated again). An import abandoned before any commit is
-- removed after 24 hours untouched (below); import_undo discards one at once.
CREATE OR REPLACE FUNCTION public.import_stage_part(p_import_id UUID, p_part INT, p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_org  UUID := public.import_admin_org();
  v_rows INT;
  v_run  public.import_runs%ROWTYPE;
BEGIN
  IF p_import_id IS NULL OR p_part IS NULL OR p_part NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'A part needs its import id and a number from 1 to 1000.' USING ERRCODE = '22023', HINT = 'bad_request';
  END IF;
  v_rows := public.import_check_payload(p_payload);
  PERFORM pg_advisory_xact_lock(hashtext('import_company_data'), hashtext(v_org::TEXT));
  -- Abandoned large imports of this company (never committed, untouched for 24 hours) are cancelled and their staged parts removed.
  -- This company's only; one with a committed part is never touched here (it is finished or undone with import_undo).
  WITH old AS (
    UPDATE public.import_runs r SET status = 'cancelled', updated_at = clock_timestamp()
    WHERE r.organization_id = v_org AND r.import_id <> p_import_id AND r.status IN ('staging', 'validated') AND r.parts_committed = 0
      AND r.updated_at < now() - INTERVAL '24 hours'
    RETURNING r.import_id)
  DELETE FROM public.import_stage s USING old WHERE s.organization_id = v_org AND s.import_id = old.import_id;
  SELECT * INTO v_run FROM public.import_runs r WHERE r.organization_id = v_org AND r.import_id = p_import_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.import_runs (organization_id, import_id, created_by) VALUES (v_org, p_import_id, v_uid) RETURNING * INTO v_run;
  ELSIF v_run.status NOT IN ('staging', 'validated') THEN
    RAISE EXCEPTION 'This import is already %: start a new one to change its file.', v_run.status USING ERRCODE = '22023', HINT = 'import_not_open';
  END IF;
  INSERT INTO public.import_stage (organization_id, import_id, part, payload, rows, created_by)
  VALUES (v_org, p_import_id, p_part, jsonb_strip_nulls(p_payload), v_rows, v_uid)
  ON CONFLICT (organization_id, import_id, part) DO UPDATE SET payload = EXCLUDED.payload, rows = EXCLUDED.rows, created_by = EXCLUDED.created_by,
                                                              created_at = clock_timestamp();
  IF (SELECT sum(s.rows) FROM public.import_stage s WHERE s.organization_id = v_org AND s.import_id = p_import_id) > 25000 THEN
    RAISE EXCEPTION 'Too many rows for one import (at most 25,000 records).' USING ERRCODE = '22023', HINT = 'too_many_rows';
  END IF;
  UPDATE public.import_runs r SET status = 'staging', plan = NULL, parts = NULL, merged_sha256 = NULL, validation = NULL, updated_at = clock_timestamp()
  WHERE r.organization_id = v_org AND r.import_id = p_import_id AND r.status IN ('staging', 'validated');
  RETURN jsonb_build_object('import_id', p_import_id, 'part', p_part, 'rows', v_rows, 'status', 'staging',
    'parts_staged', (SELECT count(*) FROM public.import_stage s WHERE s.organization_id = v_org AND s.import_id = p_import_id),
    'rows_staged', (SELECT sum(s.rows) FROM public.import_stage s WHERE s.organization_id = v_org AND s.import_id = p_import_id));
END
$$;
REVOKE ALL ON FUNCTION public.import_stage_part(UUID, INT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_stage_part(UUID, INT, JSONB) TO authenticated;

-- Validates the WHOLE staged file at once (every part, cross-part duplicates and payments included), writing nothing; the dry run of
-- a large import. With no problem the import is 'validated' with its commit plan (parts of about p_part_weight audit rows, default
-- 500: under 1.5 s a part locally with 077, whatever the size of the audit log; docs/RELEASE.md "076", timing); nothing is committed
-- until every part has passed. Recorded as a dry-run batch marked large.
CREATE OR REPLACE FUNCTION public.import_validate(p_import_id UUID, p_part_weight INT, p_client_op_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_org     UUID := public.import_admin_org();
  v_batch   UUID := gen_random_uuid();
  v_weight  INT := coalesce(p_part_weight, 500);
  v_run     public.import_runs%ROWTYPE;
  v_merged  JSONB;
  v_sha     TEXT;
  v_request TEXT;
  v_result  JSONB;
  v_plan    JSONB;
BEGIN
  IF v_weight NOT BETWEEN 10 AND 20000 THEN
    RAISE EXCEPTION 'A part''s weight must be between 10 and 20,000.' USING ERRCODE = '22023', HINT = 'bad_request';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('import_company_data'), hashtext(v_org::TEXT));
  SELECT * INTO v_run FROM public.import_runs r WHERE r.organization_id = v_org AND r.import_id = p_import_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such import.' USING ERRCODE = 'P0002', HINT = 'import_not_found';
  END IF;
  v_merged := public.import_merge_stage(v_org, p_import_id);
  v_sha := encode(sha256(convert_to(v_merged::TEXT, 'UTF8')), 'hex');
  v_request := encode(sha256(convert_to(jsonb_build_object('validate', p_import_id, 'merged', v_sha, 'weight', v_weight)::TEXT, 'UTF8')), 'hex');
  v_result := public.import_replay(v_org, p_client_op_id, v_request);
  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;
  IF v_run.status NOT IN ('staging', 'validated') THEN
    RAISE EXCEPTION 'This import is already %.', v_run.status USING ERRCODE = '22023', HINT = 'import_not_open';
  END IF;
  PERFORM public.import_check_payload(v_merged);
  BEGIN
    v_result := public.import_company_data_run(v_org, v_uid, v_batch, v_merged, 'validate', p_client_op_id, v_request, p_import_id, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_result := public.import_failure(v_merged, 'validate', SQLSTATE, SQLERRM);
  END;
  IF (v_result ->> 'ok')::BOOLEAN THEN
    v_plan := public.import_plan(v_merged, v_weight);
    UPDATE public.import_runs r SET status = 'validated', merged_sha256 = v_sha, plan = v_plan, parts = jsonb_array_length(v_plan),
                                    part_weight = v_weight, validation = v_result, file_name = v_result ->> 'file_name',
                                    file_sha256 = v_result ->> 'file_sha256', updated_at = clock_timestamp()
    WHERE r.organization_id = v_org AND r.import_id = p_import_id;
  ELSE
    UPDATE public.import_runs r SET status = 'staging', plan = NULL, parts = NULL, merged_sha256 = NULL, validation = v_result, updated_at = clock_timestamp()
    WHERE r.organization_id = v_org AND r.import_id = p_import_id;
  END IF;
  v_result := v_result || jsonb_build_object('batch_id', v_batch, 'large', TRUE, 'import_id', p_import_id,
    'parts', CASE WHEN v_plan IS NULL THEN NULL ELSE jsonb_array_length(v_plan) END, 'part_weight', v_weight);
  INSERT INTO public.import_batches (id, organization_id, client_op_id, import_id, large, parts, created_by, file_name, file_sha256, request_sha256,
                                     kinds, counts, errors, warnings, result, status)
  VALUES (v_batch, v_org, p_client_op_id, p_import_id, TRUE, (v_result ->> 'parts')::INT, v_uid, v_result ->> 'file_name', v_result ->> 'file_sha256', v_request,
          coalesce(ARRAY(SELECT jsonb_array_elements_text(v_result -> 'kinds')), ARRAY[]::TEXT[]), coalesce(v_result -> 'counts', '{}'::JSONB),
          coalesce(v_result -> 'errors', '[]'::JSONB), coalesce(v_result -> 'warnings', '[]'::JSONB), v_result, 'dry_run');
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.import_validate(UUID, INT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_validate(UUID, INT, UUID) TO authenticated;

-- Commits the next part of a validated large import, as one transaction (all or nothing for that part). The staged content must be
-- what was validated. A part that fails leaves nothing of itself; the parts before it stay until the import is undone (or the part is
-- tried again). The last part closes the import and removes the staged file.
CREATE OR REPLACE FUNCTION public.import_commit_part(p_import_id UUID, p_client_op_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_org     UUID := public.import_admin_org();
  v_batch   UUID := gen_random_uuid();
  v_run     public.import_runs%ROWTYPE;
  v_merged  JSONB;
  v_part    INT;
  v_payload JSONB;
  v_request TEXT;
  v_result  JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('import_company_data'), hashtext(v_org::TEXT));
  SELECT * INTO v_run FROM public.import_runs r WHERE r.organization_id = v_org AND r.import_id = p_import_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such import.' USING ERRCODE = 'P0002', HINT = 'import_not_found';
  END IF;
  -- A retry of a part that went in answers that part.
  IF p_client_op_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.import_batches b WHERE b.organization_id = v_org AND b.client_op_id = p_client_op_id
                                                 AND b.import_id = p_import_id AND b.status = 'committed') THEN
    RETURN (SELECT b.result || jsonb_build_object('replayed', TRUE) FROM public.import_batches b
            WHERE b.organization_id = v_org AND b.client_op_id = p_client_op_id);
  END IF;
  IF v_run.status NOT IN ('validated', 'committing') THEN
    RAISE EXCEPTION 'This import can''t be committed now (%).', v_run.status USING ERRCODE = '22023', HINT = 'import_not_validated';
  END IF;
  v_merged := public.import_merge_stage(v_org, p_import_id);
  IF encode(sha256(convert_to(v_merged::TEXT, 'UTF8')), 'hex') IS DISTINCT FROM v_run.merged_sha256 THEN
    RAISE EXCEPTION 'The staged file changed after it was validated: validate it again.' USING ERRCODE = '22023', HINT = 'import_changed';
  END IF;
  v_part := v_run.parts_committed + 1;
  v_payload := public.import_part_payload(v_merged, v_run.plan -> (v_part - 1));
  v_request := encode(sha256(convert_to(jsonb_build_object('commit', p_import_id, 'part', v_part, 'merged', v_run.merged_sha256)::TEXT, 'UTF8')), 'hex');
  PERFORM public.import_replay(v_org, p_client_op_id, v_request);
  BEGIN
    v_result := public.import_company_data_run(v_org, v_uid, v_batch, v_payload, 'commit', p_client_op_id, v_request, p_import_id, v_part, v_run.parts);
    IF NOT (v_result ->> 'ok')::BOOLEAN THEN
      RAISE EXCEPTION 'import part rolled back' USING ERRCODE = 'QI076';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'QI076' THEN
      NULL;
    WHEN OTHERS THEN
      v_result := public.import_failure(v_payload, 'commit', SQLSTATE, SQLERRM);
  END;
  IF (v_result ->> 'ok')::BOOLEAN THEN
    UPDATE public.import_runs r SET parts_committed = v_part, status = CASE WHEN v_part = r.parts THEN 'committed' ELSE 'committing' END,
                                    updated_at = clock_timestamp()
    WHERE r.organization_id = v_org AND r.import_id = p_import_id;
    IF v_part = v_run.parts THEN
      DELETE FROM public.import_stage s WHERE s.organization_id = v_org AND s.import_id = p_import_id;
    END IF;
  END IF;
  RETURN v_result || jsonb_build_object('replayed', FALSE, 'large', TRUE, 'import_id', p_import_id, 'part', v_part, 'parts', v_run.parts,
    'parts_committed', CASE WHEN (v_result ->> 'ok')::BOOLEAN THEN v_part ELSE v_run.parts_committed END);
END
$$;
REVOKE ALL ON FUNCTION public.import_commit_part(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_commit_part(UUID, UUID) TO authenticated;

-- Undoes one committed part (internal; called with the company's import lock held). Deletes ONLY records that part created (its
-- import_record_keys rows, and the lines created with those documents in the same transaction), and never one that was changed or
-- used after the import: a record with an audit row or a newer updated_at after the part's commit, or one any other row in the
-- database still points at (every foreign key to these tables is checked, so nothing cascades), is refused and kept, and so are the
-- lines and payments of a kept document. Returns {deleted: {table: n}, refused: [...]}.
CREATE OR REPLACE FUNCTION public.import_undo_part(p_org UUID, p_batch_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_b       public.import_batches%ROWTYPE;
  v_t       TEXT;
  v_fk      RECORD;
  v_n       INT;
  v_changed BOOLEAN;
  v_iter    INT := 0;
  v_deleted JSONB := '{}'::JSONB;
  v_refused JSONB;
  v_tables  CONSTANT TEXT[] := ARRAY['customers', 'suppliers', 'stock', 'quotes', 'quote_line_items', 'sales_orders', 'jobs', 'job_values',
                                     'purchase_orders', 'invoices', 'invoice_line_items', 'invoice_payments'];
BEGIN
  SELECT * INTO v_b FROM public.import_batches b WHERE b.id = p_batch_id AND b.organization_id = p_org AND b.status = 'committed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import undo: batch % not found', p_batch_id;
  END IF;
  DROP TABLE IF EXISTS pg_temp._undo;
  CREATE TEMP TABLE _undo (tbl TEXT NOT NULL, id UUID NOT NULL, kind TEXT NOT NULL, label TEXT, parent_tbl TEXT, parent_id UUID,
                           audit_rows INT NOT NULL, refused BOOLEAN NOT NULL DEFAULT FALSE, reason TEXT, PRIMARY KEY (tbl, id)) ON COMMIT DROP;
  -- The records this part created (by its keys), still there.
  INSERT INTO _undo (tbl, id, kind, label, audit_rows)
  SELECT CASE k.kind WHEN 'payments' THEN 'invoice_payments' ELSE k.kind END, k.record_id, k.kind,
         CASE WHEN k.kind IN ('customers', 'suppliers') THEN split_part(k.match_key, ':', 2) ELSE k.match_key END, k.audit_rows
  FROM public.import_record_keys k WHERE k.organization_id = p_org AND k.batch_id = p_batch_id;
  FOREACH v_t IN ARRAY ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'invoice_payments'] LOOP
    EXECUTE format('DELETE FROM pg_temp._undo u WHERE u.tbl = %L AND NOT EXISTS (SELECT 1 FROM public.%I t WHERE t.id = u.id AND t.organization_id = $1)', v_t, v_t)
      USING p_org;
  END LOOP;
  UPDATE _undo u SET parent_tbl = 'invoices', parent_id = p.invoice_id FROM public.invoice_payments p WHERE u.tbl = 'invoice_payments' AND p.id = u.id;
  -- Lines and job values written with their record in the same transaction.
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'quote_line_items', l.id, 'quote_lines', 'quotes', l.quote_id, 1
  FROM public.quote_line_items l JOIN _undo u ON u.tbl = 'quotes' AND u.id = l.quote_id WHERE l.created_at = v_b.txn_started_at;
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'invoice_line_items', l.id, 'invoice_lines', 'invoices', l.invoice_id, 1
  FROM public.invoice_line_items l JOIN _undo u ON u.tbl = 'invoices' AND u.id = l.invoice_id WHERE l.created_at = v_b.txn_started_at;
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'job_values', v.job_id, 'job_values', 'jobs', v.job_id, 1 FROM public.job_values v JOIN _undo u ON u.tbl = 'jobs' AND u.id = v.job_id;

  -- Lock them (fixed order): an edit still in progress finishes first and is seen below; no edit, and no new row pointing at them
  -- (a foreign key needs a share lock on its target), can start until this undo has committed.
  FOREACH v_t IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM public.%I t WHERE t.%I IN (SELECT u.id FROM pg_temp._undo u WHERE u.tbl = %L) ORDER BY t.%I FOR UPDATE OF t) z',
                   v_t, CASE v_t WHEN 'job_values' THEN 'job_id' ELSE 'id' END, v_t, CASE v_t WHEN 'job_values' THEN 'job_id' ELSE 'id' END) INTO v_n;
  END LOOP;

  -- Changed after the import: MORE audit rows about it than the import itself wrote (counted when the part committed; one for a line
  -- or a job value). The audit log is append only, so this does not depend on any clock: an edit by a transaction that began before
  -- the import committed counts like any other. A newer audit row or updated_at is also taken as a change.
  UPDATE _undo u SET refused = TRUE, reason = 'changed in Tolra after the import'
  WHERE u.tbl <> 'job_values'
    AND ((SELECT count(*) FROM security_audit.audit_log a WHERE a.organization_id = p_org AND a.entity_table = u.tbl AND a.entity_id = u.id::TEXT) > u.audit_rows
         OR EXISTS (SELECT 1 FROM security_audit.audit_log a
                    WHERE a.organization_id = p_org AND a.entity_table = u.tbl AND a.entity_id = u.id::TEXT AND a.created_at > v_b.created_at));
  UPDATE _undo u SET refused = TRUE, reason = 'changed in Tolra after the import'
  WHERE u.tbl = 'job_values'
    AND (SELECT count(*) FROM security_audit.audit_log a
         WHERE a.organization_id = p_org AND a.entity_table = 'job_values' AND (a.new_data ->> 'job_id' = u.id::TEXT OR a.old_data ->> 'job_id' = u.id::TEXT)) > u.audit_rows;
  FOREACH v_t IN ARRAY ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices'] LOOP
    EXECUTE format('UPDATE pg_temp._undo u SET refused = TRUE, reason = ''changed in Tolra after the import'' FROM public.%I t
                    WHERE u.tbl = %L AND t.id = u.id AND NOT u.refused AND t.updated_at > $1', v_t, v_t) USING v_b.created_at;
  END LOOP;

  -- Still used: a row anywhere that points at it (any foreign key) and is not itself being removed. Then the lines, payments and
  -- value of a kept record are kept too. Repeated until nothing changes.
  LOOP
    v_changed := FALSE;
    FOR v_fk IN
      SELECT cn.nspname AS child_schema, cl.relname AS child, a.attname AS col, pl.relname AS parent,
             EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.conrelid AND x.attname = 'id' AND NOT x.attisdropped) AS has_id
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace
      JOIN pg_class pl ON pl.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = pl.relnamespace AND pn.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1] AND pa.attname = 'id'
      WHERE c.contype = 'f' AND cardinality(c.conkey) = 1 AND pl.relname = ANY (v_tables)
      ORDER BY 1, 2, 3
    LOOP
      EXECUTE format('UPDATE pg_temp._undo u SET refused = TRUE, reason = %L WHERE u.tbl = %L AND NOT u.refused
                      AND EXISTS (SELECT 1 FROM %I.%I c WHERE c.%I = u.id AND %s)',
        'still used in Tolra (' || v_fk.child || ')', v_fk.parent, v_fk.child_schema, v_fk.child, v_fk.col,
        CASE WHEN v_fk.child_schema = 'public' AND v_fk.child = 'job_values'
               THEN 'NOT EXISTS (SELECT 1 FROM pg_temp._undo x WHERE x.tbl = ''job_values'' AND x.id = c.job_id AND NOT x.refused)'
             WHEN v_fk.child_schema = 'public' AND v_fk.child = ANY (v_tables) AND v_fk.has_id
               THEN format('NOT EXISTS (SELECT 1 FROM pg_temp._undo x WHERE x.tbl = %L AND x.id = c.id AND NOT x.refused)', v_fk.child)
             ELSE 'TRUE' END);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_changed := v_changed OR v_n > 0;
    END LOOP;
    UPDATE _undo c SET refused = TRUE, reason = 'kept with its ' || replace(c.parent_tbl, '_', ' ')
    FROM _undo p WHERE p.tbl = c.parent_tbl AND p.id = c.parent_id AND p.refused AND NOT c.refused;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_changed := v_changed OR v_n > 0;
    EXIT WHEN NOT v_changed;
    v_iter := v_iter + 1;
    IF v_iter > 50 THEN
      RAISE EXCEPTION 'import undo: references did not settle';
    END IF;
  END LOOP;

  -- Delete what is left, children first. The delete guards let only this company's rows go while this is set.
  PERFORM set_config('quoteflow.data_import_undo', p_org::TEXT, TRUE);
  UPDATE public.sales_orders so SET converted_to_job_id = NULL
  WHERE so.id IN (SELECT u.id FROM _undo u WHERE u.tbl = 'sales_orders' AND NOT u.refused) AND so.converted_to_job_id IS NOT NULL;
  FOREACH v_t IN ARRAY ARRAY['invoice_payments', 'invoice_line_items', 'invoices', 'purchase_orders', 'job_values', 'jobs', 'sales_orders',
                             'quote_line_items', 'quotes', 'stock', 'suppliers', 'customers'] LOOP
    EXECUTE format('DELETE FROM public.%I t WHERE t.organization_id = $1 AND t.%I IN (SELECT u.id FROM pg_temp._undo u WHERE u.tbl = %L AND NOT u.refused)',
                   v_t, CASE v_t WHEN 'job_values' THEN 'job_id' ELSE 'id' END, v_t) USING p_org;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object(v_t, v_n);
  END LOOP;
  PERFORM set_config('quoteflow.data_import_undo', '', TRUE);
  -- The keys of what is gone go too (so the same file can be imported again); a kept record keeps its key.
  DELETE FROM public.import_record_keys k
  WHERE k.organization_id = p_org AND k.batch_id = p_batch_id
    AND NOT EXISTS (SELECT 1 FROM _undo u WHERE u.id = k.record_id AND u.refused);
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', u.kind, 'id', u.id, 'ref', u.label, 'reason', u.reason) ORDER BY u.kind, u.label), '[]'::JSONB)
    INTO v_refused FROM _undo u WHERE u.refused AND u.parent_tbl IS NULL;
  RETURN jsonb_build_object('deleted', v_deleted, 'refused', v_refused,
    'refused_count', (SELECT count(*) FROM _undo u WHERE u.refused AND u.parent_tbl IS NULL),
    'kept_with_refused', (SELECT count(*) FROM _undo u WHERE u.refused AND u.parent_tbl IS NOT NULL));
END
$$;
REVOKE ALL ON FUNCTION public.import_undo_part(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Undo (or cancel) a large import, one committed part per call, last part first; the app calls again until 'undone'. Before any part
-- is committed it cancels: the staged file is removed. Each undone part is recorded as an 'undo' batch with what was deleted and what
-- was refused (kept, because it was changed or used after the import).
CREATE OR REPLACE FUNCTION public.import_undo(p_import_id UUID, p_client_op_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_org     UUID := public.import_admin_org();
  v_batch   UUID := gen_random_uuid();
  v_run     public.import_runs%ROWTYPE;
  v_part    public.import_batches%ROWTYPE;
  v_request TEXT;
  v_result  JSONB;
  v_left    INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('import_company_data'), hashtext(v_org::TEXT));
  SELECT * INTO v_run FROM public.import_runs r WHERE r.organization_id = v_org AND r.import_id = p_import_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such import.' USING ERRCODE = 'P0002', HINT = 'import_not_found';
  END IF;
  IF p_client_op_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.import_batches b WHERE b.organization_id = v_org AND b.client_op_id = p_client_op_id
                                                 AND b.import_id = p_import_id AND b.status = 'undo') THEN
    RETURN (SELECT b.result || jsonb_build_object('replayed', TRUE) FROM public.import_batches b
            WHERE b.organization_id = v_org AND b.client_op_id = p_client_op_id);
  END IF;
  IF v_run.status IN ('staging', 'validated') THEN
    DELETE FROM public.import_stage s WHERE s.organization_id = v_org AND s.import_id = p_import_id;
    UPDATE public.import_runs r SET status = 'cancelled', updated_at = clock_timestamp() WHERE r.organization_id = v_org AND r.import_id = p_import_id;
    RETURN jsonb_build_object('import_id', p_import_id, 'status', 'cancelled', 'replayed', FALSE);
  END IF;
  IF v_run.status IN ('cancelled', 'undone') THEN
    RETURN jsonb_build_object('import_id', p_import_id, 'status', v_run.status, 'replayed', FALSE);
  END IF;
  SELECT * INTO v_part FROM public.import_batches b
  WHERE b.organization_id = v_org AND b.import_id = p_import_id AND b.status = 'committed'
    AND NOT EXISTS (SELECT 1 FROM public.import_batches u WHERE u.organization_id = v_org AND u.import_id = p_import_id AND u.status = 'undo' AND u.part = b.part)
  ORDER BY b.part DESC LIMIT 1;
  IF NOT FOUND THEN
    DELETE FROM public.import_stage s WHERE s.organization_id = v_org AND s.import_id = p_import_id;
    UPDATE public.import_runs r SET status = 'undone', updated_at = clock_timestamp() WHERE r.organization_id = v_org AND r.import_id = p_import_id;
    RETURN jsonb_build_object('import_id', p_import_id, 'status', 'undone', 'refused', v_run.refused, 'replayed', FALSE);
  END IF;
  v_request := encode(sha256(convert_to(jsonb_build_object('undo', p_import_id, 'part', v_part.part)::TEXT, 'UTF8')), 'hex');
  PERFORM public.import_replay(v_org, p_client_op_id, v_request);
  v_result := public.import_undo_part(v_org, v_part.id);
  SELECT count(*) INTO v_left FROM public.import_batches b
  WHERE b.organization_id = v_org AND b.import_id = p_import_id AND b.status = 'committed' AND b.part < v_part.part
    AND NOT EXISTS (SELECT 1 FROM public.import_batches u WHERE u.organization_id = v_org AND u.import_id = p_import_id AND u.status = 'undo' AND u.part = b.part);
  v_result := v_result || jsonb_build_object('import_id', p_import_id, 'part', v_part.part, 'parts_left', v_left, 'batch_id', v_batch,
    'status', CASE WHEN v_left = 0 THEN 'undone' ELSE 'undoing' END, 'large', TRUE);
  INSERT INTO public.import_batches (id, organization_id, client_op_id, import_id, large, part, parts, created_by, file_name, file_sha256, request_sha256,
                                     kinds, counts, errors, warnings, result, status)
  VALUES (v_batch, v_org, p_client_op_id, p_import_id, TRUE, v_part.part, v_part.parts, v_uid, v_part.file_name, v_part.file_sha256, v_request,
          v_part.kinds, v_result -> 'deleted', '[]'::JSONB, v_result -> 'refused', v_result, 'undo');
  UPDATE public.import_runs r SET parts_undone = r.parts_undone + 1, refused = r.refused || (v_result -> 'refused'),
                                  status = CASE WHEN v_left = 0 THEN 'undone' ELSE 'undoing' END, updated_at = clock_timestamp()
  WHERE r.organization_id = v_org AND r.import_id = p_import_id;
  IF v_left = 0 THEN
    DELETE FROM public.import_stage s WHERE s.organization_id = v_org AND s.import_id = p_import_id;
  END IF;
  PERFORM security_audit.log_named_event(v_org, 'IMPORT_UNDONE', 'import_batches', v_part.id::TEXT,
    jsonb_build_object('import_id', p_import_id, 'part', v_part.part, 'deleted', v_result -> 'deleted', 'refused_count', v_result -> 'refused_count'));
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.import_undo(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_undo(UUID, UUID) TO authenticated;
