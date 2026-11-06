-- Post-144 rollback of release 148 (optional actual job costing). Rhys's approval first. Destructive only to this feature's own data:
-- the switch, machine links, per-job declarations and the JOB COST RECORDS (job_cost_snapshots) are dropped. Export job_cost_snapshots first
-- if the recorded costs are needed: after a rollback and re-release, jobs closed in between have no record (they are never re-costed at
-- today's rates). 143's rates (costing_defaults, costing_machines, costing_materials, save_costing_settings_atomic), jobs, invoices, timers,
-- purchase orders and the legacy bought-in profit are untouched. Deploy a UI without the panel first, or leave it reading "unavailable".
BEGIN;
DROP TRIGGER zz_job_cost_snapshot ON public.jobs;
DROP TRIGGER zz_job_cost_snapshot ON public.invoices;
DROP FUNCTION public.job_profitability_actual_inputs(uuid);
DROP FUNCTION public.refresh_job_cost_snapshot(uuid);
DROP FUNCTION public.save_job_cost_declarations(uuid, boolean, boolean);
DROP FUNCTION public.save_job_costing_machine_links(uuid, jsonb);
DROP FUNCTION public.set_job_costing_enabled(uuid, integer, boolean);
DROP FUNCTION public.job_cost_snapshot_on_close();
DROP FUNCTION public.job_cost_take_snapshot(uuid, uuid, text);
DROP FUNCTION public.job_cost_figures(uuid, uuid, jsonb);
DROP FUNCTION public.job_cost_rates(uuid);
DROP FUNCTION public.job_costing_access(boolean);
DROP TABLE public.job_cost_snapshots, public.job_cost_declarations, public.job_costing_machine_links, public.job_costing_settings;
DROP FUNCTION public.job_cost_snapshot_frozen();
DROP FUNCTION public.job_cost_us(tstzmultirange);
DROP FUNCTION public.job_cost_round(numeric, numeric);
NOTIFY pgrst, 'reload schema';
COMMIT;
