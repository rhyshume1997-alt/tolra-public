-- Post-144 release step 167 (modules F and G of the platform owner area: an owner-only Roadmap list and owner-only Rollouts of the existing per-company
-- feature switches; registered in supabase/release-plan.json as phase 167, after 164; CI's post-144 step installs it). One transaction; never part of
-- baseline replay. Not applied anywhere hosted. Canonical source: supabase/proposals/p167_roadmap_rollouts.sql (its body between BEGIN; and COMMIT; is
-- copied below verbatim; scripts/check-release-plan.mjs fails if they drift).
-- WHAT IT DOES: adds TWO tables (public.platform_roadmap_items, public.platform_rollout_log) and SEVEN functions (platform_roadmap_list, _save, _move,
-- platform_rollout_overview, platform_rollout_apply, and two internal helpers). Both tables have row security on and NO grant to any API role: the
-- screens read and write only through the functions. The rollout log is append-only (update, delete and truncate are refused for everyone).
-- WHAT IT DOES NOT DO: nothing is switched on (no company's hidden_nav, setting or data is read or changed by this file); no existing table, column,
-- policy, trigger or function is created, changed or dropped; no AI, no e-mail, no Xero. The app screens are off by default behind the server flags
-- PLATFORM_ROADMAP_ENABLED and PLATFORM_ROLLOUTS_ENABLED (exactly "true").
-- HOW IT BEHAVES: the roadmap and overview functions are SECURITY DEFINER and run for a signed-in platform owner only (is_platform_admin, aal2, and for
-- writes not a read-only support session); anon and PUBLIC cannot execute them. platform_rollout_apply is service-role only (the company's own guard on
-- organization_settings.hidden_nav lets only that company's admin change it for a signed-in caller): it accepts only six existing markers
-- (reports:on, reports-revenue:on, iso-templates:on, job-time-variance:on, job-ncr-register:on, tooly-admin-tour:on), changes only that one marker in
-- hidden_nav, turns on only for active companies, writes nothing for a company already in the wanted state, and writes one log row, all in one transaction.
-- STATE is judged by the objects: ABSENT (neither table and none of the seven functions): the release applies. INSTALLED (both tables with the expected
-- columns and the seven functions with the expected bodies, whitespace ignored): running again changes nothing. DRIFTED (anything else): the file REFUSES
-- with a message and changes nothing.
-- Verify: supabase/verify/roadmap_rollouts_167.sql (every row true). Rollback: supabase/release/167_roadmap_rollouts.rollback.sql (drops only these two
-- tables and seven functions, and REFUSES while either table holds a row). Production only with Rhys's separate yes on this exact file after a fresh backup.
-- Inputs: the database. Outputs: two tables, seven functions. Must not change: any other function (the self-check compares a fingerprint of every other
-- function in public and security_audit, with grants, before and after), organizations, and organization_settings (columns, constraints, triggers,
-- policies, grants, row security and every row).
BEGIN;
DO $post_release_guard$
DECLARE
  v_tables INTEGER := (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('platform_roadmap_items', 'platform_rollout_log') AND c.relkind = 'r');
  v_fns    INTEGER := (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply'));
BEGIN
 IF to_regclass('public.organizations') IS NULL OR to_regclass('public.organization_settings') IS NULL THEN
  RAISE EXCEPTION '167: public.organizations or public.organization_settings is missing; stop and run release preflight';
 END IF;
 IF to_regclass('security_audit.platform_admins') IS NULL OR to_regprocedure('public.is_platform_admin()') IS NULL OR to_regprocedure('public.assert_platform_aal()') IS NULL
    OR to_regprocedure('public.session_read_only()') IS NULL THEN
  RAISE EXCEPTION '167: a helper it calls (platform_admins, is_platform_admin, assert_platform_aal or session_read_only, from migration 036) is missing; stop and run release preflight';
 END IF;
 IF v_tables = 0 AND v_fns = 0 THEN
  RETURN; -- ABSENT: apply
 END IF;
 IF v_tables = 2 AND v_fns = 7 AND (SELECT md5(string_agg(md5(regexp_replace(p.prosrc, '\s', '', 'g')), '' ORDER BY p.proname)) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply')) = 'ec318b0a585fdf72cbbb60a0f49f70e6'
    AND (SELECT md5(string_agg(concat_ws('|', c.table_name, c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.table_name, c.ordinal_position)) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('platform_roadmap_items', 'platform_rollout_log')) = '49a0d757be4df0ee3b1101c0b2b1f74d' THEN
  RETURN; -- INSTALLED: the body below recreates identical objects (IF NOT EXISTS, OR REPLACE) and changes nothing
 END IF;
 RAISE EXCEPTION '167: some of its tables or functions exist but are not 167''s (columns or bodies differ, or only some are present); stop and compare them first, nothing was changed';
END $post_release_guard$;

-- Before: a fingerprint of everything 167 must not touch. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p167_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p167fp$
  SELECT 'every other function (name, args, security, config, body, grants)'::TEXT,
         md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), p.prosecdef::TEXT, coalesce(p.proconfig::TEXT, ''), md5(p.prosrc), coalesce(p.proacl::TEXT, ''))), '' ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), ''))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND NOT (n.nspname = 'public' AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 'organization_settings: columns',
         md5(coalesce(string_agg(concat_ws('|', c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.ordinal_position), ''))
  FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'organization_settings'
  UNION ALL SELECT 'organization_settings: constraints',
         md5(coalesce(string_agg(concat_ws('|', k.conname, pg_catalog.pg_get_constraintdef(k.oid)), ';' ORDER BY k.conname), ''))
  FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.organization_settings'::regclass
  UNION ALL SELECT 'organization_settings: triggers',
         md5(coalesce(string_agg(concat_ws('|', t.tgname, t.tgenabled::TEXT, pg_catalog.pg_get_triggerdef(t.oid)), ';' ORDER BY t.tgname), ''))
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.organization_settings'::regclass
  UNION ALL SELECT 'organization_settings: policies',
         md5(coalesce(string_agg(concat_ws('|', p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, '')), ';' ORDER BY p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'organization_settings'
  UNION ALL SELECT 'organization_settings: row security, owner, grants',
         coalesce(string_agg(c.relname || '|' || c.relrowsecurity::TEXT || '|' || c.relforcerowsecurity::TEXT || '|' || c.relowner::regrole::TEXT || '|' || coalesce(c.relacl::TEXT, ''), ';' ORDER BY c.relname), '')
  FROM pg_catalog.pg_class c WHERE c.oid = 'public.organization_settings'::regclass
  UNION ALL SELECT 'organization_settings rows', md5(coalesce(string_agg(to_jsonb(s)::TEXT, ';' ORDER BY s.organization_id), ''))
  FROM public.organization_settings s
  UNION ALL SELECT 'organizations rows', md5(coalesce(string_agg(to_jsonb(o)::TEXT, ';' ORDER BY o.id), ''))
  FROM public.organizations o
$p167fp$;
CREATE TEMP TABLE p167_before ON COMMIT DROP AS SELECT * FROM pg_temp.p167_fingerprint();

-- ---- Canonical body (supabase/proposals/p167_roadmap_rollouts.sql, unchanged) ----
-- ---- Module F: the roadmap list (platform owner only; no browser grant of any kind, every read and write goes through the functions below) ----
CREATE TABLE IF NOT EXISTS public.platform_roadmap_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  status      TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'planned', 'building', 'shipped')),
  sort_order  INTEGER NOT NULL,
  target_kind TEXT NOT NULL DEFAULT 'all' CHECK (target_kind IN ('one', 'few', 'all')),
  target_orgs UUID[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID,
  CONSTRAINT platform_roadmap_target_shape CHECK (
    (target_kind = 'all' AND cardinality(target_orgs) = 0)
    OR (target_kind = 'one' AND cardinality(target_orgs) = 1)
    OR (target_kind = 'few' AND cardinality(target_orgs) BETWEEN 2 AND 50)),
  CONSTRAINT platform_roadmap_shipped_date CHECK ((status = 'shipped') = (shipped_at IS NOT NULL))
);
ALTER TABLE public.platform_roadmap_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_roadmap_items FROM PUBLIC, anon, authenticated, service_role;

-- ---- Module G: the rollout log (append-only: no update, delete or truncate, by anyone) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_rollout_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id       UUID NOT NULL,
  actor_email    TEXT NOT NULL CHECK (char_length(actor_email) BETWEEN 1 AND 254),
  switch_marker  TEXT NOT NULL,
  turned_on      BOOLEAN NOT NULL,
  phase          TEXT NOT NULL DEFAULT '' CHECK (char_length(phase) <= 60),
  org_ids        UUID[] NOT NULL CHECK (cardinality(org_ids) BETWEEN 1 AND 200),
  org_names      TEXT[] NOT NULL,
  changed_org_ids UUID[] NOT NULL
);
ALTER TABLE public.platform_rollout_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_rollout_log FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.platform_rollout_log_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'The rollout log is append-only' USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION public.platform_rollout_log_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS platform_rollout_log_guard ON public.platform_rollout_log;
CREATE TRIGGER platform_rollout_log_guard BEFORE UPDATE OR DELETE ON public.platform_rollout_log
  FOR EACH ROW EXECUTE FUNCTION public.platform_rollout_log_guard();
DROP TRIGGER IF EXISTS platform_rollout_log_no_truncate ON public.platform_rollout_log;
CREATE TRIGGER platform_rollout_log_no_truncate BEFORE TRUNCATE ON public.platform_rollout_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.platform_rollout_log_guard();

-- ---- The owner check every signed-in function starts with (internal; no API role can call it) -----------------------------------------------
CREATE OR REPLACE FUNCTION public._platform_owner_check(p_write BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501', HINT = 'platform_required';
  END IF;
  PERFORM public.assert_platform_aal();
  IF p_write AND public.session_read_only() THEN
    RAISE EXCEPTION 'Support access is read-only. Ask for write access first.' USING ERRCODE = '42501', HINT = 'support_read_only';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public._platform_owner_check(BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.platform_roadmap_list()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public._platform_owner_check(FALSE);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'description', r.description, 'status', r.status,
                     'sort_order', r.sort_order, 'target_kind', r.target_kind, 'target_orgs', to_jsonb(r.target_orgs),
                     'created_at', r.created_at, 'shipped_at', r.shipped_at) ORDER BY r.sort_order, r.id)
                   FROM public.platform_roadmap_items r), '[]'::JSONB);
END
$$;
REVOKE ALL ON FUNCTION public.platform_roadmap_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_roadmap_list() TO authenticated;

-- Create (p_id null, added at the bottom) or change one item. A shipped date is set when the status becomes shipped and cleared when it leaves it.
CREATE OR REPLACE FUNCTION public.platform_roadmap_save(p_id UUID, p_title TEXT, p_description TEXT, p_status TEXT, p_target_kind TEXT, p_target_orgs UUID[])
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_title  TEXT := btrim(coalesce(p_title, ''));
  v_orgs   UUID[] := coalesce(p_target_orgs, '{}');
  v_id     UUID;
BEGIN
  PERFORM public._platform_owner_check(TRUE);
  IF char_length(v_title) NOT BETWEEN 1 AND 120 OR char_length(coalesce(p_description, '')) > 1000
     OR p_status IS NULL OR p_status NOT IN ('idea', 'planned', 'building', 'shipped')
     OR p_target_kind IS NULL OR p_target_kind NOT IN ('one', 'few', 'all') THEN
    RAISE EXCEPTION 'Invalid roadmap item' USING ERRCODE = '22023', HINT = 'invalid_item';
  END IF;
  IF (p_target_kind = 'all' AND cardinality(v_orgs) <> 0) OR (p_target_kind = 'one' AND cardinality(v_orgs) <> 1)
     OR (p_target_kind = 'few' AND cardinality(v_orgs) NOT BETWEEN 2 AND 50)
     OR (SELECT count(DISTINCT x) FROM unnest(v_orgs) x) <> cardinality(v_orgs)
     OR EXISTS (SELECT 1 FROM unnest(v_orgs) x WHERE x IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = x)) THEN
    RAISE EXCEPTION 'Invalid roadmap target' USING ERRCODE = '22023', HINT = 'invalid_target';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-roadmap', 0));
  IF p_id IS NULL THEN
    INSERT INTO public.platform_roadmap_items (title, description, status, sort_order, target_kind, target_orgs, shipped_at, created_by)
    VALUES (v_title, coalesce(p_description, ''), p_status, coalesce((SELECT max(sort_order) FROM public.platform_roadmap_items), 0) + 1,
            p_target_kind, v_orgs, CASE WHEN p_status = 'shipped' THEN now() END, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.platform_roadmap_items r
       SET title = v_title, description = coalesce(p_description, ''), status = p_status, target_kind = p_target_kind, target_orgs = v_orgs,
           shipped_at = CASE WHEN p_status <> 'shipped' THEN NULL WHEN r.shipped_at IS NOT NULL THEN r.shipped_at ELSE now() END,
           updated_at = now()
     WHERE r.id = p_id
    RETURNING r.id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'No such roadmap item' USING ERRCODE = 'P0002', HINT = 'item_not_found';
    END IF;
  END IF;
  RETURN jsonb_build_object('id', v_id);
END
$$;
REVOKE ALL ON FUNCTION public.platform_roadmap_save(UUID, TEXT, TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_roadmap_save(UUID, TEXT, TEXT, TEXT, TEXT, UUID[]) TO authenticated;

-- Move one item up or down one place (the list is renumbered 1..n first, so a gap or a tie cannot make the move do nothing).
CREATE OR REPLACE FUNCTION public.platform_roadmap_move(p_id UUID, p_direction TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pos INTEGER;
  v_n   INTEGER;
  v_to  INTEGER;
BEGIN
  PERFORM public._platform_owner_check(TRUE);
  IF p_direction IS NULL OR p_direction NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'Invalid direction' USING ERRCODE = '22023', HINT = 'invalid_direction';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-roadmap', 0));
  UPDATE public.platform_roadmap_items r SET sort_order = o.rn
    FROM (SELECT id, row_number() OVER (ORDER BY sort_order, id)::INTEGER AS rn FROM public.platform_roadmap_items) o
   WHERE r.id = o.id AND r.sort_order <> o.rn;
  SELECT sort_order INTO v_pos FROM public.platform_roadmap_items WHERE id = p_id;
  IF v_pos IS NULL THEN
    RAISE EXCEPTION 'No such roadmap item' USING ERRCODE = 'P0002', HINT = 'item_not_found';
  END IF;
  SELECT count(*)::INTEGER INTO v_n FROM public.platform_roadmap_items;
  v_to := CASE WHEN p_direction = 'up' THEN v_pos - 1 ELSE v_pos + 1 END;
  IF v_to BETWEEN 1 AND v_n THEN
    UPDATE public.platform_roadmap_items SET sort_order = CASE WHEN id = p_id THEN v_to ELSE v_pos END, updated_at = now()
     WHERE id = p_id OR sort_order = v_to;
  END IF;
  RETURN jsonb_build_object('id', p_id, 'moved', v_to BETWEEN 1 AND v_n);
END
$$;
REVOKE ALL ON FUNCTION public.platform_roadmap_move(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_roadmap_move(UUID, TEXT) TO authenticated;

-- ---- Module G: what the Rollouts screen shows (every company with the markers it has now, and the last 200 log rows) -------------------------
CREATE OR REPLACE FUNCTION public.platform_rollout_overview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public._platform_owner_check(FALSE);
  RETURN jsonb_build_object(
    'companies', coalesce((SELECT jsonb_agg(jsonb_build_object('organization_id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status,
                             'on', to_jsonb(coalesce((SELECT array_agg(m ORDER BY m) FROM unnest(coalesce(s.hidden_nav, '{}'::TEXT[])) m
                                                       WHERE m = ANY (ARRAY['reports:on', 'reports-revenue:on', 'iso-templates:on', 'job-time-variance:on', 'job-ncr-register:on', 'tooly-admin-tour:on'])), '{}'::TEXT[]))) ORDER BY o.name, o.id)
                           FROM public.organizations o LEFT JOIN public.organization_settings s ON s.organization_id = o.id), '[]'::JSONB),
    'log', coalesce((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'created_at', l.created_at, 'actor_email', l.actor_email, 'switch', l.switch_marker,
                             'turned_on', l.turned_on, 'phase', l.phase, 'org_names', to_jsonb(l.org_names), 'changed', cardinality(l.changed_org_ids)) ORDER BY l.created_at DESC, l.id)
                     FROM (SELECT * FROM public.platform_rollout_log ORDER BY created_at DESC, id LIMIT 200) l), '[]'::JSONB));
END
$$;
REVOKE ALL ON FUNCTION public.platform_rollout_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_rollout_overview() TO authenticated;

-- Turn ONE existing switch on or off for the named companies, and write one log row, in one transaction. Callable only by the service role: the
-- company's own guard (organization_settings_guard_nav) lets only that company's admin change hidden_nav for a signed-in caller, so the app route
-- (which has already checked the platform owner, the second step and a fresh code for "on") calls this with the service role and names the owner.
-- The function checks the owner again, accepts only the six listed markers, changes only that one marker in hidden_nav (nothing else in the list,
-- no other column, no other table), turns on only for active companies, and writes nothing for a company already in the wanted state.
CREATE OR REPLACE FUNCTION public.platform_rollout_apply(p_actor UUID, p_actor_email TEXT, p_switch TEXT, p_orgs UUID[], p_on BOOLEAN, p_phase TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_markers TEXT[] := ARRAY['reports:on', 'reports-revenue:on', 'iso-templates:on', 'job-time-variance:on', 'job-ncr-register:on', 'tooly-admin-tour:on'];
  v_phase   TEXT := btrim(coalesce(p_phase, ''));
  v_email   TEXT := btrim(coalesce(p_actor_email, ''));
  v_names   TEXT[];
  v_changed UUID[];
  v_log     UUID;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Rollouts are applied by the server, not by a signed-in session.' USING ERRCODE = '42501', HINT = 'service_only';
  END IF;
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p_actor) THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501', HINT = 'platform_required';
  END IF;
  IF p_switch IS NULL OR NOT (p_switch = ANY (v_markers)) THEN
    RAISE EXCEPTION 'That is not a switch that can be rolled out' USING ERRCODE = '22023', HINT = 'unknown_switch';
  END IF;
  IF p_on IS NULL OR p_orgs IS NULL OR cardinality(p_orgs) NOT BETWEEN 1 AND 200 OR char_length(v_phase) > 60 OR char_length(v_email) NOT BETWEEN 1 AND 254
     OR (SELECT count(DISTINCT x) FROM unnest(p_orgs) x) <> cardinality(p_orgs) OR EXISTS (SELECT 1 FROM unnest(p_orgs) x WHERE x IS NULL) THEN
    RAISE EXCEPTION 'Invalid rollout' USING ERRCODE = '22023', HINT = 'invalid_rollout';
  END IF;
  IF (SELECT count(*) FROM public.organizations o WHERE o.id = ANY (p_orgs)) <> cardinality(p_orgs) THEN
    RAISE EXCEPTION 'A chosen company was not found' USING ERRCODE = 'P0002', HINT = 'company_not_found';
  END IF;
  IF p_on AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = ANY (p_orgs) AND o.status <> 'active') THEN
    RAISE EXCEPTION 'A switch can only be turned on for an active company' USING ERRCODE = '22023', HINT = 'company_not_active';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-rollout', 0));
  SELECT array_agg(o.name ORDER BY o.name, o.id) INTO v_names FROM public.organizations o WHERE o.id = ANY (p_orgs);
  IF p_on THEN
    WITH changed AS (
      INSERT INTO public.organization_settings AS s (organization_id, hidden_nav)
      SELECT o.id, ARRAY[p_switch] FROM public.organizations o WHERE o.id = ANY (p_orgs)
      ON CONFLICT (organization_id) DO UPDATE SET hidden_nav = array_append(s.hidden_nav, p_switch) WHERE NOT (p_switch = ANY (s.hidden_nav))
      RETURNING s.organization_id)
    SELECT coalesce(array_agg(organization_id ORDER BY organization_id), '{}') INTO v_changed FROM changed;
  ELSE
    WITH changed AS (
      UPDATE public.organization_settings s SET hidden_nav = array_remove(s.hidden_nav, p_switch)
       WHERE s.organization_id = ANY (p_orgs) AND p_switch = ANY (s.hidden_nav)
      RETURNING s.organization_id)
    SELECT coalesce(array_agg(organization_id ORDER BY organization_id), '{}') INTO v_changed FROM changed;
  END IF;
  INSERT INTO public.platform_rollout_log (actor_id, actor_email, switch_marker, turned_on, phase, org_ids, org_names, changed_org_ids)
  VALUES (p_actor, v_email, p_switch, p_on, v_phase, p_orgs, v_names, v_changed)
  RETURNING id INTO v_log;
  RETURN jsonb_build_object('log_id', v_log, 'switch', p_switch, 'turned_on', p_on, 'requested', cardinality(p_orgs), 'changed', cardinality(v_changed),
                            'changed_org_ids', to_jsonb(v_changed));
END
$$;
REVOKE ALL ON FUNCTION public.platform_rollout_apply(UUID, TEXT, TEXT, UUID[], BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_rollout_apply(UUID, TEXT, TEXT, UUID[], BOOLEAN, TEXT) TO service_role;

DO $p167_self_check$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('platform_roadmap_items', 'platform_rollout_log') AND c.relkind = 'r' AND c.relrowsecurity) <> 2 THEN
    RAISE EXCEPTION '167 self-check: both tables must exist with row security on';
  END IF;
  IF (SELECT md5(string_agg(md5(regexp_replace(p.prosrc, '\s', '', 'g')), '' ORDER BY p.proname)) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply')) IS DISTINCT FROM 'ec318b0a585fdf72cbbb60a0f49f70e6' OR (SELECT md5(string_agg(concat_ws('|', c.table_name, c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.table_name, c.ordinal_position)) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('platform_roadmap_items', 'platform_rollout_log')) IS DISTINCT FROM '49a0d757be4df0ee3b1101c0b2b1f74d' THEN
    RAISE EXCEPTION '167 self-check: the seven functions and two tables must be 167''s exactly';
  END IF;
  IF has_table_privilege('anon', 'public.platform_roadmap_items', 'SELECT') OR has_table_privilege('authenticated', 'public.platform_roadmap_items', 'SELECT')
     OR has_table_privilege('service_role', 'public.platform_roadmap_items', 'SELECT') OR has_table_privilege('anon', 'public.platform_rollout_log', 'SELECT')
     OR has_table_privilege('authenticated', 'public.platform_rollout_log', 'SELECT') OR has_table_privilege('service_role', 'public.platform_rollout_log', 'SELECT') THEN
    RAISE EXCEPTION '167 self-check: no API role may have a grant on either table';
  END IF;
  IF has_function_privilege('anon', 'public.platform_roadmap_list()', 'EXECUTE') OR has_function_privilege('public', 'public.platform_roadmap_list()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.platform_roadmap_list()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._platform_owner_check(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '167 self-check: function grants are wrong (owner functions: signed-in only; rollout apply: service role only; helper: nobody)';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p167_before EXCEPT SELECT * FROM pg_temp.p167_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p167_fingerprint() EXCEPT SELECT * FROM pg_temp.p167_before) THEN
    RAISE EXCEPTION '167 self-check: another function, organizations, or organization_settings (columns, constraints, triggers, policies, grants, row security or a row) changed';
  END IF;
END
$p167_self_check$;
DROP TABLE pg_temp.p167_before;
DROP FUNCTION pg_temp.p167_fingerprint();
COMMIT;
