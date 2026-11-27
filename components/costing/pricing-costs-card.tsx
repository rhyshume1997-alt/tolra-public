"use client";
/**
 * The Settings card for Costing (Pricing and profit, stage A1): the admin-only switch (OFF by default; marker pricing-costs:on in the company's
 * hidden_nav, lib/costing/costing-switch.ts, saved through saveOrgSettings like the ISO card) and, only while the switch is confirmed on, the
 * Costing panel wired to the signed-in person's own Supabase session.
 * Inputs: the cached company settings, the signed-in user and role. Outputs: a hidden_nav save with a toast; the panel. Renders nothing for any
 * role but admin. Must not change: switched off means NO costing query at all (the panel is not even mounted), no other hidden_nav entry is
 * touched, and nothing is filled in for the company.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { PricingCostsPanel } from "@/components/costing/pricing-costs-panel";
import { Panel, Switch } from "@/components/ui/premium";
import { canSwitchPricingCosts, nextPricingCostsHiddenNav, pricingCostsEnabled, PRICING_COSTS_ON_MARKER } from "@/lib/costing/costing-switch";
import { loadOverview, loadPricingCosts, savePricingCosts, setProfitViewer } from "@/lib/costing/pricing-costs-store";
import { getOrgSettingsSnapshot, saveOrgSettings, useOrgSettings } from "@/lib/org-settings";
import { supabase } from "@/lib/supabase";
import { useCompanyUiSwitch } from "@/lib/use-company-ui-switch";
import { useUser } from "@/lib/use-user";
import type { CostingInputs } from "@/lib/costing/pricing-costs";

const LABEL = "Costing";

export function PricingCostsCard() {
  const settings = useOrgSettings();
  const { activeRole, user } = useUser();
  const confirmedOn = useCompanyUiSwitch(PRICING_COSTS_ON_MARKER);
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => loadPricingCosts(supabase), []);
  const overview = useCallback(() => loadOverview(supabase), []);
  const designate = useCallback((userId: string | null) => setProfitViewer(supabase, userId), []);
  const save = useCallback((inputs: CostingInputs, baseVersion: number) => savePricingCosts(supabase, inputs, baseVersion), []);
  if (!canSwitchPricingCosts(activeRole)) return null;
  const on = pricingCostsEnabled(settings.hiddenNav);

  async function change(next: boolean) {
    setSaving(true);
    try {
      const result = await saveOrgSettings({ hiddenNav: nextPricingCostsHiddenNav(getOrgSettingsSnapshot().hiddenNav, next) });
      if (result.dropped) return;
      if (result.denied) return void toast.error(result.message ?? `You can't change ${LABEL}.`);
      if (result.localOnly) toast.message(`${LABEL} saved in this browser only (Supabase unavailable).`);
      else toast.success(`${LABEL} saved`);
    } catch {
      toast.error(`Couldn't save ${LABEL}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="setup-pricing-costs" data-testid="pricing-costs-card">
      <Panel title={LABEL} headingLevel={2}>
        <div style={{ display: "grid", gap: "1rem", minWidth: 0 }}>
          <Switch checked={on} onChange={(next) => { if (!saving) void change(next); }} disabled={saving} label={LABEL} hint="Off until you switch it on. Your crew, running costs and targets, and the hourly rate you need to cover them. Admin only." />
          {on && confirmedOn ? <PricingCostsPanel role={activeRole} userId={user?.id ?? null} load={load} loadOverview={overview} setViewer={designate} save={save} /> : null}
        </div>
      </Panel>
    </section>
  );
}
