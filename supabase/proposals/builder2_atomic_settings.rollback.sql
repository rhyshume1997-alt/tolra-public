-- PROPOSAL ONLY. Reverts these new RPCs, never the underlying settings or base migrations.
-- Clients must first stop using these RPCs. No fallback to partial saves.
BEGIN;
DROP FUNCTION IF EXISTS public.save_chase_steps_atomic(uuid,jsonb,jsonb);
DROP FUNCTION IF EXISTS public.save_chase_steps_atomic(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.save_costing_settings_txn(uuid,jsonb,jsonb);
COMMIT;
