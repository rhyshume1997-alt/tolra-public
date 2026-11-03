-- 137_password_change_ticket.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 137: G1, a password is changed only through Tolra's own server routes (working number, after 136). Review Pack 19c: a signed-in
-- person can change their OWN password straight through Supabase Auth (supabase.auth.updateUser, PUT /auth/v1/user with their own
-- token), which skips /api/auth/change-password and its rules (the current password; for an admin, an authenticator code from the last
-- 15 minutes, requireRecentAal2 / recentSecondStep). Supabase has no setting for that rule (secure_password_change only asks for an
-- e-mailed nonce when the SESSION is over 24 hours old: GoTrue internal/api/user.go, UpdatePasswordRequireReauthentication). This file
-- closes the door in the database, where Auth stores the password.
--
-- HOW. Every password change Auth makes is one UPDATE of auth.users.encrypted_password, by Auth's own database role, inside Auth's
-- transaction (GoTrue models.User.UpdatePassword, called from PUT /user and PUT /admin/users/{id}). The app's routes, AFTER all their
-- own checks pass, issue a single-use TICKET for that one login with the service role, then ask Auth to change the password. A trigger
-- on auth.users refuses a password change unless an unexpired, unused ticket for that login exists, and uses it up (in Auth's own
-- transaction: if Auth's change fails, the ticket is not used). A direct call to Auth with a person's own token has no ticket, so Auth
-- answers 500 (Error during password storage) and the password stays as it was.
--
-- WHAT CHANGES. One table, three functions, one trigger; no existing function, table, column, policy, grant or row is changed.
--   a. security_audit.password_change_tickets: id, user_id, purpose ('own_change' | 'admin_set' | 'operator'), created_at, expires_at
--      (60 seconds after issue), used_at. Row-level security on and no policy; no grant to anyone (not anon, authenticated or the service
--      role): only the three functions below read or write it. A used or expired row is deleted 7 days after it expired, at the next issue.
--   b. public.issue_password_change_ticket(p_user_id uuid, p_purpose text) RETURNS uuid: SECURITY DEFINER, search_path pinned; EXECUTE for
--      the service role only (the app's server). Refused (42501) to a signed-in or anonymous caller even if a grant were added; the
--      login must exist (P0002); the purpose must be one of the three (22023). Returns the ticket's id.
--   c. public.revoke_password_change_ticket(p_ticket uuid) RETURNS boolean: SECURITY DEFINER, service role only, the same refusal. Deletes
--      that ticket if it is still unused (true), so a ticket a route did not need does not wait out its 60 seconds.
--   d. public.auth_users_password_change_ticket() RETURNS TRIGGER: SECURITY DEFINER, search_path pinned, executable by nobody. On an
--      UPDATE of auth.users whose encrypted_password CHANGES (an UPDATE that leaves it as it was is not asked), it lets through only:
--        - a change with a ticket: the oldest unexpired, unused ticket of that login is marked used (FOR UPDATE SKIP LOCKED: one ticket,
--          one change, even for two changes at once);
--        - Auth's own housekeeping, which never lets anyone choose a password, read from GoTrue's source:
--            removing the password of a login whose e-mail was never confirmed (ClearUnconfirmedPassword, RemoveUnconfirmedIdentities:
--            verify.go, magic_link.go, signup.go, external.go) or of a login being soft-deleted (SoftDeleteUser, admin.go: deleted_at
--            set in the same UPDATE);
--            the random 64-character password Auth sets when an INVITED login with no password and an unconfirmed e-mail accepts its
--            invite (signupVerify, verify.go, before Confirm). Nobody knows that password; the person then chooses theirs through the app.
--      Anything else is refused: 42501, HINT password_change_ticket_required. It applies to EVERY role (Auth's, the service role's, the
--      SQL editor's). To change a password by hand (SQL editor, or a dashboard action that sets one), first run, as the owner, within
--      60 seconds of the change:  SELECT public.issue_password_change_ticket('<the login''s user id>', 'operator');
--      A password reset e-mail sent from the dashboard needs nothing: its link opens Tolra's Choose your password page (the route).
--   e. TRIGGER password_change_ticket, BEFORE UPDATE, FOR EACH ROW, on auth.users. No column list (UPDATE OF), so the trigger does not
--      pin the column's type for Auth's own future schema changes; the function returns at once when the password did not change.
--      auth.users belongs to supabase_auth_admin and the SQL editor's postgres is not a member of it (production, checked read-only):
--      postgres may CREATE a trigger there (TRIGGER privilege) but not DROP or ALTER one. So this file never drops or alters the
--      trigger: it creates it only when it is missing, and when it is there it checks its shape (137's function, BEFORE UPDATE, FOR
--      EACH ROW, enabled): the same shape is left as it is (a second run, or a re-release after the rollback, which leaves the trigger
--      attached to a pass-through body that CREATE OR REPLACE above turns back into 137's); any other shape stops the file.
-- INSERTS ARE NOT ASKED: creating a login with a password (Admin > Users "Add", auth.admin.createUser) and every invite stay as they are.
-- SIGN-IN: this GoTrue writes encrypted_password at sign-in only when Auth's column encryption is on (token.go, shouldReEncrypt). The
-- guard (section 1) stops the file when any stored password is already in that encrypted form ('{...}'), so a sign-in is never refused.
-- IF GoTrue's DB (column) encryption is ever switched on, every sign-in would try to rewrite the stored hash and be refused by this
-- trigger: roll 137 back FIRST (supabase/release/137_password_change_ticket.rollback.sql), then switch encryption on.
-- GUARD (section 1): auth.users has the columns this reads, the schema security_audit exists, this role may create a trigger on
-- auth.users (as 007 and 012 did), no stored password is in the encrypted form, and any existing ticket table has this file's shape.
-- SELF-CHECK (section 6). Safe to run again, as a role that does not own auth.users (CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE,
-- the trigger created only when missing).
-- Verify: supabase/verify/password_change_ticket_137.sql (every row TRUE); every earlier verify file reads as it did before.
-- Rollback: supabase/release/137_password_change_ticket.rollback.sql (only with Rhys's approval): drops the two ticket functions and
-- the table, and turns the trigger function into a pass-through (RETURN NEW); the trigger itself stays attached and does nothing,
-- because postgres can't drop a trigger on auth.users.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users'
         AND column_name IN ('id', 'encrypted_password', 'email_confirmed_at', 'invited_at', 'deleted_at')) <> 5
     OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'security_audit') THEN
    RAISE EXCEPTION '137: auth.users (id, encrypted_password, email_confirmed_at, invited_at, deleted_at) or the schema security_audit is missing';
  END IF;
  IF NOT has_table_privilege(current_user, 'auth.users', 'TRIGGER') THEN
    RAISE EXCEPTION '137: % may not create a trigger on auth.users (007 and 012 did); stop and report', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u WHERE u.encrypted_password LIKE '{%') THEN
    RAISE EXCEPTION '137: some stored passwords use Auth''s column encryption, which rewrites them at sign-in; stop and report';
  END IF;
  IF to_regclass('security_audit.password_change_tickets') IS NOT NULL
     AND (SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable, ', ' ORDER BY ordinal_position) FROM information_schema.columns
          WHERE table_schema = 'security_audit' AND table_name = 'password_change_tickets')
         IS DISTINCT FROM 'id uuid NO, user_id uuid NO, purpose text NO, created_at timestamp with time zone NO, expires_at timestamp with time zone NO, used_at timestamp with time zone YES' THEN
    RAISE EXCEPTION '137: security_audit.password_change_tickets exists with another shape; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The tickets: closed to everyone; only the functions below use it.
CREATE TABLE IF NOT EXISTS security_audit.password_change_tickets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('own_change', 'admin_set', 'operator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS password_change_tickets_user_idx ON security_audit.password_change_tickets (user_id, created_at);
ALTER TABLE security_audit.password_change_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE security_audit.password_change_tickets FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 3. Issue a ticket (the app's server, after its own checks).
CREATE OR REPLACE FUNCTION public.issue_password_change_ticket(p_user_id UUID, p_purpose TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- The role in force survives a SECURITY DEFINER function (019 is_api_role): a signed-in or anonymous caller never issues one.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Only the server can allow a password change.' USING ERRCODE = '42501';
  END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('own_change', 'admin_set', 'operator') THEN
    RAISE EXCEPTION 'Unknown password change purpose.' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'No such login.' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM security_audit.password_change_tickets t WHERE t.expires_at < now() - interval '7 days';
  INSERT INTO security_audit.password_change_tickets (user_id, purpose, expires_at)
  VALUES (p_user_id, p_purpose, now() + interval '60 seconds')
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.issue_password_change_ticket(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_password_change_ticket(UUID, TEXT) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 4. Drop a ticket the route did not use.
CREATE OR REPLACE FUNCTION public.revoke_password_change_ticket(p_ticket UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_found BOOLEAN;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Only the server can allow a password change.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM security_audit.password_change_tickets t WHERE t.id = p_ticket AND t.used_at IS NULL;
  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found;
END
$$;
REVOKE ALL ON FUNCTION public.revoke_password_change_ticket(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_password_change_ticket(UUID) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 5. The trigger function and the trigger.
CREATE OR REPLACE FUNCTION public.auth_users_password_change_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ticket UUID;
BEGIN
  -- Not a password change (a sign-in, a ban, metadata): not asked.
  IF NEW.encrypted_password IS NOT DISTINCT FROM OLD.encrypted_password THEN
    RETURN NEW;
  END IF;
  -- Auth's housekeeping, which never lets anyone choose a password: removing the password of a login whose e-mail was never confirmed,
  -- or of one being soft-deleted; the random password Auth sets when an invited login with none accepts its invite.
  IF coalesce(NEW.encrypted_password, '') = '' AND (OLD.email_confirmed_at IS NULL OR NEW.deleted_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF coalesce(OLD.encrypted_password, '') = '' AND OLD.email_confirmed_at IS NULL AND OLD.invited_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Anything else needs a ticket the app's server issued for this login after its own checks: one ticket, one change.
  SELECT t.id INTO v_ticket
  FROM security_audit.password_change_tickets t
  WHERE t.user_id = OLD.id AND t.used_at IS NULL AND t.expires_at > now()
  ORDER BY t.created_at, t.id
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
  IF v_ticket IS NULL THEN
    RAISE EXCEPTION 'Passwords are changed in Tolra (Change password, or Admin > Users > Set password).'
      USING ERRCODE = '42501', HINT = 'password_change_ticket_required';
  END IF;
  UPDATE security_audit.password_change_tickets SET used_at = now() WHERE id = v_ticket;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.auth_users_password_change_ticket() FROM PUBLIC, anon, authenticated, service_role;

-- Created only when missing (no DROP TRIGGER: postgres does not own auth.users). An existing one must have exactly this shape.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'password_change_ticket') THEN
    CREATE TRIGGER password_change_ticket
      BEFORE UPDATE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.auth_users_password_change_ticket();
  ELSIF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'password_change_ticket' AND t.tgenabled = 'O'
                    AND t.tgfoid = to_regprocedure('public.auth_users_password_change_ticket()') AND t.tgtype = 19 AND t.tgattr = ''::int2vector
                    AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs = 0) THEN
    RAISE EXCEPTION '137: trigger password_change_ticket exists with a different shape; stop and report';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 6. Self-check: everything above is in place; the trigger function is callable by nobody, the two ticket functions by the service role
-- only, and the table by nobody.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'password_change_ticket' AND t.tgenabled = 'O'
                 AND t.tgfoid = to_regprocedure('public.auth_users_password_change_ticket()') AND t.tgtype = 19 AND t.tgattr = ''::int2vector)
     OR NOT (SELECT bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) = TRUE AND count(*) = 3 FROM pg_proc p
             WHERE p.oid IN (to_regprocedure('public.auth_users_password_change_ticket()'), to_regprocedure('public.issue_password_change_ticket(uuid,text)'),
                             to_regprocedure('public.revoke_password_change_ticket(uuid)')))
     OR has_function_privilege('authenticated', 'public.auth_users_password_change_ticket()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.auth_users_password_change_ticket()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.auth_users_password_change_ticket()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.issue_password_change_ticket(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.issue_password_change_ticket(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.issue_password_change_ticket(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.revoke_password_change_ticket(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.revoke_password_change_ticket(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.revoke_password_change_ticket(uuid)', 'EXECUTE')
     OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'security_audit.password_change_tickets'::regclass)
     OR has_table_privilege('authenticated', 'security_audit.password_change_tickets', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'security_audit.password_change_tickets', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role', 'security_audit.password_change_tickets', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION '137 self-check: the password change ticket is not in place';
  END IF;
END
$$;

COMMIT;
