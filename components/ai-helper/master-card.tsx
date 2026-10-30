"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

import { sendAiHelper } from "@/components/ai-helper/api";
import { type AiHelperStatus, featureStates } from "@/components/ai-helper/use-ai-helper-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type AiFeatureKey, type AiFeatureStates, applyMaster, masterLabel, masterState, settingsBody } from "@/lib/ai-helper/master-switch";

export const FEATURE_LABELS: Record<AiFeatureKey, { title: string; hint: string }> = {
  roundup: { title: "Round-up of what is late, waiting or unbilled", hint: "A daily or weekly summary. Read-only." },
  rfq: { title: "RFQ email to draft quote", hint: "Turns a pasted customer e-mail into a draft quote. Prices come from your fixed calculation." },
  financeCheck: { title: "Check before issue (finance check)", hint: "Suggestions on a draft invoice, purchase order or credit note before it is issued." },
};

/**
 * The AI section's master switch: "AI on/off" for this company, with one switch per feature under it. Admins change it (each change
 * is saved straight away through the settings route, which writes every feature together); office sees the same state read-only.
 * The master switch is not stored on its own: on = all features on, off = all off, in between = "Some features on" (lib/ai-helper/master-switch.ts).
 */
export function AiMasterCard({ status, onStatus }: { status: AiHelperStatus; onStatus: (next: AiHelperStatus) => void }) {
  const states = featureStates(status);
  const state = masterState(states);
  const [busy, setBusy] = useState(false);
  const master = useRef<HTMLInputElement>(null);
  const canManage = status.can_manage;

  useEffect(() => { if (master.current) master.current.indeterminate = state === "partial"; }, [state]);

  async function save(next: AiFeatureStates) {
    setBusy(true);
    try {
      const saved = await sendAiHelper("/api/ai-helper/settings", { method: "POST", body: JSON.stringify(settingsBody(next, status.monthly_cap_pence)) });
      onStatus(saved);
      if (saved.warning) toast.warning(saved.warning);
      else toast.success("AI settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const note = state === "off" ? null : status.key_set && status.monthly_cap_pence > 0 ? null : "Nothing runs until a monthly limit is set and your company's own Anthropic key is added (below).";

  return (
    <Card data-testid="ai-helper-master">
      <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="size-5 text-brand-accent" /> AI for this company</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-3 rounded-lg border p-3 text-sm font-medium text-slate-900">
          <input ref={master} type="checkbox" className="size-4" aria-label="AI on for this company" data-testid="ai-master-switch" checked={state === "on"} disabled={busy || !canManage}
            onChange={(e) => void save(applyMaster(states, e.target.checked))} />
          <span>AI on for this company</span>
          <span className="ml-auto text-xs font-normal text-slate-600" data-testid="ai-master-state">{masterLabel(state)}</span>
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(FEATURE_LABELS) as AiFeatureKey[]).map((key) => {
            const value = states[key];
            return (
              <label key={key} className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={value === true} disabled={busy || !canManage || value === null}
                  onChange={(e) => void save({ ...states, [key]: e.target.checked })} />
                <span>
                  <span className="block">{FEATURE_LABELS[key].title}</span>
                  <span className="block text-xs text-slate-500">{value === null ? "Not available yet: the database needs updating for this one." : FEATURE_LABELS[key].hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {note ? <p className="text-xs text-amber-800" data-testid="ai-master-note">{note}</p> : null}
        {!canManage ? <p className="text-xs text-slate-500">Only an admin can change these switches.</p> : null}
      </CardContent>
    </Card>
  );
}
