-- Tolra database catalogue fingerprint. READ ONLY: selects from system catalogues, changes nothing.
--
-- One row per security-relevant object: RLS state, policies, functions, triggers, PostgREST role settings and
-- table grants for the API roles. Each row carries an md5 of the definition, so two databases can be compared row by row.
--
-- Used by:
--   * tests/db/catalogue.test.ts  - a fresh 000->latest build must match tests/db/catalogue.snapshot.json
--   * release checks (audit A1/SEC13) - run in the Supabase SQL editor, export as CSV/JSON and diff against
--     the snapshot to prove the live database carries the expected definitions (not merely the file names).
--
-- Columns: kind | object | detail (md5 of the definition, or a plain value)
WITH
tables AS (
  SELECT c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'security_audit') AND c.relkind IN ('r', 'p')
),
rows AS (
  SELECT 'rls' AS kind, nspname || '.' || relname AS object,
         CASE WHEN relrowsecurity THEN 'enabled' ELSE 'DISABLED' END || CASE WHEN relforcerowsecurity THEN ',forced' ELSE '' END AS detail
  FROM tables
  UNION ALL
  SELECT 'policy', p.schemaname || '.' || p.tablename || ' :: ' || p.policyname,
         p.permissive || ' ' || p.cmd || ' ' || array_to_string(p.roles, ',') || ' '
           || md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))
  FROM pg_policies p
  WHERE p.schemaname = 'public' OR (p.schemaname = 'storage' AND p.tablename = 'objects')
  UNION ALL
  SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         CASE WHEN p.prosecdef THEN 'definer ' ELSE 'invoker ' END
           || coalesce(array_to_string(p.proconfig, ','), '') || ' ' || md5(p.prosrc)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'function-grant', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         coalesce((SELECT string_agg(r.rolname, ',' ORDER BY r.rolname)
                   FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   JOIN pg_roles r ON r.oid = a.grantee
                   WHERE a.privilege_type = 'EXECUTE' AND r.rolname IN ('anon', 'authenticated', 'service_role')), '')
           || CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN ',PUBLIC' ELSE '' END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'trigger', n.nspname || '.' || c.relname || ' :: ' || t.tgname,
         t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal
    AND (n.nspname IN ('public', 'security_audit') OR (n.nspname = 'auth' AND c.relname = 'users'))
  UNION ALL
  -- Unique indexes encode business rules (one job number per company, one job per sales order).
  SELECT 'unique-index', i.schemaname || '.' || i.tablename || ' :: ' || i.indexname, md5(i.indexdef)
  FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname
  JOIN pg_index x ON x.indexrelid = c.oid
  WHERE i.schemaname = 'public' AND x.indisunique AND NOT x.indisprimary
  UNION ALL
  -- PostgREST settings stored on its login role (e.g. the pre-request session check from 017).
  SELECT 'role-config', r.rolname || ' :: ' || split_part(c, '=', 1), split_part(c, '=', 2)
  FROM pg_roles r, unnest(r.rolconfig) AS c
  WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.%'
  UNION ALL
  SELECT 'table-grant', t.nspname || '.' || t.relname || ' :: ' || g.grantee,
         string_agg(g.privilege_type, ',' ORDER BY g.privilege_type)
  FROM tables t
  JOIN information_schema.role_table_grants g ON g.table_schema = t.nspname AND g.table_name = t.relname
  WHERE g.grantee IN ('anon', 'authenticated')
  GROUP BY t.nspname, t.relname, g.grantee
)
SELECT kind, object, detail FROM rows ORDER BY kind, object;
