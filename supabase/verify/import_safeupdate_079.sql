-- Migration 079 (the data import through the API again: WHERE TRUE on import_company_data_run's eight UPDATEs that had no WHERE of
-- their own, which Supabase's pg-safeupdate refuses in API sessions). Read only: every row should be TRUE.
-- Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH RECURSIVE f AS (
  SELECT p.*, regexp_replace(p.prosrc, '\s', '', 'g') AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)')
),
-- Every function in public and security_audit (extensions' own excluded), with its text: prosrc, or the whole definition for a
-- BEGIN ATOMIC body (prosrc is empty there).
fn AS (
  SELECT p.oid, p.proname, n.nspname,
         CASE WHEN p.prosqlbody IS NOT NULL THEN pg_get_functiondef(p.oid) ELSE p.prosrc END AS src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND p.prokind IN ('f', 'p')
    AND p.prolang IN (SELECT l.oid FROM pg_language l WHERE l.lanname IN ('plpgsql', 'sql'))
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
),
-- Static check: each statement (comments dropped, split at ';'); from each UPDATE <table> [alias] SET or DELETE FROM in it (a
-- data-changing WITH has several) to the statement's end, with every parenthesised part removed (subqueries, function calls) and cut
-- at the first ')' left over (the end of a WITH part or of an EXECUTE format('...') string): what is left must contain WHERE. The SQL
-- inside EXECUTE format('...') strings is checked the same way.
stmt AS (
  SELECT fn.oid, s.n, s.t
  FROM fn, LATERAL regexp_split_to_table(regexp_replace(fn.src, '--[^\n]*', '', 'g'), ';') WITH ORDINALITY AS s(t, n)
),
occ AS (
  SELECT stmt.oid, stmt.n, k,
         substring(stmt.t FROM regexp_instr(stmt.t, '\m(?:UPDATE\s+(?:ONLY\s+)?[[:alnum:]_.%"]+(?:\s+(?:AS\s+)?[[:alnum:]_]+)?\s+SET|DELETE\s+FROM)\M', 1, k, 0, 'i')) AS t
  FROM stmt, LATERAL generate_series(1, regexp_count(stmt.t, '\m(?:UPDATE\s+(?:ONLY\s+)?[[:alnum:]_.%"]+(?:\s+(?:AS\s+)?[[:alnum:]_]+)?\s+SET|DELETE\s+FROM)\M', 1, 'i')) AS k
),
flat(oid, n, k, t, i) AS (
  SELECT oid, n, k, t, 0 FROM occ
  UNION ALL SELECT oid, n, k, regexp_replace(t, '\([^()]*\)', ' ', 'g'), i + 1 FROM flat WHERE t ~ '\([^()]*\)' AND i < 50
),
unqualified AS (
  SELECT x.oid FROM flat x
  WHERE NOT EXISTS (SELECT 1 FROM flat y WHERE y.oid = x.oid AND y.n = x.n AND y.k = x.k AND y.i > x.i)
    AND split_part(x.t, ')', 1) !~* '\mWHERE\M'
)
SELECT 'function_is_079' AS check_name, (SELECT md5(body) = 'f7c672e961be898619c046d76458680e' FROM f) AS ok
-- 076's body exactly, but for WHERE TRUE added to eight statements (and nothing else).
UNION ALL SELECT 'only_where_true_added', (SELECT md5(replace(body, 'WHERETRUE;', ';')) = '648b7e0652cf46eacf73685343ef9572'
                                                 AND (length(body) - length(replace(body, 'WHERETRUE;', ''))) = 8 * length('WHERETRUE;') FROM f)
UNION ALL SELECT 'same_signature_and_settings', (SELECT NOT prosecdef AND prorettype = 'jsonb'::regtype AND proconfig = ARRAY['search_path=pg_catalog, public']
                                                        AND prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') FROM f)
UNION ALL SELECT 'not_callable_from_api', (SELECT NOT has_function_privilege('anon', f.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', f.oid, 'EXECUTE')
                                                  AND NOT has_function_privilege('public', f.oid, 'EXECUTE') FROM f)
-- The import functions the API reaches (076's five callable ones and every internal import_* helper): no UPDATE or DELETE without
-- its own WHERE.
UNION ALL SELECT 'import_functions_where_qualified', (SELECT count(*) >= 18 FROM fn WHERE fn.nspname = 'public' AND fn.proname LIKE 'import\_%')
                                                     AND NOT EXISTS (SELECT 1 FROM unqualified u JOIN fn ON fn.oid = u.oid WHERE fn.nspname = 'public' AND fn.proname LIKE 'import\_%')
-- And no other function either (triggers an import or a clock action fires, 078's purge and numbering, everything else).
UNION ALL SELECT 'all_functions_where_qualified', NOT EXISTS (SELECT 1 FROM unqualified);
