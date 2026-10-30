-- Migration 110 (logging an RFQ clarification e-mail is one transaction). Read only: rows 1 to 4 should be TRUE (FALSE, never an
-- error, while 110 is not applied).
WITH fn AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.prorettype, p.prosrc FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.log_rfq_clarification(uuid,text,text)')
)
SELECT 1 AS row, 'log_rfq_clarification_present' AS check_name, EXISTS (SELECT 1 FROM fn) AS ok
-- Definer with 110's search_path, returns jsonb.
UNION ALL SELECT 2, 'definer_search_path_jsonb',
  coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] AND prorettype = 'jsonb'::regtype FROM fn), FALSE)
-- Signed-in only: authenticated may call it; anon and PUBLIC may not.
UNION ALL SELECT 3, 'signed_in_only',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn), FALSE)
-- The row rules are re-checked inside: company, role, the RFQ and E-mail/Approval sections.
UNION ALL SELECT 4, 'rechecks_company_role_sections',
  coalesce((SELECT prosrc LIKE '%current_user_organization_id()%' AND prosrc LIKE '%has_org_role(ARRAY[''admin'', ''office''])%'
              AND prosrc LIKE '%section_allowed(''rfq'')%' AND prosrc LIKE '%section_allowed(''email'')%' AND prosrc LIKE '%section_allowed(''approval'')%'
              AND prosrc LIKE '%r.organization_id = v_org%' FROM fn), FALSE)
ORDER BY 1;
