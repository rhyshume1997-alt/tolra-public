-- Post-144 release step 154 (customer portal sign-in: e-mailed link plus eight-digit code, PM ruling 12 Nov 2026 15:25 option 2a;
-- registered in supabase/release-plan.json as phase 154, after 153; CI's post-144 step installs it). One-time, one transaction; never
-- part of baseline replay. Not applied anywhere hosted. Canonical source: supabase/proposals/p154_customer_portal_signin.sql (its body
-- between BEGIN; and COMMIT; is copied below verbatim between the fingerprint and the self-check; read its header). Apply only after 153
-- (the guard tests 153's objects). Required before customer portal activation, not for JNR core go-live. Production only with Rhys's
-- separate yes. Verify: supabase/verify/customer_portal_signin_154.sql (every row true).
-- Rollback: supabase/release/154_customer_portal_signin.rollback.sql (must run BEFORE 153's rollback; refuses while any contact exists).
-- Adds tables and functions only: no column, trigger, policy, grant or row of any existing table changes (the self-check proves it).
BEGIN;
DO $post_release_guard$ BEGIN
 IF to_regclass('public.customer_portal_contacts') IS NOT NULL OR to_regclass('public.customer_portal_sessions') IS NOT NULL
    OR to_regclass('public.customer_portal_signin_codes') IS NOT NULL OR to_regclass('security_audit.customer_portal_refusals') IS NOT NULL
    OR to_regprocedure('public.portal_session_resolve(text)') IS NOT NULL THEN
  RAISE EXCEPTION '154: the customer portal sign-in already exists; this one-time release was applied before';
 END IF;
 IF to_regclass('public.customer_portal_switch') IS NULL OR to_regclass('public.document_customer_links_verified') IS NULL
    OR to_regprocedure('public._document_customer_link_actor(text[],boolean)') IS NULL
    OR to_regprocedure('public._document_customer_link_reason(text)') IS NULL THEN
  RAISE EXCEPTION '154: required release 153 (document customer links) is missing; stop and check release preflight';
 END IF;
 IF to_regprocedure('public.enforce_same_org_parent()') IS NULL OR to_regprocedure('security_audit.log_row_change()') IS NULL
    OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL
    OR to_regprocedure('public.auth_rate_hit(text,text,integer,integer)') IS NULL OR to_regclass('public.record_archive_state') IS NULL THEN
  RAISE EXCEPTION '154: the helper functions and tables it builds on are not all in place; stop and check release preflight';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything 154 reads or calls (153's switch, links, view and helpers; the rate limiter; the audit and same-
-- company helpers) and of every trigger, policy, column and grant of the tables it reads. The self-check requires the identical
-- fingerprint. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p154_fingerprint()
RETURNS TABLE (kind TEXT, item TEXT, fp TEXT)
LANGUAGE sql
AS $p154fp$
  WITH t(name) AS (VALUES ('organizations'), ('customers'), ('quotes'), ('jobs'), ('record_archive_state'), ('auth_rate_limits'),
                          ('customer_portal_switch'), ('document_customer_links')),
  g(sig) AS (VALUES ('public._document_customer_link_actor(text[],boolean)'), ('public._document_customer_link_reason(text)'),
                    ('public.customer_portal_set_enabled(boolean,text)'), ('public.customer_portal_status()'),
                    ('public.auth_rate_hit(text,text,integer,integer)'), ('public.enforce_same_org_parent()'),
                    ('security_audit.log_row_change()'), ('security_audit.log_named_event(uuid,text,text,text,jsonb)'))
  SELECT 'function'::TEXT, g.sig::TEXT, md5(concat_ws('|', p.prosrc, p.prosecdef, p.proconfig::TEXT, p.proowner, p.proacl::TEXT, p.provolatile::TEXT))
  FROM g LEFT JOIN pg_proc p ON p.oid = to_regprocedure(g.sig)
  UNION ALL
  SELECT 'view', 'public.document_customer_links_verified', md5(concat_ws('|', pg_get_viewdef(to_regclass('public.document_customer_links_verified')),
    (SELECT c.relacl::TEXT FROM pg_class c WHERE c.oid = to_regclass('public.document_customer_links_verified')),
    (SELECT c.reloptions::TEXT FROM pg_class c WHERE c.oid = to_regclass('public.document_customer_links_verified'))))
  UNION ALL
  SELECT 'trigger', c.relname::TEXT || '.' || tr.tgname::TEXT, md5(pg_get_triggerdef(tr.oid) || tr.tgenabled::TEXT)
  FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (SELECT name FROM t) AND NOT tr.tgisinternal
  UNION ALL
  SELECT 'policy', p.tablename::TEXT || '.' || p.policyname::TEXT, md5(concat_ws('|', p.permissive, p.roles::TEXT, p.cmd, p.qual, p.with_check))
  FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN (SELECT name FROM t)
  UNION ALL
  SELECT 'column', c.table_name::TEXT || '.' || c.column_name::TEXT, md5(concat_ws('|', c.data_type, c.column_default, c.is_nullable, c.ordinal_position))
  FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN (SELECT name FROM t)
  UNION ALL
  SELECT 'table', c.relname::TEXT, md5(concat_ws('|', c.relacl::TEXT, c.relrowsecurity, c.relforcerowsecurity))
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (SELECT name FROM t)
  UNION ALL SELECT 'rows', 'customer_portal_switch', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.organization_id), '')) FROM public.customer_portal_switch x
  UNION ALL SELECT 'rows', 'document_customer_links', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.document_customer_links x
$p154fp$;
CREATE TEMP TABLE _p154_before ON COMMIT DROP AS SELECT * FROM pg_temp.p154_fingerprint();

-- ---- 1. Portal contacts: named people of one customer, each with own permissions; revocable; never deleted ------------------------------
-- A contact is an e-mail address an admin of the company has invited for ONE customer of that company. It is not a Supabase user and
-- has no password. One live contact per (company, customer, e-mail); a revoked contact stays as a record and can be invited again as a
-- new row. Written only by the functions below (no API role has any grant). The e-mail, name and the full invite and revoke reasons
-- (free text) live ONLY in this restricted row: no API role can read the table, and staff read contacts only through
-- portal_contacts_list (company admin; never the reasons). The company audit gets named events with ids and a fixed reason category,
-- never a row copy (PM rule: no free text in ordinary audit records).
CREATE TABLE public.customer_portal_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  customer_id     UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  email           TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  permissions     TEXT[] NOT NULL,
  invited_by      UUID NOT NULL,
  invite_reason   TEXT NOT NULL,
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_by      UUID,
  revoke_reason   TEXT,
  revoked_at      TIMESTAMPTZ,
  CONSTRAINT customer_portal_contacts_email CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(btrim(email))
    AND email ~ '^[^[:space:]@<>(),;:"\[\]\\]+@[^[:space:]@<>(),;:"\[\]\\]+\.[^[:space:]@<>(),;:"\[\]\\]+$'),
  CONSTRAINT customer_portal_contacts_name CHECK (display_name = btrim(display_name) AND length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT customer_portal_contacts_permissions CHECK (cardinality(permissions) BETWEEN 1 AND 2 AND array_position(permissions, NULL) IS NULL
    AND permissions <@ ARRAY['quotes', 'jobs']::TEXT[]),
  CONSTRAINT customer_portal_contacts_invite_reason CHECK (length(btrim(invite_reason)) BETWEEN 1 AND 500),
  CONSTRAINT customer_portal_contacts_revoke_whole CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)
    AND (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX customer_portal_contacts_one_live ON public.customer_portal_contacts (organization_id, customer_id, email) WHERE revoked_at IS NULL;
CREATE INDEX customer_portal_contacts_live_email ON public.customer_portal_contacts (email) WHERE revoked_at IS NULL;
CREATE INDEX customer_portal_contacts_customer ON public.customer_portal_contacts (customer_id);
ALTER TABLE public.customer_portal_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_portal_contacts FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zz_same_org_customer_id BEFORE INSERT OR UPDATE ON public.customer_portal_contacts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('customers', 'customer_id');

-- ---- 2. Sign-in codes: hashed, single use, 10 minutes, 5 wrong tries ------------------------------------------------------------------
-- One row per e-mailed sign-in. The server makes a random 22-character reference (in the link) and an 8-digit code (in the e-mail) and
-- sends only their hashes: ref_hash = SHA-256 hex of the reference, code_hash = the server's keyed HMAC-SHA256 hex of the code (151's
-- pattern). Neither the reference nor the code is ever stored or seen by the database. A code is live while code_hash is set: using it,
-- the fifth wrong code, a newer code for the same contact, or revoking the contact clears code_hash for good. At most one live code per
-- contact. Expires 10 minutes after it was made, whatever happens.
CREATE TABLE public.customer_portal_signin_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  contact_id      UUID NOT NULL REFERENCES public.customer_portal_contacts(id) ON DELETE RESTRICT,
  ref_hash        TEXT NOT NULL CONSTRAINT customer_portal_signin_codes_ref_key UNIQUE,
  code_hash       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  used_at         TIMESTAMPTZ,
  burnt_at        TIMESTAMPTZ,
  burn_reason     TEXT,
  CONSTRAINT customer_portal_signin_codes_ref_hash CHECK (ref_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_portal_signin_codes_code_hash CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_portal_signin_codes_ten_minutes CHECK (expires_at = created_at + interval '10 minutes'),
  CONSTRAINT customer_portal_signin_codes_attempts CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT customer_portal_signin_codes_once CHECK (used_at IS NULL OR burnt_at IS NULL),
  CONSTRAINT customer_portal_signin_codes_burn CHECK ((burnt_at IS NULL) = (burn_reason IS NULL)
    AND (burn_reason IS NULL OR burn_reason IN ('locked', 'superseded', 'contact_revoked'))),
  CONSTRAINT customer_portal_signin_codes_live CHECK ((code_hash IS NULL) = (used_at IS NOT NULL OR burnt_at IS NOT NULL))
);
CREATE UNIQUE INDEX customer_portal_signin_codes_one_live ON public.customer_portal_signin_codes (contact_id) WHERE code_hash IS NOT NULL;
ALTER TABLE public.customer_portal_signin_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_portal_signin_codes FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zz_same_org_contact_id BEFORE INSERT OR UPDATE ON public.customer_portal_signin_codes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('customer_portal_contacts', 'contact_id');

-- ---- 3. Sessions: 30 minutes idle, 8 hours at most; company and customer fixed from the contact ------------------------------------
-- token_hash = SHA-256 hex of the 32-byte random cookie token the server made (the token is never stored). organization_id and
-- customer_id are copied from the contact when the code is used; nothing the browser sends chooses them. An ended session never comes
-- back. Sessions end at the next call after: sign-out, 30 minutes without a call, 8 hours, the company's portal switched off, the
-- company paused or closed, the contact revoked, or the customer archived.
CREATE TABLE public.customer_portal_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id),
  contact_id          UUID NOT NULL REFERENCES public.customer_portal_contacts(id) ON DELETE RESTRICT,
  customer_id         UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  code_id             UUID NOT NULL CONSTRAINT customer_portal_sessions_code_key UNIQUE REFERENCES public.customer_portal_signin_codes(id) ON DELETE RESTRICT,
  token_hash          TEXT NOT NULL CONSTRAINT customer_portal_sessions_token_key UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  end_reason          TEXT,
  CONSTRAINT customer_portal_sessions_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_portal_sessions_eight_hours CHECK (absolute_expires_at = created_at + interval '8 hours'),
  CONSTRAINT customer_portal_sessions_seen CHECK (last_seen_at >= created_at),
  CONSTRAINT customer_portal_sessions_end CHECK ((ended_at IS NULL) = (end_reason IS NULL)
    AND (end_reason IS NULL OR end_reason IN ('signed_out', 'idle', 'absolute', 'portal_off', 'revoked', 'customer_archived', 'company_inactive')))
);
CREATE INDEX customer_portal_sessions_contact_live ON public.customer_portal_sessions (contact_id) WHERE ended_at IS NULL;
ALTER TABLE public.customer_portal_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_portal_sessions FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zz_same_org_contact_id BEFORE INSERT OR UPDATE ON public.customer_portal_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('customer_portal_contacts', 'contact_id');
CREATE TRIGGER zz_same_org_customer_id BEFORE INSERT OR UPDATE ON public.customer_portal_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('customers', 'customer_id');
CREATE TRIGGER zz_same_org_code_id BEFORE INSERT OR UPDATE ON public.customer_portal_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('customer_portal_signin_codes', 'code_id');

-- ---- 4. The guards: each table changes only in the ways the functions change it; nothing is ever deleted or emptied ------------------
--   contacts: INSERT starts live; UPDATE is only the one-time revoke stamp (every other column unchanged).
--   codes: INSERT starts live with no attempts; UPDATE keeps who, reference and times, counts attempts up by one at most, only ever
--     clears code_hash (never sets a new one), and changes nothing once used or burnt.
--   sessions: INSERT starts live, for the contact's own customer; UPDATE keeps who, token and creation; once ended nothing changes.
--   DELETE and TRUNCATE are refused on all three, the owner too (the rollback refuses while any contact exists, so never needs to delete).
CREATE FUNCTION public.portal_contacts_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new portal contact starts live.' USING ERRCODE = '42501', HINT = 'contact_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.organization_id, NEW.customer_id, NEW.email, NEW.display_name, NEW.permissions, NEW.invited_by, NEW.invite_reason, NEW.invited_at)
       IS NOT DISTINCT FROM (OLD.id, OLD.organization_id, OLD.customer_id, OLD.email, OLD.display_name, OLD.permissions, OLD.invited_by, OLD.invite_reason, OLD.invited_at)
       AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'A portal contact is a record: it is only ever revoked (once, with a reason), never changed or deleted.' USING ERRCODE = '42501', HINT = 'contact_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.portal_contacts_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER portal_contacts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.customer_portal_contacts
  FOR EACH ROW EXECUTE FUNCTION public.portal_contacts_guard();

CREATE FUNCTION public.portal_signin_codes_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.code_hash IS NULL OR NEW.attempts <> 0 OR NEW.used_at IS NOT NULL OR NEW.burnt_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new sign-in code starts live, unused and with no attempts.' USING ERRCODE = '42501', HINT = 'code_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.organization_id, NEW.contact_id, NEW.ref_hash, NEW.created_at, NEW.expires_at)
       IS NOT DISTINCT FROM (OLD.id, OLD.organization_id, OLD.contact_id, OLD.ref_hash, OLD.created_at, OLD.expires_at)
       AND OLD.code_hash IS NOT NULL
       AND (NEW.code_hash IS NULL OR NEW.code_hash = OLD.code_hash)
       AND NEW.attempts IN (OLD.attempts, OLD.attempts + 1) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'A sign-in code is used once: it is never reset, reused, changed or deleted.' USING ERRCODE = '42501', HINT = 'code_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.portal_signin_codes_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER portal_signin_codes_guard BEFORE INSERT OR UPDATE OR DELETE ON public.customer_portal_signin_codes
  FOR EACH ROW EXECUTE FUNCTION public.portal_signin_codes_guard();

CREATE FUNCTION public.portal_sessions_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.customer_portal_contacts c
         WHERE c.id = NEW.contact_id AND c.organization_id = NEW.organization_id AND c.customer_id = NEW.customer_id AND c.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'A new portal session starts live, for a live contact and that contact''s own customer.' USING ERRCODE = '42501', HINT = 'session_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.organization_id, NEW.contact_id, NEW.customer_id, NEW.code_id, NEW.token_hash, NEW.created_at, NEW.absolute_expires_at)
       IS NOT DISTINCT FROM (OLD.id, OLD.organization_id, OLD.contact_id, OLD.customer_id, OLD.code_id, OLD.token_hash, OLD.created_at, OLD.absolute_expires_at)
       AND OLD.ended_at IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'A portal session is never moved, revived or deleted.' USING ERRCODE = '42501', HINT = 'session_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.portal_sessions_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER portal_sessions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.customer_portal_sessions
  FOR EACH ROW EXECUTE FUNCTION public.portal_sessions_guard();

CREATE FUNCTION public.portal_no_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Customer portal records can''t be emptied.' USING ERRCODE = '42501', HINT = 'portal_record';
END
$$;
REVOKE ALL ON FUNCTION public.portal_no_truncate() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER portal_no_truncate BEFORE TRUNCATE ON public.customer_portal_contacts FOR EACH STATEMENT EXECUTE FUNCTION public.portal_no_truncate();
CREATE TRIGGER portal_no_truncate BEFORE TRUNCATE ON public.customer_portal_signin_codes FOR EACH STATEMENT EXECUTE FUNCTION public.portal_no_truncate();
CREATE TRIGGER portal_no_truncate BEFORE TRUNCATE ON public.customer_portal_sessions FOR EACH STATEMENT EXECUTE FUNCTION public.portal_no_truncate();

-- No row audit (security_audit.log_row_change) on any portal table: a row copy would put the contact's e-mail, name and free-text
-- reasons (contacts) or hashes (codes, sessions) into the company audit log. Each invite, revoke, code sent, sign-in and session end is a
-- named event instead, by id, with a fixed category (153's offboarding pattern: category in the event, full text in a restricted record).

-- ---- 5. The security log of refusals (151's pattern) -----------------------------------------------------------------------------------
-- One row per refused customer-side call: a random correlation id (returned, so the server can show it and support can trace it), the
-- step, a fixed reason, the first 16 hex characters of the reference or session token HASH (never a reference, code, token, e-mail or
-- IP), the company only when it is known from a matched row. Row security on, no grant to anyone (not the service role): written only
-- through the writer below; read by the platform operator. RETENTION: 180 days (as 151); a scheduled purge is not part of this release.
CREATE TABLE security_audit.customer_portal_refusals (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  correlation_id  UUID NOT NULL DEFAULT gen_random_uuid() CONSTRAINT customer_portal_refusals_corr_key UNIQUE,
  step            TEXT NOT NULL CONSTRAINT customer_portal_refusals_step CHECK (step IN ('request', 'verify', 'session', 'read')),
  reason          TEXT NOT NULL CONSTRAINT customer_portal_refusals_reason CHECK (reason IN (
                    'malformed', 'unknown_email', 'unknown_ref', 'portal_off', 'company_inactive', 'customer_archived', 'revoked',
                    'code_expired', 'code_used', 'code_superseded', 'wrong_code', 'locked', 'rate_limited',
                    'not_signed_in', 'session_ended', 'session_idle', 'session_expired', 'no_permission', 'other')),
  subject_hash16  TEXT CONSTRAINT customer_portal_refusals_subject CHECK (subject_hash16 IS NULL OR subject_hash16 ~ '^[0-9a-f]{16}$'),
  organization_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_portal_refusals_time ON security_audit.customer_portal_refusals (created_at);
ALTER TABLE security_audit.customer_portal_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON security_audit.customer_portal_refusals FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE security_audit.customer_portal_refusals IS 'Refused customer portal calls. Hash prefixes only; company only from a matched row. Retention 180 days.';

-- The one writer: p_subject is a 64-hex hash made by the server (reference or token hash); only its first 16 characters are kept.
CREATE FUNCTION security_audit.portal_refuse(p_step TEXT, p_reason TEXT, p_subject TEXT, p_org UUID)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_corr UUID := gen_random_uuid();
BEGIN
  INSERT INTO security_audit.customer_portal_refusals (correlation_id, step, reason, subject_hash16, organization_id)
  VALUES (v_corr, CASE WHEN p_step IN ('request', 'verify', 'session', 'read') THEN p_step ELSE 'session' END,
          CASE WHEN p_reason IN ('malformed', 'unknown_email', 'unknown_ref', 'portal_off', 'company_inactive', 'customer_archived', 'revoked',
                                 'code_expired', 'code_used', 'code_superseded', 'wrong_code', 'locked', 'rate_limited',
                                 'not_signed_in', 'session_ended', 'session_idle', 'session_expired', 'no_permission') THEN p_reason ELSE 'other' END,
          CASE WHEN p_subject ~ '^[0-9a-f]{64}$' THEN left(p_subject, 16) END,
          p_org);
  RETURN v_corr;
END
$$;
REVOKE ALL ON FUNCTION security_audit.portal_refuse(TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 6. The session gate (private): one place for every check a signed-in customer call makes ----------------------------------------
-- Locks the session row, then in this order: the company's portal switch is ON (no row = OFF), the company is active, the contact is not
-- revoked, the customer is not archived, under 8 hours, under 30 minutes since the last accepted call. The first that fails ENDS the
-- session (it never comes back, even if the cause is undone) with a named event, logs the refusal (its category) and answers
-- {ok:false, reason:'refused', correlation_id}. Then the read rate limit (120 calls a minute per session, public.auth_rate_hit; refused, not ended). Otherwise the
-- idle clock restarts and the answer carries the session's company, customer, contact and permissions, read from the rows, never from
-- the caller. Called only by the customer-side functions below (no API role may call it).
CREATE FUNCTION public._portal_session_gate(p_token_hash TEXT, p_step TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  s     RECORD;
  v_end TEXT;
  v_why TEXT;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse(p_step, 'malformed', NULL, NULL));
  END IF;
  SELECT x.id, x.organization_id, x.contact_id, x.customer_id, x.last_seen_at, x.absolute_expires_at, x.ended_at,
         k.revoked_at AS contact_revoked_at, k.permissions, k.display_name, o.status AS company_status, o.name AS company_name, cu.name AS customer_name,
         coalesce(sw.enabled, FALSE) AS portal_on,
         EXISTS (SELECT 1 FROM public.record_archive_state a
                 WHERE a.record_table = 'customers' AND a.record_id = x.customer_id AND a.state = 'archived') AS customer_archived
    INTO s
  FROM public.customer_portal_sessions x
  JOIN public.customer_portal_contacts k ON k.id = x.contact_id AND k.organization_id = x.organization_id AND k.customer_id = x.customer_id
  JOIN public.organizations o ON o.id = x.organization_id
  JOIN public.customers cu ON cu.id = x.customer_id AND cu.organization_id = x.organization_id
  LEFT JOIN public.customer_portal_switch sw ON sw.organization_id = x.organization_id
  WHERE x.token_hash = p_token_hash
  FOR UPDATE OF x;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse(p_step, 'not_signed_in', p_token_hash, NULL));
  END IF;
  IF s.ended_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused',
                              'correlation_id', security_audit.portal_refuse(p_step, 'session_ended', p_token_hash, s.organization_id));
  END IF;
  v_end := CASE WHEN NOT s.portal_on THEN 'portal_off'
                WHEN s.company_status IS DISTINCT FROM 'active' THEN 'company_inactive'
                WHEN s.contact_revoked_at IS NOT NULL THEN 'revoked'
                WHEN s.customer_archived THEN 'customer_archived'
                WHEN now() >= s.absolute_expires_at THEN 'absolute'
                WHEN now() >= s.last_seen_at + interval '30 minutes' THEN 'idle' END;
  IF v_end IS NOT NULL THEN
    UPDATE public.customer_portal_sessions SET ended_at = now(), end_reason = v_end WHERE id = s.id;
    PERFORM security_audit.log_named_event(s.organization_id, 'CUSTOMER_PORTAL_SESSION_ENDED', 'customer_portal_sessions', s.id::TEXT,
      jsonb_build_object('end_reason', v_end, 'contact_id', s.contact_id, 'customer_id', s.customer_id));
    v_why := CASE v_end WHEN 'absolute' THEN 'session_expired' WHEN 'idle' THEN 'session_idle' ELSE v_end END;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse(p_step, v_why, p_token_hash, s.organization_id));
  END IF;
  IF NOT public.auth_rate_hit('portal_read', encode(sha256(convert_to('portal_read:' || p_token_hash, 'UTF8')), 'hex'), 60, 120) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused',
                              'correlation_id', security_audit.portal_refuse(p_step, 'rate_limited', p_token_hash, s.organization_id));
  END IF;
  UPDATE public.customer_portal_sessions SET last_seen_at = greatest(last_seen_at, now()) WHERE id = s.id;
  RETURN jsonb_build_object('ok', TRUE, 'session_id', s.id, 'organization_id', s.organization_id, 'customer_id', s.customer_id,
    'contact_id', s.contact_id, 'permissions', to_jsonb(s.permissions), 'display_name', s.display_name, 'company_name', s.company_name,
    'customer_name', s.customer_name, 'idle_expires_at', now() + interval '30 minutes', 'absolute_expires_at', s.absolute_expires_at);
END
$$;
REVOKE ALL ON FUNCTION public._portal_session_gate(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 7. Customer side (server only: service_role). Answers are JSON, never an exception for a refusal, so the refusal row and any ----
-- session end are kept. A malformed hash from the server itself (a programming error, not a visitor) is an exception, as 151.

-- 7a. "E-mail me a sign-in link": the server sends the typed e-mail and one (reference hash, code hash) pair per slot (1..10; it makes
-- fresh random ones every time). Rate limit first, whether or not the e-mail is a contact: 3 a quarter of an hour and 1 a minute per
-- e-mail (public.auth_rate_hit buckets portal_request_email and portal_request_email_min; the key is a SHA-256 of the e-mail). Then,
-- for each live contact with that e-mail (one e-mail can be a contact of several customers), in a stable order: refused and logged
-- (nothing stored) if its company's portal is OFF, the company is not active or the customer is archived; otherwise every older live
-- code of that contact is burnt, a new code is stored in the next slot and the answer lists that slot with the company and customer
-- name for the e-mail. The server's answer to the visitor must be the same whatever this returns (no account discovery).
CREATE FUNCTION public.portal_signin_request(p_email TEXT, p_ref_hashes TEXT[], p_code_hashes TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_email TEXT := lower(btrim(coalesce(p_email, '')));
  v_key   TEXT;
  v_hour  BOOLEAN;
  v_min   BOOLEAN;
  c       RECORD;
  v_slot  INTEGER := 0;
  v_any   BOOLEAN := FALSE;
  v_code  UUID;
  v_sends JSONB := '[]'::JSONB;
BEGIN
  IF p_ref_hashes IS NULL OR p_code_hashes IS NULL OR cardinality(p_ref_hashes) NOT BETWEEN 1 AND 10
     OR cardinality(p_code_hashes) <> cardinality(p_ref_hashes)
     OR EXISTS (SELECT 1 FROM unnest(p_ref_hashes || p_code_hashes) AS h WHERE h IS NULL OR h !~ '^[0-9a-f]{64}$')
     OR (SELECT count(DISTINCT h) FROM unnest(p_ref_hashes) AS h) <> cardinality(p_ref_hashes) THEN
    RAISE EXCEPTION 'Invalid request.' USING ERRCODE = '22023';
  END IF;
  IF length(v_email) NOT BETWEEN 3 AND 254 OR v_email !~ '^[^[:space:]@<>(),;:"\[\]\\]+@[^[:space:]@<>(),;:"\[\]\\]+\.[^[:space:]@<>(),;:"\[\]\\]+$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse('request', 'malformed', NULL, NULL));
  END IF;
  v_key := encode(sha256(convert_to('portal_email:' || v_email, 'UTF8')), 'hex');
  v_hour := public.auth_rate_hit('portal_request_email', v_key, 900, 3);
  v_min := public.auth_rate_hit('portal_request_email_min', v_key, 60, 1);
  IF NOT v_hour OR NOT v_min THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse('request', 'rate_limited', NULL, NULL));
  END IF;
  FOR c IN
    SELECT k.id, k.organization_id, k.customer_id, o.status AS company_status, o.name AS company_name, cu.name AS customer_name,
           coalesce(sw.enabled, FALSE) AS portal_on,
           EXISTS (SELECT 1 FROM public.record_archive_state a
                   WHERE a.record_table = 'customers' AND a.record_id = k.customer_id AND a.state = 'archived') AS customer_archived
    FROM public.customer_portal_contacts k
    JOIN public.organizations o ON o.id = k.organization_id
    JOIN public.customers cu ON cu.id = k.customer_id AND cu.organization_id = k.organization_id
    LEFT JOIN public.customer_portal_switch sw ON sw.organization_id = k.organization_id
    WHERE k.email = v_email AND k.revoked_at IS NULL
    ORDER BY k.organization_id, k.customer_id, k.id
    FOR UPDATE OF k
  LOOP
    v_any := TRUE;
    IF NOT c.portal_on THEN
      PERFORM security_audit.portal_refuse('request', 'portal_off', NULL, c.organization_id);
      CONTINUE;
    END IF;
    IF c.company_status IS DISTINCT FROM 'active' THEN
      PERFORM security_audit.portal_refuse('request', 'company_inactive', NULL, c.organization_id);
      CONTINUE;
    END IF;
    IF c.customer_archived THEN
      PERFORM security_audit.portal_refuse('request', 'customer_archived', NULL, c.organization_id);
      CONTINUE;
    END IF;
    IF v_slot >= cardinality(p_ref_hashes) THEN
      CONTINUE;
    END IF;
    v_slot := v_slot + 1;
    UPDATE public.customer_portal_signin_codes SET burnt_at = now(), burn_reason = 'superseded', code_hash = NULL
    WHERE contact_id = c.id AND code_hash IS NOT NULL;
    INSERT INTO public.customer_portal_signin_codes (organization_id, contact_id, ref_hash, code_hash, created_at, expires_at)
    VALUES (c.organization_id, c.id, p_ref_hashes[v_slot], p_code_hashes[v_slot], now(), now() + interval '10 minutes')
    RETURNING id INTO v_code;
    PERFORM security_audit.log_named_event(c.organization_id, 'CUSTOMER_PORTAL_SIGNIN_CODE_SENT', 'customer_portal_contacts', c.id::TEXT,
      jsonb_build_object('code_id', v_code, 'contact_id', c.id, 'customer_id', c.customer_id));
    v_sends := v_sends || jsonb_build_array(jsonb_build_object('slot', v_slot, 'company_name', c.company_name, 'customer_name', c.customer_name));
  END LOOP;
  IF NOT v_any THEN
    PERFORM security_audit.portal_refuse('request', 'unknown_email', NULL, NULL);
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'email', v_email, 'sends', v_sends);
END
$$;

-- 7b. The code is typed on the page the link opened. The code row is locked. In this order: a known reference; not used, not burnt, not
-- expired; contact not revoked; the company's portal ON; company active; customer not archived; then the code. A wrong code counts:
-- the fifth burns it ('locked'). The right code is used up (once) and a session is opened for that contact's customer, bound to the
-- token hash the server made for the cookie. Answers {ok:false, reason:'refused', correlation_id} or {ok:true, session}.
CREATE FUNCTION public.portal_signin_verify(p_ref_hash TEXT, p_code_hash TEXT, p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v          RECORD;
  v_why      TEXT;
  v_attempts INTEGER;
  v_session  UUID;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid request.' USING ERRCODE = '22023';
  END IF;
  IF p_ref_hash IS NULL OR p_ref_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse('verify', 'malformed', NULL, NULL));
  END IF;
  SELECT x.id, x.organization_id, x.contact_id, x.code_hash, x.expires_at, x.attempts, x.used_at, x.burnt_at, x.burn_reason,
         k.customer_id, k.revoked_at AS contact_revoked_at, k.permissions, k.display_name, o.status AS company_status, o.name AS company_name,
         cu.name AS customer_name, coalesce(sw.enabled, FALSE) AS portal_on,
         EXISTS (SELECT 1 FROM public.record_archive_state a
                 WHERE a.record_table = 'customers' AND a.record_id = k.customer_id AND a.state = 'archived') AS customer_archived
    INTO v
  FROM public.customer_portal_signin_codes x
  JOIN public.customer_portal_contacts k ON k.id = x.contact_id AND k.organization_id = x.organization_id
  JOIN public.organizations o ON o.id = x.organization_id
  JOIN public.customers cu ON cu.id = k.customer_id AND cu.organization_id = x.organization_id
  LEFT JOIN public.customer_portal_switch sw ON sw.organization_id = x.organization_id
  WHERE x.ref_hash = p_ref_hash
  FOR UPDATE OF x, k;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse('verify', 'unknown_ref', p_ref_hash, NULL));
  END IF;
  v_why := CASE WHEN v.used_at IS NOT NULL THEN 'code_used'
                WHEN v.burn_reason = 'locked' THEN 'locked'
                WHEN v.burn_reason = 'contact_revoked' OR v.contact_revoked_at IS NOT NULL THEN 'revoked'
                WHEN v.burnt_at IS NOT NULL THEN 'code_superseded'
                WHEN now() >= v.expires_at THEN 'code_expired'
                WHEN NOT v.portal_on THEN 'portal_off'
                WHEN v.company_status IS DISTINCT FROM 'active' THEN 'company_inactive'
                WHEN v.customer_archived THEN 'customer_archived' END;
  IF v_why IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse('verify', v_why, p_ref_hash, v.organization_id));
  END IF;
  IF v.code_hash IS DISTINCT FROM p_code_hash THEN
    v_attempts := v.attempts + 1;
    IF v_attempts >= 5 THEN
      UPDATE public.customer_portal_signin_codes SET attempts = v_attempts, burnt_at = now(), burn_reason = 'locked', code_hash = NULL WHERE id = v.id;
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse('verify', 'locked', p_ref_hash, v.organization_id));
    END IF;
    UPDATE public.customer_portal_signin_codes SET attempts = v_attempts WHERE id = v.id;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused',
                              'correlation_id', security_audit.portal_refuse('verify', 'wrong_code', p_ref_hash, v.organization_id));
  END IF;
  UPDATE public.customer_portal_signin_codes SET used_at = now(), code_hash = NULL WHERE id = v.id;
  INSERT INTO public.customer_portal_sessions (organization_id, contact_id, customer_id, code_id, token_hash, created_at, last_seen_at, absolute_expires_at)
  VALUES (v.organization_id, v.contact_id, v.customer_id, v.id, p_token_hash, now(), now(), now() + interval '8 hours')
  RETURNING id INTO v_session;
  PERFORM security_audit.log_named_event(v.organization_id, 'CUSTOMER_PORTAL_SIGNED_IN', 'customer_portal_sessions', v_session::TEXT,
    jsonb_build_object('contact_id', v.contact_id, 'customer_id', v.customer_id, 'code_id', v.id));
  RETURN jsonb_build_object('ok', TRUE, 'session', jsonb_build_object('contact_id', v.contact_id, 'display_name', v.display_name,
    'company_name', v.company_name, 'customer_name', v.customer_name, 'permissions', to_jsonb(v.permissions),
    'idle_expires_at', now() + interval '30 minutes', 'absolute_expires_at', now() + interval '8 hours'));
END
$$;

-- 7c. Every portal page: the gate, then who is signed in (no ids of the company or customer, no hashes).
CREATE FUNCTION public.portal_session_resolve(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  g JSONB := public._portal_session_gate(p_token_hash, 'session');
BEGIN
  IF NOT (g ->> 'ok')::BOOLEAN THEN
    RETURN g;
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'session', jsonb_build_object('contact_id', g -> 'contact_id', 'display_name', g -> 'display_name',
    'company_name', g -> 'company_name', 'customer_name', g -> 'customer_name', 'permissions', g -> 'permissions',
    'idle_expires_at', g -> 'idle_expires_at', 'absolute_expires_at', g -> 'absolute_expires_at'));
END
$$;

-- 7d. Sign out: ends the session if it is live (always allowed: it only ever removes access). Same answer either way.
CREATE FUNCTION public.portal_session_end(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  s RECORD;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', TRUE);
  END IF;
  UPDATE public.customer_portal_sessions x SET ended_at = now(), end_reason = 'signed_out'
  WHERE x.token_hash = p_token_hash AND x.ended_at IS NULL
  RETURNING x.id, x.organization_id, x.contact_id, x.customer_id INTO s;
  IF FOUND THEN
    PERFORM security_audit.log_named_event(s.organization_id, 'CUSTOMER_PORTAL_SESSION_ENDED', 'customer_portal_sessions', s.id::TEXT,
      jsonb_build_object('end_reason', 'signed_out', 'contact_id', s.contact_id, 'customer_id', s.customer_id));
  END IF;
  RETURN jsonb_build_object('ok', TRUE);
END
$$;

-- 7e. Quotes (permission 'quotes'): only documents with a VERIFIED link to the session's own customer in the session's own company
-- (153's document_customer_links_verified: never a backfill link nobody verified, an unlinked document or one whose names changed),
-- only sent, accepted or rejected (never a draft or a superseded version), never an archived quote (record_archive_state; shown again
-- once unarchived while the link is still live), and only these fields. One named event per list.
CREATE FUNCTION public.portal_quotes(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  g      JSONB := public._portal_session_gate(p_token_hash, 'read');
  v_org  UUID;
  v_cust UUID;
  v_rows JSONB;
  v_n    INTEGER;
BEGIN
  IF NOT (g ->> 'ok')::BOOLEAN THEN
    RETURN g;
  END IF;
  v_org := (g ->> 'organization_id')::UUID;
  v_cust := (g ->> 'customer_id')::UUID;
  IF NOT (g -> 'permissions') ? 'quotes' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse('read', 'no_permission', p_token_hash, v_org));
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('quote_ref', q.quote_ref, 'status', q.status, 'sent_at', q.sent_at, 'valid_until', q.valid_until,
           'customer_po', q.customer_po, 'total_value', q.total_value) ORDER BY q.sent_at DESC NULLS LAST, q.quote_ref), '[]'::JSONB), count(*)::INTEGER
    INTO v_rows, v_n
  FROM public.document_customer_links_verified l
  JOIN public.quotes q ON q.id = l.document_id AND q.organization_id = l.organization_id
  WHERE l.organization_id = v_org AND l.customer_id = v_cust AND l.doc_kind = 'quote' AND q.status IN ('sent', 'accepted', 'rejected')
    AND NOT EXISTS (SELECT 1 FROM public.record_archive_state a WHERE a.record_table = 'quotes' AND a.record_id = q.id AND a.state = 'archived');
  PERFORM security_audit.log_named_event(v_org, 'CUSTOMER_PORTAL_DOCUMENTS_VIEWED', 'customer_portal_sessions', g ->> 'session_id',
    jsonb_build_object('kind', 'quotes', 'count', v_n, 'contact_id', g -> 'contact_id', 'customer_id', v_cust));
  RETURN jsonb_build_object('ok', TRUE, 'quotes', v_rows);
END
$$;

-- 7f. Jobs (permission 'jobs'): verified links only (153's view never shows an internal job), never an archived job (record_archive_state;
-- shown again once unarchived while the link is still live), and only these fields. The stage is a
-- fixed customer-facing word from the job's flow (the rule of lib/job-flow.ts jobStatusOf, with running, rework and waiting for
-- inspection all shown as in_progress): not_started, in_progress or complete. Nothing else of the job is returned.
CREATE FUNCTION public.portal_jobs(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  g      JSONB := public._portal_session_gate(p_token_hash, 'read');
  v_org  UUID;
  v_cust UUID;
  v_rows JSONB;
  v_n    INTEGER;
BEGIN
  IF NOT (g ->> 'ok')::BOOLEAN THEN
    RETURN g;
  END IF;
  v_org := (g ->> 'organization_id')::UUID;
  v_cust := (g ->> 'customer_id')::UUID;
  IF NOT (g -> 'permissions') ? 'jobs' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'refused', 'correlation_id', security_audit.portal_refuse('read', 'no_permission', p_token_hash, v_org));
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('job_no', j.job_no, 'customer_po', j.customer_po, 'due_date', j.due_date,
           'stage', CASE WHEN j.stage = 'rework' THEN 'in_progress' WHEN j.inspected_at IS NOT NULL THEN 'complete'
                         WHEN j.finished_at IS NOT NULL OR j.started_at IS NOT NULL THEN 'in_progress' ELSE 'not_started' END)
           ORDER BY j.due_date NULLS LAST, j.job_no), '[]'::JSONB), count(*)::INTEGER
    INTO v_rows, v_n
  FROM public.document_customer_links_verified l
  JOIN public.jobs j ON j.id = l.document_id AND j.organization_id = l.organization_id
  WHERE l.organization_id = v_org AND l.customer_id = v_cust AND l.doc_kind = 'job' AND NOT j.is_internal
    AND NOT EXISTS (SELECT 1 FROM public.record_archive_state a WHERE a.record_table = 'jobs' AND a.record_id = j.id AND a.state = 'archived');
  PERFORM security_audit.log_named_event(v_org, 'CUSTOMER_PORTAL_DOCUMENTS_VIEWED', 'customer_portal_sessions', g ->> 'session_id',
    jsonb_build_object('kind', 'jobs', 'count', v_n, 'contact_id', g -> 'contact_id', 'customer_id', v_cust));
  RETURN jsonb_build_object('ok', TRUE, 'jobs', v_rows);
END
$$;

REVOKE ALL ON FUNCTION public.portal_signin_request(TEXT, TEXT[], TEXT[]), public.portal_signin_verify(TEXT, TEXT, TEXT),
  public.portal_session_resolve(TEXT), public.portal_session_end(TEXT), public.portal_quotes(TEXT), public.portal_jobs(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.portal_signin_request(TEXT, TEXT[], TEXT[]), public.portal_signin_verify(TEXT, TEXT, TEXT),
  public.portal_session_resolve(TEXT), public.portal_session_end(TEXT), public.portal_quotes(TEXT), public.portal_jobs(TEXT)
  TO service_role;

-- ---- 8. Staff side (signed in; 153's actor rule: the company's own ADMIN, 033's second step where the company asks for it, never a ----
-- support or read-only session). Inviting also needs an authenticator code from the last 15 minutes and the portal ON; listing and
-- revoking never wait for a fresh code (revoking only removes access, as 153's switch-off). Exceptions, as every staff function.

CREATE FUNCTION public.portal_contact_invite(p_customer UUID, p_email TEXT, p_name TEXT, p_permissions TEXT[], p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public._document_customer_link_actor(ARRAY['admin'], TRUE);
  v_uid     UUID := auth.uid();
  v_reason  TEXT;
  v_email   TEXT := lower(btrim(coalesce(p_email, '')));
  v_name    TEXT := btrim(coalesce(p_name, ''));
  v_perms   TEXT[];
  v_contact UUID;
BEGIN
  v_reason := public._document_customer_link_reason(p_reason);
  IF NOT coalesce((SELECT s.enabled FROM public.customer_portal_switch s WHERE s.organization_id = v_org), FALSE) THEN
    RAISE EXCEPTION 'The customer portal is off for your company: switch it on first.' USING ERRCODE = '55000', HINT = 'portal_off';
  END IF;
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer AND c.organization_id = v_org) THEN
    RAISE EXCEPTION 'That customer isn''t in your company.' USING ERRCODE = 'P0002', HINT = 'customer_not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.record_archive_state a WHERE a.record_table = 'customers' AND a.record_id = p_customer AND a.state = 'archived') THEN
    RAISE EXCEPTION 'That customer is archived.' USING ERRCODE = '22023', HINT = 'customer_archived';
  END IF;
  IF length(v_email) NOT BETWEEN 3 AND 254 OR v_email !~ '^[^[:space:]@<>(),;:"\[\]\\]+@[^[:space:]@<>(),;:"\[\]\\]+\.[^[:space:]@<>(),;:"\[\]\\]+$' THEN
    RAISE EXCEPTION 'Enter a valid e-mail address.' USING ERRCODE = '22023', HINT = 'invalid_email';
  END IF;
  IF length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Enter the person''s name (up to 120 characters).' USING ERRCODE = '22023', HINT = 'invalid_name';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_perms FROM unnest(p_permissions) AS x;
  IF v_perms IS NULL OR array_position(v_perms, NULL) IS NOT NULL OR NOT (v_perms <@ ARRAY['quotes', 'jobs']::TEXT[]) THEN
    RAISE EXCEPTION 'Choose what the person may see: quotes, jobs or both.' USING ERRCODE = '22023', HINT = 'invalid_permissions';
  END IF;
  BEGIN
    INSERT INTO public.customer_portal_contacts (organization_id, customer_id, email, display_name, permissions, invited_by, invite_reason, invited_at)
    VALUES (v_org, p_customer, v_email, v_name, v_perms, v_uid, v_reason, clock_timestamp())
    RETURNING id INTO v_contact;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That e-mail is already a portal contact of this customer.' USING ERRCODE = '55000', HINT = 'already_invited';
  END;
  PERFORM security_audit.log_named_event(v_org, 'CUSTOMER_PORTAL_CONTACT_INVITED', 'customer_portal_contacts', v_contact::TEXT,
    jsonb_build_object('contact_id', v_contact, 'customer_id', p_customer, 'permissions', to_jsonb(v_perms), 'reason_category', 'portal_access_granted', 'actor', v_uid));
  RETURN jsonb_build_object('contact_id', v_contact, 'customer_id', p_customer, 'permissions', to_jsonb(v_perms));
END
$$;

CREATE FUNCTION public.portal_contacts_list(p_customer UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public._document_customer_link_actor(ARRAY['admin'], FALSE);
BEGIN
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer AND c.organization_id = v_org) THEN
    RAISE EXCEPTION 'That customer isn''t in your company.' USING ERRCODE = 'P0002', HINT = 'customer_not_found';
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('contact_id', k.id, 'email', k.email, 'display_name', k.display_name,
                     'permissions', to_jsonb(k.permissions), 'invited_at', k.invited_at, 'invited_by', k.invited_by, 'revoked_at', k.revoked_at,
                     'live_sessions', (SELECT count(*) FROM public.customer_portal_sessions x WHERE x.contact_id = k.id AND x.ended_at IS NULL)::INTEGER)
                   ORDER BY k.invited_at, k.id)
                   FROM public.customer_portal_contacts k WHERE k.organization_id = v_org AND k.customer_id = p_customer), '[]'::JSONB);
END
$$;

CREATE FUNCTION public.portal_contact_revoke(p_contact UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public._document_customer_link_actor(ARRAY['admin'], FALSE);
  v_uid    UUID := auth.uid();
  v_reason TEXT;
  v_k      public.customer_portal_contacts%ROWTYPE;
  v_at     TIMESTAMPTZ := clock_timestamp();
  v_ended  INTEGER;
  v_s      RECORD;
BEGIN
  v_reason := public._document_customer_link_reason(p_reason);
  SELECT * INTO v_k FROM public.customer_portal_contacts k WHERE k.id = p_contact AND k.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That portal contact isn''t in your company.' USING ERRCODE = 'P0002', HINT = 'contact_not_found';
  END IF;
  IF v_k.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'That portal contact is already revoked.' USING ERRCODE = '55000', HINT = 'already_revoked';
  END IF;
  UPDATE public.customer_portal_contacts SET revoked_at = v_at, revoked_by = v_uid, revoke_reason = v_reason WHERE id = v_k.id;
  UPDATE public.customer_portal_signin_codes SET burnt_at = v_at, burn_reason = 'contact_revoked', code_hash = NULL
  WHERE contact_id = v_k.id AND code_hash IS NOT NULL;
  v_ended := 0;
  FOR v_s IN
    UPDATE public.customer_portal_sessions SET ended_at = v_at, end_reason = 'revoked' WHERE contact_id = v_k.id AND ended_at IS NULL RETURNING id
  LOOP
    v_ended := v_ended + 1;
    PERFORM security_audit.log_named_event(v_org, 'CUSTOMER_PORTAL_SESSION_ENDED', 'customer_portal_sessions', v_s.id::TEXT,
      jsonb_build_object('end_reason', 'revoked', 'contact_id', v_k.id, 'customer_id', v_k.customer_id));
  END LOOP;
  PERFORM security_audit.log_named_event(v_org, 'CUSTOMER_PORTAL_CONTACT_REVOKED', 'customer_portal_contacts', v_k.id::TEXT,
    jsonb_build_object('contact_id', v_k.id, 'customer_id', v_k.customer_id, 'ended_sessions', v_ended, 'reason_category', 'portal_access_revoked', 'actor', v_uid));
  RETURN jsonb_build_object('contact_id', v_k.id, 'revoked_at', v_at, 'ended_sessions', v_ended);
END
$$;

REVOKE ALL ON FUNCTION public.portal_contact_invite(UUID, TEXT, TEXT, TEXT[], TEXT), public.portal_contacts_list(UUID), public.portal_contact_revoke(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.portal_contact_invite(UUID, TEXT, TEXT, TEXT[], TEXT), public.portal_contacts_list(UUID), public.portal_contact_revoke(UUID, TEXT)
  TO authenticated;


-- ---- Self-check before COMMIT (anything wrong: the whole release is rolled back) -------------------------------------------------------
DO $p154_self_check$
BEGIN
  IF EXISTS (SELECT * FROM _p154_before EXCEPT SELECT * FROM pg_temp.p154_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p154_fingerprint() EXCEPT SELECT * FROM _p154_before) THEN
    RAISE EXCEPTION '154 self-check: a 153 object, a helper, or a trigger, policy, column, grant or row of a table 154 reads, changed';
  END IF;
  IF NOT coalesce((SELECT bool_and(c.relrowsecurity) AND count(*) = 4 FROM pg_class c
                   WHERE c.oid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'),
                                   to_regclass('public.customer_portal_sessions'), to_regclass('security_audit.customer_portal_refusals'))), FALSE)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['public.customer_portal_contacts', 'public.customer_portal_signin_codes', 'public.customer_portal_sessions',
                                           'security_audit.customer_portal_refusals']) AS tb(n), unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
                WHERE has_table_privilege(r.role, tb.n, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
    RAISE EXCEPTION '154 self-check: the portal tables must have row security on and no grant to any API role';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public.portal_signin_request(text,text[],text[])', 'public.portal_signin_verify(text,text,text)',
                                        'public.portal_session_resolve(text)', 'public.portal_session_end(text)', 'public.portal_quotes(text)',
                                        'public.portal_jobs(text)']) AS f(sig)
             LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
             WHERE p.oid IS NULL OR NOT p.prosecdef OR p.proconfig IS NULL OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION '154 self-check: the six customer-side functions must be SECURITY DEFINER, pinned, callable by the service role only';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public.portal_contact_invite(uuid,text,text,text[],text)', 'public.portal_contacts_list(uuid)',
                                        'public.portal_contact_revoke(uuid,text)']) AS f(sig)
             LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
             WHERE p.oid IS NULL OR NOT p.prosecdef OR p.proconfig IS NULL OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION '154 self-check: the three staff functions must be SECURITY DEFINER, pinned, callable by signed-in users only';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public._portal_session_gate(text,text)', 'security_audit.portal_refuse(text,text,text,uuid)',
                                        'public.portal_contacts_guard()', 'public.portal_signin_codes_guard()', 'public.portal_sessions_guard()',
                                        'public.portal_no_truncate()']) AS f(sig), unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
             WHERE to_regprocedure(f.sig) IS NULL OR has_function_privilege(r.role, to_regprocedure(f.sig), 'EXECUTE')) THEN
    RAISE EXCEPTION '154 self-check: the private functions must be callable by no API role';
  END IF;
  -- 153's verify counts public functions named customer_portal% or %document_customer%: still exactly 153's eight callable ones (154 adds none).
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE '%document_customer%' OR p.proname LIKE 'customer_portal%')
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 8 THEN
    RAISE EXCEPTION '154 self-check: a 154 function is named like a 153 function';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = to_regprocedure('security_audit.log_row_change()')
               AND t.tgrelid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'),
                                 to_regclass('public.customer_portal_sessions'), to_regclass('security_audit.customer_portal_refusals'))) THEN
    RAISE EXCEPTION '154 self-check: no portal table may be row-audited (e-mail, names, free text and hashes stay out of the company audit)';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'f' AND c.confdeltype = 'r'
        AND c.conrelid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'), to_regclass('public.customer_portal_sessions'))
        AND c.confrelid IN (to_regclass('public.customers'), to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'))) <> 5
     OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.confdeltype = 'c'
                  AND c.conrelid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'), to_regclass('public.customer_portal_sessions'))) THEN
    RAISE EXCEPTION '154 self-check: the customer, contact and code references must be ON DELETE RESTRICT, never CASCADE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_portal_contacts) OR EXISTS (SELECT 1 FROM public.customer_portal_signin_codes)
     OR EXISTS (SELECT 1 FROM public.customer_portal_sessions) OR EXISTS (SELECT 1 FROM security_audit.customer_portal_refusals) THEN
    RAISE EXCEPTION '154 self-check: the release must start with no contact, code, session or refusal';
  END IF;
END
$p154_self_check$;
DROP FUNCTION pg_temp.p154_fingerprint();
COMMIT;
