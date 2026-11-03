-- Read only. Every row must be true. Does not install or validate the software.
WITH f AS (SELECT * FROM pg_proc WHERE oid=to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)'))
SELECT '147 body checksum' AS check_name, coalesce((SELECT md5(regexp_replace(prosrc,'\s','','g'))='63145f3026fdc7db5dc1ba0a5928177a' FROM f),false) AS ok
UNION ALL SELECT '147 invoker and pinned path', coalesce((SELECT NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public'] AND prorettype='jsonb'::regtype AND provolatile='v' FROM f),false)
UNION ALL SELECT '147 authenticated only API grant', coalesce((SELECT has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('service_role',oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') FROM f),false)
UNION ALL SELECT '147 underlying RLS retained', coalesce((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.chase_steps')),false);
