-- Rollback of release step 153 (document customer link v2). One transaction. Removes the link table, the verified view, the portal switch,
-- the (necessarily empty) offboarding snapshot table and 153's functions; no job, quote, customer or issued-document guard is touched (153
-- changed none). Audit rows are never deleted: security_audit.audit_log is append-only.
-- REFUSES (nothing changed; the transaction is rolled back) whenever removal would lose a person's recorded decision or break something:
--   * 153 is not installed (a second run);
--   * release 154 (AI own-key providers, which requires 153) is installed: 154 must be rolled back BEFORE 153 (PM ruling (e), 12 Nov
--     2026). Its objects, as 154's own one-time guard names them: column public.ai_helper_secrets.provider, function
--     public.ai_helper_set_provider_key(text,text,text), constraints ai_helper_tolra_control_deactivated_154 and
--     ai_helper_tolra_companies_deactivated_154. Any one of them present refuses;
--   * any link was made by a person (manual or name_override), any link was verified, or any link was unlinked;
--   * any company has a portal switch row (ON or OFF: each one is an admin's decision with a reason);
--   * any links were ever retired or any company offboarded (a DOCUMENT_CUSTOMER_LINKS_RETIRED or CUSTOMER_PORTAL_OFFBOARDED event exists,
--     or any offboarding snapshot row exists): re-applying 153 would backfill those documents again, and dropping the snapshot table
--     would lose the only copy of the removed rows;
--   * anything outside 153 depends on its tables, view or functions (a later release such as the portal: roll that back first).
-- Otherwise (only unverified, live backfill rows exist, which nothing has ever shown): it first writes one DOCUMENT_CUSTOMER_LINK_ROLLBACK
-- event per company with the count and the ids it removes, then removes those rows one by one through the guard (each removal is its
-- own row-audit DELETE), so the audit trail explains every row 153 inserted. Then it drops 153's objects WITHOUT CASCADE.
-- IF IT REFUSES: do NOT delete link rows by hand (the guard refuses it anyway). Keep 153 installed (preferred: it is additive and nothing
-- outside Tolra reads it while the portal is off). Only with Rhys's approval.
BEGIN;
-- Nothing can link, verify, unlink, retire or switch between the checks below and the drop (a row committed after the checks would
-- otherwise be lost without the refusal seeing it).
LOCK TABLE public.document_customer_links, public.customer_portal_switch, public.document_customer_offboarding_snapshots IN ACCESS EXCLUSIVE MODE;
DO $rollback_guard$
DECLARE
  o RECORD;
BEGIN
  IF to_regclass('public.document_customer_links') IS NULL THEN
    RAISE EXCEPTION '153 rollback: release 153 is not installed';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_helper_secrets' AND column_name = 'provider')
     OR to_regprocedure('public.ai_helper_set_provider_key(text,text,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('ai_helper_tolra_control_deactivated_154', 'ai_helper_tolra_companies_deactivated_154')) THEN
    RAISE EXCEPTION '153 rollback: release 154 (AI own-key providers) is installed and requires 153. Nothing was changed. Roll back 154 first.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.document_customer_links WHERE source <> 'backfill' OR verified_at IS NOT NULL OR unlinked_at IS NOT NULL) THEN
    RAISE EXCEPTION '153 rollback: a person has linked, verified or unlinked documents; removing the table would lose those recorded decisions. Nothing was changed. Keep 153.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_portal_switch) THEN
    RAISE EXCEPTION '153 rollback: a company has used the customer portal switch (an admin decision with a reason). Nothing was changed. Keep 153.';
  END IF;
  IF EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.action = 'DOCUMENT_CUSTOMER_LINKS_RETIRED') THEN
    RAISE EXCEPTION '153 rollback: an admin has retired document links; re-applying 153 would link those documents again. Nothing was changed. Keep 153.';
  END IF;
  IF EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.action = 'CUSTOMER_PORTAL_OFFBOARDED')
     OR EXISTS (SELECT 1 FROM public.document_customer_offboarding_snapshots) THEN
    RAISE EXCEPTION '153 rollback: the platform owner has offboarded a company''s document links; re-applying 153 would link its documents again. Nothing was changed. Keep 153.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_depend d
             WHERE d.refobjid IN (to_regclass('public.document_customer_links'), to_regclass('public.document_customer_links_verified'),
                                  to_regclass('public.customer_portal_switch'), to_regclass('public.document_customer_offboarding_snapshots'))
               AND d.deptype = 'n' AND d.classid = 'pg_rewrite'::regclass
               AND d.objid NOT IN (SELECT r.oid FROM pg_rewrite r WHERE r.ev_class = to_regclass('public.document_customer_links_verified')))
     OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid IN (to_regclass('public.document_customer_links'), to_regclass('public.customer_portal_switch'),
                                                                                       to_regclass('public.document_customer_offboarding_snapshots')))
     OR EXISTS (SELECT 1 FROM pg_proc p
                WHERE (p.prosrc LIKE '%document_customer_links%' OR p.prosrc LIKE '%customer_portal_switch%' OR p.prosrc LIKE '%document_customer_offboarding_snapshots%')
                  AND NOT (p.pronamespace = 'public'::regnamespace AND p.proname IN ('document_customer_links_guard', 'document_customer_links_no_truncate',
                       '_document_customer_link_actor', '_document_customer_link_reason', '_document_customer_link_backfill', 'link_document_customer',
                       'link_document_customer_name_override', 'verify_document_customer_links', 'unlink_document_customer',
                       'retire_document_customer_links', 'customer_portal_status', 'customer_portal_set_enabled',
                       'customer_portal_switch_guard', 'customer_portal_switch_no_truncate', 'platform_offboard_document_customer_links',
                       'document_customer_offboarding_snapshots_guard'))) THEN
    RAISE EXCEPTION '153 rollback: something outside 153 depends on its tables, view or functions (a later release). Nothing was changed. Roll that back first, or keep 153.';
  END IF;
  FOR o IN SELECT l.organization_id, count(*) AS n, jsonb_agg(l.id ORDER BY l.id) AS ids FROM public.document_customer_links l GROUP BY l.organization_id ORDER BY l.organization_id LOOP
    PERFORM security_audit.log_named_event(o.organization_id, 'DOCUMENT_CUSTOMER_LINK_ROLLBACK', 'document_customer_links', o.organization_id::TEXT,
      jsonb_build_object('removed_unverified_backfill_links', o.n, 'link_ids', o.ids, 'reason', 'release 153 rolled back', 'actor', 'release 153 rollback'));
  END LOOP;
  PERFORM set_config('tolra.document_customer_link_removal', 'rollback', TRUE);
  DELETE FROM public.document_customer_links;
  PERFORM set_config('tolra.document_customer_link_removal', '', TRUE);
END
$rollback_guard$;
DROP FUNCTION public.platform_offboard_document_customer_links(UUID, TEXT);
DROP FUNCTION public.customer_portal_set_enabled(BOOLEAN, TEXT);
DROP FUNCTION public.customer_portal_status();
DROP FUNCTION public.retire_document_customer_links(TEXT, UUID, TEXT);
DROP FUNCTION public.unlink_document_customer(TEXT, UUID, TEXT);
DROP FUNCTION public.verify_document_customer_links(UUID[], TEXT);
DROP FUNCTION public.link_document_customer_name_override(TEXT, UUID, UUID, TEXT, BOOLEAN);
DROP FUNCTION public.link_document_customer(TEXT, UUID, UUID, TEXT);
DROP FUNCTION public._document_customer_link_backfill(UUID);
DROP FUNCTION public._document_customer_link_reason(TEXT);
DROP FUNCTION public._document_customer_link_actor(TEXT[], BOOLEAN);
DROP VIEW public.document_customer_links_verified;
DROP TABLE public.document_customer_links;
DROP TABLE public.customer_portal_switch;
DROP TABLE public.document_customer_offboarding_snapshots;
DROP FUNCTION public.document_customer_offboarding_snapshots_guard();
DROP FUNCTION public.customer_portal_switch_no_truncate();
DROP FUNCTION public.customer_portal_switch_guard();
DROP FUNCTION public.document_customer_links_no_truncate();
DROP FUNCTION public.document_customer_links_guard();
COMMIT;
