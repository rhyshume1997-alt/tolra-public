-- =====================================================================================================
-- 020: quote decisions and issued quotes (audit B4b: D1, D2 minimum).
--
-- * accepted_at / rejected_at record when a customer's decision was entered.
-- * Status moves only forward: draft -> sent -> accepted | rejected (draft may be decided directly). Accepted,
--   rejected and stored "expired" quotes are final. "Expired" for a live quote is derived in the app from
--   valid_until, never written over a decision.
-- * Once a quote is no longer a draft, its customer, value, VAT setting, terms, validity, description, notes to the
--   customer, snapshots and lines can't change, and it can't be deleted: corrections are made on a draft (or a
--   copy). Still open: status (forward only), sent_at, accepted_at, rejected_at and internal notes.
-- Applies to API users (anon, authenticated, service role); the database owner (imports, maintenance) isn't
-- restricted (public.is_api_role, migration 019).
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.quote_lifecycle_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'accepted_at', 'rejected_at', 'internal_notes', 'updated_at', 'updated_by'];
  v_from TEXT;
  v_to   TEXT;
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
  IF v_to IS DISTINCT FROM v_from AND NOT (
       (v_from = 'draft' AND v_to IN ('sent', 'accepted', 'rejected'))
    OR (v_from = 'sent'  AND v_to IN ('accepted', 'rejected'))) THEN
    RAISE EXCEPTION 'Quote % can''t go from % to %.', OLD.quote_ref, v_from, v_to USING ERRCODE = '42501';
  END IF;
  IF v_from <> 'draft' AND (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Quote % has been issued: correct a draft or copy it instead.', OLD.quote_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS quote_lifecycle_guard ON public.quotes;
CREATE TRIGGER quote_lifecycle_guard BEFORE UPDATE OR DELETE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quote_lifecycle_guard();

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

DROP TRIGGER IF EXISTS quote_lines_issue_lock ON public.quote_line_items;
CREATE TRIGGER quote_lines_issue_lock BEFORE INSERT OR UPDATE OR DELETE ON public.quote_line_items
  FOR EACH ROW EXECUTE FUNCTION public.quote_lines_issue_lock();
