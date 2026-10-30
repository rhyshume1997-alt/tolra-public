-- 106 rollback: ONLY with Rhys's approval. Removes the company mailer's send ledger (E8: the app then sends without the retry guard
-- until 106 is back), the company e-mail templates (every company's own subject and body texts go with
-- them; the app then uses its default texts and the Email templates card says "not available"), the finance check's per-company switch
-- (every company's choice goes; the app reads it as off) and the two functions. Audit rows already written stay (the audit log is
-- append-only). Nothing else is touched: 106 replaced no existing object. Run the whole text as one transaction, then the release
-- preflight (marker 106 shows "not applied").
BEGIN;

-- E8: the company mailer's send ledger (its email_history rows stay: they are the company's e-mail record).
DROP FUNCTION IF EXISTS public.complete_company_email(UUID, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.reserve_company_email(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public._company_email_caller(UUID, UUID);
DROP TABLE IF EXISTS security_audit.company_email_sends;

DROP FUNCTION IF EXISTS public.ai_helper_set_finance_check(BOOLEAN);
ALTER TABLE IF EXISTS public.ai_helper_settings DROP COLUMN IF EXISTS finance_check_enabled;
DROP TABLE IF EXISTS public.email_templates;
DROP FUNCTION IF EXISTS public.email_templates_stamp();

DO $$
BEGIN
  IF to_regclass('public.email_templates') IS NOT NULL OR to_regprocedure('public.email_templates_stamp()') IS NOT NULL
     OR to_regprocedure('public.ai_helper_set_finance_check(boolean)') IS NOT NULL OR to_regclass('security_audit.company_email_sends') IS NOT NULL
     OR to_regprocedure('public.reserve_company_email(uuid,uuid,text,text,text,text,text,text,text)') IS NOT NULL
     OR to_regprocedure('public.complete_company_email(uuid,uuid,uuid,text)') IS NOT NULL OR to_regprocedure('public._company_email_caller(uuid,uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'finance_check_enabled') THEN
    RAISE EXCEPTION '106 rollback: a 106 object is still there';
  END IF;
END
$$;

COMMIT;
