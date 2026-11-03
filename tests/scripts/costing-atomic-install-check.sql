-- Operator-only preflight, in the same transaction as installing the proposal.
DO $$ BEGIN
  IF current_setting('tolra.costing_throwaway', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Explicit throwaway acknowledgement required';
  END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL
     OR to_regclass('public.costing_materials') IS NULL
     OR to_regclass('public.costing_machines') IS NULL
     OR to_regclass('public.costing_defaults') IS NULL THEN
    RAISE EXCEPTION 'Local test schema including migration 143 required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug NOT LIKE 't-%') THEN
    RAISE EXCEPTION 'Non-synthetic company present: refuse this database';
  END IF;
  IF to_regprocedure('public.save_costing_settings_atomic(uuid,jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'Function already exists: do not overwrite an unknown installation';
  END IF;
END $$;
