-- Read only: after release 154 (customer portal sign-in; registered in supabase/release-plan.json as phase 154, after 153), every row must say true.
-- What it proves: the three portal tables and the refusal log exist with row security and no grant to any API role; the six customer-side
-- functions are callable by the service role only, the three staff functions by signed-in users only, all SECURITY DEFINER with a pinned
-- search_path; the private functions are callable by no API role; customer, contact and code references are ON DELETE RESTRICT; the
-- same-company, guard, no-truncate and contact row-audit triggers are on; codes are hashed (64 hex), single use, 10 minutes, at most 5
-- attempts; sessions are bound to a token hash, 8 hours absolute; no table holds a clear code, reference or token; every session's company
-- and customer are its contact's; every customer-side read goes through the gate, which reads the portal switch; 153 is whole (its eight
-- callable functions only). Invariants only: each row stays true after contacts are invited, sign in, sessions end and contacts are revoked
-- (the release-time "no rows yet" check is in the release's own self-check).
SELECT 'tables: customer_portal_contacts, customer_portal_signin_codes, customer_portal_sessions and security_audit.customer_portal_refusals exist with row security' AS check_name,
  coalesce((SELECT bool_and(c.relrowsecurity) AND count(*) = 4 FROM pg_class c
            WHERE c.oid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'),
                            to_regclass('public.customer_portal_sessions'), to_regclass('security_audit.customer_portal_refusals'))), false) AS ok
UNION ALL SELECT 'API: no grant on any portal table or the refusal log to anon, authenticated or the service role',
  coalesce(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public.customer_portal_contacts', 'public.customer_portal_signin_codes', 'public.customer_portal_sessions',
                                                  'security_audit.customer_portal_refusals']) AS tb(n), unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
                       WHERE to_regclass(tb.n) IS NULL OR has_table_privilege(r.role, tb.n, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')), false)
UNION ALL SELECT 'customer side: request, verify, resolve, end, quotes and jobs are SECURITY DEFINER with a pinned search_path, callable by the service role only',
  coalesce((SELECT count(*) = 6 FROM unnest(ARRAY['public.portal_signin_request(text,text[],text[])', 'public.portal_signin_verify(text,text,text)',
                                                  'public.portal_session_resolve(text)', 'public.portal_session_end(text)', 'public.portal_quotes(text)',
                                                  'public.portal_jobs(text)']) AS f(sig)
            JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
            WHERE p.prosecdef AND p.proconfig::TEXT LIKE '%search_path=pg_catalog, public, security_audit%'
              AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')), false)
UNION ALL SELECT 'staff side: invite, list and revoke are SECURITY DEFINER with a pinned search_path, callable by signed-in users only',
  coalesce((SELECT count(*) = 3 FROM unnest(ARRAY['public.portal_contact_invite(uuid,text,text,text[],text)', 'public.portal_contacts_list(uuid)',
                                                  'public.portal_contact_revoke(uuid,text)']) AS f(sig)
            JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
            WHERE p.prosecdef AND p.proconfig::TEXT LIKE '%search_path=pg_catalog, public%'
              AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')), false)
UNION ALL SELECT 'private: the session gate, the refusal writer and the trigger functions are callable by no API role',
  coalesce(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public._portal_session_gate(text,text)', 'security_audit.portal_refuse(text,text,text,uuid)',
                                                  'public.portal_contacts_guard()', 'public.portal_signin_codes_guard()', 'public.portal_sessions_guard()',
                                                  'public.portal_no_truncate()']) AS f(sig), unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
                       WHERE to_regprocedure(f.sig) IS NULL OR has_function_privilege(r.role, to_regprocedure(f.sig), 'EXECUTE')), false)
UNION ALL SELECT 'references: customer, contact and code references are ON DELETE RESTRICT (five), never CASCADE',
  (SELECT count(*) = 5 FROM pg_constraint c WHERE c.contype = 'f' AND c.confdeltype = 'r'
     AND c.conrelid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'), to_regclass('public.customer_portal_sessions'))
     AND c.confrelid IN (to_regclass('public.customers'), to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes')))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.confdeltype = 'c'
     AND c.conrelid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'), to_regclass('public.customer_portal_sessions')))
UNION ALL SELECT 'triggers: same company (5), guard (3), no truncate (3) and the contact row audit are on',
  (SELECT count(*) = 12 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
     AND (t.tgrelid, t.tgname, t.tgfoid) IN (
       (to_regclass('public.customer_portal_contacts'), 'zz_same_org_customer_id', to_regprocedure('public.enforce_same_org_parent()')),
       (to_regclass('public.customer_portal_signin_codes'), 'zz_same_org_contact_id', to_regprocedure('public.enforce_same_org_parent()')),
       (to_regclass('public.customer_portal_sessions'), 'zz_same_org_contact_id', to_regprocedure('public.enforce_same_org_parent()')),
       (to_regclass('public.customer_portal_sessions'), 'zz_same_org_customer_id', to_regprocedure('public.enforce_same_org_parent()')),
       (to_regclass('public.customer_portal_sessions'), 'zz_same_org_code_id', to_regprocedure('public.enforce_same_org_parent()')),
       (to_regclass('public.customer_portal_contacts'), 'portal_contacts_guard', to_regprocedure('public.portal_contacts_guard()')),
       (to_regclass('public.customer_portal_signin_codes'), 'portal_signin_codes_guard', to_regprocedure('public.portal_signin_codes_guard()')),
       (to_regclass('public.customer_portal_sessions'), 'portal_sessions_guard', to_regprocedure('public.portal_sessions_guard()')),
       (to_regclass('public.customer_portal_contacts'), 'portal_no_truncate', to_regprocedure('public.portal_no_truncate()')),
       (to_regclass('public.customer_portal_signin_codes'), 'portal_no_truncate', to_regprocedure('public.portal_no_truncate()')),
       (to_regclass('public.customer_portal_sessions'), 'portal_no_truncate', to_regprocedure('public.portal_no_truncate()')),
       (to_regclass('public.customer_portal_contacts'), 'audit_customer_portal_contacts_changes', to_regprocedure('security_audit.log_row_change()'))))
UNION ALL SELECT 'codes: 64-hex hashes only, ten minutes, at most five attempts, used or burnt once, at most one live code per contact',
  (SELECT count(*) = 7 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.customer_portal_signin_codes') AND c.contype = 'c'
     AND c.conname IN ('customer_portal_signin_codes_ref_hash', 'customer_portal_signin_codes_code_hash', 'customer_portal_signin_codes_ten_minutes',
                       'customer_portal_signin_codes_attempts', 'customer_portal_signin_codes_once', 'customer_portal_signin_codes_burn', 'customer_portal_signin_codes_live'))
  AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'customer_portal_signin_codes' AND indexname = 'customer_portal_signin_codes_one_live')
  AND NOT EXISTS (SELECT 1 FROM public.customer_portal_signin_codes x
                  WHERE x.expires_at <> x.created_at + interval '10 minutes' OR x.attempts > 5 OR (x.code_hash IS NOT NULL AND x.attempts >= 5)
                     OR (x.code_hash IS NULL) <> (x.used_at IS NOT NULL OR x.burnt_at IS NOT NULL))
UNION ALL SELECT 'sessions: bound to a 64-hex token hash, eight hours absolute, one session per code, ended with a known reason',
  (SELECT count(*) = 4 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.customer_portal_sessions') AND c.contype = 'c'
     AND c.conname IN ('customer_portal_sessions_token_hash', 'customer_portal_sessions_eight_hours', 'customer_portal_sessions_seen', 'customer_portal_sessions_end'))
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.customer_portal_sessions') AND c.conname = 'customer_portal_sessions_code_key' AND c.contype = 'u')
  AND NOT EXISTS (SELECT 1 FROM public.customer_portal_sessions x WHERE x.absolute_expires_at <> x.created_at + interval '8 hours')
UNION ALL SELECT 'no clear secret: the code and session tables hold no e-mail, code, reference or token column (hashes only)',
  NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name IN ('customer_portal_signin_codes', 'customer_portal_sessions')
              AND column_name NOT IN ('id', 'organization_id', 'contact_id', 'customer_id', 'code_id', 'ref_hash', 'code_hash', 'token_hash', 'created_at',
                                      'expires_at', 'attempts', 'used_at', 'burnt_at', 'burn_reason', 'last_seen_at', 'absolute_expires_at', 'ended_at', 'end_reason'))
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'security_audit' AND table_name = 'customer_portal_refusals'
              AND column_name NOT IN ('id', 'correlation_id', 'step', 'reason', 'subject_hash16', 'organization_id', 'created_at'))
UNION ALL SELECT 'isolation: every code and session belongs to its contact''s company, and every session to its contact''s customer',
  NOT EXISTS (SELECT 1 FROM public.customer_portal_sessions x JOIN public.customer_portal_contacts k ON k.id = x.contact_id
              WHERE k.organization_id <> x.organization_id OR k.customer_id <> x.customer_id)
  AND NOT EXISTS (SELECT 1 FROM public.customer_portal_signin_codes x JOIN public.customer_portal_contacts k ON k.id = x.contact_id
              WHERE k.organization_id <> x.organization_id)
  AND NOT EXISTS (SELECT 1 FROM public.customer_portal_contacts k JOIN public.customers c ON c.id = k.customer_id WHERE c.organization_id <> k.organization_id)
UNION ALL SELECT 'revoked contacts: no live session and no live code',
  NOT EXISTS (SELECT 1 FROM public.customer_portal_contacts k WHERE k.revoked_at IS NOT NULL
              AND (EXISTS (SELECT 1 FROM public.customer_portal_sessions x WHERE x.contact_id = k.id AND x.ended_at IS NULL)
                   OR EXISTS (SELECT 1 FROM public.customer_portal_signin_codes x WHERE x.contact_id = k.id AND x.code_hash IS NOT NULL)))
UNION ALL SELECT 'portal OFF: the gate reads the company switch, and every signed-in customer call goes through the gate; request and verify read the switch',
  coalesce((SELECT p.prosrc LIKE '%public.customer_portal_switch%' AND p.prosrc LIKE '%portal_off%' FROM pg_proc p WHERE p.oid = to_regprocedure('public._portal_session_gate(text,text)')), false)
  AND (SELECT count(*) = 3 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.portal_session_resolve(text)'), to_regprocedure('public.portal_quotes(text)'),
         to_regprocedure('public.portal_jobs(text)')) AND p.prosrc LIKE '%public._portal_session_gate(p_token_hash,%')
  AND (SELECT count(*) = 3 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.portal_signin_request(text,text[],text[])'),
         to_regprocedure('public.portal_signin_verify(text,text,text)'), to_regprocedure('public.portal_contact_invite(uuid,text,text,text[],text)'))
         AND p.prosrc LIKE '%public.customer_portal_switch%' AND p.prosrc LIKE '%portal_off%')
UNION ALL SELECT '153 whole: its tables, view and eight callable functions are present, and no 154 function is named like a 153 one',
  to_regclass('public.document_customer_links') IS NOT NULL AND to_regclass('public.document_customer_links_verified') IS NOT NULL
  AND to_regclass('public.customer_portal_switch') IS NOT NULL
  AND (SELECT count(*) = 8 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND (p.proname LIKE '%document_customer%' OR p.proname LIKE 'customer_portal%') AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'customer_portal%'
         AND p.proname NOT IN ('customer_portal_status', 'customer_portal_set_enabled', 'customer_portal_switch_guard', 'customer_portal_switch_no_truncate'));
