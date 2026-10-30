-- 107 rollback: ONLY with Rhys's approval. Removes what 107 adds: every company's Microsoft 365 connection (its row, its encrypted
-- tokens and any open Connect), the app-level credentials the platform owner entered (the env vars then apply again), and the
-- accountant's connect links (open ones stop working; an OAuth state started from one goes with it). The provider checks go back to
-- 'xero' only. Xero connections, mappings, contacts and the send log are untouched. Audit rows already written stay (append-only).
-- The app then shows the Microsoft card and the accountant link as "not available until database update 107 is applied", and Xero
-- keeps working. 084's functions were never replaced, so nothing of 084 needs restoring. Run the whole text as one transaction, then
-- the release preflight (marker 107 shows "not applied").
BEGIN;

DROP FUNCTION IF EXISTS public.integration_app_credentials_list();
DROP FUNCTION IF EXISTS public.integration_app_credentials_remove(TEXT);
DROP FUNCTION IF EXISTS public.integration_app_credentials_save(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.integration_oauth_consume_invite(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_disconnect_revoke(TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_revoke(UUID);
DROP FUNCTION IF EXISTS public.integration_invites_open(TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_peek(TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_redeem(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_create(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_oauth_start(TEXT, TEXT, TEXT);

-- Microsoft 365 rows first (the provider checks are tightened below). The connection row's audit trigger records its removal.
DELETE FROM public.integration_oauth_states WHERE provider <> 'xero' OR via_invite IS NOT NULL;
DELETE FROM public.integration_secrets WHERE provider <> 'xero';
DELETE FROM public.integration_connections WHERE provider <> 'xero';

ALTER TABLE public.integration_oauth_states DROP COLUMN IF EXISTS via_invite;
DROP TABLE IF EXISTS public.integration_connect_invites;
DROP TABLE IF EXISTS public.integration_app_credentials;

DROP TRIGGER IF EXISTS aa_integration_sends_accounting_only ON public.integration_sends;
DROP FUNCTION IF EXISTS public.integration_sends_accounting_only();

ALTER TABLE public.integration_connections DROP CONSTRAINT IF EXISTS integration_connections_provider_check;
ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_provider_check CHECK (provider IN ('xero'));
ALTER TABLE public.integration_secrets DROP CONSTRAINT IF EXISTS integration_secrets_provider_check;
ALTER TABLE public.integration_secrets ADD CONSTRAINT integration_secrets_provider_check CHECK (provider IN ('xero'));
ALTER TABLE public.integration_oauth_states DROP CONSTRAINT IF EXISTS integration_oauth_states_provider_check;
ALTER TABLE public.integration_oauth_states ADD CONSTRAINT integration_oauth_states_provider_check CHECK (provider IN ('xero'));

DO $$
BEGIN
  IF to_regclass('public.integration_app_credentials') IS NOT NULL OR to_regclass('public.integration_connect_invites') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'integration_oauth_states' AND column_name = 'via_invite')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('integration_oauth_start', 'integration_invite_create', 'integration_invite_redeem', 'integration_oauth_consume_invite',
                                  'integration_invite_peek', 'integration_invites_open', 'integration_invite_revoke', 'integration_disconnect_revoke',
                                  'integration_app_credentials_save', 'integration_app_credentials_remove', 'integration_app_credentials_list',
                                  'integration_sends_accounting_only'))
     OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%microsoft%'
                AND c.conrelid IN ('public.integration_connections'::regclass, 'public.integration_secrets'::regclass, 'public.integration_oauth_states'::regclass)) THEN
    RAISE EXCEPTION '107 rollback: something 107 added is still there';
  END IF;
END
$$;

COMMIT;
