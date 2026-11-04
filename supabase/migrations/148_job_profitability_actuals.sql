-- 148: optional actual job costing. Main ends at 137; leave 138–147 reserved for pending work.
-- New tables and RPCs only. Disabled by default. Never changes payroll or legacy profit calculations.
BEGIN;
CREATE TABLE public.job_costing_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  labour_rate_pence integer CHECK (labour_rate_pence >= 0),
  overhead_basis text NOT NULL DEFAULT 'none' CHECK (overhead_basis IN ('none','labour','machine')),
  overhead_rate_pence integer CHECK (overhead_rate_pence >= 0),
  approved_by uuid REFERENCES auth.users(id), approved_at timestamptz,
  CHECK (NOT enabled OR (labour_rate_pence IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL
    AND (overhead_basis = 'none' OR overhead_rate_pence IS NOT NULL)))
);
CREATE TABLE public.job_machine_cost_rates (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  machine_id uuid NOT NULL REFERENCES public.machines(id),
  rate_pence integer NOT NULL CHECK (rate_pence >= 0),
  includes_labour boolean NOT NULL, includes_overhead boolean NOT NULL,
  PRIMARY KEY (organization_id, machine_id)
);
CREATE TABLE public.job_cost_estimates (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id),
  supplier_pence integer CHECK (supplier_pence >= 0),
  labour_hours numeric(12,6) CHECK (labour_hours >= 0),
  overhead_hours numeric(12,6) CHECK (overhead_hours >= 0),
  labour_not_required boolean NOT NULL DEFAULT false, machines_not_required boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES auth.users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
-- Keep a private approval history: changing a rate recalculates the new view, never payroll or old profit.
CREATE TABLE public.job_costing_rate_history (
  organization_id uuid NOT NULL REFERENCES public.organizations(id), revision integer NOT NULL,
  settings jsonb NOT NULL, machine_rates jsonb NOT NULL, changed_by uuid NOT NULL REFERENCES auth.users(id),
  changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id, revision)
);
CREATE TRIGGER zz_same_org_machine BEFORE INSERT OR UPDATE ON public.job_machine_cost_rates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machines','machine_id');
CREATE TRIGGER zz_same_org_job BEFORE INSERT OR UPDATE ON public.job_cost_estimates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs','job_id');
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['job_costing_settings','job_machine_cost_rates','job_cost_estimates','job_costing_rate_history'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY financial_read ON public.%I FOR SELECT TO authenticated USING (
      organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin','office'])
      AND public.section_allowed('jobs') AND public.section_allowed('invoices')
      AND public.section_allowed('quotes') AND public.section_allowed('purchase-orders'))$p$, t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', t);
  END LOOP;
END $$;

-- Central gate also protects SECURITY DEFINER RPCs; RLS alone is not sufficient inside them.
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
REVOKE ALL ON FUNCTION public.job_costing_access(boolean) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.save_job_costing_rates(p_organization uuid, p_revision integer, p_enabled boolean, p_labour integer,
  p_overhead_basis text, p_overhead integer, p_machines jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.job_costing_access(true); current_revision integer; item jsonb;
BEGIN
  IF public.session_read_only() THEN RAISE EXCEPTION 'Read only' USING ERRCODE = '42501'; END IF;
  IF org IS DISTINCT FROM p_organization THEN RAISE EXCEPTION 'Company changed; reload rates' USING ERRCODE = '42501'; END IF;
  -- Lock even the first save; a revision cannot silently overwrite another admin's approval.
  PERFORM 1 FROM public.organizations WHERE id = org FOR UPDATE;
  SELECT revision INTO current_revision FROM public.job_costing_settings WHERE organization_id = org;
  IF coalesce(current_revision,0) IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'Rates changed; reload before saving' USING ERRCODE = '40001';
  END IF;
  IF p_enabled IS NULL OR p_labour IS NULL OR p_labour < 0 OR p_overhead_basis IS NULL
    OR p_overhead_basis NOT IN ('none','labour','machine') OR (p_overhead_basis <> 'none' AND p_overhead IS NULL)
    OR p_overhead < 0 OR jsonb_typeof(p_machines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Enter valid costing rates and inclusion flags' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.job_machine_cost_rates WHERE organization_id = org;
  FOR item IN SELECT value FROM jsonb_array_elements(p_machines) LOOP
    IF jsonb_typeof(item->'rate_pence') IS DISTINCT FROM 'number' OR (item->>'rate_pence') !~ '^\d+$'
      OR jsonb_typeof(item->'includes_labour') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(item->'includes_overhead') IS DISTINCT FROM 'boolean'
      OR NOT EXISTS (SELECT 1 FROM public.machines WHERE id = (item->>'machine_id')::uuid AND organization_id = org) THEN
      RAISE EXCEPTION 'Invalid machine rate or company' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.job_machine_cost_rates VALUES (org, (item->>'machine_id')::uuid, (item->>'rate_pence')::integer,
      (item->>'includes_labour')::boolean, (item->>'includes_overhead')::boolean);
  END LOOP;
  INSERT INTO public.job_costing_settings VALUES (org, p_enabled, p_revision + 1, p_labour, p_overhead_basis, p_overhead,
    CASE WHEN p_enabled THEN auth.uid() END, CASE WHEN p_enabled THEN now() END)
  ON CONFLICT (organization_id) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision,
    labour_rate_pence = excluded.labour_rate_pence, overhead_basis = excluded.overhead_basis, overhead_rate_pence = excluded.overhead_rate_pence,
    approved_by = excluded.approved_by, approved_at = excluded.approved_at;
  INSERT INTO public.job_costing_rate_history (organization_id, revision, settings, machine_rates, changed_by)
    SELECT org, revision, to_jsonb(s), p_machines, auth.uid() FROM public.job_costing_settings s WHERE organization_id = org;
END $$;
REVOKE ALL ON FUNCTION public.save_job_costing_rates(uuid,integer,boolean,integer,text,integer,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_job_costing_rates(uuid,integer,boolean,integer,text,integer,jsonb) TO authenticated;

CREATE FUNCTION public.save_job_cost_estimate(p_job uuid, p_supplier integer, p_labour numeric, p_overhead numeric,
  p_no_labour boolean, p_no_machines boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.job_costing_access(false);
BEGIN
  IF public.session_read_only() THEN RAISE EXCEPTION 'Read only' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job AND organization_id = org) THEN
    RAISE EXCEPTION 'Job unavailable' USING ERRCODE = '42501';
  END IF;
  IF (p_labour IS NOT NULL AND (p_labour::text IN ('NaN','Infinity','-Infinity') OR p_labour < 0 OR p_labour <> round(p_labour,6)))
    OR (p_overhead IS NOT NULL AND (p_overhead::text IN ('NaN','Infinity','-Infinity') OR p_overhead < 0 OR p_overhead <> round(p_overhead,6))) THEN
    RAISE EXCEPTION 'Invalid hours' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.job_cost_estimates VALUES (org,p_job,p_supplier,p_labour,p_overhead,p_no_labour,p_no_machines,auth.uid(),now())
  ON CONFLICT (job_id) DO UPDATE SET supplier_pence = excluded.supplier_pence, labour_hours = excluded.labour_hours,
    overhead_hours = excluded.overhead_hours, labour_not_required = excluded.labour_not_required,
    machines_not_required = excluded.machines_not_required, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
END $$;
REVOKE ALL ON FUNCTION public.save_job_cost_estimate(uuid,integer,numeric,numeric,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_job_cost_estimate(uuid,integer,numeric,numeric,boolean,boolean) TO authenticated;

-- One statement snapshot, explicit company predicates, no browser row cap and no employee pay data.
CREATE FUNCTION public.job_profitability_actual_inputs(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.job_costing_access(false); q uuid; cfg jsonb; result jsonb;
BEGIN
  SELECT quote_id INTO q FROM public.jobs WHERE id = p_job AND organization_id = org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job unavailable' USING ERRCODE = '42501'; END IF;
  SELECT to_jsonb(s) INTO cfg FROM public.job_costing_settings s WHERE organization_id = org;
  cfg := coalesce(cfg, '{"enabled":false,"revision":0,"approved_at":null,"labour_rate_pence":null,"overhead_basis":"none","overhead_rate_pence":null}'::jsonb);
  result := jsonb_build_object('organizationId',org,'jobId',p_job,'config',cfg,
    'canConfigure',public.has_org_role(ARRAY['admin']),
    'machineChoices',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) FROM public.machines WHERE organization_id = org),
    'rates',(SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM public.job_machine_cost_rates r WHERE organization_id = org),
    'estimate',(SELECT to_jsonb(e) FROM public.job_cost_estimates e WHERE job_id = p_job AND organization_id = org));
  IF NOT (cfg->>'enabled')::boolean THEN RETURN result; END IF;
  RETURN result || jsonb_build_object(
    'labour',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM public.operator_sessions s
      WHERE s.organization_id = org AND s.voided_at IS NULL AND (s.job_id = p_job OR EXISTS (
        SELECT 1 FROM public.operator_sessions own WHERE own.organization_id = org AND own.job_id = p_job AND own.voided_at IS NULL
          AND own.user_id = s.user_id AND own.started_at < coalesce(s.ended_at,'infinity') AND s.started_at < coalesce(own.ended_at,'infinity')))),
    'machines',(SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM public.machine_runs r
      WHERE r.organization_id = org AND (r.job_id = p_job OR EXISTS (
        SELECT 1 FROM public.machine_runs own WHERE own.organization_id = org AND own.job_id = p_job
          AND own.machine_id = r.machine_id AND own.started_at < coalesce(r.ended_at,'infinity') AND r.started_at < coalesce(own.ended_at,'infinity')))),
    'plans',(SELECT coalesce(jsonb_agg(jsonb_build_object('machine_id',machine_id,'estimated_hours',estimated_hours::text)),'[]'::jsonb)
      FROM public.job_machines WHERE organization_id = org AND job_id = p_job),
    'pos',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'total_value',total_value::text,'linked_net',linked_net::text)),'[]'::jsonb)
      FROM public.purchase_orders WHERE organization_id = org AND (job_id = p_job OR (job_id IS NULL AND quote_id = q))),
    'ambiguousQuoteCosts',(EXISTS (SELECT 1 FROM public.purchase_orders WHERE organization_id = org AND job_id IS NULL AND quote_id = q)
      AND EXISTS (SELECT 1 FROM public.jobs WHERE organization_id = org AND quote_id = q AND id <> p_job)),
    'invoices',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'subtotal',subtotal::text)),'[]'::jsonb)
      FROM public.invoices WHERE organization_id = org AND job_id = p_job),
    'credits',(SELECT coalesce(jsonb_agg(jsonb_build_object('invoice_id',c.invoice_id,'status',c.status,'subtotal',c.subtotal::text)),'[]'::jsonb)
      FROM public.credit_notes c JOIN public.invoices i ON i.id = c.invoice_id AND i.organization_id = org
      WHERE c.organization_id = org AND i.job_id = p_job),
    'quoteLines',(SELECT coalesce(jsonb_agg(jsonb_build_object('quantity',quantity::text,'unit_price',unit_price::text,'declined',declined)),'[]'::jsonb)
      FROM public.quote_line_items WHERE organization_id = org AND quote_id = q));
END $$;
REVOKE ALL ON FUNCTION public.job_profitability_actual_inputs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_profitability_actual_inputs(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
