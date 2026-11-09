-- Read-only verification after the proposal is separately reviewed/applied.
-- NOT RUN by this PR. No key/ciphertext is selected into the output.
SELECT 'control has RLS' AS check_name, relrowsecurity AS passed FROM pg_class WHERE oid = 'public.ai_helper_tolra_control'::regclass
UNION ALL SELECT 'company settings have RLS', relrowsecurity FROM pg_class WHERE oid = 'public.ai_helper_tolra_companies'::regclass
UNION ALL SELECT 'anonymous cannot read control', NOT has_table_privilege('anon','public.ai_helper_tolra_control','SELECT')
UNION ALL SELECT 'signed-in users cannot read control', NOT has_table_privilege('authenticated','public.ai_helper_tolra_control','SELECT')
UNION ALL SELECT 'companies cannot raise allowance directly', NOT has_table_privilege('authenticated','public.ai_helper_tolra_companies','UPDATE')
UNION ALL SELECT 'signed-in users cannot read Tolra key', NOT has_function_privilege('authenticated','public.ai_helper_tolra_key(uuid,uuid)','EXECUTE')
UNION ALL SELECT 'signed-in users cannot enable global service', NOT has_function_privilege('authenticated','public.ai_helper_tolra_configure(boolean,text,uuid)','EXECUTE')
UNION ALL SELECT 'service can retrieve reserved key', has_function_privilege('service_role','public.ai_helper_tolra_key(uuid,uuid)','EXECUTE')
UNION ALL SELECT 'original reserve is not a public bypass', NOT has_function_privilege('authenticated','public._ai_helper_reserve_own_key(text,integer,text,integer)','EXECUTE')
UNION ALL SELECT 'provided reserve is not a public bypass', NOT has_function_privilege('authenticated','public._ai_helper_reserve_tolra(text,integer,text,integer)','EXECUTE')
UNION ALL SELECT 'companies cannot set caps', NOT has_function_privilege('authenticated','public.ai_helper_tolra_set_cap(uuid,integer,uuid)','EXECUTE')
UNION ALL SELECT 'companies cannot list other caps', NOT has_function_privilege('authenticated','public.ai_helper_tolra_caps()','EXECUTE')
UNION ALL SELECT 'service can set caps', has_function_privilege('service_role','public.ai_helper_tolra_set_cap(uuid,integer,uuid)','EXECUTE')
UNION ALL SELECT '1000p default', (SELECT column_default::INTEGER = 1000 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_tolra_companies' AND column_name = 'monthly_cap_pence')
UNION ALL SELECT 'caps bounded by 100000p', NOT EXISTS(SELECT 1 FROM public.ai_helper_tolra_companies WHERE monthly_cap_pence < 0 OR monthly_cap_pence > 100000)
UNION ALL SELECT 'valid encrypted form only', NOT EXISTS(SELECT 1 FROM public.ai_helper_tolra_control WHERE api_key_enc IS NOT NULL AND api_key_enc !~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
UNION ALL SELECT 'allowance and ledger nonnegative', NOT EXISTS(SELECT 1 FROM public.ai_helper_tolra_companies WHERE monthly_cap_pence < 0)
UNION ALL SELECT 'own reserve body preserved', (SELECT md5(regexp_replace(prosrc,'\s','','g')) FROM pg_proc WHERE oid = 'public._ai_helper_reserve_own_key(text,integer,text,integer)'::regprocedure) = '972540e833a42bbb35ac5b670c56daa8'
UNION ALL SELECT 'assistant own reserve body preserved', (SELECT md5(regexp_replace(prosrc,'\s','','g')) FROM pg_proc WHERE oid = 'public._ai_helper_reserve_assistant_own_key(integer,text,integer)'::regprocedure) = 'f3e880f36702f8a1d358a4da194f7b5a';
