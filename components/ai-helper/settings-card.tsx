"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

import { type AiHelperStatus, useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const pounds = (pence: number) => (pence / 100).toFixed(2);

async function send(path: string, init: RequestInit): Promise<AiHelperStatus> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const payload = (await response.json().catch(() => ({}))) as AiHelperStatus & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Could not save.");
  return payload;
}

/**
 * Settings > AI helper (admins). Shown only when this server has the helper on (AI_HELPER_ENABLED). Both features start off; nothing
 * runs until a monthly limit is set and the company's OWN Anthropic API key is added (one account per company, owned by the business;
 * set a spend limit in the Anthropic console too). The key goes to the server, which stores it encrypted, and never comes back: this
 * card only ever shows whether one is set and its last four characters.
 */
export function AiHelperSettingsCard() {
  const { status, allowed, setStatus } = useAiHelperStatus();
  const [roundup, setRoundup] = useState(false);
  const [rfq, setRfq] = useState(false);
  const [cap, setCap] = useState("0.00");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!status) return;
    setRoundup(status.roundup_enabled);
    setRfq(status.rfq_enabled);
    setCap(pounds(status.monthly_cap_pence));
  }, [status]);

  if (!allowed || !status?.can_manage) return null;

  async function run(action: () => Promise<AiHelperStatus>, done: string) {
    setBusy(true);
    try {
      setStatus(await action());
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  function saveSettings() {
    const pence = Math.round(Number(cap) * 100);
    if (!Number.isFinite(pence) || pence < 0 || pence > 100_000) {
      toast.error("Enter a monthly limit between £0 and £1000.");
      return;
    }
    void run(() => send("/api/ai-helper/settings", { method: "POST", body: JSON.stringify({ roundupEnabled: roundup, rfqEnabled: rfq, monthlyCapPence: pence }) }), "AI helper settings saved");
  }

  function saveKey() {
    const value = key.trim();
    setKey("");
    void run(() => send("/api/ai-helper/key", { method: "POST", body: JSON.stringify({ key: value }) }), "API key saved");
  }

  return (
    <Card data-testid="ai-helper-settings">
      <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="size-5 text-brand-accent" /> AI helper</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">Office paperwork help for admin and office users. It suggests; a person checks and approves. It never sends, issues, approves, voids, records payments or edits records. Prices never come from the AI. Both are off until you switch them on.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-3 rounded-lg border p-3 text-sm">
            <input type="checkbox" className="size-4" checked={roundup} onChange={(e) => setRoundup(e.target.checked)} disabled={busy} />
            <span>Round-up of what is late, waiting or unbilled</span>
          </label>
          <label className="flex items-center gap-3 rounded-lg border p-3 text-sm">
            <input type="checkbox" className="size-4" checked={rfq} onChange={(e) => setRfq(e.target.checked)} disabled={busy} />
            <span>RFQ email to draft quote</span>
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="field-label">Monthly limit (£)</span>
            <Input aria-label="Monthly AI limit in pounds" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className="w-32" disabled={busy} />
          </label>
          <Button type="button" onClick={saveSettings} disabled={busy}>Save AI helper settings</Button>
          <p className="text-xs text-slate-500">Used this month: £{pounds(status.month_spent_pence)} of £{pounds(status.monthly_cap_pence)}.</p>
        </div>
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium text-slate-800" data-testid="ai-helper-key-state">
            {status.key_set ? `API key set (ending ${status.key_last4 ?? "????"})` : "No API key set"}
          </p>
          <p className="text-xs text-slate-500">Your company&apos;s own Anthropic API key, from an account your business owns, with a spend limit set in the Anthropic console. It is stored encrypted and is never shown again.</p>
          <div className="flex flex-wrap gap-2">
            <Input aria-label="Anthropic API key" type="password" autoComplete="off" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} className="max-w-sm" disabled={busy} />
            <Button type="button" variant="outline" onClick={saveKey} disabled={busy || !key.trim()}>Save key</Button>
            {status.key_set ? <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => send("/api/ai-helper/key", { method: "DELETE" }), "API key removed")}>Remove key</Button> : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
