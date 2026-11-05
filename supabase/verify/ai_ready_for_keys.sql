-- Read-only checks after the reviewed AI readiness proposal. Every row must be true.
SELECT 'ai_helper_status_body' AS check_name, (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = 'a144add4b49efdc0b08fb9a3ad4657d9' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_status()')) AS ok
UNION ALL
SELECT 'ai_helper_save_settings_body' AS check_name, (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = 'e26d13bc31075b5633013db3345696c0' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_save_settings(boolean,boolean,integer)')) AS ok
UNION ALL
SELECT 'ai_helper_reserve_body' AS check_name, (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '4f01eb3ad6e06cccbd53fb86482cd3d6' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)')) AS ok
UNION ALL
SELECT 'ai_helper_reserve_assistant_body' AS check_name, (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '8b8594f704c5cb1b8edf154c582ace36' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid = to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)')) AS ok
UNION ALL
SELECT 'new_company_default_1000', (SELECT column_default = '1000' FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_helper_settings' AND column_name='monthly_cap_pence');
