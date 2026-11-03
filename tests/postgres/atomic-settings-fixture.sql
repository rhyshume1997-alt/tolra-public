-- Standalone contract fixture, NOT the production schema or an Auth service.
-- RLS is enabled and calls run as authenticated, never as the owner.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
CREATE TABLE public.test_members(user_id uuid PRIMARY KEY, organization_id uuid NOT NULL, role text NOT NULL);
GRANT USAGE ON SCHEMA auth TO authenticated,anon;
GRANT SELECT ON public.test_members TO authenticated;
CREATE FUNCTION public.current_user_organization_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT organization_id FROM public.test_members WHERE user_id=auth.uid() $$;
CREATE FUNCTION public.has_org_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT role=ANY(roles) FROM public.test_members WHERE user_id=auth.uid()),false) $$;
CREATE FUNCTION public.my_session() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('support',coalesce(current_setting('test.support',true),'false')='true','read_only',coalesce(current_setting('test.read_only',true),'false')='true') $$;
CREATE FUNCTION public.assert_privileged_aal() RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF current_setting('test.aal',true) IS DISTINCT FROM 'aal2' THEN RAISE EXCEPTION 'Second step required' USING ERRCODE='42501'; END IF; END $$;
CREATE TABLE public.chase_steps(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,offset_days integer NOT NULL CHECK(offset_days BETWEEN -60 AND 365),tone text NOT NULL CHECK(tone IN ('before_due','friendly','firm','final')), UNIQUE(organization_id,offset_days),CHECK((offset_days<=0)=(tone='before_due')));
CREATE TABLE public.costing_materials(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),price_pence integer NOT NULL CHECK(price_pence BETWEEN 0 AND 10000000),price_unit text NOT NULL CHECK(price_unit IN ('kg','each')),scrap_pct numeric NOT NULL CHECK(scrap_pct BETWEEN 0 AND 100));
CREATE UNIQUE INDEX ON public.costing_materials(organization_id,lower(btrim(name)));
CREATE TABLE public.costing_machines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),hourly_rate_pence integer NOT NULL CHECK(hourly_rate_pence BETWEEN 0 AND 10000000),labour_rate_pence integer CHECK(labour_rate_pence BETWEEN 0 AND 10000000));
CREATE UNIQUE INDEX ON public.costing_machines(organization_id,lower(btrim(name)));
CREATE TABLE public.costing_defaults(organization_id uuid PRIMARY KEY,labour_rate_pence integer NOT NULL CHECK(labour_rate_pence BETWEEN 0 AND 10000000),programming_rate_pence integer NOT NULL CHECK(programming_rate_pence BETWEEN 0 AND 10000000),overhead_pct numeric NOT NULL CHECK(overhead_pct BETWEEN 100 AND 500),default_margin_pct numeric NOT NULL CHECK(default_margin_pct BETWEEN 0 AND 95));
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['chase_steps','costing_materials','costing_machines','costing_defaults'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO authenticated',t);
 EXECUTE format('CREATE POLICY company_rates ON public.%I TO authenticated USING (organization_id=public.current_user_organization_id() AND public.has_org_role(ARRAY[''admin'',''office''])) WITH CHECK (organization_id=public.current_user_organization_id() AND public.has_org_role(ARRAY[''admin'',''office'']))',t);
END LOOP; END $$;
