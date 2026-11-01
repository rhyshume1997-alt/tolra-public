-- 129 rollback: ONLY with Rhys's approval. Removes "Invite your accountant": the four functions, the sign-up trigger back to 007's body,
-- the five columns, their CHECK and index, and the column grant (back to 007's table grant).
-- EVERY ACCOUNTANT INVITE IS DELETED FIRST (rows with a token_hash: open, used, revoked or expired). Without that, dropping the columns
-- would leave each one as an ordinary viewer invite with no expiry, which the sign-up trigger would then honour. Ordinary invites
-- (token_hash NULL) are untouched. Memberships an accountant already received stay (an admin removes them in Settings > Users); the
-- ACCOUNTANT_INVITE_* events stay in security_audit.audit_log, which nothing can edit. An accountant link sent out then answers
-- "can't be used". Run the whole text as one transaction, then the release preflight (marker 129 shows "not applied").
BEGIN;

DELETE FROM public.organization_invites WHERE token_hash IS NOT NULL;

DROP FUNCTION IF EXISTS public.create_accountant_invite(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.redeem_accountant_invite(TEXT);
DROP FUNCTION IF EXISTS public.revoke_accountant_invite(UUID);
DROP FUNCTION IF EXISTS public.accountant_invite_peek(TEXT);

-- 007's sign-up trigger function, byte for byte.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  inv      RECORD;
  v_first  RECORD;
  v_has    BOOLEAN := FALSE;
BEGIN
  BEGIN
    IF NEW.email IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT i.organization_id, i.role, o.name AS org_name INTO v_first
    FROM public.organization_invites i JOIN public.organizations o ON o.id = i.organization_id
    WHERE lower(i.email) = lower(NEW.email)
    ORDER BY i.created_at, i.id
    LIMIT 1;
    IF FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = NEW.id) THEN
        INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, organization, active)
        VALUES (NEW.id, lower(NEW.email), nullif(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), v_first.role,
                v_first.organization_id, v_first.org_name, TRUE)
        ON CONFLICT DO NOTHING;
      END IF;
      IF EXISTS (SELECT 1 FROM public.user_profiles WHERE id = NEW.id) THEN
        FOR inv IN SELECT i.organization_id, i.role FROM public.organization_invites i
                   WHERE lower(i.email) = lower(NEW.email) ORDER BY i.created_at, i.id
        LOOP
          INSERT INTO public.organization_members (user_id, organization_id, role, active)
          VALUES (NEW.id, inv.organization_id, inv.role, TRUE)
          ON CONFLICT (user_id, organization_id) DO NOTHING;
          v_has := TRUE;
        END LOOP;
        IF v_has THEN
          DELETE FROM public.organization_invites WHERE lower(email) = lower(NEW.email);
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_auth_user: profile not created for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.organization_invites DROP CONSTRAINT IF EXISTS organization_invites_accountant_shape;
DROP INDEX IF EXISTS public.organization_invites_token_hash_uniq;
REVOKE SELECT (id, organization_id, email, role, created_at, expires_at, used_at, revoked_at, created_by) ON public.organization_invites FROM authenticated;
ALTER TABLE public.organization_invites
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS token_hash,
  DROP COLUMN IF EXISTS used_at,
  DROP COLUMN IF EXISTS revoked_at,
  DROP COLUMN IF EXISTS created_by;
REVOKE ALL ON public.organization_invites FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organization_invites TO authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.create_accountant_invite(text,text)') IS NOT NULL OR to_regprocedure('public.redeem_accountant_invite(text)') IS NOT NULL
     OR to_regprocedure('public.revoke_accountant_invite(uuid)') IS NOT NULL OR to_regprocedure('public.accountant_invite_peek(text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organization_invites'
                AND column_name IN ('expires_at', 'token_hash', 'used_at', 'revoked_at', 'created_by')) THEN
    RAISE EXCEPTION '129 rollback: the accountant invite is still there';
  END IF;
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.handle_new_auth_user()'))
     IS DISTINCT FROM '06b94b76c311ed711fbecbce0da0580b' THEN
    RAISE EXCEPTION '129 rollback: the sign-up trigger is not 007''s body';
  END IF;
END
$$;

COMMIT;
