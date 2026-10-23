-- 085_data_import_credit_delivery.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 085: data import PR2 (Admin > Data, G23): credit notes, delivery notes, and who sent a PO or an invoice and who signed a delivery note.
-- Extends 076's engine (as 079 left it); nothing of it is duplicated. Needs 076 and 079 (import_company_data_run is 079's), 034 / 037
-- (the credit note and delivery note guards), 078 (CRD numbers) and 081 (its delivery note release gate already lets the import in).
-- Independent of 080 to 083 and of 084: it applies on 083 and changes nothing they change.
--
-- 1. PEOPLE (G23: "free text marked 'not a Tolra user', linked to a user only on one exact match; never invented"). New nullable columns:
--    invoices.sent_by_name / sent_by_user_id, purchase_orders.sent_by_name / sent_by_user_id, delivery_notes.signed_by_user_id (034's
--    signed_by_name is the text). The name is kept as written (200 characters at most); the user is set only when exactly one member
--    of the company (Tolra support excluded) has that full name, letter case and spacing aside. No user id = "not a Tolra user". Written
--    by the import only: a browser session can't set or change them (import_people_guard, 42501 hint imported_people_field); the
--    database owner and the service role are not held to it. An issued invoice keeps them frozen as before (027's lock).
-- 2. CREDIT NOTES (kind credit_notes): credit_ref (kept as written: CRD-n, CN-n or anything else, with a warning; no counter is used,
--    078's next CRD number carries on after the highest CRD or CN number when one is next issued), invoice_ref (required: a credit note
--    in Tolra always credits an invoice), customer (optional; must be the invoice's), credit_date (required), status (issued only:
--    Tolra has no void credit note and drafts are not imported), reason, net / VAT / total (as given, else from the lines) and lines
--    (034 keeps a credit note's figures equal to its lines': lines given must add up to the figures given; without lines it gets one
--    line for its whole net and VAT).
--    Linked by the invoice's number to an invoice this import creates, in the same file (in a large import the same part: the plan
--    puts every credit note with its invoice, as it does payments); an invoice already in Tolra is a problem (New credit note on it),
--    never an update of a record that is there. Written issued and applied in full (allocated_amount = total, one
--    invoice_credit_allocations row), as issue_credit_note and allocate_credit_note leave one; the invoice is written with what it is
--    credited (credited_amount) and its status settles as allocate_credit_note settles it (nothing left: paid when anything was
--    paid, else credited; 'credited' is now accepted in the file when its credit notes cover it). Problems: the invoice void,
--    cancelled or written off; another customer; its credit notes together over the invoice's total; net + VAT <> total; a number
--    already in Tolra for another invoice or total (the same one again is matched and skipped).
-- 3. DELIVERY NOTES (kind delivery_notes): dn_number, customer and delivery_date required; job_no, so_number, invoice_ref, ship date and
--    via, status (pending, awaiting, despatched (sent out), delivered, signed: default signed when Signed by is given, else despatched),
--    notes, signed_by / signed_at / signature_notes, lines (description, quantity). Linked, each only on exactly one match, to its
--    customer (normalised name), job (number + customer; an internal job is a problem: 042 never despatches one), sales order
--    (number + customer, only the one its job was made from) and invoice (number + customer); another customer's job, order or
--    invoice is never linked: a link not made is a warning and the text is kept. No draft
--    invoice is made (059's trigger fires on a status change only) and no release is asked for (081's gate lets the import in). DLN
--    numbering carries on after the highest DLN-n (076 already reseeds DLN).
-- 4. THE GUARDS an import or its undo passes, as 076 did for six others: credit_note_issue_lock, credit_note_lines_issue_lock (034),
--    delivery_notes_link_guard (037), delivery_note_items_link_guard (034): each body exactly as before plus ONE block: an INSERT
--    passes while quoteflow.data_import equals the row's company, a DELETE while quoteflow.data_import_undo does. Only the import (and
--    its undo) sets them, for the session's company, around its own statements, and clears them straight after; a client can't set a
--    setting through the API. Everything else in those guards, and every other guard, is unchanged.
-- 5. THE ENGINE (all internal, as before): import_company_data_run is 079's body plus the two kinds and the people fields (079's
--    WHERE TRUE kept: every UPDATE and DELETE has its own WHERE, safe under pg-safeupdate); import_check_payload, import_merge_stage,
--    import_plan and import_part_payload know the two sections; import_undo_part also removes a part's credit notes (with their lines
--    and allocation, kept with their invoice when it is kept) and delivery notes (with their items), refusing, as before, any record
--    changed or used after the import. The record keys and saved mappings accept the two kinds. The five API entry points
--    (import_company_data, import_stage_part, import_validate, import_commit_part, import_undo) are unchanged.
--
-- Additive: no table; five nullable columns; one internal trigger function on three tables; ten functions replaced (md5-guarded:
-- each must be its 034 / 037 / 076 / 079 body or already 085's, else nothing of 085 is kept). No policy or grant for an API role
-- changes. Safe to run more than once. SELF-CHECK before COMMIT (section 7). Rollback: supabase/release/085_data_import_credit_delivery.rollback.sql
-- (docs/RELEASE.md "085"; stops while any imported credit note or delivery note key, mapping or person field exists).
-- =====================================================================================================
-- 1. The guard: every function 085 replaces is the body it extends (or already 085's); anything else stops the release, nothing kept.
DO $$
DECLARE
  r RECORD;
  v_md5 TEXT;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('credit_note_issue_lock', 'fb8e80d48fc099c48df1e783baf29fc1', '8e0ff460c60a94bb1164dc39dd77aae1'),
    ('credit_note_lines_issue_lock', 'd044647b5c7768cea71ed0a869b29428', '369bbaa5c6979d4bb9d70c5cbf68d9bd'),
    ('delivery_notes_link_guard', 'd785f434d829cb12f0f3eccbd8c73908', '4c57607b1909f060d689df9ea5a99128'),
    ('delivery_note_items_link_guard', '699da71eb0c6c42410f94ca1e2ccb023', '612a2bc924a8ea1916ce1a66101ced97'),
    ('import_check_payload', '24dfe4ba953c462ccdf0fe83c41b064d', '7c041eb39e57ee9504308162bc3217c9'),
    ('import_merge_stage', '080be44b691830f8b5898e1ba2cc470a', 'b24dbc8ae80269fca5d93345a1d3f50a'),
    ('import_plan', 'a01903b90106d900cbdd6a5428411ef1', 'ba1637348e59883e1473ee4645875c12'),
    ('import_part_payload', '08847bc25a95d21765fe9f5af0c4684f', 'bcd8bc328cde95cceafefe0ca1b0990b'),
    ('import_company_data_run', 'f7c672e961be898619c046d76458680e', '0a2fec5746b0b1262cb2af6fe792bd7c'),
    ('import_undo_part', '2a1f18cca913a8e2eb21ec7970285748', '177d5c7273b79670dd0c3f130b215652')) v(name, before_085, after_085)
  LOOP
    SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name;
    IF v_md5 IS NULL OR v_md5 NOT IN (r.before_085, r.after_085) THEN
      RAISE EXCEPTION '085: public.% is not the body 085 extends (md5 without whitespace %); stop and compare it first', r.name, coalesce(v_md5, 'missing');
    END IF;
  END LOOP;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_people_guard()');
  IF v_md5 IS NOT NULL AND v_md5 <> '513ca1c3542ad19388992a58a8b78cdb' THEN
    RAISE EXCEPTION '085: public.import_people_guard exists and is not 085''s (md5 %)', v_md5;
  END IF;
END
$$;

-- 2. Who sent a PO or an invoice, who signed a delivery note (section 1 above). Nullable, so no existing row changes.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS sent_by_name TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS sent_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS sent_by_name TEXT;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS sent_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS signed_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_sent_by_name_length;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_sent_by_name_length CHECK (sent_by_name IS NULL OR length(sent_by_name) BETWEEN 1 AND 200);
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_sent_by_name_length;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_sent_by_name_length CHECK (sent_by_name IS NULL OR length(sent_by_name) BETWEEN 1 AND 200);

-- 3. The record keys and saved mappings take the two new kinds (076's lists plus credit_notes and delivery_notes).
ALTER TABLE public.import_mappings DROP CONSTRAINT IF EXISTS import_mappings_kind_check;
ALTER TABLE public.import_mappings ADD CONSTRAINT import_mappings_kind_check CHECK (kind IN ('customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs',
  'purchase_orders', 'invoices', 'payments', 'credit_notes', 'delivery_notes'));
ALTER TABLE public.import_record_keys DROP CONSTRAINT IF EXISTS import_record_keys_kind_check;
ALTER TABLE public.import_record_keys ADD CONSTRAINT import_record_keys_kind_check CHECK (kind IN ('customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs',
  'purchase_orders', 'invoices', 'payments', 'credit_notes', 'delivery_notes'));

-- 4. The people columns are written by the import only (section 1). Internal trigger function; one trigger per table.
CREATE OR REPLACE FUNCTION public.import_people_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_col TEXT;
BEGIN
  -- The browser roles only; the import itself (for the company it holds it for), the database owner and the service role write them.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated')
     OR current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT THEN
    RETURN NEW;
  END IF;
  FOREACH v_col IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(NEW) -> v_col) IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) -> v_col ELSE 'null'::JSONB END) THEN
      RAISE EXCEPTION 'Who sent or signed an imported document is set by the data import only.' USING ERRCODE = '42501', HINT = 'imported_people_field';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.import_people_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS import_people_guard ON public.invoices;
CREATE TRIGGER import_people_guard BEFORE INSERT OR UPDATE OF sent_by_name, sent_by_user_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.import_people_guard('sent_by_name', 'sent_by_user_id');
DROP TRIGGER IF EXISTS import_people_guard ON public.purchase_orders;
CREATE TRIGGER import_people_guard BEFORE INSERT OR UPDATE OF sent_by_name, sent_by_user_id ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.import_people_guard('sent_by_name', 'sent_by_user_id');
DROP TRIGGER IF EXISTS import_people_guard ON public.delivery_notes;
CREATE TRIGGER import_people_guard BEFORE INSERT OR UPDATE OF signed_by_user_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.import_people_guard('signed_by_user_id');
-- -----------------------------------------------------------------------------------------------------
-- 5. The four guards an import or its undo passes: each body exactly as before (034 / 037) plus the one 085 block (section 4 above).
-- 034's credit_note_issue_lock, plus the 085 block.
CREATE OR REPLACE FUNCTION public.credit_note_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_open CONSTANT TEXT[] := ARRAY['updated_at', 'updated_by'];
  v_draft_editable CONSTANT TEXT[] := ARRAY['reason', 'credit_date', 'updated_at', 'updated_by'];
  v_via_issue BOOLEAN;
  v_via_allocation BOOLEAN;
BEGIN
  -- Only the browser roles are held to this; the importer, the database owner and the service role write finished records.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- 085: the data import's own writes for the company it holds them for (an insert while quoteflow.data_import, a delete while
  -- quoteflow.data_import_undo; each set by the import alone, around its own statements, and cleared after).
  IF (TG_OP = 'INSERT' AND current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT)
     OR (TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.credit_ref IS NOT NULL OR NEW.allocated_amount <> 0 OR NEW.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new credit note is saved as a draft and then issued.' USING ERRCODE = '42501';
    END IF;
    -- The header's amounts come from the lines and the invoice: only create_credit_note writes one.
    IF current_setting('quoteflow.credit_lines', TRUE) IS DISTINCT FROM NEW.id::TEXT THEN
      RAISE EXCEPTION 'A credit note is made with New credit note, from the invoice''s lines.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  v_via_issue := current_setting('quoteflow.credit_note', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  v_via_allocation := current_setting('quoteflow.credit_allocation', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF OLD.status = 'draft' THEN
    IF TG_OP = 'UPDATE' AND NOT v_via_issue THEN
      IF NEW.status <> 'draft' OR NEW.credit_ref IS NOT NULL OR NEW.issued_at IS NOT NULL OR NEW.allocated_amount <> 0 THEN
        RAISE EXCEPTION 'A credit note is issued with Issue credit note.' USING ERRCODE = '42501';
      END IF;
      IF (to_jsonb(NEW) - v_draft_editable) IS DISTINCT FROM (to_jsonb(OLD) - v_draft_editable) THEN
        RAISE EXCEPTION 'The invoice, customer and amounts of a credit note come from its lines and can''t be edited: delete the draft and make it again.' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit note % has been issued, so it can''t be deleted.', OLD.credit_ref USING ERRCODE = '42501';
  END IF;
  IF NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount AND NOT v_via_allocation THEN
    RAISE EXCEPTION 'Credit note %: a credit is applied to its invoice with Apply credit.', OLD.credit_ref USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_open - 'allocated_amount') IS DISTINCT FROM (to_jsonb(OLD) - v_open - 'allocated_amount') THEN
    RAISE EXCEPTION 'Credit note % has been issued: it can''t be changed.', OLD.credit_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- 034's credit_note_lines_issue_lock, plus the 085 block.
CREATE OR REPLACE FUNCTION public.credit_note_lines_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old UUID := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.credit_note_id END;
  v_new UUID := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.credit_note_id END;
BEGIN
  -- 085: the data import's own writes for the company it holds them for (an insert while quoteflow.data_import, a delete while
  -- quoteflow.data_import_undo; each set by the import alone, around its own statements, and cleared after).
  IF (TG_OP = 'INSERT' AND current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT)
     OR (TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IN ('anon', 'authenticated') THEN
    -- Both the credit note a line is leaving and the one it is moving to count: a line can't be moved out of, or into, an issued one.
    IF EXISTS (SELECT 1 FROM public.credit_notes c WHERE c.id IN (v_old, v_new) AND c.status <> 'draft') THEN
      RAISE EXCEPTION 'That credit note has been issued, so its lines can''t be changed.' USING ERRCODE = '42501';
    END IF;
    -- Lines are written by create_credit_note only (which checks them against the invoice); a draft that is wrong is deleted and made
    -- again. Deleting the draft itself removes its lines (the parent is already gone when the cascade reaches them).
    IF current_setting('quoteflow.credit_lines', TRUE) IS DISTINCT FROM coalesce(v_new, v_old)::TEXT
       AND NOT (TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.credit_notes c WHERE c.id = v_old)) THEN
      RAISE EXCEPTION 'The lines of a credit note are set when it is made, from the invoice''s lines.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- 037's delivery_notes_link_guard, plus the 085 block.
CREATE OR REPLACE FUNCTION public.delivery_notes_link_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_via      BOOLEAN;
  v_order    TEXT[] := ARRAY['pending', 'awaiting', 'despatched', 'delivered', 'signed'];
  v_old_rank INT;
  v_new_rank INT;
  v_free     TEXT[];
  v_job_no   TEXT;
  v_found    BOOLEAN := FALSE;
  v_job_id   UUID;
  v_job_so   UUID;
  v_state    RECORD;
  v_over     TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- 085: the data import's own writes for the company it holds them for (an insert while quoteflow.data_import, a delete while
  -- quoteflow.data_import_undo; each set by the import alone, around its own statements, and cleared after).
  IF (TG_OP = 'INSERT' AND current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT)
     OR (TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_via := current_setting('quoteflow.delivery_note_invoice', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('despatched', 'delivered', 'signed') THEN
      RAISE EXCEPTION 'Delivery note % has been sent out, so it can''t be deleted.', OLD.dn_number USING ERRCODE = '42501';
    END IF;
    IF OLD.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = OLD.invoice_id AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')) THEN
      RAISE EXCEPTION 'Delivery note % has been invoiced, so it can''t be deleted.', OLD.dn_number USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.invoice_id IS NOT NULL OR (NEW.job_id IS NOT NULL AND current_setting('quoteflow.delivery_note_new', TRUE) IS DISTINCT FROM 'on') THEN
      RAISE EXCEPTION 'A delivery note is linked to an order, a job or an invoice by the functions that make it.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id AND NOT v_via
     AND NOT (NEW.invoice_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = OLD.invoice_id)) THEN
    RAISE EXCEPTION 'A delivery note is linked to its invoice when the invoice is made from it.' USING ERRCODE = '42501';
  END IF;
  IF (NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id OR NEW.job_id IS DISTINCT FROM OLD.job_id)
     AND EXISTS (SELECT 1 FROM public.delivery_note_items i WHERE i.delivery_note_id = OLD.id AND i.sales_order_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A delivery note made from an order keeps its order and job.' USING ERRCODE = '42501';
  END IF;

  v_old_rank := coalesce(array_position(v_order, OLD.status), 0);
  v_new_rank := coalesce(array_position(v_order, NEW.status), 0);
  -- Once sent out, a note only moves forward (sent, delivered, signed); the signature and the e-mail record are the only things that
  -- can still be written, and a signed note keeps its signature. Everything else on it, and its items, is frozen.
  IF v_old_rank >= 3 THEN
    IF v_new_rank < v_old_rank THEN
      RAISE EXCEPTION 'Delivery note % has been sent out, so its status can only move forward.', OLD.dn_number USING ERRCODE = '42501';
    END IF;
    v_free := CASE WHEN OLD.status = 'signed' THEN ARRAY['emailed_at', 'updated_at', 'updated_by', 'invoice_id']
                   ELSE ARRAY['status', 'signed_by_name', 'signed_at', 'signature_notes', 'emailed_at', 'updated_at', 'updated_by', 'invoice_id'] END;
    IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
      RAISE EXCEPTION 'Delivery note % has been sent out, so it can''t be changed (only its signature and e-mail record can).', OLD.dn_number USING ERRCODE = '42501';
    END IF;
  ELSIF v_new_rank >= 3 THEN
    -- Going out: the job's release is checked again now, with the job row locked, so a release withdrawn after the note was made
    -- (a drawing revised, a result changed) stops it here. A note with no job, or whose job number matches none, is not held.
    -- Per order line (037): the job row is locked FOR UPDATE, as a failure locks it, and what may go out is read under that lock.
    IF NEW.job_id IS NOT NULL THEN
      SELECT j.id, j.job_no, j.converted_from_sales_order_id, TRUE INTO v_job_id, v_job_no, v_job_so, v_found FROM public.jobs j WHERE j.id = NEW.job_id AND j.organization_id = NEW.organization_id FOR UPDATE;
    ELSIF nullif(btrim(NEW.job_ref), '') IS NOT NULL THEN
      SELECT j.id, j.job_no, j.converted_from_sales_order_id, TRUE INTO v_job_id, v_job_no, v_job_so, v_found FROM public.jobs j WHERE j.job_no = btrim(NEW.job_ref) AND j.organization_id = NEW.organization_id ORDER BY j.created_at LIMIT 1 FOR UPDATE;
    END IF;
    IF coalesce(v_found, FALSE) THEN
      SELECT * INTO v_state FROM public.job_release_state(v_job_id);
      IF NOT v_state.released THEN
        RAISE EXCEPTION '% hasn''t passed inspection (or its release was withdrawn), so delivery note % can''t be sent out.', v_job_no, OLD.dn_number USING ERRCODE = '22023';
      END IF;
      -- Fail closed: what is held can't be weighed, so nothing of the job goes out.
      IF v_state.blocked IS NOT NULL THEN
        RAISE EXCEPTION '% Delivery note % can''t be sent out until then.', v_state.blocked, OLD.dn_number USING ERRCODE = '22023';
      END IF;
      IF v_state.holding THEN
        -- Part of the job is held: an item not made from the job's own order can't be weighed against it, so such a note waits.
        IF EXISTS (SELECT 1 FROM public.delivery_note_items i WHERE i.delivery_note_id = OLD.id
                     AND (i.sales_order_line_id IS NULL OR v_job_so IS NULL
                          OR NOT EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.id = i.sales_order_line_id AND l.sales_order_id = v_job_so))) THEN
          RAISE EXCEPTION 'Part of % is held in rework or waiting for replacements, so delivery note % can''t be sent out: make the note from the sales order, which counts what may go.', v_job_no, OLD.dn_number USING ERRCODE = '22023';
        END IF;
        -- What has gone out on each order line (other notes already sent) plus this note must fit what that line has available.
        SELECT string_agg(left(r.description, 60), ', ') INTO v_over
        FROM public.delivery_note_items i
        JOIN public.job_line_release(v_job_id) r ON r.line_id = i.sales_order_line_id
        WHERE i.delivery_note_id = OLD.id
          AND i.quantity + coalesce((SELECT sum(o.quantity) FROM public.delivery_note_items o JOIN public.delivery_notes d ON d.id = o.delivery_note_id
                                     WHERE o.sales_order_line_id = i.sales_order_line_id AND d.id <> OLD.id AND d.status IN ('despatched', 'delivered', 'signed')), 0)
              > r.available;
        IF v_over IS NOT NULL THEN
          RAISE EXCEPTION 'Part of % is held in rework or waiting for replacements, so delivery note % can''t be sent out with this much of: %.', v_job_no, OLD.dn_number, v_over USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 034's delivery_note_items_link_guard, plus the 085 block.
CREATE OR REPLACE FUNCTION public.delivery_note_items_link_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_via BOOLEAN;
  v_dn  UUID;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- 085: the data import's own writes for the company it holds them for (an insert while quoteflow.data_import, a delete while
  -- quoteflow.data_import_undo; each set by the import alone, around its own statements, and cleared after).
  IF (TG_OP = 'INSERT' AND current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT)
     OR (TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_dn := CASE WHEN TG_OP = 'DELETE' THEN OLD.delivery_note_id ELSE NEW.delivery_note_id END;
  v_via := current_setting('quoteflow.delivery_note', TRUE) IS NOT DISTINCT FROM v_dn::TEXT;
  -- A note that has been sent out, delivered or signed is a record of what went: its items are frozen.
  IF EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.id = v_dn AND d.status IN ('despatched', 'delivered', 'signed'))
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.id = OLD.delivery_note_id AND d.status IN ('despatched', 'delivered', 'signed'))) THEN
    RAISE EXCEPTION 'This delivery note has been sent out, so its items can''t be changed.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.sales_order_line_id IS NOT NULL AND NOT v_via THEN
    RAISE EXCEPTION 'Items are linked to an order line by making the delivery note from the sales order.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.sales_order_line_id IS NOT NULL OR NEW.sales_order_line_id IS NOT NULL)
     AND (NEW.sales_order_line_id IS DISTINCT FROM OLD.sales_order_line_id OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.delivery_note_id IS DISTINCT FROM OLD.delivery_note_id) THEN
    RAISE EXCEPTION 'The quantity despatched on a delivery note made from an order can''t be changed: delete the note and make it again.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
       SELECT 1 FROM public.delivery_notes d JOIN public.invoices i ON i.id = d.invoice_id
       WHERE d.id = OLD.delivery_note_id AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')) THEN
    RAISE EXCEPTION 'This delivery note has been invoiced, so its items can''t be changed.' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 6. The engine: 076's helpers knowing the two sections, 079's import_company_data_run with the two kinds and the people fields,
-- 076's import_undo_part removing them too. Same signatures, LANGUAGE, search_path, not SECURITY DEFINER, internal (REVOKEs repeated).
-- 076's import_check_payload, extended by 085.
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
  WHERE k NOT IN ('file_name', 'file_sha256', 'customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments',
                  'credit_notes', 'delivery_notes');
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
        UNION ALL SELECT jsonb_array_elements(p_payload -> 'invoices') WHERE jsonb_typeof(p_payload -> 'invoices') = 'array'
        UNION ALL SELECT jsonb_array_elements(p_payload -> 'credit_notes') WHERE jsonb_typeof(p_payload -> 'credit_notes') = 'array'
        UNION ALL SELECT jsonb_array_elements(p_payload -> 'delivery_notes') WHERE jsonb_typeof(p_payload -> 'delivery_notes') = 'array') d;
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

-- 076's import_merge_stage, extended by 085.
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
                       CROSS JOIN LATERAL unnest(ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments',
                                                       'credit_notes', 'delivery_notes']) k(k)
                       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.payload -> k.k) = 'array' THEN s.payload -> k.k ELSE '[]'::JSONB END)
                                          WITH ORDINALITY e(v, ord)
                       WHERE s.organization_id = p_org AND s.import_id = p_import_id) y
                 GROUP BY y.k) x), '{}'::JSONB)
$$;
REVOKE ALL ON FUNCTION public.import_merge_stage(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- 076's import_plan, extended by 085.
CREATE OR REPLACE FUNCTION public.import_plan(p_merged JSONB, p_weight INT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH items AS (
    SELECT g.grp, g.korder, g.k, e.ord,
           CASE WHEN g.k IN ('quotes', 'invoices', 'delivery_notes')
                THEN (CASE g.k WHEN 'invoices' THEN 2 ELSE 1 END)
                     + CASE WHEN jsonb_typeof(e.v -> 'lines') = 'array' THEN jsonb_array_length(e.v -> 'lines') ELSE 0 END
                     -- 085: an invoice's credit notes go in with it (import_part_payload), so they weigh with it: each 1, and 1 a line.
                     + CASE WHEN g.k = 'invoices' AND jsonb_typeof(p_merged -> 'credit_notes') = 'array'
                            THEN coalesce((SELECT sum(1 + CASE WHEN jsonb_typeof(c.v -> 'lines') = 'array' THEN jsonb_array_length(c.v -> 'lines') ELSE 0 END)
                                           FROM jsonb_array_elements(p_merged -> 'credit_notes') c(v)
                                           WHERE public.import_clean_text(c.v ->> 'invoice_ref') = public.import_clean_text(e.v ->> 'invoice_ref')), 0)::INT
                            ELSE 0 END
                ELSE 1 END AS w
    FROM (VALUES (1, 1, 'customers'), (1, 2, 'suppliers'), (1, 3, 'stock'), (2, 1, 'quotes'),
                 (3, 1, 'sales_orders'), (3, 2, 'jobs'), (3, 3, 'purchase_orders'), (4, 1, 'invoices'),
                 (5, 1, 'delivery_notes')) g(grp, korder, k)
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

-- 076's import_part_payload, extended by 085.
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
         -- 085: and every credit note for those invoices (a credit note is written with its invoice, which is written once with what
         -- it credits).
         || CASE WHEN p_slices ? 'invoices' THEN jsonb_build_object('credit_notes', (
              SELECT coalesce(jsonb_agg(c.v ORDER BY c.ord), '[]'::JSONB)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_merged -> 'credit_notes') = 'array' THEN p_merged -> 'credit_notes' ELSE '[]'::JSONB END)
                   WITH ORDINALITY c(v, ord)
              WHERE public.import_clean_text(c.v ->> 'invoice_ref') IN (
                SELECT public.import_clean_text(i.v ->> 'invoice_ref') FROM jsonb_array_elements(p_merged -> 'invoices') WITH ORDINALITY i(v, ord)
                WHERE i.ord BETWEEN (p_slices -> 'invoices' ->> 0)::INT AND (p_slices -> 'invoices' ->> 1)::INT)))
            ELSE '{}'::JSONB END
$$;
REVOKE ALL ON FUNCTION public.import_part_payload(JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- 079's import_company_data_run, extended by 085.
CREATE OR REPLACE FUNCTION public.import_company_data_run(p_org UUID, p_uid UUID, p_batch UUID, p_payload JSONB, p_mode TEXT,
                                                         p_client_op_id UUID, p_request TEXT, p_import_id UUID, p_part INT, p_parts INT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kinds CONSTANT TEXT[] := ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments',
                                   'credit_notes', 'delivery_notes'];
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
  v_cl       INT := 0;
  v_dl       INT := 0;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('validate', 'dry_run', 'commit') THEN
    RAISE EXCEPTION 'import: unknown mode %', p_mode;
  END IF;
  DROP TABLE IF EXISTS pg_temp._imp_err, pg_temp._imp_warn, pg_temp._imp_parties, pg_temp._imp_stock, pg_temp._imp_quotes,
    pg_temp._imp_quote_lines, pg_temp._imp_sales_orders, pg_temp._imp_jobs, pg_temp._imp_purchase_orders, pg_temp._imp_invoices,
    pg_temp._imp_invoice_lines, pg_temp._imp_payments, pg_temp._imp_names;
  DROP TABLE IF EXISTS pg_temp._imp_people, pg_temp._imp_credit_notes, pg_temp._imp_credit_lines, pg_temp._imp_delivery_notes, pg_temp._imp_delivery_items;
  CREATE TEMP TABLE _imp_err (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, ord INT, row_no INT, field TEXT, message TEXT) ON COMMIT DROP;
  CREATE TEMP TABLE _imp_warn (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, row_no INT, field TEXT, message TEXT) ON COMMIT DROP;
  -- 085: the company's people by full name (letter case and spacing aside; Tolra support excluded). A name given for "sent by" or
  -- "signed by" is kept as text, "not a Tolra user", and linked to a user only when exactly one of them has that name: never guessed.
  CREATE TEMP TABLE _imp_people ON COMMIT DROP AS
  SELECT lower(regexp_replace(btrim(up.full_name), '\s+', ' ', 'g')) AS nn, count(DISTINCT up.id)::INT AS n, (array_agg(up.id ORDER BY up.id))[1] AS id
  FROM public.organization_members m JOIN public.user_profiles up ON up.id = m.user_id
  WHERE m.organization_id = p_org AND NOT m.support AND nullif(btrim(up.full_name), '') IS NOT NULL
  GROUP BY 1;

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
         x.po_ref AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id, NULL::UUID AS sent_by_user_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'po_ref') AS po_ref, (cr.c ->> 'supplier') AS supplier,
               (cr.c ->> 'order_date') AS order_date_raw, (cr.c ->> 'expected_delivery') AS expected_raw,
               (cr.c ->> 'total_value') AS total_raw, (cr.c ->> 'status') AS status_raw,
               (cr.c ->> 'notes') AS notes, (cr.c ->> 'vat_enabled') AS vat_enabled_raw, (cr.c ->> 'sent_by') AS sent_by
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
    ('sent_by', CASE WHEN length(c.sent_by) > 200 THEN 'Sent by is longer than 200 characters.' END),
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
         NULL::TEXT AS status, FALSE AS payment_unverified, NULL::UUID AS job_id, 0::NUMERIC AS credited, NULL::UUID AS sent_by_user_id,
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
               (cr.c ->> 'job_no') AS job_no, (cr.c ->> 'description') AS description, (cr.c ->> 'sent_by') AS sent_by
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

  -- ===== Credit notes and their lines (085) =======================================================================================
  -- A credit note credits an invoice this import creates (in this file, or this part of a large one), found by its number. It goes in
  -- issued and applied in full to that invoice, as issue_credit_note and allocate_credit_note leave one: the invoice settles by what it
  -- owed and anything beyond that is the customer's credit. Its number is kept as written and uses no counter (078: the next CRD number
  -- carries on after the highest CRD-n or CN-n the company has, read when it is issued).
  CREATE TEMP TABLE _imp_credit_notes ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.credit_date_raw) AS credit_date,
         public.import_num(x.subtotal_raw) AS subtotal_given, public.import_num(x.vat_raw) AS vat_given, public.import_num(x.total_raw) AS total_given,
         public.import_bool(x.vat_enabled_raw) AS vat_enabled_given,
         lower(regexp_replace(coalesce(x.status_raw, 'issued'), '[ -]+', '_', 'g')) AS status,
         NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat, NULL::NUMERIC AS total, NULL::BOOLEAN AS vat_enabled,
         x.credit_ref AS match_key, NULL::UUID AS existing_id, NULL::UUID AS invoice_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord, e.v,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'credit_ref') AS credit_ref, (cr.c ->> 'invoice_ref') AS invoice_ref,
               (cr.c ->> 'customer') AS customer, (cr.c ->> 'credit_date') AS credit_date_raw,
               (cr.c ->> 'status') AS status_raw, (cr.c ->> 'reason') AS reason,
               (cr.c ->> 'subtotal') AS subtotal_raw, (cr.c ->> 'vat') AS vat_raw, (cr.c ->> 'total') AS total_raw,
               (cr.c ->> 'vat_enabled') AS vat_enabled_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'credit_notes', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  CREATE TEMP TABLE _imp_credit_lines ON COMMIT DROP AS
  SELECT x.*, public.import_num(x.quantity_raw) AS quantity, public.import_num(x.unit_price_raw) AS unit_price,
         public.import_num(x.vat_pct_raw) AS vat_pct, public.import_bool(x.vat_exempt_raw) AS vat_exempt
  FROM (SELECT c.ord AS c_ord, c.row_no AS c_row, l.pos::INT AS pos, jsonb_typeof(l.v) = 'object' AS obj,
               (cl.c ->> 'description') AS description,
               coalesce((cl.c ->> 'quantity'), '1') AS quantity_raw,
               coalesce((cl.c ->> 'unit_price'), '0') AS unit_price_raw,
               coalesce((cl.c ->> 'vat_pct'), '20') AS vat_pct_raw,
               coalesce((cl.c ->> 'vat_exempt'), 'false') AS vat_exempt_raw
        FROM _imp_credit_notes c
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.v -> 'lines') = 'array' THEN c.v -> 'lines' ELSE '[]'::JSONB END) WITH ORDINALITY l(v, pos)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(l.v) AS c OFFSET 0) cl) x;
  CREATE INDEX ON _imp_credit_lines (c_ord);
  ANALYZE _imp_credit_notes;
  ANALYZE _imp_credit_lines;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'credit_notes', l.c_ord, l.c_row, 'lines[' || l.pos || '].' || f.field, f.message
  FROM _imp_credit_lines l
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT l.obj THEN 'Not a line.' END),
    ('description', CASE WHEN l.obj AND l.description IS NULL THEN 'Line description is required.' WHEN length(l.description) > 500 THEN 'Line description is longer than 500 characters.' END),
    ('quantity', CASE WHEN l.quantity IS NULL OR l.quantity <= 0 OR l.quantity <> round(l.quantity, 3) THEN 'Quantity must be more than 0 (at most 3 decimals).' END),
    ('unit_price', CASE WHEN l.unit_price IS NULL OR l.unit_price < 0 OR l.unit_price <> round(l.unit_price, 2) THEN 'Unit price must be an amount of 0 or more (pounds and pence).' END),
    ('vat_pct', CASE WHEN l.vat_pct IS NULL OR l.vat_pct < 0 OR l.vat_pct > 100 OR l.vat_pct <> round(l.vat_pct, 2) THEN 'VAT % must be between 0 and 100.' END),
    ('vat_exempt', CASE WHEN l.vat_exempt IS NULL THEN 'VAT exempt must be yes or no.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  -- VAT as the credit note says, else as its invoice (in this file, else in Tolra) charges it.
  UPDATE _imp_credit_notes c SET vat_enabled = coalesce(c.vat_enabled_given,
      (SELECT i.vat_enabled FROM _imp_invoices i WHERE i.invoice_ref = c.invoice_ref ORDER BY i.ord LIMIT 1),
      (SELECT x.vat_enabled FROM public.invoices x WHERE x.organization_id = p_org AND x.invoice_ref = c.invoice_ref ORDER BY x.created_at LIMIT 1), TRUE)
  WHERE TRUE;
  -- Totals as for invoices: as given (VAT 0 and net = total when only the total is given), else from the lines.
  UPDATE _imp_credit_notes c SET
    total = CASE WHEN c.subtotal_given IS NULL AND c.vat_given IS NULL AND c.total_given IS NULL THEN s.net + s.tax ELSE c.total_given END,
    vat = CASE WHEN c.subtotal_given IS NULL AND c.vat_given IS NULL AND c.total_given IS NULL THEN s.tax
               ELSE coalesce(c.vat_given, c.total_given - c.subtotal_given, 0) END,
    subtotal = CASE WHEN c.subtotal_given IS NULL AND c.vat_given IS NULL AND c.total_given IS NULL THEN s.net
                    ELSE coalesce(c.subtotal_given, c.total_given - coalesce(c.vat_given, 0)) END
  FROM (SELECT c2.ord, sum(round(l.quantity * l.unit_price, 2)) AS net,
               CASE WHEN c2.vat_enabled THEN sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END) ELSE 0 END AS tax
        FROM _imp_credit_notes c2 LEFT JOIN _imp_credit_lines l ON l.c_ord = c2.ord AND l.quantity IS NOT NULL AND l.unit_price IS NOT NULL AND l.vat_pct IS NOT NULL AND l.vat_exempt IS NOT NULL
        GROUP BY c2.ord, c2.vat_enabled) s
  WHERE s.ord = c.ord;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'credit_notes', c.ord, c.row_no, f.field, f.message
  FROM _imp_credit_notes c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('credit_ref', CASE WHEN c.obj AND c.credit_ref IS NULL THEN 'Credit note number is required.' WHEN length(c.credit_ref) > 60 THEN 'Credit note number is longer than 60 characters.' END),
    ('invoice_ref', CASE WHEN c.obj AND c.invoice_ref IS NULL THEN 'Invoice number is required: a credit note in Tolra always credits an invoice.'
                         WHEN length(c.invoice_ref) > 60 THEN 'Invoice number is longer than 60 characters.' END),
    ('customer', CASE WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('credit_date', CASE WHEN c.obj AND c.credit_date_raw IS NULL THEN 'Credit note date is required.'
                         WHEN c.credit_date_raw IS NOT NULL AND c.credit_date IS NULL THEN 'Credit note date must be a real date written YYYY-MM-DD.' END),
    ('status', CASE WHEN c.status NOT IN ('issued', 'sent', 'applied')
                    THEN 'Status must be issued: a draft credit note is not imported, and Tolra has no void credit note (leave it out of the file).' END),
    ('reason', CASE WHEN length(c.reason) > 500 THEN 'Reason is longer than 500 characters.' END),
    ('subtotal', CASE WHEN c.subtotal_raw IS NOT NULL AND (c.subtotal_given IS NULL OR c.subtotal_given < 0 OR c.subtotal_given <> round(c.subtotal_given, 2))
                      THEN 'Net must be an amount of 0 or more (pounds and pence).' END),
    ('vat', CASE WHEN c.vat_raw IS NOT NULL AND (c.vat_given IS NULL OR c.vat_given < 0 OR c.vat_given <> round(c.vat_given, 2))
                 THEN 'VAT must be an amount of 0 or more (pounds and pence).' END),
    ('total', CASE WHEN c.total_raw IS NOT NULL AND (c.total_given IS NULL OR c.total_given < 0 OR c.total_given <> round(c.total_given, 2))
                     THEN 'Total must be an amount of 0 or more (pounds and pence).'
                   WHEN c.obj AND c.total_raw IS NULL AND (c.subtotal_raw IS NOT NULL OR c.vat_raw IS NOT NULL) THEN 'Total is required with net or VAT.'
                   WHEN c.obj AND c.total_raw IS NULL AND c.subtotal_raw IS NULL AND c.vat_raw IS NULL
                        AND NOT EXISTS (SELECT 1 FROM _imp_credit_lines l WHERE l.c_ord = c.ord) THEN 'Total is required (or give the lines).'
                   WHEN c.total IS NOT NULL AND (c.subtotal < 0 OR c.vat < 0 OR c.subtotal + c.vat <> c.total) THEN 'Net + VAT must equal the total.'
                   WHEN c.total IS NOT NULL AND c.total <= 0 THEN 'A credit note must credit more than 0.'
                   WHEN c.vat > 0 AND NOT c.vat_enabled THEN 'VAT is given, but this credit note charges no VAT (nor does its invoice).'
                   WHEN c.vat > 0 AND c.subtotal = 0 THEN 'A credit note with VAT needs its net amount.' END),
    ('vat_enabled', CASE WHEN c.vat_enabled_raw IS NOT NULL AND c.vat_enabled_given IS NULL THEN 'VAT must be yes or no.' END),
    ('lines', CASE WHEN c.obj AND c.v ? 'lines' AND jsonb_typeof(c.v -> 'lines') NOT IN ('array', 'null') THEN 'Lines must be a list.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  -- 034: a credit note's net, VAT and total are what its lines add up to. Lines given must make the figures given; without lines it
  -- gets one line for its whole net and VAT (written below).
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'credit_notes', c.ord, c.row_no, 'lines', 'The lines come to net ' || to_char(s.net, 'FM999999999990.00') || ', VAT ' || to_char(s.tax, 'FM999999999990.00')
         || '; the credit note says net ' || to_char(c.subtotal, 'FM999999999990.00') || ', VAT ' || to_char(c.vat, 'FM999999999990.00') || ': its figures must be its lines''.'
  FROM _imp_credit_notes c
  JOIN (SELECT l.c_ord, sum(round(l.quantity * l.unit_price, 2)) AS net,
               sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END) AS tax
        FROM _imp_credit_lines l GROUP BY l.c_ord) s ON s.c_ord = c.ord
  WHERE c.total IS NOT NULL AND (s.net IS DISTINCT FROM c.subtotal OR (CASE WHEN c.vat_enabled THEN s.tax ELSE 0 END) IS DISTINCT FROM c.vat)
    AND NOT EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'credit_notes' AND e.ord = c.ord);
  -- Already in Tolra: the same number for the same invoice and total is a match (skipped); anything else is a problem.
  UPDATE _imp_credit_notes c SET existing_id = cn.id FROM public.credit_notes cn WHERE cn.organization_id = p_org AND cn.credit_ref = c.credit_ref;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'credit_notes', c.ord, c.row_no, 'credit_ref', c.credit_ref || ' is already in Tolra for another invoice or with a different total: nothing is overwritten.'
  FROM _imp_credit_notes c JOIN public.credit_notes cn ON cn.id = c.existing_id LEFT JOIN public.invoices i ON i.id = cn.invoice_id
  WHERE i.invoice_ref IS DISTINCT FROM c.invoice_ref OR (c.total IS NOT NULL AND cn.total <> c.total);

  -- ===== Delivery notes and their items (085) =====================================================================================
  -- Linked when they are written (below) to their customer (one with that name), job (by number, never an internal one), sales order
  -- (number and customer, consistent with the job) and invoice (by number), each only when exactly one matches. Who signed it is text,
  -- linked to a Tolra user only on one match by full name. A note goes in as it was (sent out, delivered or signed): no draft invoice is
  -- made and no release is asked for (081's gate lets the import's own notes in). As with 076's invoices (issued_at), 035's actor_stamp
  -- records the import as the moment a sent-out note went out (despatched_at, despatched_by); its own dates are delivery_date and ship_date.
  CREATE TEMP TABLE _imp_delivery_notes ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.delivery_date_raw) AS delivery_date, public.import_date(x.ship_date_raw) AS ship_date,
         public.import_date(x.signed_at_raw) AS signed_on,
         CASE lower(regexp_replace(coalesce(x.status_raw, CASE WHEN x.signed_by IS NOT NULL THEN 'signed' ELSE 'despatched' END), '[ -]+', '_', 'g'))
           WHEN 'sent' THEN 'despatched' WHEN 'sent_out' THEN 'despatched' WHEN 'dispatched' THEN 'despatched'
           ELSE lower(regexp_replace(coalesce(x.status_raw, CASE WHEN x.signed_by IS NOT NULL THEN 'signed' ELSE 'despatched' END), '[ -]+', '_', 'g')) END AS status,
         public.import_norm_name(x.customer) AS customer_norm,
         x.dn_number AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id,
         NULL::UUID AS customer_id, NULL::UUID AS job_id, NULL::UUID AS so_id, NULL::UUID AS invoice_id, NULL::UUID AS signed_by_user_id
  FROM (SELECT e.ord::INT AS ord, e.v,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'dn_number') AS dn_number, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'job_no') AS job_no, (cr.c ->> 'so_number') AS so_number, (cr.c ->> 'invoice_ref') AS invoice_ref,
               (cr.c ->> 'delivery_date') AS delivery_date_raw, (cr.c ->> 'ship_date') AS ship_date_raw,
               (cr.c ->> 'ship_via') AS ship_via, (cr.c ->> 'status') AS status_raw, (cr.c ->> 'notes') AS notes,
               (cr.c ->> 'signed_by') AS signed_by, (cr.c ->> 'signed_at') AS signed_at_raw, (cr.c ->> 'signature_notes') AS signature_notes
        FROM jsonb_array_elements(coalesce(p_payload -> 'delivery_notes', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  CREATE TEMP TABLE _imp_delivery_items ON COMMIT DROP AS
  SELECT x.*, public.import_num(x.quantity_raw) AS quantity
  FROM (SELECT d.ord AS d_ord, d.row_no AS d_row, l.pos::INT AS pos, jsonb_typeof(l.v) = 'object' AS obj,
               (cl.c ->> 'description') AS description, coalesce((cl.c ->> 'quantity'), '1') AS quantity_raw
        FROM _imp_delivery_notes d
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.v -> 'lines') = 'array' THEN d.v -> 'lines' ELSE '[]'::JSONB END) WITH ORDINALITY l(v, pos)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(l.v) AS c OFFSET 0) cl) x;
  CREATE INDEX ON _imp_delivery_items (d_ord);
  ANALYZE _imp_delivery_notes;
  ANALYZE _imp_delivery_items;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'delivery_notes', c.ord, c.row_no, f.field, f.message
  FROM _imp_delivery_notes c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('dn_number', CASE WHEN c.obj AND c.dn_number IS NULL THEN 'Delivery note number is required.' WHEN length(c.dn_number) > 60 THEN 'Delivery note number is longer than 60 characters.' END),
    ('customer', CASE WHEN c.obj AND c.customer IS NULL THEN 'Customer is required.' WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('job_no', CASE WHEN length(c.job_no) > 60 THEN 'Job number is longer than 60 characters.'
                    WHEN EXISTS (SELECT 1 FROM public.jobs j WHERE j.organization_id = p_org AND j.job_no = c.job_no AND j.is_internal)
                    THEN 'Job ' || c.job_no || ' is internal: it has no customer order, so it is never despatched.' END),
    ('so_number', CASE WHEN length(c.so_number) > 60 THEN 'Order number is longer than 60 characters.' END),
    ('invoice_ref', CASE WHEN length(c.invoice_ref) > 60 THEN 'Invoice number is longer than 60 characters.' END),
    ('delivery_date', CASE WHEN c.obj AND c.delivery_date_raw IS NULL THEN 'Delivery date is required.'
                           WHEN c.delivery_date_raw IS NOT NULL AND c.delivery_date IS NULL THEN 'Delivery date must be a real date written YYYY-MM-DD.' END),
    ('ship_date', CASE WHEN c.ship_date_raw IS NOT NULL AND c.ship_date IS NULL THEN 'Ship date must be a real date written YYYY-MM-DD.' END),
    ('ship_via', CASE WHEN length(c.ship_via) > 200 THEN 'Ship via is longer than 200 characters.' END),
    ('status', CASE WHEN c.status NOT IN ('pending', 'awaiting', 'despatched', 'delivered', 'signed')
                    THEN 'Status must be pending, awaiting, despatched, delivered or signed.'
                    WHEN c.status = 'signed' AND c.signed_by IS NULL THEN 'A signed note needs who signed it (Signed by).'
                    WHEN c.status <> 'signed' AND c.signed_by IS NOT NULL THEN 'Signed by is given, so the status must be signed.' END),
    ('notes', CASE WHEN length(c.notes) > 4000 THEN 'Notes are longer than 4000 characters.' END),
    ('signed_by', CASE WHEN length(c.signed_by) > 200 THEN 'Signed by is longer than 200 characters.' END),
    ('signed_at', CASE WHEN c.signed_at_raw IS NOT NULL AND c.signed_on IS NULL THEN 'Date signed must be a real date written YYYY-MM-DD.' END),
    ('signature_notes', CASE WHEN length(c.signature_notes) > 1000 THEN 'Signature notes are longer than 1000 characters.' END),
    ('lines', CASE WHEN c.obj AND c.v ? 'lines' AND jsonb_typeof(c.v -> 'lines') NOT IN ('array', 'null') THEN 'Lines must be a list.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'delivery_notes', l.d_ord, l.d_row, 'lines[' || l.pos || '].' || f.field, f.message
  FROM _imp_delivery_items l
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT l.obj THEN 'Not a line.' END),
    ('description', CASE WHEN l.obj AND l.description IS NULL THEN 'Line description is required.' WHEN length(l.description) > 2000 THEN 'Line description is longer than 2000 characters.' END),
    ('quantity', CASE WHEN l.quantity IS NULL OR l.quantity <= 0 OR l.quantity <> round(l.quantity, 3) THEN 'Quantity must be more than 0 (at most 3 decimals).' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_delivery_notes c SET existing_id = dn.id FROM public.delivery_notes dn WHERE dn.organization_id = p_org AND dn.dn_number = c.dn_number;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'delivery_notes', c.ord, c.row_no, 'dn_number', c.dn_number || ' is already in Tolra for a different customer: nothing is overwritten.'
  FROM _imp_delivery_notes c JOIN public.delivery_notes dn ON dn.id = c.existing_id
  WHERE public.import_norm_name(dn.customer) IS DISTINCT FROM c.customer_norm;

  -- ===== People named on purchase orders, invoices and delivery notes (085) =======================================================
  UPDATE _imp_purchase_orders c SET sent_by_user_id = pp.id FROM _imp_people pp WHERE pp.nn = lower(regexp_replace(c.sent_by, '\s+', ' ', 'g')) AND pp.n = 1;
  UPDATE _imp_invoices c SET sent_by_user_id = pp.id FROM _imp_people pp WHERE pp.nn = lower(regexp_replace(c.sent_by, '\s+', ' ', 'g')) AND pp.n = 1;
  UPDATE _imp_delivery_notes c SET signed_by_user_id = pp.id FROM _imp_people pp WHERE pp.nn = lower(regexp_replace(c.signed_by, '\s+', ' ', 'g')) AND pp.n = 1;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT y.kind, y.row_no, y.field, y.who || ' is the name of ' || pp.n || ' people in Tolra: kept as text ("not a Tolra user"), linked to none of them.'
  FROM (SELECT 'purchase_orders' AS kind, row_no, 'sent_by' AS field, sent_by AS who FROM _imp_purchase_orders
        UNION ALL SELECT 'invoices', row_no, 'sent_by', sent_by FROM _imp_invoices
        UNION ALL SELECT 'delivery_notes', row_no, 'signed_by', signed_by FROM _imp_delivery_notes) y
  JOIN _imp_people pp ON pp.nn = lower(regexp_replace(y.who, '\s+', ' ', 'g')) AND pp.n > 1;

  -- ===== In-file duplicates (documents and stock) =================================================================================
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT d.kind, d.ord, d.row_no, d.field, 'This number is in the file twice (also row ' || d.first_row || ').'
  FROM (SELECT y.*, first_value(y.row_no) OVER w AS first_row, row_number() OVER w AS rn
        FROM (SELECT 'stock' AS kind, 'sku' AS field, ord, row_no, match_key FROM _imp_stock
              UNION ALL SELECT 'quotes', 'quote_ref', ord, row_no, match_key FROM _imp_quotes
              UNION ALL SELECT 'sales_orders', 'so_number', ord, row_no, match_key FROM _imp_sales_orders
              UNION ALL SELECT 'jobs', 'job_no', ord, row_no, match_key FROM _imp_jobs
              UNION ALL SELECT 'purchase_orders', 'po_ref', ord, row_no, match_key FROM _imp_purchase_orders
              UNION ALL SELECT 'invoices', 'invoice_ref', ord, row_no, match_key FROM _imp_invoices
              UNION ALL SELECT 'credit_notes', 'credit_ref', ord, row_no, match_key FROM _imp_credit_notes
              UNION ALL SELECT 'delivery_notes', 'dn_number', ord, row_no, match_key FROM _imp_delivery_notes) y
        WHERE y.match_key IS NOT NULL
        WINDOW w AS (PARTITION BY y.kind, y.match_key ORDER BY y.ord)) d
  WHERE d.rn > 1;

  -- ===== Decide: create, match (skipped), or error =================================================================================
  CREATE INDEX ON _imp_err (kind, ord);
  ANALYZE _imp_err;
  UPDATE _imp_parties c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = c.kind AND e.ord = c.ord) THEN 'error'
                                          WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_stock c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'stock' AND e.ord = c.ord) THEN 'error'
                                        WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_quotes c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'quotes' AND e.ord = c.ord) THEN 'error'
                                         WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_sales_orders c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'sales_orders' AND e.ord = c.ord) THEN 'error'
                                               WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_jobs c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'jobs' AND e.ord = c.ord) THEN 'error'
                                       WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_purchase_orders c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'purchase_orders' AND e.ord = c.ord) THEN 'error'
                                                  WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_delivery_notes c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'delivery_notes' AND e.ord = c.ord) THEN 'error'
                                                 WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;

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
                             invoice_id = (SELECT i.new_id FROM _imp_invoices i WHERE i.invoice_ref = p.invoice_ref ORDER BY i.ord LIMIT 1) WHERE TRUE;

  -- Credit notes (085): matched by number; created only with an invoice this import creates, for that invoice's customer, never on a
  -- void, cancelled or written-off one, and never for more than the invoice (all its credit notes together).
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'credit_notes', c.ord, c.row_no, 'invoice_ref',
         CASE WHEN i.ord IS NOT NULL AND EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord)
                THEN 'Its invoice (row ' || i.row_no || ') has problems.'
              WHEN i.existing_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.invoices x WHERE x.organization_id = p_org AND x.invoice_ref = c.invoice_ref)
                THEN 'Invoice ' || c.invoice_ref || ' is already in Tolra: a credit note is imported only with its invoice (make it on the invoice with New credit note).'
              ELSE 'There is no invoice ' || c.invoice_ref || ' in this file or in Tolra.' END
  FROM _imp_credit_notes c
  LEFT JOIN LATERAL (SELECT i2.ord, i2.row_no, i2.existing_id FROM _imp_invoices i2 WHERE i2.invoice_ref = c.invoice_ref ORDER BY i2.ord LIMIT 1) i ON TRUE
  WHERE c.existing_id IS NULL AND c.invoice_ref IS NOT NULL AND length(c.invoice_ref) <= 60
    AND NOT EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'credit_notes' AND e.ord = c.ord)
    AND (i.ord IS NULL OR i.existing_id IS NOT NULL OR EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord));
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'credit_notes', c.ord, c.row_no, f.field, f.message
  FROM _imp_credit_notes c
  JOIN LATERAL (SELECT i2.ord, i2.customer, i2.status_given FROM _imp_invoices i2 WHERE i2.invoice_ref = c.invoice_ref AND i2.existing_id IS NULL ORDER BY i2.ord LIMIT 1) i ON TRUE
  CROSS JOIN LATERAL (VALUES
    ('customer', CASE WHEN c.customer IS NOT NULL AND public.import_norm_name(c.customer) IS DISTINCT FROM public.import_norm_name(i.customer)
                      THEN 'Its invoice ' || c.invoice_ref || ' is for ' || i.customer || ', not ' || c.customer || '.' END),
    ('invoice_ref', CASE WHEN i.status_given IN ('void', 'cancelled', 'written_off')
                         THEN 'Invoice ' || c.invoice_ref || ' is ' || replace(i.status_given, '_', ' ') || ' and can''t be credited.' END)
  ) f(field, message)
  WHERE c.existing_id IS NULL AND f.message IS NOT NULL;
  UPDATE _imp_credit_notes c SET invoice_id = (SELECT i.new_id FROM _imp_invoices i WHERE i.invoice_ref = c.invoice_ref ORDER BY i.ord LIMIT 1) WHERE TRUE;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'credit_notes', c.ord, c.row_no, 'total',
         'The credit notes for ' || c.invoice_ref || ' come to ' || to_char(s.credited, 'FM999999999990.00') || ', more than the invoice''s '
         || to_char(i.total, 'FM999999999990.00') || '.'
  FROM _imp_credit_notes c
  JOIN _imp_invoices i ON i.new_id = c.invoice_id AND i.total IS NOT NULL
  JOIN (SELECT c2.invoice_id, sum(c2.total) AS credited FROM _imp_credit_notes c2
        WHERE c2.existing_id IS NULL AND c2.total IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'credit_notes' AND e.ord = c2.ord)
        GROUP BY c2.invoice_id) s ON s.invoice_id = c.invoice_id
  WHERE c.existing_id IS NULL AND s.credited > i.total AND NOT EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'credit_notes' AND e.ord = c.ord);
  UPDATE _imp_credit_notes c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'credit_notes' AND e.ord = c.ord) THEN 'error'
                                               WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_invoices i SET credited = s.credited
  FROM (SELECT c.invoice_id, sum(c.total) AS credited FROM _imp_credit_notes c WHERE c.action = 'create' GROUP BY c.invoice_id) s
  WHERE s.invoice_id = i.new_id;

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
    ('status', CASE WHEN c.status_given NOT IN ('issued', 'sent', 'partial', 'paid', 'credited', 'void', 'cancelled', 'written_off')
                    THEN 'Status must be issued, sent, partial, paid, credited, void, cancelled or written off (drafts are not imported).'
                    -- 085: credited only by credit notes in this file that cover what was not paid.
                    WHEN c.status_given = 'credited' AND (c.credited = 0 OR c.paid + c.credited < c.total)
                    THEN 'Marked credited, but the credit notes for it in this file come to ' || to_char(c.credited, 'FM999999999990.00') || ' of ' || to_char(coalesce(c.total, 0) - c.paid, 'FM999999999990.00') || ' not paid.' END),
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
    ('sent_by', CASE WHEN length(c.sent_by) > 200 THEN 'Sent by is longer than 200 characters.' END),
    ('payments', CASE WHEN c.paid > 0 AND c.status_given IN ('void', 'cancelled') THEN 'A void or cancelled invoice can''t have payments.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_invoices i SET
    -- 085: as allocate_credit_note settles it: nothing left to pay is paid when anything was paid, else credited.
    status = CASE WHEN i.status_given IN ('void', 'cancelled', 'written_off') THEN i.status_given
                  WHEN i.paid > 0 AND i.paid + i.credited >= i.total THEN 'paid'
                  WHEN i.credited > 0 AND i.credited >= i.total THEN 'credited'
                  WHEN i.paid > 0 THEN 'partial'
                  WHEN i.status_given = 'paid' AND i.total = 0 THEN 'paid'
                  WHEN i.status_given IN ('paid', 'partial', 'credited') THEN 'sent'
                  ELSE i.status_given END,
    payment_unverified = (i.status_given IN ('paid', 'partial') AND i.paid = 0 AND i.total - i.credited > 0),
    action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord) THEN 'error'
                  WHEN i.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
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
  -- 085: a credit note whose invoice turned out to have a problem above.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'credit_notes', c.ord, c.row_no, 'invoice_ref', 'Its invoice (row ' || i.row_no || ') has problems.'
  FROM _imp_credit_notes c JOIN _imp_invoices i ON i.new_id = c.invoice_id
  WHERE c.action = 'create' AND i.action = 'error';
  UPDATE _imp_credit_notes c SET action = 'error' WHERE c.action = 'create' AND EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'credit_notes' AND e.ord = c.ord);
  ANALYZE _imp_credit_notes;
  ANALYZE _imp_delivery_notes;

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
        UNION ALL SELECT 'delivery_notes', row_no, 'dn_number', dn_number, 'DLN' FROM _imp_delivery_notes WHERE action = 'create'
        UNION ALL SELECT 'sales_orders', row_no, 'so_number', so_number, 'SO' FROM _imp_sales_orders WHERE action = 'create') y
  WHERE y.ref !~ ('^' || y.prefix || '-\d{1,9}$');
  -- 085: credit notes.
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'credit_notes', c.row_no, 'credit_ref', c.credit_ref || ' is not CRD-<digits>: it is imported as written, and Tolra''s CRD numbers carry on after the highest CRD or CN number.'
  FROM _imp_credit_notes c WHERE c.action = 'create' AND c.credit_ref !~ '^(CRD|CN)-\d{1,9}$';
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'invoices', i.row_no, 'total', 'Its payments and credit notes come to ' || to_char(i.paid + i.credited, 'FM999999999990.00') || ', more than its total: the '
         || to_char(i.paid + i.credited - i.total, 'FM999999999990.00') || ' over is the customer''s credit.'
  FROM _imp_invoices i WHERE i.action = 'create' AND i.credited > 0 AND i.paid + i.credited > i.total;

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
  SELECT (SELECT count(*) FROM _imp_credit_lines l JOIN _imp_credit_notes c ON c.ord = l.c_ord WHERE c.action = 'create')
       + (SELECT count(*) FROM _imp_credit_notes c WHERE c.action = 'create' AND NOT EXISTS (SELECT 1 FROM _imp_credit_lines l WHERE l.c_ord = c.ord)) INTO v_cl;
  SELECT count(*) INTO v_dl FROM _imp_delivery_items l JOIN _imp_delivery_notes d ON d.ord = l.d_ord WHERE d.action = 'create';
  v_counts := v_counts || jsonb_build_object('credit_note_lines', jsonb_build_object('created', v_cl), 'delivery_note_items', jsonb_build_object('created', v_dl));
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
               + (SELECT count(*) FROM _imp_invoices) + (SELECT count(*) FROM _imp_payments)
               + (SELECT count(*) FROM _imp_credit_notes) + (SELECT count(*) FROM _imp_delivery_notes),
    'lines', (SELECT count(*) FROM _imp_quote_lines) + (SELECT count(*) FROM _imp_invoice_lines)
             + (SELECT count(*) FROM _imp_credit_lines) + (SELECT count(*) FROM _imp_delivery_items),
    'audit_rows', (SELECT count(*) FROM _imp_parties WHERE action = 'create') + (SELECT count(*) FROM _imp_stock WHERE action = 'create')
                  + (SELECT count(*) FROM _imp_quotes WHERE action = 'create') + (SELECT count(*) FROM _imp_sales_orders WHERE action = 'create')
                  + (SELECT count(*) FROM _imp_jobs WHERE action = 'create') + (SELECT count(*) FROM _imp_purchase_orders WHERE action = 'create')
                  + 2 * (SELECT count(*) FROM _imp_invoices WHERE action = 'create') + v_ql + v_il
                  + (SELECT count(*) FROM _imp_credit_notes WHERE action = 'create') + (SELECT count(*) FROM _imp_delivery_notes WHERE action = 'create') + v_cl + v_dl);
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
                                      notes, vat_enabled, sent_by_name, sent_by_user_id, created_at, updated_at)
  SELECT c.new_id, p_org, c.po_ref, c.po_ref, c.supplier, coalesce(c.order_date, CURRENT_DATE), c.expected_delivery, '[]'::JSONB, c.total_value, c.status,
         c.notes, coalesce(c.vat_enabled, FALSE), c.sent_by, c.sent_by_user_id,
         coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_purchase_orders c WHERE c.action = 'create' ORDER BY c.ord;

  -- Invoices: linked to their job by number (never an internal job).
  UPDATE _imp_invoices i SET job_id = j.id FROM public.jobs j
  WHERE i.action = 'create' AND j.organization_id = p_org AND j.job_no = i.job_no AND NOT j.is_internal;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'invoices', i.row_no, 'job_no', 'Not linked to job ' || i.job_no || ' (not found, or an internal job).'
  FROM _imp_invoices i WHERE i.action = 'create' AND i.job_no IS NOT NULL AND i.job_id IS NULL;
  INSERT INTO public.invoices (id, organization_id, invoice_ref, customer, description, subtotal, vat, total, status, due_date, invoice_date, terms,
                               quote_ref, customer_po, job_id, vat_enabled, amount_paid, credited_amount, sent_by_name, sent_by_user_id, paid_at,
                               payment_unverified, created_at, updated_at)
  SELECT c.new_id, p_org, c.invoice_ref, c.customer, c.description, c.subtotal, c.vat, c.total, c.status, c.due_date, c.invoice_date, c.terms,
         c.quote_ref, c.customer_po, c.job_id, c.vat_enabled, c.paid, c.credited, c.sent_by, c.sent_by_user_id,
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

  -- Credit notes (085): issued, with their lines, and applied in full to their invoice (written above with what they credit), as
  -- allocate_credit_note records it.
  INSERT INTO public.credit_notes (id, organization_id, invoice_id, credit_ref, status, customer, credit_date, reason, subtotal, vat, total, vat_enabled,
                                   allocated_amount, issued_at, created_at, updated_at)
  SELECT c.new_id, p_org, c.invoice_id, c.credit_ref, 'issued', i.customer, c.credit_date, c.reason, c.subtotal, c.vat, c.total, c.vat_enabled, c.total,
         (c.credit_date + TIME '12:00') AT TIME ZONE 'Europe/London', (c.credit_date + TIME '12:00') AT TIME ZONE 'Europe/London',
         (c.credit_date + TIME '12:00') AT TIME ZONE 'Europe/London'
  FROM _imp_credit_notes c JOIN _imp_invoices i ON i.new_id = c.invoice_id AND i.action = 'create'
  WHERE c.action = 'create' ORDER BY c.ord;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_expect := (v_counts -> 'credit_notes' ->> 'created')::INT;
  IF v_n <> v_expect THEN RAISE EXCEPTION 'import: % credit notes written, % expected', v_n, v_expect; END IF;
  INSERT INTO public.credit_note_lines (organization_id, credit_note_id, position, description, quantity, unit_price, vat_pct, vat_exempt, vat_amount)
  SELECT p_org, c.new_id, l.pos - 1, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt,
         CASE WHEN l.vat_exempt OR NOT c.vat_enabled THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END
  FROM _imp_credit_lines l JOIN _imp_credit_notes c ON c.ord = l.c_ord WHERE c.action = 'create' ORDER BY c.ord, l.pos;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- A credit note given without lines: one line for its whole net and VAT (so its figures are its lines', as 034 keeps them).
  INSERT INTO public.credit_note_lines (organization_id, credit_note_id, position, description, quantity, unit_price, vat_pct, vat_exempt, vat_amount)
  SELECT p_org, c.new_id, 0, 'Credit note ' || c.credit_ref || CASE WHEN c.reason IS NOT NULL THEN ': ' || left(c.reason, 400) ELSE ' (imported without lines)' END,
         1, c.subtotal, CASE WHEN c.subtotal > 0 THEN least(100, round(c.vat * 100 / c.subtotal, 2)) ELSE 0 END, c.vat = 0, c.vat
  FROM _imp_credit_notes c WHERE c.action = 'create' AND NOT EXISTS (SELECT 1 FROM _imp_credit_lines l WHERE l.c_ord = c.ord) ORDER BY c.ord;
  v_n := v_n + (SELECT count(*) FROM _imp_credit_notes c WHERE c.action = 'create' AND NOT EXISTS (SELECT 1 FROM _imp_credit_lines l WHERE l.c_ord = c.ord));
  IF v_n <> v_cl THEN RAISE EXCEPTION 'import: % credit note lines written, % expected', v_n, v_cl; END IF;
  INSERT INTO public.invoice_credit_allocations (organization_id, invoice_id, credit_note_id, amount, allocated_on, created_by)
  SELECT p_org, c.invoice_id, c.new_id, c.total, c.credit_date, p_uid
  FROM _imp_credit_notes c WHERE c.action = 'create' ORDER BY c.ord;

  -- Delivery notes (085): their links, each only when exactly one record matches (a link not made is a warning, the text is kept).
  UPDATE _imp_delivery_notes d SET customer_id = n.id FROM _imp_names n WHERE n.nn = d.customer_norm AND n.n = 1 AND d.action = 'create';
  -- Job and invoice: by number AND for this note's customer (normalised name), as the sales order is: another customer's is never linked.
  UPDATE _imp_delivery_notes d SET job_id = j.id FROM public.jobs j
  WHERE d.action = 'create' AND j.organization_id = p_org AND j.job_no = d.job_no AND NOT j.is_internal
    AND public.import_norm_name(j.customer) = d.customer_norm;
  UPDATE _imp_delivery_notes d SET so_id = o.id
  FROM (SELECT so.so_number, public.import_norm_name(so.customer) AS nn, (array_agg(so.id))[1] AS id, count(*) AS n, (array_agg(so.converted_to_job_id))[1] AS job_id
        FROM public.sales_orders so WHERE so.organization_id = p_org GROUP BY 1, 2) o
  WHERE d.action = 'create' AND o.so_number = d.so_number AND o.nn = d.customer_norm AND o.n = 1
    -- with a job, only the order that job was made from (as create_delivery_note and 042's guard accept the link)
    AND (d.job_id IS NULL OR o.job_id = d.job_id OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = d.job_id AND j.converted_from_sales_order_id = o.id));
  UPDATE _imp_delivery_notes d SET invoice_id = i.id FROM public.invoices i
  WHERE d.action = 'create' AND i.organization_id = p_org AND i.invoice_ref = d.invoice_ref
    AND public.import_norm_name(i.customer) = d.customer_norm;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'delivery_notes', d.row_no, y.field, y.message
  FROM _imp_delivery_notes d
  CROSS JOIN LATERAL (VALUES
    ('job_no', CASE WHEN d.job_no IS NOT NULL AND d.job_id IS NULL THEN 'Not linked to job ' || d.job_no || ' (not found for this customer): kept as text.' END),
    ('so_number', CASE WHEN d.so_number IS NOT NULL AND d.so_id IS NULL
                       THEN 'Not linked to sales order ' || d.so_number || ' (not found for this customer, or its job is another one): kept as text in the notes.' END),
    ('invoice_ref', CASE WHEN d.invoice_ref IS NOT NULL AND d.invoice_id IS NULL THEN 'Not linked to invoice ' || d.invoice_ref || ' (not found for this customer): kept as text.' END)
  ) y(field, message)
  WHERE d.action = 'create' AND y.message IS NOT NULL;
  INSERT INTO public.delivery_notes (id, organization_id, dn_number, customer, customer_id, sales_order_id, job_id, job_ref, invoice_id, invoice_ref,
                                     delivery_date, ship_date, ship_via, status, notes, signed_by_name, signed_by_user_id, signed_at, signature_notes,
                                     created_at, updated_at)
  SELECT d.new_id, p_org, d.dn_number, d.customer, d.customer_id, d.so_id, d.job_id, d.job_no, d.invoice_id, d.invoice_ref,
         d.delivery_date, d.ship_date, d.ship_via, d.status,
         nullif(concat_ws(E'\n', d.notes, CASE WHEN d.so_number IS NOT NULL AND d.so_id IS NULL THEN 'Sales order: ' || d.so_number END), ''),
         d.signed_by, d.signed_by_user_id,
         CASE WHEN d.status = 'signed' THEN (coalesce(d.signed_on, d.delivery_date) + TIME '12:00') AT TIME ZONE 'Europe/London' END, d.signature_notes,
         (d.delivery_date + TIME '12:00') AT TIME ZONE 'Europe/London', (d.delivery_date + TIME '12:00') AT TIME ZONE 'Europe/London'
  FROM _imp_delivery_notes d WHERE d.action = 'create' ORDER BY d.ord;
  INSERT INTO public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity)
  SELECT p_org, d.new_id, l.pos - 1, l.description, l.quantity
  FROM _imp_delivery_items l JOIN _imp_delivery_notes d ON d.ord = l.d_ord WHERE d.action = 'create' ORDER BY d.ord, l.pos;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_dl THEN RAISE EXCEPTION 'import: % delivery note items written, % expected', v_n, v_dl; END IF;

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
        UNION ALL SELECT 'credit_notes', match_key, new_id FROM _imp_credit_notes WHERE action = 'create'
        UNION ALL SELECT 'delivery_notes', match_key, new_id FROM _imp_delivery_notes WHERE action = 'create'
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

-- 076's import_undo_part, extended by 085.
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
                                     'purchase_orders', 'invoices', 'invoice_line_items', 'invoice_payments',
                                     'credit_notes', 'credit_note_lines', 'invoice_credit_allocations', 'delivery_notes', 'delivery_note_items'];
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
  FOREACH v_t IN ARRAY ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'invoice_payments',
                             'credit_notes', 'delivery_notes'] LOOP
    EXECUTE format('DELETE FROM pg_temp._undo u WHERE u.tbl = %L AND NOT EXISTS (SELECT 1 FROM public.%I t WHERE t.id = u.id AND t.organization_id = $1)', v_t, v_t)
      USING p_org;
  END LOOP;
  UPDATE _undo u SET parent_tbl = 'invoices', parent_id = p.invoice_id FROM public.invoice_payments p WHERE u.tbl = 'invoice_payments' AND p.id = u.id;
  -- 085: a credit note is kept with its invoice (deleting one without the other would leave the invoice's credited amount wrong).
  UPDATE _undo u SET parent_tbl = 'invoices', parent_id = c.invoice_id FROM public.credit_notes c WHERE u.tbl = 'credit_notes' AND c.id = u.id;
  -- Lines and job values written with their record in the same transaction.
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'quote_line_items', l.id, 'quote_lines', 'quotes', l.quote_id, 1
  FROM public.quote_line_items l JOIN _undo u ON u.tbl = 'quotes' AND u.id = l.quote_id WHERE l.created_at = v_b.txn_started_at;
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'invoice_line_items', l.id, 'invoice_lines', 'invoices', l.invoice_id, 1
  FROM public.invoice_line_items l JOIN _undo u ON u.tbl = 'invoices' AND u.id = l.invoice_id WHERE l.created_at = v_b.txn_started_at;
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'job_values', v.job_id, 'job_values', 'jobs', v.job_id, 1 FROM public.job_values v JOIN _undo u ON u.tbl = 'jobs' AND u.id = v.job_id;
  -- 085: a credit note's lines and its allocation to its invoice (the allocation is not row-audited), a delivery note's items.
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'credit_note_lines', l.id, 'credit_note_lines', 'credit_notes', l.credit_note_id, 1
  FROM public.credit_note_lines l JOIN _undo u ON u.tbl = 'credit_notes' AND u.id = l.credit_note_id WHERE l.created_at = v_b.txn_started_at;
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'invoice_credit_allocations', a.id, 'credit_allocations', 'credit_notes', a.credit_note_id, 0
  FROM public.invoice_credit_allocations a JOIN _undo u ON u.tbl = 'credit_notes' AND u.id = a.credit_note_id WHERE a.created_at = v_b.txn_started_at;
  INSERT INTO _undo (tbl, id, kind, parent_tbl, parent_id, audit_rows)
  SELECT 'delivery_note_items', l.id, 'delivery_note_items', 'delivery_notes', l.delivery_note_id, 1
  FROM public.delivery_note_items l JOIN _undo u ON u.tbl = 'delivery_notes' AND u.id = l.delivery_note_id WHERE l.created_at = v_b.txn_started_at;

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
  FOREACH v_t IN ARRAY ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices',
                             'credit_notes', 'delivery_notes'] LOOP
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
  FOREACH v_t IN ARRAY ARRAY['delivery_note_items', 'delivery_notes', 'invoice_credit_allocations', 'credit_note_lines', 'credit_notes',
                             'invoice_payments', 'invoice_line_items', 'invoices', 'purchase_orders', 'job_values', 'jobs', 'sales_orders',
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

-- -----------------------------------------------------------------------------------------------------
-- 7. Self-check before COMMIT: every body is 085's; none of the replaced import functions has an UPDATE or DELETE without its own WHERE
-- (079's check); the internal ones (and the new trigger function) can't be called from the API; the five entry points are as before;
-- the people columns, their triggers and the two kinds are in place.
DO $$
DECLARE
  r RECORD;
  v_md5 TEXT;
  v_names TEXT[] := ARRAY['import_check_payload', 'import_merge_stage', 'import_plan', 'import_part_payload', 'import_company_data_run', 'import_undo_part'];
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('credit_note_issue_lock', '8e0ff460c60a94bb1164dc39dd77aae1'),
    ('credit_note_lines_issue_lock', '369bbaa5c6979d4bb9d70c5cbf68d9bd'),
    ('delivery_notes_link_guard', '4c57607b1909f060d689df9ea5a99128'),
    ('delivery_note_items_link_guard', '612a2bc924a8ea1916ce1a66101ced97'),
    ('import_check_payload', '7c041eb39e57ee9504308162bc3217c9'),
    ('import_merge_stage', 'b24dbc8ae80269fca5d93345a1d3f50a'),
    ('import_plan', 'ba1637348e59883e1473ee4645875c12'),
    ('import_part_payload', 'bcd8bc328cde95cceafefe0ca1b0990b'),
    ('import_company_data_run', '0a2fec5746b0b1262cb2af6fe792bd7c'),
    ('import_undo_part', '177d5c7273b79670dd0c3f130b215652'),
    ('import_people_guard', '513ca1c3542ad19388992a58a8b78cdb')) v(name, after_085)
  LOOP
    SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name;
    IF v_md5 IS DISTINCT FROM r.after_085 THEN
      RAISE EXCEPTION '085: public.% is not 085''s after the replace (md5 %)', r.name, v_md5;
    END IF;
  END LOOP;
  IF EXISTS (
    WITH RECURSIVE stmt AS (
      SELECT p.oid, s.n, s.t FROM pg_proc p,
        LATERAL regexp_split_to_table(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), ';') WITH ORDINALITY AS s(t, n)
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_names)
    ),
    occ AS (
      SELECT stmt.oid, stmt.n, k, substring(stmt.t FROM regexp_instr(stmt.t, '\m(?:UPDATE\s+(?:ONLY\s+)?[[:alnum:]_.%"]+(?:\s+(?:AS\s+)?[[:alnum:]_]+)?\s+SET|DELETE\s+FROM)\M', 1, k, 0, 'i')) AS t
      FROM stmt, LATERAL generate_series(1, regexp_count(stmt.t, '\m(?:UPDATE\s+(?:ONLY\s+)?[[:alnum:]_.%"]+(?:\s+(?:AS\s+)?[[:alnum:]_]+)?\s+SET|DELETE\s+FROM)\M', 1, 'i')) AS k
    ),
    flat(oid, n, k, t, i) AS (
      SELECT oid, n, k, t, 0 FROM occ
      UNION ALL SELECT oid, n, k, regexp_replace(t, '\([^()]*\)', ' ', 'g'), i + 1 FROM flat WHERE t ~ '\([^()]*\)' AND i < 50
    )
    SELECT 1 FROM flat x
    WHERE NOT EXISTS (SELECT 1 FROM flat y WHERE y.oid = x.oid AND y.n = x.n AND y.k = x.k AND y.i > x.i)
      AND split_part(x.t, ')', 1) !~* '\mWHERE\M'
  ) THEN
    RAISE EXCEPTION '085: an import function has an UPDATE or DELETE without its own WHERE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_names || 'import_people_guard'::TEXT)
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION '085: an internal import function is callable from the API';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.import_company_data(jsonb,boolean,uuid)'), to_regprocedure('public.import_stage_part(uuid,integer,jsonb)'),
        to_regprocedure('public.import_validate(uuid,integer,uuid)'), to_regprocedure('public.import_commit_part(uuid,uuid)'), to_regprocedure('public.import_undo(uuid,uuid)'))
        AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) <> 5 THEN
    RAISE EXCEPTION '085: the import entry points are not as 076 left them';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND (table_name, column_name) IN (('invoices', 'sent_by_name'), ('invoices', 'sent_by_user_id'), ('purchase_orders', 'sent_by_name'),
                                          ('purchase_orders', 'sent_by_user_id'), ('delivery_notes', 'signed_by_user_id'))) <> 5
     OR (SELECT count(*) FROM pg_trigger t WHERE t.tgname = 'import_people_guard' AND NOT t.tgisinternal AND t.tgenabled = 'O'
           AND t.tgfoid = 'public.import_people_guard()'::regprocedure
           AND t.tgrelid IN ('public.invoices'::regclass, 'public.purchase_orders'::regclass, 'public.delivery_notes'::regclass)) <> 3 THEN
    RAISE EXCEPTION '085: the people columns or their triggers are missing';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c WHERE c.conname IN ('import_mappings_kind_check', 'import_record_keys_kind_check')
        AND pg_get_constraintdef(c.oid) LIKE '%credit_notes%' AND pg_get_constraintdef(c.oid) LIKE '%delivery_notes%') <> 2 THEN
    RAISE EXCEPTION '085: the import kinds were not widened';
  END IF;
END
$$;

COMMIT;
