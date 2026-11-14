"use client";

/**
 * The admin-only switch for the ISO 9001 draft templates page (off by default). No database change: it adds or removes the marker in
 * the company's organization_settings.hidden_nav (lib/iso/iso-switch.ts), saved through saveOrgSettings in lib/org-settings.ts.
 *
 * Inputs: the cached company settings (useOrgSettings) and the signed-in role. Outputs: a hidden_nav save with a success or error toast;
 * a refused save leaves the switch as it was. Renders nothing for any role but admin.
 * Must not change: the marker text, the off-by-default rule, the "every other hidden_nav entry is kept" rule (nextIsoHiddenNav), or the
 * wording: these are draft templates and a self-check aid, never a claim about any external assessment.
 */
import { useState } from "react";
import { toast } from "sonner";
import { FileText } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { canSeeIso, isoTemplatesEnabled, nextIsoHiddenNav } from "@/lib/iso/iso-switch";
import { getOrgSettingsSnapshot, saveOrgSettings, useOrgSettings } from "@/lib/org-settings";
import { useUser } from "@/lib/use-user";

const LABEL = "ISO 9001 draft templates";

export function IsoSwitchCard() {
  const settings = useOrgSettings();
  const { activeRole } = useUser();
  const [saving, setSaving] = useState(false);
  if (!canSeeIso(activeRole)) return null;
  const on = isoTemplatesEnabled(settings.hiddenNav);

  async function change(next: boolean) {
    setSaving(true);
    try {
      const result = await saveOrgSettings({ hiddenNav: nextIsoHiddenNav(getOrgSettingsSnapshot().hiddenNav, next) });
      if (result.dropped) return;
      if (result.denied) return void toast.error(result.message ?? `You can't change the ${LABEL}.`);
      if (result.localOnly) toast.message(`${LABEL} saved in this browser only (Supabase unavailable).`);
      else toast.success(`${LABEL} saved`);
    } catch {
      toast.error(`Couldn't save the ${LABEL}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="iso-switch-card">
      <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="size-5 text-brand-accent" /> {LABEL}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">Off until you switch it on. Draft documents and a self-check list for your own review. They only read records Tolra already keeps. Admin only.</p>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span className="font-medium text-slate-800">{LABEL}</span>
          <button type="button" role="switch" aria-checked={on} aria-label={LABEL} disabled={saving} onClick={() => { if (!saving) void change(!on); }} className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-none transition disabled:cursor-not-allowed disabled:opacity-60 ${on ? "bg-brand" : "bg-slate-300"}`}>
            <span className={`inline-block size-5 rounded-none bg-white shadow transition ${on ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
