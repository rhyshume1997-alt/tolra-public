"use client";

// Platform owner Rollouts (module G). Inputs: GET /api/platform/rollouts (every company with the listed switches it has on, and the log). Outputs:
// POSTs to the same route to turn ONE listed switch on or off for the chosen companies, in phases (a phase name is only a label on the log).
// Turning on asks for a fresh authenticator code (sendWithCode); turning off never does. Must not change: only switches listed in
// lib/platform/rollouts.ts; nothing is on by default; the screen never changes a company's data other than that one marker.

import { useCallback, useEffect, useState } from "react";

import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { sendWithCode } from "@/lib/mfa-step-up";
import { ROLLOUT_PHASE_MAX, ROLLOUT_SWITCHES, switchLabel, type RolloutOverview } from "@/lib/platform/rollouts";

type Body = { error?: string; code?: unknown; changed?: number; requested?: number };
const when = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function RolloutsCard() {
  const [overview, setOverview] = useState<RolloutOverview | null>(null);
  const [marker, setMarker] = useState(ROLLOUT_SWITCHES[0].marker);
  const [chosen, setChosen] = useState<string[]>([]);
  const [phase, setPhase] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { requestCode, codeDialog } = useCodePrompt();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/platform/rollouts", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as (RolloutOverview & { error?: string; code?: string }) | null;
      if (response.status === 403 && body?.code === "mfa_required") return window.location.assign("/mfa");
      if (!response.ok || !body?.companies) return setMessage({ ok: false, text: body?.error || "Couldn't load the rollouts." });
      setOverview({ companies: body.companies, log: body.log });
    } catch {
      setMessage({ ok: false, text: "Can't reach the server. Check your connection and try again." });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const companies = overview?.companies ?? [];
  const hasOn = (c: { on: string[] }) => c.on.includes(marker);
  const onNow = companies.filter(hasOn);
  const info = ROLLOUT_SWITCHES.find((s) => s.marker === marker);

  async function apply(on: boolean, ids: string[]) {
    if (busy || ids.length === 0) return;
    setBusy(true);
    setMessage(null);
    const send = async () => {
      const response = await fetch("/api/platform/rollouts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ switchMarker: marker, organizationIds: ids, on, phase: phase.trim() }) });
      return { ok: response.ok, status: response.status, body: (await response.json().catch(() => null)) as Body | null };
    };
    try {
      const outcome = await sendWithCode<Body>(send, requestCode);
      if (outcome.result === "cancelled") return setMessage({ ok: false, text: "Cancelled. Nothing was changed." });
      if (outcome.result === "failed") return setMessage({ ok: false, text: outcome.answer.body?.error || "Couldn't change the switch. Nothing was changed." });
      const b = outcome.answer.body;
      setMessage({ ok: true, text: `${switchLabel(marker)} turned ${on ? "on" : "off"} for ${b?.changed ?? 0} of ${b?.requested ?? ids.length} ${ids.length === 1 ? "company" : "companies"} (the rest were already ${on ? "on" : "off"}). Logged.` });
      setChosen([]);
      await load();
    } catch {
      setMessage({ ok: false, text: "Can't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const activeIds = companies.filter((c) => c.status === "active").map((c) => c.organizationId);
  const toggle = (id: string) => setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <Card className="mt-4" data-testid="rollouts">
      <CardHeader><CardTitle>Rollouts</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-600">Turn one existing feature switch on for one company, a chosen few or all, in phases (for example one company first, then the rest). Nothing is on by default. This changes only that one switch, never a company&apos;s records. Turning a switch on asks for a fresh authenticator code; turning it off does not.</p>
        {message ? <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-green-700" : "text-sm text-red-700"}>{message.text}</p> : null}

        <label className="grid gap-1 text-sm">Switch
          <select aria-label="Switch" className="h-11 rounded-md border px-2" value={marker} onChange={(e) => { setMarker(e.target.value); setChosen([]); setMessage(null); }} disabled={busy}>
            {ROLLOUT_SWITCHES.map((s) => <option key={s.marker} value={s.marker}>{s.label}</option>)}
          </select>
          {info ? <span className="text-xs text-slate-500">{info.note}</span> : null}
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{switchLabel(marker)} is on for {onNow.length} of {companies.length} {companies.length === 1 ? "company" : "companies"}.</p>
          <Button variant="outline" disabled={busy || onNow.length === 0} className="min-h-11" onClick={() => void apply(false, onNow.map((c) => c.organizationId))}>Turn off everywhere</Button>
        </div>

        {overview === null && !message ? <p className="text-sm text-slate-500">Loading...</p> : null}
        <ul className="grid gap-1" data-testid="rollout-companies">
          {companies.map((c) => (
            <li key={c.organizationId} className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-1.5" data-company={c.slug}>
              <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <input type="checkbox" aria-label={`Choose ${c.name}`} checked={chosen.includes(c.organizationId)} onChange={() => toggle(c.organizationId)} disabled={busy} />
                <span className="truncate">{c.name}{c.status !== "active" ? ` (${c.status})` : ""}</span>
              </label>
              <Badge variant="outline">{hasOn(c) ? "On" : "Off"}</Badge>
              {hasOn(c) ? <Button variant="outline" size="sm" aria-label={`Turn ${switchLabel(marker)} off for ${c.name}`} disabled={busy} onClick={() => void apply(false, [c.organizationId])}>Turn off</Button> : null}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setChosen(activeIds)} className="min-h-11">Choose all active companies</Button>
          <Button variant="outline" disabled={busy || chosen.length === 0} onClick={() => setChosen([])} className="min-h-11">Clear choice</Button>
        </div>
        <label className="grid gap-1 text-sm">Phase name (optional, shown in the log, for example &quot;Phase 1: first company&quot;)
          <Input aria-label="Phase name" value={phase} maxLength={ROLLOUT_PHASE_MAX} onChange={(e) => setPhase(e.target.value)} disabled={busy} className="h-11" autoComplete="off" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || chosen.length === 0} onClick={() => void apply(true, chosen)} className="min-h-11">{busy ? "Working..." : `Turn on for ${chosen.length} ${chosen.length === 1 ? "company" : "companies"}`}</Button>
          <Button variant="outline" disabled={busy || chosen.length === 0} onClick={() => void apply(false, chosen)} className="min-h-11">Turn off for the chosen</Button>
        </div>

        <h2 className="pt-2 text-base font-semibold">Rollout log</h2>
        {overview?.log.length === 0 ? <p className="text-sm text-slate-500">Nothing has been rolled out yet.</p> : null}
        <ul className="grid gap-1" data-testid="rollout-log">
          {(overview?.log ?? []).map((row) => (
            <li key={row.id} className="rounded-md border border-slate-200 px-3 py-1.5 text-sm">
              <span className="font-medium">{switchLabel(row.switchMarker)} {row.turnedOn ? "on" : "off"}</span> for {row.orgNames.join(", ")}
              {row.phase ? ` (${row.phase})` : ""}. <span className="text-slate-500">{row.changed} changed, by {row.actorEmail}, {when(row.createdAt)}.</span>
            </li>
          ))}
        </ul>
        {codeDialog}
      </CardContent>
    </Card>
  );
}
