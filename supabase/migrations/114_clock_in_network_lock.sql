-- =====================================================================================================
-- 114: lock clock-in to the workshop network (M27; Rhys, Fri 30 Oct: "an admin-only button that captures the current network IP and
-- locks clock-in to it (only admin can change)"). G21 / B40 phase 2 (refuse), OFF by default: with no lock row (the default) every clock
-- action, its answer and its audit rows are exactly as before 114. Needs 050 (attendance_events, time_company_lock) and 075 (the
-- request's address, site networks, the per-person On site only flag). Applied after 101; touches none of 076 to 101's objects.
-- NUMBERING: 114 is a working number (given by the orchestrator, 30 Oct). It replaces no existing object, so it can take any later
-- number without a change to its text other than this header.
--
-- WHAT IT ADDS. Two tables, four functions (two the app calls, two trigger functions), two triggers on attendance_events. Nothing
-- existing is replaced; 075's flag check (site_network_settings 'flag') keeps working beside it, unchanged.
--   a. public.clock_in_network_locks: at most one row per company: the network clock-in is locked to (the address the admin's own
--      request came from: /32 for IPv4, its /64 for IPv6, exactly as 075's "Use the network I'm on now"), who locked it and when. No row
--      = unlocked. Read by the company's admin and office users.
--   b. public.clock_in_network_unverified: one row per clock action that the lock could NOT check: made while the company is locked, by
--      a person marked On site only (075's site_network_members), and either synced later (it reached the server more than 2 minutes
--      after the device's time: queued offline; 075's rule) or with no client address on the request (not through the API gateway).
--      Such an action is ACCEPTED (a clock action made offline can't prove where it was made, and is never lost) and marked
--      network_unverified here, with a copy of its action and times so the week review can list it. Never changed or removed (050's
--      immutability function). No address is kept. Read: the person their own; admin and office the company's.
--   c. lock_clock_in_network(): admin only (075's site_network_admin_org: assert_privileged_aal, then the admin role). The address comes
--      from 075's request_client_ip(): PostgREST's request.headers, cf-connecting-ip ONLY, set by the server per request; the browser
--      never sends an address and x-forwarded-for is ignored (its first hop is whatever the client wrote). Locks, or re-captures (the
--      same call replaces the network with this request's). Refused when the address can't be seen (ip_unknown) or is private / local
--      (075's site_network_parse: private_network). Audited (CLOCK_IN_NETWORK_LOCKED, and the row change).
--   d. unlock_clock_in_network(): admin only, the same guard. Removes the row. Audited (CLOCK_IN_NETWORK_UNLOCKED, and the row change).
--   e. clock_in_network_lock_check(), BEFORE INSERT on attendance_events, clock actions only (source 'clock': in, out, break start, break
--      end; corrections are never checked, so an admin can always add time): REFUSES (42501, hint clock_in_network_locked, nothing is
--      recorded) a clock action when ALL of: the company has a lock row; the person is On site only (075: no row = can work off site,
--      never checked); the action is online (device time at most 2 minutes behind the server); the request has a client address; and
--      that address is neither inside the locked network nor inside one of the company's saved site networks (075's list, so a second
--      address family or a second site can be added there). The message names no address and avoids the words the app reads as a
--      lost connection (lib/offline/store.ts isNetworkError), so the device holds it as refused instead of retrying it until it is
--      2 minutes old.
--   f. clock_in_network_unverified_record(), AFTER INSERT (named zz_ to run after 050/075's own): writes the row of b. Never refuses: any
--      error inside it is swallowed (the clock action stays recorded, without the mark), as 075's check does.
-- SPOOFING / LIMITS (as 075, header note 5): cf-connecting-ip is trustworthy only if every request reaches PostgREST through Cloudflare;
-- prove it on the real project before pressing Lock (docs/RELEASE.md "075" pre-activation check). A device whose clock is set more than
-- 2 minutes behind is treated as synced later: accepted and marked network_unverified (shown to the office), never silently trusted.
-- Support read-only and admin two-step statement triggers on both tables, as 075. SECURITY DEFINER, pinned search_path. Forward only,
-- safe to run more than once. Rollback: supabase/release/114_clock_in_network_lock.rollback.sql.
-- =====================================================================================================

-- ---- 0. Needs 050 and 075 -------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.attendance_events') IS NULL OR to_regprocedure('public.time_company_lock(uuid)') IS NULL
     OR to_regprocedure('public.attendance_events_immutable()') IS NULL THEN
    RAISE EXCEPTION '114 needs 050 (attendance_events) applied first';
  END IF;
  IF to_regclass('public.site_network_members') IS NULL OR to_regprocedure('public.request_client_ip()') IS NULL
     OR to_regprocedure('public.site_network_parse(text)') IS NULL OR to_regprocedure('public.site_network_matches(uuid,inet)') IS NULL
     OR to_regprocedure('public.site_network_admin_org()') IS NULL THEN
    RAISE EXCEPTION '114 needs 075 (site network check) applied first';
  END IF;
END
$$;

-- ---- 1. The company's lock (no row = unlocked) ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clock_in_network_locks (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  network         CIDR NOT NULL,
  locked_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  locked_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT clock_in_network_locks_one_address CHECK (masklen(network) = CASE family(network) WHEN 4 THEN 32 ELSE 64 END)
);
ALTER TABLE public.clock_in_network_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clock_in_network_locks rbac select" ON public.clock_in_network_locks;
CREATE POLICY "clock_in_network_locks rbac select" ON public.clock_in_network_locks FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
REVOKE ALL ON public.clock_in_network_locks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.clock_in_network_locks TO authenticated;

-- ---- 2. Clock actions the lock could not check (accepted, marked network_unverified) ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clock_in_network_unverified (
  event_id        UUID PRIMARY KEY REFERENCES public.attendance_events(id) ON DELETE RESTRICT,
  id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action          TEXT NOT NULL CHECK (action IN ('in', 'out', 'break_start', 'break_end')),
  at              TIMESTAMPTZ NOT NULL,
  device_at       TIMESTAMPTZ,
  received_at     TIMESTAMPTZ NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('synced_later', 'address_unknown')),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_clock_in_network_unverified_at ON public.clock_in_network_unverified (organization_id, at);
ALTER TABLE public.clock_in_network_unverified ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clock_in_network_unverified rbac select" ON public.clock_in_network_unverified;
CREATE POLICY "clock_in_network_unverified rbac select" ON public.clock_in_network_unverified FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.clock_in_network_unverified FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.clock_in_network_unverified TO authenticated;
-- A record of what happened: never changed or removed (050's function, as the clock record itself and 075's check rows).
DROP TRIGGER IF EXISTS clock_in_network_unverified_immutable ON public.clock_in_network_unverified;
CREATE TRIGGER clock_in_network_unverified_immutable BEFORE UPDATE OR DELETE ON public.clock_in_network_unverified
  FOR EACH ROW EXECUTE FUNCTION public.attendance_events_immutable();

-- Audit (row changes), support read-only and admin two-step on both tables, as 075.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['clock_in_network_locks', 'clock_in_network_unverified'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_' || t || '_changes', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change()', 'audit_' || t || '_changes', t);
    EXECUTE format('DROP TRIGGER IF EXISTS support_read_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS admin_mfa ON public.%I', t);
    EXECUTE format('CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard()', t);
  END LOOP;
END
$$;

-- ---- 3. The check, before each clock action is recorded --------------------------------------------------------------------------
-- Runs inside record_attendance_event (050), which holds the company's and the person's locks. Unlocked company, a person who can work
-- off site, a synced-later action or no client address: returns at once (the row goes in). Otherwise refuses an address outside both
-- the locked network and the saved site networks. Internal.
CREATE OR REPLACE FUNCTION public.clock_in_network_lock_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_net CIDR;
  v_ip  INET;
BEGIN
  IF NEW.source <> 'clock' THEN
    RETURN NEW;
  END IF;
  SELECT l.network INTO v_net FROM public.clock_in_network_locks l WHERE l.organization_id = NEW.organization_id;
  IF v_net IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.site_network_members m
                 WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.user_id AND m.on_site_only) THEN
    RETURN NEW;
  END IF;
  IF NEW.device_at IS NOT NULL AND NEW.received_at - NEW.device_at > INTERVAL '2 minutes' THEN
    RETURN NEW; -- synced later: can't be checked; marked by the AFTER trigger
  END IF;
  v_ip := public.request_client_ip();
  IF v_ip IS NULL THEN
    RETURN NEW; -- no client address on this request: can't be checked; marked by the AFTER trigger
  END IF;
  IF (family(v_ip) = family(v_net) AND v_ip <<= v_net) OR public.site_network_matches(NEW.organization_id, v_ip) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% from the workshop Wi-Fi: this device isn''t on it, so nothing was recorded. Join the workshop Wi-Fi and try again, or ask an admin if you are working off site today.',
    CASE NEW.action WHEN 'in' THEN 'Clock in' WHEN 'out' THEN 'Clock out' WHEN 'break_start' THEN 'Start your break' ELSE 'End your break' END
    USING ERRCODE = '42501', HINT = 'clock_in_network_locked';
END
$$;
REVOKE ALL ON FUNCTION public.clock_in_network_lock_check() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS clock_in_network_lock ON public.attendance_events;
CREATE TRIGGER clock_in_network_lock BEFORE INSERT ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.clock_in_network_lock_check();

-- ---- 4. The mark, after a clock action the lock could not check is recorded ------------------------------------------------------
-- Never refuses: any error is swallowed (the clock action stays recorded, without the mark). Internal.
CREATE OR REPLACE FUNCTION public.clock_in_network_unverified_record()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reason TEXT;
BEGIN
  IF NEW.source <> 'clock' THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.clock_in_network_locks l WHERE l.organization_id = NEW.organization_id) THEN
      RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.site_network_members m
                   WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.user_id AND m.on_site_only) THEN
      RETURN NULL;
    END IF;
    IF NEW.device_at IS NOT NULL AND NEW.received_at - NEW.device_at > INTERVAL '2 minutes' THEN
      v_reason := 'synced_later';
    ELSIF public.request_client_ip() IS NULL THEN
      v_reason := 'address_unknown';
    ELSE
      RETURN NULL; -- checked online by clock_in_network_lock_check, and allowed
    END IF;
    INSERT INTO public.clock_in_network_unverified (event_id, organization_id, user_id, action, at, device_at, received_at, reason)
    VALUES (NEW.id, NEW.organization_id, NEW.user_id, NEW.action, NEW.at, NEW.device_at, NEW.received_at, v_reason);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL; -- the clock action stays recorded; it just has no mark
  END;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.clock_in_network_unverified_record() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_clock_in_network_unverified ON public.attendance_events;
CREATE TRIGGER zz_clock_in_network_unverified AFTER INSERT ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.clock_in_network_unverified_record();

-- ---- 5. Admin: lock (or re-capture), unlock -----------------------------------------------------------------------------------
-- Locks clock-in to the network this request comes from (075's request_client_ip: cf-connecting-ip only), or re-captures it.
CREATE OR REPLACE FUNCTION public.lock_clock_in_network()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.site_network_admin_org();
  v_ip     INET;
  v_net    CIDR;
  v_before CIDR;
  v_row    public.clock_in_network_locks%ROWTYPE;
BEGIN
  PERFORM public.time_company_lock(v_org);
  v_ip := public.request_client_ip();
  IF v_ip IS NULL THEN
    RAISE EXCEPTION 'Tolra can''t see the address this request comes from, so nothing was locked.' USING ERRCODE = '22023', HINT = 'ip_unknown';
  END IF;
  v_net := public.site_network_parse(CASE family(v_ip) WHEN 4 THEN host(v_ip) || '/32' ELSE host(network(set_masklen(v_ip, 64))) || '/64' END);
  SELECT l.network INTO v_before FROM public.clock_in_network_locks l WHERE l.organization_id = v_org FOR UPDATE;
  INSERT INTO public.clock_in_network_locks (organization_id, network, locked_by, locked_at)
  VALUES (v_org, v_net, auth.uid(), clock_timestamp())
  ON CONFLICT (organization_id) DO UPDATE SET network = EXCLUDED.network, locked_by = EXCLUDED.locked_by, locked_at = EXCLUDED.locked_at
  RETURNING * INTO v_row;
  PERFORM security_audit.log_named_event(v_org, 'CLOCK_IN_NETWORK_LOCKED', 'clock_in_network_locks', v_row.id::TEXT,
    jsonb_build_object('before', v_before::TEXT, 'after', v_net::TEXT, 'recaptured', v_before IS NOT NULL));
  RETURN jsonb_build_object('locked', TRUE, 'network', v_row.network::TEXT, 'locked_by', v_row.locked_by, 'locked_at', v_row.locked_at,
                            'changed', v_before IS DISTINCT FROM v_net, 'recaptured', v_before IS NOT NULL);
END
$$;
REVOKE ALL ON FUNCTION public.lock_clock_in_network() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_clock_in_network() TO authenticated;

CREATE OR REPLACE FUNCTION public.unlock_clock_in_network()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.site_network_admin_org();
  v_row public.clock_in_network_locks%ROWTYPE;
BEGIN
  PERFORM public.time_company_lock(v_org);
  DELETE FROM public.clock_in_network_locks l WHERE l.organization_id = v_org RETURNING * INTO v_row;
  IF v_row.organization_id IS NOT NULL THEN
    PERFORM security_audit.log_named_event(v_org, 'CLOCK_IN_NETWORK_UNLOCKED', 'clock_in_network_locks', v_row.id::TEXT,
      jsonb_build_object('network', v_row.network::TEXT, 'locked_by', v_row.locked_by, 'locked_at', v_row.locked_at));
  END IF;
  RETURN jsonb_build_object('locked', FALSE, 'changed', v_row.organization_id IS NOT NULL);
END
$$;
REVOKE ALL ON FUNCTION public.unlock_clock_in_network() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlock_clock_in_network() TO authenticated;

-- ---- 6. Self-check before COMMIT --------------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF NOT (SELECT bool_and(c.relrowsecurity) AND count(*) = 2 FROM pg_class c
          WHERE c.oid IN ('public.clock_in_network_locks'::regclass, 'public.clock_in_network_unverified'::regclass)) THEN
    RAISE EXCEPTION '114: a table is missing or has row level security off';
  END IF;
  IF has_table_privilege('authenticated', 'public.clock_in_network_locks', 'INSERT') OR has_table_privilege('authenticated', 'public.clock_in_network_locks', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.clock_in_network_locks', 'DELETE')
     OR has_table_privilege('authenticated', 'public.clock_in_network_unverified', 'INSERT') OR has_table_privilege('authenticated', 'public.clock_in_network_unverified', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.clock_in_network_unverified', 'DELETE')
     OR has_table_privilege('anon', 'public.clock_in_network_locks', 'SELECT') OR has_table_privilege('anon', 'public.clock_in_network_unverified', 'SELECT') THEN
    RAISE EXCEPTION '114: an API role can write a lock table, or anon can read one';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.lock_clock_in_network()', 'public.unlock_clock_in_network()'] LOOP
    IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn))
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '114: % is not definer, pinned and signed-in only', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.clock_in_network_lock_check()', 'public.clock_in_network_unverified_record()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '114: % is callable by an API role', v_fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.attendance_events'::regclass AND tgenabled = 'O'
        AND tgname IN ('clock_in_network_lock', 'zz_clock_in_network_unverified')) <> 2 THEN
    RAISE EXCEPTION '114: the clock-in network triggers are not both on attendance_events';
  END IF;
END
$$;
