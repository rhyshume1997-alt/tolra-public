-- READ ONLY. Migration 035 (who did what): run in a read-only transaction AFTER applying 035 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 5 are facts about the schema and must be "true". Row 6 must be 0. Rows 7 onwards
-- count, per milestone that has happened, how many have a recorded actor and how many were left blank (the backfill fills only
-- what the activity trail proves, so blank rows are expected on data older than 035); their expected value is "informational".
-- Row 21 must be 0 and row 22 "true" (no e-mail address as an inspector's name or in the history).
WITH
fn AS (SELECT p.proname, p.prosrc, p.prosecdef, p.proargnames FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'security_audit')),
trg AS (SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal),
milestones(milestone, filled, blank) AS (
  SELECT 'Jobs started (started_by)', count(*) FILTER (WHERE started_by IS NOT NULL), count(*) FILTER (WHERE started_by IS NULL) FROM public.jobs WHERE started_at IS NOT NULL
  UNION ALL SELECT 'Jobs finished (finished_by)', count(*) FILTER (WHERE finished_by IS NOT NULL), count(*) FILTER (WHERE finished_by IS NULL) FROM public.jobs WHERE finished_at IS NOT NULL
  UNION ALL SELECT 'Jobs inspected (inspected_by_user)', count(*) FILTER (WHERE inspected_by_user IS NOT NULL), count(*) FILTER (WHERE inspected_by_user IS NULL) FROM public.jobs WHERE inspected_at IS NOT NULL
  UNION ALL SELECT 'Quotes sent (sent_by)', count(*) FILTER (WHERE sent_by IS NOT NULL), count(*) FILTER (WHERE sent_by IS NULL) FROM public.quotes WHERE sent_at IS NOT NULL
  UNION ALL SELECT 'Quotes accepted (accepted_by)', count(*) FILTER (WHERE accepted_by IS NOT NULL), count(*) FILTER (WHERE accepted_by IS NULL) FROM public.quotes WHERE accepted_at IS NOT NULL
  UNION ALL SELECT 'Invoices issued (issued_by)', count(*) FILTER (WHERE issued_by IS NOT NULL), count(*) FILTER (WHERE issued_by IS NULL) FROM public.invoices WHERE coalesce(status, 'draft') <> 'draft'
  UNION ALL SELECT 'Invoices paid (paid_by)', count(*) FILTER (WHERE paid_by IS NOT NULL), count(*) FILTER (WHERE paid_by IS NULL) FROM public.invoices WHERE status = 'paid'
  UNION ALL SELECT 'Invoices e-mailed (emailed_by)', count(*) FILTER (WHERE emailed_by IS NOT NULL), count(*) FILTER (WHERE emailed_by IS NULL) FROM public.invoices WHERE sent_date IS NOT NULL
  UNION ALL SELECT 'Sales orders confirmed (confirmed_by)', count(*) FILTER (WHERE confirmed_by IS NOT NULL), count(*) FILTER (WHERE confirmed_by IS NULL) FROM public.sales_orders WHERE status = 'confirmed'
  UNION ALL SELECT 'Purchase orders received (received_by)', count(*) FILTER (WHERE received_by IS NOT NULL), count(*) FILTER (WHERE received_by IS NULL) FROM public.purchase_orders WHERE received_at IS NOT NULL
  UNION ALL SELECT 'Delivery notes despatched (despatched_by)', count(*) FILTER (WHERE despatched_by IS NOT NULL), count(*) FILTER (WHERE despatched_by IS NULL) FROM public.delivery_notes WHERE status IN ('despatched', 'delivered', 'signed')
  UNION ALL SELECT 'Delivery notes signed (signed_recorded_by)', count(*) FILTER (WHERE signed_recorded_by IS NOT NULL), count(*) FILTER (WHERE signed_recorded_by IS NULL) FROM public.delivery_notes WHERE signed_at IS NOT NULL
  UNION ALL SELECT 'Delivery notes e-mailed (emailed_by)', count(*) FILTER (WHERE emailed_by IS NOT NULL), count(*) FILTER (WHERE emailed_by IS NULL) FROM public.delivery_notes WHERE emailed_at IS NOT NULL
  UNION ALL SELECT 'Credit notes issued (issued_by)', count(*) FILTER (WHERE issued_by IS NOT NULL), count(*) FILTER (WHERE issued_by IS NULL) FROM public.credit_notes WHERE status = 'issued'
),
stray AS (
  -- An actor recorded for a milestone that has not happened (or happened and was undone).
  SELECT (SELECT count(*) FROM public.jobs WHERE (started_by IS NOT NULL AND started_at IS NULL) OR (finished_by IS NOT NULL AND finished_at IS NULL) OR (inspected_by_user IS NOT NULL AND inspected_at IS NULL))
       + (SELECT count(*) FROM public.quotes WHERE (sent_by IS NOT NULL AND sent_at IS NULL) OR (accepted_by IS NOT NULL AND accepted_at IS NULL))
       + (SELECT count(*) FROM public.invoices WHERE (issued_by IS NOT NULL AND coalesce(status, 'draft') = 'draft') OR (paid_by IS NOT NULL AND status <> 'paid') OR (emailed_by IS NOT NULL AND sent_date IS NULL))
       + (SELECT count(*) FROM public.sales_orders WHERE confirmed_by IS NOT NULL AND confirmed_at IS NULL)
       + (SELECT count(*) FROM public.purchase_orders WHERE received_by IS NOT NULL AND received_at IS NULL)
       + (SELECT count(*) FROM public.delivery_notes WHERE (despatched_by IS NOT NULL AND despatched_at IS NULL) OR (signed_recorded_by IS NOT NULL AND signed_at IS NULL) OR (emailed_by IS NOT NULL AND emailed_at IS NULL))
       + (SELECT count(*) FROM public.credit_notes WHERE issued_by IS NOT NULL AND status <> 'issued') AS n
)
SELECT * FROM (
  SELECT 1 AS n, 'Milestone columns exist (all 17)' AS check_name,
      (SELECT count(*) = 17 FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (
        ('jobs', 'started_by'), ('jobs', 'finished_by'), ('jobs', 'inspected_by_user'), ('quotes', 'sent_by'), ('quotes', 'accepted_by'),
        ('invoices', 'issued_at'), ('invoices', 'issued_by'), ('invoices', 'paid_by'), ('invoices', 'emailed_by'),
        ('sales_orders', 'confirmed_at'), ('sales_orders', 'confirmed_by'), ('purchase_orders', 'received_by'),
        ('delivery_notes', 'despatched_at'), ('delivery_notes', 'despatched_by'), ('delivery_notes', 'signed_recorded_by'), ('delivery_notes', 'emailed_by'),
        ('credit_notes', 'issued_by')))::text AS value, 'true' AS expected
  UNION ALL SELECT 2, 'company_people() exists, is SECURITY DEFINER and returns user_id and display_name only',
      (SELECT count(*) = 1 AND bool_and(prosecdef) AND bool_and(proargnames = ARRAY['user_id', 'display_name']) FROM fn WHERE proname = 'company_people')::text, 'true'
  UNION ALL SELECT 3, 'The record history reads no e-mail address (its actor_email column is always empty)',
      (SELECT count(*) = 1 AND NOT bool_or(position('a.actor_email' IN prosrc) > 0) FROM fn WHERE proname = 'record_activity')::text, 'true'
  UNION ALL SELECT 4, 'Actor triggers exist (12 keep, 7 stamp)',
      ((SELECT count(*) = 12 FROM trg WHERE tgname = 'aa_actor_keep') AND (SELECT count(*) = 7 FROM trg WHERE tgname = 'zzz_actor_stamp'))::text, 'true'
  UNION ALL SELECT 5, 'The events are written by the database (stamp trigger and confirm function)',
      ((SELECT position('REOPEN' IN prosrc) > 0 AND position('MARK_PAID' IN prosrc) > 0 AND position('RESEND' IN prosrc) > 0 FROM fn WHERE proname = 'actor_stamp')
       AND (SELECT position('CONFIRM_STILL_OWED' IN prosrc) > 0 FROM fn WHERE proname = 'confirm_invoice_payments'))::text, 'true'
  UNION ALL SELECT 6, 'Actors recorded for a milestone that has not happened (expected 0)', (SELECT n FROM stray)::text, '0'
  UNION ALL SELECT (6 + row_number() OVER (ORDER BY milestone))::int, milestone || ': actor recorded / left blank', filled || ' recorded / ' || blank || ' blank', 'informational'
  FROM milestones
  UNION ALL SELECT 21, 'Inspector names holding an e-mail address (jobs.inspected_by, job_inspections.inspector_name), plus no-@ rules missing on the tables (expected 0)',
      ((SELECT count(*) FROM public.jobs WHERE position('@' IN inspected_by) > 0) + (SELECT count(*) FROM public.job_inspections WHERE position('@' IN inspector_name) > 0)
       + 2 - (SELECT count(*) FROM pg_constraint WHERE conname IN ('jobs_inspected_by_no_email', 'job_inspections_inspector_name_no_email')))::text, '0'
  UNION ALL SELECT 22, 'The record history and the activity log pass every old and new value through the e-mail redaction',
      ((SELECT count(*) = 2 FROM fn WHERE proname IN ('record_activity', 'org_activity') AND position('redact_emails' IN prosrc) > 0)
       AND EXISTS (SELECT 1 FROM fn WHERE proname = 'redact_emails'))::text, 'true'
) AS t
ORDER BY n;
