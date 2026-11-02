-- 136 rollback: ONLY with Rhys's approval. Drops the trigger organization_members_recent_second_step on public.organization_members and
-- its function public.organization_members_recent_second_step(). 136 changed nothing else (no function, table, column, policy, grant or
-- row), so the database is back to the chain with 135 / 134. After it, a signed-in browser calling set_member_access or
-- admin_set_company_access directly is no longer asked for a recent authenticator code by the database (the app's routes still are).
-- No data is touched, so there is nothing to stop on. Run the whole text as one transaction, then the release preflight (marker 136
-- shows "not applied").
BEGIN;
DROP TRIGGER IF EXISTS organization_members_recent_second_step ON public.organization_members;
DROP FUNCTION IF EXISTS public.organization_members_recent_second_step();

DO $$
BEGIN
  IF to_regprocedure('public.organization_members_recent_second_step()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.organization_members'::regclass AND t.tgname = 'organization_members_recent_second_step') THEN
    RAISE EXCEPTION '136 rollback: the database is not back to the chain before 136';
  END IF;
END
$$;
COMMIT;
