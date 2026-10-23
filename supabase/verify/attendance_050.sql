-- Migration 050 (attendance and time settings). Read only: every row should be TRUE.
SELECT 'tables_present' AS check_name,
  to_regclass('public.attendance_events') IS NOT NULL AND to_regclass('public.time_settings') IS NOT NULL AND to_regclass('public.bank_holidays') IS NOT NULL AS ok
UNION ALL SELECT 'rls_enabled', (
  SELECT bool_and(c.relrowsecurity) AND count(*) = 3 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('attendance_events', 'time_settings', 'bank_holidays'))
-- No API role writes these tables directly (every write goes through the functions); anon reads nothing.
UNION ALL SELECT 'no_direct_api_writes', NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['attendance_events', 'time_settings', 'bank_holidays']) t, unnest(ARRAY['anon', 'authenticated']) r,
                unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
  WHERE has_table_privilege(r, 'public.' || t, p))
UNION ALL SELECT 'anon_reads_nothing', NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['attendance_events', 'time_settings', 'bank_holidays']) t WHERE has_table_privilege('anon', 'public.' || t, 'SELECT'))
UNION ALL SELECT 'writers_signed_in_only', (
  SELECT bool_and(p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
         AND count(*) = 3
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('record_attendance_event', 'correct_attendance_event', 'save_time_settings'))
UNION ALL SELECT 'internal_functions_only', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('time_week_of', 'time_week_locked', 'time_week_locked_at', 'attendance_client_time', 'time_caller_org', 'attendance_answer', 'attendance_events_immutable',
                      'time_company_lock', 'attendance_lock')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')))
-- Clock records are never changed or removed; support sessions are read-only; admins at aal1 are refused when the company requires it.
UNION ALL SELECT 'record_guards', (
  SELECT count(*) = 4 FROM pg_trigger WHERE tgrelid = 'public.attendance_events'::regclass AND tgenabled = 'O'
    AND tgname IN ('attendance_events_immutable', 'attendance_events_no_truncate', 'support_read_only', 'admin_mfa'))
  AND (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.time_settings'::regclass AND tgenabled = 'O' AND tgname IN ('support_read_only', 'admin_mfa'))
-- Lock order: the company's audit-chain lock, then the person's clock lock, both taken before a clock write asks whether the week is
-- approved (an approval, 052, takes the same locks, so the two never cross and never deadlock).
UNION ALL SELECT 'lock_before_week_check', (
  SELECT position('time_company_lock(' IN p.prosrc) BETWEEN 1 AND position('''attendance:''' IN p.prosrc)
  FROM pg_proc p WHERE p.oid = 'public.attendance_lock(uuid, uuid)'::regprocedure)
  AND (SELECT bool_and(position('attendance_lock(' IN p.prosrc) BETWEEN 1 AND position('time_week_locked' IN p.prosrc)) AND count(*) = 2
       FROM pg_proc p
       WHERE p.oid IN ('public.record_attendance_event(uuid, text, timestamptz, text)'::regprocedure,
                       'public.correct_attendance_event(uuid, uuid, uuid, text, timestamptz, text)'::regprocedure))
UNION ALL SELECT 'one_key_one_record', EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid = 'public.attendance_events'::regclass AND conname = 'attendance_events_client_op' AND contype = 'u')
  AND to_regclass('public.attendance_events_one_replacement') IS NOT NULL
UNION ALL SELECT 'bank_holidays_seeded', (
  SELECT count(*) >= 16 FROM public.bank_holidays WHERE region = 'england-and-wales' AND day BETWEEN DATE '2026-01-01' AND DATE '2027-12-31')
-- Data: a correction always names a row of the same person and company, and carries a reason.
UNION ALL SELECT 'corrections_consistent', NOT EXISTS (
  SELECT 1 FROM public.attendance_events c LEFT JOIN public.attendance_events o ON o.id = c.supersedes
  WHERE c.supersedes IS NOT NULL AND (o.id IS NULL OR o.organization_id <> c.organization_id OR o.user_id <> c.user_id))
  AND NOT EXISTS (SELECT 1 FROM public.attendance_events WHERE source = 'correction' AND length(btrim(coalesce(reason, ''))) < 3)
-- Data: every record belongs to someone who is (or was) in that company.
UNION ALL SELECT 'records_of_members', NOT EXISTS (
  SELECT 1 FROM public.attendance_events e
  WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = e.organization_id AND m.user_id = e.user_id));
