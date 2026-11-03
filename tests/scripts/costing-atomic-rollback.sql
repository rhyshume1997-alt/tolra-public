-- Operator-only rollback of the proposal, not migration 143. Leaves all rates and tables intact.
BEGIN;
DO $$ BEGIN
  IF current_setting('tolra.costing_throwaway', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Explicit throwaway acknowledgement required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug NOT LIKE 't-%') THEN
    RAISE EXCEPTION 'Non-synthetic company present: refuse this database';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.save_costing_settings_atomic(uuid,jsonb,jsonb);
DO $$ BEGIN
  IF to_regprocedure('public.save_costing_settings_atomic(uuid,jsonb,jsonb)') IS NOT NULL
     OR to_regclass('public.costing_materials') IS NULL
     OR to_regclass('public.costing_machines') IS NULL
     OR to_regclass('public.costing_defaults') IS NULL THEN
    RAISE EXCEPTION 'Rollback must remove only the proposal function';
  END IF;
END $$;
COMMIT;
