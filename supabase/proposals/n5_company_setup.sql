-- N5 proposal only. Review and apply in a separate release; never run during app startup.
BEGIN;
CREATE TABLE public.company_setup_progress (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  step text NOT NULL CHECK (step IN ('company','branding','hours','breaks','people','connections','ai','email','import')),
  completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id, step)
);
ALTER TABLE public.company_setup_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "setup own admin select" ON public.company_setup_progress FOR SELECT TO authenticated
 USING (organization_id = (SELECT public.current_user_organization_id()) AND public.has_org_role(ARRAY['admin']) AND NOT coalesce((SELECT s.is_support FROM public._session_membership() s),true));
CREATE POLICY "setup own admin insert" ON public.company_setup_progress FOR INSERT TO authenticated
 WITH CHECK (organization_id = (SELECT public.current_user_organization_id()) AND public.has_org_role(ARRAY['admin']) AND NOT coalesce((SELECT s.is_support FROM public._session_membership() s),true));
CREATE POLICY "setup own admin update" ON public.company_setup_progress FOR UPDATE TO authenticated
 USING (organization_id = (SELECT public.current_user_organization_id()) AND public.has_org_role(ARRAY['admin']) AND NOT coalesce((SELECT s.is_support FROM public._session_membership() s),true))
 WITH CHECK (organization_id = (SELECT public.current_user_organization_id()) AND public.has_org_role(ARRAY['admin']) AND NOT coalesce((SELECT s.is_support FROM public._session_membership() s),true));
REVOKE ALL ON public.company_setup_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.company_setup_progress TO authenticated;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.company_setup_progress FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
COMMIT;
