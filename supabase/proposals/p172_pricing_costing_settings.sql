-- p172 (proposed release 172, after 170 in supabase/release-plan.json; 171 is taken by the ISO editable documents proposal): Pricing and profit,
-- stage A1 (Settings): the company's costing inputs, visible and editable by ONE designated person only (owner-approved 26 Nov).
-- PROPOSAL ONLY. Not applied to production. Rehearsed on the scratch database only: supabase/proposals/p172_pricing_costing_settings.rehearsal.md.
-- Rollback: supabase/proposals/p172_pricing_costing_settings.rollback.sql.
--
-- OUTPUTS (all new): one table and four functions:
--   public.company_pricing_costs            ONE row per company: the designated profit viewer, crew, hours, weeks, hourly cost, running costs, targets.
--   public.pricing_costs_admin_caller()     internal guard (no grant to any browser role): the caller's company, or a refusal.
--   public.pricing_costs_overview()         active admin: who is designated now and the active admins who can be chosen. Never any figure.
--   public.set_pricing_profit_viewer(uuid)  active admin: designates (or clears) the ONE person who can see and edit the figures.
--   public.save_pricing_costs(jsonb, int)   the designated person only: replaces the figures (optimistic version check).
-- WHO CAN DO WHAT (the minimal secure model):
--   * READ (row-level security): only the designated person, only in their own session company, only while still an active admin there.
--     Every other admin, office, workshop, viewer, anon, other company and a platform-owner support session reads nothing: the select policy
--     is the whole of the table's read access. With nobody designated (the default) NOBODY reads or writes the figures, not even admins.
--   * WRITE: no INSERT/UPDATE/DELETE grant and no write policy for any browser role. Only the functions write (SECURITY DEFINER, search_path
--     pg_catalog, public), each starting with assert_privileged_aal(), a session company, role admin, NOT a support session, NOT read-only.
--   * DESIGNATION: an active admin of the company designates one other-or-same active ADMIN (the Settings page is admin-only, so the person
--     must be able to open it). It changes nothing about anyone's role or other rights. Because an admin who is not designated must never be
--     able to read the figures by designating themselves, EVERY change of designee (including clearing it) blanks the figures in the same
--     statement and bumps the version: the new person starts empty and the old figures are gone from the table (the audit row records that
--     the figures were cleared, never the figures). Choosing the person already designated changes nothing.
--   * SAVE: figures come only from the designated person, in one call: men 0..200 whole; hours per week 0..168; weeks per year 0..53; hourly
--     cost 0..100000; yearly target 0..1e11; profit target percent 0..100; up to 100 running costs {name 1..100 chars, amount 0..1e9,
--     period monthly|yearly}. Unknown keys refused (22023). Any figure may be null/absent (not entered). Nothing here has a default: a new row
--     holds no figure at all. A stale p_base_version is refused (40001, hint stale_version).
-- AUDIT: designation and each save write one security_audit.audit_log row from inside the function. Rows hold the action, the company, the
--   designee id (designation only), the version and whether figures were cleared: NEVER a figure (admins can read the audit log).
-- NOT STORED: the break-even hourly rate and the rate for a chosen profit percent are calculated in the app from these inputs, never saved.
-- MUST NOT CHANGE: any existing table, column, policy, trigger, function or grant. Nothing is gated here (the app keeps it behind the
--   pricing-costs:on company switch and treats a missing table or function as "not available yet").
-- NOTE for the data wipe: public.company_pricing_costs has an organization_id and is a KEPT company record (not operational data). supabase/cutover/wipe_operational_data.sql
--   is not on main yet, so it cannot be edited here; whoever lands it must classify this table as KEPT or the script will refuse an unknown table.
BEGIN;

-- ---- 1. The table ---------------------------------------------------------------------------------------------------------------
CREATE TABLE public.company_pricing_costs (
  organization_id   UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Plain uuid, no foreign key: removing a login must never cascade into, or be blocked by, this record. The policy also needs an active admin.
  profit_viewer_id  UUID,
  men               INTEGER       CONSTRAINT company_pricing_costs_men CHECK (men IS NULL OR men BETWEEN 0 AND 200),
  hours_per_week    NUMERIC(6,2)  CONSTRAINT company_pricing_costs_hours CHECK (hours_per_week IS NULL OR hours_per_week BETWEEN 0 AND 168),
  weeks_per_year    NUMERIC(5,2)  CONSTRAINT company_pricing_costs_weeks CHECK (weeks_per_year IS NULL OR weeks_per_year BETWEEN 0 AND 53),
  hourly_cost       NUMERIC(12,2) CONSTRAINT company_pricing_costs_hourly CHECK (hourly_cost IS NULL OR hourly_cost BETWEEN 0 AND 100000),
  yearly_target     NUMERIC(14,2) CONSTRAINT company_pricing_costs_target CHECK (yearly_target IS NULL OR yearly_target BETWEEN 0 AND 100000000000),
  profit_target_pct NUMERIC(5,2)  CONSTRAINT company_pricing_costs_pct CHECK (profit_target_pct IS NULL OR profit_target_pct BETWEEN 0 AND 100),
  running_costs     JSONB NOT NULL DEFAULT '[]'::JSONB
                    CONSTRAINT company_pricing_costs_running CHECK (jsonb_typeof(running_costs) = 'array' AND jsonb_array_length(running_costs) <= 100 AND octet_length(running_costs::TEXT) <= 40000),
  version           INTEGER NOT NULL DEFAULT 0 CONSTRAINT company_pricing_costs_version CHECK (version >= 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID
);

-- ---- 2. Row security and grants -------------------------------------------------------------------------------------------------
ALTER TABLE public.company_pricing_costs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_pricing_costs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_pricing_costs TO authenticated;
CREATE POLICY "company_pricing_costs viewer select" ON public.company_pricing_costs FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id())
         AND profit_viewer_id = (SELECT auth.uid())
         AND (SELECT public.has_org_role(ARRAY['admin'])));

-- ---- 3. Caller guard (internal) -------------------------------------------------------------------------------------------------
CREATE FUNCTION public.pricing_costs_admin_caller()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_session JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  SELECT public.my_session() INTO v_session;
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((v_session ->> 'support')::BOOLEAN, FALSE) OR coalesce((v_session ->> 'read_only')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END
$$;
REVOKE ALL ON FUNCTION public.pricing_costs_admin_caller() FROM PUBLIC, anon, authenticated;

-- ---- 4. Overview for an admin: who is designated, who can be chosen (no figure) ---------------------------------------------------
CREATE FUNCTION public.pricing_costs_overview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.pricing_costs_admin_caller();
  v_viewer UUID;
BEGIN
  SELECT c.profit_viewer_id INTO v_viewer FROM public.company_pricing_costs c WHERE c.organization_id = v_org;
  RETURN jsonb_build_object(
    'viewer', CASE WHEN v_viewer IS NULL THEN NULL ELSE
      (SELECT jsonb_build_object('id', p.id, 'name', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Unknown')) FROM public.user_profiles p WHERE p.id = v_viewer) END,
    'candidates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Unknown')) ORDER BY coalesce(nullif(btrim(p.full_name), ''), p.email), p.id)
        FROM public.organization_members m JOIN public.user_profiles p ON p.id = m.user_id
       WHERE m.organization_id = v_org AND m.active = TRUE AND m.support = FALSE AND m.role = 'admin' AND p.active = TRUE), '[]'::JSONB));
END
$$;
REVOKE ALL ON FUNCTION public.pricing_costs_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_costs_overview() TO authenticated;

-- ---- 5. Designate (or clear) the one profit viewer ---------------------------------------------------------------------------------
CREATE FUNCTION public.set_pricing_profit_viewer(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.pricing_costs_admin_caller();
  v_uid     UUID := auth.uid();
  v_row     public.company_pricing_costs;
  v_cleared BOOLEAN;
BEGIN
  IF p_user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.organization_members m JOIN public.user_profiles p ON p.id = m.user_id
        WHERE m.organization_id = v_org AND m.user_id = p_user_id AND m.active = TRUE AND m.support = FALSE AND m.role = 'admin' AND p.active = TRUE) THEN
    RAISE EXCEPTION 'Choose an active admin of this company' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pricing-costs:' || v_org::TEXT, 0));
  SELECT * INTO v_row FROM public.company_pricing_costs c WHERE c.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    IF p_user_id IS NULL THEN
      RETURN jsonb_build_object('viewer_id', NULL, 'figures_cleared', FALSE, 'changed', FALSE);
    END IF;
    INSERT INTO public.company_pricing_costs (organization_id, profit_viewer_id, version, updated_by) VALUES (v_org, p_user_id, 1, v_uid);
    v_cleared := FALSE;
  ELSIF v_row.profit_viewer_id IS NOT DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('viewer_id', p_user_id, 'figures_cleared', FALSE, 'changed', FALSE);
  ELSE
    v_cleared := v_row.men IS NOT NULL OR v_row.hours_per_week IS NOT NULL OR v_row.weeks_per_year IS NOT NULL OR v_row.hourly_cost IS NOT NULL
              OR v_row.yearly_target IS NOT NULL OR v_row.profit_target_pct IS NOT NULL OR jsonb_array_length(v_row.running_costs) > 0;
    UPDATE public.company_pricing_costs
       SET profit_viewer_id = p_user_id, men = NULL, hours_per_week = NULL, weeks_per_year = NULL, hourly_cost = NULL,
           yearly_target = NULL, profit_target_pct = NULL, running_costs = '[]'::JSONB,
           version = version + 1, updated_at = now(), updated_by = v_uid
     WHERE organization_id = v_org;
  END IF;

  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, new_data, metadata)
  VALUES (v_org, v_uid, nullif(auth.jwt() ->> 'email', ''), 'pricing_costs.viewer_set', 'company_pricing_costs', v_org::TEXT,
          jsonb_build_object('profit_viewer_id', p_user_id, 'figures_cleared', v_cleared),
          jsonb_build_object('source', 'pricing_costs_function'));
  RETURN jsonb_build_object('viewer_id', p_user_id, 'figures_cleared', v_cleared, 'changed', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public.set_pricing_profit_viewer(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_pricing_profit_viewer(UUID) TO authenticated;

-- ---- 6. Save the figures (the designated person only) ------------------------------------------------------------------------------
CREATE FUNCTION public.save_pricing_costs(p_values JSONB, p_base_version INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.pricing_costs_admin_caller();
  v_uid     UUID := auth.uid();
  v_row     public.company_pricing_costs;
  v_key     TEXT;
  v_e       JSONB;
  v_men     NUMERIC;
  v_hours   NUMERIC;
  v_weeks   NUMERIC;
  v_hourly  NUMERIC;
  v_target  NUMERIC;
  v_pct     NUMERIC;
  v_costs   JSONB := '[]'::JSONB;
  v_amount  NUMERIC;
BEGIN
  -- Only the designated person: anybody else (any other admin included) gets the same refusal as a stranger.
  SELECT * INTO v_row FROM public.company_pricing_costs c WHERE c.organization_id = v_org AND c.profit_viewer_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  IF p_values IS NULL OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid figures' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    IF v_key NOT IN ('men', 'hoursPerWeek', 'weeksPerYear', 'hourlyCost', 'yearlyTarget', 'profitTargetPct', 'runningCosts') THEN
      RAISE EXCEPTION 'Invalid figures' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- Each figure is a JSON number or null/absent; nothing else.
  FOR v_key IN SELECT unnest(ARRAY['men', 'hoursPerWeek', 'weeksPerYear', 'hourlyCost', 'yearlyTarget', 'profitTargetPct']) LOOP
    IF p_values ? v_key AND jsonb_typeof(p_values -> v_key) NOT IN ('number', 'null') THEN
      RAISE EXCEPTION 'Invalid figures' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  v_men := (p_values ->> 'men')::NUMERIC;
  v_hours := (p_values ->> 'hoursPerWeek')::NUMERIC;
  v_weeks := (p_values ->> 'weeksPerYear')::NUMERIC;
  v_hourly := (p_values ->> 'hourlyCost')::NUMERIC;
  v_target := (p_values ->> 'yearlyTarget')::NUMERIC;
  v_pct := (p_values ->> 'profitTargetPct')::NUMERIC;
  IF v_men IS NOT NULL AND v_men <> trunc(v_men) THEN
    RAISE EXCEPTION 'The number of men must be a whole number' USING ERRCODE = '22023';
  END IF;

  IF p_values ? 'runningCosts' AND jsonb_typeof(p_values -> 'runningCosts') NOT IN ('array', 'null') THEN
    RAISE EXCEPTION 'Invalid figures' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_values -> 'runningCosts') = 'array' THEN
    IF jsonb_array_length(p_values -> 'runningCosts') > 100 THEN
      RAISE EXCEPTION 'Too many running costs' USING ERRCODE = '22023';
    END IF;
    FOR v_e IN SELECT value FROM jsonb_array_elements(p_values -> 'runningCosts') LOOP
      IF jsonb_typeof(v_e) IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_e) k WHERE k NOT IN ('name', 'amount', 'period'))
         OR jsonb_typeof(v_e -> 'name') IS DISTINCT FROM 'string' OR jsonb_typeof(v_e -> 'amount') IS DISTINCT FROM 'number'
         OR (v_e ->> 'period') IS NULL OR (v_e ->> 'period') NOT IN ('monthly', 'yearly') THEN
        RAISE EXCEPTION 'Invalid running cost' USING ERRCODE = '22023';
      END IF;
      v_amount := (v_e ->> 'amount')::NUMERIC;
      IF char_length(btrim(v_e ->> 'name')) NOT BETWEEN 1 AND 100 OR v_amount < 0 OR v_amount > 1000000000 THEN
        RAISE EXCEPTION 'Invalid running cost' USING ERRCODE = '22023';
      END IF;
      v_costs := v_costs || jsonb_build_array(jsonb_build_object('name', btrim(v_e ->> 'name'), 'amount', round(v_amount, 2), 'period', v_e ->> 'period'));
    END LOOP;
  END IF;

  IF p_base_version IS DISTINCT FROM v_row.version THEN
    RAISE EXCEPTION 'These figures changed since you opened them; reload before saving' USING ERRCODE = '40001', HINT = 'stale_version';
  END IF;

  UPDATE public.company_pricing_costs
     SET men = v_men::INTEGER, hours_per_week = v_hours, weeks_per_year = v_weeks, hourly_cost = v_hourly, yearly_target = v_target,
         profit_target_pct = v_pct, running_costs = v_costs, version = version + 1, updated_at = now(), updated_by = v_uid
   WHERE organization_id = v_org
   RETURNING * INTO v_row;

  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, new_data, metadata)
  VALUES (v_org, v_uid, nullif(auth.jwt() ->> 'email', ''), 'pricing_costs.save', 'company_pricing_costs', v_org::TEXT,
          jsonb_build_object('version', v_row.version), jsonb_build_object('source', 'pricing_costs_function'));

  RETURN jsonb_build_object('version', v_row.version, 'updated_at', v_row.updated_at);
END
$$;
REVOKE ALL ON FUNCTION public.save_pricing_costs(JSONB, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_pricing_costs(JSONB, INTEGER) TO authenticated;
COMMIT;
