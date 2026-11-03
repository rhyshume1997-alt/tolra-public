-- 137 rollback: ONLY with Rhys's approval. Run as postgres in the SQL editor. It needs no ownership of auth.users: auth.users belongs to
-- supabase_auth_admin and postgres is not a member of it, so postgres can't drop or alter a trigger there. Therefore:
--   - LEFT IN PLACE, ON PURPOSE: the trigger password_change_ticket on auth.users (BEFORE UPDATE, FOR EACH ROW) and its function
--     public.auth_users_password_change_ticket(), whose body becomes a pass-through (RETURN NEW). It is still SECURITY DEFINER with the
--     pinned search_path, and still executable by nobody. It does nothing: every UPDATE of auth.users goes through unchanged. The
--     release preflight shows marker 137 "not applied" and its "137 needs" row shows the trigger as "no-op".
--   - DROPPED: public.issue_password_change_ticket(uuid, text), public.revoke_password_change_ticket(uuid) and the table
--     security_audit.password_change_tickets (single-use tickets of at most 60 seconds and their used / expired history; nothing else
--     refers to them).
-- 137 changed nothing else (no existing function, table, column, policy, grant or row). After it, a signed-in person can again change
-- their own password straight through Supabase Auth (PUT /auth/v1/user), skipping the app's route. Roll back the APP first or together:
-- the app's routes treat a missing issue_password_change_ticket as "137 not applied" and go on without a ticket. Running the 137
-- release again later puts 137's body back into the same function (CREATE OR REPLACE); the attached trigger passes its shape check.
-- Removing the leftover trigger itself needs the table's owner (Supabase support); it is harmless as it is.
-- Refused when 137 is not applied (no trigger password_change_ticket on auth.users). Run the whole text as one transaction, then the
-- release preflight.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'password_change_ticket'
                 AND t.tgfoid = to_regprocedure('public.auth_users_password_change_ticket()')) THEN
    RAISE EXCEPTION '137 rollback: 137 is not applied here (no trigger password_change_ticket on auth.users calling 137''s function); nothing to roll back';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.auth_users_password_change_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.auth_users_password_change_ticket() FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.issue_password_change_ticket(uuid, text);
DROP FUNCTION IF EXISTS public.revoke_password_change_ticket(uuid);
DROP TABLE IF EXISTS security_audit.password_change_tickets;

DO $$
BEGIN
  IF to_regprocedure('public.issue_password_change_ticket(uuid,text)') IS NOT NULL OR to_regprocedure('public.revoke_password_change_ticket(uuid)') IS NOT NULL
     OR to_regclass('security_audit.password_change_tickets') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.auth_users_password_change_ticket()')
                    AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '9a9b6d9beba469441f646d038720863d'
                    AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'])
     OR has_function_privilege('authenticated', 'public.auth_users_password_change_ticket()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.auth_users_password_change_ticket()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.auth_users_password_change_ticket()', 'EXECUTE') THEN
    RAISE EXCEPTION '137 rollback: the database is not the chain before 137 plus the pass-through trigger function';
  END IF;
END
$$;
COMMIT;
