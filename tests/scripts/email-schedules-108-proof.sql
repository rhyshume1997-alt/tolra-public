-- Behavioural proof for migration 108 on the plain-PostgreSQL stand-in (run on a COPY: create database e_sched template sec_base;
-- apply supabase/release/108_email_schedules.release.sql first). Everything runs in one transaction and is rolled back.
--   psql -h 127.0.0.1 -U postgres -d e_sched -v ON_ERROR_STOP=1 -f tests/scripts/email-schedules-108-proof.sql
-- Prints one line per check: PASS / FAIL. The last line is "ALL PASS" only when every check passed.
BEGIN;
CREATE TEMP TABLE proof (name TEXT, ok BOOLEAN);
GRANT ALL ON proof TO PUBLIC;

-- Two companies; an admin, an office user and a workshop user in A; an admin in B.
INSERT INTO public.organizations (id, name, slug) VALUES
  ('a0000000-0000-0000-0000-00000000000a', 'Sched A', 't-sched-a'), ('b0000000-0000-0000-0000-00000000000b', 'Sched B', 't-sched-b');
INSERT INTO auth.users (id, email) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'admin-a@example.test'), ('a2000000-0000-0000-0000-000000000002', 'office-a@example.test'),
  ('a3000000-0000-0000-0000-000000000003', 'shop-a@example.test'), ('b1000000-0000-0000-0000-000000000001', 'admin-b@example.test');
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'admin-a@example.test', 'Admin A', 'admin', 'a0000000-0000-0000-0000-00000000000a', true, false),
  ('a2000000-0000-0000-0000-000000000002', 'office-a@example.test', 'Office A', 'office', 'a0000000-0000-0000-0000-00000000000a', true, false),
  ('a3000000-0000-0000-0000-000000000003', 'shop-a@example.test', 'Shop A', 'workshop', 'a0000000-0000-0000-0000-00000000000a', true, false),
  ('b1000000-0000-0000-0000-000000000001', 'admin-b@example.test', 'Admin B', 'admin', 'b0000000-0000-0000-0000-00000000000b', true, false);
INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'admin', true),
  ('a2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'office', true),
  ('a3000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000000a', 'workshop', true),
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'admin', true)
ON CONFLICT (user_id, organization_id) DO NOTHING;

-- Helper: run one statement as a signed-in person; record whether it raised and what.
CREATE FUNCTION pg_temp.try_as(p_user UUID, p_sql TEXT, OUT err TEXT, OUT n BIGINT) LANGUAGE plpgsql AS $$
DECLARE h TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    err := NULL;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
    err := SQLSTATE || coalesce('/' || nullif(h, ''), '');
    n := 0;
  END;
  RESET ROLE;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.try_as(UUID, TEXT) TO PUBLIC;

-- 1. An admin can create a schedule; it is OFF by default.
INSERT INTO proof SELECT 'admin inserts (starts off)', (r.err IS NULL AND r.n = 1)
  FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
    $q$INSERT INTO public.email_schedules (organization_id, kind, frequency) VALUES ('a0000000-0000-0000-0000-00000000000a', 'invoice_reminder', 'daily')$q$) r;
INSERT INTO proof SELECT 'new schedule is off, 08:00, Europe/London',
  (SELECT NOT enabled AND time_of_day = '08:00' AND timezone = 'Europe/London' AND updated_by = 'a1000000-0000-0000-0000-000000000001' FROM public.email_schedules WHERE kind = 'invoice_reminder');

-- 2. Office and workshop can read but not write; the other company's admin can neither read nor write.
INSERT INTO proof SELECT 'office reads own company schedule', (r.n = 1) FROM pg_temp.try_as('a2000000-0000-0000-0000-000000000002', $q$SELECT 1 FROM public.email_schedules$q$) r;
INSERT INTO proof SELECT 'workshop reads own company schedule', (r.n = 1) FROM pg_temp.try_as('a3000000-0000-0000-0000-000000000003', $q$SELECT 1 FROM public.email_schedules$q$) r;
INSERT INTO proof SELECT 'office cannot insert', (r.err LIKE '42501%') FROM pg_temp.try_as('a2000000-0000-0000-0000-000000000002',
  $q$INSERT INTO public.email_schedules (organization_id, kind, frequency) VALUES ('a0000000-0000-0000-0000-00000000000a', 'timesheet', 'daily')$q$) r;
INSERT INTO proof SELECT 'office cannot update', (r.n = 0) FROM pg_temp.try_as('a2000000-0000-0000-0000-000000000002', $q$UPDATE public.email_schedules SET enabled = true$q$) r;
INSERT INTO proof SELECT 'workshop cannot update', (r.n = 0) FROM pg_temp.try_as('a3000000-0000-0000-0000-000000000003', $q$UPDATE public.email_schedules SET enabled = true$q$) r;
INSERT INTO proof SELECT 'office cannot delete', (r.n = 0) FROM pg_temp.try_as('a2000000-0000-0000-0000-000000000002', $q$DELETE FROM public.email_schedules$q$) r;
INSERT INTO proof SELECT 'other company admin sees nothing', (r.n = 0) FROM pg_temp.try_as('b1000000-0000-0000-0000-000000000001', $q$SELECT 1 FROM public.email_schedules$q$) r;
INSERT INTO proof SELECT 'other company admin cannot update', (r.n = 0) FROM pg_temp.try_as('b1000000-0000-0000-0000-000000000001', $q$UPDATE public.email_schedules SET enabled = true$q$) r;
INSERT INTO proof SELECT 'other company admin cannot insert into A', (r.err LIKE '42501%') FROM pg_temp.try_as('b1000000-0000-0000-0000-000000000001',
  $q$INSERT INTO public.email_schedules (organization_id, kind, frequency) VALUES ('a0000000-0000-0000-0000-00000000000a', 'timesheet', 'daily')$q$) r;
INSERT INTO proof SELECT 'still off after all refused writes', (SELECT NOT enabled FROM public.email_schedules WHERE kind = 'invoice_reminder');

-- 3. Admin updates; the row checks hold.
INSERT INTO proof SELECT 'admin turns it on weekly Monday', (r.err IS NULL AND r.n = 1) FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$UPDATE public.email_schedules SET enabled = true, frequency = 'weekly', weekday = 1, time_of_day = '09:30' WHERE kind = 'invoice_reminder'$q$) r;
INSERT INTO proof SELECT 'weekly without a weekday refused (23514)', (r.err LIKE '23514%') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$UPDATE public.email_schedules SET frequency = 'weekly', weekday = NULL WHERE kind = 'invoice_reminder'$q$) r;
INSERT INTO proof SELECT 'once without a moment refused (23514)', (r.err LIKE '23514%') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$UPDATE public.email_schedules SET frequency = 'once', run_at = NULL WHERE kind = 'invoice_reminder'$q$) r;
INSERT INTO proof SELECT 'weekday 7 refused (23514)', (r.err LIKE '23514%') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$UPDATE public.email_schedules SET weekday = 7 WHERE kind = 'invoice_reminder'$q$) r;
INSERT INTO proof SELECT 'unknown kind refused (23514)', (r.err LIKE '23514%') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$INSERT INTO public.email_schedules (organization_id, kind, frequency) VALUES ('a0000000-0000-0000-0000-00000000000a', 'newsletter', 'daily')$q$) r;
INSERT INTO proof SELECT 'second schedule of a kind refused (23505)', (r.err LIKE '23505%') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$INSERT INTO public.email_schedules (organization_id, kind, frequency) VALUES ('a0000000-0000-0000-0000-00000000000a', 'invoice_reminder', 'daily')$q$) r;
INSERT INTO proof SELECT 'bad time zone refused (22023 bad_timezone)', (r.err = '22023/bad_timezone') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$UPDATE public.email_schedules SET timezone = 'Mars/Olympus' WHERE kind = 'invoice_reminder'$q$) r;
INSERT INTO proof SELECT 'other real zone accepted', (r.err IS NULL AND r.n = 1) FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$UPDATE public.email_schedules SET timezone = 'Europe/Dublin' WHERE kind = 'invoice_reminder'$q$) r;
INSERT INTO proof SELECT 'bad recipient refused (22023 bad_recipient)', (r.err = '22023/bad_recipient') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$INSERT INTO public.email_schedules (organization_id, kind, frequency, recipients) VALUES ('a0000000-0000-0000-0000-00000000000a', 'timesheet', 'weekly', ARRAY['not an address'])$q$) r;
INSERT INTO proof SELECT 'header-injection recipient refused', (r.err = '22023/bad_recipient') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$INSERT INTO public.email_schedules (organization_id, kind, frequency, weekday, recipients) VALUES ('a0000000-0000-0000-0000-00000000000a', 'timesheet', 'weekly', 5, ARRAY[E'a@b.co\r\nBcc: x@y.co'])$q$) r;
INSERT INTO proof SELECT 'good recipients accepted', (r.err IS NULL AND r.n = 1) FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$INSERT INTO public.email_schedules (organization_id, kind, frequency, weekday, recipients) VALUES ('a0000000-0000-0000-0000-00000000000a', 'timesheet', 'weekly', 5, ARRAY['boss@example.test', 'accounts@example.test'])$q$) r;

-- 3b. The server noting a run (last_run_at) does not move updated_at; any real change does.
SELECT updated_at AS before_ts FROM public.email_schedules WHERE kind = 'invoice_reminder' \gset
SELECT pg_sleep(0.05);
UPDATE public.email_schedules SET last_run_at = now() WHERE kind = 'invoice_reminder';
INSERT INTO proof SELECT 'last_run_at alone keeps updated_at', (SELECT updated_at = :'before_ts'::timestamptz FROM public.email_schedules WHERE kind = 'invoice_reminder');
UPDATE public.email_schedules SET time_of_day = '10:00' WHERE kind = 'invoice_reminder';
INSERT INTO proof SELECT 'a real change moves updated_at', (SELECT updated_at > :'before_ts'::timestamptz FROM public.email_schedules WHERE kind = 'invoice_reminder');

-- 4. Runs and sends: members can read what the server wrote, nobody signed in can write.
INSERT INTO public.email_schedule_runs (schedule_id, period_key, sent_count) SELECT id, '2026-W44', 3 FROM public.email_schedules WHERE kind = 'timesheet';
INSERT INTO proof SELECT 'office reads runs', (r.n = 1) FROM pg_temp.try_as('a2000000-0000-0000-0000-000000000002', $q$SELECT 1 FROM public.email_schedule_runs$q$) r;
INSERT INTO proof SELECT 'workshop reads no runs', (r.n = 0) FROM pg_temp.try_as('a3000000-0000-0000-0000-000000000003', $q$SELECT 1 FROM public.email_schedule_runs$q$) r;
INSERT INTO proof SELECT 'other company reads no runs', (r.n = 0) FROM pg_temp.try_as('b1000000-0000-0000-0000-000000000001', $q$SELECT 1 FROM public.email_schedule_runs$q$) r;
INSERT INTO proof SELECT 'admin cannot write runs (42501)', (r.err LIKE '42501%') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$INSERT INTO public.email_schedule_runs (schedule_id, period_key) SELECT id, 'x' FROM public.email_schedules$q$) r;
INSERT INTO proof SELECT 'admin cannot write sends (42501)', (r.err LIKE '42501%') FROM pg_temp.try_as('a1000000-0000-0000-0000-000000000001',
  $q$DELETE FROM public.invoice_reminder_sends$q$) r;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.email_schedule_runs (schedule_id, period_key) SELECT id, '2026-W44' FROM public.email_schedules WHERE kind = 'timesheet';
    INSERT INTO proof VALUES ('same schedule+period twice refused (23505)', false);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO proof VALUES ('same schedule+period twice refused (23505)', true);
  END;
  BEGIN
    INSERT INTO public.email_schedule_runs (schedule_id, period_key) SELECT id, '2026-W44' FROM public.email_schedules WHERE kind = 'timesheet'
      ON CONFLICT (schedule_id, period_key) DO NOTHING;
    INSERT INTO proof VALUES ('ON CONFLICT DO NOTHING claims nothing the second time', NOT FOUND);
  END;
END $$;

-- 5. One reminder per invoice per schedule per period.
INSERT INTO public.invoices (id, organization_id, customer, status, invoice_ref, total, due_date)
  VALUES ('c0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-00000000000a', 'Acme', 'sent', 'INV-1', 100, '2026-10-01');
DO $$
DECLARE s UUID := (SELECT id FROM public.email_schedules WHERE kind = 'invoice_reminder');
BEGIN
  INSERT INTO public.invoice_reminder_sends (invoice_id, schedule_id, period_key) VALUES ('c0000000-0000-0000-0000-0000000000c1', s, '2026-W44');
  BEGIN
    INSERT INTO public.invoice_reminder_sends (invoice_id, schedule_id, period_key) VALUES ('c0000000-0000-0000-0000-0000000000c1', s, '2026-W44');
    INSERT INTO proof VALUES ('same invoice+schedule+period twice refused', false);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO proof VALUES ('same invoice+schedule+period twice refused', true);
  END;
  INSERT INTO invoice_reminder_sends (invoice_id, schedule_id, period_key) VALUES ('c0000000-0000-0000-0000-0000000000c1', s, '2026-W45');
  INSERT INTO proof VALUES ('same invoice next period allowed', true);
END $$;

-- 6. Deleting a schedule removes its runs and sends (cascade); deleting the company's invoice removes its send records.
DELETE FROM public.email_schedules WHERE kind = 'timesheet';
INSERT INTO proof SELECT 'cascade removes runs', NOT EXISTS (SELECT 1 FROM public.email_schedule_runs);
DELETE FROM public.invoices WHERE id = 'c0000000-0000-0000-0000-0000000000c1';
INSERT INTO proof SELECT 'cascade removes sends with the invoice', NOT EXISTS (SELECT 1 FROM public.invoice_reminder_sends);

SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, name FROM proof ORDER BY ok, name;
SELECT CASE WHEN bool_and(ok) THEN 'ALL PASS (' || count(*) || ')' ELSE 'SOME FAILED' END AS summary FROM proof;
ROLLBACK;
