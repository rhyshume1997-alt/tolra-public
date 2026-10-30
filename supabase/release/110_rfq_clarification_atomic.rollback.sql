-- 110 rollback: ONLY with Rhys's approval. Removes public.log_rfq_clarification. Deploy the app version from before 110 FIRST
-- (it logs the e-mail and moves the RFQ in two requests); the 110 app calls the function and would show "Couldn't log the email"
-- without it. No table or row is changed: e-mails already logged stay in email_history and RFQs keep their status. Run the whole
-- text as one transaction, then the release preflight (marker 110 shows "not applied").
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'log_rfq_clarification'
             AND (p.oid <> coalesce(to_regprocedure('public.log_rfq_clarification(uuid,text,text)')::oid, 0::oid) OR NOT p.prosecdef)) THEN
    RAISE EXCEPTION '110 rollback: public.log_rfq_clarification is not 110''s; stop and compare it first';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS public.log_rfq_clarification(UUID, TEXT, TEXT);
COMMIT;
