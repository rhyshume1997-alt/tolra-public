-- 004: organisation-wide display settings (hidden menu items, hidden table columns).
-- Idempotent: safe to run more than once. Requires public.user_organization_id()
-- and public.has_org_role() (both from 000_base_schema.sql).

CREATE TABLE IF NOT EXISTS public.organization_settings (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  hidden_nav TEXT[] NOT NULL DEFAULT '{}',
  hidden_columns JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.organization_settings ADD COLUMN IF NOT EXISTS hidden_nav TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.organization_settings ADD COLUMN IF NOT EXISTS hidden_columns JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.organization_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organization_settings select" ON public.organization_settings;
CREATE POLICY "organization_settings select" ON public.organization_settings FOR SELECT
  USING (organization_id = public.user_organization_id());

-- Admin and office may write (office needs this to change column visibility in place).
DROP POLICY IF EXISTS "organization_settings insert" ON public.organization_settings;
CREATE POLICY "organization_settings insert" ON public.organization_settings FOR INSERT
  WITH CHECK (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));

DROP POLICY IF EXISTS "organization_settings update" ON public.organization_settings;
CREATE POLICY "organization_settings update" ON public.organization_settings FOR UPDATE
  USING (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']))
  WITH CHECK (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));

-- Only admins may change which menu items are hidden.
CREATE OR REPLACE FUNCTION public.organization_settings_guard_nav()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.hidden_nav IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.hidden_nav ELSE '{}'::text[] END)
     AND NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can change hidden menu items';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_settings_guard_nav ON public.organization_settings;
CREATE TRIGGER organization_settings_guard_nav
  BEFORE INSERT OR UPDATE ON public.organization_settings
  FOR EACH ROW EXECUTE FUNCTION public.organization_settings_guard_nav();
