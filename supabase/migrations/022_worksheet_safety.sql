-- =====================================================================================================
-- 022: worksheet saves can't silently overwrite each other; one required date (audit B5: D7, A12, A4, D6).
--
-- * jobs.worksheet_version goes up by one whenever a worksheet field changes (the trigger sets it; a value sent
--   by a client is ignored). The app saves "only if the version is still the one I loaded" and gets the saved row
--   back, so a second person's save is refused as a conflict instead of overwriting the first. Moving a job's
--   stage or status on the board doesn't touch the worksheet version, so it never causes a conflict.
-- * Required date: date_required (the worksheet's date) and due_date (the board's date) are kept equal on every
--   change: changing one sets the other. Existing rows are not rewritten; readers use date_required, falling back
--   to due_date for older rows where only that is set.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS worksheet_version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.jobs_worksheet_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Fields edited on the worksheet (lib/job-worksheet.ts worksheetToPatch).
  v_fields CONSTANT TEXT[] := ARRAY[
    'description', 'material_ordered', 'checklist', 'customer_po', 'date_received', 'date_required', 'quote_ref',
    'dimension_report_no', 'material_cert_no', 'heat_cast_no', 'drawing_no', 'material_required', 'material_ordered_at',
    'material_ordered_notes', 'material_supplier', 'machine_1', 'program_1', 'machine_2', 'program_2', 'machine_3',
    'program_3', 'improvement_comments', 'overrun_reasons', 'checked_by', 'signed_off_by', 'signed_off_at',
    'job_time_quoted_hr', 'job_time_taken_hr', 'quantity_required', 'setup_time_hr', 'run_time_hr'];
  v_old JSONB := to_jsonb(OLD);
  v_new JSONB;
  v_key TEXT;
  v_changed BOOLEAN := FALSE;
BEGIN
  -- One required date: whichever of the two dates changed sets the other.
  IF NEW.date_required IS DISTINCT FROM OLD.date_required THEN
    NEW.due_date := NEW.date_required;
  ELSIF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    NEW.date_required := NEW.due_date;
  END IF;

  v_new := to_jsonb(NEW);
  FOREACH v_key IN ARRAY v_fields LOOP
    IF v_new -> v_key IS DISTINCT FROM v_old -> v_key THEN
      v_changed := TRUE;
      EXIT;
    END IF;
  END LOOP;
  NEW.worksheet_version := OLD.worksheet_version + CASE WHEN v_changed THEN 1 ELSE 0 END;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jobs_worksheet_version ON public.jobs;
CREATE TRIGGER jobs_worksheet_version BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_worksheet_version();

-- New jobs: if only one of the two dates is given, use it for both.
CREATE OR REPLACE FUNCTION public.jobs_required_date_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.date_required := coalesce(NEW.date_required, NEW.due_date);
  NEW.due_date := coalesce(NEW.due_date, NEW.date_required);
  NEW.worksheet_version := 0;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jobs_required_date_on_insert ON public.jobs;
CREATE TRIGGER jobs_required_date_on_insert BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_required_date_on_insert();
