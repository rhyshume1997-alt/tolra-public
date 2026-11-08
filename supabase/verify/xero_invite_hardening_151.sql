-- Read only: after a separately approved release 151 (registered in supabase/release-plan.json as phase 151, after 150), every row must say true.
-- What it proves, in words: the accountant's Xero connect link is an opaque reference bound to one company, the creating admin and one recipient address;
-- the old token functions are gone; the code functions are for the service role only; the invite table is unreadable through the API; no 107 token link
-- is still open; a code is only ever stored as a 64-hex keyed hash; nothing in the audit log carries a reference, code or hash.
SELECT 'invite table: new columns present, token_hash nullable, ref unique, bound check present' AS check_name,
  (SELECT count(*) = 10 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'integration_connect_invites'
     AND column_name IN ('ref', 'recipient_email', 'code_hash', 'code_expires_at', 'code_sent_at', 'code_sent_count', 'code_attempts', 'locked_at', 'expired_logged_at', 'revoke_reason'))
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'integration_connect_invites' AND column_name = 'token_hash' AND is_nullable = 'YES')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.integration_connect_invites') AND c.conname = 'integration_connect_invites_ref_key' AND c.contype = 'u')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.integration_connect_invites') AND c.conname = 'integration_connect_invites_bound')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.integration_connect_invites') AND c.conname = 'integration_connect_invites_recipient') AS ok
UNION ALL SELECT 'the 107 token functions are gone (create(text,text), redeem, and a peek by token hash)',
  to_regprocedure('public.integration_invite_create(text,text)') IS NULL AND to_regprocedure('public.integration_invite_redeem(text,text,text)') IS NULL
  AND coalesce((SELECT p.proargnames = ARRAY['p_ref'] FROM pg_proc p WHERE p.oid = to_regprocedure('public.integration_invite_peek(text)')), false)
UNION ALL SELECT 'no 107 token invite is still open',
  NOT EXISTS (SELECT 1 FROM public.integration_connect_invites i WHERE i.ref IS NULL AND i.used_at IS NULL AND i.revoked_at IS NULL)
UNION ALL SELECT 'peek, code_issue, code_verify, the callback consume and the refusal log: security definer, pinned search path, service role only (nobody else, not PUBLIC)',
  (SELECT bool_and(coalesce(p.prosecdef, false) AND p.proconfig IS NOT NULL
                   AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.integration_invite_peek(text)'), to_regprocedure('public.integration_invite_code_issue(text,text)'),
                                  to_regprocedure('public.integration_invite_code_verify(text,text,text,text)'),
                                  to_regprocedure('public.integration_oauth_consume_invite(text,text)'), to_regprocedure('public.integration_invite_refusal_log(text,text,text,uuid)')))
  AND to_regprocedure('public.integration_invite_refusal_log(text,text,text,uuid)') IS NOT NULL AND to_regprocedure('public.integration_invite_code_issue(text,text)') IS NOT NULL AND to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') IS NOT NULL
UNION ALL SELECT 'create, open list and revoke: signed-in admins only (authenticated, not anon, not PUBLIC); create has the three-argument form',
  (SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.integration_invite_create(text,text,text)'), to_regprocedure('public.integration_invites_open(text)'), to_regprocedure('public.integration_invite_revoke(uuid)')))
  AND to_regprocedure('public.integration_invite_create(text,text,text)') IS NOT NULL
UNION ALL SELECT 'invite table: row security on, no grant to PUBLIC, anon or authenticated, no policy',
  coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.integration_connect_invites')), false)
  AND NOT has_table_privilege('anon', 'public.integration_connect_invites', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.integration_connect_invites', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = to_regclass('public.integration_connect_invites') AND a.grantee = 0)
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'integration_connect_invites')
UNION ALL SELECT 'a stored code is only a 64-hex hash, expiring, and never kept on a used or cancelled invite',
  NOT EXISTS (SELECT 1 FROM public.integration_connect_invites i WHERE i.code_hash IS NOT NULL AND (i.code_hash !~ '^[0-9a-f]{64}$' OR i.code_expires_at IS NULL OR i.used_at IS NOT NULL OR i.revoked_at IS NOT NULL))
UNION ALL SELECT 'the audit log holds no reference, code hash or token of any invite',
  NOT EXISTS (SELECT 1 FROM security_audit.audit_log a JOIN public.integration_connect_invites i ON i.ref IS NOT NULL AND a.metadata::TEXT LIKE '%' || i.ref || '%'
              WHERE a.entity_table = 'integration_connect_invites')
  AND NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.entity_table = 'integration_connect_invites' AND (a.metadata::TEXT ~* '(code_hash|token_hash|"ref"|"code")'))
UNION ALL SELECT 'refusal log: row security on, no grant to PUBLIC, anon, authenticated or service_role, no policy and its writer callable by no API role',
  coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('security_audit.integration_invite_refusals')), false)
  AND NOT has_table_privilege('anon', 'security_audit.integration_invite_refusals', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'security_audit.integration_invite_refusals', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('service_role', 'security_audit.integration_invite_refusals', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = to_regclass('security_audit.integration_invite_refusals') AND a.grantee = 0)
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'security_audit' AND p.tablename = 'integration_invite_refusals')
  AND to_regprocedure('security_audit.integration_invite_refuse(text,text,text,uuid,uuid)') IS NOT NULL
  AND NOT has_function_privilege('anon', 'security_audit.integration_invite_refuse(text,text,text,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'security_audit.integration_invite_refuse(text,text,text,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'security_audit.integration_invite_refuse(text,text,text,uuid,uuid)', 'EXECUTE')
UNION ALL SELECT 'refusal log holds only a correlation id, a fixed step and reason, a 16-hex reference hash and a company that exists: nothing else is stored',
  (SELECT count(*) = 7 FROM information_schema.columns WHERE table_schema = 'security_audit' AND table_name = 'integration_invite_refusals')
  AND NOT EXISTS (SELECT 1 FROM security_audit.integration_invite_refusals r WHERE r.ref_hash !~ '^[0-9a-f]{16}$')
UNION ALL SELECT 'the company audit no longer carries refusals: no INTEGRATION_INVITE_REFUSED row is written by 151',
  to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.integration_invite_code_verify(text,text,text,text)'), to_regprocedure('public.integration_invite_code_issue(text,text)'),
                                                          to_regprocedure('public.integration_oauth_consume_invite(text,text)')) AND p.prosrc LIKE '%INTEGRATION_INVITE_REFUSED%');
