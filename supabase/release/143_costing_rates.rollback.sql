-- 143 rollback: ONLY with Rhys's approval. Removes the costing rates: the three tables (costing_materials, costing_machines,
-- costing_defaults) with their policies, grants, indexes and triggers, and public.save_costing_settings_atomic(uuid,jsonb,jsonb) and
-- public.costing_rates_stamp().
-- EVERY COMPANY'S COSTING RATES ARE DELETED (materials, machines and defaults). Export them first if they are wanted again. Quotes, quote lines
-- and jobs are not touched: nothing references the rate tables, and a price already put on a quote line is stored on the line itself. The row
-- audit events (security_audit.audit_log) stay; nothing can edit that log. The Quote Builder's costing calculation then reads as off (not
-- configured). Run the whole text as one transaction, then the release preflight (marker 143 shows "not applied") and
-- supabase/verify/costing_rates_143.sql is no longer run.
-- It REFUSES while any material, machine or defaults row exists, unless the runner first says, in the same session, that deleting them is accepted (export them first):
--     SET tolra.x143_accept_deleting_rates = 'yes';
BEGIN;
DO $rb$ BEGIN
 IF to_regclass('public.costing_materials') IS NOT NULL AND to_regclass('public.costing_machines') IS NOT NULL AND to_regclass('public.costing_defaults') IS NOT NULL THEN
  IF (EXISTS (SELECT 1 FROM public.costing_materials) OR EXISTS (SELECT 1 FROM public.costing_machines) OR EXISTS (SELECT 1 FROM public.costing_defaults))
     AND coalesce(current_setting('tolra.x143_accept_deleting_rates', TRUE), '') <> 'yes' THEN
   RAISE EXCEPTION '143 rollback refused: costing rates exist; rolling back deletes every company''s materials, machines and defaults. Export them first, then SET tolra.x143_accept_deleting_rates = ''yes'' if that is accepted.';
  END IF;
 END IF;
END $rb$;

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
