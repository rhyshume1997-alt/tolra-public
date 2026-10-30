-- 107_integrations_connect.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 107: Integrations connect, "click through and connect with no fuss" (E2 Xero, E7 Microsoft 365; Rhys, Fri 30 Oct). Builds on 084.
-- Needs 084 (the integration tables and functions), 036 (is_platform_admin, assert_platform_aal, _session_membership), 033
-- (assert_privileged_aal, require_admin_mfa_guard), 035 (security_audit.log_named_event). Safe to run again.
-- REPLACES NO EXISTING FUNCTION: 084's functions are guarded by body (its section 1) and the upgrade rehearsal applies 084 again after
-- this file, so every 084 function keeps its body; 107 adds new functions beside them.
--
-- WHAT IT ADDS
--   a. The provider CHECK on integration_connections, integration_secrets and integration_oauth_states also allows 'microsoft' (a
--      company's Microsoft 365 mailbox, signed in by delegated OAuth). integration_mappings, _contacts and _sends stay 'xero' only.
--   b. integration_sends takes accounting providers only: 084's enqueue adds a send row for EVERY connected provider when an invoice is
--      issued, so a BEFORE INSERT trigger (integration_sends_accounting_only) quietly drops a row for any provider but 'xero'. Without
--      it, issuing an invoice in a company connected to Microsoft 365 would fail on the CHECK.
--   c. public.integration_app_credentials: the app-level client id and (server-encrypted) client secret per provider, entered once by
--      the platform owner. RLS on, no policy, no grant to anon or authenticated: only the server (service role) reads it; the owner
--      writes it through integration_app_credentials_save / _remove and reads only client id + last 4 through _list.
--   d. public.integration_connect_invites: a one-use link an admin sends the accountant (24 hours, Xero only). Only the SHA-256 of the
--      token is kept. RLS on, no policy, no grant. integration_oauth_states.via_invite: the invite a Connect was started from.
--   Functions (SECURITY DEFINER, pinned search_path):
--     signed in: integration_oauth_start (Connect for 'xero' or 'microsoft': admin, two-step, own company, never a support session),
--                integration_invite_create (admin, two-step, own company, never a support session),
--                integration_app_credentials_save / _remove / _list (platform owner, aal2).
--     server only (service role): integration_invite_redeem (the link, once: marks it used and keeps a 10-minute OAuth state bound to
--                the invite's company and the admin who made it), integration_oauth_consume_invite (the callback for that state only).
--     internal: integration_sends_accounting_only (trigger).
-- AUDIT: named events INTEGRATION_INVITE_CREATED, INTEGRATION_INVITE_USED (the company's log), INTEGRATION_APP_CREDENTIALS_SAVED and
-- _REMOVED (platform level: organization_id NULL). Never a token, a token hash, a secret or its ciphertext.
-- GUARD (section 1). SELF-CHECK (section 6). Verify: supabase/verify/integrations_connect_107.sql (every row TRUE).
-- Rollback: supabase/release/107_integrations_connect.rollback.sql (Rhys's approval; removes every Microsoft 365 connection).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists.
DO $$
BEGIN
  IF to_regclass('public.integration_connections') IS NULL OR to_regclass('public.integration_secrets') IS NULL
     OR to_regclass('public.integration_oauth_states') IS NULL OR to_regclass('public.integration_sends') IS NULL
     OR to_regprocedure('public.integration_oauth_consume(uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.integration_store_connection(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,integer)') IS NULL THEN
    RAISE EXCEPTION '107: the integrations layer (084) is missing';
  END IF;
  IF to_regprocedure('public.is_platform_admin()') IS NULL OR to_regprocedure('public.assert_platform_aal()') IS NULL
     OR to_regprocedure('public._session_membership()') IS NULL OR to_regprocedure('public.current_user_organization_id()') IS NULL
     OR to_regprocedure('public.has_org_role(text[])') IS NULL OR to_regprocedure('public.assert_privileged_aal()') IS NULL
     OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL OR to_regprocedure('public.support_readonly_guard()') IS NULL
     OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '107: a helper it needs (033, 035, 036) is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. Microsoft 365 as a connection provider (connections, secrets, OAuth states only).
ALTER TABLE public.integration_connections DROP CONSTRAINT IF EXISTS integration_connections_provider_check;
ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_provider_check CHECK (provider IN ('xero', 'microsoft'));
ALTER TABLE public.integration_secrets DROP CONSTRAINT IF EXISTS integration_secrets_provider_check;
ALTER TABLE public.integration_secrets ADD CONSTRAINT integration_secrets_provider_check CHECK (provider IN ('xero', 'microsoft'));
ALTER TABLE public.integration_oauth_states DROP CONSTRAINT IF EXISTS integration_oauth_states_provider_check;
ALTER TABLE public.integration_oauth_states ADD CONSTRAINT integration_oauth_states_provider_check CHECK (provider IN ('xero', 'microsoft'));

-- The send log is for accounting systems: a row 084's enqueue makes for a mail provider is dropped (never an error, never a send).
CREATE OR REPLACE FUNCTION public.integration_sends_accounting_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM 'xero' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.integration_sends_accounting_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS aa_integration_sends_accounting_only ON public.integration_sends;
CREATE TRIGGER aa_integration_sends_accounting_only BEFORE INSERT ON public.integration_sends
  FOR EACH ROW EXECUTE FUNCTION public.integration_sends_accounting_only();

-- -----------------------------------------------------------------------------------------------------
-- 3. The tables.
-- 3a. App-level credentials (one row per provider, platform wide). The secret is the server's ciphertext ("v<n>.<iv>.<tag>.<data>").
CREATE TABLE IF NOT EXISTS public.integration_app_credentials (
  provider            TEXT PRIMARY KEY CONSTRAINT integration_app_credentials_provider CHECK (provider IN ('xero', 'microsoft')),
  client_id           TEXT NOT NULL CONSTRAINT integration_app_credentials_client_id
                        CHECK (length(client_id) BETWEEN 1 AND 200 AND client_id !~ '[[:cntrl:][:space:]]'),
  client_secret_enc   TEXT NOT NULL CONSTRAINT integration_app_credentials_secret_enc
                        CHECK (client_secret_enc ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND length(client_secret_enc) <= 4000),
  client_secret_last4 TEXT NOT NULL CONSTRAINT integration_app_credentials_last4 CHECK (length(client_secret_last4) = 4 AND client_secret_last4 !~ '[[:cntrl:][:space:]]'),
  redirect_uri        TEXT CONSTRAINT integration_app_credentials_redirect
                        CHECK (redirect_uri IS NULL OR (length(redirect_uri) <= 500 AND redirect_uri ~ '^(https://|http://localhost[:/]|http://127\.0\.0\.1[:/])' AND redirect_uri !~ '[[:cntrl:][:space:]]')),
  key_version         INTEGER NOT NULL CONSTRAINT integration_app_credentials_key_version CHECK (key_version BETWEEN 1 AND 999),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID
);

-- 3b. The accountant's one-use connect link: the token's SHA-256 only, 24 hours, used once.
CREATE TABLE IF NOT EXISTS public.integration_connect_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CONSTRAINT integration_connect_invites_provider CHECK (provider IN ('xero')),
  token_hash      TEXT NOT NULL CONSTRAINT integration_connect_invites_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  CONSTRAINT integration_connect_invites_token_key UNIQUE (token_hash),
  CONSTRAINT integration_connect_invites_24h CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_integration_connect_invites_org ON public.integration_connect_invites (organization_id, expires_at);

-- 3c. An OAuth state started from an invite carries it (the callback then needs no Tolra session; the state is still single use,
-- 10 minutes, bound to the invite's company and the admin who made the invite).
ALTER TABLE public.integration_oauth_states ADD COLUMN IF NOT EXISTS via_invite UUID REFERENCES public.integration_connect_invites(id) ON DELETE CASCADE;

-- 3d. Row level security, grants and the guards 084's tables carry. Neither table is readable or writable through the API.
ALTER TABLE public.integration_app_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_connect_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_app_credentials, public.integration_connect_invites FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS support_read_only ON public.integration_app_credentials;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_app_credentials FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.integration_app_credentials;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_app_credentials FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.integration_connect_invites;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_connect_invites FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.integration_connect_invites;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_connect_invites FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 4. Connect (signed in) and the accountant's link.
-- 4a. Connect, step 1, for Xero or Microsoft 365: as 084's integration_oauth_begin (admin, two-step, own company, 10 minutes, at most
-- five open), and never from a support session (read-only or elevated). The callback uses 084's integration_oauth_consume.
CREATE OR REPLACE FUNCTION public.integration_oauth_start(p_provider TEXT, p_state_hash TEXT, p_verifier_enc TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can connect it.' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('xero', 'microsoft') THEN
    RAISE EXCEPTION 'Unknown provider.' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.integration_oauth_states s
  WHERE s.organization_id = v_org AND (s.consumed_at IS NOT NULL OR s.expires_at < now());
  IF (SELECT count(*) FROM public.integration_oauth_states s WHERE s.organization_id = v_org AND s.user_id = v_uid) >= 5 THEN
    RAISE EXCEPTION 'Too many Connect attempts are open: wait 10 minutes and try again.' USING ERRCODE = '54000', HINT = 'too_many_attempts';
  END IF;
  INSERT INTO public.integration_oauth_states (organization_id, provider, user_id, state_hash, verifier_enc, expires_at)
  VALUES (v_org, p_provider, v_uid, p_state_hash, p_verifier_enc, now() + interval '10 minutes')
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.integration_oauth_start(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_oauth_start(TEXT, TEXT, TEXT) TO authenticated;

-- 4b. The accountant's link (signed in: admin, two-step, own company, never support). The server made the random token; this keeps
-- its SHA-256 for 24 hours. At most three open links per company. Audited (no token, no hash).
CREATE OR REPLACE FUNCTION public.integration_invite_create(p_provider TEXT, p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_uid     UUID := auth.uid();
  v_id      UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can send a connect link.' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS DISTINCT FROM 'xero' THEN
    RAISE EXCEPTION 'A connect link is for Xero only.' USING ERRCODE = '22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid link.' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.integration_connect_invites i
  WHERE i.organization_id = v_org AND (i.used_at IS NOT NULL OR i.expires_at < now()) AND i.created_at < now() - interval '30 days';
  IF (SELECT count(*) FROM public.integration_connect_invites i
      WHERE i.organization_id = v_org AND i.used_at IS NULL AND i.expires_at > now()) >= 3 THEN
    RAISE EXCEPTION 'Three connect links are already open: use one of them, or wait until they expire (24 hours).' USING ERRCODE = '54000', HINT = 'too_many_invites';
  END IF;
  INSERT INTO public.integration_connect_invites (organization_id, provider, token_hash, created_by, created_at, expires_at)
  VALUES (v_org, p_provider, p_token_hash, v_uid, now(), now() + interval '24 hours')
  RETURNING id, expires_at INTO v_id, v_expires;
  PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_INVITE_CREATED', 'integration_connect_invites', v_id::TEXT,
    jsonb_build_object('provider', p_provider, 'expires_at', v_expires, 'by', v_uid));
  RETURN jsonb_build_object('id', v_id, 'provider', p_provider, 'expires_at', v_expires);
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_create(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_invite_create(TEXT, TEXT) TO authenticated;

-- 4c. The link is opened (server only, no Tolra session): an unused, unexpired invite is used up (row lock: two opens at once, one
-- wins), the admin who made it must still be an active, non-support admin of the active company, and a 10-minute OAuth state bound to
-- that company and admin (via_invite) is kept. Returns the company and provider. The invite grants nothing else.
CREATE OR REPLACE FUNCTION public.integration_invite_redeem(p_token_hash TEXT, p_state_hash TEXT, p_verifier_enc TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_inv RECORD;
BEGIN
  UPDATE public.integration_connect_invites i SET used_at = now()
  WHERE i.token_hash = p_token_hash AND i.used_at IS NULL AND i.expires_at > now()
  RETURNING i.id, i.organization_id, i.provider, i.created_by INTO v_inv;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'This connect link has expired or was already used: ask for a new one.' USING ERRCODE = '42501', HINT = 'invite_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
                 WHERE m.organization_id = v_inv.organization_id AND m.user_id = v_inv.created_by AND m.active AND NOT m.support
                   AND o.status = 'active' AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))) THEN
    RAISE EXCEPTION 'This connect link is no longer valid: ask for a new one.' USING ERRCODE = '42501', HINT = 'invite_invalid';
  END IF;
  INSERT INTO public.integration_oauth_states (organization_id, provider, user_id, state_hash, verifier_enc, expires_at, via_invite)
  VALUES (v_inv.organization_id, v_inv.provider, v_inv.created_by, p_state_hash, p_verifier_enc, now() + interval '10 minutes', v_inv.id);
  PERFORM security_audit.log_named_event(v_inv.organization_id, 'INTEGRATION_INVITE_USED', 'integration_connect_invites', v_inv.id::TEXT,
    jsonb_build_object('provider', v_inv.provider, 'invited_by', v_inv.created_by));
  RETURN jsonb_build_object('organization_id', v_inv.organization_id, 'provider', v_inv.provider);
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_redeem(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_invite_redeem(TEXT, TEXT, TEXT) TO service_role;

-- 4d. The callback for a state an invite started (server only): unexpired, unused, started from an invite; used up. Returns the
-- company, the admin who made the invite and the encrypted verifier. NULL when no such state exists (nothing is used up then).
CREATE OR REPLACE FUNCTION public.integration_oauth_consume_invite(p_provider TEXT, p_state_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_out JSONB;
BEGIN
  UPDATE public.integration_oauth_states s SET consumed_at = now()
  WHERE s.state_hash = p_state_hash AND s.provider = p_provider AND s.via_invite IS NOT NULL
    AND s.consumed_at IS NULL AND s.expires_at > now()
  RETURNING jsonb_build_object('organization_id', s.organization_id, 'user_id', s.user_id, 'verifier_enc', s.verifier_enc) INTO v_out;
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.integration_oauth_consume_invite(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_oauth_consume_invite(TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 5. App-level credentials (platform owner, aal2). The server encrypts the secret; the database never sees it in plain text.
CREATE OR REPLACE FUNCTION public.integration_app_credentials_save(p_provider TEXT, p_client_id TEXT, p_secret_enc TEXT, p_secret_last4 TEXT,
                                                                  p_redirect_uri TEXT, p_key_version INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_client TEXT := btrim(coalesce(p_client_id, ''));
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only the platform owner can set the app details.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_platform_aal();
  IF p_provider IS NULL OR p_provider NOT IN ('xero', 'microsoft') THEN
    RAISE EXCEPTION 'Unknown provider.' USING ERRCODE = '22023';
  END IF;
  IF v_client = '' THEN
    RAISE EXCEPTION 'Enter the client id.' USING ERRCODE = '22023';
  END IF;
  IF p_secret_enc IS NULL THEN
    -- The secret kept as it is (only the client id or redirect changes): there must already be one.
    UPDATE public.integration_app_credentials c SET client_id = v_client, redirect_uri = p_redirect_uri, updated_at = now(), updated_by = auth.uid()
    WHERE c.provider = p_provider;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Enter the client secret.' USING ERRCODE = '22023';
    END IF;
  ELSE
    INSERT INTO public.integration_app_credentials (provider, client_id, client_secret_enc, client_secret_last4, redirect_uri, key_version, updated_at, updated_by)
    VALUES (p_provider, v_client, p_secret_enc, p_secret_last4, p_redirect_uri, p_key_version, now(), auth.uid())
    ON CONFLICT (provider) DO UPDATE
      SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc, client_secret_last4 = EXCLUDED.client_secret_last4,
          redirect_uri = EXCLUDED.redirect_uri, key_version = EXCLUDED.key_version, updated_at = now(), updated_by = auth.uid();
  END IF;
  PERFORM security_audit.log_named_event(NULL, 'INTEGRATION_APP_CREDENTIALS_SAVED', 'integration_app_credentials', p_provider,
    jsonb_build_object('provider', p_provider, 'client_id', v_client, 'secret_changed', p_secret_enc IS NOT NULL));
  RETURN jsonb_build_object('provider', p_provider, 'client_id', v_client);
END
$$;
REVOKE ALL ON FUNCTION public.integration_app_credentials_save(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_app_credentials_save(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.integration_app_credentials_remove(p_provider TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only the platform owner can remove the app details.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_platform_aal();
  DELETE FROM public.integration_app_credentials c WHERE c.provider = p_provider;
  IF FOUND THEN
    PERFORM security_audit.log_named_event(NULL, 'INTEGRATION_APP_CREDENTIALS_REMOVED', 'integration_app_credentials', p_provider,
      jsonb_build_object('provider', p_provider));
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END
$$;
REVOKE ALL ON FUNCTION public.integration_app_credentials_remove(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_app_credentials_remove(TEXT) TO authenticated;

-- What the owner's screen shows: client id, the secret's last 4, the redirect, when. Never the secret or its ciphertext.
CREATE OR REPLACE FUNCTION public.integration_app_credentials_list()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Only the platform owner can see the app details.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_platform_aal();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('provider', c.provider, 'client_id', c.client_id, 'client_secret_last4', c.client_secret_last4,
                                                       'redirect_uri', c.redirect_uri, 'updated_at', c.updated_at) ORDER BY c.provider), '[]'::JSONB)
          FROM public.integration_app_credentials c);
END
$$;
REVOKE ALL ON FUNCTION public.integration_app_credentials_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_app_credentials_list() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 6. Self-check before COMMIT (the same checks as supabase/verify/integrations_connect_107.sql).
DO $$
DECLARE
  v_fn TEXT;
  v_t  TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.integration_oauth_start(text,text,text)', 'public.integration_invite_create(text,text)',
                              'public.integration_app_credentials_save(text,text,text,text,text,integer)', 'public.integration_app_credentials_remove(text)',
                              'public.integration_app_credentials_list()'] LOOP
    IF NOT coalesce((SELECT p.prosecdef AND p.proconfig IS NOT NULL AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                     FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)), FALSE) THEN
      RAISE EXCEPTION '107: % is not a signed-in-only definer function', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.integration_invite_redeem(text,text,text)', 'public.integration_oauth_consume_invite(text,text)'] LOOP
    IF to_regprocedure(v_fn) IS NULL OR has_function_privilege('anon', to_regprocedure(v_fn), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(v_fn), 'EXECUTE') OR NOT has_function_privilege('service_role', to_regprocedure(v_fn), 'EXECUTE')
       OR (SELECT p.proconfig IS NULL OR NOT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) THEN
      RAISE EXCEPTION '107: % is missing, callable from the API, or not the server''s', v_fn;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY ARRAY['integration_app_credentials', 'integration_connect_invites'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || v_t))
       OR has_table_privilege('authenticated', 'public.' || v_t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_table_privilege('anon', 'public.' || v_t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_t)
       OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = to_regclass('public.' || v_t) AND t.tgname IN ('support_read_only', 'admin_mfa')) <> 2 THEN
      RAISE EXCEPTION '107: % has RLS off, an API grant or policy, or a guard missing', v_t;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'c' AND c.conname IN ('integration_connections_provider_check', 'integration_secrets_provider_check', 'integration_oauth_states_provider_check')
        AND pg_get_constraintdef(c.oid) LIKE '%microsoft%') <> 3 THEN
    RAISE EXCEPTION '107: the provider checks do not allow microsoft';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'aa_integration_sends_accounting_only'
                   AND t.tgrelid = 'public.integration_sends'::regclass AND t.tgfoid = 'public.integration_sends_accounting_only()'::regprocedure) THEN
    RAISE EXCEPTION '107: the send log''s accounting-only trigger is missing';
  END IF;
END
$$;

COMMIT;
