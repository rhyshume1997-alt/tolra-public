-- 137 rollback: ONLY with Rhys's approval. Drops the trigger password_change_ticket on auth.users, its function
-- public.auth_users_password_change_ticket(), public.issue_password_change_ticket(uuid, text), public.revoke_password_change_ticket(uuid)
-- and the table security_audit.password_change_tickets (its rows are single-use tickets of at most 60 seconds and their used / expired
-- history; nothing else refers to them). 137 changed nothing else (no existing function, table, column, policy, grant or row), so the
-- database is back to the chain with 136. After it, a signed-in person can again change their own password straight through Supabase
-- Auth (PUT /auth/v1/user), skipping the app's route. Roll back the APP first or together: the app's routes treat a missing
-- issue_password_change_ticket as "137 not applied" and go on without a ticket. Run the whole text as one transaction, then the release
-- preflight (marker 137 shows "not applied").
BEGIN;
DROP TRIGGER IF EXISTS password_change_ticket ON auth.users;
DROP FUNCTION IF EXISTS public.auth_users_password_change_ticket();
DROP FUNCTION IF EXISTS public.issue_password_change_ticket(uuid, text);
DROP FUNCTION IF EXISTS public.revoke_password_change_ticket(uuid);
DROP TABLE IF EXISTS security_audit.password_change_tickets;

DO $$
BEGIN
  IF to_regprocedure('public.auth_users_password_change_ticket()') IS NOT NULL OR to_regprocedure('public.issue_password_change_ticket(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.revoke_password_change_ticket(uuid)') IS NOT NULL OR to_regclass('security_audit.password_change_tickets') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'password_change_ticket') THEN
    RAISE EXCEPTION '137 rollback: the database is not back to the chain before 137';
  END IF;
END
$$;
COMMIT;
