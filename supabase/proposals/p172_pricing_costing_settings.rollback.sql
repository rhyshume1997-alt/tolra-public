-- Rollback of p172 (supabase/proposals/p172_pricing_costing_settings.sql). Drops ONLY what p172 added: the functions save_pricing_costs,
-- set_pricing_profit_viewer, pricing_costs_overview, pricing_costs_admin_caller and the table public.company_pricing_costs (its policy and
-- constraints go with it). REFUSES, changing nothing, while any company holds an entered figure (crew, hours, weeks, hourly cost, target or a
-- running cost): those figures exist nowhere else and this file never deletes them (export them first, or have the owner decide). A row that holds
-- only a designation and no figure is dropped with the table (it is re-created by designating again; the audit log keeps the history). Safe to
-- run when p172 is absent (nothing to do) and safe to run twice. After it, the app treats the table as missing ("not available yet").
-- Inputs: the database. Outputs: five objects removed. Must not change: anything else. Production only with a separate yes.
BEGIN;
DO $rollback_guard$
BEGIN
  IF to_regclass('public.company_pricing_costs') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.company_pricing_costs c
                WHERE c.men IS NOT NULL OR c.hours_per_week IS NOT NULL OR c.weeks_per_year IS NOT NULL OR c.hourly_cost IS NOT NULL
                   OR c.yearly_target IS NOT NULL OR c.profit_target_pct IS NOT NULL OR jsonb_array_length(c.running_costs) > 0) THEN
      RAISE EXCEPTION 'p172 rollback: costing figures exist; they exist nowhere else and this file never deletes them, so nothing was changed';
    END IF;
  END IF;
END
$rollback_guard$;
DROP FUNCTION IF EXISTS public.save_pricing_costs(JSONB, INTEGER);
DROP FUNCTION IF EXISTS public.set_pricing_profit_viewer(UUID);
DROP FUNCTION IF EXISTS public.pricing_costs_overview();
DROP TABLE IF EXISTS public.company_pricing_costs;
DROP FUNCTION IF EXISTS public.pricing_costs_admin_caller();
COMMIT;
