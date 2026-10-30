-- 113 rollback: ONLY with Rhys's approval. Removes the reopen sign-off table and its four functions: every reopen request, its approval
-- mode and the admin's decision go with them. Reopens already done stay done (they are reopen_job's, 081, with its own job flow event
-- and activity). The app then falls back to today's Reopen (reopen_job with a reason) and says "Admin approval recording is available
-- after database update 113". Audit rows already written stay (the audit log is append-only). Nothing else is touched: 113 replaced no
-- existing object. Run the whole text as one transaction, then the release preflight (marker 113 shows "not applied").
BEGIN;

DROP FUNCTION IF EXISTS public.decide_reopen_request(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.reopen_record(TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.reopen_preview(TEXT, UUID);
DROP FUNCTION IF EXISTS public._reopen_audit(UUID, TEXT, UUID, JSONB);

DROP TABLE IF EXISTS public.reopen_requests;

DO $$
BEGIN
  IF to_regclass('public.reopen_requests') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('reopen_record', 'reopen_preview', 'decide_reopen_request', '_reopen_audit')) THEN
    RAISE EXCEPTION '113 rollback: a reopen sign-off table or function is still there';
  END IF;
  IF to_regprocedure('public.reopen_job(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '113 rollback: reopen_job (081) is missing; it must never be dropped by this rollback';
  END IF;
END
$$;

COMMIT;
