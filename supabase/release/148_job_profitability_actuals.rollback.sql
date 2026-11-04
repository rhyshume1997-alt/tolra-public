-- Approval required before any real use. Export the four NEW costing tables first if their data is needed.
-- Destructive only to this optional feature's settings, estimates and rate history; legacy profit and timers stay intact.
-- First deploy a UI without the new panel, or leave it showing unavailable. Never restore a backup over live activity for this rollback.
BEGIN;
DROP FUNCTION public.job_profitability_actual_inputs(uuid);
DROP FUNCTION public.save_job_cost_estimate(uuid,integer,numeric,numeric,boolean,boolean);
DROP FUNCTION public.save_job_costing_rates(uuid,integer,boolean,integer,text,integer,jsonb);
DROP FUNCTION public.job_costing_access(boolean);
DROP TABLE public.job_costing_rate_history, public.job_cost_estimates, public.job_machine_cost_rates, public.job_costing_settings;
NOTIFY pgrst, 'reload schema';
COMMIT;
