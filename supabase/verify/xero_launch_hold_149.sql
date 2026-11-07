-- Read only: after a separately approved release 149, every row must say true. No row depends on how many companies are switched on later.
-- What it proves, in words: a company's Xero transfer switch is a persisted row, off by default and not set by install or by connecting; only the
-- admin function can turn it on; the database function that claims a send (and the retry) refuse while it is off, before any row is touched;
-- nothing refuses a result write (a send already claimed finishes); a connection change puts it back off; no API role can read or write the table.
-- A queued document is HELD (never claimed, never re-queued by a retry) unless it was queued in the current ON period, or the company's own admin
-- approved it, with a fresh authenticator code, on the current connection: switching ON, reconnecting or retrying never releases the backlog.
SELECT 'hold table: row security on, no grant to PUBLIC, anon, authenticated or service_role' AS check_name,
  coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.xero_transfer_hold')), false)
  AND NOT has_table_privilege('anon', 'public.xero_transfer_hold', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.xero_transfer_hold', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('service_role', 'public.xero_transfer_hold', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = to_regclass('public.xero_transfer_hold') AND a.grantee = 0) AS ok
UNION ALL SELECT 'off by default: the enabled column is NOT NULL with default false',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'xero_transfer_hold' AND column_name = 'enabled' AND column_default = 'false' AND is_nullable = 'NO')
UNION ALL SELECT 'install and connecting never switch a company on: every row that is on was turned on by the admin function (an actor, reason admin)',
  NOT EXISTS (SELECT 1 FROM public.xero_transfer_hold h WHERE h.enabled AND (h.changed_by IS NULL OR h.reason IS DISTINCT FROM 'admin'))
UNION ALL SELECT 'the gate is a security definer with a pinned search path, for the service role only',
  coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_transfer_enabled(uuid)')), false)
  AND has_function_privilege('service_role', 'public.integration_xero_transfer_enabled(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.integration_xero_transfer_enabled(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.integration_xero_transfer_enabled(uuid)', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = to_regprocedure('public.integration_xero_transfer_enabled(uuid)') AND a.grantee = 0)
UNION ALL SELECT 'the gate says on only for a row that is on AND a connected connection (company by company)',
  coalesce((SELECT prosrc LIKE '%h.organization_id = p_org AND h.enabled%' AND prosrc LIKE '%c.organization_id = p_org%' AND prosrc LIKE '%c.status = ''connected''%'
            FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_transfer_enabled(uuid)')), false)
UNION ALL SELECT 'the sweep list is for the service role only and holds on-and-connected companies only',
  coalesce((SELECT prosecdef AND prosrc LIKE '%WHERE h.enabled%' AND prosrc LIKE '%c.status = ''connected''%' FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_enabled_orgs()')), false)
  AND has_function_privilege('service_role', 'public.integration_xero_enabled_orgs()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.integration_xero_enabled_orgs()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.integration_xero_enabled_orgs()', 'EXECUTE')
UNION ALL SELECT 'the switch function: signed-in admin of the company, never a support session, second step, connected and mapped before ON, audited',
  coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit'] AND prosrc LIKE '%assert_privileged_aal()%' AND prosrc LIKE '%has_org_role(ARRAY[''admin''])%'
                   AND prosrc LIKE '%is_support%' AND prosrc LIKE '%integration_unmapped(v_org, ''xero'')%' AND prosrc LIKE '%mfa_recent_required%' AND prosrc LIKE '%XERO_TRANSFERS_CHANGED%'
                   AND position('not_connected' IN prosrc) < position('INSERT INTO public.xero_transfer_hold' IN prosrc)
            FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_set_transfers(boolean)')), false)
  AND has_function_privilege('authenticated', 'public.integration_xero_set_transfers(boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.integration_xero_set_transfers(boolean)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.integration_xero_set_transfers(boolean)', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = to_regprocedure('public.integration_xero_set_transfers(boolean)') AND a.grantee = 0)
UNION ALL SELECT 'the status function answers an admin of the company only, never anon',
  coalesce((SELECT prosecdef AND prosrc LIKE '%has_org_role(ARRAY[''admin''])%' FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_launch_status()')), false)
  AND has_function_privilege('authenticated', 'public.integration_xero_launch_status()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.integration_xero_launch_status()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.integration_xero_launch_status()', 'EXECUTE')
UNION ALL SELECT 'the claim refuses a held company BEFORE it changes any row (after the connection status answer)',
  coalesce((SELECT position('integration_xero_transfer_enabled(p_org)' IN prosrc) > 0 AND prosrc LIKE '%''launch_hold''%'
                   AND position('integration_xero_transfer_enabled(p_org)' IN prosrc) > position('v_status IS DISTINCT FROM ''connected''' IN prosrc)
                   AND position('integration_xero_transfer_enabled(p_org)' IN prosrc) < position('UPDATE public.integration_sends' IN prosrc)
            FROM pg_proc WHERE oid = to_regprocedure('public.integration_claim_next(uuid,text,integer,text,uuid)')), false)
UNION ALL SELECT 'the retry refuses a held company after finding the company''s own row (a foreign id stays not found)',
  coalesce((SELECT prosrc LIKE '%xero_launch_hold%' AND position('xero_launch_hold' IN prosrc) > position('Send not found' IN prosrc)
                   AND position('xero_launch_hold' IN prosrc) < position('not_retryable' IN prosrc)
            FROM pg_proc WHERE oid = to_regprocedure('public.integration_retry_send(uuid)')), false)
UNION ALL SELECT 'nothing refuses a result write: the only 149 trigger on the send queue is AFTER INSERT (it records how a row was queued), and recording a result does not consult the switch',
  NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.integration_sends'::regclass AND NOT tgisinternal AND tgname ILIKE '%xero%' AND tgname <> 'xero_send_queued')
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.integration_sends'::regclass AND tgname = 'xero_send_queued' AND tgenabled = 'O'
                AND tgfoid = to_regprocedure('public.integration_xero_send_queued()') AND (tgtype & 2) = 0 AND (tgtype & 1) = 1 AND (tgtype & 4) = 4 AND (tgtype & 16) = 0)
  AND coalesce((SELECT prosrc NOT LIKE '%RAISE%' AND prosrc NOT LIKE '%UPDATE%' FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_send_queued()')), false)
  AND coalesce((SELECT prosrc NOT LIKE '%transfer_enabled%' AND prosrc NOT LIKE '%launch_hold%' FROM pg_proc WHERE oid = to_regprocedure('public.integration_record_result(uuid,uuid,text,text,text,text,timestamptz)')), false)
UNION ALL SELECT 'a connection change puts the company back off: row trigger on insert, update and delete, no API role may call its function',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.integration_connections'::regclass AND tgname = 'xero_connection_reset' AND tgenabled = 'O'
            AND tgfoid = to_regprocedure('public.integration_xero_connection_reset()') AND (tgtype & 1) = 1 AND (tgtype & 4) = 4 AND (tgtype & 8) = 8 AND (tgtype & 16) = 16)
  AND NOT has_function_privilege('anon', 'public.integration_xero_connection_reset()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.integration_xero_connection_reset()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.integration_xero_connection_reset()', 'EXECUTE')
UNION ALL SELECT 'the reset covers a reconnect or fresh consent (connected_at), another organisation (tenant), a status change and a deleted row',
  coalesce((SELECT prosrc LIKE '%NEW.connected_at IS NOT DISTINCT FROM OLD.connected_at%' AND prosrc LIKE '%NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id%'
                   AND prosrc LIKE '%NEW.status IS NOT DISTINCT FROM OLD.status%' AND prosrc LIKE '%TG_OP = ''DELETE''%'
            FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_connection_reset()')), false)
UNION ALL SELECT 'review table: row security on, no grant to PUBLIC, anon, authenticated or service_role',
  coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.xero_send_release')), false)
  AND NOT has_table_privilege('anon', 'public.xero_send_release', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('authenticated', 'public.xero_send_release', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('service_role', 'public.xero_send_release', 'SELECT,INSERT,UPDATE,DELETE')
  AND NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = to_regclass('public.xero_send_release') AND a.grantee = 0)
UNION ALL SELECT 'a document is released only if queued in the current ON period, or approved on the current connection; nobody else may call the rule',
  coalesce((SELECT prosecdef AND prosrc LIKE '%r.queued_generation = h.generation AND h.enabled%' AND prosrc LIKE '%r.approved_epoch = h.connection_epoch%' AND prosrc LIKE '%r.organization_id = p_org%'
            FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_send_released(uuid,uuid)')), false)
  AND NOT has_function_privilege('anon', 'public.integration_xero_send_released(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.integration_xero_send_released(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.integration_xero_send_released(uuid,uuid)', 'EXECUTE')
UNION ALL SELECT 'the claim takes released documents only, the retry refuses a held one, switching ON starts a new ON period, a connection change a new connection epoch',
  coalesce((SELECT prosrc LIKE '%integration_xero_send_released(p_org, s.id)%' FROM pg_proc WHERE oid = to_regprocedure('public.integration_claim_next(uuid,text,integer,text,uuid)')), false)
  AND coalesce((SELECT prosrc LIKE '%integration_xero_send_released(v_org, p_send)%' AND prosrc LIKE '%xero_held_for_review%'
                       AND position('xero_held_for_review' IN prosrc) < position('UPDATE public.integration_sends' IN prosrc)
                FROM pg_proc WHERE oid = to_regprocedure('public.integration_retry_send(uuid)')), false)
  AND coalesce((SELECT prosrc LIKE '%generation = h.generation + CASE WHEN p_enabled THEN 1 ELSE 0 END%' FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_set_transfers(boolean)')), false)
  AND coalesce((SELECT prosrc LIKE '%connection_epoch = h.connection_epoch + 1%' FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_connection_reset()')), false)
  AND NOT EXISTS (SELECT 1 FROM public.xero_send_release r WHERE r.approved_epoch IS NOT NULL AND r.approved_by IS NULL)
UNION ALL SELECT 'approval: signed-in admin of the company, never a support session, a fresh authenticator code always, connected, audited; review list for admins only',
  coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit'] AND prosrc LIKE '%assert_privileged_aal()%' AND prosrc LIKE '%has_org_role(ARRAY[''admin''])%'
                   AND prosrc LIKE '%is_support%' AND prosrc LIKE '%mfa_recent_required%' AND prosrc NOT LIKE '%require_admin_mfa%' AND prosrc LIKE '%not_connected%'
                   AND prosrc LIKE '%s.organization_id = v_org%' AND prosrc LIKE '%XERO_HELD_SENDS_APPROVED%'
                   AND position('mfa_recent_required' IN prosrc) < position('INSERT INTO public.xero_send_release' IN prosrc)
            FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_approve_held(uuid[])')), false)
  AND has_function_privilege('authenticated', 'public.integration_xero_approve_held(uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.integration_xero_approve_held(uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.integration_xero_approve_held(uuid[])', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = to_regprocedure('public.integration_xero_approve_held(uuid[])') AND a.grantee = 0)
  AND coalesce((SELECT prosecdef AND prosrc LIKE '%has_org_role(ARRAY[''admin''])%' FROM pg_proc WHERE oid = to_regprocedure('public.integration_xero_held_sends()')), false)
  AND has_function_privilege('authenticated', 'public.integration_xero_held_sends()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.integration_xero_held_sends()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.integration_xero_held_sends()', 'EXECUTE');
-- Also run tests/db/xero-launch-hold-149.test.ts against a disposable database, never a live tenant.
