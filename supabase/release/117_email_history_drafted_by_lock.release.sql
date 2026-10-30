-- 117_email_history_drafted_by_lock.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 117: email_history.drafted_by can no longer be changed by a signed-in user (security proof S1-4, Low). Needs 006 (the email_history
-- row level security), 031 (reserve_mail_send). Touches no existing object; adds one function and one trigger. Safe to run again.
-- THE GAP. 006's insert policy already requires drafted_by = auth.uid() (so INSERT needs nothing here; anon has no grant on the table),
-- but the update policy only checks the company and the role, so an admin or office user could UPDATE drafted_by to any user id and so
-- re-attribute a draft or a sent email to someone else.
-- THE RULE. For a request made as anon or authenticated (the API roles), drafted_by cannot change on UPDATE. The test is on the
-- effective database user (current_user), not on the role setting the 081 to 083 guards read: reserve_mail_send (031, SECURITY DEFINER,
-- admin only) legitimately hands a retried send to the admin who retries it (drafted_by = auth.uid()), and the foreign key's ON DELETE
-- SET NULL when a profile is removed also writes the column; both run as the table owner, so they pass. service_role is not an API
-- role here and is not limited, as the other guards. The function is SECURITY INVOKER on purpose: a definer function would always see
-- its owner and the rule would never apply.
-- Verify: supabase/verify/email_history_drafted_by_117.sql (every row TRUE).
-- Rollback: supabase/release/117_email_history_drafted_by_lock.rollback.sql (drops the trigger and the function; no data changes).
-- =====================================================================================================

-- 1. The guard: what this file builds on exists.
DO $$
BEGIN
  IF to_regclass('public.email_history') IS NULL OR to_regclass('security_audit.mail_send_ledger') IS NULL THEN
    RAISE EXCEPTION '117: public.email_history or the mail send ledger (006, 031) is missing';
  END IF;
END
$$;

-- 2. The lock.
CREATE OR REPLACE FUNCTION public.email_history_drafted_by_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.drafted_by IS DISTINCT FROM OLD.drafted_by AND current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Email history: who drafted an email cannot be changed.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.email_history_drafted_by_lock() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS email_history_drafted_by_lock ON public.email_history;
CREATE TRIGGER email_history_drafted_by_lock BEFORE UPDATE OF drafted_by ON public.email_history
  FOR EACH ROW EXECUTE FUNCTION public.email_history_drafted_by_lock();

-- 3. Self-check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.email_history'::regclass AND tgname = 'email_history_drafted_by_lock'
                   AND tgenabled = 'O' AND NOT tgisinternal AND (tgtype & 16) = 16 AND (tgtype & 2) = 2 AND (tgtype & 1) = 1) THEN
    RAISE EXCEPTION '117: the drafted_by lock trigger is missing, disabled or not a row-level BEFORE UPDATE trigger';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.email_history_drafted_by_lock()'))
     OR has_function_privilege('authenticated', 'public.email_history_drafted_by_lock()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.email_history_drafted_by_lock()', 'EXECUTE') THEN
    RAISE EXCEPTION '117: the drafted_by lock function must be invoker and not callable by the API roles';
  END IF;
END
$$;

COMMIT;
