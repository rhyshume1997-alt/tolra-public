-- Rollback of 090 (a clock action is recorded only in the company it was made in). ONE transaction: run the whole text; if anything
-- fails, nothing of it is kept. Only with Rhys's approval. Removes the function public.record_attendance_event_in_company();
-- 050's four-argument function, every table, row, policy and grant stay as they are (090 changed nothing else). Afterwards an app
-- build from 090 on holds every clock action as "Tolra needs updating" (nothing is lost) until 090 is applied again or the app is
-- rolled back too. STOPS (nothing changed) while the function exists with a body other than 090's. Safe to run twice. Then
-- `notify pgrst, 'reload schema';` and the release preflight (marker 090 "not applied").
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'b27723bfaaf334678d8d23bb1c1f0756') THEN
    RAISE EXCEPTION '090 rollback: public.record_attendance_event_in_company() is not 090''s; stop and compare';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.record_attendance_event_in_company(UUID, TEXT, TIMESTAMPTZ, TEXT, UUID);

DO $$
BEGIN
  IF to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '090 rollback: the function is still there';
  END IF;
  IF to_regprocedure('public.record_attendance_event(uuid,text,timestamp with time zone,text)') IS NULL THEN
    RAISE EXCEPTION '090 rollback: 050''s record_attendance_event is missing';
  END IF;
END
$$;

COMMIT;
