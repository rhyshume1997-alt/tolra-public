"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { pounds, sendAiHelper } from "@/components/ai-helper/api";
import { type AiHelperStatus, featureStates } from "@/components/ai-helper/use-ai-helper-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { availableFeatures, settingsBody } from "@/lib/ai-helper/master-switch";
import { FEATURE_LABELS } from "@/components/ai-helper/master-card";

/**
 * "How it is customised": what belongs to this company. Everyone who can open the AI section sees the summary (key set or not, the
 * monthly limit and this month's use, which features are on, who can use it). An admin also gets the two things only they set: the
 * monthly limit and the company's OWN Anthropic API key (an account the business owns; set a spend limit in the Anthropic console too).
 * The key goes to the server, which stores it encrypted, and never comes back: only whether one is set and its last four characters.
 */
export function AiCustomisedCard({ status, onStatus }: { status: AiHelperStatus; onStatus: (next: AiHelperStatus) => void }) {
  const [cap, setCap] = useState(pounds(status.monthly_cap_pence));
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCap(pounds(status.monthly_cap_pence)); }, [status.monthly_cap_pence]);

  const states = featureStates(status);
  const on = availableFeatures(states).filter((k) => states[k] === true).map((k) => FEATURE_LABELS[k].title);

  async function run(action: () => Promise<AiHelperStatus>, done: string) {
    setBusy(true);
    try {
      onStatus(await action());
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  function saveCap() {
    const pence = Math.round(Number(cap) * 100);
    if (!Number.isFinite(pence) || pence < 0 || pence > 100_000) {
      toast.error("Enter a monthly limit between £0 and £1000.");
      return;
    }
    void run(() => sendAiHelper("/api/ai-helper/settings", { method: "POST", body: JSON.stringify(settingsBody(states, pence)) }), "Monthly limit saved");
  }

  function saveKey() {
    const value = key.trim();
    setKey("");
    void run(() => sendAiHelper("/api/ai-helper/key", { method: "POST", body: JSON.stringify({ key: value }) }), "API key saved");
  }

  return (
    <Card data-testid="ai-helper-settings">
      <CardHeader><CardTitle>How it is customised</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-slate-500">Your Anthropic key</dt>
          <dd data-testid="ai-helper-key-state" className="font-medium text-slate-900">{status.key_set ? `API key set${status.can_manage ? ` (ending ${status.key_last4 ?? "????"})` : ""}` : "No API key set"}</dd>
          <dt className="text-slate-500">Monthly limit</dt>
          <dd data-testid="ai-helper-usage">£{pounds(status.monthly_cap_pence)} (used this month: £{pounds(status.month_spent_pence)})</dd>
          <dt className="text-slate-500">Features on</dt>
          <dd>{on.length ? on.join("; ") : "None"}</dd>
          <dt className="text-slate-500">Who can use it</dt>
          <dd>Office and admin. Workshop and viewer logins cannot. Only an admin changes these settings.</dd>
        </dl>
        {status.can_manage ? (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-sm">
                <span className="field-label">Monthly limit (£)</span>
                <Input aria-label="Monthly AI limit in pounds" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className="w-32" disabled={busy} />
              </label>
              <Button type="button" onClick={saveCap} disabled={busy}>Save monthly limit</Button>
              <p className="text-xs text-slate-500">Nothing runs until a limit above £0 is set. When it is reached, the AI stops for the month.</p>
            </div>
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-xs text-slate-500">Your company&apos;s own Anthropic API key, from an account your business owns, with a spend limit set in the Anthropic console. It is stored encrypted and is never shown again.</p>
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Anthropic API key" type="password" autoComplete="off" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} className="max-w-sm" disabled={busy} />
                <Button type="button" variant="outline" onClick={saveKey} disabled={busy || !key.trim()}>Save key</Button>
                {status.key_set ? <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => sendAiHelper("/api/ai-helper/key", { method: "DELETE" }), "API key removed")}>Remove key</Button> : null}
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
