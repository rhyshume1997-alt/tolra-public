-- Step 01 (run on quoteflow-prod, after 007 and import/import_legacy_tenant.sql). Idempotent.
-- Supabase grants EXECUTE on every new function to anon and authenticated by default.
-- This closes off what neither role should call through the API:
--   * anon (not signed in) may call no public function at all;
--   * trigger functions are never callable as RPCs;
--   * security_audit.prevent_audit_mutation gets a fixed search_path (Supabase advisor warning).
-- Functions signed-in users need (helpers, next_doc_number, create_with_lines, write_audit,
-- switch_organization, my_organizations, org_members, set_member_access) keep their explicit grants.

DO $$
DECLARE f RECORD;
BEGIN
  -- 1. anon: no public or security_audit function is callable without signing in.
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'security_audit') AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f.sig);
  END LOOP;

  -- 2. Trigger functions: nobody calls these directly.
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'security_audit') AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
  END LOOP;
END $$;

ALTER FUNCTION security_audit.prevent_audit_mutation() SET search_path = pg_catalog;

-- Check: this must return no rows.
SELECT p.oid::regprocedure AS function_still_open_to_anon
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'security_audit') AND p.prokind = 'f'
  AND has_function_privilege('anon', p.oid, 'EXECUTE');
