-- 143 rollback: ONLY with Rhys's approval. Removes the costing rates: the three tables (costing_materials, costing_machines,
-- costing_defaults) with their policies, grants, indexes and triggers, and public.costing_rates_stamp().
-- EVERY COMPANY'S COSTING RATES ARE DELETED (materials, machines and defaults). Export them first if they are wanted again. Quote lines
-- already added from the calculation are ordinary quote lines and stay. The row audit events (security_audit.audit_log) stay; nothing can
-- edit that log. The Quote Builder's costing calculation then reads as off. Run the whole text as one transaction, then the release
-- preflight (marker 143 shows "not applied") and supabase/verify/costing_rates_143.sql is no longer run.
BEGIN;

DROP TABLE IF EXISTS public.costing_materials;
DROP TABLE IF EXISTS public.costing_machines;
DROP TABLE IF EXISTS public.costing_defaults;
DROP FUNCTION IF EXISTS public.costing_rates_stamp();

COMMIT;
