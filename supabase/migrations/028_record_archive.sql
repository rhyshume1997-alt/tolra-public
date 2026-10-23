-- =====================================================================================================
-- 028: archive, never delete.
--
-- Finished records drop out of the default lists into an "Archived" view once they are older than the company's
-- setting (default 12 months): finished jobs, accepted/expired/rejected quotes, paid invoices, received/cancelled
-- purchase orders, despatched/converted/closed sales orders, delivered/signed delivery notes. Archived records stay
-- searchable, viewable and printable; nothing is deleted or changed in the records themselves.
--
--   * organization_settings.archive_after_months (1..120, default 12): the age rule, applied by the app.
--   * public.record_archive_state: the manual choices only (Archive now / keep Active), one row per record.
--     Kept apart from the records so issued-document locks (019, 027) are untouched, and an archive choice never
--     counts as editing an issued document.
--   * public.set_archive_state(table, id, state): admin and office only, same company only; 'auto' removes the
--     manual choice (back to the age rule). Readable by the company's members, writable only through the function.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

ALTER TABLE public.organization_settings ADD COLUMN IF NOT EXISTS archive_after_months INTEGER NOT NULL DEFAULT 12;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_settings_archive_after_months_check') THEN
    ALTER TABLE public.organization_settings ADD CONSTRAINT organization_settings_archive_after_months_check
      CHECK (archive_after_months BETWEEN 1 AND 120);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.record_archive_state (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  record_table TEXT NOT NULL CHECK (record_table IN ('jobs', 'quotes', 'invoices', 'purchase_orders', 'sales_orders', 'delivery_notes')),
  record_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('archived', 'active')),
  set_by UUID,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (record_table, record_id)
);
CREATE INDEX IF NOT EXISTS record_archive_state_org ON public.record_archive_state (organization_id, record_table);

ALTER TABLE public.record_archive_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "record_archive_state select" ON public.record_archive_state;
CREATE POLICY "record_archive_state select" ON public.record_archive_state
  FOR SELECT TO authenticated USING (organization_id = public.current_user_organization_id());
REVOKE ALL ON public.record_archive_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.record_archive_state TO authenticated;
GRANT ALL ON public.record_archive_state TO service_role;

CREATE OR REPLACE FUNCTION public.set_archive_state(p_table TEXT, p_id UUID, p_state TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_record_org UUID;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin and office can archive records.' USING ERRCODE = '42501';
  END IF;
  IF p_table NOT IN ('jobs', 'quotes', 'invoices', 'purchase_orders', 'sales_orders', 'delivery_notes') THEN
    RAISE EXCEPTION 'These records can''t be archived.' USING ERRCODE = '22023';
  END IF;
  IF p_state NOT IN ('archived', 'active', 'auto') THEN
    RAISE EXCEPTION 'Unknown archive state.' USING ERRCODE = '22023';
  END IF;
  EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', p_table) INTO v_record_org USING p_id;
  IF v_record_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'That record couldn''t be found.' USING ERRCODE = 'P0002';
  END IF;
  IF p_state = 'auto' THEN
    DELETE FROM public.record_archive_state WHERE record_table = p_table AND record_id = p_id;
  ELSE
    INSERT INTO public.record_archive_state (organization_id, record_table, record_id, state, set_by, set_at)
    VALUES (v_org, p_table, p_id, p_state, auth.uid(), now())
    ON CONFLICT (record_table, record_id) DO UPDATE SET state = EXCLUDED.state, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.set_archive_state(TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_archive_state(TEXT, UUID, TEXT) TO authenticated;
