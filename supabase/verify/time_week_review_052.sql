-- Migration 052 (weekly review and approval of hours). Read only: every row should be TRUE.
SELECT 'table_present' AS check_name, to_regclass('public.time_week_approvals') IS NOT NULL AS ok
UNION ALL SELECT 'rls_enabled', (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.time_week_approvals'::regclass)
UNION ALL SELECT 'no_direct_api_writes', NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
  WHERE has_table_privilege(r, 'public.time_week_approvals', p))
  AND NOT has_table_privilege('anon', 'public.time_week_approvals', 'SELECT')
UNION ALL SELECT 'readers_and_approve_signed_in_only', (
  SELECT bool_and(p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
         AND count(*) = 2
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('time_week_status', 'approve_time_week'))
UNION ALL SELECT 'internal_functions_only', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('time_week_revision', 'time_week_locked', 'time_week_locked_at', 'time_week_approvals_immutable')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')))
-- 050's placeholder was replaced: an approved week is locked for the person (the body reads time_week_approvals).
UNION ALL SELECT 'week_lock_live', (
  SELECT p.prosrc LIKE '%time_week_approvals%' FROM pg_proc p WHERE p.oid = 'public.time_week_locked(uuid, uuid, date)'::regprocedure)
  AND (SELECT p.prosrc LIKE '%time_week_approvals%' FROM pg_proc p WHERE p.oid = 'public.time_week_locked_at(uuid, uuid, timestamptz)'::regprocedure)
-- approve_time_week takes the person's clock lock, then their labour lock (each after the company's audit-chain lock), BEFORE it works
-- out the revision: a clock or labour write of that person (050, 051) either committed before (the revision includes it) or waits and
-- then sees the approval.
UNION ALL SELECT 'approve_locks_first', (
  SELECT position('attendance_lock(' IN p.prosrc) BETWEEN 1 AND position('labour_lock(' IN p.prosrc)
         AND position('labour_lock(' IN p.prosrc) < position('time_week_revision(' IN p.prosrc)
  FROM pg_proc p WHERE p.oid = 'public.approve_time_week(uuid, date, text, jsonb, text)'::regprocedure)
UNION ALL SELECT 'record_guards', (
  SELECT count(*) = 4 FROM pg_trigger WHERE tgrelid = 'public.time_week_approvals'::regclass AND tgenabled = 'O'
    AND tgname IN ('time_week_approvals_immutable', 'time_week_approvals_no_truncate', 'support_read_only', 'admin_mfa'))
-- Data: every approval is of a Monday, by someone of that company, for someone of that company.
UNION ALL SELECT 'approvals_consistent', NOT EXISTS (
  SELECT 1 FROM public.time_week_approvals a
  WHERE extract(isodow FROM a.week_start) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = a.organization_id AND m.user_id = a.user_id)
     OR (a.approved_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = a.organization_id AND m.user_id = a.approved_by)));

-- Informational: approved weeks whose records changed since (show as "Changed since approval" until approved again).
SELECT o.slug AS company, a.user_id, a.week_start, a.approved_at
FROM (SELECT DISTINCT ON (organization_id, user_id, week_start) * FROM public.time_week_approvals ORDER BY organization_id, user_id, week_start, approved_at DESC, id) a
JOIN public.organizations o ON o.id = a.organization_id
WHERE a.revision <> public.time_week_revision(a.organization_id, a.user_id, a.week_start)
ORDER BY a.week_start DESC, o.slug LIMIT 50;
