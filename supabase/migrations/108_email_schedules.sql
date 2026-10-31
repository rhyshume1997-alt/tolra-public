-- =====================================================================================================
-- 108: e-mail schedules (E12 invoice reminders, E13 timesheet e-mails). Per company, per kind ('invoice_reminder', 'timesheet'): on or
-- off, daily / weekly (a weekday) / once (a date and time), a time of day, the time zone (Europe/London by default) and, for timesheets,
-- who gets them. The cron (CRON_SECRET) finds what is due and sends through lib/email/send-company-email.ts: today once a day
-- (app/api/cron/daily, vercel.json, Vercel Hobby); on Pro, app/api/cron/email-schedules every 15 minutes. EVERY SCHEDULE STARTS OFF: this file inserts no row, so nothing is sent until an admin turns one on.
-- Needs 000 (organizations, current_user_organization_id, has_org_role) and 033/036 (require_admin_mfa_guard, support_readonly_guard).
-- NUMBERING: 108 (106 = mailer and templates, 107 = integrations connect). Touches none of their objects, nor any existing object.
-- Safe to run again.
--
-- WHAT IT ADDS. Four tables, one trigger function; no existing table, row, function, policy or grant changes.
--   a. public.email_schedules: one row per company per kind. Everyone in the company can read it; only an admin can write it.
--   b. public.email_schedule_runs: one row per schedule per period (period_key: the day, the ISO week or the once-time), claimed BEFORE
--      anything is sent, so two overlapping cron calls never send the same period twice. Written by the server only (service role);
--      admin and office can read it.
--   c. public.invoice_reminder_sends: one row per invoice per schedule per period, so an invoice is reminded at most once per period.
--      Written by the server only; admin and office can read it.
--   d. public.timesheet_sends: one row per schedule per period per person, claimed BEFORE that person's timesheet e-mail is sent and given
--      back if the send fails, so a period that is retaken after a crash e-mails only the people not yet sent. Written by the server only.
--   e. public.email_schedules_guard(): row trigger on (a): checks the time zone and the recipients, and stamps updated_at / updated_by
--      (not when only last_run_at changed: that is the server noting a run).
-- Rollback: supabase/release/108_email_schedules.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. Tables.
CREATE TABLE IF NOT EXISTS public.email_schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('invoice_reminder', 'timesheet')),
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  frequency       TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'once')),
  weekday         SMALLINT CHECK (weekday BETWEEN 0 AND 6),            -- 0 = Sunday ... 6 = Saturday (JavaScript's getDay)
  time_of_day     TIME NOT NULL DEFAULT '08:00',
  run_at          TIMESTAMPTZ,                                          -- 'once': the moment (the app turns a picked date and time into it)
  timezone        TEXT NOT NULL DEFAULT 'Europe/London' CHECK (length(timezone) BETWEEN 1 AND 64),
  recipients      TEXT[],                                               -- timesheet: the admin e-mails (NULL = every active admin of the company); reminders: NULL = the invoice's customer
  last_run_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID,
  UNIQUE (organization_id, kind),
  CONSTRAINT email_schedules_weekly_has_weekday CHECK (frequency <> 'weekly' OR weekday IS NOT NULL),
  CONSTRAINT email_schedules_once_has_time CHECK (frequency <> 'once' OR run_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.email_schedule_runs (
  schedule_id UUID NOT NULL REFERENCES public.email_schedules(id) ON DELETE CASCADE,
  period_key  TEXT NOT NULL CHECK (length(period_key) BETWEEN 1 AND 64),
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_count  INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  error       TEXT CHECK (error IS NULL OR length(error) <= 500),      -- a short code or sentence, never an address or a document text
  attempts    SMALLINT NOT NULL DEFAULT 1,                              -- a period that ended with an error is tried again, at most 3 times
  UNIQUE (schedule_id, period_key)
);

CREATE TABLE IF NOT EXISTS public.invoice_reminder_sends (
  invoice_id  UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES public.email_schedules(id) ON DELETE CASCADE,
  period_key  TEXT NOT NULL CHECK (length(period_key) BETWEEN 1 AND 64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, schedule_id, period_key)
);
CREATE TABLE IF NOT EXISTS public.timesheet_sends (
  schedule_id UUID NOT NULL REFERENCES public.email_schedules(id) ON DELETE CASCADE,
  period_key  TEXT NOT NULL CHECK (length(period_key) BETWEEN 1 AND 64),
  user_id     UUID NOT NULL,                                            -- the person whose week was e-mailed (no foreign key: the record outlives a login)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_reminder_sends_schedule ON public.invoice_reminder_sends (schedule_id, period_key);

-- -----------------------------------------------------------------------------------------------------
-- 2. The row trigger: a real time zone, tidy recipients, who changed it and when.
CREATE OR REPLACE FUNCTION public.email_schedules_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  r TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = NEW.timezone) THEN
    RAISE EXCEPTION 'That time zone is not recognised.' USING ERRCODE = '22023', HINT = 'bad_timezone';
  END IF;
  IF NEW.recipients IS NOT NULL THEN
    IF cardinality(NEW.recipients) > 20 THEN
      RAISE EXCEPTION 'At most 20 recipients.' USING ERRCODE = '22023', HINT = 'too_many_recipients';
    END IF;
    FOREACH r IN ARRAY NEW.recipients LOOP
      IF r IS NULL OR length(r) > 254 OR r !~ '^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$' THEN
        RAISE EXCEPTION 'One of the recipients is not a valid e-mail address.' USING ERRCODE = '22023', HINT = 'bad_recipient';
      END IF;
    END LOOP;
  END IF;
  -- The server noting that a run happened (last_run_at) is not a change of the schedule: updated_at / updated_by stay, because the
  -- cron never fires for a moment before the schedule was last changed (so switching one on at 2pm doesn't send the 8am one at once).
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'last_run_at' - 'updated_at' - 'updated_by') = (to_jsonb(OLD) - 'last_run_at' - 'updated_at' - 'updated_by') THEN
    NEW.updated_at := OLD.updated_at;
    NEW.updated_by := OLD.updated_by;
    RETURN NEW;
  END IF;
  NEW.updated_at := clock_timestamp();
  IF auth.uid() IS NOT NULL THEN NEW.updated_by := auth.uid(); ELSIF TG_OP = 'UPDATE' THEN NEW.updated_by := OLD.updated_by; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.email_schedules_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS email_schedules_guard ON public.email_schedules;
CREATE TRIGGER email_schedules_guard BEFORE INSERT OR UPDATE ON public.email_schedules FOR EACH ROW EXECUTE FUNCTION public.email_schedules_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. Row security. Schedules: the company reads, an admin writes. Runs and sends (reminders, timesheets): admin and office read; only the server writes.
ALTER TABLE public.email_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_schedule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_reminder_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_schedules member select" ON public.email_schedules;
CREATE POLICY "email_schedules member select" ON public.email_schedules FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id());
DROP POLICY IF EXISTS "email_schedules admin insert" ON public.email_schedules;
CREATE POLICY "email_schedules admin insert" ON public.email_schedules FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "email_schedules admin update" ON public.email_schedules;
CREATE POLICY "email_schedules admin update" ON public.email_schedules FOR UPDATE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']))
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "email_schedules admin delete" ON public.email_schedules;
CREATE POLICY "email_schedules admin delete" ON public.email_schedules FOR DELETE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

DROP POLICY IF EXISTS "email_schedule_runs office select" ON public.email_schedule_runs;
CREATE POLICY "email_schedule_runs office select" ON public.email_schedule_runs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.email_schedules s WHERE s.id = schedule_id AND s.organization_id = public.current_user_organization_id())
         AND public.has_org_role(ARRAY['admin', 'office']));
DROP POLICY IF EXISTS "invoice_reminder_sends office select" ON public.invoice_reminder_sends;
CREATE POLICY "invoice_reminder_sends office select" ON public.invoice_reminder_sends FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.email_schedules s WHERE s.id = schedule_id AND s.organization_id = public.current_user_organization_id())
         AND public.has_org_role(ARRAY['admin', 'office']));

DROP POLICY IF EXISTS "timesheet_sends office select" ON public.timesheet_sends;
CREATE POLICY "timesheet_sends office select" ON public.timesheet_sends FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.email_schedules s WHERE s.id = schedule_id AND s.organization_id = public.current_user_organization_id())
         AND public.has_org_role(ARRAY['admin', 'office']));

REVOKE ALL ON public.email_schedules, public.email_schedule_runs, public.invoice_reminder_sends, public.timesheet_sends FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_schedules TO authenticated;
GRANT SELECT ON public.email_schedule_runs, public.invoice_reminder_sends, public.timesheet_sends TO authenticated;

-- A support session can't change a schedule; an admin who needs the second step must have it (the same guards as every settings table).
DROP TRIGGER IF EXISTS support_read_only ON public.email_schedules;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.email_schedules FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.email_schedules;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.email_schedules FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
