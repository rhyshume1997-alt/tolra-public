-- 128_workshop_network.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 128: Settings > Workshop network (G21 / B40; Rhys's in-app IP capture). Rename a saved workshop network, and keep a short record of
-- the online clock actions 114's network lock refused, so the admin's "unrecognised network" banner sees them too. Needs 075 (site
-- networks, the keyed admin saves, the request's address), 078 (the 30-day address retention and its purge) and 114 (the lock).
-- NOTHING IS SWITCHED ON: no default, no switch, no lock and no exception changes. 075's Flag check stays off and 114's lock stays
-- unlocked unless an admin presses them (B40 activation is Rhys-only). Applied after 122 (it touches none of 115 to 122's objects).
--
-- WHAT IT ADDS OR CHANGES.
--   a. public.site_network_ops.kind (075's keyed admin saves): the CHECK also allows 'rename'. Nothing else of the table changes.
--   b. public.clock_in_network_refusals: one row per online clock action 114 REFUSED (clock_in_network_lock_check raises, so the clock
--      row and anything written with it are rolled back: the device reports the refusal straight after, see c). Company, person, the
--      action's key and action, the time, status 'refused_unrecognised' and the request's address (ip). The address is kept for 078's
--      30 days (site_network_ip_retention) and then set to NULL by the same purge as every other clock-in address (d); the rest of the
--      row stays. NOT audited (row changes would copy the address into the hash-chained audit log, which can never be purged), as
--      078's attendance_event_network_ips. Read: the company's ADMINS only (row rule); nobody else, no other company. No API writes.
--      Support read-only and the admin second step, as 075's and 078's tables.
--   c. public.record_clock_in_refusal(key, action): the caller's own refused clock action, in the caller's company (050's
--      time_caller_org: admin, office, workshop). The database decides, never the device: it records ONLY when, at this request, the
--      company is locked (114), the caller is not allowed off site (114's exception), the request has a client address (075's
--      request_client_ip: cf-connecting-ip, set by the server) and that address is inside neither the locked network nor a saved site
--      network; otherwise not_refused and nothing is written. A key already recorded answers the first record (replayed); a key the
--      server recorded as a clock action is op_applied. At most 30 per person per hour (too_many_refusals). Expired addresses of the
--      company are cleared first (as 078's clock trigger does).
--   d. public.site_network_ip_purge(company, limit) (078's, internal; the ip-purge cron and every clock action call it): 078's body,
--      then the company's refusal addresses past the retention period are set to NULL (oldest first, at most limit, rows another
--      transaction holds skipped). Returns both counts added up. public.purge_site_network_ips(all) (078's, admin): 078's body; with
--      all, every refusal address of the company is cleared too. Same names, signatures, security, search_path and grants as 078.
--   e. public.rename_site_network(key, id, label): admin only, second step where required (075's site_network_admin_org), the
--      caller's company only, under the company's lock, keyed (075's site_network_replay: the same key and request answer the first
--      result; another request under the key is client_op_reused). The label is trimmed, 1 to 60 characters (bad_label). Audited
--      (SITE_NETWORK_RENAMED: network, before, after) when the name changes. The network itself never changes.
-- AFTER 128, 078's verify row only_admin_adds_site_networks reads FALSE by design (rename_site_network also updates site_networks, the
-- label only); 128's verify restates the rule as only_admin_saves_site_networks. No other earlier verify row changes.
-- GUARD (section 0): 075, 078 and 114 are there, and 078's two purge functions are 078's (or already this file's), md5 with every
-- whitespace character removed. Safe to run more than once. SELF-CHECK (section 6). Verify: supabase/verify/workshop_network_128.sql
-- (every row TRUE). Rollback: supabase/release/128_workshop_network.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 0. Needs 075, 078 and 114; 078's purge functions are 078's (or already this file's).
DO $$
DECLARE
  v_purge TEXT;
  v_admin TEXT;
BEGIN
  IF to_regclass('public.site_networks') IS NULL OR to_regclass('public.site_network_ops') IS NULL
     OR to_regprocedure('public.site_network_admin_org()') IS NULL OR to_regprocedure('public.site_network_replay(uuid,uuid,text,jsonb)') IS NULL
     OR to_regprocedure('public.request_client_ip()') IS NULL OR to_regprocedure('public.site_network_matches(uuid,inet)') IS NULL THEN
    RAISE EXCEPTION '128 needs 075 (site network check) applied first';
  END IF;
  IF to_regclass('public.attendance_event_network_ips') IS NULL OR to_regprocedure('public.site_network_ip_retention()') IS NULL THEN
    RAISE EXCEPTION '128 needs 078 (clock-in address retention) applied first';
  END IF;
  IF to_regclass('public.clock_in_network_locks') IS NULL OR to_regclass('public.clock_in_network_exemptions') IS NULL THEN
    RAISE EXCEPTION '128 needs 114 (clock-in network lock) applied first';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_purge FROM pg_proc p WHERE p.oid = to_regprocedure('public.site_network_ip_purge(uuid,integer)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_admin FROM pg_proc p WHERE p.oid = to_regprocedure('public.purge_site_network_ips(boolean)');
  -- 207f4845...: 078's site_network_ip_purge; 53348dc9...: this file's (section 4).
  IF v_purge IS NULL OR v_purge NOT IN ('207f4845dd9e5280fa752b7b6d69457a', '53348dc930741ac3eae1ec3258337871') THEN
    RAISE EXCEPTION '128: public.site_network_ip_purge is not 078''s (md5 without whitespace %); stop and compare it first', coalesce(v_purge, 'missing');
  END IF;
  -- c0c228c4...: 078's purge_site_network_ips; 8bf4c2db...: this file's (section 4).
  IF v_admin IS NULL OR v_admin NOT IN ('c0c228c4e802c773c1bee3885bd6caad', '8bf4c2dbdb1b11618cabc6a1520ebd75') THEN
    RAISE EXCEPTION '128: public.purge_site_network_ips is not 078''s (md5 without whitespace %); stop and compare it first', coalesce(v_admin, 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 1. The keyed admin saves (075) also take 'rename'. The existing rows all pass (the list only grows).
ALTER TABLE public.site_network_ops DROP CONSTRAINT IF EXISTS site_network_ops_kind_check;
ALTER TABLE public.site_network_ops ADD CONSTRAINT site_network_ops_kind_check CHECK (kind IN ('check', 'add', 'remove', 'member', 'rename'));

-- -----------------------------------------------------------------------------------------------------
-- 2. Online clock actions the lock refused (the address kept 078's 30 days, then cleared; the rest kept).
CREATE TABLE IF NOT EXISTS public.clock_in_network_refusals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_op_id    UUID NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('in', 'out', 'break_start', 'break_end')),
  status          TEXT NOT NULL DEFAULT 'refused_unrecognised' CHECK (status = 'refused_unrecognised'),
  ip              INET,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT clock_in_network_refusals_one_per_key UNIQUE (organization_id, client_op_id)
);
CREATE INDEX IF NOT EXISTS idx_clock_in_network_refusals_at ON public.clock_in_network_refusals (organization_id, attempted_at);
CREATE INDEX IF NOT EXISTS idx_clock_in_network_refusals_person ON public.clock_in_network_refusals (organization_id, user_id, attempted_at);
CREATE INDEX IF NOT EXISTS idx_clock_in_network_refusals_ip_expiry ON public.clock_in_network_refusals (organization_id, attempted_at) WHERE ip IS NOT NULL;
ALTER TABLE public.clock_in_network_refusals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clock_in_network_refusals admin select" ON public.clock_in_network_refusals;
CREATE POLICY "clock_in_network_refusals admin select" ON public.clock_in_network_refusals FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.clock_in_network_refusals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.clock_in_network_refusals TO authenticated;
-- Support read-only and the admin second step, as 075's and 078's tables. Deliberately NO audit trigger (the address must never reach the
-- hash-chained audit log) and NO immutability trigger (the address is cleared when it expires).
DROP TRIGGER IF EXISTS support_read_only ON public.clock_in_network_refusals;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.clock_in_network_refusals
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.clock_in_network_refusals;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.clock_in_network_refusals
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- The answer for one refusal row (never the address). Internal.
CREATE OR REPLACE FUNCTION public.clock_in_refusal_answer(p_row public.clock_in_network_refusals, p_replayed BOOLEAN)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('id', p_row.id, 'user_id', p_row.user_id, 'client_op_id', p_row.client_op_id, 'action', p_row.action,
                            'status', p_row.status, 'attempted_at', p_row.attempted_at, 'recorded', TRUE, 'replayed', p_replayed)
$$;
REVOKE ALL ON FUNCTION public.clock_in_refusal_answer(public.clock_in_network_refusals, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- Clears the company's refusal addresses older than the retention period (078's), oldest first, at most p_limit (NULL: all of them).
-- Rows another transaction holds are skipped (never waited for). Returns how many it cleared. Internal.
CREATE OR REPLACE FUNCTION public.clock_in_refusal_ip_purge(p_org UUID, p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE public.clock_in_network_refusals d SET ip = NULL
  WHERE d.id IN (SELECT r.id FROM public.clock_in_network_refusals r
                 WHERE r.organization_id = p_org AND r.ip IS NOT NULL AND r.attempted_at < now() - public.site_network_ip_retention()
                 ORDER BY r.attempted_at
                 LIMIT p_limit
                 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.clock_in_refusal_ip_purge(UUID, INTEGER) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. The device reports its own refused clock action; the database re-checks that 114 would refuse it now, from this request.
CREATE OR REPLACE FUNCTION public.record_clock_in_refusal(p_client_op_id UUID, p_action TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
  v_net CIDR;
  v_ip  INET;
  v_row public.clock_in_network_refusals%ROWTYPE;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'The report needs the clock action''s key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('in', 'out', 'break_start', 'break_end') THEN
    RAISE EXCEPTION 'Unknown clock action.' USING ERRCODE = '22023', HINT = 'bad_action';
  END IF;
  SELECT * INTO v_row FROM public.clock_in_network_refusals r WHERE r.organization_id = v_org AND r.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_row.user_id = v_uid AND v_row.action = p_action THEN
      RETURN public.clock_in_refusal_answer(v_row, TRUE);
    END IF;
    RAISE EXCEPTION 'This report''s key was already used for something else.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;
  -- A brake, not a count: two reports racing past it may exceed it by one or two.
  IF (SELECT count(*) FROM (SELECT 1 FROM public.clock_in_network_refusals r
                            WHERE r.organization_id = v_org AND r.user_id = v_uid AND r.attempted_at > now() - INTERVAL '1 hour' LIMIT 30) h) >= 30 THEN
    RAISE EXCEPTION 'Too many refused clock actions reported from this login in the last hour.' USING ERRCODE = '54000', HINT = 'too_many_refusals';
  END IF;
  IF EXISTS (SELECT 1 FROM public.attendance_events e WHERE e.organization_id = v_org AND e.client_op_id = p_client_op_id) THEN
    RAISE EXCEPTION 'That clock action was recorded, not refused.' USING ERRCODE = '22023', HINT = 'op_applied';
  END IF;
  -- 114's rule, for this request: locked, the person not allowed off site, an address seen, outside the locked and the saved networks.
  SELECT l.network INTO v_net FROM public.clock_in_network_locks l WHERE l.organization_id = v_org;
  v_ip := public.request_client_ip();
  IF v_net IS NULL
     OR EXISTS (SELECT 1 FROM public.clock_in_network_exemptions x WHERE x.organization_id = v_org AND x.user_id = v_uid AND x.off_site_allowed)
     OR v_ip IS NULL
     OR (family(v_ip) = family(v_net) AND v_ip <<= v_net) OR public.site_network_matches(v_org, v_ip) THEN
    RAISE EXCEPTION 'The network lock would not refuse a clock action from here.' USING ERRCODE = '22023', HINT = 'not_refused';
  END IF;
  -- The company's expired refusal addresses go first (078's rule for every clock-in address). A failed purge never stops the record.
  BEGIN
    IF EXISTS (SELECT 1 FROM public.clock_in_network_refusals r
               WHERE r.organization_id = v_org AND r.ip IS NOT NULL AND r.attempted_at < now() - public.site_network_ip_retention()) THEN
      PERFORM public.clock_in_refusal_ip_purge(v_org, 500);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  INSERT INTO public.clock_in_network_refusals (organization_id, user_id, client_op_id, action, ip)
  VALUES (v_org, v_uid, p_client_op_id, p_action, v_ip)
  ON CONFLICT (organization_id, client_op_id) DO NOTHING
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    -- The same key reported at the same moment by another request: answer that record.
    SELECT * INTO v_row FROM public.clock_in_network_refusals r WHERE r.organization_id = v_org AND r.client_op_id = p_client_op_id;
    IF v_row.user_id = v_uid AND v_row.action = p_action THEN
      RETURN public.clock_in_refusal_answer(v_row, TRUE);
    END IF;
    RAISE EXCEPTION 'This report''s key was already used for something else.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;
  RETURN public.clock_in_refusal_answer(v_row, FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.record_clock_in_refusal(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_clock_in_refusal(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. The same retention and purge as every clock-in address (078): the cron, each clock action and the admin's Delete buttons.
-- 078's site_network_ip_purge, then the company's expired refusal addresses. Returns both counts added up (the cron calls again while a
-- call returns its limit, so it carries on until both are done). Internal.
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
  -- 128: the addresses of refused clock actions, under the same retention.
  RETURN v_n + public.clock_in_refusal_ip_purge(p_org, p_limit);
END
$$;
REVOKE ALL ON FUNCTION public.site_network_ip_purge(UUID, INTEGER) FROM PUBLIC, anon, authenticated;

-- 078's purge_site_network_ips; with p_all the company's refusal addresses are cleared too (the refusal rows stay, without the address).
CREATE OR REPLACE FUNCTION public.purge_site_network_ips(p_all BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.site_network_admin_org();
  v_n   INTEGER;
  v_r   INTEGER;
BEGIN
  IF p_all IS NULL THEN
    RAISE EXCEPTION 'Choose expired addresses or all of them.' USING ERRCODE = '22023', HINT = 'bad_flag';
  END IF;
  PERFORM public.time_company_lock(v_org);
  IF p_all THEN
    DELETE FROM public.attendance_event_network_ips i WHERE i.organization_id = v_org;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    -- 128: every refusal address of the company too.
    UPDATE public.clock_in_network_refusals r SET ip = NULL WHERE r.organization_id = v_org AND r.ip IS NOT NULL;
    GET DIAGNOSTICS v_r = ROW_COUNT;
    v_n := v_n + v_r;
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
-- 5. Rename a saved workshop network (admin, two-step, keyed, audited). The address never changes.
CREATE OR REPLACE FUNCTION public.rename_site_network(p_client_op_id UUID, p_id UUID, p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.site_network_admin_org();
  v_label   TEXT := btrim(p_label);
  v_request JSONB;
  v_replay  JSONB;
  v_row     public.site_networks%ROWTYPE;
  v_result  JSONB;
BEGIN
  IF v_label IS NULL OR length(v_label) < 1 OR length(v_label) > 60 THEN
    RAISE EXCEPTION 'Give the network a name of 1 to 60 characters.' USING ERRCODE = '22023', HINT = 'bad_label';
  END IF;
  v_request := jsonb_build_object('id', p_id, 'label', v_label);
  PERFORM public.time_company_lock(v_org);
  v_replay := public.site_network_replay(v_org, p_client_op_id, 'rename', v_request);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;
  SELECT * INTO v_row FROM public.site_networks n WHERE n.organization_id = v_org AND n.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That site network was not found.' USING ERRCODE = 'P0002', HINT = 'network_missing';
  END IF;
  IF v_row.label IS DISTINCT FROM v_label THEN
    UPDATE public.site_networks SET label = v_label WHERE organization_id = v_org AND id = p_id;
    PERFORM security_audit.log_named_event(v_org, 'SITE_NETWORK_RENAMED', 'site_networks', v_row.id::TEXT,
      jsonb_build_object('network', v_row.network::TEXT, 'before', v_row.label, 'after', v_label));
  END IF;
  v_result := jsonb_build_object('id', v_row.id, 'network', v_row.network::TEXT, 'label', v_label, 'renamed', v_row.label IS DISTINCT FROM v_label);
  INSERT INTO public.site_network_ops (organization_id, client_op_id, kind, request, result, created_by)
  VALUES (v_org, p_client_op_id, 'rename', v_request, v_result, auth.uid());
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.rename_site_network(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_site_network(UUID, UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 6. Self-check before COMMIT (the same checks as supabase/verify/workshop_network_128.sql).
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.clock_in_network_refusals'::regclass) THEN
    RAISE EXCEPTION '128: clock_in_network_refusals has row level security off';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
             WHERE has_table_privilege(r, 'public.clock_in_network_refusals', p))
     OR has_table_privilege('anon', 'public.clock_in_network_refusals', 'SELECT') THEN
    RAISE EXCEPTION '128: an API role can write clock_in_network_refusals, or anon can read it';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'public.clock_in_network_refusals'::regclass AND NOT g.tgisinternal
               AND g.tgname NOT IN ('support_read_only', 'admin_mfa')) THEN
    RAISE EXCEPTION '128: clock_in_network_refusals has a trigger other than support_read_only and admin_mfa (an audit trigger would keep the address)';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.rename_site_network(uuid,uuid,text)', 'public.record_clock_in_refusal(uuid,text)', 'public.purge_site_network_ips(boolean)'] LOOP
    IF (SELECT NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
               OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
               OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) IS NOT FALSE THEN
      RAISE EXCEPTION '128: % is not definer, pinned and signed-in only', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.site_network_ip_purge(uuid,integer)', 'public.clock_in_refusal_ip_purge(uuid,integer)',
                              'public.clock_in_refusal_answer(clock_in_network_refusals,boolean)'] LOOP
    IF (SELECT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
               OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) IS NOT FALSE THEN
      RAISE EXCEPTION '128: % is not internal (invoker, pinned, no API role)', v_fn;
    END IF;
  END LOOP;
  IF NOT (SELECT pg_get_constraintdef(c.oid) LIKE '%''rename''%' FROM pg_constraint c
          WHERE c.conrelid = 'public.site_network_ops'::regclass AND c.conname = 'site_network_ops_kind_check') THEN
    RAISE EXCEPTION '128: site_network_ops.kind does not allow rename';
  END IF;
END
$$;

COMMIT;
