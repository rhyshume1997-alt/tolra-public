-- Post-144 release step 145. One-time, one transaction; never part of baseline replay.
-- Canonical source: supabase/proposals/n5_company_setup.sql. Existing objects cause refusal, never overwrite.
BEGIN;
DO $post_release_guard$ BEGIN
 IF to_regprocedure('public.accounting_cloud_connections_ready()') IS NULL THEN
  RAISE EXCEPTION '145: required release 144 is missing; stop and check release preflight';
 END IF;
END $post_release_guard$;

CREATE TABLE public.company_setup_progress (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  step text NOT NULL CHECK (step IN ('company','branding','hours','breaks','people','connections','ai','email','import')),
  completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id, step)
);
-- my_session is the existing scoped SECURITY DEFINER API; never grant the private membership helper.
-- Reject support even when elevated; session_read_only alone would allow elevated support.
ALTER TABLE public.company_setup_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "setup own admin select" ON public.company_setup_progress FOR SELECT TO authenticated
 USING (organization_id = (SELECT public.current_user_organization_id()) AND public.has_org_role(ARRAY['admin']) AND NOT coalesce(((SELECT public.my_session()) ->> 'support')::boolean,true));
CREATE POLICY "setup own admin insert" ON public.company_setup_progress FOR INSERT TO authenticated
 WITH CHECK (organization_id = (SELECT public.current_user_organization_id()) AND public.has_org_role(ARRAY['admin']) AND NOT coalesce(((SELECT public.my_session()) ->> 'support')::boolean,true));
CREATE POLICY "setup own admin update" ON public.company_setup_progress FOR UPDATE TO authenticated
 USING (organization_id = (SELECT public.current_user_organization_id()) AND public.has_org_role(ARRAY['admin']) AND NOT coalesce(((SELECT public.my_session()) ->> 'support')::boolean,true))
 WITH CHECK (organization_id = (SELECT public.current_user_organization_id()) AND public.has_org_role(ARRAY['admin']) AND NOT coalesce(((SELECT public.my_session()) ->> 'support')::boolean,true));
REVOKE ALL ON public.company_setup_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.company_setup_progress TO authenticated;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.company_setup_progress FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();

COMMIT;
