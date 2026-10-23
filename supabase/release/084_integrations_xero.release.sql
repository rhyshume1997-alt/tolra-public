-- 084_integrations_xero.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 084: Integrations layer + Xero connect and push (G22, Lot B PR 1; Rhys, Mon 19 Oct). One way, Tolra to Xero only: issued invoices,
-- issued credit notes and their customers; Tolra numbers kept; voids sent as voids; nothing is ever pulled back (payments stay in Xero,
-- from the bank feed; the office marks paid in Tolra by hand; Tolra sends no payments). Per company, OFF by default.
-- Applies after 083 (needs 030, 035, 036, 065, 076 and 078). Rules: nothing sends unless the company is connected AND every VAT rate its
-- waiting documents use is mapped (and both account codes are set); each document is sent once (keyed by its id); tokens are encrypted
-- at rest by the server (AES-256-GCM, key outside the database) and never readable through the API; every change audited, no token or
-- secret in any audit row; RLS, company isolation, two-step sign-in and the API grants as tight as before.
--
-- WHAT CHANGES (six new tables, twenty new functions, two triggers; no existing function or table is changed).
-- 1. public.integration_connections: one row per company and provider (provider 'xero' only for now): connected / needs_reconnect /
--    disconnected, the Xero organisation (tenant) id and name, who connected it and when. A Xero organisation is linked to ONE Tolra
--    company at a time (unique index), so JNR and Marpet can never share one by mistake. Admins of the company read it; no API write.
-- 2. public.integration_secrets: the refresh and access tokens, as ciphertext only (a CHECK refuses anything that is not the server's
--    "v<version>.<iv>.<tag>.<data>" form, so a plain token can't be stored by mistake), the key version, the access token's expiry, and
--    the refresh lease. RLS on with NO policy and every API grant revoked: no signed-in user reads it, through any path. Not audited (a
--    copy of the ciphertext in the audit log would outlive a disconnect); connect, disconnect and needs-reconnect are named events.
-- 3. public.integration_oauth_states: one row per Connect click: the hash of the OAuth state, the PKCE verifier (ciphertext), the
--    company and admin it is bound to, 10 minutes, single use. Same lock-down as the secrets; not audited.
-- 4. public.integration_mappings: the account codes (sales, credit notes) and one Xero tax rate per Tolra VAT key ('20', '5', '0',
--    'exempt', 'no_vat', or any other rate in use). Admins read them; written only by integration_set_mapping (admin, two-step).
-- 5. public.integration_contacts: Tolra customer (the name on the document, exactly) to the Xero contact: matched by exact name, created,
--    or chosen by an admin; two or more matches (or an archived or differently spelt one) is a problem, never a guess.
-- 6. public.integration_sends: the send log. One row per document and action (create / void), UNIQUE, so each document is sent once,
--    keyed by its id: pending -> sending -> sent / failed (with the reason) / needs_check (the result is unknown: read Xero back first)
--    / skipped (never sent, and why). Admins read it.
-- 7. Enqueue (trigger zz_integration_enqueue on invoices and credit_notes, AFTER UPDATE OF status): when a draft is issued, and when an
--    invoice already queued is voided, a row is added for each provider the company is connected to. Nothing is queued while the company
--    is not connected (documents issued before it connects are never sent), and never for imported records (076: the import's own
--    session setting, or the record in import_record_keys). Issuing never waits for, or fails because of, the provider.
-- 8. Functions. Signed-in (admin, two-step sign-in, own company only): integration_oauth_begin, integration_disconnect,
--    integration_set_mapping, integration_retry_send, integration_resolve_contact; integration_overview (admin, read). Server only
--    (service role; EXECUTE revoked from PUBLIC, anon and authenticated): integration_oauth_consume, integration_store_connection,
--    integration_mark_needs_reconnect, integration_token_lease / _store / _release (the single-use refresh token is rotated by exactly
--    one caller: the new one is stored before it is used), integration_claim_next (FOR UPDATE SKIP LOCKED; the gate: connected and
--    nothing unmapped), integration_record_result (only by the claim that holds the row), integration_contact_record,
--    integration_document (the document as sent, with each line's VAT key: the one place the keys are worked out),
--    integration_unmapped. Internal: integration_vat_key, integration_carriage_vat_key (Q5: carriage without VAT is sent as no VAT;
--    carriage with VAT gets the standard rate), integration_enqueue. Connecting to a different organisation clears the contact matches;
--    a void whose invoice went to another organisation is skipped with the reason.
-- GUARD (section 1): what 084 builds on is there, and 084's own functions, if present, are 084's (md5 with every whitespace character
-- removed). Anything else stops the release and nothing of 084 is kept. Safe to run again.
-- Rollback: supabase/release/084_integrations_xero.rollback.sql (drops everything 084 adds; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 084 builds on is there.
DO $$
BEGIN
  IF to_regclass('public.invoices') IS NULL OR to_regclass('public.credit_notes') IS NULL OR to_regclass('public.credit_note_lines') IS NULL
     OR to_regclass('public.invoice_line_items') IS NULL OR to_regclass('public.import_record_keys') IS NULL THEN
    RAISE EXCEPTION '084: invoices, credit notes (034) or import_record_keys (076) is missing';
  END IF;
  IF to_regprocedure('public.org_vat_registered(uuid)') IS NULL OR to_regprocedure('public.org_standard_vat_rate(uuid)') IS NULL
     OR to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL
     OR to_regprocedure('public.support_readonly_guard()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL
     OR to_regprocedure('security_audit.log_row_change()') IS NULL OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '084: a helper it needs (030 to 065) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organization_members' AND column_name = 'support') THEN
    RAISE EXCEPTION '084: organization_members.support (036) is missing';
  END IF;
  -- On a second run its own functions are 084's (md5 with every whitespace character removed: a CRLF paste matches); a function of
  -- the same name with any other body stops the release and nothing of 084 is kept.
  IF EXISTS (SELECT 1 FROM pg_proc p
             JOIN (VALUES ('public.integration_vat_key(boolean,boolean,numeric)', '5888052cf753ac3981ad80ac88a03c2a'),
                          ('public.integration_carriage_vat_key(boolean,boolean,numeric)', 'a7a2b19c8f37e3a56171165e565947f3'),
                          ('public.integration_document(uuid,text,uuid)', '795a05b1b69e782009016c166ae1f134'),
                          ('public.integration_unmapped(uuid,text)', '7a82009695c1f1a79b1df7d68fac724e'),
                          ('public.integration_enqueue()', '26bba3708dd4f02328376e1cd632f7d0'),
                          ('public.integration_oauth_begin(text,text,text)', '426b80b684e190d212cbdb18d511bd4a'),
                          ('public.integration_oauth_consume(uuid,uuid,text,text)', 'f69377561a80fcbc71b8521879226125'),
                          ('public.integration_store_connection(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,integer)', 'c3c0d54db277c9a3a2e3db0194570f76'),
                          ('public.integration_disconnect(text)', '3a3581322cd57e116908074c2357fda1'),
                          ('public.integration_mark_needs_reconnect(uuid,text,text)', 'f4e26e9d96d6c9ff861842876d27cb48'),
                          ('public.integration_token_lease(uuid,text,uuid,integer)', 'a2b30349f62887d0155a140308637864'),
                          ('public.integration_token_store(uuid,text,uuid,text,text,timestamp with time zone,integer)', 'a2789f9ce27710bf857f5543ac7ada04'),
                          ('public.integration_token_release(uuid,text,uuid)', 'abc5577db31577fb09499063eadc294d'),
                          ('public.integration_claim_next(uuid,text,integer,text,uuid)', '1e926cf7051cc6614f0cfc6b2124b470'),
                          ('public.integration_record_result(uuid,uuid,text,text,text,text,timestamp with time zone)', '8bc5ebfbf2317fe1d461006158326ce8'),
                          ('public.integration_set_mapping(text,text,text,text,text)', '52d30fd1c2605d0eccae08d07f71b22a'),
                          ('public.integration_retry_send(uuid)', '1e8e2136759e43952aa406f8a6bcac88'),
                          ('public.integration_contact_record(uuid,text,text,text,text,text)', 'c501214f478528b3da30c22362766db9'),
                          ('public.integration_resolve_contact(text,text,text)', 'f822e371fec0c04762d8a337ffb4f64a'),
                          ('public.integration_overview(text)', 'dd5820b12ef24958b5a16cca5a4d36b9')) AS f(sig, body)
               ON p.oid = to_regprocedure(f.sig)
             WHERE md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> f.body) THEN
    RAISE EXCEPTION '084: a function 084 creates already exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The tables.
-- 2a. Connections: one per company and provider. No secrets here.
CREATE TABLE IF NOT EXISTS public.integration_connections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES public.organizations(id),
  provider               TEXT NOT NULL CHECK (provider IN ('xero')),
  status                 TEXT NOT NULL CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
  tenant_id              TEXT CHECK (tenant_id IS NULL OR (length(tenant_id) BETWEEN 1 AND 100 AND tenant_id !~ '[[:cntrl:][:space:]]')),
  tenant_name            TEXT CHECK (tenant_name IS NULL OR (length(btrim(tenant_name)) BETWEEN 1 AND 200 AND tenant_name !~ '[[:cntrl:]]')),
  external_connection_id TEXT CHECK (external_connection_id IS NULL OR (length(external_connection_id) BETWEEN 1 AND 100 AND external_connection_id !~ '[[:cntrl:][:space:]]')),
  status_reason          TEXT CHECK (status_reason IS NULL OR (length(status_reason) <= 300 AND status_reason !~ '[[:cntrl:]]')),
  connected_by           UUID,
  connected_at           TIMESTAMPTZ,
  disconnected_by        UUID,
  disconnected_at        TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_connections_org_provider_key UNIQUE (organization_id, provider),
  CONSTRAINT integration_connections_live_has_tenant CHECK (status = 'disconnected' OR tenant_id IS NOT NULL)
);
-- A Xero organisation is linked to one Tolra company at a time.
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_one_company_per_tenant ON public.integration_connections (provider, tenant_id)
  WHERE status <> 'disconnected';

-- 2b. Secrets: ciphertext only, never readable through the API (RLS on, no policy, no grant).
CREATE TABLE IF NOT EXISTS public.integration_secrets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  provider          TEXT NOT NULL CHECK (provider IN ('xero')),
  refresh_token_enc TEXT NOT NULL CHECK (refresh_token_enc ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND length(refresh_token_enc) <= 8000),
  access_token_enc  TEXT CHECK (access_token_enc IS NULL OR (access_token_enc ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND length(access_token_enc) <= 16000)),
  access_expires_at TIMESTAMPTZ,
  key_version       INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 999),
  lease_holder      UUID,
  lease_until       TIMESTAMPTZ,
  rotated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_secrets_org_provider_key UNIQUE (organization_id, provider)
);

-- 2c. OAuth states: single use, 10 minutes, bound to the company and the admin who clicked Connect.
CREATE TABLE IF NOT EXISTS public.integration_oauth_states (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  provider        TEXT NOT NULL CHECK (provider IN ('xero')),
  user_id         UUID NOT NULL,
  state_hash      TEXT NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  verifier_enc    TEXT NOT NULL CHECK (verifier_enc ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND length(verifier_enc) <= 2000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  CONSTRAINT integration_oauth_states_state_key UNIQUE (state_hash)
);
CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_org ON public.integration_oauth_states (organization_id, user_id, expires_at);

-- 2d. Mappings: account codes and one tax rate per Tolra VAT key.
CREATE TABLE IF NOT EXISTS public.integration_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  provider        TEXT NOT NULL CHECK (provider IN ('xero')),
  kind            TEXT NOT NULL CHECK (kind IN ('sales_account', 'credit_account', 'tax_rate')),
  tolra_key       TEXT NOT NULL DEFAULT '' CHECK (tolra_key = '' OR tolra_key ~ '^(exempt|no_vat|[0-9]{1,3}(\.[0-9]{1,2})?)$'),
  external_code   TEXT NOT NULL CHECK (length(btrim(external_code)) BETWEEN 1 AND 50 AND external_code !~ '[[:cntrl:]]'),
  external_name   TEXT CHECK (external_name IS NULL OR (length(external_name) <= 200 AND external_name !~ '[[:cntrl:]]')),
  updated_by      UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_mappings_key_by_kind CHECK ((kind = 'tax_rate') = (tolra_key <> '')),
  CONSTRAINT integration_mappings_one_per_key UNIQUE (organization_id, provider, kind, tolra_key)
);

-- 2e. Contacts: the customer's name on the document, exactly, to the provider's contact. Two or more matches is a problem.
CREATE TABLE IF NOT EXISTS public.integration_contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id),
  provider            TEXT NOT NULL CHECK (provider IN ('xero')),
  customer_name       TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 300 AND customer_name = btrim(customer_name)),
  external_contact_id TEXT CHECK (external_contact_id IS NULL OR (length(external_contact_id) BETWEEN 1 AND 100 AND external_contact_id !~ '[[:cntrl:][:space:]]')),
  matched_by          TEXT CHECK (matched_by IS NULL OR matched_by IN ('exact_name', 'created', 'chosen')),
  state               TEXT NOT NULL CHECK (state IN ('ok', 'problem')),
  problem             TEXT CHECK (problem IS NULL OR (length(problem) <= 300 AND problem !~ '[[:cntrl:]]')),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_contacts_ok_has_contact CHECK ((state = 'ok') = (external_contact_id IS NOT NULL AND matched_by IS NOT NULL)),
  CONSTRAINT integration_contacts_one_per_name UNIQUE (organization_id, provider, customer_name)
);

-- 2f. The send log: each document and action once.
CREATE TABLE IF NOT EXISTS public.integration_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  provider        TEXT NOT NULL CHECK (provider IN ('xero')),
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('invoice', 'credit_note')),
  doc_id          UUID NOT NULL,
  doc_ref         TEXT CHECK (doc_ref IS NULL OR length(doc_ref) <= 100),
  action          TEXT NOT NULL CHECK (action IN ('create', 'void')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'needs_check', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token     UUID,
  claimed_until   TIMESTAMPTZ,
  tenant_id       TEXT CHECK (tenant_id IS NULL OR length(tenant_id) <= 100),
  external_id     TEXT CHECK (external_id IS NULL OR (length(external_id) BETWEEN 1 AND 100 AND external_id !~ '[[:cntrl:][:space:]]')),
  external_number TEXT CHECK (external_number IS NULL OR (length(external_number) BETWEEN 1 AND 100 AND external_number !~ '[[:cntrl:]]')),
  last_error      TEXT CHECK (last_error IS NULL OR (length(last_error) <= 500 AND last_error !~ '[[:cntrl:]]')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  CONSTRAINT integration_sends_void_is_invoice CHECK (action = 'create' OR doc_type = 'invoice'),
  CONSTRAINT integration_sends_sent_has_external CHECK (status <> 'sent' OR external_id IS NOT NULL),
  CONSTRAINT integration_sends_once UNIQUE (organization_id, provider, doc_type, doc_id, action)
);
CREATE INDEX IF NOT EXISTS idx_integration_sends_queue ON public.integration_sends (organization_id, provider, status, next_attempt_at);

-- 2g. Row level security, grants and the guards every company table carries. Readable tables: the company's admins only, SELECT only.
ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "integration_connections admin select" ON public.integration_connections;
CREATE POLICY "integration_connections admin select" ON public.integration_connections FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "integration_mappings admin select" ON public.integration_mappings;
CREATE POLICY "integration_mappings admin select" ON public.integration_mappings FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "integration_contacts admin select" ON public.integration_contacts;
CREATE POLICY "integration_contacts admin select" ON public.integration_contacts FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "integration_sends admin select" ON public.integration_sends;
CREATE POLICY "integration_sends admin select" ON public.integration_sends FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

REVOKE ALL ON public.integration_connections, public.integration_secrets, public.integration_oauth_states, public.integration_mappings,
  public.integration_contacts, public.integration_sends FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.integration_connections, public.integration_mappings, public.integration_contacts, public.integration_sends TO authenticated;

-- Row audit on the four readable tables (no secret in any of them). The secrets and the OAuth states are NOT audited: a copy of the
-- ciphertext in the audit log would outlive a disconnect; connect, disconnect and needs-reconnect are named events instead.
DROP TRIGGER IF EXISTS audit_integration_connections_changes ON public.integration_connections;
CREATE TRIGGER audit_integration_connections_changes AFTER INSERT OR DELETE OR UPDATE ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS audit_integration_mappings_changes ON public.integration_mappings;
CREATE TRIGGER audit_integration_mappings_changes AFTER INSERT OR DELETE OR UPDATE ON public.integration_mappings
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS audit_integration_contacts_changes ON public.integration_contacts;
CREATE TRIGGER audit_integration_contacts_changes AFTER INSERT OR DELETE OR UPDATE ON public.integration_contacts
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS audit_integration_sends_changes ON public.integration_sends;
CREATE TRIGGER audit_integration_sends_changes AFTER INSERT OR DELETE OR UPDATE ON public.integration_sends
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

DROP TRIGGER IF EXISTS support_read_only ON public.integration_connections;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_connections FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.integration_secrets;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_secrets FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.integration_oauth_states;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_oauth_states FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.integration_mappings;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_mappings FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.integration_contacts;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_contacts FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS support_read_only ON public.integration_sends;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_sends FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();

DROP TRIGGER IF EXISTS admin_mfa ON public.integration_connections;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_connections FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.integration_secrets;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_secrets FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.integration_oauth_states;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_oauth_states FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.integration_mappings;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_mappings FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.integration_contacts;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_contacts FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.integration_sends;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_sends FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. The document as it is sent, and its VAT keys (the one place they are worked out; the server maps each key to the provider's
-- tax rate and never works one out itself).
-- 3a. A line's VAT key: 'no_vat' when the document charges no VAT (VAT switched off on it, or the company not VAT registered, 030),
-- 'exempt' for an exempt line, else its rate ('20', '5', '0', '17.5').
CREATE OR REPLACE FUNCTION public.integration_vat_key(p_taxed BOOLEAN, p_vat_exempt BOOLEAN, p_vat_pct NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN NOT coalesce(p_taxed, FALSE) THEN 'no_vat'
              WHEN coalesce(p_vat_exempt, FALSE) THEN 'exempt'
              ELSE trim_scale(round(coalesce(p_vat_pct, 0), 2))::TEXT END
$$;
REVOKE ALL ON FUNCTION public.integration_vat_key(BOOLEAN, BOOLEAN, NUMERIC) FROM PUBLIC, anon, authenticated;

-- 3b. Carriage's VAT key. Xero sign-off question 5 (tax codes per VAT rate; G22 default until the accountant answers): carriage without
-- VAT is sent as no VAT (the 'no_vat' key); carriage with VAT gets the standard rate (the company's standard rate's key, as Tolra
-- charges it, 029/030). If the accountant wants carriage without VAT zero rated instead, only this changes.
CREATE OR REPLACE FUNCTION public.integration_carriage_vat_key(p_taxed BOOLEAN, p_carriage_vat BOOLEAN, p_standard_rate NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN coalesce(p_taxed, FALSE) AND coalesce(p_carriage_vat, FALSE) THEN trim_scale(round(coalesce(p_standard_rate, 20), 2))::TEXT
              ELSE 'no_vat' END
$$;
REVOKE ALL ON FUNCTION public.integration_carriage_vat_key(BOOLEAN, BOOLEAN, NUMERIC) FROM PUBLIC, anon, authenticated;

-- 3c. The document as the server sends it (server only): number, dates, customer, totals, and each line with its net, VAT and VAT key,
-- worked out exactly as Tolra totals it (check_document_totals, 027/029: each line's net and VAT rounded to the penny; carriage at the
-- standard rate when it carries VAT). A £0 text-only invoice line (073) has no key. NULL when the document is not this company's.
CREATE OR REPLACE FUNCTION public.integration_document(p_org UUID, p_doc_type TEXT, p_doc_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reg   BOOLEAN := public.org_vat_registered(p_org);
  v_std   NUMERIC := public.org_standard_vat_rate(p_org);
  v_doc   RECORD;
  v_taxed BOOLEAN;
  v_lines JSONB;
BEGIN
  IF p_doc_type = 'invoice' THEN
    SELECT i.id, i.invoice_ref, i.invoice_date, i.tax_point, i.issued_at, i.created_at, i.due_date, i.customer_po, i.customer, i.status,
           i.vat_enabled, coalesce(i.carriage, 0) AS carriage, i.carriage_vat, i.subtotal, i.vat, i.total
      INTO v_doc FROM public.invoices i WHERE i.id = p_doc_id AND i.organization_id = p_org;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_taxed := coalesce(v_doc.vat_enabled, TRUE) AND v_reg;
    SELECT coalesce(jsonb_agg(x.line ORDER BY x.pos, x.created_at, x.id), '[]'::JSONB) INTO v_lines
    FROM (SELECT l.position AS pos, l.created_at, l.id,
                 jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit_price', l.unit_price,
                   'text_only', (l.quantity = 0 AND l.unit_price = 0),
                   'net', round(l.quantity * l.unit_price, 2),
                   'vat', CASE WHEN v_taxed AND NOT l.vat_exempt THEN round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) ELSE 0 END,
                   'vat_key', CASE WHEN l.quantity = 0 AND l.unit_price = 0 THEN NULL ELSE public.integration_vat_key(v_taxed, l.vat_exempt, l.vat_pct) END) AS line
          FROM public.invoice_line_items l WHERE l.invoice_id = p_doc_id AND l.organization_id = p_org) x;
    IF v_doc.carriage <> 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('description', 'Carriage', 'quantity', 1, 'unit_price', v_doc.carriage,
        'text_only', FALSE, 'net', v_doc.carriage, 'carriage', TRUE,
        'vat', CASE WHEN v_taxed AND v_doc.carriage_vat THEN round(v_doc.carriage * v_std / 100, 2) ELSE 0 END,
        'vat_key', public.integration_carriage_vat_key(v_taxed, v_doc.carriage_vat, v_std)));
    END IF;
    RETURN jsonb_build_object('doc_type', 'invoice', 'id', v_doc.id, 'number', v_doc.invoice_ref,
      'date', coalesce(v_doc.invoice_date, v_doc.tax_point, (v_doc.issued_at AT TIME ZONE 'Europe/London')::DATE, (v_doc.created_at AT TIME ZONE 'Europe/London')::DATE),
      'due_date', v_doc.due_date, 'reference', nullif(btrim(coalesce(v_doc.customer_po, '')), ''), 'customer', btrim(v_doc.customer),
      'status', v_doc.status, 'voided', lower(coalesce(v_doc.status, '')) IN ('void', 'cancelled'),
      'subtotal', v_doc.subtotal, 'carriage', v_doc.carriage, 'vat', v_doc.vat, 'total', v_doc.total, 'lines', v_lines);
  ELSIF p_doc_type = 'credit_note' THEN
    SELECT c.id, c.credit_ref, c.credit_date, c.customer, c.status, c.vat_enabled, c.subtotal, c.vat, c.total, i.invoice_ref
      INTO v_doc FROM public.credit_notes c LEFT JOIN public.invoices i ON i.id = c.invoice_id AND i.organization_id = c.organization_id
      WHERE c.id = p_doc_id AND c.organization_id = p_org;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_taxed := coalesce(v_doc.vat_enabled, TRUE) AND v_reg;
    SELECT coalesce(jsonb_agg(x.line ORDER BY x.pos, x.created_at, x.id), '[]'::JSONB) INTO v_lines
    FROM (SELECT l.position AS pos, l.created_at, l.id,
                 jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit_price', l.unit_price, 'text_only', FALSE,
                   'net', round(l.quantity * l.unit_price, 2), 'vat', l.vat_amount,
                   'vat_key', public.integration_vat_key(v_taxed, l.vat_exempt, l.vat_pct)) AS line
          FROM public.credit_note_lines l WHERE l.credit_note_id = p_doc_id AND l.organization_id = p_org) x;
    RETURN jsonb_build_object('doc_type', 'credit_note', 'id', v_doc.id, 'number', v_doc.credit_ref, 'date', v_doc.credit_date,
      'due_date', NULL, 'reference', v_doc.invoice_ref, 'customer', btrim(v_doc.customer), 'status', v_doc.status, 'voided', FALSE,
      'subtotal', v_doc.subtotal, 'carriage', 0, 'vat', v_doc.vat, 'total', v_doc.total, 'lines', v_lines);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.integration_document(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_document(UUID, TEXT, UUID) TO service_role;

-- 3d. What is not mapped yet (server only; integration_overview shows it to admins): 'account:sales' and 'account:credit' until both
-- account codes are set, and 'vat:<key>' for each VAT key a waiting document uses with no tax rate mapped. Nothing sends while this
-- is not empty (G22: "nothing sends until every rate used is mapped").
CREATE OR REPLACE FUNCTION public.integration_unmapped(p_org UUID, p_provider TEXT)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(array_agg(u.k ORDER BY u.k), '{}'::TEXT[])
  FROM (
    SELECT 'account:sales' AS k
    WHERE NOT EXISTS (SELECT 1 FROM public.integration_mappings m WHERE m.organization_id = p_org AND m.provider = p_provider AND m.kind = 'sales_account')
    UNION
    SELECT 'account:credit'
    WHERE NOT EXISTS (SELECT 1 FROM public.integration_mappings m WHERE m.organization_id = p_org AND m.provider = p_provider AND m.kind = 'credit_account')
    UNION
    SELECT 'vat:' || (l.line ->> 'vat_key')
    FROM public.integration_sends s
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(public.integration_document(s.organization_id, s.doc_type, s.doc_id) -> 'lines', '[]'::JSONB)) AS l(line)
    WHERE s.organization_id = p_org AND s.provider = p_provider AND s.action = 'create' AND s.status IN ('pending', 'sending', 'failed', 'needs_check')
      AND l.line ->> 'vat_key' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.integration_mappings m WHERE m.organization_id = p_org AND m.provider = p_provider
                        AND m.kind = 'tax_rate' AND m.tolra_key = l.line ->> 'vat_key')
  ) u
$$;
REVOKE ALL ON FUNCTION public.integration_unmapped(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_unmapped(UUID, TEXT) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 4. Enqueue: a draft issued, or a queued invoice voided, adds a send row for each provider the company is connected to. Never for an
-- import (076's session setting, or the record in import_record_keys); nothing while the company is not connected; never fails the issue.
CREATE OR REPLACE FUNCTION public.integration_enqueue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_was  TEXT := lower(coalesce(OLD.status, 'draft'));
  v_is   TEXT := lower(coalesce(NEW.status, 'draft'));
  v_type TEXT := CASE TG_TABLE_NAME WHEN 'invoices' THEN 'invoice' ELSE 'credit_note' END;
  v_ref  TEXT := left(to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'invoices' THEN 'invoice_ref' ELSE 'credit_ref' END, 100);
  v_conn RECORD;
BEGIN
  IF v_was = v_is THEN
    RETURN NULL;
  END IF;
  IF current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT
     OR EXISTS (SELECT 1 FROM public.import_record_keys k WHERE k.organization_id = NEW.organization_id AND k.record_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  FOR v_conn IN SELECT c.provider FROM public.integration_connections c
                WHERE c.organization_id = NEW.organization_id AND c.status IN ('connected', 'needs_reconnect') ORDER BY c.provider LOOP
    IF v_was = 'draft' AND v_is NOT IN ('void', 'cancelled') THEN
      INSERT INTO public.integration_sends (organization_id, provider, doc_type, doc_id, doc_ref, action)
      VALUES (NEW.organization_id, v_conn.provider, v_type, NEW.id, v_ref, 'create')
      ON CONFLICT ON CONSTRAINT integration_sends_once DO NOTHING;
    ELSIF v_type = 'invoice' AND v_is IN ('void', 'cancelled') AND v_was NOT IN ('void', 'cancelled', 'draft')
          AND EXISTS (SELECT 1 FROM public.integration_sends s WHERE s.organization_id = NEW.organization_id AND s.provider = v_conn.provider
                        AND s.doc_type = 'invoice' AND s.doc_id = NEW.id AND s.action = 'create') THEN
      INSERT INTO public.integration_sends (organization_id, provider, doc_type, doc_id, doc_ref, action)
      VALUES (NEW.organization_id, v_conn.provider, 'invoice', NEW.id, v_ref, 'void')
      ON CONFLICT ON CONSTRAINT integration_sends_once DO NOTHING;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.integration_enqueue() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_integration_enqueue ON public.invoices;
CREATE TRIGGER zz_integration_enqueue AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.integration_enqueue();
DROP TRIGGER IF EXISTS zz_integration_enqueue ON public.credit_notes;
CREATE TRIGGER zz_integration_enqueue AFTER UPDATE OF status ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.integration_enqueue();

-- -----------------------------------------------------------------------------------------------------
-- 5. Connect and disconnect. Xero sign-off question 9 (who may connect and disconnect; G22 default): admins only, after the second
-- step of sign-in, for their own company.
-- 5a. Connect, step 1 (signed in): the server has made a random state and PKCE verifier; this keeps the state's hash and the
-- encrypted verifier, bound to this company and this admin, for 10 minutes. Returns the row's id.
CREATE OR REPLACE FUNCTION public.integration_oauth_begin(p_provider TEXT, p_state_hash TEXT, p_verifier_enc TEXT)
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
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can connect the company to an accounting system.' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS DISTINCT FROM 'xero' THEN
    RAISE EXCEPTION 'Unknown accounting system.' USING ERRCODE = '22023';
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
REVOKE ALL ON FUNCTION public.integration_oauth_begin(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_oauth_begin(TEXT, TEXT, TEXT) TO authenticated;

-- 5b. Connect, step 2 (server only): the callback's state, for this company and this admin, unexpired and unused, is used up; returns
-- the encrypted verifier. The admin must still be an active admin of the company.
CREATE OR REPLACE FUNCTION public.integration_oauth_consume(p_org UUID, p_user UUID, p_provider TEXT, p_state_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_verifier TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
                 WHERE m.organization_id = p_org AND m.user_id = p_user AND m.active AND NOT m.support AND o.status = 'active'
                   AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))) THEN
    RAISE EXCEPTION 'Only admins can connect the company to an accounting system.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.integration_oauth_states s SET consumed_at = now()
  WHERE s.state_hash = p_state_hash AND s.provider = p_provider AND s.organization_id = p_org AND s.user_id = p_user
    AND s.consumed_at IS NULL AND s.expires_at > now()
  RETURNING s.verifier_enc INTO v_verifier;
  IF v_verifier IS NULL THEN
    RAISE EXCEPTION 'This Connect has expired or was not started here: click Connect again.' USING ERRCODE = '42501', HINT = 'oauth_state_invalid';
  END IF;
  RETURN jsonb_build_object('verifier_enc', v_verifier);
END
$$;
REVOKE ALL ON FUNCTION public.integration_oauth_consume(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_oauth_consume(UUID, UUID, TEXT, TEXT) TO service_role;

-- 5c. Connect, step 3 (server only): the tenant the admin consented to, and the encrypted tokens. Refused when that tenant is linked to
-- another company, or this company is linked to another tenant (disconnect first). Audited as INTEGRATION_CONNECTED (no token).
CREATE OR REPLACE FUNCTION public.integration_store_connection(p_org UUID, p_user UUID, p_provider TEXT, p_tenant_id TEXT, p_tenant_name TEXT,
                                                              p_external_connection_id TEXT, p_refresh_enc TEXT, p_access_enc TEXT,
                                                              p_access_expires_at TIMESTAMPTZ, p_key_version INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_old  RECORD;
  v_name TEXT := left(nullif(btrim(regexp_replace(coalesce(p_tenant_name, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 200);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
                 WHERE m.organization_id = p_org AND m.user_id = p_user AND m.active AND NOT m.support AND o.status = 'active'
                   AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))) THEN
    RAISE EXCEPTION 'Only admins can connect the company to an accounting system.' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(coalesce(p_tenant_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'No organisation was chosen in Xero.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.integration_connections c WHERE c.provider = p_provider AND c.tenant_id = p_tenant_id
             AND c.status <> 'disconnected' AND c.organization_id <> p_org) THEN
    RAISE EXCEPTION 'This Xero organisation is already connected to another company in Tolra.' USING ERRCODE = '23505', HINT = 'tenant_in_use';
  END IF;
  SELECT c.status, c.tenant_id INTO v_old FROM public.integration_connections c WHERE c.organization_id = p_org AND c.provider = p_provider FOR UPDATE;
  IF FOUND AND v_old.status <> 'disconnected' AND v_old.tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'This company is connected to another Xero organisation: disconnect it first.' USING ERRCODE = '22023', HINT = 'disconnect_first';
  END IF;
  -- Connected again to a different Xero organisation: the contact matches belong to the old one (its ContactIDs mean nothing in the new
  -- one), so they go (audited row by row); the new organisation's contacts are matched afresh.
  IF FOUND AND v_old.tenant_id IS DISTINCT FROM p_tenant_id THEN
    DELETE FROM public.integration_contacts k WHERE k.organization_id = p_org AND k.provider = p_provider;
  END IF;
  INSERT INTO public.integration_connections (organization_id, provider, status, tenant_id, tenant_name, external_connection_id, status_reason,
                                              connected_by, connected_at, disconnected_by, disconnected_at, updated_at)
  VALUES (p_org, p_provider, 'connected', p_tenant_id, v_name, nullif(btrim(coalesce(p_external_connection_id, '')), ''), NULL, p_user, now(), NULL, NULL, now())
  ON CONFLICT ON CONSTRAINT integration_connections_org_provider_key DO UPDATE
    SET status = 'connected', tenant_id = EXCLUDED.tenant_id, tenant_name = EXCLUDED.tenant_name, external_connection_id = EXCLUDED.external_connection_id,
        status_reason = NULL, connected_by = EXCLUDED.connected_by, connected_at = EXCLUDED.connected_at, disconnected_by = NULL,
        disconnected_at = NULL, updated_at = now();
  INSERT INTO public.integration_secrets (organization_id, provider, refresh_token_enc, access_token_enc, access_expires_at, key_version, lease_holder, lease_until, rotated_at)
  VALUES (p_org, p_provider, p_refresh_enc, p_access_enc, p_access_expires_at, p_key_version, NULL, NULL, now())
  ON CONFLICT ON CONSTRAINT integration_secrets_org_provider_key DO UPDATE
    SET refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = EXCLUDED.access_token_enc, access_expires_at = EXCLUDED.access_expires_at,
        key_version = EXCLUDED.key_version, lease_holder = NULL, lease_until = NULL, rotated_at = now();
  PERFORM security_audit.log_named_event(p_org, 'INTEGRATION_CONNECTED', 'integration_connections', p_provider,
    jsonb_build_object('provider', p_provider, 'tenant_id', p_tenant_id, 'tenant_name', v_name, 'by', p_user,
                       'reconnected', coalesce(v_old.status = 'needs_reconnect', FALSE)));
  RETURN jsonb_build_object('provider', p_provider, 'status', 'connected', 'tenant_name', v_name);
END
$$;
REVOKE ALL ON FUNCTION public.integration_store_connection(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_store_connection(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER) TO service_role;

-- 5d. Disconnect (signed in, admin, two-step): the tokens are deleted, the state is disconnected, anything not yet sent is skipped (it
-- never goes to another organisation); the send log stays. Audited as INTEGRATION_DISCONNECTED.
CREATE OR REPLACE FUNCTION public.integration_disconnect(p_provider TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_uid     UUID := auth.uid();
  v_conn    RECORD;
  v_skipped INTEGER;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can disconnect the company from an accounting system.' USING ERRCODE = '42501';
  END IF;
  SELECT c.status, c.tenant_id, c.tenant_name INTO v_conn FROM public.integration_connections c
  WHERE c.organization_id = v_org AND c.provider = p_provider FOR UPDATE;
  IF NOT FOUND OR v_conn.status = 'disconnected' THEN
    RAISE EXCEPTION 'This company is not connected.' USING ERRCODE = 'P0002', HINT = 'not_connected';
  END IF;
  DELETE FROM public.integration_secrets t WHERE t.organization_id = v_org AND t.provider = p_provider;
  DELETE FROM public.integration_oauth_states s WHERE s.organization_id = v_org AND s.provider = p_provider;
  UPDATE public.integration_connections c
  SET status = 'disconnected', status_reason = NULL, disconnected_by = v_uid, disconnected_at = now(), updated_at = now()
  WHERE c.organization_id = v_org AND c.provider = p_provider;
  UPDATE public.integration_sends s
  SET status = 'skipped', last_error = 'Disconnected before it was sent: not sent.', claimed_until = NULL, updated_at = now()
  WHERE s.organization_id = v_org AND s.provider = p_provider AND s.status IN ('pending', 'failed') AND s.external_id IS NULL;
  GET DIAGNOSTICS v_skipped = ROW_COUNT;
  PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_DISCONNECTED', 'integration_connections', p_provider,
    jsonb_build_object('provider', p_provider, 'tenant_id', v_conn.tenant_id, 'tenant_name', v_conn.tenant_name, 'skipped', v_skipped));
  RETURN jsonb_build_object('provider', p_provider, 'status', 'disconnected', 'skipped', v_skipped);
END
$$;
REVOKE ALL ON FUNCTION public.integration_disconnect(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_disconnect(TEXT) TO authenticated;

-- 5e. The provider refused the refresh token (server only): sending pauses until an admin connects again. Audited once per change.
CREATE OR REPLACE FUNCTION public.integration_mark_needs_reconnect(p_org UUID, p_provider TEXT, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_reason TEXT := left(coalesce(nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 'The connection needs to be made again.'), 300);
BEGIN
  UPDATE public.integration_connections c SET status = 'needs_reconnect', status_reason = v_reason, updated_at = now()
  WHERE c.organization_id = p_org AND c.provider = p_provider AND c.status = 'connected';
  IF FOUND THEN
    PERFORM security_audit.log_named_event(p_org, 'INTEGRATION_NEEDS_RECONNECT', 'integration_connections', p_provider,
      jsonb_build_object('provider', p_provider, 'reason', v_reason));
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.integration_mark_needs_reconnect(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_mark_needs_reconnect(UUID, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 6. The refresh lease (server only). The refresh token is single use: one caller at a time holds the lease (the row lock orders two
-- callers; the second sees the first's lease and gets nothing), stores the new tokens BEFORE using the new access token (refused once
-- another holder has taken the lease over), then releases it. Returns the ciphertexts; NULL when there is none or another holds it.
CREATE OR REPLACE FUNCTION public.integration_token_lease(p_org UUID, p_provider TEXT, p_holder UUID, p_seconds INTEGER DEFAULT 60)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF p_holder IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'A lease needs a holder and 5 to 300 seconds.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.integration_secrets t SET lease_holder = p_holder, lease_until = now() + make_interval(secs => p_seconds)
  WHERE t.organization_id = p_org AND t.provider = p_provider
    AND (t.lease_holder IS NULL OR t.lease_until < now() OR t.lease_holder = p_holder)
    AND EXISTS (SELECT 1 FROM public.integration_connections c WHERE c.organization_id = p_org AND c.provider = p_provider
                  AND c.status IN ('connected', 'needs_reconnect'))
  RETURNING jsonb_build_object('refresh_token_enc', t.refresh_token_enc, 'access_token_enc', t.access_token_enc,
                               'access_expires_at', t.access_expires_at, 'key_version', t.key_version, 'lease_until', t.lease_until) INTO v_out;
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.integration_token_lease(UUID, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_token_lease(UUID, TEXT, UUID, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.integration_token_store(p_org UUID, p_provider TEXT, p_holder UUID, p_refresh_enc TEXT, p_access_enc TEXT,
                                                         p_access_expires_at TIMESTAMPTZ, p_key_version INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_holder IS NULL THEN
    RETURN FALSE;
  END IF;
  UPDATE public.integration_secrets t
  SET refresh_token_enc = p_refresh_enc, access_token_enc = p_access_enc, access_expires_at = p_access_expires_at,
      key_version = p_key_version, rotated_at = now()
  WHERE t.organization_id = p_org AND t.provider = p_provider AND t.lease_holder = p_holder;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.integration_token_store(UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_token_store(UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.integration_token_release(p_org UUID, p_provider TEXT, p_holder UUID)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.integration_secrets t SET lease_holder = NULL, lease_until = NULL
  WHERE t.organization_id = p_org AND t.provider = p_provider AND t.lease_holder = p_holder;
END
$$;
REVOKE ALL ON FUNCTION public.integration_token_release(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_token_release(UUID, TEXT, UUID) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 7. The send queue (server only).
-- 7a. The next row to send, claimed for p_lease_seconds (FOR UPDATE SKIP LOCKED: two senders never take the same row). The gate first:
-- connected (not needs_reconnect, not disconnected) and nothing unmapped, or it returns {"blocked": why} and claims nothing. Before
-- choosing: a claim that ran out becomes needs_check (its result is unknown: read the provider back first); a row started for another
-- tenant is skipped; a void whose invoice never reached the provider is skipped with that invoice. A void waits for its invoice's create.
CREATE OR REPLACE FUNCTION public.integration_claim_next(p_org UUID, p_provider TEXT, p_lease_seconds INTEGER DEFAULT 120,
                                                        p_doc_type TEXT DEFAULT NULL, p_doc_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status   TEXT;
  v_tenant   TEXT;
  v_unmapped TEXT[];
  v_row      RECORD;
  v_ext      TEXT;
  v_claim    UUID := gen_random_uuid();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 900 THEN
    RAISE EXCEPTION 'A claim lasts 10 to 900 seconds.' USING ERRCODE = '22023';
  END IF;
  SELECT c.status, c.tenant_id INTO v_status, v_tenant FROM public.integration_connections c WHERE c.organization_id = p_org AND c.provider = p_provider;
  IF v_status IS DISTINCT FROM 'connected' THEN
    RETURN jsonb_build_object('blocked', coalesce(v_status, 'not_connected'), 'send', NULL);
  END IF;

  UPDATE public.integration_sends s
  SET status = 'needs_check', claimed_until = NULL, updated_at = now(),
      last_error = 'The send stopped before its result came back: check Xero before sending it again.'
  WHERE s.organization_id = p_org AND s.provider = p_provider AND s.status = 'sending' AND s.claimed_until < now();
  UPDATE public.integration_sends s
  SET status = 'skipped', last_error = 'Started for another Xero organisation: not sent to this one.', updated_at = now()
  WHERE s.organization_id = p_org AND s.provider = p_provider AND s.status = 'pending' AND s.tenant_id IS NOT NULL AND s.tenant_id <> v_tenant;
  UPDATE public.integration_sends c
  SET status = 'skipped', last_error = 'Voided in Tolra before it reached Xero: not sent.', updated_at = now()
  WHERE c.organization_id = p_org AND c.provider = p_provider AND c.action = 'create' AND c.external_id IS NULL
    AND ((c.status = 'failed') OR (c.status = 'pending' AND c.attempts = 0))
    AND EXISTS (SELECT 1 FROM public.integration_sends v WHERE v.organization_id = c.organization_id AND v.provider = c.provider
                  AND v.doc_type = c.doc_type AND v.doc_id = c.doc_id AND v.action = 'void' AND v.status = 'pending');
  UPDATE public.integration_sends v
  SET status = 'skipped', last_error = 'Its invoice never reached Xero: nothing to void.', updated_at = now()
  WHERE v.organization_id = p_org AND v.provider = p_provider AND v.action = 'void' AND v.status = 'pending'
    AND EXISTS (SELECT 1 FROM public.integration_sends c WHERE c.organization_id = v.organization_id AND c.provider = v.provider
                  AND c.doc_type = v.doc_type AND c.doc_id = v.doc_id AND c.action = 'create' AND c.status = 'skipped');
  UPDATE public.integration_sends v
  SET status = 'skipped', last_error = 'Its invoice was sent to another Xero organisation (connected before): void it there by hand.', updated_at = now()
  WHERE v.organization_id = p_org AND v.provider = p_provider AND v.action = 'void' AND v.status = 'pending'
    AND EXISTS (SELECT 1 FROM public.integration_sends c WHERE c.organization_id = v.organization_id AND c.provider = v.provider
                  AND c.doc_type = v.doc_type AND c.doc_id = v.doc_id AND c.action = 'create' AND c.tenant_id IS NOT NULL AND c.tenant_id <> v_tenant);

  v_unmapped := public.integration_unmapped(p_org, p_provider);
  IF cardinality(v_unmapped) > 0 THEN
    RETURN jsonb_build_object('blocked', 'unmapped', 'unmapped', to_jsonb(v_unmapped), 'send', NULL);
  END IF;

  SELECT s.id, s.doc_type, s.doc_id, s.doc_ref, s.action, s.attempts, s.external_id INTO v_row
  FROM public.integration_sends s
  WHERE s.organization_id = p_org AND s.provider = p_provider AND s.status = 'pending' AND s.next_attempt_at <= now()
    -- With a document (the automatic send right after it is issued or voided, Rhys Wed 21 Oct): only that document's first attempt;
    -- every retry and every other document waits for an admin's Send now (or the daily sweep).
    AND (p_doc_id IS NULL OR (s.doc_id = p_doc_id AND s.doc_type = p_doc_type AND s.attempts = 0))
    AND (s.action = 'create'
         OR EXISTS (SELECT 1 FROM public.integration_sends c WHERE c.organization_id = s.organization_id AND c.provider = s.provider
                      AND c.doc_type = s.doc_type AND c.doc_id = s.doc_id AND c.action = 'create' AND c.external_id IS NOT NULL
                      AND c.status IN ('sent', 'failed') AND c.tenant_id = v_tenant))
  ORDER BY s.created_at, s.id
  LIMIT 1
  FOR UPDATE OF s SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('blocked', NULL, 'send', NULL);
  END IF;
  IF v_row.action = 'void' THEN
    SELECT c.external_id INTO v_ext FROM public.integration_sends c WHERE c.organization_id = p_org AND c.provider = p_provider
      AND c.doc_type = v_row.doc_type AND c.doc_id = v_row.doc_id AND c.action = 'create';
  ELSE
    v_ext := v_row.external_id;
  END IF;
  UPDATE public.integration_sends s
  SET status = 'sending', claim_token = v_claim, claimed_until = now() + make_interval(secs => p_lease_seconds),
      attempts = s.attempts + 1, tenant_id = v_tenant, updated_at = now()
  WHERE s.id = v_row.id;
  RETURN jsonb_build_object('blocked', NULL, 'send', jsonb_build_object('id', v_row.id, 'claim', v_claim, 'doc_type', v_row.doc_type,
    'doc_id', v_row.doc_id, 'doc_ref', v_row.doc_ref, 'action', v_row.action, 'attempts', v_row.attempts + 1, 'external_id', v_ext,
    'tenant_id', v_tenant));
END
$$;
REVOKE ALL ON FUNCTION public.integration_claim_next(UUID, TEXT, INTEGER, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_claim_next(UUID, TEXT, INTEGER, TEXT, UUID) TO service_role;

-- 7b. The result, written only by the claim that holds the row (or, for a claim that ran out and became needs_check, its late definite
-- answer). sent needs the provider's id; pending needs the retry time. A sent row is final.
CREATE OR REPLACE FUNCTION public.integration_record_result(p_send UUID, p_claim UUID, p_status TEXT, p_external_id TEXT DEFAULT NULL,
                                                           p_external_number TEXT DEFAULT NULL, p_error TEXT DEFAULT NULL, p_retry_at TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_error  TEXT := left(nullif(btrim(regexp_replace(coalesce(p_error, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 500);
  v_ext    TEXT := left(nullif(btrim(coalesce(p_external_id, '')), ''), 100);
  v_number TEXT := left(nullif(btrim(regexp_replace(coalesce(p_external_number, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 100);
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent', 'failed', 'needs_check', 'pending', 'skipped') THEN
    RAISE EXCEPTION 'Unknown send result.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'sent' AND v_ext IS NULL THEN
    RAISE EXCEPTION 'A sent document needs the id it has in the accounting system.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'pending' AND p_retry_at IS NULL THEN
    RAISE EXCEPTION 'A send to try again needs the time to try it.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.integration_sends s
  SET status = p_status, claimed_until = NULL,
      external_id = coalesce(v_ext, s.external_id), external_number = coalesce(v_number, s.external_number),
      last_error = CASE WHEN p_status = 'sent' THEN NULL ELSE coalesce(v_error, s.last_error) END,
      next_attempt_at = CASE WHEN p_status = 'pending' THEN greatest(p_retry_at, now()) ELSE s.next_attempt_at END,
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE s.sent_at END, updated_at = now()
  WHERE s.id = p_send AND s.claim_token = p_claim
    AND (s.status = 'sending' OR (s.status = 'needs_check' AND p_status IN ('sent', 'failed', 'needs_check')));
  RETURN jsonb_build_object('recorded', FOUND);
END
$$;
REVOKE ALL ON FUNCTION public.integration_record_result(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_record_result(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 8. Mappings, retries and contacts.
-- 8a. A mapping (signed in, admin, two-step): the sales or credit-note account code, or the tax rate for one Tolra VAT key. A blank code
-- removes it.
CREATE OR REPLACE FUNCTION public.integration_set_mapping(p_provider TEXT, p_kind TEXT, p_tolra_key TEXT, p_external_code TEXT, p_external_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org  UUID := public.current_user_organization_id();
  v_uid  UUID := auth.uid();
  v_key  TEXT := CASE WHEN p_kind = 'tax_rate' THEN lower(btrim(coalesce(p_tolra_key, ''))) ELSE '' END;
  v_code TEXT := nullif(btrim(coalesce(p_external_code, '')), '');
  v_name TEXT := left(nullif(btrim(regexp_replace(coalesce(p_external_name, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 200);
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can change how documents are mapped.' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS DISTINCT FROM 'xero' OR p_kind IS NULL OR p_kind NOT IN ('sales_account', 'credit_account', 'tax_rate') THEN
    RAISE EXCEPTION 'Unknown mapping.' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'tax_rate' AND v_key !~ '^(exempt|no_vat|[0-9]{1,3}(\.[0-9]{1,2})?)$' THEN
    RAISE EXCEPTION 'Choose a Tolra VAT rate (a percentage, exempt or no VAT).' USING ERRCODE = '22023';
  END IF;
  IF v_code IS NULL THEN
    DELETE FROM public.integration_mappings m WHERE m.organization_id = v_org AND m.provider = p_provider AND m.kind = p_kind AND m.tolra_key = v_key;
    RETURN jsonb_build_object('kind', p_kind, 'tolra_key', v_key, 'external_code', NULL);
  END IF;
  INSERT INTO public.integration_mappings (organization_id, provider, kind, tolra_key, external_code, external_name, updated_by, updated_at)
  VALUES (v_org, p_provider, p_kind, v_key, v_code, v_name, v_uid, now())
  ON CONFLICT ON CONSTRAINT integration_mappings_one_per_key DO UPDATE
    SET external_code = EXCLUDED.external_code, external_name = EXCLUDED.external_name, updated_by = EXCLUDED.updated_by, updated_at = now();
  RETURN jsonb_build_object('kind', p_kind, 'tolra_key', v_key, 'external_code', v_code);
END
$$;
REVOKE ALL ON FUNCTION public.integration_set_mapping(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_set_mapping(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 8b. Retry (signed in, admin, two-step): a failed or needs_check row is queued again (the server reads the provider back first, so a
-- document that did arrive is not sent twice). Audited as INTEGRATION_SEND_RETRY.
CREATE OR REPLACE FUNCTION public.integration_retry_send(p_send UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_row RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can send a document again.' USING ERRCODE = '42501';
  END IF;
  SELECT s.id, s.status, s.doc_type, s.doc_ref, s.action INTO v_row FROM public.integration_sends s
  WHERE s.id = p_send AND s.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Send not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status NOT IN ('failed', 'needs_check') THEN
    RAISE EXCEPTION 'Only a failed send, or one to check, can be sent again.' USING ERRCODE = '22023', HINT = 'not_retryable';
  END IF;
  UPDATE public.integration_sends s SET status = 'pending', next_attempt_at = now(), claimed_until = NULL, updated_at = now()
  WHERE s.id = p_send AND s.organization_id = v_org;
  PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_SEND_RETRY', 'integration_sends', p_send::TEXT,
    jsonb_build_object('doc_type', v_row.doc_type, 'doc_ref', v_row.doc_ref, 'action', v_row.action, 'was', v_row.status));
  RETURN jsonb_build_object('id', p_send, 'status', 'pending');
END
$$;
REVOKE ALL ON FUNCTION public.integration_retry_send(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_retry_send(UUID) TO authenticated;

-- 8c. A contact match (server only): ok (matched by exact name, or created), or a problem (two or more matches, an archived one, a
-- different spelling); never replaces a match already made.
CREATE OR REPLACE FUNCTION public.integration_contact_record(p_org UUID, p_provider TEXT, p_customer TEXT, p_external_contact_id TEXT,
                                                            p_matched_by TEXT, p_problem TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_name    TEXT := btrim(coalesce(p_customer, ''));
  v_problem TEXT := left(nullif(btrim(regexp_replace(coalesce(p_problem, ''), '[[:cntrl:]]+', ' ', 'g')), ''), 300);
  v_out     RECORD;
BEGIN
  IF v_name = '' THEN
    RAISE EXCEPTION 'The document has no customer name.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.integration_contacts (organization_id, provider, customer_name, external_contact_id, matched_by, state, problem, updated_at)
  VALUES (p_org, p_provider, v_name, CASE WHEN v_problem IS NULL THEN p_external_contact_id END, CASE WHEN v_problem IS NULL THEN p_matched_by END,
          CASE WHEN v_problem IS NULL THEN 'ok' ELSE 'problem' END, v_problem, now())
  ON CONFLICT ON CONSTRAINT integration_contacts_one_per_name DO UPDATE
    SET external_contact_id = EXCLUDED.external_contact_id, matched_by = EXCLUDED.matched_by, state = EXCLUDED.state,
        problem = EXCLUDED.problem, updated_at = now()
    WHERE integration_contacts.state = 'problem';
  SELECT c.state, c.external_contact_id, c.matched_by, c.problem INTO v_out FROM public.integration_contacts c
  WHERE c.organization_id = p_org AND c.provider = p_provider AND c.customer_name = v_name;
  RETURN jsonb_build_object('state', v_out.state, 'external_contact_id', v_out.external_contact_id, 'matched_by', v_out.matched_by, 'problem', v_out.problem);
END
$$;
REVOKE ALL ON FUNCTION public.integration_contact_record(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_contact_record(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- 8d. An admin chooses the contact for a customer whose match was a problem (signed in, admin, two-step). Audited as
-- INTEGRATION_CONTACT_CHOSEN.
CREATE OR REPLACE FUNCTION public.integration_resolve_contact(p_provider TEXT, p_customer TEXT, p_external_contact_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org  UUID := public.current_user_organization_id();
  v_name TEXT := btrim(coalesce(p_customer, ''));
  v_ext  TEXT := nullif(btrim(coalesce(p_external_contact_id, '')), '');
  v_id   UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can choose the contact.' USING ERRCODE = '42501';
  END IF;
  IF v_ext IS NULL THEN
    RAISE EXCEPTION 'Choose the contact.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.integration_contacts c SET state = 'ok', external_contact_id = v_ext, matched_by = 'chosen', problem = NULL, updated_at = now()
  WHERE c.organization_id = v_org AND c.provider = p_provider AND c.customer_name = v_name AND c.state = 'problem'
  RETURNING c.id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No contact problem for that customer.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_CONTACT_CHOSEN', 'integration_contacts', v_id::TEXT,
    jsonb_build_object('provider', p_provider, 'customer', v_name, 'external_contact_id', v_ext));
  RETURN jsonb_build_object('customer', v_name, 'state', 'ok', 'external_contact_id', v_ext);
END
$$;
REVOKE ALL ON FUNCTION public.integration_resolve_contact(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_resolve_contact(TEXT, TEXT, TEXT) TO authenticated;

-- 8e. The Integrations page's summary (signed in, admin, the caller's own company only): the connection (no secret), what is not
-- mapped yet, and the send log's counts.
CREATE OR REPLACE FUNCTION public.integration_overview(p_provider TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org  UUID := public.current_user_organization_id();
  v_conn RECORD;
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can see the company''s integrations.' USING ERRCODE = '42501';
  END IF;
  SELECT c.status, c.tenant_name, c.connected_at, c.status_reason INTO v_conn FROM public.integration_connections c
  WHERE c.organization_id = v_org AND c.provider = p_provider;
  RETURN jsonb_build_object('provider', p_provider, 'status', coalesce(v_conn.status, 'not_connected'), 'tenant_name', v_conn.tenant_name,
    'connected_at', v_conn.connected_at, 'status_reason', v_conn.status_reason,
    'unmapped', to_jsonb(public.integration_unmapped(v_org, p_provider)),
    'counts', (SELECT coalesce(jsonb_object_agg(x.status, x.n), '{}'::JSONB) FROM (SELECT s.status, count(*) AS n FROM public.integration_sends s
               WHERE s.organization_id = v_org AND s.provider = p_provider GROUP BY s.status) x),
    'contact_problems', (SELECT count(*) FROM public.integration_contacts c WHERE c.organization_id = v_org AND c.provider = p_provider AND c.state = 'problem'));
END
$$;
REVOKE ALL ON FUNCTION public.integration_overview(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_overview(TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 9. Self-check before COMMIT (the same checks as supabase/verify/integrations_084.sql).
DO $$
DECLARE
  v_fn TEXT;
  v_t  TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.integration_oauth_begin(text,text,text)', 'public.integration_disconnect(text)', 'public.integration_set_mapping(text,text,text,text,text)',
                              'public.integration_retry_send(uuid)', 'public.integration_resolve_contact(text,text,text)', 'public.integration_overview(text)'] LOOP
    IF NOT (SELECT p.prosecdef AND p.proconfig IS NOT NULL AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) THEN
      RAISE EXCEPTION '084: % is not a signed-in-only definer function', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.integration_vat_key(boolean,boolean,numeric)', 'public.integration_carriage_vat_key(boolean,boolean,numeric)',
                              'public.integration_document(uuid,text,uuid)', 'public.integration_unmapped(uuid,text)', 'public.integration_enqueue()',
                              'public.integration_oauth_consume(uuid,uuid,text,text)',
                              'public.integration_store_connection(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,integer)',
                              'public.integration_mark_needs_reconnect(uuid,text,text)', 'public.integration_token_lease(uuid,text,uuid,integer)',
                              'public.integration_token_store(uuid,text,uuid,text,text,timestamp with time zone,integer)',
                              'public.integration_token_release(uuid,text,uuid)', 'public.integration_claim_next(uuid,text,integer,text,uuid)',
                              'public.integration_record_result(uuid,uuid,text,text,text,text,timestamp with time zone)',
                              'public.integration_contact_record(uuid,text,text,text,text,text)'] LOOP
    IF to_regprocedure(v_fn) IS NULL OR has_function_privilege('anon', to_regprocedure(v_fn), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(v_fn), 'EXECUTE') OR (SELECT p.proconfig IS NULL FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) THEN
      RAISE EXCEPTION '084: % is missing or callable from the API', v_fn;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY ARRAY['integration_connections', 'integration_secrets', 'integration_oauth_states', 'integration_mappings', 'integration_contacts', 'integration_sends'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.' || v_t))
       OR has_table_privilege('authenticated', 'public.' || v_t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_table_privilege('anon', 'public.' || v_t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = to_regclass('public.' || v_t) AND t.tgname IN ('support_read_only', 'admin_mfa')) <> 2 THEN
      RAISE EXCEPTION '084: % has RLS off, an API write grant, or a guard missing', v_t;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.integration_secrets', 'SELECT') OR has_table_privilege('authenticated', 'public.integration_oauth_states', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN ('integration_secrets', 'integration_oauth_states'))
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgfoid = 'security_audit.log_row_change()'::regprocedure
                AND t.tgrelid IN ('public.integration_secrets'::regclass, 'public.integration_oauth_states'::regclass)) THEN
    RAISE EXCEPTION '084: the secrets or the OAuth states are readable through the API, or audited';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'zz_integration_enqueue' AND t.tgfoid = 'public.integration_enqueue()'::regprocedure
        AND t.tgrelid IN ('public.invoices'::regclass, 'public.credit_notes'::regclass)) <> 2 THEN
    RAISE EXCEPTION '084: the enqueue trigger is missing';
  END IF;
END
$$;

COMMIT;
