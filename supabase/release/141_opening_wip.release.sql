-- 141_opening_wip.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- CA packaging prerequisite; original held-owner SQL body below is unchanged.
DO $ca_prerequisite$
DECLARE checked record; checked_count integer:=0;
BEGIN
 FOR checked IN
-- Migration 140 (the SliQ number an imported invoice, quote, purchase order, job or sales order had in SliQ).
-- Read only: every row should be TRUE (6).
SELECT 'five_columns_text_nullable' AS check_name,
  (SELECT string_agg(table_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY table_name) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('invoices', 'quotes', 'purchase_orders', 'jobs', 'sales_orders') AND column_name = 'source_ref')
    = 'invoices:text:YES,jobs:text:YES,purchase_orders:text:YES,quotes:text:YES,sales_orders:text:YES' AS ok
UNION ALL SELECT 'five_checks_validated',
  (SELECT count(*) FROM pg_constraint WHERE conname IN ('invoices_source_ref_check', 'quotes_source_ref_check', 'purchase_orders_source_ref_check',
     'jobs_source_ref_check', 'sales_orders_source_ref_check') AND convalidated AND contype = 'c') = 5
UNION ALL SELECT 'five_triggers_enabled',
  (SELECT count(*) FROM pg_trigger t WHERE t.tgname = 'source_ref_import_only' AND NOT t.tgisinternal AND t.tgenabled = 'O'
     AND t.tgfoid = to_regprocedure('public.source_ref_import_only()')
     AND t.tgrelid IN (to_regclass('public.invoices'), to_regclass('public.quotes'), to_regclass('public.purchase_orders'),
                       to_regclass('public.jobs'), to_regclass('public.sales_orders'))) = 5
UNION ALL SELECT 'function_is_140s',
  coalesce((SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '169cd2798340f7ba1d43b8b85e3be923' AND NOT prosecdef
            AND proconfig = ARRAY['search_path=pg_catalog, public']
            FROM pg_proc WHERE oid = to_regprocedure('public.source_ref_import_only()')), FALSE)
UNION ALL SELECT 'function_not_callable_from_the_api',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
            FROM pg_proc WHERE oid = to_regprocedure('public.source_ref_import_only()')), FALSE)
UNION ALL SELECT 'source_ref_well_formed',
  NOT EXISTS (SELECT 1 FROM public.invoices WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.quotes WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.purchase_orders WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.jobs WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.sales_orders WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
 LOOP
  checked_count:=checked_count+1;
  IF checked.ok IS DISTINCT FROM true THEN RAISE EXCEPTION '141: prerequisite verification failed: %',checked.check_name; END IF;
 END LOOP;
 IF checked_count<>6 THEN RAISE EXCEPTION '141: prerequisite verification incomplete'; END IF;
END; $ca_prerequisite$;

-- =====================================================================================================
-- 141: opening work in progress from SliQ, kept on its own (reviewer decision 6, Mon 2 Nov: Part B of the SliQ import).
-- Before: SliQ's WIP at the cutover had nowhere to go. The importer (scripts/sliq-import) writes customers, invoices, quotes, payments, POs and
-- now open jobs, but a WIP figure is neither an invoice nor a job price, and it must never count as invoiced revenue or money owed.
-- After: public.opening_wip keeps one row per WIP line exactly as SliQ states it: the SliQ job number, the Tolra job where the job is imported
-- (or already in Tolra), a description, a quantity, a value and the "as at" date. Every figure is the source's own: a blank value stays NULL
-- (no valuation is ever worked out) and John confirms each value from the importer's wip-verification.csv. Nothing reads this table to work out
-- revenue, invoices, receivables, aging or the Overview: it is a record only.
--   * WRITE: only the importer, through a direct owner connection to a disposable or approved target (scripts/sliq-import/jobs-write.mjs). No
--     signed-in role may insert, change or delete a row (no write grant, no policy for it). source_key is the importer's stable key for the line
--     (unique per company), so a repeat import adds nothing.
--   * READ: admin and office of the company only, as job prices (job_values, 009). A workshop person, a viewer and anon read nothing.
--   * LINKS: job_id -> jobs(id) ON DELETE SET NULL (the SliQ job number stays in source_job_ref); a job of another company is refused
--     (enforce_same_org_parent, as every other business link, 015).
--   * AUDIT: the standard row audit trigger (security_audit.log_row_change), the support-session read-only guard and the admin second-step guard,
--     as every company table (117's job_problems).
-- Needs 000 (organizations, jobs), 013 (security_audit.log_row_change), 015 (enforce_same_org_parent), 033 (require_admin_mfa_guard) and 036
-- (current_user_organization_id, has_org_role, support_readonly_guard). Replaces no existing object and changes no row. Safe to run again.
-- Until this is applied the importer refuses a write that has WIP rows (the table is missing); nothing in the app reads the table.
-- Verify: supabase/verify/opening_wip_141.sql (every row TRUE). Rollback: supabase/release/141_opening_wip.rollback.sql (drops the table and
-- every opening WIP row; only with Rhys's approval). Proof: tests/scripts/opening-wip-141.proof.sql.
-- NUMBERING: 140 and 141 (renumbered from 135 and 136, Mon 2 Nov). Main has 135 (job spec Customer PO); 136 and 137 are on PR #106
-- (G1) and 138 and 139 are held for chasing. In supabase/verify/release_preflight.sql the '141 ...' marker follows '140 ...', which follows
-- the highest marker below it on the branch it lands on (135 on main today; 136 to 139 go between them when they merge).
-- The table holds company and job ids, the SliQ job number, a description, a quantity, a value, a date and the importer's key.
-- =====================================================================================================

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.jobs') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.support_readonly_guard()') IS NULL OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL
     OR to_regprocedure('public.enforce_same_org_parent()') IS NULL OR to_regprocedure('security_audit.log_row_change()') IS NULL THEN
    RAISE EXCEPTION '141 needs 000 (organizations, jobs), 013, 015, 033 and 036 (the helpers and guards it uses)';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 1. The table: one row per opening WIP line, as SliQ states it.
CREATE TABLE IF NOT EXISTS public.opening_wip (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id           UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  source_job_ref   TEXT CHECK (source_job_ref IS NULL OR length(source_job_ref) BETWEEN 1 AND 100),
  description      TEXT CHECK (description IS NULL OR length(description) <= 2000),
  quantity         NUMERIC(14,3),
  value            NUMERIC(14,2),
  as_of            DATE,
  source_reference TEXT CHECK (source_reference IS NULL OR length(source_reference) <= 200),
  source           TEXT NOT NULL DEFAULT 'sliq' CHECK (source = 'sliq'),
  source_key       TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 100),
  imported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT opening_wip_source_key_unique UNIQUE (organization_id, source_key)
);
CREATE INDEX IF NOT EXISTS opening_wip_by_job ON public.opening_wip (organization_id, job_id) WHERE job_id IS NOT NULL;

ALTER TABLE public.opening_wip ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "opening_wip rbac select" ON public.opening_wip;
CREATE POLICY "opening_wip rbac select" ON public.opening_wip FOR SELECT TO authenticated
  USING (organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.opening_wip FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.opening_wip TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.opening_wip;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.opening_wip
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS audit_opening_wip_changes ON public.opening_wip;
CREATE TRIGGER audit_opening_wip_changes AFTER INSERT OR UPDATE OR DELETE ON public.opening_wip
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.opening_wip;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.opening_wip
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.opening_wip;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.opening_wip
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- 2. Self-check: the table, its one read policy, no write grant to any API role.
DO $$
BEGIN
  IF to_regclass('public.opening_wip') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.opening_wip'::regclass)
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'opening_wip') <> 1
     OR has_table_privilege('authenticated', 'public.opening_wip', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.opening_wip', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '141 self-check failed: public.opening_wip is not as written';
  END IF;
END
$$;

COMMIT;
