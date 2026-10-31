-- =====================================================================================================
-- 116: one figure a night for the Overview's money-owed trend (the owner's Overview, Money section, sparkline).
-- Before: the Overview knows only what is owed NOW (lib/dashboard-analytics owedByAge over invoices). Past balances can't be worked out
-- again from today's invoices (payments, credits and refunds change them), so there is no honest trend to draw.
-- After: public.overview_owed_snapshots keeps one row per company per London calendar day: what was owed and how much of it was late,
-- worked out by public.capture_overview_owed() with the same rule as the app (lib/receivables owed()):
--   * an invoice counts when its status (blank = draft) is not paid, draft, void, voided, cancelled, canceled, credited or written_off,
--     and its payment is not still to be confirmed (payment_unverified, 027);
--   * it counts at total - amount_paid - credited_amount + refunded_amount, never below zero;
--   * late = the part of that whose due date is before the snapshot day (due today is not late; no due date is not late).
-- The function only ever writes TODAY (London) from the invoices as they are now: it takes no date, so a past day can never be made up
-- from present balances. Run again the same day, it replaces that day's figures (a later run sees the later payments).
-- Called nightly by app/api/cron/overview-snapshot (vercel.json), with the service role key.
-- Who reads: the company's admins only (the Overview is admin only), and only while the company's Invoices page is switched on
-- (section_allowed('invoices'), as invoices themselves). Nobody signed in can insert, change or delete a row; only the function writes.
-- Needs 000 (organizations, invoices), 027 (payment_unverified), 034 (credited_amount, refunded_amount), 036 (current_user_organization_id,
-- has_org_role, section_allowed, support_readonly_guard). Replaces no existing object. Safe to run again.
-- Until this is applied the app hides the sparkline and the cron route answers "skipped: not configured", so deploy order does not matter.
-- NUMBERING: 116 is a working number. The table holds company ids, dates and two sums of money; no names, no invoice detail.
-- =====================================================================================================

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.invoices') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.section_allowed(text)') IS NULL OR to_regprocedure('public.support_readonly_guard()') IS NULL THEN
    RAISE EXCEPTION '116 needs 000 (organizations, invoices) and 036 (current_user_organization_id, has_org_role, section_allowed, support_readonly_guard)';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices'
        AND column_name IN ('payment_unverified', 'credited_amount', 'refunded_amount', 'amount_paid', 'due_date')) <> 5 THEN
    RAISE EXCEPTION '116 needs invoices.payment_unverified (027), credited_amount and refunded_amount (034), amount_paid and due_date';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 1. The table: one row per company per London day.
CREATE TABLE IF NOT EXISTS public.overview_owed_snapshots (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  snapshot_date   DATE NOT NULL,
  owed_amount     NUMERIC(14,2) NOT NULL CHECK (owed_amount >= 0),
  late_amount     NUMERIC(14,2) NOT NULL CHECK (late_amount >= 0),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, snapshot_date),
  CONSTRAINT overview_owed_snapshots_late_within_owed CHECK (late_amount <= owed_amount)
);

ALTER TABLE public.overview_owed_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "overview_owed_snapshots admin select" ON public.overview_owed_snapshots;
CREATE POLICY "overview_owed_snapshots admin select" ON public.overview_owed_snapshots FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "overview_owed_snapshots section access" ON public.overview_owed_snapshots;
CREATE POLICY "overview_owed_snapshots section access" ON public.overview_owed_snapshots AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.section_allowed('invoices'))) WITH CHECK ((SELECT public.section_allowed('invoices')));

REVOKE ALL ON public.overview_owed_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.overview_owed_snapshots TO authenticated;

-- A support session stays read-only here too (every company table carries this trigger).
DROP TRIGGER IF EXISTS support_read_only ON public.overview_owed_snapshots;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.overview_owed_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();

-- -----------------------------------------------------------------------------------------------------
-- 2. The capture: today's figures for every company, from the invoices as they are now. Returns how many companies it wrote.
CREATE OR REPLACE FUNCTION public.capture_overview_owed()
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_day   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_count INTEGER;
BEGIN
  INSERT INTO public.overview_owed_snapshots (organization_id, snapshot_date, owed_amount, late_amount, captured_at)
  SELECT o.id, v_day, coalesce(sum(b.owed), 0), coalesce(sum(b.owed) FILTER (WHERE b.due_date < v_day), 0), now()
  FROM public.organizations o
  LEFT JOIN LATERAL (
    SELECT i.due_date,
           greatest(0, coalesce(i.total, 0) - coalesce(i.amount_paid, 0) - coalesce(i.credited_amount, 0) + coalesce(i.refunded_amount, 0)) AS owed
    FROM public.invoices i
    WHERE i.organization_id = o.id
      AND coalesce(nullif(lower(btrim(i.status)), ''), 'draft') NOT IN ('paid', 'draft', 'void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off')
      AND NOT coalesce(i.payment_unverified, FALSE)
  ) b ON TRUE
  GROUP BY o.id
  ON CONFLICT (organization_id, snapshot_date) DO UPDATE
    SET owed_amount = EXCLUDED.owed_amount, late_amount = EXCLUDED.late_amount, captured_at = EXCLUDED.captured_at;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 3. Who may call it: the service role only (the nightly job). Nobody signed in, and not anon.
REVOKE ALL ON FUNCTION public.capture_overview_owed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_overview_owed() TO service_role;
