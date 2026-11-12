-- =====================================================================================================
-- p153 (proposal v2; post-144 release 153, after 152): link jobs and quotes to the customer record by ID, in a side table.
-- PROPOSAL ONLY. Not applied anywhere hosted or local. Packaged verbatim (the body inside its transaction) into
-- supabase/release/153_document_customer_link.release.sql, which adds the guard, the before/after fingerprint and the self-check.
-- Verify: supabase/verify/document_customer_link_153.sql (every row true). Pre-release read: supabase/verify/document_customer_link_153_guards.sql.
-- Rollback: supabase/release/153_document_customer_link.rollback.sql.
--
-- PM RULING (Wed 11 Nov 2026, conditionally approved; no implementation or execution yet), applied here: side table; jobs and quotes
-- only; no issued-document lock changes; verified links only; ambiguous matches not inserted; immutable audit; switch OFF by default
-- (in 153; its Settings screen is a separate PR); no costs, margins, balances or quote approval. Answers: (1) an admin may link a
-- document whose customer text differs from the customer's name after confirming identity, with a reason and a fresh code; (2) a
-- fresh authenticator code for every manual link action, whatever the company's own MFA setting (people without one enrol first);
-- (3) link management: admin and office only; (5) 153 is required before portal activation, not for JNR core go-live; (6) no
-- indefinite retention promise. Corrections: backfill links are stored UNVERIFIED and never shown until an admin or office person
-- verifies each one; no cascade delete (ON DELETE RESTRICT plus a controlled, audited retire path); rollback refuses unsafe removal.
--
-- WHAT IT ADDS (nothing else changes):
--   * public.document_customer_links: one row per link (job or quote -> customer of the same company), with the document's customer
--     text and the customer's name as they were when linked. Sources: backfill (unverified until verified), manual (names match;
--     verified when made), name_override (names differ; admin only; identity confirmed; verified when made). The job, quote and
--     customer references are ON DELETE RESTRICT: a document or customer with link history is not deleted until an admin retires its
--     links (retire_document_customer_links: reason, fresh code, full snapshot in the audit trail first). RLS: admin and office read
--     the rows of documents in sections they can see; no API role writes. A guard allows only the one-time verify stamp, the one-time
--     unlink stamp, and removal through retire, the company offboarding or the rollback. Every row change is a security_audit.audit_log row.
--   * public.document_customer_links_verified (security_invoker view): what may be shown. Live, VERIFIED, and neither the document's
--     customer text nor the customer's name has changed since the link was made; never an internal job. Seven columns, no money.
--   * public.customer_portal_switch: the company's portal switch. No row = OFF; written only by customer_portal_set_enabled (admin); a
--     guard refuses every other write, any DELETE other than the company offboarding's, and TRUNCATE; every change is a
--     security_audit.audit_log row.
--   * Functions (signed-in only): link_document_customer, link_document_customer_name_override, verify_document_customer_links,
--     unlink_document_customer, retire_document_customer_links, customer_portal_status, customer_portal_set_enabled, and the platform
--     owner's platform_offboard_document_customer_links (PM ruling (d), 12 Nov 2026: no permanent company-delete block).
--     Internal (no API role): _document_customer_link_actor, _document_customer_link_reason, _document_customer_link_backfill and the
--     two trigger functions.
--   * The backfill, once per company: a job (not internal) or quote is linked, UNVERIFIED, only when its customer text matches exactly
--     one customer of its own company. Ambiguous, unmatched and nameless documents are NOT inserted; all are counted in the company's
--     DOCUMENT_CUSTOMER_LINK_BACKFILL audit event. Nothing the backfill writes is shown until a person verifies it.
-- WHAT IT DOES NOT TOUCH: no column, trigger, policy or grant on jobs, quotes, invoices, credit notes, delivery notes, purchase orders
--   or customers; no issued-document guard function; no job or quote creation path (the release proves the first two, before and
--   after, in one transaction). The foreign keys add PostgreSQL's own internal referential triggers on jobs, quotes and customers:
--   deleting a job, quote or customer that has link rows is REFUSED (23503) until its links are retired. New jobs and quotes get no
--   link here; reliable assignment at creation is a later release with the Jobs, Quotes and Customers app changes.
-- RETENTION: link rows live as long as their document; they leave only through retire (with a reason, before the document or customer
--   is deleted under its own retention rule), the company offboarding (platform owner, with a reason: every link row and the switch row
--   of one company, so 153 never blocks that company's removal) or this release's rollback (unverified backfill rows only). The
--   offboarding never deletes the company, a document, a customer or an audit row. Audit rows are never deleted
--   or changed by anything here; they follow the audit trail's own retention (full detail 6 years, then personal fields anonymised by
--   the checkpoint method, which keeps the hash chain verifiable). Reasons are free text: the screens ask for no personal data in them,
--   and link_reason, verify_reason and unlink_reason join the anonymiser's key list when that is built, with the customer names:
--   document_customer_text and customer_name_at_link (row audits), the override event's document_customer_text and customer_name, the
--   retire and offboarding events' nested rows[] (each holds both names and the three reasons), and the switch's reason (row audit,
--   event and the offboarding event's switch snapshot).
-- =====================================================================================================
BEGIN;
-- ---- 1. The link table: jobs and quotes only ----------------------------------------------------------------------------------------
-- One row per link. A live link (unlinked_at IS NULL) is at most one per document. Each row keeps the document's customer text and the
-- customer's name as they were when it was made. Rows change only by the one-time verify stamp and the one-time unlink stamp; a relink
-- is a new row. The job, quote and customer references are ON DELETE RESTRICT (the 045 / 081 "records kept" precedent): a link row
-- never disappears behind a document's back. The document tables get no column, trigger, policy or grant from this release.
CREATE TABLE public.document_customer_links (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES public.organizations(id),
  doc_kind                TEXT NOT NULL,
  job_id                  UUID REFERENCES public.jobs(id) ON DELETE RESTRICT,
  quote_id                UUID REFERENCES public.quotes(id) ON DELETE RESTRICT,
  customer_id             UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  source                  TEXT NOT NULL,
  document_customer_text  TEXT NOT NULL,
  customer_name_at_link   TEXT NOT NULL,
  linked_by               UUID,
  link_reason             TEXT,
  linked_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  verified_by             UUID,
  verify_reason           TEXT,
  verified_at             TIMESTAMPTZ,
  unlinked_by             UUID,
  unlink_reason           TEXT,
  unlinked_at             TIMESTAMPTZ,
  CONSTRAINT document_customer_links_kind CHECK (doc_kind IN ('job', 'quote')),
  CONSTRAINT document_customer_links_one_document CHECK (num_nonnulls(job_id, quote_id) = 1
    AND (doc_kind = 'job') = (job_id IS NOT NULL) AND (doc_kind = 'quote') = (quote_id IS NOT NULL)),
  CONSTRAINT document_customer_links_source CHECK (source IN ('backfill', 'manual', 'name_override')),
  CONSTRAINT document_customer_links_names CHECK (btrim(document_customer_text) <> '' AND btrim(customer_name_at_link) <> ''
    AND CASE source WHEN 'name_override' THEN lower(btrim(document_customer_text)) <> lower(btrim(customer_name_at_link))
                    ELSE lower(btrim(document_customer_text)) = lower(btrim(customer_name_at_link)) END),
  CONSTRAINT document_customer_links_who_and_why CHECK (CASE source
    WHEN 'backfill' THEN linked_by IS NULL AND link_reason IS NULL
    ELSE linked_by IS NOT NULL AND length(btrim(coalesce(link_reason, ''))) BETWEEN 1 AND 500
         AND verified_by = linked_by AND verified_at = linked_at AND verify_reason = link_reason END),
  CONSTRAINT document_customer_links_verify_whole CHECK ((verified_at IS NULL) = (verified_by IS NULL)
    AND (verified_at IS NULL) = (verify_reason IS NULL)
    AND (verify_reason IS NULL OR length(btrim(verify_reason)) BETWEEN 1 AND 500)),
  CONSTRAINT document_customer_links_unlink_whole CHECK ((unlinked_at IS NULL) = (unlinked_by IS NULL)
    AND (unlinked_at IS NULL) = (unlink_reason IS NULL)
    AND (unlink_reason IS NULL OR length(btrim(unlink_reason)) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX document_customer_links_one_live_job ON public.document_customer_links (job_id) WHERE unlinked_at IS NULL AND job_id IS NOT NULL;
CREATE UNIQUE INDEX document_customer_links_one_live_quote ON public.document_customer_links (quote_id) WHERE unlinked_at IS NULL AND quote_id IS NOT NULL;
CREATE INDEX document_customer_links_job ON public.document_customer_links (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX document_customer_links_quote ON public.document_customer_links (quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX document_customer_links_customer ON public.document_customer_links (customer_id);
CREATE INDEX document_customer_links_pending ON public.document_customer_links (organization_id) WHERE unlinked_at IS NULL AND verified_at IS NULL;

-- Read only: own company, admin and office, only in a section the person may see, and only where the caller can already see the
-- document (the EXISTS runs under the caller's own row security on jobs / quotes). Admin and office see unverified backfill rows here so
-- they can verify or unlink them; nothing outside the verified view is ever shown to a customer. Nobody writes directly: the functions
-- below are the only route; the service role gets nothing in 153.
ALTER TABLE public.document_customer_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_customer_links select" ON public.document_customer_links FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id())
         AND (SELECT public.has_org_role(ARRAY['admin', 'office']))
         AND CASE document_customer_links.doc_kind
               WHEN 'job' THEN (SELECT public.section_allowed('jobs'))
                               AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = document_customer_links.job_id)
               WHEN 'quote' THEN (SELECT public.section_allowed('quotes'))
                                 AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = document_customer_links.quote_id)
               ELSE FALSE END);
REVOKE ALL ON public.document_customer_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.document_customer_links TO authenticated;

-- Same company: the existing 006 trigger function, unchanged, once per parent (the zz_same_org_<column> naming of 006).
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.document_customer_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
CREATE TRIGGER zz_same_org_quote_id BEFORE INSERT OR UPDATE ON public.document_customer_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('quotes', 'quote_id');
CREATE TRIGGER zz_same_org_customer_id BEFORE INSERT OR UPDATE ON public.document_customer_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('customers', 'customer_id');

-- The guard.
--   INSERT: starts live; a backfill row starts unverified; the document is a non-internal job or a quote of its own company and the
--     stored texts are exactly the document's customer text and the customer's name now (the names rule is the CHECK above).
--   UPDATE: exactly one of the one-time verify stamp (only while live, and only while neither text has changed since the link:
--     otherwise link_stale) or the one-time unlink stamp; every other column unchanged.
--   DELETE: only inside retire_document_customer_links for that document or customer, inside platform_offboard_document_customer_links
--     for that company, or inside 153's rollback for an unverified, live backfill row (each sets the transaction-local
--     tolra.document_customer_link_removal). Anything else is refused, the owner too.
CREATE FUNCTION public.document_customer_links_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_doc_text TEXT;
  v_internal BOOLEAN := FALSE;
  v_found    BOOLEAN;
  v_name     TEXT;
  v_removal  TEXT := coalesce(current_setting('tolra.document_customer_link_removal', TRUE), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.unlinked_at IS NOT NULL OR (NEW.source = 'backfill' AND NEW.verified_at IS NOT NULL) THEN
      RAISE EXCEPTION 'A new document link starts live, and a backfill link starts unverified.' USING ERRCODE = '42501', HINT = 'link_immutable';
    END IF;
    IF NEW.doc_kind = 'job' THEN
      SELECT j.customer, j.is_internal INTO v_doc_text, v_internal FROM public.jobs j WHERE j.id = NEW.job_id AND j.organization_id = NEW.organization_id;
      v_found := FOUND;
    ELSE
      SELECT q.customer INTO v_doc_text FROM public.quotes q WHERE q.id = NEW.quote_id AND q.organization_id = NEW.organization_id;
      v_found := FOUND;
    END IF;
    IF NOT v_found THEN
      RAISE EXCEPTION 'A document link must name a % of its own company.', NEW.doc_kind USING ERRCODE = '42501', HINT = 'link_other_company';
    END IF;
    IF v_internal THEN
      RAISE EXCEPTION 'An internal job has no customer to link.' USING ERRCODE = '22023', HINT = 'internal_job';
    END IF;
    SELECT c.name INTO v_name FROM public.customers c WHERE c.id = NEW.customer_id AND c.organization_id = NEW.organization_id;
    IF NOT FOUND OR NEW.document_customer_text IS DISTINCT FROM v_doc_text OR NEW.customer_name_at_link IS DISTINCT FROM v_name THEN
      RAISE EXCEPTION 'A document link must record the document''s customer text and the customer''s name as they are now.' USING ERRCODE = '42501', HINT = 'link_stale';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.organization_id, NEW.doc_kind, NEW.job_id, NEW.quote_id, NEW.customer_id, NEW.source, NEW.document_customer_text,
        NEW.customer_name_at_link, NEW.linked_by, NEW.link_reason, NEW.linked_at)
       IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.doc_kind, OLD.job_id, OLD.quote_id, OLD.customer_id, OLD.source, OLD.document_customer_text,
        OLD.customer_name_at_link, OLD.linked_by, OLD.link_reason, OLD.linked_at) THEN
      RAISE EXCEPTION 'A document link can''t be changed: unlink it (once, with a reason) and link again.' USING ERRCODE = '42501', HINT = 'link_immutable';
    END IF;
    -- The one-time verify stamp: live before and after, unlink columns untouched, and nothing has changed since the link was made.
    IF OLD.verified_at IS NULL AND NEW.verified_at IS NOT NULL AND OLD.unlinked_at IS NULL AND NEW.unlinked_at IS NULL
       AND NEW.unlinked_by IS NULL AND NEW.unlink_reason IS NULL THEN
      IF NOT EXISTS (
           SELECT 1 FROM public.customers c
           WHERE c.id = OLD.customer_id AND lower(btrim(c.name)) = lower(btrim(OLD.customer_name_at_link))
             AND CASE OLD.doc_kind
                   WHEN 'job' THEN EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = OLD.job_id AND NOT j.is_internal
                                             AND lower(btrim(coalesce(j.customer, ''))) = lower(btrim(OLD.document_customer_text)))
                   ELSE EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = OLD.quote_id
                                  AND lower(btrim(q.customer)) = lower(btrim(OLD.document_customer_text))) END) THEN
        RAISE EXCEPTION 'The document''s customer or the customer''s name has changed since this link was made: unlink it and link again.' USING ERRCODE = '55000', HINT = 'link_stale';
      END IF;
      RETURN NEW;
    END IF;
    -- The one-time unlink stamp: verify columns untouched.
    IF OLD.unlinked_at IS NULL AND NEW.unlinked_at IS NOT NULL
       AND (NEW.verified_by, NEW.verify_reason, NEW.verified_at) IS NOT DISTINCT FROM (OLD.verified_by, OLD.verify_reason, OLD.verified_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A document link can''t be changed: unlink it (once, with a reason) and link again.' USING ERRCODE = '42501', HINT = 'link_immutable';
  END IF;
  -- DELETE.
  IF v_removal = 'rollback' AND OLD.source = 'backfill' AND OLD.verified_at IS NULL AND OLD.unlinked_at IS NULL THEN
    RETURN OLD;
  END IF;
  IF v_removal <> '' AND v_removal IN ('retire:job:' || OLD.job_id::TEXT, 'retire:quote:' || OLD.quote_id::TEXT, 'retire:customer:' || OLD.customer_id::TEXT,
                                       'offboard:' || OLD.organization_id::TEXT) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'A document link is a record: it leaves only when an admin retires the links of its document or customer (with a reason).' USING ERRCODE = '42501', HINT = 'link_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.document_customer_links_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER document_customer_links_guard BEFORE INSERT OR UPDATE OR DELETE ON public.document_customer_links
  FOR EACH ROW EXECUTE FUNCTION public.document_customer_links_guard();

CREATE FUNCTION public.document_customer_links_no_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Document links are a record: they can''t be emptied.' USING ERRCODE = '42501', HINT = 'link_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.document_customer_links_no_truncate() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER document_customer_links_no_truncate BEFORE TRUNCATE ON public.document_customer_links
  FOR EACH STATEMENT EXECUTE FUNCTION public.document_customer_links_no_truncate();

-- Every row change (backfill, link, verify, unlink, retire, rollback) is a row in the append-only, hash-chained security_audit.audit_log
-- (000/006: prevent_audit_mutation refuses UPDATE and DELETE there). No support_read_only / admin_mfa statement triggers on this table:
-- the functions check both themselves.
CREATE TRIGGER audit_document_customer_links_changes AFTER INSERT OR UPDATE OR DELETE ON public.document_customer_links
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- ---- 2. What may be shown: verified links only ---------------------------------------------------------------------------------------
-- Live, VERIFIED (a person verified it, or a person made it), and neither the document's customer text nor the customer's name has
-- changed since the link was made (case and surrounding spaces aside); never an internal job. An unverified backfill link is never here.
-- security_invoker: the caller's own row security applies. Only these seven columns: no cost, margin, balance, total, status or approval.
CREATE VIEW public.document_customer_links_verified WITH (security_invoker = true) AS
SELECT l.id, l.organization_id, l.doc_kind, coalesce(l.job_id, l.quote_id) AS document_id, l.customer_id, l.source, l.verified_at
FROM public.document_customer_links l
JOIN public.customers c ON c.id = l.customer_id AND c.organization_id = l.organization_id
LEFT JOIN public.jobs j ON l.doc_kind = 'job' AND j.id = l.job_id AND j.organization_id = l.organization_id
LEFT JOIN public.quotes q ON l.doc_kind = 'quote' AND q.id = l.quote_id AND q.organization_id = l.organization_id
WHERE l.unlinked_at IS NULL
  AND l.verified_at IS NOT NULL
  AND lower(btrim(c.name)) = lower(btrim(l.customer_name_at_link))
  AND CASE l.doc_kind
        WHEN 'job' THEN j.id IS NOT NULL AND NOT j.is_internal AND lower(btrim(coalesce(j.customer, ''))) = lower(btrim(l.document_customer_text))
        WHEN 'quote' THEN q.id IS NOT NULL AND lower(btrim(q.customer)) = lower(btrim(l.document_customer_text))
        ELSE FALSE END;
REVOKE ALL ON public.document_customer_links_verified FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.document_customer_links_verified TO authenticated;

-- ---- 3. The company switch: OFF by default --------------------------------------------------------------------------------------------
-- No row = off. A row exists only once an admin has used the switch. As 149's xero_transfer_hold (not an organization_settings column or
-- a hidden_nav marker, which an admin can change with a plain UPDATE: no fresh code, no reason, no named audit event). In 153 nothing
-- outside Tolra reads it; the portal release refuses every portal call while it is off. Its Settings screen is a separate PR.
CREATE TABLE public.customer_portal_switch (
  id              UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id),
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  changed_by      UUID NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason          TEXT NOT NULL,
  CONSTRAINT customer_portal_switch_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500)
);
ALTER TABLE public.customer_portal_switch ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_portal_switch admin select" ON public.customer_portal_switch FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin'])));
REVOKE ALL ON public.customer_portal_switch FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.customer_portal_switch TO authenticated;

-- Only customer_portal_set_enabled writes the switch: it sets the transaction-local tolra.customer_portal_switch_write to its own company
-- first. Any other INSERT or UPDATE is refused, the owner too. A switch row is never emptied, and is deleted only by the platform owner's
-- company offboarding (platform_offboard_document_customer_links sets the same flag to 'offboard:' and that company; its event keeps the
-- row). Each row is an admin's decision with a reason; 153's rollback refuses while any exists or after any offboarding. Every change is
-- also a security_audit.audit_log row (the id column exists for security_audit.log_row_change, which records each row by id).
CREATE FUNCTION public.customer_portal_switch_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('tolra.customer_portal_switch_write', TRUE), '') = 'offboard:' || OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.organization_id::TEXT = coalesce(current_setting('tolra.customer_portal_switch_write', TRUE), '') THEN
      IF TG_OP = 'INSERT' THEN
        RETURN NEW;
      END IF;
      IF (NEW.id, NEW.organization_id) IS NOT DISTINCT FROM (OLD.id, OLD.organization_id) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'The customer portal switch changes only through its own setting (admin, fresh code, reason), and is removed only by the platform offboarding.'
    USING ERRCODE = '42501', HINT = 'switch_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.customer_portal_switch_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER customer_portal_switch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.customer_portal_switch
  FOR EACH ROW EXECUTE FUNCTION public.customer_portal_switch_guard();

CREATE FUNCTION public.customer_portal_switch_no_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'The customer portal switch is a record: it can''t be emptied.' USING ERRCODE = '42501', HINT = 'switch_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.customer_portal_switch_no_truncate() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER customer_portal_switch_no_truncate BEFORE TRUNCATE ON public.customer_portal_switch
  FOR EACH STATEMENT EXECUTE FUNCTION public.customer_portal_switch_no_truncate();
CREATE TRIGGER audit_customer_portal_switch_changes AFTER INSERT OR UPDATE OR DELETE ON public.customer_portal_switch
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- ---- 4. Who may act (internal) ---------------------------------------------------------------------------------------------------------
-- A signed-in member of the session's company in one of p_roles: 033's second step where the company asks for it (assert_privileged_aal);
-- never a support session (elevated or not) and never a read-only session; and, when p_fresh, an authenticator code from the last
-- 15 minutes (900 s, up to 60 s ahead for clock skew: the test of 136 / 149 and lib/mfa-policy.ts recentSecondStep), whatever the
-- company's own setting (PM answer 2: people without an authenticator enrol first). Returns the company. No API role may call it.
CREATE FUNCTION public._document_customer_link_actor(p_roles TEXT[], p_fresh BOOLEAN)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_now NUMERIC := extract(epoch FROM now());
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR auth.uid() IS NULL OR p_roles IS NULL OR NOT public.has_org_role(p_roles)
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) OR public.session_read_only() THEN
    RAISE EXCEPTION 'Only the company''s own % can do this.', array_to_string(p_roles, ' or ') USING ERRCODE = '42501',
      HINT = CASE WHEN p_roles = ARRAY['admin'] THEN 'admin_required' ELSE 'admin_or_office_required' END;
  END IF;
  IF p_fresh AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::JSONB END) AS e
       WHERE e ->> 'method' IN ('totp', 'mfa/totp')
         AND CASE WHEN jsonb_typeof(e -> 'timestamp') = 'number' THEN (e ->> 'timestamp')::NUMERIC END BETWEEN v_now - 900 AND v_now + 60) THEN
    RAISE EXCEPTION 'Enter a fresh code from your authenticator app first.' USING ERRCODE = '42501', HINT = 'mfa_recent_required';
  END IF;
  RETURN v_org;
END
$$;
REVOKE ALL ON FUNCTION public._document_customer_link_actor(TEXT[], BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._document_customer_link_reason(p_reason TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Give a reason (up to 500 characters).' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;
  RETURN btrim(p_reason);
END
$$;
REVOKE ALL ON FUNCTION public._document_customer_link_reason(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 5. Link by hand (admin or office; fresh code; reason; names must match; audited) ---------------------------------------------------
CREATE FUNCTION public.link_document_customer(p_kind TEXT, p_document UUID, p_customer UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org      UUID := public._document_customer_link_actor(ARRAY['admin', 'office'], TRUE);
  v_uid      UUID := auth.uid();
  v_at       TIMESTAMPTZ := clock_timestamp();
  v_reason   TEXT;
  v_doc_text TEXT;
  v_internal BOOLEAN := FALSE;
  v_name     TEXT;
  v_link     UUID;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('job', 'quote') THEN
    RAISE EXCEPTION 'Only jobs and quotes can be linked to a customer.' USING ERRCODE = '22023', HINT = 'invalid_kind';
  END IF;
  v_reason := public._document_customer_link_reason(p_reason);
  IF NOT public.section_allowed(CASE p_kind WHEN 'job' THEN 'jobs' ELSE 'quotes' END) THEN
    RAISE EXCEPTION 'That % isn''t in your company.', p_kind USING ERRCODE = 'P0002', HINT = 'document_not_found';
  END IF;
  IF p_kind = 'job' THEN
    SELECT j.customer, j.is_internal INTO v_doc_text, v_internal FROM public.jobs j WHERE j.id = p_document AND j.organization_id = v_org;
  ELSE
    SELECT q.customer INTO v_doc_text FROM public.quotes q WHERE q.id = p_document AND q.organization_id = v_org;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That % isn''t in your company.', p_kind USING ERRCODE = 'P0002', HINT = 'document_not_found';
  END IF;
  IF v_internal THEN
    RAISE EXCEPTION 'An internal job has no customer to link.' USING ERRCODE = '22023', HINT = 'internal_job';
  END IF;
  SELECT c.name INTO v_name FROM public.customers c WHERE c.id = p_customer AND c.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That customer isn''t in your company.' USING ERRCODE = 'P0002', HINT = 'customer_not_found';
  END IF;
  IF btrim(coalesce(v_doc_text, '')) = '' OR lower(btrim(v_name)) IS DISTINCT FROM lower(btrim(v_doc_text)) THEN
    RAISE EXCEPTION 'That customer isn''t the one named on this % (%). An admin can link it after confirming who the customer is.', p_kind, btrim(coalesce(v_doc_text, ''))
      USING ERRCODE = '22023', HINT = 'customer_mismatch';
  END IF;
  BEGIN
    INSERT INTO public.document_customer_links (organization_id, doc_kind, job_id, quote_id, customer_id, source, document_customer_text,
                                                customer_name_at_link, linked_by, link_reason, linked_at, verified_by, verify_reason, verified_at)
    VALUES (v_org, p_kind, CASE WHEN p_kind = 'job' THEN p_document END, CASE WHEN p_kind = 'quote' THEN p_document END, p_customer, 'manual',
            v_doc_text, v_name, v_uid, v_reason, v_at, v_uid, v_reason, v_at)
    RETURNING id INTO v_link;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This % is already linked to a customer (verified or waiting): verify or unlink that link first.', p_kind USING ERRCODE = '55000', HINT = 'already_linked';
  END;
  PERFORM security_audit.log_named_event(v_org, 'DOCUMENT_CUSTOMER_LINKED', 'document_customer_links', v_link::TEXT,
    jsonb_build_object('doc_kind', p_kind, 'document_id', p_document, 'customer_id', p_customer, 'reason', v_reason, 'actor', v_uid));
  RETURN jsonb_build_object('link_id', v_link, 'doc_kind', p_kind, 'document_id', p_document, 'customer_id', p_customer, 'source', 'manual');
END
$$;

-- ---- 6. Link with a different name (PM answer 1: ADMIN only; identity confirmed; fresh code; reason; its own audit event) -------------
-- For a document whose customer text can't be corrected (for example a sent quote with a typo). Refused when the names already match
-- (use the ordinary link), when the identity was not confirmed, or when the document has no customer text at all.
CREATE FUNCTION public.link_document_customer_name_override(p_kind TEXT, p_document UUID, p_customer UUID, p_reason TEXT, p_identity_confirmed BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org      UUID := public._document_customer_link_actor(ARRAY['admin'], TRUE);
  v_uid      UUID := auth.uid();
  v_at       TIMESTAMPTZ := clock_timestamp();
  v_reason   TEXT;
  v_doc_text TEXT;
  v_internal BOOLEAN := FALSE;
  v_name     TEXT;
  v_link     UUID;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('job', 'quote') THEN
    RAISE EXCEPTION 'Only jobs and quotes can be linked to a customer.' USING ERRCODE = '22023', HINT = 'invalid_kind';
  END IF;
  v_reason := public._document_customer_link_reason(p_reason);
  IF p_identity_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm you have checked who the customer is before linking a different name.' USING ERRCODE = '22023', HINT = 'identity_not_confirmed';
  END IF;
  IF NOT public.section_allowed(CASE p_kind WHEN 'job' THEN 'jobs' ELSE 'quotes' END) THEN
    RAISE EXCEPTION 'That % isn''t in your company.', p_kind USING ERRCODE = 'P0002', HINT = 'document_not_found';
  END IF;
  IF p_kind = 'job' THEN
    SELECT j.customer, j.is_internal INTO v_doc_text, v_internal FROM public.jobs j WHERE j.id = p_document AND j.organization_id = v_org;
  ELSE
    SELECT q.customer INTO v_doc_text FROM public.quotes q WHERE q.id = p_document AND q.organization_id = v_org;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That % isn''t in your company.', p_kind USING ERRCODE = 'P0002', HINT = 'document_not_found';
  END IF;
  IF v_internal THEN
    RAISE EXCEPTION 'An internal job has no customer to link.' USING ERRCODE = '22023', HINT = 'internal_job';
  END IF;
  IF btrim(coalesce(v_doc_text, '')) = '' THEN
    RAISE EXCEPTION 'This % names no customer.', p_kind USING ERRCODE = '22023', HINT = 'no_customer_text';
  END IF;
  SELECT c.name INTO v_name FROM public.customers c WHERE c.id = p_customer AND c.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That customer isn''t in your company.' USING ERRCODE = 'P0002', HINT = 'customer_not_found';
  END IF;
  IF lower(btrim(v_name)) = lower(btrim(v_doc_text)) THEN
    RAISE EXCEPTION 'The names match: use the ordinary link.' USING ERRCODE = '22023', HINT = 'names_match';
  END IF;
  BEGIN
    INSERT INTO public.document_customer_links (organization_id, doc_kind, job_id, quote_id, customer_id, source, document_customer_text,
                                                customer_name_at_link, linked_by, link_reason, linked_at, verified_by, verify_reason, verified_at)
    VALUES (v_org, p_kind, CASE WHEN p_kind = 'job' THEN p_document END, CASE WHEN p_kind = 'quote' THEN p_document END, p_customer, 'name_override',
            v_doc_text, v_name, v_uid, v_reason, v_at, v_uid, v_reason, v_at)
    RETURNING id INTO v_link;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This % is already linked to a customer (verified or waiting): verify or unlink that link first.', p_kind USING ERRCODE = '55000', HINT = 'already_linked';
  END;
  PERFORM security_audit.log_named_event(v_org, 'DOCUMENT_CUSTOMER_LINKED_NAME_OVERRIDE', 'document_customer_links', v_link::TEXT,
    jsonb_build_object('doc_kind', p_kind, 'document_id', p_document, 'customer_id', p_customer, 'document_customer_text', v_doc_text,
                       'customer_name', v_name, 'identity_confirmed', TRUE, 'reason', v_reason, 'actor', v_uid));
  RETURN jsonb_build_object('link_id', v_link, 'doc_kind', p_kind, 'document_id', p_document, 'customer_id', p_customer, 'source', 'name_override');
END
$$;

-- ---- 7. Verify backfill links (admin or office; fresh code; one reason for the batch; 1..200 links; all or nothing; audited) ----------
CREATE FUNCTION public.verify_document_customer_links(p_links UUID[], p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public._document_customer_link_actor(ARRAY['admin', 'office'], TRUE);
  v_uid    UUID := auth.uid();
  v_at     TIMESTAMPTZ := clock_timestamp();
  v_reason TEXT;
  v_ids    UUID[];
  v_row    public.document_customer_links%ROWTYPE;
  v_n      INT := 0;
BEGIN
  v_reason := public._document_customer_link_reason(p_reason);
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_links) AS x WHERE x IS NOT NULL;
  IF p_links IS NULL OR v_ids IS NULL OR cardinality(v_ids) <> cardinality(p_links) OR cardinality(v_ids) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Choose between 1 and 200 links to verify, each once.' USING ERRCODE = '22023', HINT = 'invalid_batch';
  END IF;
  FOR v_row IN SELECT * FROM public.document_customer_links l WHERE l.id = ANY (v_ids) AND l.organization_id = v_org ORDER BY l.id FOR UPDATE LOOP
    IF v_row.source <> 'backfill' OR v_row.verified_at IS NOT NULL OR v_row.unlinked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Link % is not a waiting backfill link.', v_row.id USING ERRCODE = '55000', HINT = 'not_pending';
    END IF;
    IF NOT public.section_allowed(CASE v_row.doc_kind WHEN 'job' THEN 'jobs' ELSE 'quotes' END) THEN
      RAISE EXCEPTION 'Link % isn''t in your company.', v_row.id USING ERRCODE = 'P0002', HINT = 'link_not_found';
    END IF;
    UPDATE public.document_customer_links l SET verified_by = v_uid, verify_reason = v_reason, verified_at = v_at WHERE l.id = v_row.id;
    PERFORM security_audit.log_named_event(v_org, 'DOCUMENT_CUSTOMER_LINK_VERIFIED', 'document_customer_links', v_row.id::TEXT,
      jsonb_build_object('doc_kind', v_row.doc_kind, 'document_id', coalesce(v_row.job_id, v_row.quote_id), 'customer_id', v_row.customer_id,
                         'reason', v_reason, 'actor', v_uid, 'batch_size', cardinality(v_ids)));
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'One or more links aren''t in your company. Nothing was verified.' USING ERRCODE = 'P0002', HINT = 'link_not_found';
  END IF;
  RETURN jsonb_build_object('verified', v_n, 'verified_at', v_at);
END
$$;

-- ---- 8. Unlink (admin or office; fresh code; reason; audited). Also how a wrong backfill link is rejected. ----------------------------
CREATE FUNCTION public.unlink_document_customer(p_kind TEXT, p_document UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public._document_customer_link_actor(ARRAY['admin', 'office'], TRUE);
  v_uid    UUID := auth.uid();
  v_reason TEXT;
  v_link   public.document_customer_links%ROWTYPE;
  v_at     TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('job', 'quote') THEN
    RAISE EXCEPTION 'Only jobs and quotes can be linked to a customer.' USING ERRCODE = '22023', HINT = 'invalid_kind';
  END IF;
  v_reason := public._document_customer_link_reason(p_reason);
  IF NOT public.section_allowed(CASE p_kind WHEN 'job' THEN 'jobs' ELSE 'quotes' END) THEN
    RAISE EXCEPTION 'This % isn''t linked to a customer.', p_kind USING ERRCODE = 'P0002', HINT = 'not_linked';
  END IF;
  SELECT * INTO v_link FROM public.document_customer_links l
  WHERE l.organization_id = v_org AND l.unlinked_at IS NULL AND l.doc_kind = p_kind
    AND (l.job_id = p_document OR l.quote_id = p_document)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This % isn''t linked to a customer.', p_kind USING ERRCODE = 'P0002', HINT = 'not_linked';
  END IF;
  UPDATE public.document_customer_links l SET unlinked_at = v_at, unlinked_by = v_uid, unlink_reason = v_reason WHERE l.id = v_link.id;
  PERFORM security_audit.log_named_event(v_org, 'DOCUMENT_CUSTOMER_UNLINKED', 'document_customer_links', v_link.id::TEXT,
    jsonb_build_object('doc_kind', p_kind, 'document_id', p_document, 'customer_id', v_link.customer_id, 'was_source', v_link.source,
                       'was_verified', v_link.verified_at IS NOT NULL, 'reason', v_reason, 'actor', v_uid));
  RETURN jsonb_build_object('link_id', v_link.id, 'unlinked_at', v_at);
END
$$;

-- ---- 9. Retire (ADMIN only; fresh code; reason): the controlled way a document or customer with link history can later be deleted -------
-- Removes every link row of that job, quote or customer (each removal is its own row-audit DELETE) and, in the same transaction, writes
-- one DOCUMENT_CUSTOMER_LINKS_RETIRED event holding exactly the removed rows in full, taken from the DELETE itself (DELETE ... RETURNING:
-- no row can be added or changed between reading and removing), so the audit trail says what was removed, by whom and why. Does NOT delete
-- the document or the customer: that stays the existing route, under its own rules (jobs: admin; quotes and customers: admin or
-- office; 082 customers_in_use_guard still refuses a customer that is named on a record) and its own retention rule.
CREATE FUNCTION public.retire_document_customer_links(p_target_kind TEXT, p_target UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org      UUID := public._document_customer_link_actor(ARRAY['admin'], TRUE);
  v_uid      UUID := auth.uid();
  v_reason   TEXT;
  v_snapshot JSONB;
  v_n        INT;
BEGIN
  IF p_target_kind IS NULL OR p_target_kind NOT IN ('job', 'quote', 'customer') THEN
    RAISE EXCEPTION 'Retire the links of a job, a quote or a customer.' USING ERRCODE = '22023', HINT = 'invalid_kind';
  END IF;
  v_reason := public._document_customer_link_reason(p_reason);
  PERFORM set_config('tolra.document_customer_link_removal', 'retire:' || p_target_kind || ':' || p_target::TEXT, TRUE);
  WITH gone AS (
    DELETE FROM public.document_customer_links l
    WHERE l.organization_id = v_org
      AND CASE p_target_kind WHEN 'job' THEN l.job_id = p_target WHEN 'quote' THEN l.quote_id = p_target ELSE l.customer_id = p_target END
    RETURNING l.*
  )
  SELECT jsonb_agg(to_jsonb(g) ORDER BY g.linked_at, g.id), count(*) INTO v_snapshot, v_n FROM gone g;
  PERFORM set_config('tolra.document_customer_link_removal', '', TRUE);
  IF coalesce(v_n, 0) = 0 THEN
    RAISE EXCEPTION 'That % has no links to retire.', p_target_kind USING ERRCODE = 'P0002', HINT = 'not_linked';
  END IF;
  PERFORM security_audit.log_named_event(v_org, 'DOCUMENT_CUSTOMER_LINKS_RETIRED', 'document_customer_links', p_target::TEXT,
    jsonb_build_object('target_kind', p_target_kind, 'target_id', p_target, 'rows', v_snapshot, 'count', v_n, 'reason', v_reason, 'actor', v_uid));
  RETURN jsonb_build_object('retired', v_n, 'target_kind', p_target_kind, 'target_id', p_target);
END
$$;

-- ---- 10. The switch: status (admin) and on / off (admin, reason; ON needs a fresh code; OFF never waits for one) ------------------------
CREATE FUNCTION public.customer_portal_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The same checks as every other function here (033's second step where asked, never a support or read-only session); admin only;
  -- reading needs no fresh code.
  v_org UUID := public._document_customer_link_actor(ARRAY['admin'], FALSE);
  v_row public.customer_portal_switch%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.customer_portal_switch s WHERE s.organization_id = v_org;
  RETURN jsonb_build_object('enabled', coalesce(v_row.enabled, FALSE), 'changed_at', v_row.changed_at);
END
$$;

CREATE FUNCTION public.customer_portal_set_enabled(p_enabled BOOLEAN, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public._document_customer_link_actor(ARRAY['admin'], coalesce(p_enabled, FALSE));
  v_uid    UUID := auth.uid();
  v_reason TEXT;
  v_was    BOOLEAN;
  v_at     TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'Choose on or off.' USING ERRCODE = '22023', HINT = 'invalid_enabled';
  END IF;
  v_reason := public._document_customer_link_reason(p_reason);
  PERFORM set_config('tolra.customer_portal_switch_write', v_org::TEXT, TRUE);
  -- Switching on: insert the row first (149's pattern), so two switch-ons at once wait on the same row and the second sees it on and
  -- logs nothing. Switching off never creates a row: no row already means off.
  IF p_enabled THEN
    INSERT INTO public.customer_portal_switch (organization_id, enabled, changed_by, changed_at, reason)
    VALUES (v_org, FALSE, v_uid, v_at, v_reason) ON CONFLICT (organization_id) DO NOTHING;
  END IF;
  SELECT s.enabled INTO v_was FROM public.customer_portal_switch s WHERE s.organization_id = v_org FOR UPDATE;
  v_was := coalesce(v_was, FALSE);
  IF v_was IS DISTINCT FROM p_enabled THEN
    INSERT INTO public.customer_portal_switch AS s (organization_id, enabled, changed_by, changed_at, reason)
    VALUES (v_org, p_enabled, v_uid, v_at, v_reason)
    ON CONFLICT (organization_id) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by,
      changed_at = EXCLUDED.changed_at, reason = EXCLUDED.reason;
    PERFORM security_audit.log_named_event(v_org, 'CUSTOMER_PORTAL_SWITCH_CHANGED', 'customer_portal_switch', v_org::TEXT,
      jsonb_build_object('enabled', p_enabled, 'was', v_was, 'reason', v_reason, 'actor', v_uid));
  END IF;
  PERFORM set_config('tolra.customer_portal_switch_write', '', TRUE);
  RETURN jsonb_build_object('enabled', p_enabled, 'changed_at', CASE WHEN v_was IS DISTINCT FROM p_enabled THEN v_at END);
END
$$;

-- Signed-in users only (each function checks the role itself); never anon, never the service role, never PUBLIC.
REVOKE ALL ON FUNCTION public.link_document_customer(TEXT, UUID, UUID, TEXT), public.link_document_customer_name_override(TEXT, UUID, UUID, TEXT, BOOLEAN),
  public.verify_document_customer_links(UUID[], TEXT), public.unlink_document_customer(TEXT, UUID, TEXT), public.retire_document_customer_links(TEXT, UUID, TEXT),
  public.customer_portal_status(), public.customer_portal_set_enabled(BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_document_customer(TEXT, UUID, UUID, TEXT), public.link_document_customer_name_override(TEXT, UUID, UUID, TEXT, BOOLEAN),
  public.verify_document_customer_links(UUID[], TEXT), public.unlink_document_customer(TEXT, UUID, TEXT), public.retire_document_customer_links(TEXT, UUID, TEXT),
  public.customer_portal_status(), public.customer_portal_set_enabled(BOOLEAN, TEXT) TO authenticated;

-- ---- 10a. Company offboarding (PLATFORM OWNER only; second step; fresh code; reason): PM ruling (d), 12 Nov 2026 --------------------------
-- 153 must not block a company's removal for ever. This removes, for ONE company, every document link row (live, verified, unlinked or
-- backfill; each removal is its own row-audit DELETE) and its portal switch row (a row-audit DELETE too), and in the same transaction
-- writes one CUSTOMER_PORTAL_OFFBOARDED event in that company's own audit chain holding exactly the removed rows, taken from the DELETEs
-- themselves (DELETE ... RETURNING, as retire). Nothing references a link or switch row, so nothing is orphaned. It does NOT delete the
-- company, a document, a customer or any audit row, and changes nothing else: deleting the company stays outside 153 under its own rules
-- (security_audit.audit_log's reference to organizations, 000, still keeps a company with audit history; audit evidence never cascades).
-- Who: the platform owner pattern of 036 / 039 / 107 (is_platform_admin, then assert_platform_aal: aal2 always), never a read-only support
-- session, plus an authenticator code from the last 15 minutes (the fresh-code test of _document_customer_link_actor, 136, 149) because it
-- removes admins' recorded decisions. Both tables are locked (SHARE ROW EXCLUSIVE, as the rollback locks before its checks) so no link,
-- verify, unlink, retire or switch can commit between the removal and the event. Refused (nothing written) when the company has nothing
-- to remove. After any offboarding the 153 rollback refuses (re-applying 153 would backfill that company again).
CREATE FUNCTION public.platform_offboard_document_customer_links(p_org UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_now    NUMERIC := extract(epoch FROM now());
  v_reason TEXT;
  v_links  JSONB;
  v_n      INT;
  v_switch JSONB;
BEGIN
  IF v_uid IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501', HINT = 'platform_required';
  END IF;
  PERFORM public.assert_platform_aal();
  IF public.session_read_only() THEN
    RAISE EXCEPTION 'Support access is read-only. Ask for write access first.' USING ERRCODE = '42501', HINT = 'support_read_only';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::JSONB END) AS e
       WHERE e ->> 'method' IN ('totp', 'mfa/totp')
         AND CASE WHEN jsonb_typeof(e -> 'timestamp') = 'number' THEN (e ->> 'timestamp')::NUMERIC END BETWEEN v_now - 900 AND v_now + 60) THEN
    RAISE EXCEPTION 'Enter a fresh code from your authenticator app first.' USING ERRCODE = '42501', HINT = 'mfa_recent_required';
  END IF;
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'Company not found.' USING ERRCODE = 'P0002', HINT = 'company_not_found';
  END IF;
  v_reason := public._document_customer_link_reason(p_reason);
  LOCK TABLE public.document_customer_links, public.customer_portal_switch IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('tolra.document_customer_link_removal', 'offboard:' || p_org::TEXT, TRUE);
  WITH gone AS (
    DELETE FROM public.document_customer_links l WHERE l.organization_id = p_org RETURNING l.*
  )
  SELECT jsonb_agg(to_jsonb(g) ORDER BY g.linked_at, g.id), count(*) INTO v_links, v_n FROM gone g;
  PERFORM set_config('tolra.document_customer_link_removal', '', TRUE);
  PERFORM set_config('tolra.customer_portal_switch_write', 'offboard:' || p_org::TEXT, TRUE);
  WITH gone AS (
    DELETE FROM public.customer_portal_switch s WHERE s.organization_id = p_org RETURNING s.*
  )
  SELECT to_jsonb(g) INTO v_switch FROM gone g;
  PERFORM set_config('tolra.customer_portal_switch_write', '', TRUE);
  IF coalesce(v_n, 0) = 0 AND v_switch IS NULL THEN
    RAISE EXCEPTION 'That company has no document links or portal switch to remove.' USING ERRCODE = 'P0002', HINT = 'nothing_to_offboard';
  END IF;
  PERFORM security_audit.log_named_event(p_org, 'CUSTOMER_PORTAL_OFFBOARDED', 'document_customer_links', p_org::TEXT,
    jsonb_build_object('rows', coalesce(v_links, '[]'::JSONB), 'count', coalesce(v_n, 0), 'switch', v_switch, 'reason', v_reason, 'actor', v_uid));
  RETURN jsonb_build_object('removed_links', coalesce(v_n, 0), 'removed_switch', v_switch IS NOT NULL, 'organization_id', p_org);
END
$$;
REVOKE ALL ON FUNCTION public.platform_offboard_document_customer_links(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_offboard_document_customer_links(UUID, TEXT) TO authenticated;

-- ---- 11. Backfill (internal; the release runs it once per company). Every row it writes is UNVERIFIED and hidden. -----------------------
-- A job (not internal) or quote with NO link row at all (live or unlinked: a person's unlink is never undone here) is linked when its
-- trimmed, lower-case customer text matches exactly ONE customer of its own company (archived customers count: archiving never changes
-- the customer row, 100). Zero matches, two or more (an active and an archived one included), or no name: NOT inserted, only counted.
-- Never across companies. A second run inserts nothing new. Writes one DOCUMENT_CUSTOMER_LINK_BACKFILL event per company with the counts;
-- every inserted row is also its own audit row (the trigger above). Never touches a job, quote or customer row.
CREATE FUNCTION public._document_customer_link_backfill(p_org UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'The backfill is run by the release, not by a signed-in user.' USING ERRCODE = '42501';
  END IF;
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'backfill: no such company' USING ERRCODE = '22023';
  END IF;
  WITH names AS (
    SELECT lower(btrim(c.name)) AS nn, count(*)::INT AS n, (array_agg(c.id))[1] AS only_id, (array_agg(c.name))[1] AS only_name
    FROM public.customers c WHERE c.organization_id = p_org GROUP BY 1
  ), docs AS (
    SELECT 'job'::TEXT AS kind, j.id, j.customer AS doc_text, lower(btrim(coalesce(j.customer, ''))) AS nn,
           EXISTS (SELECT 1 FROM public.document_customer_links l WHERE l.job_id = j.id) AS has_row
    FROM public.jobs j WHERE j.organization_id = p_org AND NOT j.is_internal
    UNION ALL
    SELECT 'quote'::TEXT, q.id, q.customer, lower(btrim(coalesce(q.customer, ''))),
           EXISTS (SELECT 1 FROM public.document_customer_links l WHERE l.quote_id = q.id)
    FROM public.quotes q WHERE q.organization_id = p_org
  ), classified AS (
    SELECT d.kind, d.id, d.doc_text, n.only_id, n.only_name,
           CASE WHEN d.has_row THEN 'already' WHEN d.nn = '' THEN 'no_name' WHEN n.n IS NULL THEN 'unmatched'
                WHEN n.n > 1 THEN 'ambiguous' ELSE 'link' END AS outcome
    FROM docs d LEFT JOIN names n ON n.nn = d.nn
  ), ins AS (
    INSERT INTO public.document_customer_links (organization_id, doc_kind, job_id, quote_id, customer_id, source, document_customer_text, customer_name_at_link)
    SELECT p_org, c.kind, CASE WHEN c.kind = 'job' THEN c.id END, CASE WHEN c.kind = 'quote' THEN c.id END, c.only_id, 'backfill', c.doc_text, c.only_name
    FROM classified c WHERE c.outcome = 'link'
    RETURNING doc_kind
  )
  SELECT jsonb_build_object(
    'jobs', jsonb_build_object('linked_unverified', (SELECT count(*) FROM ins WHERE ins.doc_kind = 'job'),
                               'ambiguous', count(*) FILTER (WHERE kind = 'job' AND outcome = 'ambiguous'),
                               'unmatched', count(*) FILTER (WHERE kind = 'job' AND outcome = 'unmatched'),
                               'no_name', count(*) FILTER (WHERE kind = 'job' AND outcome = 'no_name'),
                               'already', count(*) FILTER (WHERE kind = 'job' AND outcome = 'already')),
    'quotes', jsonb_build_object('linked_unverified', (SELECT count(*) FROM ins WHERE ins.doc_kind = 'quote'),
                                 'ambiguous', count(*) FILTER (WHERE kind = 'quote' AND outcome = 'ambiguous'),
                                 'unmatched', count(*) FILTER (WHERE kind = 'quote' AND outcome = 'unmatched'),
                                 'no_name', count(*) FILTER (WHERE kind = 'quote' AND outcome = 'no_name'),
                                 'already', count(*) FILTER (WHERE kind = 'quote' AND outcome = 'already')))
  INTO v_result FROM classified;
  PERFORM security_audit.log_named_event(p_org, 'DOCUMENT_CUSTOMER_LINK_BACKFILL', 'document_customer_links', p_org::TEXT,
    v_result || jsonb_build_object('actor', 'release 153', 'reason', 'release 153 backfill (unverified links only)'));
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public._document_customer_link_backfill(UUID) FROM PUBLIC, anon, authenticated, service_role;

DO $p153_backfill$
DECLARE
  o RECORD;
BEGIN
  FOR o IN SELECT id FROM public.organizations ORDER BY id LOOP
    RAISE NOTICE '153 backfill %: %', o.id, public._document_customer_link_backfill(o.id);
  END LOOP;
END
$p153_backfill$;
COMMIT;
