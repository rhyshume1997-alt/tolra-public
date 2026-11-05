"use client";

import { useCallback, useEffect, useState } from "react";

import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SetupCard } from "@/components/integrations/setup-card";
import { type ConnectStatus, postIntegration } from "@/components/microsoft-connect-card";
import { postIntegrationWithCode } from "@/lib/integrations/post-with-code";
import { Button } from "@/components/ui/button";
import { XeroMappings } from "@/components/xero-mappings";
import type { IntegrationOverview } from "@/lib/integrations/overview";
import { postJson, safeMessage } from "@/lib/integrations/ai-setup";
import { sendWithCode } from "@/lib/mfa-step-up";
import {
  EMERGENCY_NOTE, type LaunchHold, activationFor, connectionLine, outcomeNotice, serverBehaviour, setupSteps,
} from "@/lib/integrations/xero-setup-state";
import { supabase } from "@/lib/supabase";

export type XeroSetupCardViewProps = {
  configured: boolean | null;
  overview: IntegrationOverview | null;
  loadError?: boolean;
  outcome?: string | null;
  launchHold?: LaunchHold;
  busy?: boolean;
  /** Result of "Check with Xero": the organisation name read from Xero just now, or Xero's reason. */
  check?: { ok: boolean; text: string } | null;
  /** An error from the last action (connect, disconnect, switch), shown plainly. */
  actionError?: string | null;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onCheck?: () => void;
  onMappingsChanged?: () => void;
  onSwitch?: (next: boolean) => void;
};

/** The presentation of the Xero card in the shared frame: every state is a prop, so every state is tested without a server. */
export function XeroSetupCardView(p: XeroSetupCardViewProps) {
  const inputs = { configured: p.configured, overview: p.overview, loadError: p.loadError, outcome: p.outcome, launchHold: p.launchHold };
  const behaviour = serverBehaviour(inputs);
  const notice = outcomeNotice(p.outcome);
  const status = p.overview?.status;
  const connected = status === "connected";
  const linked = connected || status === "needs_reconnect";
  const canConnect = p.configured === true && p.overview !== null && !p.busy;
  const behaviourTone = behaviour.kind === "sends" ? "border-emerald-300 bg-emerald-50 text-emerald-900"
    : behaviour.kind === "unknown" || behaviour.kind === "needs_reconnect" || behaviour.kind === "held" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700";
  const unmapped = p.overview?.unmapped ?? [];
  return (
    <SetupCard
      id="xero"
      title="Xero"
      summary="One way, Tolra to Xero: issued invoices, issued credit notes and their customers. Nothing is read back; payments stay in Xero."
      connection={connectionLine(inputs)}
      steps={setupSteps(inputs)}
      activation={activationFor(inputs, p.busy, p.onSwitch)}
      footnote={EMERGENCY_NOTE}
    >
      <p className={`rounded-md border p-2 text-sm ${behaviourTone}`} data-testid="xero-behaviour" data-kind={behaviour.kind}>{behaviour.text}</p>
      {notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={`text-sm ${notice.tone === "error" ? "text-red-700" : "text-emerald-700"}`} data-testid="xero-outcome">{notice.text}</p> : null}
      {p.actionError ? <p role="alert" className="text-sm text-red-700" data-testid="xero-action-error">{p.actionError}</p> : null}
      {connected ? (
        <p className="text-sm" data-testid="xero-tenant">
          <span className="font-medium">Xero organisation: </span>{p.overview?.tenant_name ?? "name not available"}.{" "}
          Bound to this Tolra company only: Xero will not let another company use it while this one holds it.
        </p>
      ) : null}
      {connected && unmapped.length > 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="xero-unmapped">
          {unmapped.length} unmapped. Transfers cannot be turned on while any is unmapped.
        </p>
      ) : null}
      {p.check ? <p role={p.check.ok ? "status" : "alert"} className={`text-sm ${p.check.ok ? "text-emerald-700" : "text-red-700"}`} data-testid="xero-check-result">{p.check.text}</p> : null}
      <div className="flex flex-wrap gap-2">
        {linked ? null : <Button onClick={p.onConnect} disabled={!canConnect || !p.onConnect}>Connect to Xero</Button>}
        {status === "needs_reconnect" ? <Button onClick={p.onConnect} disabled={!canConnect || !p.onConnect}>Connect again</Button> : null}
        {connected ? <Button variant="outline" onClick={p.onCheck} disabled={p.busy || !p.onCheck}>Check with Xero</Button> : null}
        {linked ? <Button variant="outline" onClick={p.onDisconnect} disabled={p.busy || !p.onDisconnect}>Disconnect</Button> : null}
      </div>
      {p.overview && linked ? <XeroMappings connected={connected} unmapped={unmapped} onChanged={p.onMappingsChanged ?? (() => undefined)} /> : null}
    </SetupCard>
  );
}

/**
 * Admin > Integrations > Xero, in the shared SetupCard frame. Reads the company's overview (integration_overview, this company only) and the
 * status route (are Xero's app details on this server). Connect, Check, Disconnect and the mappings reuse the existing routes and
 * components; their authorisation (admin role, second step of sign-in) is the routes' and the database's, unchanged.
 * The "Turn on transfers" switch is the company's own, persisted, server-side Xero transfer switch (release 149; GET and POST
 * /api/integrations/xero/launch): OFF by default, separate from Connected, enabled only when the company is connected and mapped, and turned on
 * only with a fresh authenticator code (the same code prompt as the AI switch: the route answers mfa_recent_required, the dialog opens, the same
 * request is sent once more). It is read from the server, never assumed. `launchHold` (a test seam): when given, it replaces the real switch.
 * The Connect, Disconnect and Check logic is copied from components/integrations-panel.tsx (which is not edited).
 */
export function XeroSetupCard({ launchHold: injected, outcome }: { launchHold?: LaunchHold; outcome?: string | null }) {
  const { requestCode, codeDialog } = useCodePrompt();
  const [switchOn, setSwitchOn] = useState<boolean | null>(null);
  const [switchReadable, setSwitchReadable] = useState(true);
  const [overview, setOverview] = useState<IntegrationOverview | null>(null);
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [urlOutcome, setUrlOutcome] = useState<string | null>(null);

  useEffect(() => { if (outcome === undefined) setUrlOutcome(new URLSearchParams(window.location.search).get("xero")); }, [outcome]);

  const load = useCallback(async () => {
    if (!supabase) { setLoadError(true); return; }
    const { data, error } = await supabase.rpc("integration_overview", { p_provider: "xero" });
    if (error) { setLoadError(true); return; }
    setLoadError(false);
    setOverview(data as IntegrationOverview);
  }, []);
  useEffect(() => { void load(); }, [load]);
  // The transfer switch, as the server holds it (admin only). Unreadable: shown as such, and nothing is sent (the app fails closed).
  const loadSwitch = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/xero/launch", { credentials: "same-origin", cache: "no-store" });
      const body = res.ok ? ((await res.json().catch(() => null)) as { enabled?: unknown } | null) : null;
      if (body && typeof body.enabled === "boolean") { setSwitchOn(body.enabled); setSwitchReadable(true); } else { setSwitchOn(null); setSwitchReadable(false); }
    } catch { setSwitchOn(null); setSwitchReadable(false); }
  }, []);
  useEffect(() => { if (!injected) void loadSwitch(); }, [injected, loadSwitch]);
  useEffect(() => {
    let active = true;
    void fetch("/api/integrations/status", { credentials: "same-origin" })
      .then(async (res) => (res.ok ? ((await res.json()) as ConnectStatus) : null))
      .catch(() => null)
      // A failed status read is not "set up": the card says it does not know.
      .then((value) => { if (active) { if (value) setStatus(value); else setStatusFailed(true); } });
    return () => { active = false; };
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try { await fn(); } finally { setBusy(false); }
  }
  const connect = () => run(async () => {
    const r = await postIntegrationWithCode("/api/integrations/xero/connect", requestCode);
    if (!r.ok) setActionError(r.error);
    else if (typeof r.body.url === "string") window.location.assign(r.body.url);
  });
  const disconnect = () => { setConfirm(false); return run(async () => {
    const r = await postIntegrationWithCode("/api/integrations/xero/disconnect", requestCode);
    if (!r.ok) setActionError(r.error);
    setCheck(null);
    await load();
  }); };
  const runCheck = () => run(async () => {
    setCheck(null);
    const r = await postIntegration("/api/integrations/xero/test");
    setCheck(r.ok ? { ok: true, text: String(r.body.message ?? "Working") } : { ok: false, text: r.error });
  });
  const changeSwitch = async (next: boolean) => {
    const outcome = await sendWithCode(() => postJson("/api/integrations/xero/launch", { enabled: next }), requestCode);
    if (outcome.result === "cancelled") setActionError("Cancelled. Nothing was changed.");
    else if (outcome.result === "failed") setActionError(safeMessage(outcome.answer.body, "Xero transfers were not changed. Try again."));
    await loadSwitch();
  };
  const launchHold: LaunchHold | undefined = injected ?? { available: switchReadable, on: switchOn, set: changeSwitch };
  const flip = (next: boolean) => { void run(async () => { await launchHold.set(next); await load(); }); };

  return (
    <>
      {codeDialog}

      <XeroSetupCardView
        configured={status ? status.xero.configured : null}
        overview={overview}
        loadError={loadError || statusFailed}
        outcome={outcome === undefined ? urlOutcome : outcome}
        launchHold={launchHold}
        busy={busy}
        check={check}
        actionError={actionError}
        onConnect={() => void connect()}
        onDisconnect={() => setConfirm(true)}
        onCheck={() => void runCheck()}
        onMappingsChanged={() => void load()}
        onSwitch={flip}
      />
      <ConfirmDialog
        open={confirm}
        title="Disconnect from Xero?"
        description="Nothing more is sent. Anything queued and not yet sent is dropped (it is never sent to another organisation). The send log stays."
        confirmLabel="Disconnect"
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
