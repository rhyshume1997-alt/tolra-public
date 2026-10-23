-- 078 rollback: ONLY with Rhys's approval. Puts back 075's check trigger function and its ip CHECK, 058's next_doc_number and 034's
-- issue_credit_note byte for byte, and removes what 078 added. Refuses (forward-fix instead) once any on_site / off_site check has lost
-- its address (purged after 30 days, or by an admin): 075's rule (an address on every such row) can't be met again. While every address
-- is still kept, they are put back on their check rows, with the immutability and audit triggers off for that one UPDATE in this
-- transaction only (so no address is copied into the audit log by the rollback either); one named event per company records the count.
-- Credit notes issued as CRD-#### keep their numbers (credit_ref never changes); the 'CRD' counter row stays (data, unused by 058's
-- function); new credit notes are CN-#### again, carrying on the CN counter. Run the whole text as one transaction, then
-- `notify pgrst, 'reload schema';` and the release preflight (marker 078 "not applied"). Roll 078 back BEFORE 075 (075's rollback drops
-- attendance_event_networks, which 078's table references).
BEGIN;
DO $$
DECLARE
  v TEXT;
BEGIN
  -- Only 078's functions (or the ones it replaced, on a second run) are replaced; anything else is looked at first.
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.attendance_events_network()');
  IF v IS DISTINCT FROM 'b21a4903c9c33c644e39b5a032f8fd05' AND v IS DISTINCT FROM '7a351480f264088cefa94d07b120bc6a' THEN
    RAISE EXCEPTION '078 rollback: public.attendance_events_network() is neither 078''s nor 075''s; stop and compare it first';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.next_doc_number(text)');
  IF v IS DISTINCT FROM 'c5af802da68d4236a36db71098036acf' AND v IS DISTINCT FROM 'aed436480167bf7a88708d6bdc6f1f16' THEN
    RAISE EXCEPTION '078 rollback: public.next_doc_number(text) is neither 078''s nor 058''s; stop and compare it first';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.issue_credit_note(uuid)');
  IF v IS DISTINCT FROM '5619c98bdff1ceff9c17576e5b88bbad' AND v IS DISTINCT FROM '6d1965e58b3cb2db5338362af80250de' THEN
    RAISE EXCEPTION '078 rollback: public.issue_credit_note(uuid) is neither 078''s nor 034''s; stop and compare it first';
  END IF;
  IF to_regclass('public.attendance_event_network_ips') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.attendance_event_networks n
               WHERE n.status IN ('on_site', 'off_site') AND n.ip IS NULL
                 AND NOT EXISTS (SELECT 1 FROM public.attendance_event_network_ips i WHERE i.event_id = n.event_id)) THEN
      RAISE EXCEPTION '078 rollback: some clock checks no longer have their address (deleted after 30 days or by an admin); 075''s rule can''t be restored: do not roll back, forward-fix instead';
    END IF;
  END IF;
END
$$;

-- Lock order (as 078 and every clock action): the audit-chain lock of each company whose addresses go back (one named event each)
-- BEFORE this transaction locks attendance_event_networks; a company that appears later is locked without waiting (below).
DO $$
DECLARE
  r RECORD;
BEGIN
  IF to_regclass('public.attendance_event_network_ips') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN EXECUTE 'SELECT DISTINCT i.organization_id FROM public.attendance_event_network_ips i ORDER BY i.organization_id' LOOP
    PERFORM public.time_company_lock(r.organization_id);
  END LOOP;
END
$$;

-- 075's check trigger function, verbatim (supabase/migrations/075_site_network_and_sync_rejections.sql).
-- ---- 4. The check, after each clock action is recorded ----------------------------------------------------------------------------
-- Runs inside record_attendance_event (050), which already holds the company's lock and the person's lock. With the switch off, or a
-- person who is not on-site-only, it returns at once and writes nothing. It never refuses: any error is swallowed (the clock action is
-- kept, without a check row). Internal.
CREATE OR REPLACE FUNCTION public.attendance_events_network()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_mode   TEXT;
  v_ip     INET;
  v_status TEXT;
BEGIN
  IF NEW.source <> 'clock' THEN
    RETURN NULL;
  END IF;
  SELECT s.site_network_check INTO v_mode FROM public.site_network_settings s WHERE s.organization_id = NEW.organization_id;
  IF coalesce(v_mode, 'off') <> 'flag' THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.site_network_members m
                   WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.user_id AND m.on_site_only) THEN
      RETURN NULL;
    END IF;
    IF NEW.device_at IS NOT NULL AND NEW.received_at - NEW.device_at > INTERVAL '2 minutes' THEN
      v_status := 'synced_later';
    ELSE
      v_ip := public.request_client_ip();
      v_status := CASE WHEN v_ip IS NULL THEN 'unknown'
                       WHEN public.site_network_matches(NEW.organization_id, v_ip) THEN 'on_site'
                       ELSE 'off_site' END;
    END IF;
    INSERT INTO public.attendance_event_networks (event_id, organization_id, user_id, status, ip, off_site_network)
    VALUES (NEW.id, NEW.organization_id, NEW.user_id, v_status, CASE WHEN v_status IN ('on_site', 'off_site') THEN v_ip END, v_status = 'off_site');
  EXCEPTION WHEN OTHERS THEN
    -- Phase 1 never refuses a clock action. The action stays recorded; it just has no check row.
    RETURN NULL;
  END;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.attendance_events_network() FROM PUBLIC, anon, authenticated;

-- The kept addresses back on their check rows (none on a second run), then 075's CHECK.
ALTER TABLE public.attendance_event_networks DROP CONSTRAINT IF EXISTS attendance_event_networks_ip;
DO $$
DECLARE
  r RECORD;
BEGIN
  IF to_regclass('public.attendance_event_network_ips') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.attendance_event_network_ips) THEN
    RETURN;
  END IF;
  FOR r IN EXECUTE 'SELECT DISTINCT i.organization_id FROM public.attendance_event_network_ips i ORDER BY i.organization_id' LOOP
    IF NOT pg_try_advisory_xact_lock(hashtext(coalesce(r.organization_id::TEXT, ''))) THEN
      RAISE EXCEPTION '078 rollback: a clock action of company % is running; nothing was changed, run the rollback again', r.organization_id
        USING ERRCODE = '55P03';
    END IF;
  END LOOP;
  FOR r IN EXECUTE 'SELECT i.organization_id, count(*) AS n FROM public.attendance_event_network_ips i GROUP BY i.organization_id ORDER BY i.organization_id' LOOP
    PERFORM security_audit.log_named_event(r.organization_id, 'SITE_NETWORK_IPS_RESTORED', 'attendance_event_networks', NULL,
      jsonb_build_object('restored', r.n, 'rollback', '078'));
  END LOOP;
  ALTER TABLE public.attendance_event_networks DISABLE TRIGGER attendance_event_networks_immutable;
  ALTER TABLE public.attendance_event_networks DISABLE TRIGGER audit_attendance_event_networks_changes;
  EXECUTE 'UPDATE public.attendance_event_networks n SET ip = i.ip FROM public.attendance_event_network_ips i WHERE i.event_id = n.event_id AND n.ip IS NULL';
  ALTER TABLE public.attendance_event_networks ENABLE TRIGGER audit_attendance_event_networks_changes;
  ALTER TABLE public.attendance_event_networks ENABLE TRIGGER attendance_event_networks_immutable;
END
$$;
ALTER TABLE public.attendance_event_networks ADD CONSTRAINT attendance_event_networks_ip CHECK ((ip IS NOT NULL) = (status IN ('on_site', 'off_site')));

DROP FUNCTION IF EXISTS public.purge_site_network_ips(boolean);
DROP FUNCTION IF EXISTS public.site_network_ip_purge(uuid, integer);
DROP FUNCTION IF EXISTS public.seed_credit_note_number(uuid, text);
DROP TABLE IF EXISTS public.attendance_event_network_ips;
DROP FUNCTION IF EXISTS public.site_network_ip_retention();

-- 058's next_doc_number, verbatim (supabase/migrations/058_quote_to_job.sql).
-- -----------------------------------------------------------------------------------------------------
-- ---- 3. SO-#### numbers ------------------------------------------------------------------------------------
-- The 034 body, plus 'SO' (admin, office; a number already used as an so_number is skipped).
CREATE OR REPLACE FUNCTION public.next_doc_number(p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org      UUID := public.current_user_organization_id();
  n        INT;
  result   TEXT;
  taken    BOOLEAN;
  attempts INT := 0;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_prefix IS NULL OR p_prefix NOT IN ('QUO', 'INV', 'J', 'PO', 'RFQ', 'DLN', 'CN', 'SO') THEN
    RAISE EXCEPTION 'invalid document prefix' USING ERRCODE = '22023';
  END IF;

  -- You can only take numbers for documents you are allowed to create (a viewer cannot burn numbers).
  IF NOT public.has_org_role(CASE p_prefix
        WHEN 'INV' THEN ARRAY['admin', 'office']
        WHEN 'J'   THEN ARRAY['admin', 'office', 'workshop']
        WHEN 'DLN' THEN ARRAY['admin', 'office', 'workshop']
        ELSE            ARRAY['admin', 'office']
      END) THEN
    RAISE EXCEPTION 'not authorised for % numbers', p_prefix USING ERRCODE = '42501';
  END IF;

  LOOP
    INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
    VALUES (org, p_prefix, 1)
    ON CONFLICT (organization_id, prefix) DO UPDATE SET last = c.last + 1
    RETURNING c.last INTO n;

    -- lpad() would truncate numbers above 9999, so only pad short numbers.
    result := p_prefix || '-' || CASE WHEN n < 10000 THEN lpad(n::TEXT, 4, '0') ELSE n::TEXT END;

    -- Skip numbers that already exist (rows imported or seeded after the counters were seeded, or jobs that
    -- took a quote's number). Counters only move forward, so a skipped number is simply never reused.
    taken := CASE p_prefix
      WHEN 'QUO' THEN EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = result)
      WHEN 'INV' THEN EXISTS (SELECT 1 FROM public.invoices WHERE organization_id = org AND invoice_ref = result)
      WHEN 'J'   THEN EXISTS (SELECT 1 FROM public.jobs     WHERE organization_id = org AND job_no = result)
                   OR EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = 'QUO' || substr(result, 2))
      WHEN 'DLN' THEN EXISTS (SELECT 1 FROM public.delivery_notes WHERE organization_id = org AND dn_number = result)
      WHEN 'CN'  THEN EXISTS (SELECT 1 FROM public.credit_notes WHERE organization_id = org AND credit_ref = result)
      WHEN 'SO'  THEN EXISTS (SELECT 1 FROM public.sales_orders WHERE organization_id = org AND so_number = result)
      ELSE FALSE
    END;
    EXIT WHEN NOT taken;

    attempts := attempts + 1;
    IF attempts > 10000 THEN
      RAISE EXCEPTION 'could not allocate a free % number', p_prefix;
    END IF;
  END LOOP;

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.next_doc_number(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_doc_number(TEXT) TO authenticated;

-- 034's issue_credit_note, verbatim (supabase/migrations/034_workflow_day_one.sql).
-- Issues a draft credit note and applies it to its invoice, in one transaction (nothing is issued without being applied, nothing applied
-- without being issued): gives it the next CN number, freezes it with the issuer's and customer's details as they are now, and records
-- the whole credit against the invoice (allocate_credit_note). What the invoice still owed is paid off by it; whatever is beyond that is
-- customer credit on the invoice (paid + credited - refunded - total), which shows on the invoice and can be refunded or applied to another
-- invoice of the customer: it is never left unapplied or hidden.
-- Before anything is written the credit note is worked out again from its LINES and the invoice, never from its header: the header must
-- match the lines to the penny (net, VAT, total), each line must be one of the invoice's own lines (its description, rate and exemption the
-- invoice's, a price no higher than invoiced, VAT within a penny or two of the rate and no VAT on an exempt line or an invoice without it),
-- and the caps hold again, now that the invoice is locked. Issuing it again returns its number. Admin and office.
CREATE OR REPLACE FUNCTION public.issue_credit_note(p_credit UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_invoice UUID;
  v_cn      public.credit_notes%ROWTYPE;
  v_inv     RECORD;
  v_ref     TEXT;
  v_vat_on  BOOLEAN;
  v_net     NUMERIC;
  v_vat     NUMERIC;
  v_bad     INTEGER;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  -- The invoice is locked first, then the credit note (the order allocate_credit_note uses), so the two never wait for each other.
  SELECT invoice_id INTO v_invoice FROM public.credit_notes WHERE id = p_credit AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT id, invoice_ref, status, customer, total, vat_enabled, issuer_snapshot INTO v_inv FROM public.invoices WHERE id = v_invoice AND organization_id = v_org FOR UPDATE;
  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_credit AND organization_id = v_org FOR UPDATE;
  IF v_cn.status <> 'draft' THEN
    RETURN v_cn.credit_ref;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.credit_note_lines WHERE credit_note_id = p_credit) THEN
    RAISE EXCEPTION 'Add at least one line before issuing.' USING ERRCODE = '22023';
  END IF;
  IF lower(coalesce(v_inv.status, 'draft')) IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'written_off') THEN
    RAISE EXCEPTION '% is % and can''t be credited.', coalesce(v_inv.invoice_ref, 'The invoice'), coalesce(v_inv.status, 'a draft') USING ERRCODE = '22023';
  END IF;

  -- The credit note again, from its lines and the invoice.
  v_vat_on := v_inv.vat_enabled AND CASE WHEN v_inv.issuer_snapshot IS NULL THEN public.org_vat_registered(v_org)
                                         ELSE NOT (v_inv.issuer_snapshot -> 'vatRegistered' IS NOT DISTINCT FROM 'false'::JSONB) END;
  SELECT coalesce(sum(round(l.quantity * l.unit_price, 2)), 0), coalesce(sum(l.vat_amount), 0) INTO v_net, v_vat FROM public.credit_note_lines l WHERE l.credit_note_id = p_credit;
  SELECT count(*) INTO v_bad
    FROM public.credit_note_lines l
    LEFT JOIN public.invoice_line_items il ON il.id = l.invoice_line_id AND il.invoice_id = v_invoice AND il.organization_id = v_org
    WHERE l.credit_note_id = p_credit
      AND (il.id IS NULL OR l.organization_id <> v_org OR l.description IS DISTINCT FROM il.description OR l.vat_pct IS DISTINCT FROM il.vat_pct OR l.vat_exempt IS DISTINCT FROM il.vat_exempt
           OR l.unit_price > il.unit_price
           OR (l.vat_exempt OR NOT v_vat_on) AND l.vat_amount <> 0
           OR NOT (l.vat_exempt OR NOT v_vat_on) AND abs(l.vat_amount - round(l.quantity * l.unit_price, 2) * l.vat_pct / 100) > 0.02);
  IF v_bad > 0 OR v_cn.customer IS DISTINCT FROM v_inv.customer OR v_cn.vat_enabled IS DISTINCT FROM v_vat_on
     OR v_cn.subtotal IS DISTINCT FROM v_net OR v_cn.vat IS DISTINCT FROM v_vat OR v_cn.total IS DISTINCT FROM v_net + v_vat OR v_net + v_vat <= 0 THEN
    RAISE EXCEPTION 'This credit note does not match its lines and the invoice (it is for % but its lines come to %): nothing was issued. Delete the draft and make it again.',
      chr(163) || to_char(v_cn.total, 'FM999999990.00'), chr(163) || to_char(v_net + v_vat, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  -- The caps again, now that the invoice is locked: every line, and the invoice's total, against all the credit notes made for it.
  PERFORM public.check_credit_note_caps(v_invoice);

  v_ref := public.next_doc_number('CN');
  PERFORM set_config('quoteflow.credit_note', p_credit::TEXT, TRUE);
  UPDATE public.credit_notes
     SET status = 'issued', credit_ref = v_ref, issued_at = now(),
         issuer_snapshot = coalesce(v_inv.issuer_snapshot, public.issuer_snapshot(v_org)), customer_snapshot = public.customer_snapshot(v_org, v_cn.customer)
   WHERE id = p_credit;
  PERFORM set_config('quoteflow.credit_note', '', TRUE);
  -- Apply all of it to the invoice in the same transaction: the invoice settles by what it owed and the rest is customer credit.
  PERFORM public.allocate_credit_note(p_credit, v_cn.total, gen_random_uuid());
  RETURN v_ref;
END
$$;
REVOKE ALL ON FUNCTION public.issue_credit_note(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_credit_note(UUID) TO authenticated;
COMMIT;
