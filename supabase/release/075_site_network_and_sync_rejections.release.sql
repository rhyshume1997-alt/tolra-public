-- 075_site_network_and_sync_rejections.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 075: site network check, phase 1 (B40 / G21: RECORD AND FLAG ONLY, OFF by default) and refused late time actions made visible to the
-- office (G18). Needs 050, 051, 052. Applied after 074 (it changes nothing of 058 to 074).
--
-- PART A (B40 phase 1). A browser or phone app can't read the Wi-Fi name, so the only check is the public IP address a clock action
-- reaches the server from: every device on the site Wi-Fi goes out through the router's one public IP.
-- 1. site_network_settings: one row per company, the switch site_network_check ('off' | 'flag'). No row = 'off'. There is no 'refuse'
--    mode: phase 2 is a later migration, switched on only after a workshop test.
-- 2. site_networks: the company's allowed site networks (public IPv4 or IPv6 address or CIDR, e.g. 203.0.113.7/32, 2001:db8:1:2::/64),
--    each with a name. At most 20. Private, loopback, link-local and shared (CGNAT) ranges are refused (they are never what the server
--    sees), and so is anything broader than /16 (IPv4) or /32 (IPv6).
-- 3. site_network_members: per person, on_site_only (no row = FALSE). A fitter who works off site is simply not on-site-only, so never
--    flagged.
-- 4. attendance_event_networks: one row per clock action (050's attendance_events, source 'clock') that was CHECKED, written by an AFTER
--    INSERT trigger on attendance_events (050's functions are not replaced; the clock row itself is never changed: it is immutable).
--    Written ONLY when the company's switch is 'flag' AND the person is on-site-only; otherwise nothing at all is written, so with the
--    defaults (switch off) every clock action, its answer, its audit rows and every revision are exactly as before 075.
--      status 'on_site'      : the request's IP is inside one of the company's networks;
--      status 'off_site'     : it is not: off_site_network = TRUE (the flag the office sees). NEVER refused;
--      status 'synced_later' : the action reached the server more than 2 minutes after the device's time (it was queued offline and
--                              synced later, or the device clock is behind): the network it was made on is unknown, so it is NOT
--                              checked, NOT flagged, and no IP is kept;
--      status 'unknown'      : no client IP header on the request (not through the API gateway, e.g. the SQL editor): not flagged.
--    The IP is stored only for on_site and off_site (personal data: kept only for the people the company chose to check). The row's
--    audit copy (log_row_change) holds the IP too, in security_audit.audit_log: retention to be decided before activation.
--    The trigger never refuses a clock action: any error inside it is swallowed and the clock action is recorded without a check row.
-- 5. Which IP: public.request_client_ip() reads PostgREST's request.headers (current_setting('request.headers', true), set by the
--    server per request; a client cannot set a GUC) and takes ONLY 'cf-connecting-ip', the header Supabase's Cloudflare edge sets to the
--    address that connected to it. NOT x-forwarded-for: its first hop is whatever the client sent (Supabase discussion 34647 shows
--    "x-forwarded-for: spoofed,<real ip>" reaching PostgREST), and which later hop is the client depends on the proxy chain.
--    SPOOFING CAVEAT: cf-connecting-ip is only trustworthy if every request reaches PostgREST through Cloudflare, which overwrites it. That
--    can't be proved from a migration: before phase 2 (refuse) prove it on the real project (docs/RELEASE.md "075", pre-activation
--    check). Phase 1 only flags, so a spoofed header can hide a flag but never refuse or lose time. The device's own clock still decides
--    'synced_later' (a person who sets a phone's clock back gets 'synced later, network unknown', shown as such, never 'on site').
-- 6. Admin only (assert_privileged_aal, 050's time_caller_org, then the admin role), keyed with client_op_id (site_network_ops: the same
--    key and request answers the first result; the same key for something else is refused, client_op_reused), all audited:
--    set_site_network_check(key, mode), add_site_network(key, network, label) (network NULL = "use the network I'm on now": the request's
--    IP, /32 for IPv4, its /64 for IPv6), remove_site_network(key, id), set_member_on_site_only(key, person, on_site_only);
--    my_request_network() (read only: the IP this request comes from, as the server sees it, and whether it is a saved network).
--
-- PART B (G18). A clock or labour action queued on a device is refused at sync when its time falls in a week approved before it synced
-- (week_approved) or is more than 14 days old (time_too_old); until now that refusal stayed on the device.
-- 7. time_sync_rejections: one row per refused action the device reports (person, company, kind, action, intended time, code, key,
--    device-reported reason, job and device labels). Unique per company and key.
-- 8. report_time_sync_rejection(key, kind, action, at, code, reason, job, device): the caller's OWN refused action in their own company
--    (a signed-in admin, office or workshop member). Idempotent per key: the same key and request answers the first row (replayed); the
--    key for something else, or someone else's key, is refused (client_op_reused). The server checks the claim: an action it recorded
--    under that key is refused (op_applied); week_approved needs the time to fall in an approved week before that approval
--    (052's time_week_locked_at) and a caller who is not an admin (admins are never refused for an approved week); time_too_old needs
--    a time over 14 days ago; otherwise not_refused. Capped per person: 200 unresolved, 50 in 24 hours (too_many_rejections).
-- 9. resolve_time_sync_rejection(id, note): admin or office marks one resolved (who, when, note); a second call answers the row.
--
-- Read: networks, settings and the person flags: admin and office (the person also sees their own flag row); check rows and refused
-- actions: each person their own (admin, office, workshop), admin and office the company's; viewer none. No direct client writes.
-- SECURITY DEFINER, pinned search_path. Support read-only and admin two-step triggers as 050. Additive: six tables, one trigger on
-- attendance_events, sixteen functions (seven callable by signed-in members, nine internal); nothing existing is replaced. Forward only, safe to run
-- more than once. Rollback: docs/RELEASE.md "075".
-- =====================================================================================================

-- ---- 1. The company's switch ----------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_network_settings (
  organization_id    UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  id                 UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  site_network_check TEXT NOT NULL DEFAULT 'off' CHECK (site_network_check IN ('off', 'flag')),
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.site_network_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "site_network_settings rbac select" ON public.site_network_settings;
CREATE POLICY "site_network_settings rbac select" ON public.site_network_settings FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
REVOKE ALL ON public.site_network_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.site_network_settings TO authenticated;

-- ---- 2. The company's site networks ------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_networks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  network         CIDR NOT NULL,
  label           TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT site_networks_one_per_company UNIQUE (organization_id, network),
  CONSTRAINT site_networks_not_too_broad CHECK (masklen(network) >= CASE family(network) WHEN 4 THEN 16 ELSE 32 END)
);
ALTER TABLE public.site_networks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "site_networks rbac select" ON public.site_networks;
CREATE POLICY "site_networks rbac select" ON public.site_networks FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
REVOKE ALL ON public.site_networks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.site_networks TO authenticated;

-- ---- 3. Per person: on site only ----------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_network_members (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id              UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  on_site_only    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id)
);
ALTER TABLE public.site_network_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "site_network_members rbac select" ON public.site_network_members;
CREATE POLICY "site_network_members rbac select" ON public.site_network_members FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.site_network_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.site_network_members TO authenticated;

-- ---- 4. The check of each clock action (written by the trigger below) ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attendance_event_networks (
  event_id         UUID PRIMARY KEY REFERENCES public.attendance_events(id) ON DELETE RESTRICT,
  id               UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  organization_id  UUID NOT NULL REFERENCES public.organizations(id),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status           TEXT NOT NULL CHECK (status IN ('on_site', 'off_site', 'synced_later', 'unknown')),
  ip               INET,
  off_site_network BOOLEAN NOT NULL DEFAULT FALSE,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT attendance_event_networks_flag CHECK (off_site_network = (status = 'off_site')),
  CONSTRAINT attendance_event_networks_ip CHECK ((ip IS NOT NULL) = (status IN ('on_site', 'off_site')))
);
CREATE INDEX IF NOT EXISTS idx_attendance_event_networks_person ON public.attendance_event_networks (organization_id, user_id, checked_at);
ALTER TABLE public.attendance_event_networks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attendance_event_networks rbac select" ON public.attendance_event_networks;
CREATE POLICY "attendance_event_networks rbac select" ON public.attendance_event_networks FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.attendance_event_networks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.attendance_event_networks TO authenticated;
-- A check row is a record of what happened, never changed or removed (050's function: the same rule as the clock record itself).
DROP TRIGGER IF EXISTS attendance_event_networks_immutable ON public.attendance_event_networks;
CREATE TRIGGER attendance_event_networks_immutable BEFORE UPDATE OR DELETE ON public.attendance_event_networks
  FOR EACH ROW EXECUTE FUNCTION public.attendance_events_immutable();

-- ---- 5. Admin saves, keyed (no API role reads or writes it) ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_network_ops (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_op_id    UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('check', 'add', 'remove', 'member')),
  request         JSONB NOT NULL,
  result          JSONB NOT NULL,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, client_op_id)
);
ALTER TABLE public.site_network_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_network_ops FROM PUBLIC, anon, authenticated;

-- ---- 7. Refused late time actions, reported by the device ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.time_sync_rejections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  client_op_id    UUID NOT NULL,
  op_kind         TEXT NOT NULL CHECK (op_kind IN ('clock', 'labour')),
  action          TEXT NOT NULL,
  intended_at     TIMESTAMPTZ NOT NULL,
  code            TEXT NOT NULL CHECK (code IN ('week_approved', 'time_too_old')),
  device_reason   TEXT CHECK (device_reason IS NULL OR length(device_reason) <= 500),
  job_label       TEXT CHECK (job_label IS NULL OR length(job_label) <= 80),
  device_label    TEXT CHECK (device_label IS NULL OR length(device_label) <= 80),
  reported_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  CONSTRAINT time_sync_rejections_one_per_key UNIQUE (organization_id, client_op_id),
  CONSTRAINT time_sync_rejections_action CHECK ((op_kind = 'clock' AND action IN ('in', 'out', 'break_start', 'break_end'))
                                                OR (op_kind = 'labour' AND action IN ('start', 'stop'))),
  CONSTRAINT time_sync_rejections_resolved CHECK (resolved_by IS NULL OR resolved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_time_sync_rejections_open ON public.time_sync_rejections (organization_id, user_id, intended_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_time_sync_rejections_person_reported ON public.time_sync_rejections (organization_id, user_id, reported_at);
ALTER TABLE public.time_sync_rejections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "time_sync_rejections rbac select" ON public.time_sync_rejections;
CREATE POLICY "time_sync_rejections rbac select" ON public.time_sync_rejections FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.time_sync_rejections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.time_sync_rejections TO authenticated;

-- Audit (row changes: old and new, who), support read-only and admin two-step on every table 075 adds.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_network_settings', 'site_networks', 'site_network_members', 'attendance_event_networks', 'time_sync_rejections'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_' || t || '_changes', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change()', 'audit_' || t || '_changes', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['site_network_settings', 'site_networks', 'site_network_members', 'attendance_event_networks', 'site_network_ops', 'time_sync_rejections'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS support_read_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS admin_mfa ON public.%I', t);
    EXECUTE format('CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard()', t);
  END LOOP;
END
$$;

-- ---- Addresses ------------------------------------------------------------------------------------------------------------------------
-- A single host address from text, or NULL when it isn't one. An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is returned as IPv4. Internal.
CREATE OR REPLACE FUNCTION public.site_network_host(p_text TEXT)
RETURNS INET
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v INET;
BEGIN
  IF p_text IS NULL OR length(p_text) > 64 OR btrim(p_text) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v := btrim(p_text)::INET;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  IF masklen(v) <> (CASE family(v) WHEN 4 THEN 32 ELSE 128 END) THEN
    RETURN NULL;
  END IF;
  IF family(v) = 6 AND v << INET '::ffff:0.0.0.0/96' THEN
    v := INET '0.0.0.0' + (v - INET '::ffff:0.0.0.0');
  END IF;
  RETURN v;
END
$$;
REVOKE ALL ON FUNCTION public.site_network_host(TEXT) FROM PUBLIC, anon, authenticated;

-- TRUE for an address or range a public server never sees as a client, or one that doesn't name a site: private, loopback, link-local,
-- shared (CGNAT), IETF protocol assignments (192.0.0.0/24), benchmarking (198.18.0.0/15), NAT64 (64:ff9b::/96), 6to4 (2002::/16),
-- unique-local, unspecified, multicast and reserved. Internal.
CREATE OR REPLACE FUNCTION public.site_network_private(p_net INET)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM unnest(ARRAY['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
                                            '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3', '::/127', '64:ff9b::/96',
                                            '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8']::CIDR[]) r
                 WHERE family(r) = family(p_net) AND (p_net <<= r OR r <<= p_net))
$$;
REVOKE ALL ON FUNCTION public.site_network_private(INET) FROM PUBLIC, anon, authenticated;

-- A site network from text ('203.0.113.7', '203.0.113.0/28', '2001:db8:1:2::/64'): the network (host bits cleared). Refuses (22023) text
-- that is not an address (bad_network), a private range (private_network) or one broader than /16 or /32 (too_broad). Internal.
CREATE OR REPLACE FUNCTION public.site_network_parse(p_text TEXT)
RETURNS CIDR
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v INET;
BEGIN
  IF p_text IS NULL OR length(p_text) > 64 OR btrim(p_text) = '' THEN
    RAISE EXCEPTION 'Enter a public IP address, or a range such as 203.0.113.0/28.' USING ERRCODE = '22023', HINT = 'bad_network';
  END IF;
  BEGIN
    v := btrim(p_text)::INET;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Enter a public IP address, or a range such as 203.0.113.0/28.' USING ERRCODE = '22023', HINT = 'bad_network';
  END;
  -- An IPv4-mapped IPv6 address is saved as the IPv4 address (that is how the client's address is compared); a mapped range is refused.
  IF family(v) = 6 AND v <<= INET '::ffff:0.0.0.0/96' THEN
    IF masklen(v) <> 128 THEN
      RAISE EXCEPTION 'Enter an IPv4 range as IPv4, such as 203.0.113.0/28.' USING ERRCODE = '22023', HINT = 'bad_network';
    END IF;
    v := public.site_network_host(host(v));
  END IF;
  IF masklen(v) < (CASE family(v) WHEN 4 THEN 16 ELSE 32 END) THEN
    RAISE EXCEPTION 'That range is too broad (at most /16 for IPv4, /32 for IPv6).' USING ERRCODE = '22023', HINT = 'too_broad';
  END IF;
  IF public.site_network_private(v) THEN
    RAISE EXCEPTION 'That is a private or local address. Use the public address the site''s internet comes from (Use the network I''m on now).'
      USING ERRCODE = '22023', HINT = 'private_network';
  END IF;
  RETURN network(v);
END
$$;
REVOKE ALL ON FUNCTION public.site_network_parse(TEXT) FROM PUBLIC, anon, authenticated;

-- The client's public IP as the API gateway saw it: PostgREST's request.headers (server-set per request), header cf-connecting-ip only
-- (see the header note at the top). NULL when there is none or it isn't an address. Never raises. Internal.
CREATE OR REPLACE FUNCTION public.request_client_ip()
RETURNS INET
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_raw TEXT := current_setting('request.headers', TRUE);
  v_h   JSONB;
BEGIN
  IF v_raw IS NULL OR btrim(v_raw) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_h := v_raw::JSONB;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  IF jsonb_typeof(v_h) <> 'object' THEN
    RETURN NULL;
  END IF;
  RETURN public.site_network_host(v_h ->> 'cf-connecting-ip');
END
$$;
REVOKE ALL ON FUNCTION public.request_client_ip() FROM PUBLIC, anon, authenticated;

-- TRUE when the address is inside one of the company's site networks. Internal.
CREATE OR REPLACE FUNCTION public.site_network_matches(p_org UUID, p_ip INET)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p_ip IS NOT NULL AND EXISTS (SELECT 1 FROM public.site_networks n
                                      WHERE n.organization_id = p_org AND family(n.network) = family(p_ip) AND p_ip <<= n.network)
$$;
REVOKE ALL ON FUNCTION public.site_network_matches(UUID, INET) FROM PUBLIC, anon, authenticated;

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
DROP TRIGGER IF EXISTS zz_attendance_events_network ON public.attendance_events;
CREATE TRIGGER zz_attendance_events_network AFTER INSERT ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.attendance_events_network();

-- ---- 6. Admin: keyed saves ---------------------------------------------------------------------------------------------------------
-- The caller's company, for an admin (two-step where required). Internal.
CREATE OR REPLACE FUNCTION public.site_network_admin_org()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  IF NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can change the site network settings.' USING ERRCODE = '42501', HINT = 'admin_only';
  END IF;
  RETURN v_org;
END
$$;
REVOKE ALL ON FUNCTION public.site_network_admin_org() FROM PUBLIC, anon, authenticated;

-- The first answer for this key (the same request), or NULL when the key is new. Refuses a key used for something else. Called with the
-- company's lock held. Internal.
CREATE OR REPLACE FUNCTION public.site_network_replay(p_org UUID, p_client_op_id UUID, p_kind TEXT, p_request JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_op public.site_network_ops%ROWTYPE;
BEGIN
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'This save needs its key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  SELECT * INTO v_op FROM public.site_network_ops o WHERE o.organization_id = p_org AND o.client_op_id = p_client_op_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_op.kind = p_kind AND v_op.request = p_request THEN
    RETURN v_op.result || jsonb_build_object('replayed', TRUE);
  END IF;
  RAISE EXCEPTION 'This save''s key was already used for something else. Try again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
END
$$;
REVOKE ALL ON FUNCTION public.site_network_replay(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- Switch: 'off' (nothing is checked or recorded) or 'flag' (on-site-only people's clock actions are checked and flagged, never refused).
-- 'flag' needs at least one saved network.
CREATE OR REPLACE FUNCTION public.set_site_network_check(p_client_op_id UUID, p_mode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.site_network_admin_org();
  v_request JSONB := jsonb_build_object('mode', p_mode);
  v_replay  JSONB;
  v_before  TEXT;
  v_result  JSONB;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('off', 'flag') THEN
    RAISE EXCEPTION 'Choose off or flag.' USING ERRCODE = '22023', HINT = 'bad_mode';
  END IF;
  PERFORM public.time_company_lock(v_org);
  v_replay := public.site_network_replay(v_org, p_client_op_id, 'check', v_request);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;
  IF p_mode = 'flag' AND NOT EXISTS (SELECT 1 FROM public.site_networks n WHERE n.organization_id = v_org) THEN
    RAISE EXCEPTION 'Save the site network first.' USING ERRCODE = '22023', HINT = 'no_networks';
  END IF;
  SELECT s.site_network_check INTO v_before FROM public.site_network_settings s WHERE s.organization_id = v_org FOR UPDATE;
  v_before := coalesce(v_before, 'off');
  IF v_before IS DISTINCT FROM p_mode THEN
    INSERT INTO public.site_network_settings (organization_id, site_network_check, updated_by)
    VALUES (v_org, p_mode, auth.uid())
    ON CONFLICT (organization_id) DO UPDATE SET site_network_check = EXCLUDED.site_network_check, updated_by = EXCLUDED.updated_by,
                                                updated_at = clock_timestamp();
    PERFORM security_audit.log_named_event(v_org, 'SITE_NETWORK_CHECK_SET', 'site_network_settings', v_org::TEXT,
      jsonb_build_object('before', v_before, 'after', p_mode));
  END IF;
  v_result := jsonb_build_object('mode', p_mode, 'changed', v_before IS DISTINCT FROM p_mode);
  INSERT INTO public.site_network_ops (organization_id, client_op_id, kind, request, result, created_by)
  VALUES (v_org, p_client_op_id, 'check', v_request, v_result, auth.uid());
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.set_site_network_check(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_site_network_check(UUID, TEXT) TO authenticated;

-- Adds a site network. p_network NULL or empty: "use the network I'm on now" (this request's IP: /32 for IPv4, its /64 for IPv6;
-- ip_unknown when the server can't see it). Already saved: answers that row (added FALSE). At most 20 per company.
CREATE OR REPLACE FUNCTION public.add_site_network(p_client_op_id UUID, p_network TEXT, p_label TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.site_network_admin_org();
  v_label   TEXT := coalesce(nullif(btrim(p_label), ''), 'Site network');
  v_request JSONB := jsonb_build_object('network', nullif(btrim(p_network), ''), 'label', v_label);
  v_replay  JSONB;
  v_ip      INET;
  v_net     CIDR;
  v_row     public.site_networks%ROWTYPE;
  v_added   BOOLEAN := FALSE;
  v_result  JSONB;
BEGIN
  IF length(v_label) > 60 THEN
    RAISE EXCEPTION 'Keep the name to 60 characters.' USING ERRCODE = '22023', HINT = 'bad_label';
  END IF;
  PERFORM public.time_company_lock(v_org);
  v_replay := public.site_network_replay(v_org, p_client_op_id, 'add', v_request);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;
  IF nullif(btrim(p_network), '') IS NULL THEN
    v_ip := public.request_client_ip();
    IF v_ip IS NULL THEN
      RAISE EXCEPTION 'Tolra can''t see the network this request comes from. Enter the address instead.' USING ERRCODE = '22023', HINT = 'ip_unknown';
    END IF;
    v_net := public.site_network_parse(CASE family(v_ip) WHEN 4 THEN host(v_ip) || '/32' ELSE host(network(set_masklen(v_ip, 64))) || '/64' END);
  ELSE
    v_net := public.site_network_parse(p_network);
  END IF;
  SELECT * INTO v_row FROM public.site_networks n WHERE n.organization_id = v_org AND n.network = v_net;
  IF NOT FOUND THEN
    IF (SELECT count(*) FROM public.site_networks n WHERE n.organization_id = v_org) >= 20 THEN
      RAISE EXCEPTION 'A company can save at most 20 site networks. Remove one first.' USING ERRCODE = '22023', HINT = 'too_many';
    END IF;
    INSERT INTO public.site_networks (organization_id, network, label, created_by) VALUES (v_org, v_net, v_label, auth.uid())
    RETURNING * INTO v_row;
    v_added := TRUE;
    PERFORM security_audit.log_named_event(v_org, 'SITE_NETWORK_ADDED', 'site_networks', v_row.id::TEXT,
      jsonb_build_object('network', v_net::TEXT, 'label', v_label, 'from_this_request', v_ip IS NOT NULL));
  END IF;
  v_result := jsonb_build_object('id', v_row.id, 'network', v_row.network::TEXT, 'label', v_row.label, 'added', v_added);
  INSERT INTO public.site_network_ops (organization_id, client_op_id, kind, request, result, created_by)
  VALUES (v_org, p_client_op_id, 'add', v_request, v_result, auth.uid());
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.add_site_network(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_site_network(UUID, TEXT, TEXT) TO authenticated;

-- Removes a site network. The last one can't be removed while the check is on (switch it off first, or add the new one first).
CREATE OR REPLACE FUNCTION public.remove_site_network(p_client_op_id UUID, p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.site_network_admin_org();
  v_request JSONB := jsonb_build_object('id', p_id);
  v_replay  JSONB;
  v_row     public.site_networks%ROWTYPE;
  v_result  JSONB;
BEGIN
  PERFORM public.time_company_lock(v_org);
  v_replay := public.site_network_replay(v_org, p_client_op_id, 'remove', v_request);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;
  SELECT * INTO v_row FROM public.site_networks n WHERE n.organization_id = v_org AND n.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That site network was not found.' USING ERRCODE = 'P0002', HINT = 'network_missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.site_network_settings s WHERE s.organization_id = v_org AND s.site_network_check <> 'off')
     AND NOT EXISTS (SELECT 1 FROM public.site_networks n WHERE n.organization_id = v_org AND n.id <> p_id) THEN
    RAISE EXCEPTION 'This is the last site network and the check is on. Add the new one first, or switch the check off.' USING ERRCODE = '22023', HINT = 'last_network';
  END IF;
  DELETE FROM public.site_networks WHERE organization_id = v_org AND id = p_id;
  PERFORM security_audit.log_named_event(v_org, 'SITE_NETWORK_REMOVED', 'site_networks', v_row.id::TEXT,
    jsonb_build_object('network', v_row.network::TEXT, 'label', v_row.label));
  v_result := jsonb_build_object('id', v_row.id, 'network', v_row.network::TEXT, 'label', v_row.label, 'removed', TRUE);
  INSERT INTO public.site_network_ops (organization_id, client_op_id, kind, request, result, created_by)
  VALUES (v_org, p_client_op_id, 'remove', v_request, v_result, auth.uid());
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.remove_site_network(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_site_network(UUID, UUID) TO authenticated;

-- A person's "On site only" (TRUE) or "Can work off site" (FALSE, the default).
CREATE OR REPLACE FUNCTION public.set_member_on_site_only(p_client_op_id UUID, p_user UUID, p_on_site_only BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.site_network_admin_org();
  v_request JSONB := jsonb_build_object('user_id', p_user, 'on_site_only', p_on_site_only);
  v_replay  JSONB;
  v_before  BOOLEAN;
  v_result  JSONB;
BEGIN
  IF p_on_site_only IS NULL THEN
    RAISE EXCEPTION 'Choose on site only or can work off site.' USING ERRCODE = '22023', HINT = 'bad_flag';
  END IF;
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = v_org AND m.user_id = p_user AND NOT m.support) THEN
    RAISE EXCEPTION 'That person is not in this company.' USING ERRCODE = 'P0002', HINT = 'not_member';
  END IF;
  PERFORM public.time_company_lock(v_org);
  v_replay := public.site_network_replay(v_org, p_client_op_id, 'member', v_request);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;
  SELECT m.on_site_only INTO v_before FROM public.site_network_members m WHERE m.organization_id = v_org AND m.user_id = p_user FOR UPDATE;
  v_before := coalesce(v_before, FALSE);
  IF v_before IS DISTINCT FROM p_on_site_only THEN
    INSERT INTO public.site_network_members (organization_id, user_id, on_site_only, updated_by)
    VALUES (v_org, p_user, p_on_site_only, auth.uid())
    ON CONFLICT (organization_id, user_id) DO UPDATE SET on_site_only = EXCLUDED.on_site_only, updated_by = EXCLUDED.updated_by,
                                                         updated_at = clock_timestamp();
    PERFORM security_audit.log_named_event(v_org, 'MEMBER_ON_SITE_ONLY_SET', 'site_network_members', p_user::TEXT,
      jsonb_build_object('user_id', p_user, 'before', v_before, 'after', p_on_site_only));
  END IF;
  v_result := jsonb_build_object('user_id', p_user, 'on_site_only', p_on_site_only, 'changed', v_before IS DISTINCT FROM p_on_site_only);
  INSERT INTO public.site_network_ops (organization_id, client_op_id, kind, request, result, created_by)
  VALUES (v_org, p_client_op_id, 'member', v_request, v_result, auth.uid());
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.set_member_on_site_only(UUID, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_on_site_only(UUID, UUID, BOOLEAN) TO authenticated;

-- Read only, admin: the IP this request comes from as the server sees it (NULL when it can't), the network "Use the network I'm on now"
-- would save, and whether it is already inside a saved network. Also the pre-activation check (docs/RELEASE.md "075").
CREATE OR REPLACE FUNCTION public.my_request_network()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.site_network_admin_org();
  v_ip  INET := public.request_client_ip();
BEGIN
  RETURN jsonb_build_object(
    'ip', host(v_ip),
    'family', family(v_ip),
    'network', CASE WHEN v_ip IS NULL THEN NULL
                    WHEN family(v_ip) = 4 THEN host(v_ip) || '/32'
                    ELSE host(network(set_masklen(v_ip, 64))) || '/64' END,
    'private', CASE WHEN v_ip IS NULL THEN NULL ELSE public.site_network_private(v_ip) END,
    'on_saved_network', public.site_network_matches(v_org, v_ip),
    'header', 'cf-connecting-ip');
END
$$;
REVOKE ALL ON FUNCTION public.my_request_network() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_request_network() TO authenticated;

-- ---- 8. Report a refused late time action (the device, for the caller's own action) ------------------------------------------------
CREATE OR REPLACE FUNCTION public.time_sync_rejection_answer(p_row public.time_sync_rejections, p_replayed BOOLEAN)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('id', p_row.id, 'user_id', p_row.user_id, 'client_op_id', p_row.client_op_id, 'op_kind', p_row.op_kind,
                            'action', p_row.action, 'intended_at', p_row.intended_at, 'code', p_row.code, 'reported_at', p_row.reported_at,
                            'resolved_at', p_row.resolved_at, 'resolved_by', p_row.resolved_by, 'replayed', p_replayed)
$$;
REVOKE ALL ON FUNCTION public.time_sync_rejection_answer(public.time_sync_rejections, BOOLEAN) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.report_time_sync_rejection(p_client_op_id UUID, p_kind TEXT, p_action TEXT, p_at TIMESTAMPTZ, p_code TEXT,
                                                             p_reason TEXT DEFAULT NULL, p_job TEXT DEFAULT NULL, p_device TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
  v_row public.time_sync_rejections%ROWTYPE;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'The report needs the action''s key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  IF p_kind IS NULL OR NOT ((p_kind = 'clock' AND p_action IN ('in', 'out', 'break_start', 'break_end')) OR (p_kind = 'labour' AND p_action IN ('start', 'stop'))) THEN
    RAISE EXCEPTION 'Unknown time action.' USING ERRCODE = '22023', HINT = 'bad_action';
  END IF;
  IF p_code IS NULL OR p_code NOT IN ('week_approved', 'time_too_old') THEN
    RAISE EXCEPTION 'Only refusals for an approved week or a time over 14 days old are reported.' USING ERRCODE = '22023', HINT = 'bad_code';
  END IF;
  IF p_at IS NULL OR p_at < TIMESTAMPTZ '2020-01-01 00:00:00+00' OR p_at > now() + INTERVAL '1 day' THEN
    RAISE EXCEPTION 'Give the time the action was meant for.' USING ERRCODE = '22023', HINT = 'bad_time';
  END IF;
  -- Caps, checked BEFORE the company-wide lock (cheap, indexed, bounded counts) so a flood of reports can't queue behind clocking: at
  -- most 200 unresolved reports per person and 50 reported per person in 24 hours (54000, too_many_rejections; the device ignores it
  -- and still shows its refusal). A key already reported skips them: its replay is always answered. Two reports racing past a cap may
  -- exceed it by one or two; it is a brake, not a count.
  IF NOT EXISTS (SELECT 1 FROM public.time_sync_rejections r WHERE r.organization_id = v_org AND r.client_op_id = p_client_op_id)
     AND ((SELECT count(*) FROM (SELECT 1 FROM public.time_sync_rejections r
                                 WHERE r.organization_id = v_org AND r.user_id = v_uid AND r.resolved_at IS NULL LIMIT 200) o) >= 200
          OR (SELECT count(*) FROM (SELECT 1 FROM public.time_sync_rejections r
                                    WHERE r.organization_id = v_org AND r.user_id = v_uid AND r.reported_at > now() - INTERVAL '1 day' LIMIT 50) d) >= 50) THEN
    RAISE EXCEPTION 'Too many refused time actions reported from this login. Ask the office to look at the ones already reported.'
      USING ERRCODE = '54000', HINT = 'too_many_rejections';
  END IF;
  -- The company's audit-chain lock (every write here writes an audit row): one order with every other write of hours.
  PERFORM public.time_company_lock(v_org);
  SELECT * INTO v_row FROM public.time_sync_rejections r WHERE r.organization_id = v_org AND r.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_row.user_id = v_uid AND v_row.op_kind = p_kind AND v_row.action = p_action AND v_row.intended_at = p_at AND v_row.code = p_code THEN
      RETURN public.time_sync_rejection_answer(v_row, TRUE);
    END IF;
    RAISE EXCEPTION 'This report''s key was already used for something else.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;
  -- An action the server recorded under that key was not refused.
  IF EXISTS (SELECT 1 FROM public.attendance_events e WHERE e.organization_id = v_org AND e.client_op_id = p_client_op_id)
     OR EXISTS (SELECT 1 FROM public.labour_ops o WHERE o.organization_id = v_org AND o.client_op_id = p_client_op_id) THEN
    RAISE EXCEPTION 'That action was recorded, not refused.' USING ERRCODE = '22023', HINT = 'op_applied';
  END IF;
  -- The claim must be one the server would make now: a time in the caller's week approved after it (052; never for an admin, whom 050
  -- and 051 don't refuse for an approved week), or over 14 days old (050).
  IF (p_code = 'week_approved' AND (public.has_org_role(ARRAY['admin']) OR NOT public.time_week_locked_at(v_org, v_uid, p_at)))
     OR (p_code = 'time_too_old' AND p_at >= now() - INTERVAL '14 days') THEN
    RAISE EXCEPTION 'The server would not refuse that action for that reason.' USING ERRCODE = '22023', HINT = 'not_refused';
  END IF;
  INSERT INTO public.time_sync_rejections (organization_id, user_id, client_op_id, op_kind, action, intended_at, code, device_reason, job_label, device_label)
  VALUES (v_org, v_uid, p_client_op_id, p_kind, p_action, p_at, p_code, left(nullif(btrim(p_reason), ''), 500),
          left(nullif(btrim(p_job), ''), 80), left(nullif(btrim(p_device), ''), 80))
  RETURNING * INTO v_row;
  PERFORM security_audit.log_named_event(v_org, 'TIME_SYNC_REJECTION_REPORTED', 'time_sync_rejections', v_row.id::TEXT,
    jsonb_build_object('user_id', v_uid, 'kind', p_kind, 'action', p_action, 'at', p_at, 'code', p_code, 'client_op_id', p_client_op_id));
  RETURN public.time_sync_rejection_answer(v_row, FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.report_time_sync_rejection(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_time_sync_rejection(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ---- 9. The office marks one resolved (after adding it as a correction, or deciding it isn't needed) --------------------------------
CREATE OR REPLACE FUNCTION public.resolve_time_sync_rejection(p_id UUID, p_note TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID;
  v_row public.time_sync_rejections%ROWTYPE;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  IF NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only the office or an admin can mark this resolved.' USING ERRCODE = '42501', HINT = 'office_only';
  END IF;
  IF length(btrim(coalesce(p_note, ''))) > 500 THEN
    RAISE EXCEPTION 'Keep the note to 500 characters.' USING ERRCODE = '22023', HINT = 'bad_note';
  END IF;
  PERFORM public.time_company_lock(v_org);
  SELECT * INTO v_row FROM public.time_sync_rejections r WHERE r.organization_id = v_org AND r.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That refused action was not found.' USING ERRCODE = 'P0002', HINT = 'rejection_missing';
  END IF;
  IF v_row.resolved_at IS NOT NULL THEN
    RETURN public.time_sync_rejection_answer(v_row, TRUE);
  END IF;
  UPDATE public.time_sync_rejections SET resolved_at = clock_timestamp(), resolved_by = auth.uid(), resolution_note = nullif(btrim(p_note), '')
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  PERFORM security_audit.log_named_event(v_org, 'TIME_SYNC_REJECTION_RESOLVED', 'time_sync_rejections', v_row.id::TEXT,
    jsonb_build_object('user_id', v_row.user_id, 'action', v_row.action, 'at', v_row.intended_at, 'code', v_row.code, 'note', v_row.resolution_note));
  RETURN public.time_sync_rejection_answer(v_row, FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.resolve_time_sync_rejection(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_time_sync_rejection(UUID, TEXT) TO authenticated;

COMMIT;
