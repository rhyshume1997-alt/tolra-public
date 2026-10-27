-- 096 rollback: ONLY with Rhys's approval. Removes the AI helper's four tables and seven functions: every company's switches, cap,
-- usage ledger, stored (encrypted) API key and suggestion records go with them. The app then answers "not available" (the status call
-- fails), so no AI UI shows. Draft quotes a person approved stay (they are normal quotes). Audit rows already written stay (the audit
-- log is append-only). Nothing else is touched: 096 replaced no existing object. Run the whole text as one transaction, then the release
-- preflight (marker 096 shows "not applied").
BEGIN;

DROP FUNCTION IF EXISTS public.ai_helper_decide(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.ai_helper_settle(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.ai_helper_reserve(TEXT, INTEGER, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.ai_helper_set_key(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ai_helper_save_settings(BOOLEAN, BOOLEAN, INTEGER);
DROP FUNCTION IF EXISTS public.ai_helper_status();
DROP FUNCTION IF EXISTS public._ai_helper_caller(TEXT[]);
DROP FUNCTION IF EXISTS public._ai_helper_audit(UUID, TEXT, TEXT, TEXT, JSONB);

DROP TABLE IF EXISTS public.ai_helper_requests;
DROP TABLE IF EXISTS public.ai_helper_usage;
DROP TABLE IF EXISTS public.ai_helper_secrets;
DROP TABLE IF EXISTS public.ai_helper_settings;

DO $$
BEGIN
  IF to_regclass('public.ai_helper_settings') IS NOT NULL OR to_regclass('public.ai_helper_secrets') IS NOT NULL
     OR to_regclass('public.ai_helper_usage') IS NOT NULL OR to_regclass('public.ai_helper_requests') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%ai\_helper%') THEN
    RAISE EXCEPTION '096 rollback: an AI helper table or function is still there';
  END IF;
END
$$;

COMMIT;
