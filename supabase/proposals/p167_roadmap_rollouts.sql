-- Release 167 proposal (canonical source of supabase/release/167_roadmap_rollouts.release.sql; its body below is copied into that file verbatim, and
-- scripts/check-release-plan.mjs fails if the two drift). Modules F and G of the platform owner area: an owner-only Roadmap list and owner-only
-- Rollouts of the EXISTING per-company feature switches (the "<name>:on" markers in organization_settings.hidden_nav), with an append-only log.
-- Adds two tables and six functions. Nothing is switched on by this file, no company row is touched, no existing function, table or policy changes.
-- Not applied anywhere hosted.
BEGIN;

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
COMMIT;
