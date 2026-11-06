-- 143 rollback: ONLY with Rhys's approval. Removes the costing rates: the three tables (costing_materials, costing_machines,
-- costing_defaults) with their policies, grants, indexes and triggers, and public.save_costing_settings_atomic(uuid,jsonb,jsonb) and
-- public.costing_rates_stamp().
-- EVERY COMPANY'S COSTING RATES ARE DELETED (materials, machines and defaults). Export them first if they are wanted again. Quotes, quote lines
-- and jobs are not touched: nothing references the rate tables, and a price already put on a quote line is stored on the line itself. The row
-- audit events (security_audit.audit_log) stay; nothing can edit that log. The Quote Builder's costing calculation then reads as off (not
-- configured). Run the whole text as one transaction, then the release preflight (marker 143 shows "not applied") and
-- supabase/verify/costing_rates_143.sql is no longer run.
BEGIN;

DROP FUNCTION IF EXISTS public."save_costing_settings_atomic"(uuid, jsonb, jsonb);
DROP TABLE IF EXISTS public.costing_materials;
DROP TABLE IF EXISTS public.costing_machines;
DROP TABLE IF EXISTS public.costing_defaults;
DROP FUNCTION IF EXISTS public.costing_rates_stamp();

DO $$
BEGIN
  IF to_regclass('public.costing_materials') IS NOT NULL OR to_regclass('public.costing_machines') IS NOT NULL OR to_regclass('public.costing_defaults') IS NOT NULL
     OR to_regprocedure('public.costing_rates_stamp()') IS NOT NULL OR to_regprocedure('public.save_costing_settings_atomic(uuid,jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION '143 rollback: something of 143 is still there';
  END IF;
END
$$;

COMMIT;
