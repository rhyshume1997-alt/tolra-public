-- =====================================================================================================
-- 015: business links stay inside one organisation (audit B0b: SEC14).
--
-- A foreign key only proves the linked row exists. RLS hides another organisation's rows but doesn't stop someone
-- who knows an id from writing it into a link column, so an order could point at another company's quote, customer
-- or job. Line items and machine bookings already had a same-organisation trigger (006); this adds the same trigger
-- (public.enforce_same_org_parent, unchanged) to the remaining links:
--
--   quotes.rfq_id -> rfqs                         sales_orders.quote_id / customer_id / converted_to_job_id
--   jobs.quote_id / converted_from_sales_order_id invoices.job_id -> jobs
--   delivery_notes.sales_order_id / customer_id
--
-- Kept: NULL links (legacy and manual records), ON DELETE SET NULL, and the deferrable order<->job pair used by
-- imports (a link to a row that doesn't exist yet is left to the deferred foreign key, as before).
-- The triggers only fire when the link or the organisation changes, so unrelated edits of an existing row never
-- fail because of an old link. Existing rows are NOT changed: any already-invalid link is reported below as a
-- NOTICE (and by supabase/verify/cross_org_links.sql) for a person to repair.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

DO $$
DECLARE
  spec  TEXT[];
  specs TEXT[][] := ARRAY[
    ['quotes', 'rfq_id', 'rfqs'],
    ['sales_orders', 'quote_id', 'quotes'],
    ['sales_orders', 'customer_id', 'customers'],
    ['sales_orders', 'converted_to_job_id', 'jobs'],
    ['jobs', 'quote_id', 'quotes'],
    ['jobs', 'converted_from_sales_order_id', 'sales_orders'],
    ['invoices', 'job_id', 'jobs'],
    ['delivery_notes', 'sales_order_id', 'sales_orders'],
    ['delivery_notes', 'customer_id', 'customers']
  ];
  bad   BIGINT;
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'zz_same_org_' || spec[2], spec[1]);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I, organization_id ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent(%L, %L)',
      'zz_same_org_' || spec[2], spec[2], spec[1], spec[3], spec[2]);

    EXECUTE format(
      'SELECT count(*) FROM public.%I c JOIN public.%I p ON p.id = c.%I WHERE p.organization_id <> c.organization_id',
      spec[1], spec[3], spec[2]) INTO bad;
    IF bad > 0 THEN
      RAISE NOTICE '015: % existing %.% link(s) point at another organisation (left unchanged; see supabase/verify/cross_org_links.sql)',
        bad, spec[1], spec[2];
    END IF;
  END LOOP;
END
$$;
