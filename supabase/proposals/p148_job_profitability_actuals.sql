-- P148 proposal only (optional actual job costing, OFF by default). Packaged as post-144 release step 148
-- (supabase/release/148_job_profitability_actuals.release.sql), after 147 and before 149. One-time: a repeat refuses on the existing table.
-- Adapted from Codex PR 378 (migration 148 + lib/job-profitability-actuals.ts) so that it REUSES release 143's single company rate source:
--   * NO second rate store and NO second rate editor. Labour is costed at costing_defaults.labour_rate_pence (a machine's own
--     costing_machines.labour_rate_pence for operator time on that machine, when set); machine time at costing_machines.hourly_rate_pence;
--     overhead is 143's overhead_pct applied to machine + labour cost (150 = 50% added; 100 = none), as the quote engine does. Rates are edited
--     only by 143's save_costing_settings_atomic. #378's job_costing_settings rate columns, job_machine_cost_rates, job_costing_rate_history
--     and save_job_costing_rates are gone; so are its includes_labour/includes_overhead flags (machine cost never includes labour here).
--   * Machine link: 143's costing_machines is its own name list with no key to public.machines, and 143's verify pins that table's exact
--     columns and that no foreign key points at it, so 148 does NOT alter it. job_costing_machine_links (one row per shop-floor machine, same
--     company) says which 143 costing machine prices a machine's runs. It holds no figure. A run on an unlinked machine, or one linked to a
--     costing machine since deleted in Settings, leaves the job INCOMPLETE (never a zero).
--   * SNAPSHOTS: job_cost_snapshots keeps the cost of a job (the whole 143 rate set used, as jsonb, and labour, machine, overhead and supplier
--     pence) taken when the job FINISHES or its first invoice is ISSUED, whichever is first (deferred to commit, so timers the finish closes are
--     in). The rates on a snapshot can never change (trigger); editing 143's rates afterwards changes no past record. A refresh re-works the
--     figures from corrected recorded time at the SNAPSHOT's own rates. "At today's rates" is only for an OPEN job (not finished, no issued
--     invoice, no snapshot) and the app labels it so. A closed job with no snapshot (closed before 148, or before 143 rates were set up) shows
--     "no cost record", never a figure at today's rates.
--   * The switch (job_costing_settings.enabled, approved_by/at) can only be turned on while the company's 143 rates are configured (defaults
--     row, at least one machine and one material: 143's own rule). Not configured: OFF, with 143's message. Default OFF for every company.
--   * Money: integer pence; time: integer microseconds from timestamptz; ONE rounding rule, halves up on the exact ratio (separate from the frozen
--     lib/costing's pyRound), applied once per figure. A missing input makes the figure INCOMPLETE with a reason; no zero is invented.
-- Read access: admin and office of the company who can see jobs, invoices, quotes and purchase orders (#378's gate), plus the second step.
-- Rollback: supabase/release/148_job_profitability_actuals.rollback.sql (drops 148's triggers, functions and four tables; 143 untouched).
BEGIN;
-- 1. Tables. No rate column anywhere: every figure comes from 143's tables.
CREATE TABLE public.job_costing_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  approved_by uuid, approved_at timestamptz,
  CONSTRAINT job_costing_settings_approved CHECK (NOT enabled OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE TABLE public.job_costing_machine_links (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE CASCADE,
  costing_machine_id uuid NOT NULL,
  linked_by uuid, linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, machine_id)
);
CREATE TABLE public.job_cost_declarations (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  labour_not_required boolean NOT NULL, machines_not_required boolean NOT NULL,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.job_cost_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
  taken_on text NOT NULL CHECK (taken_on IN ('finished','invoiced')),
  rates jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('complete','incomplete')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  labour_us bigint, machine_us bigint,
  labour_pence bigint, machine_pence bigint, overhead_pence bigint, supplier_pence bigint,
  taken_at timestamptz NOT NULL DEFAULT now(), taken_by uuid,
  refreshed_at timestamptz, refreshed_by uuid,
  CONSTRAINT job_cost_snapshots_figures CHECK ((state = 'complete') = (labour_pence IS NOT NULL AND machine_pence IS NOT NULL
    AND overhead_pence IS NOT NULL AND supplier_pence IS NOT NULL AND jsonb_array_length(reasons) = 0)
    AND (state = 'complete' OR (labour_pence IS NULL AND machine_pence IS NULL AND overhead_pence IS NULL AND supplier_pence IS NULL)))
);
CREATE TRIGGER zz_same_org_machine BEFORE INSERT OR UPDATE ON public.job_costing_machine_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machines','machine_id');
CREATE TRIGGER zz_same_org_job BEFORE INSERT OR UPDATE ON public.job_cost_declarations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs','job_id');
CREATE TRIGGER zz_same_org_job BEFORE INSERT OR UPDATE ON public.job_cost_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs','job_id');
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['job_costing_settings','job_costing_machine_links','job_cost_declarations','job_cost_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY financial_read ON public.%I FOR SELECT TO authenticated USING (
      organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin','office']))
      AND (SELECT public.section_allowed('jobs')) AND (SELECT public.section_allowed('invoices'))
      AND (SELECT public.section_allowed('quotes')) AND (SELECT public.section_allowed('purchase-orders')))$p$, t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', t);
  END LOOP;
END $$;

-- 2. A snapshot's rates, company, job, cause and time never change; only its figures may be re-worked at those same rates.
CREATE FUNCTION public.job_cost_snapshot_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.taken_on IS DISTINCT FROM OLD.taken_on OR NEW.rates IS DISTINCT FROM OLD.rates OR NEW.taken_at IS DISTINCT FROM OLD.taken_at THEN
    RAISE EXCEPTION 'A job cost record keeps the rates it was taken at' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.job_cost_snapshot_frozen() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER job_cost_snapshot_frozen BEFORE UPDATE ON public.job_cost_snapshots FOR EACH ROW EXECUTE FUNCTION public.job_cost_snapshot_frozen();

-- 3. The one rounding rule: halves up on an exact non-negative ratio (business money, not the frozen quotation engine), as whole pence.
CREATE FUNCTION public.job_cost_round(p_num numeric, p_den numeric) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE q numeric; r numeric;
BEGIN
  IF p_num < 0 OR p_den <= 0 OR p_num <> trunc(p_num) OR p_den <> trunc(p_den) THEN RAISE EXCEPTION 'Invalid cost ratio' USING ERRCODE = '22023'; END IF;
  q := div(p_num, p_den); r := p_num - q * p_den;
  IF 2 * r >= p_den THEN q := q + 1; END IF;
  RETURN q::bigint;
END $$;
REVOKE ALL ON FUNCTION public.job_cost_round(numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;

-- Whole microseconds covered by a set of bounded time ranges (each instant counted once).
CREATE FUNCTION public.job_cost_us(p tstzmultirange) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(sum(extract(epoch FROM upper(x) - lower(x)) * 1000000), 0) FROM unnest(coalesce(p, '{}'::tstzmultirange)) x
$$;
REVOKE ALL ON FUNCTION public.job_cost_us(tstzmultirange) FROM PUBLIC, anon, authenticated, service_role;

-- 4. Central gate (#378's): the SECURITY DEFINER functions check it; RLS alone is not enough inside them.
CREATE FUNCTION public.job_costing_access(p_admin boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.current_user_organization_id();
BEGIN
  IF auth.uid() IS NULL OR org IS NULL OR NOT public.has_org_role(CASE WHEN p_admin THEN ARRAY['admin'] ELSE ARRAY['admin','office'] END)
    OR NOT public.section_allowed('jobs') OR NOT public.section_allowed('invoices')
    OR NOT public.section_allowed('quotes') OR NOT public.section_allowed('purchase-orders') THEN
    RAISE EXCEPTION 'Financial access required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_privileged_aal();
  RETURN org;
END $$;
REVOKE ALL ON FUNCTION public.job_costing_access(boolean) FROM PUBLIC, anon, authenticated, service_role;

-- 5. The company's 143 rate set, or NULL when 143 says costing is not configured (no defaults row, no machine or no material).
CREATE FUNCTION public.job_cost_rates(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'source', 'costing_defaults/costing_machines (143)',
    'defaults', jsonb_build_object('labour_rate_pence', d.labour_rate_pence, 'overhead_pct', d.overhead_pct, 'updated_at', d.updated_at),
    'machines', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'hourly_rate_pence', m.hourly_rate_pence,
                   'labour_rate_pence', m.labour_rate_pence) ORDER BY m.id), '[]'::jsonb) FROM public.costing_machines m WHERE m.organization_id = p_org),
    'links', (SELECT coalesce(jsonb_agg(jsonb_build_object('machine_id', l.machine_id, 'costing_machine_id', l.costing_machine_id) ORDER BY l.machine_id), '[]'::jsonb)
              FROM public.job_costing_machine_links l WHERE l.organization_id = p_org),
    'read_at', now())
  FROM public.costing_defaults d
  WHERE d.organization_id = p_org
    AND EXISTS (SELECT 1 FROM public.costing_machines WHERE organization_id = p_org)
    AND EXISTS (SELECT 1 FROM public.costing_materials WHERE organization_id = p_org)
$$;
REVOKE ALL ON FUNCTION public.job_cost_rates(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 6. The cost of one job from its recorded time and supplier allocations at the rate set given. Never invents a zero: any gap is a reason
-- and the figures are then NULL. Explicit company predicates throughout; no employee pay data is read.
CREATE FUNCTION public.job_cost_figures(p_org uuid, p_job uuid, p_rates jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_reasons text[] := ARRAY[]::text[];
  v_quote uuid; v_no_labour boolean; v_no_machines boolean; v_has_decl boolean;
  v_default numeric := (p_rates #>> '{defaults,labour_rate_pence}')::numeric;
  v_pct numeric := (p_rates #>> '{defaults,overhead_pct}')::numeric;
  v_labour_num numeric := 0; v_labour_us numeric := 0; v_machine_num numeric := 0; v_machine_us numeric := 0;
  v_supplier numeric := 0; v_has_labour boolean; v_has_machines boolean; r record;
  c_hour CONSTANT numeric := 3600000000;
BEGIN
  SELECT quote_id INTO v_quote FROM public.jobs WHERE id = p_job AND organization_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job unavailable' USING ERRCODE = '42501'; END IF;
  IF v_default IS NULL OR v_pct IS NULL THEN v_reasons := v_reasons || 'Company costing rates are not set up'::text; END IF;
  SELECT labour_not_required, machines_not_required INTO v_no_labour, v_no_machines
    FROM public.job_cost_declarations WHERE job_id = p_job AND organization_id = p_org;
  v_has_decl := FOUND;
  IF NOT v_has_decl THEN v_reasons := v_reasons || 'Confirm whether this job needs labour and machine hours'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.operator_sessions WHERE organization_id = p_org AND job_id = p_job AND voided_at IS NULL AND ended_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.machine_runs WHERE organization_id = p_org AND job_id = p_job AND ended_at IS NULL) THEN
    v_reasons := v_reasons || 'A labour or machine timer on this job is still running'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.operator_sessions WHERE organization_id = p_org AND job_id = p_job AND voided_at IS NULL AND ended_at < started_at)
     OR EXISTS (SELECT 1 FROM public.machine_runs WHERE organization_id = p_org AND job_id = p_job AND ended_at < started_at) THEN
    v_reasons := v_reasons || 'A timer on this job ends before it starts'::text;
  END IF;
  v_has_labour := EXISTS (SELECT 1 FROM public.operator_sessions WHERE organization_id = p_org AND job_id = p_job AND voided_at IS NULL AND ended_at > started_at);
  v_has_machines := EXISTS (SELECT 1 FROM public.machine_runs WHERE organization_id = p_org AND job_id = p_job AND ended_at > started_at);
  IF v_has_decl THEN
    IF NOT v_has_labour AND NOT v_no_labour THEN v_reasons := v_reasons || 'No completed labour hours recorded'::text; END IF;
    IF NOT v_has_machines AND NOT v_no_machines THEN v_reasons := v_reasons || 'No completed machine hours recorded'::text; END IF;
    IF v_has_labour AND v_no_labour THEN v_reasons := v_reasons || 'Recorded labour conflicts with the no-labour declaration'::text; END IF;
    IF v_has_machines AND v_no_machines THEN v_reasons := v_reasons || 'Recorded machines conflict with the no-machine declaration'::text; END IF;
  END IF;
  -- The same person or machine timed on another job at the same moment would be charged twice: correct it first (#378's rule).
  IF EXISTS (SELECT 1 FROM public.operator_sessions s JOIN public.operator_sessions o ON o.organization_id = p_org AND o.user_id = s.user_id
               AND o.job_id <> p_job AND o.voided_at IS NULL AND o.started_at < coalesce(s.ended_at, 'infinity') AND s.started_at < coalesce(o.ended_at, 'infinity')
             WHERE s.organization_id = p_org AND s.job_id = p_job AND s.voided_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.machine_runs s JOIN public.machine_runs o ON o.organization_id = p_org AND o.machine_id = s.machine_id
               AND o.job_id <> p_job AND o.started_at < coalesce(s.ended_at, 'infinity') AND s.started_at < coalesce(o.ended_at, 'infinity')
             WHERE s.organization_id = p_org AND s.job_id = p_job) THEN
    v_reasons := v_reasons || 'Overlapping time on another job needs correction before costing'::text;
  END IF;
  -- Every machine run must be priced by a 143 costing machine that is in this rate set.
  FOR r IN SELECT DISTINCT m.name FROM public.machine_runs x JOIN public.machines m ON m.id = x.machine_id AND m.organization_id = p_org
           WHERE x.organization_id = p_org AND x.job_id = p_job AND x.ended_at > x.started_at
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_rates -> 'links', '[]'::jsonb)) l
                             JOIN jsonb_array_elements(coalesce(p_rates -> 'machines', '[]'::jsonb)) c ON c ->> 'id' = l ->> 'costing_machine_id'
                             WHERE l ->> 'machine_id' = x.machine_id::text)
           ORDER BY m.name LOOP
    v_reasons := v_reasons || format('Machine "%s" has no costing rate linked', r.name);
  END LOOP;
  -- Machine time: union per machine, at that machine's 143 hourly rate.
  WITH cm AS (SELECT (c ->> 'id')::uuid AS id, (c ->> 'hourly_rate_pence')::numeric AS hourly FROM jsonb_array_elements(coalesce(p_rates -> 'machines', '[]'::jsonb)) c),
  lk AS (SELECT (l ->> 'machine_id')::uuid AS machine_id, (l ->> 'costing_machine_id')::uuid AS cm_id FROM jsonb_array_elements(coalesce(p_rates -> 'links', '[]'::jsonb)) l),
  per AS (SELECT x.machine_id, max(cm.hourly) AS hourly, public.job_cost_us(range_agg(tstzrange(x.started_at, x.ended_at))) AS us
          FROM public.machine_runs x LEFT JOIN lk ON lk.machine_id = x.machine_id LEFT JOIN cm ON cm.id = lk.cm_id
          WHERE x.organization_id = p_org AND x.job_id = p_job AND x.ended_at > x.started_at GROUP BY x.machine_id)
  SELECT coalesce(sum(us * hourly), 0), coalesce(sum(us), 0) INTO v_machine_num, v_machine_us FROM per;
  -- Labour time: union per person at the company labour rate; while that person ran a machine whose 143 row has its own labour rate, that rate.
  IF EXISTS (WITH cm AS (SELECT (c ->> 'id')::uuid AS id, (c ->> 'labour_rate_pence')::numeric AS labour FROM jsonb_array_elements(coalesce(p_rates -> 'machines', '[]'::jsonb)) c),
             lk AS (SELECT (l ->> 'machine_id')::uuid AS machine_id, (l ->> 'costing_machine_id')::uuid AS cm_id FROM jsonb_array_elements(coalesce(p_rates -> 'links', '[]'::jsonb)) l),
             o AS (SELECT x.operator_id, cm.labour, range_agg(tstzrange(x.started_at, x.ended_at)) AS mr FROM public.machine_runs x
                   JOIN lk ON lk.machine_id = x.machine_id JOIN cm ON cm.id = lk.cm_id
                   WHERE x.organization_id = p_org AND x.job_id = p_job AND x.ended_at > x.started_at AND x.operator_id IS NOT NULL AND cm.labour IS NOT NULL
                   GROUP BY 1, 2)
             SELECT 1 FROM o a JOIN o b ON a.operator_id = b.operator_id AND a.labour < b.labour AND a.mr && b.mr) THEN
    v_reasons := v_reasons || 'One operator ran machines with different labour rates at the same time'::text;
  END IF;
  WITH cm AS (SELECT (c ->> 'id')::uuid AS id, (c ->> 'labour_rate_pence')::numeric AS labour FROM jsonb_array_elements(coalesce(p_rates -> 'machines', '[]'::jsonb)) c),
  lk AS (SELECT (l ->> 'machine_id')::uuid AS machine_id, (l ->> 'costing_machine_id')::uuid AS cm_id FROM jsonb_array_elements(coalesce(p_rates -> 'links', '[]'::jsonb)) l),
  lab AS (SELECT user_id, range_agg(tstzrange(started_at, ended_at)) AS mr FROM public.operator_sessions
          WHERE organization_id = p_org AND job_id = p_job AND voided_at IS NULL AND ended_at > started_at GROUP BY user_id),
  o AS (SELECT x.operator_id AS user_id, cm.labour, range_agg(tstzrange(x.started_at, x.ended_at)) AS mr FROM public.machine_runs x
        JOIN lk ON lk.machine_id = x.machine_id JOIN cm ON cm.id = lk.cm_id
        WHERE x.organization_id = p_org AND x.job_id = p_job AND x.ended_at > x.started_at AND x.operator_id IS NOT NULL AND cm.labour IS NOT NULL GROUP BY 1, 2),
  ov AS (SELECT o.labour, public.job_cost_us(lab.mr * o.mr) AS us FROM lab JOIN o USING (user_id))
  SELECT coalesce((SELECT sum(public.job_cost_us(mr)) FROM lab), 0),
         coalesce((SELECT sum(public.job_cost_us(mr)) FROM lab), 0) * coalesce(v_default, 0) + coalesce((SELECT sum((labour - coalesce(v_default, 0)) * us) FROM ov), 0)
    INTO v_labour_us, v_labour_num;
  -- Supplier: linked purchase orders, each once, cancelled ones left out, the linked part where given (lib/purchase-order-link's rule).
  FOR r IN SELECT DISTINCT ON (id) total_value, linked_net FROM public.purchase_orders
           WHERE organization_id = p_org AND (job_id = p_job OR (job_id IS NULL AND v_quote IS NOT NULL AND quote_id = v_quote))
             AND lower(btrim(coalesce(status, ''))) <> 'cancelled' ORDER BY id LOOP
    IF r.total_value IS NULL OR r.total_value < 0 THEN
      IF NOT 'Supplier allocations are missing or unreadable' = ANY (v_reasons) THEN v_reasons := v_reasons || 'Supplier allocations are missing or unreadable'::text; END IF;
    ELSE v_supplier := v_supplier + least(r.total_value, coalesce(r.linked_net, r.total_value)) * 100;
    END IF;
  END LOOP;
  IF v_quote IS NOT NULL AND EXISTS (SELECT 1 FROM public.purchase_orders WHERE organization_id = p_org AND job_id IS NULL AND quote_id = v_quote
                                      AND lower(btrim(coalesce(status, ''))) <> 'cancelled')
     AND EXISTS (SELECT 1 FROM public.jobs WHERE organization_id = p_org AND quote_id = v_quote AND id <> p_job) THEN
    v_reasons := v_reasons || 'A quote-only supplier allocation is shared by multiple jobs; allocate it to a job'::text;
  END IF;
  IF cardinality(v_reasons) > 0 THEN
    RETURN jsonb_build_object('state', 'incomplete', 'reasons', to_jsonb(v_reasons), 'labour_us', NULL, 'machine_us', NULL,
      'labour_pence', NULL, 'machine_pence', NULL, 'overhead_pence', NULL, 'supplier_pence', NULL);
  END IF;
  RETURN jsonb_build_object('state', 'complete', 'reasons', '[]'::jsonb, 'labour_us', v_labour_us::bigint, 'machine_us', v_machine_us::bigint,
    'labour_pence', public.job_cost_round(v_labour_num, c_hour), 'machine_pence', public.job_cost_round(v_machine_num, c_hour),
    'overhead_pence', public.job_cost_round((v_labour_num + v_machine_num) * (v_pct * 100 - 10000), c_hour * 10000),
    'supplier_pence', public.job_cost_round(v_supplier, 1));
END $$;
REVOKE ALL ON FUNCTION public.job_cost_figures(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- 7. Take the record once per job, at the company's rates of that moment. Not configured in 143: no record (the job shows "no cost record").
CREATE FUNCTION public.job_cost_take_snapshot(p_org uuid, p_job uuid, p_taken_on text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_rates jsonb; v_fig jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.job_cost_snapshots WHERE job_id = p_job) THEN RETURN; END IF;
  v_rates := public.job_cost_rates(p_org);
  IF v_rates IS NULL THEN RETURN; END IF;
  BEGIN
    v_fig := public.job_cost_figures(p_org, p_job, v_rates);
  EXCEPTION WHEN OTHERS THEN
    v_fig := jsonb_build_object('state', 'incomplete', 'reasons', jsonb_build_array('Costs could not be worked out when this job closed; refresh this record'));
  END;
  INSERT INTO public.job_cost_snapshots (organization_id, job_id, taken_on, rates, state, reasons, labour_us, machine_us,
    labour_pence, machine_pence, overhead_pence, supplier_pence, taken_by)
  VALUES (p_org, p_job, p_taken_on, v_rates, v_fig ->> 'state', v_fig -> 'reasons', (v_fig ->> 'labour_us')::bigint, (v_fig ->> 'machine_us')::bigint,
    (v_fig ->> 'labour_pence')::bigint, (v_fig ->> 'machine_pence')::bigint, (v_fig ->> 'overhead_pence')::bigint, (v_fig ->> 'supplier_pence')::bigint, auth.uid())
  ON CONFLICT (job_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.job_cost_take_snapshot(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- 8. When: at commit of the transaction that finishes the job or issues its first invoice. Never blocks the finish or the invoice.
CREATE FUNCTION public.job_cost_snapshot_on_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job uuid; v_org uuid;
BEGIN
  IF TG_TABLE_NAME = 'jobs' THEN
    SELECT id, organization_id INTO v_job, v_org FROM public.jobs WHERE id = NEW.id AND finished_at IS NOT NULL;
  ELSE
    SELECT i.job_id, i.organization_id INTO v_job, v_org FROM public.invoices i WHERE i.id = NEW.id AND i.job_id IS NOT NULL
      AND lower(btrim(coalesce(i.status, ''))) NOT IN ('', 'draft', 'void', 'voided', 'cancelled', 'canceled');
  END IF;
  IF v_job IS NULL THEN RETURN NULL; END IF;
  BEGIN
    PERFORM public.job_cost_take_snapshot(v_org, v_job, CASE WHEN TG_TABLE_NAME = 'jobs' THEN 'finished' ELSE 'invoiced' END);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '148: job cost record not taken for job %: %', v_job, SQLERRM;
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.job_cost_snapshot_on_close() FROM PUBLIC, anon, authenticated, service_role;
CREATE CONSTRAINT TRIGGER zz_job_cost_snapshot AFTER UPDATE OF finished_at ON public.jobs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL) EXECUTE FUNCTION public.job_cost_snapshot_on_close();
CREATE CONSTRAINT TRIGGER zz_job_cost_snapshot AFTER INSERT OR UPDATE OF status, job_id ON public.invoices DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.job_id IS NOT NULL AND lower(btrim(coalesce(NEW.status, ''))) NOT IN ('', 'draft', 'void', 'voided', 'cancelled', 'canceled'))
  EXECUTE FUNCTION public.job_cost_snapshot_on_close();

-- 9. Admin: the switch. ON only while 143's rates are configured; the revision stops two admins overwriting each other.
CREATE FUNCTION public.set_job_costing_enabled(p_organization uuid, p_revision integer, p_enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.job_costing_access(true); current_revision integer;
BEGIN
  IF public.session_read_only() THEN RAISE EXCEPTION 'Read only' USING ERRCODE = '42501'; END IF;
  IF org IS DISTINCT FROM p_organization THEN RAISE EXCEPTION 'Company changed; reload' USING ERRCODE = '42501'; END IF;
  IF p_enabled IS NULL OR p_revision IS NULL THEN RAISE EXCEPTION 'Choose on or off' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.organizations WHERE id = org FOR UPDATE;
  SELECT revision INTO current_revision FROM public.job_costing_settings WHERE organization_id = org;
  IF coalesce(current_revision, 0) IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Job costing changed; reload before saving' USING ERRCODE = '40001'; END IF;
  IF p_enabled AND public.job_cost_rates(org) IS NULL THEN
    RAISE EXCEPTION 'Costing is not set up: enter your rates in Settings > Costing rates' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.job_costing_settings (organization_id, enabled, revision, approved_by, approved_at)
  VALUES (org, p_enabled, p_revision + 1, CASE WHEN p_enabled THEN auth.uid() END, CASE WHEN p_enabled THEN now() END)
  ON CONFLICT (organization_id) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision,
    approved_by = excluded.approved_by, approved_at = excluded.approved_at;
END $$;
REVOKE ALL ON FUNCTION public.set_job_costing_enabled(uuid, integer, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_job_costing_enabled(uuid, integer, boolean) TO authenticated;

-- 10. Admin: which 143 costing machine prices each shop-floor machine (no figure here). The whole set is replaced.
CREATE FUNCTION public.save_job_costing_machine_links(p_organization uuid, p_links jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.job_costing_access(true); item jsonb;
  v_uuid CONSTANT text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF public.session_read_only() THEN RAISE EXCEPTION 'Read only' USING ERRCODE = '42501'; END IF;
  IF org IS DISTINCT FROM p_organization THEN RAISE EXCEPTION 'Company changed; reload' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_links) IS DISTINCT FROM 'array' OR jsonb_array_length(p_links) > 500 THEN RAISE EXCEPTION 'Invalid machine links' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.organizations WHERE id = org FOR UPDATE;
  DELETE FROM public.job_costing_machine_links WHERE organization_id = org;
  FOR item IN SELECT value FROM jsonb_array_elements(p_links) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR coalesce(item ->> 'machine_id', '') !~ v_uuid OR coalesce(item ->> 'costing_machine_id', '') !~ v_uuid
       OR NOT EXISTS (SELECT 1 FROM public.machines WHERE id = (item ->> 'machine_id')::uuid AND organization_id = org)
       OR NOT EXISTS (SELECT 1 FROM public.costing_machines WHERE id = (item ->> 'costing_machine_id')::uuid AND organization_id = org) THEN
      RAISE EXCEPTION 'Invalid machine link or company' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.job_costing_machine_links (organization_id, machine_id, costing_machine_id, linked_by)
    VALUES (org, (item ->> 'machine_id')::uuid, (item ->> 'costing_machine_id')::uuid, auth.uid());
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.save_job_costing_machine_links(uuid, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_job_costing_machine_links(uuid, jsonb) TO authenticated;

-- 11. Admin/office: whether a job needs labour or machine hours (so "none recorded" is a real zero, never a guessed one).
CREATE FUNCTION public.save_job_cost_declarations(p_job uuid, p_no_labour boolean, p_no_machines boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.job_costing_access(false);
BEGIN
  IF public.session_read_only() THEN RAISE EXCEPTION 'Read only' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job AND organization_id = org) THEN RAISE EXCEPTION 'Job unavailable' USING ERRCODE = '42501'; END IF;
  IF p_no_labour IS NULL OR p_no_machines IS NULL THEN RAISE EXCEPTION 'Answer both questions' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.job_cost_declarations (organization_id, job_id, labour_not_required, machines_not_required, updated_by)
  VALUES (org, p_job, p_no_labour, p_no_machines, auth.uid())
  ON CONFLICT (job_id) DO UPDATE SET labour_not_required = excluded.labour_not_required, machines_not_required = excluded.machines_not_required,
    updated_by = excluded.updated_by, updated_at = now();
END $$;
REVOKE ALL ON FUNCTION public.save_job_cost_declarations(uuid, boolean, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_job_cost_declarations(uuid, boolean, boolean) TO authenticated;

-- 12. Admin/office: re-work a job's record from corrected recorded time at the record's OWN rates (never today's).
CREATE FUNCTION public.refresh_job_cost_snapshot(p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.job_costing_access(false); v_rates jsonb; v_fig jsonb;
BEGIN
  IF public.session_read_only() THEN RAISE EXCEPTION 'Read only' USING ERRCODE = '42501'; END IF;
  SELECT rates INTO v_rates FROM public.job_cost_snapshots WHERE job_id = p_job AND organization_id = org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No cost record for this job' USING ERRCODE = 'P0002'; END IF;
  v_fig := public.job_cost_figures(org, p_job, v_rates);
  UPDATE public.job_cost_snapshots SET state = v_fig ->> 'state', reasons = v_fig -> 'reasons',
    labour_us = (v_fig ->> 'labour_us')::bigint, machine_us = (v_fig ->> 'machine_us')::bigint,
    labour_pence = (v_fig ->> 'labour_pence')::bigint, machine_pence = (v_fig ->> 'machine_pence')::bigint,
    overhead_pence = (v_fig ->> 'overhead_pence')::bigint, supplier_pence = (v_fig ->> 'supplier_pence')::bigint,
    refreshed_at = now(), refreshed_by = auth.uid()
  WHERE job_id = p_job AND organization_id = org;
END $$;
REVOKE ALL ON FUNCTION public.refresh_job_cost_snapshot(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_job_cost_snapshot(uuid) TO authenticated;

-- 13. What the job page reads. Off or not configured: no figures at all. Open job: today's rates (labelled live). Closed: the record only.
CREATE FUNCTION public.job_profitability_actual_inputs(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.job_costing_access(false); q uuid; v_finished timestamptz; cfg jsonb; v_rates jsonb; v_snap jsonb;
  v_invoiced boolean; v_open boolean; result jsonb;
BEGIN
  SELECT quote_id, finished_at INTO q, v_finished FROM public.jobs WHERE id = p_job AND organization_id = org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job unavailable' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object('enabled', s.enabled, 'revision', s.revision, 'approved_at', s.approved_at) INTO cfg
    FROM public.job_costing_settings s WHERE s.organization_id = org;
  cfg := coalesce(cfg, '{"enabled":false,"revision":0,"approved_at":null}'::jsonb);
  v_rates := public.job_cost_rates(org);
  SELECT to_jsonb(s) - 'rates' || jsonb_build_object('rates_read_at', s.rates ->> 'read_at') INTO v_snap
    FROM public.job_cost_snapshots s WHERE s.job_id = p_job AND s.organization_id = org;
  v_invoiced := EXISTS (SELECT 1 FROM public.invoices WHERE organization_id = org AND job_id = p_job
                        AND lower(btrim(coalesce(status, ''))) NOT IN ('', 'draft', 'void', 'voided', 'cancelled', 'canceled'));
  v_open := v_snap IS NULL AND v_finished IS NULL AND NOT v_invoiced;
  result := jsonb_build_object('organizationId', org, 'jobId', p_job, 'config', cfg, 'configured', v_rates IS NOT NULL,
    'canConfigure', public.has_org_role(ARRAY['admin']), 'open', v_open,
    'machineChoices', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id), '[]'::jsonb) FROM public.machines WHERE organization_id = org),
    'costingMachines', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id), '[]'::jsonb) FROM public.costing_machines WHERE organization_id = org),
    'links', (SELECT coalesce(jsonb_agg(jsonb_build_object('machine_id', machine_id, 'costing_machine_id', costing_machine_id)), '[]'::jsonb)
              FROM public.job_costing_machine_links WHERE organization_id = org),
    'declarations', (SELECT jsonb_build_object('labour_not_required', labour_not_required, 'machines_not_required', machines_not_required)
                     FROM public.job_cost_declarations WHERE job_id = p_job AND organization_id = org));
  IF NOT (cfg ->> 'enabled')::boolean OR v_rates IS NULL THEN RETURN result; END IF;
  RETURN result || jsonb_build_object(
    'snapshot', v_snap,
    'live', CASE WHEN v_open THEN public.job_cost_figures(org, p_job, v_rates) END,
    'invoices', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'subtotal', subtotal::text)), '[]'::jsonb)
                 FROM public.invoices WHERE organization_id = org AND job_id = p_job),
    'credits', (SELECT coalesce(jsonb_agg(jsonb_build_object('invoice_id', c.invoice_id, 'status', c.status, 'subtotal', c.subtotal::text)), '[]'::jsonb)
                FROM public.credit_notes c JOIN public.invoices i ON i.id = c.invoice_id AND i.organization_id = org
                WHERE c.organization_id = org AND i.job_id = p_job),
    'quoteLines', (SELECT coalesce(jsonb_agg(jsonb_build_object('quantity', quantity::text, 'unit_price', unit_price::text, 'declined', declined)), '[]'::jsonb)
                   FROM public.quote_line_items WHERE organization_id = org AND quote_id = q));
END $$;
REVOKE ALL ON FUNCTION public.job_profitability_actual_inputs(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.job_profitability_actual_inputs(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
