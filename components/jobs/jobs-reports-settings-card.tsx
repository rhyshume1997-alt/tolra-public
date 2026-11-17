"use client";

/**
 * Settings card "Job reports": three admin-only switches, all OFF by default, for planned vs actual machine time on job worksheets,
 * the NCR register and the operations Reports page (lib/reports/reports-switch.ts). No database change: each switch adds or removes its marker in the company's organization_settings.hidden_nav
 * (lib/jobs/planned-vs-actual-switch.ts, lib/jobs/ncr-register-switch.ts), saved through saveOrgSettings in lib/org-settings.ts.
 *
 * Inputs: the cached company settings (useOrgSettings) and the signed-in role. Outputs: a hidden_nav save; a refused save shows an
 * error toast and the switch stays as it was.
 * Must not change: the marker texts (owned by the two switch files), the off-by-default rule, or the "every other hidden_nav entry
 * is left unchanged" rule in nextHiddenNav.
 */
import { useState } from "react";
import { toast } from "sonner";
import { FileBarChart } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ncrRegisterEnabled, ncrRegisterSwitchChange } from "@/lib/jobs/ncr-register-switch";
import { plannedVsActualEnabled, plannedVsActualSwitchChange } from "@/lib/jobs/planned-vs-actual-switch";
import { reportsEnabled, reportsSwitchChange } from "@/lib/reports/reports-switch";
import { getOrgSettingsSnapshot, saveOrgSettings, useOrgSettings } from "@/lib/org-settings";
import { useUser } from "@/lib/use-user";

type HiddenNavChange = { add: string[]; remove: string[] };

/** The hidden_nav list after applying a switch's {add, remove}: every other entry (sales-orders:on, hidden keys, the other switch) is kept in order. */
export function nextHiddenNav(current: readonly string[], change: HiddenNavChange): string[] {
  const kept = current.filter((entry) => !change.remove.includes(entry));
  return [...kept, ...change.add.filter((entry) => !kept.includes(entry))];
}

function SwitchButton({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-none transition disabled:cursor-not-allowed disabled:opacity-60 ${checked ? "bg-brand" : "bg-slate-300"}`}>
      <span className={`inline-block size-5 rounded-none bg-white shadow transition ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

export function JobsReportsSettingsCard() {
  const settings = useOrgSettings();
  const { activeRole } = useUser();
  const [saving, setSaving] = useState(false);
  if (activeRole !== "admin") return null;

  async function change(label: string, switchChange: HiddenNavChange) {
    setSaving(true);
    try {
      // saveOrgSettings turns the full list into a delta against the cache and merges it onto the server row at save time.
      const result = await saveOrgSettings({ hiddenNav: nextHiddenNav(getOrgSettingsSnapshot().hiddenNav, switchChange) });
      if (result.dropped) return;
      if (result.denied) return void toast.error(result.message ?? `You can't change ${label.toLowerCase()}.`);
      if (result.localOnly) toast.message(`${label} saved in this browser only (Supabase unavailable).`);
      else toast.success(`${label} saved`);
    } catch {
      toast.error(`Couldn't save ${label.toLowerCase()}.`);
    } finally {
      setSaving(false);
    }
  }

  const rows = [
    { label: "Planned vs actual machine time on job worksheets", on: plannedVsActualEnabled(settings.hiddenNav), changeFor: plannedVsActualSwitchChange },
    { label: "NCR register", on: ncrRegisterEnabled(settings.hiddenNav), changeFor: ncrRegisterSwitchChange },
    { label: "Reports page", on: reportsEnabled(settings.hiddenNav), changeFor: reportsSwitchChange },
  ];

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><FileBarChart className="size-5 text-brand-accent" /> Job reports</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">All are off until you switch them on. They only read records Tolra already keeps, and are shown to admin and office.</p>
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <span className="font-medium text-slate-800">{row.label}</span>
            <SwitchButton checked={row.on} label={row.label} disabled={saving} onChange={(checked) => { if (!saving) void change(row.label, row.changeFor(checked)); }} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
