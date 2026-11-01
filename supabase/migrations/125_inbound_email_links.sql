-- =====================================================================================================
-- 125: an inbox e-mail can be linked to the quote whose customer PO it carries, or to the purchase order a supplier's e-mail is about
-- (Rhys confirmed, 1 Nov; ChatGPT's conditions, 1 Nov: SUGGEST ONLY). Needs 031 (inbound_emails), 006 (enforce_same_org_parent),
-- 033 (assert_privileged_aal), 012 (section_allowed), 035 (security_audit.log_named_event) and 036 (_session_membership). Works with or
-- without 123 (quotes.customer_po, set_quote_customer_po): each is looked up when it is needed, never assumed. Touches no other
-- migration's objects: no existing function, policy, grant or row changes.
--
-- WHAT IT ADDS.
--   a. public.inbound_emails gains five columns, all empty on every existing row:
--        linked_quote_id / linked_purchase_order_id: the record the e-mail is linked to (nullable foreign keys, ON DELETE SET NULL; at
--          most one of the two), each with the same-company trigger every other business link has (enforce_same_org_parent, 015's form);
--        link_status: NULL, 'suggested', 'manual' or 'auto'. Only 'suggested' (the inbox check found candidates) and 'manual' (a person
--          clicked Link) are written now. 'auto' is reserved for a later, separately approved migration: link_inbound_email refuses it;
--        linked_po_number: the PO number the person linked with (at most 100 characters);
--        link_suggestions: the candidates the inbox check found (a JSON array, at most 10: kind, id, ref, po), for the person to
--          choose from. A suggestion never links anything and never changes the quote or the order.
--   b. public.link_inbound_email(p_email, p_kind, p_target, p_po, p_how): SECURITY DEFINER, pinned search_path, signed-in only, the
--      caller's company only (an e-mail or a target of another company reads "not found"), second step first (assert_privileged_aal),
--      support sessions refused. p_kind 'quote' or 'purchase_order'; p_how:
--        'suggested' (admin only: the inbox check runs as the admin): adds one candidate to link_suggestions; nothing else changes. An
--          e-mail a person has already linked is left alone;
--        'manual' (admin or office with that section, Quotes or Purchase orders): links the e-mail. For a quote with a PO number, when
--          123 is applied and the quote has no customer PO yet, the PO is written through 123's own set_quote_customer_po (its checks,
--          its SET_CUSTOMER_PO audit event with the previous value and who); a quote that already has a PO keeps it (never overwritten
--          here). Nothing else downstream is made or changed (no order, job or invoice).
--      Every write is audited in the same transaction: SUGGEST_EMAIL_LINK or LINK_INBOUND_EMAIL (ids, refs, PO numbers, the previous
--      link; no e-mail text).
-- RLS AND GRANTS: unchanged. inbound_emails is still readable by the company's admin and office users only (031) and has no INSERT,
-- UPDATE or DELETE grant: only record_inbound_email (031) and link_inbound_email write it. Its admin_mfa and support_read_only
-- triggers (033, 036) still apply.
-- GUARD (section 1). Safe to run again. SELF-CHECK (section 5). Verify: supabase/verify/inbound_email_links_125.sql (every row TRUE).
-- Rollback: supabase/release/125_inbound_email_links.rollback.sql (drops the function, the two triggers and the five columns: every link
-- and suggestion is lost; audit rows stay; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists, and link_inbound_email is absent or already this file's.
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  IF to_regclass('public.inbound_emails') IS NULL OR to_regclass('public.quotes') IS NULL OR to_regclass('public.purchase_orders') IS NULL
     OR to_regprocedure('public.enforce_same_org_parent()') IS NULL OR to_regprocedure('public.assert_privileged_aal()') IS NULL
     OR to_regprocedure('public.section_allowed(text)') IS NULL OR to_regprocedure('public._session_membership()') IS NULL
     OR to_regprocedure('security_audit.log_named_event(uuid, text, text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION '125: a table or function it needs (031, 006, 012, 033, 035, 036) is missing';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.link_inbound_email(uuid, text, uuid, text, text)') INTO v_md5;
  IF v_md5 IS NOT NULL AND v_md5 <> '2f7a1169a7087cf17a3f872a8f08a088' THEN
    RAISE EXCEPTION '125: public.link_inbound_email exists with another body (md5 %); stop and compare it first', v_md5;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The columns, their rules and indexes. Every existing row keeps its values; the new columns start empty.
ALTER TABLE public.inbound_emails ADD COLUMN IF NOT EXISTS linked_quote_id UUID REFERENCES public.quotes(id) ON DELETE SET NULL;
ALTER TABLE public.inbound_emails ADD COLUMN IF NOT EXISTS linked_purchase_order_id UUID REFERENCES public.purchase_orders(id) ON DELETE SET NULL;
ALTER TABLE public.inbound_emails ADD COLUMN IF NOT EXISTS link_status TEXT;
ALTER TABLE public.inbound_emails ADD COLUMN IF NOT EXISTS linked_po_number TEXT;
ALTER TABLE public.inbound_emails ADD COLUMN IF NOT EXISTS link_suggestions JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_link_status_check;
ALTER TABLE public.inbound_emails ADD CONSTRAINT inbound_emails_link_status_check
  CHECK (link_status IS NULL OR link_status IN ('suggested', 'manual', 'auto'));
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_one_link_check;
ALTER TABLE public.inbound_emails ADD CONSTRAINT inbound_emails_one_link_check
  CHECK (linked_quote_id IS NULL OR linked_purchase_order_id IS NULL);
-- A link (quote or order) is only ever made by a person (or, later, an approved automatic match), never by a suggestion.
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_linked_by_check;
ALTER TABLE public.inbound_emails ADD CONSTRAINT inbound_emails_linked_by_check
  CHECK ((linked_quote_id IS NULL AND linked_purchase_order_id IS NULL) OR link_status IN ('manual', 'auto'));
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_linked_po_check;
ALTER TABLE public.inbound_emails ADD CONSTRAINT inbound_emails_linked_po_check
  CHECK (linked_po_number IS NULL OR (char_length(linked_po_number) BETWEEN 1 AND 100 AND linked_po_number = btrim(linked_po_number)));
ALTER TABLE public.inbound_emails DROP CONSTRAINT IF EXISTS inbound_emails_link_suggestions_check;
ALTER TABLE public.inbound_emails ADD CONSTRAINT inbound_emails_link_suggestions_check
  CHECK (jsonb_typeof(link_suggestions) = 'array' AND jsonb_array_length(link_suggestions) <= 10);

CREATE INDEX IF NOT EXISTS idx_inbound_emails_linked_quote ON public.inbound_emails (linked_quote_id) WHERE linked_quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_emails_linked_po ON public.inbound_emails (linked_purchase_order_id) WHERE linked_purchase_order_id IS NOT NULL;

-- The same-company rule on both links (015's form: fires only when the link or the organisation changes).
DROP TRIGGER IF EXISTS zz_same_org_linked_quote_id ON public.inbound_emails;
CREATE TRIGGER zz_same_org_linked_quote_id BEFORE INSERT OR UPDATE OF linked_quote_id, organization_id ON public.inbound_emails
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('quotes', 'linked_quote_id');
DROP TRIGGER IF EXISTS zz_same_org_linked_purchase_order_id ON public.inbound_emails;
CREATE TRIGGER zz_same_org_linked_purchase_order_id BEFORE INSERT OR UPDATE OF linked_purchase_order_id, organization_id ON public.inbound_emails
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('purchase_orders', 'linked_purchase_order_id');

-- -----------------------------------------------------------------------------------------------------
-- 3. link_inbound_email: a suggestion from the inbox check, or a person's Link click.
CREATE OR REPLACE FUNCTION public.link_inbound_email(p_email UUID, p_kind TEXT, p_target UUID, p_po TEXT DEFAULT NULL, p_how TEXT DEFAULT 'manual')
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_user     UUID := auth.uid();
  v_how      TEXT := coalesce(p_how, 'manual');
  v_po       TEXT := nullif(btrim(coalesce(p_po, '')), '');
  v_mail     public.inbound_emails%ROWTYPE;
  v_ref      TEXT;
  v_entry    JSONB;
  v_old_po   TEXT;
  v_po_state TEXT := 'none';
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL
     OR NOT public.has_org_role(CASE WHEN v_how = 'suggested' THEN ARRAY['admin'] ELSE ARRAY['admin', 'office'] END) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF coalesce((SELECT s.is_support FROM public._session_membership() s LIMIT 1), FALSE) THEN
    RAISE EXCEPTION 'Support access can''t link e-mails.' USING ERRCODE = '42501', HINT = 'support_refused';
  END IF;
  IF v_how = 'auto' THEN
    RAISE EXCEPTION 'Automatic linking is not switched on.' USING ERRCODE = '22023', HINT = 'auto_link_off';
  END IF;
  IF v_how NOT IN ('suggested', 'manual') OR p_kind IS NULL OR p_kind NOT IN ('quote', 'purchase_order') OR p_email IS NULL OR p_target IS NULL THEN
    RAISE EXCEPTION 'Invalid e-mail link' USING ERRCODE = '22023';
  END IF;
  IF v_po IS NOT NULL AND char_length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;
  IF NOT public.section_allowed(CASE p_kind WHEN 'quote' THEN 'quotes' ELSE 'purchase-orders' END) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_mail FROM public.inbound_emails e WHERE e.id = p_email AND e.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'E-mail not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_kind = 'quote' THEN
    SELECT q.quote_ref INTO v_ref FROM public.quotes q WHERE q.id = p_target AND q.organization_id = v_org;
  ELSE
    SELECT coalesce(o.po_ref, o.po_number, '') INTO v_ref FROM public.purchase_orders o WHERE o.id = p_target AND o.organization_id = v_org;
  END IF;
  IF v_ref IS NULL THEN
    RAISE EXCEPTION '% not found', CASE p_kind WHEN 'quote' THEN 'Quote' ELSE 'Purchase order' END USING ERRCODE = 'P0002';
  END IF;

  IF v_how = 'suggested' THEN
    -- A person's link stands; a candidate already listed, or a full list (10), adds nothing.
    IF v_mail.link_status IN ('manual', 'auto')
       OR v_mail.link_suggestions @> jsonb_build_array(jsonb_build_object('kind', p_kind, 'id', p_target, 'po', v_po))
       OR jsonb_array_length(v_mail.link_suggestions) >= 10 THEN
      RETURN jsonb_build_object('email', p_email, 'changed', FALSE, 'link_status', v_mail.link_status);
    END IF;
    v_entry := jsonb_build_object('kind', p_kind, 'id', p_target, 'ref', v_ref, 'po', v_po);
    UPDATE public.inbound_emails SET link_suggestions = link_suggestions || jsonb_build_array(v_entry), link_status = 'suggested'
    WHERE id = p_email;
    PERFORM security_audit.log_named_event(v_org, 'SUGGEST_EMAIL_LINK', 'inbound_emails', p_email::TEXT,
      jsonb_build_object('kind', p_kind, 'target_id', p_target, 'target_ref', v_ref, 'po_number', v_po));
    RETURN jsonb_build_object('email', p_email, 'changed', TRUE, 'link_status', 'suggested', 'kind', p_kind, 'target', p_target, 'ref', v_ref);
  END IF;

  -- A person's Link click. The same link again changes nothing.
  IF v_mail.link_status = 'manual' AND v_mail.linked_po_number IS NOT DISTINCT FROM v_po
     AND ((p_kind = 'quote' AND v_mail.linked_quote_id = p_target) OR (p_kind = 'purchase_order' AND v_mail.linked_purchase_order_id = p_target)) THEN
    RETURN jsonb_build_object('email', p_email, 'changed', FALSE, 'link_status', 'manual', 'kind', p_kind, 'target', p_target, 'ref', v_ref, 'po_state', 'unchanged');
  END IF;

  -- The customer's PO goes onto the quote through 123's own path, only when 123 is applied and the quote has none yet.
  IF p_kind = 'quote' AND v_po IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quotes' AND column_name = 'customer_po')
       OR to_regprocedure('public.set_quote_customer_po(uuid, text)') IS NULL THEN
      v_po_state := 'no_quote_po_yet';
    ELSE
      EXECUTE 'SELECT customer_po FROM public.quotes WHERE id = $1' INTO v_old_po USING p_target;
      IF v_old_po IS NULL THEN
        EXECUTE 'SELECT public.set_quote_customer_po($1, $2)' USING p_target, v_po;
        v_po_state := 'written';
      -- The same PO written another way (lib/po-capture normalisePo: no case, spaces, _ . / -, or leading PO before a digit).
      ELSIF regexp_replace(upper(regexp_replace(v_old_po, '[\s_./-]', '', 'g')), '^PO([0-9])', '\1')
            = regexp_replace(upper(regexp_replace(v_po, '[\s_./-]', '', 'g')), '^PO([0-9])', '\1') THEN
        v_po_state := 'already_set';
      ELSE
        v_po_state := 'kept_existing';
      END IF;
    END IF;
  END IF;

  UPDATE public.inbound_emails
  SET linked_quote_id = CASE WHEN p_kind = 'quote' THEN p_target END,
      linked_purchase_order_id = CASE WHEN p_kind = 'purchase_order' THEN p_target END,
      link_status = 'manual',
      linked_po_number = v_po
  WHERE id = p_email;
  PERFORM security_audit.log_named_event(v_org, 'LINK_INBOUND_EMAIL', 'inbound_emails', p_email::TEXT, jsonb_build_object(
    'kind', p_kind, 'target_id', p_target, 'target_ref', v_ref, 'po_number', v_po, 'po_state', v_po_state, 'previous_customer_po', v_old_po,
    'previous_link_status', v_mail.link_status, 'previous_quote_id', v_mail.linked_quote_id,
    'previous_purchase_order_id', v_mail.linked_purchase_order_id, 'previous_po_number', v_mail.linked_po_number));
  RETURN jsonb_build_object('email', p_email, 'changed', TRUE, 'link_status', 'manual', 'kind', p_kind, 'target', p_target, 'ref', v_ref,
                            'po_state', v_po_state);
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 4. Signed-in only (031's pattern).
REVOKE ALL ON FUNCTION public.link_inbound_email(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_inbound_email(UUID, TEXT, UUID, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check before COMMIT (the same checks as supabase/verify/inbound_email_links_125.sql).
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inbound_emails'
        AND column_name IN ('linked_quote_id', 'linked_purchase_order_id', 'link_status', 'linked_po_number', 'link_suggestions')) <> 5 THEN
    RAISE EXCEPTION '125: inbound_emails is missing a link column';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.inbound_emails'::regclass AND conname IN ('inbound_emails_link_status_check',
        'inbound_emails_one_link_check', 'inbound_emails_linked_by_check', 'inbound_emails_linked_po_check', 'inbound_emails_link_suggestions_check')) <> 5
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.inbound_emails'::regclass AND contype = 'f' AND confdeltype = 'n'
           AND confrelid IN ('public.quotes'::regclass, 'public.purchase_orders'::regclass)) <> 2 THEN
    RAISE EXCEPTION '125: a link rule or foreign key is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.inbound_emails'::regclass AND NOT tgisinternal AND tgenabled = 'O'
        AND tgname IN ('zz_same_org_linked_quote_id', 'zz_same_org_linked_purchase_order_id')
        AND tgfoid = to_regprocedure('public.enforce_same_org_parent()')) <> 2 THEN
    RAISE EXCEPTION '125: a same-company trigger is missing';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '2f7a1169a7087cf17a3f872a8f08a088' OR NOT p.prosecdef
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
             OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
             OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.link_inbound_email(uuid, text, uuid, text, text)')) IS NOT FALSE THEN
    RAISE EXCEPTION '125: link_inbound_email is not this file''s, definer, pinned and signed-in only';
  END IF;
END
$$;
