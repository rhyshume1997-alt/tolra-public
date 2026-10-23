-- 078_ip_retention_and_crd_numbers.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 078: clock-in network addresses kept at most 30 days, never in the audit log (B40 / G21, Rhys's decision), and credit notes
-- numbered CRD-#### (G9, Rhys's decision). Needs 075 (site network check) and 058 (next_doc_number). Production order: 075, 077,
-- 076, then 078 (it changes nothing 076 or 077 change).
--
-- PART A: the clock-in IP address. The site check stays RECORD AND FLAG ONLY, never refusing, tied to the site Wi-Fi's public address
-- an admin saves (and can change) in Settings. Until now (075) the request's IP of an on_site / off_site check was kept for ever in
-- attendance_event_networks.ip (a row that can never change or be removed) AND copied, with the row, into the hash-chained audit log
-- (log_row_change), which can never be purged without breaking the chain.
-- 1. attendance_event_network_ips: the address of each on_site / off_site check, one row per check (event_id), with the company, the
--    person and the check time. NOT audited (nothing of it ever reaches security_audit.audit_log) and NOT immutable (it is deleted when
--    it expires). Read rules as attendance_event_networks: the person their own (admin, office, workshop), admin and office the
--    company's; viewer and other companies nothing; no direct API writes; support read-only and the admin second step as 075's tables.
-- 2. Retention: site_network_ip_retention() = 30 days from the check; site_network_ip_purge(company, limit) deletes the company's
--    expired addresses, oldest first, skipping rows another transaction holds (never waits for them). No scheduler (see 4).
-- 3. Existing rows: any address already in attendance_event_networks (075 applied and the check switched on before 078) is moved:
--    copied into the new table if it is under 30 days old (older ones are dropped, as the purge would), then set to NULL in place.
--    That one UPDATE runs with the row's immutability trigger and its audit trigger disabled for this transaction only (ALTER TABLE
--    ... DISABLE TRIGGER, re-enabled before the transaction ends: no other session ever sees them off), so the move writes no address
--    into the audit log; one named event per company records the counts instead. Audit rows ALREADY written under 075 keep their copy
--    of the address: the hash chain makes them unchangeable, and 078 never rewrites audit_log (release preflight row 14 counts them).
--    Lock order: the companies' audit-chain locks are taken first (section 0), before any lock on attendance_event_networks, as a clock
--    action does: a clock action during the release can't deadlock with it.
--    From then on attendance_event_networks.ip is always NULL (CHECK (ip IS NULL)); the row stays immutable and keeps the status, the
--    off_site_network flag and the check time for ever. So its audit copy holds no address.
-- 4. The check trigger (075's attendance_events_network, replaced): every clock action of a company first deletes that company's
--    expired addresses (an index probe on (organization_id, checked_at); when something has expired, at most 500 rows); then, exactly
--    as 075, the check row, whose address now goes to attendance_event_network_ips. Every statement runs inside the outer handler (an
--    error anywhere never refuses the clock action); the purge and the address insert each have their own (a failed purge still lets
--    the check run; a failed address insert keeps the check row and its flag).
-- 5. purge_site_network_ips(p_all): an admin deletes the company's expired addresses (p_all FALSE), or all of them (TRUE), at once.
--    Audited: the count only, never an address. A company that stops clocking keeps its last addresses until an admin runs it.
--    Kept for ever, whatever the age: the check row (status, off_site_network, check time). There is no per-flag decision record in
--    075 or the app yet (a week's approval note, 052, is the only office text); 078 neither adds nor removes one.
--    A seen address is NEVER trusted automatically: 078 reads attendance_event_network_ips nowhere but its own purge, and only 075's
--    add_site_network (an admin's explicit save: typed, or "Use the network I'm on now") writes site_networks.
--
-- PART B: credit note numbers. New credit notes are numbered CRD-#### (John's SliQ series), ascending in the order they are issued.
-- 6. next_doc_number (058's body) also hands out 'CRD' (admin, office, as 'CN'). The number carries on after the highest credit note
--    number the company already has, CRD-n or CN-n (a company that issued CN-0012 goes on at CRD-0013, never back to CRD-0001),
--    read at every call so a credit note loaded later still moves it on; a number already used is skipped (as every series).
--    Credit notes SliQ holds that are not in Tolra (JNR's CRD-0166 and CRD-2166 have no invoice link, so they are recorded outside
--    Tolra) are set with seed_credit_note_number(company, 'CRD-2166'), owner only (SQL editor), which only ever moves the counter on.
-- 7. issue_credit_note (034's body) takes next_doc_number('CRD') instead of 'CN'. Nothing else of it changes. Existing credit_ref
--    values are never changed; 'CN' stays accepted by next_doc_number.
--
-- Three functions replaced (attendance_events_network, next_doc_number, issue_credit_note) and one CHECK on attendance_event_networks;
-- added: one table and four functions (one callable by signed-in members, three internal or owner only). Forward only, safe to run
-- more than once. Rollback: docs/RELEASE.md "078".
-- =====================================================================================================

-- ---- 0. Lock order -------------------------------------------------------------------------------------------------------------
-- Section 3 writes one audit row per company whose check rows hold an address, and every audit row takes that company's audit-chain
-- lock (time_company_lock, the key set_audit_hash takes). A clock action takes the same lock FIRST and then writes the check row. So
-- the company locks are taken here, before this transaction locks attendance_event_networks (section 1's foreign key, section 3's
-- ALTER TABLE): one order everywhere (company lock, then the table), so a clock action during the release waits or goes first, and
-- the two can't deadlock. No address held: no lock taken.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT n.organization_id FROM public.attendance_event_networks n WHERE n.ip IS NOT NULL ORDER BY n.organization_id LOOP
    PERFORM public.time_company_lock(r.organization_id);
  END LOOP;
END
$$;

-- ---- 1. The address of each on_site / off_site check, kept 30 days -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attendance_event_network_ips (
  event_id        UUID PRIMARY KEY REFERENCES public.attendance_event_networks(event_id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ip              INET NOT NULL,
  checked_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attendance_event_network_ips_expiry ON public.attendance_event_network_ips (organization_id, checked_at);
ALTER TABLE public.attendance_event_network_ips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attendance_event_network_ips rbac select" ON public.attendance_event_network_ips;
CREATE POLICY "attendance_event_network_ips rbac select" ON public.attendance_event_network_ips FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.attendance_event_network_ips FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.attendance_event_network_ips TO authenticated;
-- Support read-only and the admin second step, as every table 075 adds. Deliberately NO audit trigger (the address must never reach
-- the hash-chained audit log) and NO immutability trigger (expired rows are deleted).
DROP TRIGGER IF EXISTS support_read_only ON public.attendance_event_network_ips;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_event_network_ips
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.attendance_event_network_ips;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_event_network_ips
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- ---- 2. Retention ------------------------------------------------------------------------------------------------------------------
-- How long a clock-in address is kept after its check (Rhys, final: 30 days). The status and the flag are kept for ever. Internal.
CREATE OR REPLACE FUNCTION public.site_network_ip_retention()
RETURNS INTERVAL
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT INTERVAL '30 days'
$$;
REVOKE ALL ON FUNCTION public.site_network_ip_retention() FROM PUBLIC, anon, authenticated;

-- Deletes the company's addresses older than the retention period, oldest first, at most p_limit (NULL: all of them). Rows another
-- transaction is deleting are skipped (never waited for). Returns how many it deleted. Internal.
CREATE OR REPLACE FUNCTION public.site_network_ip_purge(p_org UUID, p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  DELETE FROM public.attendance_event_network_ips d
  WHERE d.event_id IN (SELECT i.event_id FROM public.attendance_event_network_ips i
                       WHERE i.organization_id = p_org AND i.checked_at < now() - public.site_network_ip_retention()
                       ORDER BY i.checked_at
                       LIMIT p_limit
                       FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.site_network_ip_purge(UUID, INTEGER) FROM PUBLIC, anon, authenticated;

-- ---- 3. Addresses already in attendance_event_networks (075 switched on before 078): moved, never into the audit log --------------
ALTER TABLE public.attendance_event_networks DROP CONSTRAINT IF EXISTS attendance_event_networks_ip;
DO $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - public.site_network_ip_retention();
  r        RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.attendance_event_networks n WHERE n.ip IS NOT NULL) THEN
    RETURN;
  END IF;
  INSERT INTO public.attendance_event_network_ips (event_id, organization_id, user_id, ip, checked_at)
  SELECT n.event_id, n.organization_id, n.user_id, n.ip, n.checked_at
  FROM public.attendance_event_networks n
  WHERE n.ip IS NOT NULL AND n.checked_at >= v_cutoff
  ON CONFLICT (event_id) DO NOTHING;
  -- Every company logged below must already hold its audit-chain lock (section 0). A company whose first address was committed after
  -- section 0 looked is locked here WITHOUT waiting: this transaction now locks attendance_event_networks, and waiting for a company
  -- lock while a clock action of that company waits for the table would deadlock. If it is busy the release stops (nothing kept):
  -- run it again.
  FOR r IN SELECT DISTINCT n.organization_id FROM public.attendance_event_networks n WHERE n.ip IS NOT NULL ORDER BY n.organization_id LOOP
    IF NOT pg_try_advisory_xact_lock(hashtext(coalesce(r.organization_id::TEXT, ''))) THEN
      RAISE EXCEPTION '078: a clock action of company % is running; nothing was changed, run the release again', r.organization_id
        USING ERRCODE = '55P03';
    END IF;
  END LOOP;
  -- One named event per company: counts only, never an address.
  FOR r IN SELECT n.organization_id, count(*) FILTER (WHERE n.checked_at >= v_cutoff) AS moved, count(*) FILTER (WHERE n.checked_at < v_cutoff) AS expired
           FROM public.attendance_event_networks n WHERE n.ip IS NOT NULL GROUP BY n.organization_id ORDER BY n.organization_id LOOP
    PERFORM security_audit.log_named_event(r.organization_id, 'SITE_NETWORK_IPS_MOVED', 'attendance_event_networks', NULL,
      jsonb_build_object('moved', r.moved, 'removed_expired', r.expired, 'retention_days', 30));
  END LOOP;
  -- The narrow bypass: this transaction only, these two triggers only, this one column only. The audit trigger is off so the OLD row
  -- (with its address) is not copied into the audit log again.
  ALTER TABLE public.attendance_event_networks DISABLE TRIGGER attendance_event_networks_immutable;
  ALTER TABLE public.attendance_event_networks DISABLE TRIGGER audit_attendance_event_networks_changes;
  UPDATE public.attendance_event_networks SET ip = NULL WHERE ip IS NOT NULL;
  ALTER TABLE public.attendance_event_networks ENABLE TRIGGER audit_attendance_event_networks_changes;
  ALTER TABLE public.attendance_event_networks ENABLE TRIGGER attendance_event_networks_immutable;
END
$$;
-- From now on the check row never holds an address (075's rule was: an address exactly for on_site and off_site).
ALTER TABLE public.attendance_event_networks ADD CONSTRAINT attendance_event_networks_ip CHECK (ip IS NULL);

-- ---- 4. The check, after each clock action is recorded (075's, with the address kept apart and expired ones deleted first) ---------
-- Runs inside record_attendance_event (050), which already holds the company's lock and the person's lock. With the switch off, or a
-- person who is not on-site-only, it writes nothing (it only deletes the company's expired addresses, when there are any). It never
-- refuses: EVERY statement runs inside the outer handler, so any error leaves the clock action recorded (without a check row). The
-- purge has its own handler (a failed purge still lets the check run), and so has the address (a failed address insert keeps the
-- check row and its flag, without the address). Internal.
CREATE OR REPLACE FUNCTION public.attendance_events_network()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_mode    TEXT;
  v_ip      INET;
  v_status  TEXT;
  v_checked TIMESTAMPTZ;
BEGIN
  BEGIN
    -- 078: the company's addresses past the retention period go first (cheap: one index probe when none has expired).
    BEGIN
      IF EXISTS (SELECT 1 FROM public.attendance_event_network_ips i
                 WHERE i.organization_id = NEW.organization_id AND i.checked_at < now() - public.site_network_ip_retention()) THEN
        PERFORM public.site_network_ip_purge(NEW.organization_id, 500);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- The next clock action tries again.
      NULL;
    END;
    IF NEW.source <> 'clock' THEN
      RETURN NULL;
    END IF;
    SELECT s.site_network_check INTO v_mode FROM public.site_network_settings s WHERE s.organization_id = NEW.organization_id;
    IF coalesce(v_mode, 'off') <> 'flag' THEN
      RETURN NULL;
    END IF;
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
    -- The check row (and so its audit copy) never holds the address: it goes to attendance_event_network_ips, which is not audited.
    INSERT INTO public.attendance_event_networks (event_id, organization_id, user_id, status, ip, off_site_network)
    VALUES (NEW.id, NEW.organization_id, NEW.user_id, v_status, NULL, v_status = 'off_site')
    RETURNING checked_at INTO v_checked;
    IF v_status IN ('on_site', 'off_site') THEN
      BEGIN
        INSERT INTO public.attendance_event_network_ips (event_id, organization_id, user_id, ip, checked_at)
        VALUES (NEW.id, NEW.organization_id, NEW.user_id, v_ip, v_checked);
      EXCEPTION WHEN OTHERS THEN
        -- The check row and its flag stay; only the address is not kept.
        NULL;
      END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Phase 1 never refuses a clock action. The action stays recorded; it just has no check row.
    RETURN NULL;
  END;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.attendance_events_network() FROM PUBLIC, anon, authenticated;

-- ---- 5. Admin: delete the company's kept addresses now --------------------------------------------------------------------------
-- p_all FALSE: those past the retention period (what every clock action does anyway; for a company that has stopped clocking).
-- p_all TRUE: every address the company holds (e.g. after switching the check off). The status and flag of each check stay. Admin
-- only (second step where required), the caller's company only, under the company's lock (the same order as a clock action).
-- Audited when something was deleted: the count, never an address. Safe to repeat (a second call deletes nothing).
CREATE OR REPLACE FUNCTION public.purge_site_network_ips(p_all BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.site_network_admin_org();
  v_n   INTEGER;
BEGIN
  IF p_all IS NULL THEN
    RAISE EXCEPTION 'Choose expired addresses or all of them.' USING ERRCODE = '22023', HINT = 'bad_flag';
  END IF;
  PERFORM public.time_company_lock(v_org);
  IF p_all THEN
    DELETE FROM public.attendance_event_network_ips i WHERE i.organization_id = v_org;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    v_n := public.site_network_ip_purge(v_org, NULL);
  END IF;
  IF v_n > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'SITE_NETWORK_IPS_PURGED', 'attendance_event_network_ips', NULL,
      jsonb_build_object('removed', v_n, 'all', p_all, 'retention_days', 30));
  END IF;
  RETURN jsonb_build_object('removed', v_n, 'all', p_all, 'retention_days', 30);
END
$$;
REVOKE ALL ON FUNCTION public.purge_site_network_ips(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_site_network_ips(BOOLEAN) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. CRD-#### numbers -------------------------------------------------------------------------------------------
-- The 058 body, plus 'CRD' (admin, office; a number already used as a credit_ref is skipped). For 'CRD' the counter is first moved
-- past the highest CRD-n or CN-n credit note number the company has (read at every call; a counter never moves back).
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
  floor_n  INT := 0;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_prefix IS NULL OR p_prefix NOT IN ('QUO', 'INV', 'J', 'PO', 'RFQ', 'DLN', 'CN', 'SO', 'CRD') THEN
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

  -- 078: credit notes carry on after the highest credit note number the company already has (CRD-n, or CN-n from before 078), so a
  -- credit note loaded or recorded after the counter was made still moves it on. Other prefixes: floor 0, exactly as before.
  IF p_prefix = 'CRD' THEN
    SELECT coalesce(max(substring(cn.credit_ref FROM '^(?:CRD|CN)-(\d{1,9})$')::INT), 0) INTO floor_n
    FROM public.credit_notes cn
    WHERE cn.organization_id = org AND cn.credit_ref ~ '^(CRD|CN)-\d{1,9}$';
  END IF;

  LOOP
    INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
    VALUES (org, p_prefix, floor_n + 1)
    ON CONFLICT (organization_id, prefix) DO UPDATE SET last = GREATEST(c.last + 1, EXCLUDED.last)
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
      WHEN 'CRD' THEN EXISTS (SELECT 1 FROM public.credit_notes WHERE organization_id = org AND credit_ref = result)
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

-- Owner only (SQL editor or a direct connection; no API role may run it): the company's CRD counter moved on to at least the number
-- of p_highest ('CRD-2166', a credit note the company issued outside Tolra, e.g. in SliQ), so the next credit note is the one after
-- it. Never moves the counter back. Returns the number the next credit note will take (unless a higher one is in Tolra by then).
CREATE OR REPLACE FUNCTION public.seed_credit_note_number(p_org UUID, p_highest TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_n    INT := substring(btrim(coalesce(p_highest, '')) FROM '^CRD-(\d{1,9})$')::INT;
  v_last INT;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'Unknown company.' USING ERRCODE = 'P0002';
  END IF;
  IF v_n IS NULL OR v_n < 1 THEN
    RAISE EXCEPTION 'Give the highest credit note number as CRD-n, e.g. CRD-2166.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
  VALUES (p_org, 'CRD', v_n)
  ON CONFLICT (organization_id, prefix) DO UPDATE SET last = GREATEST(c.last, EXCLUDED.last)
  RETURNING c.last INTO v_last;
  RETURN 'CRD-' || CASE WHEN v_last + 1 < 10000 THEN lpad((v_last + 1)::TEXT, 4, '0') ELSE (v_last + 1)::TEXT END;
END
$$;
REVOKE ALL ON FUNCTION public.seed_credit_note_number(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 7. Issuing a credit note takes the next CRD number (034's body; only 'CN' -> 'CRD') -----------------------------------------
-- Issues a draft credit note and applies it to its invoice, in one transaction (nothing is issued without being applied, nothing applied
-- without being issued): gives it the next CRD number (078), freezes it with the issuer's and customer's details as they are now, and records
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

  v_ref := public.next_doc_number('CRD');
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
