-- Local proof for migration 109 (each person's date format). Run on a COPY of a database with 000..108 applied plus 109:
--   createdb e_dates -T sec_base; psql -d e_dates -f supabase/release/109_user_date_format.release.sql; psql -d e_dates -f this
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises.
\set ON_ERROR_STOP 1
BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('10900000-0000-0000-0000-00000000000a', 'a.dates@example.test'),
  ('10900000-0000-0000-0000-00000000000b', 'b.dates@example.test');
INSERT INTO public.user_preferences (user_id, date_format) VALUES ('10900000-0000-0000-0000-00000000000b', 'ymd-full');

-- Person A, signed in.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"10900000-0000-0000-0000-00000000000a","role":"authenticated"}', true),
       set_config('request.jwt.claim.sub', '10900000-0000-0000-0000-00000000000a', true);
INSERT INTO public.user_preferences (user_id, date_format) VALUES ('10900000-0000-0000-0000-00000000000a', 'mdy-short');
UPDATE public.user_preferences SET date_format = 'mdy-full';
DO $$ BEGIN
  IF (SELECT count(*) FROM public.user_preferences) <> 1 THEN RAISE EXCEPTION 'FAIL A sees another person''s row'; END IF;
  IF (SELECT date_format FROM public.user_preferences) <> 'mdy-full' THEN RAISE EXCEPTION 'FAIL A own update'; END IF;
  RAISE NOTICE 'PASS A reads and updates only their own row';
END $$;
DO $$ BEGIN
  INSERT INTO public.user_preferences (user_id, date_format) VALUES ('10900000-0000-0000-0000-00000000000b', 'dmy-number');
  RAISE EXCEPTION 'FAIL A wrote B''s row';
EXCEPTION WHEN insufficient_privilege OR unique_violation THEN RAISE NOTICE 'PASS A cannot write B''s row (%)', SQLSTATE; END $$;
DO $$ DECLARE n INT; BEGIN
  UPDATE public.user_preferences SET date_format = 'dmy-number' WHERE user_id = '10900000-0000-0000-0000-00000000000b';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL A updated B''s row'; END IF;
  RAISE NOTICE 'PASS A cannot update B''s row';
END $$;
DO $$ BEGIN
  UPDATE public.user_preferences SET user_id = '10900000-0000-0000-0000-00000000000b';
  RAISE EXCEPTION 'FAIL A moved their row to B';
EXCEPTION WHEN insufficient_privilege OR unique_violation THEN RAISE NOTICE 'PASS A cannot move their row to B (%)', SQLSTATE; END $$;
DO $$ BEGIN
  DELETE FROM public.user_preferences;
  RAISE EXCEPTION 'FAIL delete allowed';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS no DELETE'; END $$;
DO $$ BEGIN
  UPDATE public.user_preferences SET date_format = 'dd-mm-yy';
  RAISE EXCEPTION 'FAIL unchecked value stored';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS only the nine formats'; END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM 1 FROM public.user_preferences;
  RAISE EXCEPTION 'FAIL anon reads user_preferences';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS nothing for anon'; END $$;
RESET ROLE;
ROLLBACK;
