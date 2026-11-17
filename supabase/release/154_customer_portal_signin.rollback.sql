-- Rollback of release step 154 (customer portal sign-in). One transaction. Removes the three portal tables, the refusal log and 154's
-- functions; nothing of 153 or any other release is touched (154 changed nothing existing). Audit rows are never deleted:
-- security_audit.audit_log is append-only. Must run BEFORE 153's rollback (153's rollback refuses while 154 is installed).
-- REFUSES (nothing changed; the transaction is rolled back):
--   * 154 is not installed (a second run);
--   * any portal contact exists, live or revoked (each is a person with access, or the record of one, and personal data; PM Q16
--     default): codes and sessions can only exist with a contact, so none exists either;
--   * anything outside 154 depends on its tables or functions (a later release: roll that back first).
-- Otherwise it drops 154's objects WITHOUT CASCADE. The refusal log is dropped with it (as 151's rollback drops its refusal log).
-- IF IT REFUSES: do NOT delete contacts by hand (the guard refuses it anyway). Revoke contacts through the app and keep 154 installed
-- (it is additive and refuses every customer call while the portal is OFF). Only with Rhys's approval.
BEGIN;
DO $rollback_guard$
BEGIN
  IF to_regclass('public.customer_portal_contacts') IS NULL THEN
    RAISE EXCEPTION '154 rollback: release 154 is not installed';
  END IF;
  -- Nothing can invite, sign in or open a session between the checks below and the drop.
  LOCK TABLE public.customer_portal_contacts, public.customer_portal_signin_codes, public.customer_portal_sessions,
             security_audit.customer_portal_refusals IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.customer_portal_contacts) THEN
    RAISE EXCEPTION '154 rollback: portal contacts exist (people given access, and their records). Nothing was changed. Keep 154.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_depend d
             WHERE d.refobjid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'),
                                  to_regclass('public.customer_portal_sessions'), to_regclass('security_audit.customer_portal_refusals'))
               AND d.deptype = 'n' AND d.classid = 'pg_rewrite'::regclass)
     OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f'
                  AND c.confrelid IN (to_regclass('public.customer_portal_contacts'), to_regclass('public.customer_portal_signin_codes'),
                                      to_regclass('public.customer_portal_sessions'))
                  AND c.conrelid NOT IN (to_regclass('public.customer_portal_signin_codes'), to_regclass('public.customer_portal_sessions')))
     OR EXISTS (SELECT 1 FROM pg_proc p
                WHERE (p.prosrc LIKE '%customer_portal_contacts%' OR p.prosrc LIKE '%customer_portal_signin_codes%'
                       OR p.prosrc LIKE '%customer_portal_sessions%' OR p.prosrc LIKE '%customer_portal_refusals%'
                       OR p.prosrc LIKE '%_portal_session_gate%' OR p.prosrc LIKE '%portal_refuse%')
                  AND NOT ((p.pronamespace = 'public'::regnamespace AND p.proname IN ('portal_signin_request', 'portal_signin_verify', 'portal_session_resolve',
                              'portal_session_end', 'portal_quotes', 'portal_jobs', 'portal_contact_invite', 'portal_contacts_list', 'portal_contact_revoke',
                              '_portal_session_gate', 'portal_contacts_guard', 'portal_signin_codes_guard', 'portal_sessions_guard', 'portal_no_truncate'))
                           OR (p.pronamespace = 'security_audit'::regnamespace AND p.proname = 'portal_refuse'))) THEN
    RAISE EXCEPTION '154 rollback: something outside 154 depends on its tables or functions (a later release). Nothing was changed. Roll that back first, or keep 154.';
  END IF;
END
$rollback_guard$;
DROP FUNCTION public.portal_contact_revoke(UUID, TEXT);
DROP FUNCTION public.portal_contacts_list(UUID);
DROP FUNCTION public.portal_contact_invite(UUID, TEXT, TEXT, TEXT[], TEXT);
DROP FUNCTION public.portal_jobs(TEXT);
DROP FUNCTION public.portal_quotes(TEXT);
DROP FUNCTION public.portal_session_end(TEXT);
DROP FUNCTION public.portal_session_resolve(TEXT);
DROP FUNCTION public.portal_signin_verify(TEXT, TEXT, TEXT);
DROP FUNCTION public.portal_signin_request(TEXT, TEXT[], TEXT[]);
DROP FUNCTION public._portal_session_gate(TEXT, TEXT);
DROP TABLE public.customer_portal_sessions;
DROP TABLE public.customer_portal_signin_codes;
DROP TABLE public.customer_portal_contacts;
DROP TABLE security_audit.customer_portal_refusals;
DROP FUNCTION security_audit.portal_refuse(TEXT, TEXT, TEXT, UUID);
DROP FUNCTION public.portal_no_truncate();
DROP FUNCTION public.portal_sessions_guard();
DROP FUNCTION public.portal_signin_codes_guard();
DROP FUNCTION public.portal_contacts_guard();
COMMIT;
