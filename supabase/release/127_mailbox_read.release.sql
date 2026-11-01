-- 127_mailbox_read.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 127: Tolra reads the company's own Microsoft 365 inbox through the one-click delegated connection (C1; Rhys and ChatGPT approved).
-- Needs 031 (inbound_emails, its UNIQUE (organization_id, graph_message_id), record_inbound_email), 084 and 107 (integration_connections
-- with provider 'microsoft'), 033 (require_admin_mfa_guard, support_readonly_guard), 036 (has_org_role, current_user_organization_id).
-- REPLACES NO EXISTING FUNCTION AND CHANGES NO EXISTING TABLE. Safe to run again.
--
-- WHAT IT ADDS
--   a. public.integration_mailbox_sync: one row per company, for its Microsoft 365 connection's inbox reading. No secret here.
--        mailbox_id    the connected mailbox's object id (= integration_connections.tenant_id); the cursor belongs to this mailbox only
--        mail_read     the company's sign-in includes delegated Mail.Read (read only: never Mail.ReadWrite). FALSE for a connection
--                      made before 127 (it only allowed Mail.Send): the card asks for "Reconnect to allow reading mail"; sending is
--                      not affected.
--        checkpoint, next_link   where the inbox check is up to (the newest received time stored; Microsoft's paging link)
--        last_sync_at, last_attempt_at, last_error, error_count   the last good check, the last try, and why it failed (a fixed code,
--                      never Microsoft's text, a token or a message; the app turns the code into plain words)
--        claimed_at    when a check last started (mailbox_sync_claim): the throttle, so open tabs, users and the server never check
--                      one company more often than once a minimum interval (the app asks for 90 seconds)
--      RLS on, no policy, no grant to anon or authenticated: only these functions read or write it.
--   b. Functions (SECURITY DEFINER, search_path pinned):
--      server only (service role): mailbox_sync_connected (after Connect stores the sign-in: whether Mail.Read was granted; the same
--        mailbox keeps its cursor, so a reconnect resumes, a different mailbox starts afresh), mailbox_sync_due (the connections to
--        check: connected, Mail.Read, the same mailbox; all, or one company), mailbox_sync_result (a check's outcome for ONE company),
--        mailbox_record_inbound (one message for ONE company, as 031's record_inbound_email: the same UNIQUE, ON CONFLICT DO NOTHING,
--        and the same new RFQ; refused unless that company's connection may read mail).
--        mailbox_sync_claim (start a check for ONE company: at most one per minimum interval, whatever the number of callers; the row
--        lock makes two callers at once give one 'claimed' and one 'recent').
--        mailbox_suggest_email_link (125's PO capture on a server check: one SUGGESTION for ONE company's new e-mail, as 125's
--        link_inbound_email with p_how 'suggested'; it can never link. Needs 125's columns when called: the app calls it only when 125
--        is applied).
--      signed in: mailbox_sync_status (the caller's own company's reading status, admins only; never the cursor).
-- ISOLATION: every server function takes the company and touches only that company's rows; mailbox_record_inbound writes only the
-- organization_id it is given, and only when that company's own connection is connected with Mail.Read.
-- GUARD (section 1). SELF-CHECK (section 5). Verify: supabase/verify/mailbox_read_127.sql (every row TRUE).
-- Rollback: supabase/release/127_mailbox_read.rollback.sql (Rhys's approval; inbox reading stops, the stored e-mails and RFQs stay).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists, and a function of 127's name has 127's body (a second run) or does not exist.
DO $$
BEGIN
  IF to_regclass('public.inbound_emails') IS NULL OR to_regclass('public.rfqs') IS NULL
     OR to_regprocedure('public.record_inbound_email(text,text,text,text,text,timestamp with time zone,text,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.inbound_emails'::regclass AND k.contype = 'u'
                    AND pg_get_constraintdef(k.oid) = 'UNIQUE (organization_id, graph_message_id)') THEN
    RAISE EXCEPTION '127: inbound mail (031) is missing';
  END IF;
  IF to_regclass('public.integration_connections') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = 'integration_connections_provider_check'
                    AND k.conrelid = 'public.integration_connections'::regclass AND pg_get_constraintdef(k.oid) LIKE '%microsoft%') THEN
    RAISE EXCEPTION '127: Microsoft 365 connections (084, 107) are missing';
  END IF;
  IF to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL OR to_regprocedure('public.support_readonly_guard()') IS NULL THEN
    RAISE EXCEPTION '127: a helper it needs (033, 036) is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
             JOIN (VALUES ('public.mailbox_sync_connected(uuid,text,boolean)', '157bc48f606d2d36a18cdcef5da067a5'),
                          ('public.mailbox_sync_due(uuid)', 'f166b13165a5e3f45a8ee96ed9563ab2'),
                          ('public.mailbox_sync_result(uuid,text,text,timestamp with time zone)', 'bc91232dd7936719831735c19703274c'),
                          ('public.mailbox_record_inbound(uuid,text,text,text,text,text,timestamp with time zone,text,text)', '4a7ede00d54804941fc17a291bde6b4c'),
                          ('public.mailbox_sync_status()', '2d190567cfe9f2bd8fa6c6d055b7df45'),
                          ('public.mailbox_sync_claim(uuid,integer)', 'a9985b00301c4579f1f6797205c21834'),
                          ('public.mailbox_suggest_email_link(uuid,uuid,text,uuid,text)', '2ad8ea7f269f532b082e3db31e58f7ed')) AS f(sig, body)
               ON p.oid = to_regprocedure(f.sig)
             WHERE md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> f.body) THEN
    RAISE EXCEPTION '127: a function 127 creates already exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The table.
CREATE TABLE IF NOT EXISTS public.integration_mailbox_sync (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL DEFAULT 'microsoft' CHECK (provider = 'microsoft'),
  mailbox_id      TEXT NOT NULL CHECK (length(mailbox_id) BETWEEN 1 AND 100 AND mailbox_id !~ '[[:cntrl:][:space:]]'),
  mail_read       BOOLEAN NOT NULL DEFAULT FALSE,
  checkpoint      TIMESTAMPTZ,
  next_link       TEXT CHECK (next_link IS NULL OR (next_link LIKE 'https://graph.microsoft.com/v1.0/%' AND length(next_link) <= 4000 AND next_link !~ '[[:cntrl:][:space:]]')),
  last_sync_at    TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT CHECK (last_error IS NULL OR last_error IN ('reconnect', 'consent', 'signin', 'busy', 'unavailable', 'store_failed')),
  error_count     INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  claimed_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.integration_mailbox_sync ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE public.integration_mailbox_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_mailbox_sync FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS support_read_only ON public.integration_mailbox_sync;
CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.integration_mailbox_sync FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.integration_mailbox_sync;
CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.integration_mailbox_sync FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. Server only (service role).
-- 3a. After Connect stored the sign-in (integration_store_connection): whether it includes Mail.Read. The company's connection must be
-- connected to this mailbox. The same mailbox keeps its cursor (a reconnect resumes where it was; messages already stored are skipped by
-- 031's UNIQUE); another mailbox starts afresh. Any earlier failure is cleared.
CREATE OR REPLACE FUNCTION public.mailbox_sync_connected(p_org UUID, p_mailbox_id TEXT, p_mail_read BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old TEXT;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.integration_connections c
                                  WHERE c.organization_id = p_org AND c.provider = 'microsoft' AND c.status = 'connected' AND c.tenant_id = p_mailbox_id) THEN
    RAISE EXCEPTION 'This company is not connected to that mailbox.' USING ERRCODE = 'P0002', HINT = 'not_connected';
  END IF;
  SELECT s.mailbox_id INTO v_old FROM public.integration_mailbox_sync s WHERE s.organization_id = p_org FOR UPDATE;
  INSERT INTO public.integration_mailbox_sync (organization_id, mailbox_id, mail_read, updated_at)
  VALUES (p_org, p_mailbox_id, coalesce(p_mail_read, FALSE), now())
  ON CONFLICT (organization_id) DO UPDATE
    SET mailbox_id = EXCLUDED.mailbox_id, mail_read = EXCLUDED.mail_read,
        checkpoint = CASE WHEN public.integration_mailbox_sync.mailbox_id = EXCLUDED.mailbox_id THEN public.integration_mailbox_sync.checkpoint END,
        next_link = CASE WHEN public.integration_mailbox_sync.mailbox_id = EXCLUDED.mailbox_id THEN public.integration_mailbox_sync.next_link END,
        last_error = NULL, error_count = 0, updated_at = now();
  RETURN jsonb_build_object('mail_read', coalesce(p_mail_read, FALSE), 'resumed', v_old IS NOT DISTINCT FROM p_mailbox_id AND v_old IS NOT NULL);
END
$$;
REVOKE ALL ON FUNCTION public.mailbox_sync_connected(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailbox_sync_connected(UUID, TEXT, BOOLEAN) TO service_role;

-- 3b. The connections whose inbox may be checked now: connected (not needs_reconnect, not disconnected), Mail.Read granted, the same
-- mailbox the cursor belongs to, an active company. p_org NULL: every one; else that company only (no row: it can't be read).
CREATE OR REPLACE FUNCTION public.mailbox_sync_due(p_org UUID DEFAULT NULL)
RETURNS TABLE (organization_id UUID, checkpoint TIMESTAMPTZ, next_link TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.organization_id, s.checkpoint, s.next_link
  FROM public.integration_mailbox_sync s
  JOIN public.integration_connections c ON c.organization_id = s.organization_id AND c.provider = 'microsoft'
  JOIN public.organizations o ON o.id = s.organization_id
  WHERE c.status = 'connected' AND s.mail_read AND c.tenant_id = s.mailbox_id AND o.status = 'active'
    AND (p_org IS NULL OR s.organization_id = p_org)
  ORDER BY s.last_attempt_at NULLS FIRST, s.organization_id
$$;
REVOKE ALL ON FUNCTION public.mailbox_sync_due(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailbox_sync_due(UUID) TO service_role;

-- 3c. One check's outcome, for ONE company. p_error NULL: it worked (last checked now, the failure cleared, the cursor moved on: the
-- paging link as given, the checkpoint never backwards). A code: it failed (the cursor stays, the count goes up); 'consent' (Microsoft
-- refused reading this mailbox) also clears mail_read, so the card asks to reconnect and the sign-in is renewed for sending only.
CREATE OR REPLACE FUNCTION public.mailbox_sync_result(p_org UUID, p_error TEXT, p_next_link TEXT, p_checkpoint TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_error IS NULL THEN
    UPDATE public.integration_mailbox_sync s
    SET last_sync_at = now(), last_attempt_at = now(), last_error = NULL, error_count = 0, next_link = p_next_link,
        checkpoint = GREATEST(s.checkpoint, p_checkpoint), updated_at = now()
    WHERE s.organization_id = p_org;
  ELSE
    UPDATE public.integration_mailbox_sync s
    SET last_attempt_at = now(), last_error = p_error, error_count = s.error_count + 1,
        mail_read = s.mail_read AND p_error <> 'consent', updated_at = now()
    WHERE s.organization_id = p_org;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.mailbox_sync_result(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailbox_sync_result(UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- 3d. One message for ONE company, read with that company's own sign-in: 031's record_inbound_email for the server (no signed-in admin
-- on a background check). Refused unless that company's connection is connected with Mail.Read. The same UNIQUE (organization_id,
-- graph_message_id) and ON CONFLICT DO NOTHING (a message read again is not stored again and makes no second RFQ); the RFQ's creator is
-- the admin who connected the mailbox. Returns { inserted, inbound_email_id, rfq_id } as 031 does.
CREATE OR REPLACE FUNCTION public.mailbox_record_inbound(p_org UUID, p_graph_message_id TEXT, p_internet_message_id TEXT, p_from_address TEXT,
                                                         p_from_name TEXT, p_subject TEXT, p_received_at TIMESTAMPTZ,
                                                         p_body_preview TEXT, p_body_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user    UUID;
  v_inbound UUID;
  v_rfq     UUID;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.mailbox_sync_due(p_org)) THEN
    RAISE EXCEPTION 'This company''s mailbox can''t be read.' USING ERRCODE = '42501', HINT = 'mailbox_not_readable';
  END IF;
  IF coalesce(p_graph_message_id, '') = '' OR p_received_at IS NULL THEN
    RAISE EXCEPTION 'message id and received time are required' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_user FROM public.integration_connections c JOIN auth.users u ON u.id = c.connected_by
  WHERE c.organization_id = p_org AND c.provider = 'microsoft';

  INSERT INTO public.inbound_emails (organization_id, graph_message_id, internet_message_id, from_address, from_name,
                                     subject, received_at, body_preview, body_text)
  VALUES (p_org, p_graph_message_id, p_internet_message_id, p_from_address, p_from_name, p_subject, p_received_at,
          p_body_preview, p_body_text)
  ON CONFLICT (organization_id, graph_message_id) DO NOTHING
  RETURNING id INTO v_inbound;
  IF v_inbound IS NULL THEN
    RETURN jsonb_build_object('inserted', FALSE, 'inbound_email_id', NULL, 'rfq_id', NULL);
  END IF;

  INSERT INTO public.rfqs (organization_id, customer, email, description, status, created_by, updated_by)
  VALUES (p_org,
          coalesce(nullif(trim(p_from_name), ''), nullif(trim(p_from_address), ''), 'Unknown sender'),
          nullif(trim(p_from_address), ''),
          left(trim(concat_ws(E'\n', nullif(trim(p_subject), ''), nullif(trim(p_body_preview), ''))), 2000),
          'new', v_user, v_user)
  RETURNING id INTO v_rfq;
  UPDATE public.inbound_emails SET rfq_id = v_rfq WHERE id = v_inbound;
  RETURN jsonb_build_object('inserted', TRUE, 'inbound_email_id', v_inbound, 'rfq_id', v_rfq);
END
$$;
REVOKE ALL ON FUNCTION public.mailbox_record_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailbox_record_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) TO service_role;

-- 3e. Start one check for ONE company (the throttle). 'claimed' with the cursor when its mailbox may be read and no check started in the
-- last p_min_seconds; 'recent' (with the last good check and failure code) when one did; 'not_readable' when it can't be read (not
-- connected, needs reconnect, no Mail.Read, another mailbox, an inactive company). The UPDATE takes the row lock and re-checks claimed_at
-- after a concurrent claim commits, so two callers at once (two tabs, two office users, the server's pass) start one check, not two.
-- A check that never finishes holds nothing: the next claim after the interval starts again (031's UNIQUE skips what was stored).
CREATE OR REPLACE FUNCTION public.mailbox_sync_claim(p_org UUID, p_min_seconds INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.integration_mailbox_sync%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_min_seconds IS NULL OR p_min_seconds < 0 OR p_min_seconds > 3600 THEN
    RAISE EXCEPTION 'a company and an interval of 0 to 3600 seconds are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.mailbox_sync_due(p_org)) THEN
    RETURN jsonb_build_object('state', 'not_readable');
  END IF;
  UPDATE public.integration_mailbox_sync s SET claimed_at = now()
  WHERE s.organization_id = p_org AND (s.claimed_at IS NULL OR s.claimed_at <= now() - make_interval(secs => p_min_seconds))
  RETURNING s.* INTO v_row;
  IF NOT FOUND THEN
    SELECT s.* INTO v_row FROM public.integration_mailbox_sync s WHERE s.organization_id = p_org;
    RETURN jsonb_build_object('state', 'recent', 'last_sync_at', v_row.last_sync_at, 'last_error', v_row.last_error);
  END IF;
  RETURN jsonb_build_object('state', 'claimed', 'checkpoint', v_row.checkpoint, 'next_link', v_row.next_link);
END
$$;
REVOKE ALL ON FUNCTION public.mailbox_sync_claim(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailbox_sync_claim(UUID, INTEGER) TO service_role;

-- 3f. 125's PO capture for the server's inbox check (the browser check, the Check inbox button and the background pass): ONE suggestion
-- for ONE company's newly stored e-mail, as 125's link_inbound_email does with p_how 'suggested' (no signed-in admin on a server check).
-- SUGGEST ONLY: there is no way to link here (no p_how; never 'manual' or 'auto'): linked_quote_id, linked_purchase_order_id and
-- linked_po_number are never written and no quote's customer PO is set; a person's Link click (125) stays the only way to link.
-- The e-mail and the quote or purchase order must both be p_org's (another company's reads "not found"); refused unless that company's
-- connection may read mail. A person's link stands, a candidate already listed or a full list (10) adds nothing, as in 125.
CREATE OR REPLACE FUNCTION public.mailbox_suggest_email_link(p_org UUID, p_email UUID, p_kind TEXT, p_target UUID, p_po TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_po    TEXT := nullif(btrim(coalesce(p_po, '')), '');
  v_mail  public.inbound_emails%ROWTYPE;
  v_ref   TEXT;
  v_entry JSONB;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.mailbox_sync_due(p_org)) THEN
    RAISE EXCEPTION 'This company''s mailbox can''t be read.' USING ERRCODE = '42501', HINT = 'mailbox_not_readable';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('quote', 'purchase_order') OR p_email IS NULL OR p_target IS NULL THEN
    RAISE EXCEPTION 'Invalid e-mail link' USING ERRCODE = '22023';
  END IF;
  IF v_po IS NOT NULL AND char_length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_mail FROM public.inbound_emails e WHERE e.id = p_email AND e.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'E-mail not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_kind = 'quote' THEN
    SELECT q.quote_ref INTO v_ref FROM public.quotes q WHERE q.id = p_target AND q.organization_id = p_org;
  ELSE
    SELECT coalesce(o.po_ref, o.po_number, '') INTO v_ref FROM public.purchase_orders o WHERE o.id = p_target AND o.organization_id = p_org;
  END IF;
  IF v_ref IS NULL THEN
    RAISE EXCEPTION '% not found', CASE p_kind WHEN 'quote' THEN 'Quote' ELSE 'Purchase order' END USING ERRCODE = 'P0002';
  END IF;

  IF v_mail.link_status IN ('manual', 'auto')
     OR v_mail.link_suggestions @> jsonb_build_array(jsonb_build_object('kind', p_kind, 'id', p_target, 'po', v_po))
     OR jsonb_array_length(v_mail.link_suggestions) >= 10 THEN
    RETURN jsonb_build_object('email', p_email, 'changed', FALSE, 'link_status', v_mail.link_status);
  END IF;
  v_entry := jsonb_build_object('kind', p_kind, 'id', p_target, 'ref', v_ref, 'po', v_po);
  UPDATE public.inbound_emails SET link_suggestions = link_suggestions || jsonb_build_array(v_entry), link_status = 'suggested'
  WHERE id = p_email AND organization_id = p_org;
  PERFORM security_audit.log_named_event(p_org, 'SUGGEST_EMAIL_LINK', 'inbound_emails', p_email::TEXT,
    jsonb_build_object('kind', p_kind, 'target_id', p_target, 'target_ref', v_ref, 'po_number', v_po, 'via', 'inbox_check'));
  RETURN jsonb_build_object('email', p_email, 'changed', TRUE, 'link_status', 'suggested', 'kind', p_kind, 'target', p_target, 'ref', v_ref);
END
$$;
REVOKE ALL ON FUNCTION public.mailbox_suggest_email_link(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailbox_suggest_email_link(UUID, UUID, TEXT, UUID, TEXT) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 4. Signed in: the caller's own company's inbox reading, for the Microsoft 365 card (admins only). Never the cursor or the mailbox id.
CREATE OR REPLACE FUNCTION public.mailbox_sync_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_row public.integration_mailbox_sync%ROWTYPE;
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can see the mailbox status.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.integration_mailbox_sync s WHERE s.organization_id = v_org;
  RETURN jsonb_build_object('mail_read', coalesce(v_row.mail_read, FALSE), 'last_sync_at', v_row.last_sync_at,
                            'last_error', v_row.last_error, 'error_count', coalesce(v_row.error_count, 0));
END
$$;
REVOKE ALL ON FUNCTION public.mailbox_sync_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mailbox_sync_status() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check: the table is closed to the API; each server function is the service role's only; the status function is signed-in only.
DO $$
DECLARE
  v_sig TEXT;
BEGIN
  IF has_table_privilege('authenticated', 'public.integration_mailbox_sync', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.integration_mailbox_sync', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.integration_mailbox_sync'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'integration_mailbox_sync') THEN
    RAISE EXCEPTION '127 self-check: integration_mailbox_sync is reachable through the API';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['public.mailbox_sync_connected(uuid,text,boolean)', 'public.mailbox_sync_due(uuid)',
                               'public.mailbox_sync_result(uuid,text,text,timestamp with time zone)',
                               'public.mailbox_record_inbound(uuid,text,text,text,text,text,timestamp with time zone,text,text)',
                               'public.mailbox_sync_claim(uuid,integer)', 'public.mailbox_suggest_email_link(uuid,uuid,text,uuid,text)'] LOOP
    IF has_function_privilege('authenticated', v_sig, 'EXECUTE') OR has_function_privilege('anon', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '127 self-check: % is not the service role''s only', v_sig;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.mailbox_sync_status()', 'EXECUTE') OR has_function_privilege('anon', 'public.mailbox_sync_status()', 'EXECUTE') THEN
    RAISE EXCEPTION '127 self-check: mailbox_sync_status is not signed-in only';
  END IF;
END
$$;

COMMIT;
