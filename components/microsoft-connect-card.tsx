"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { NEEDS_107, cardStatusLabel, microsoftOutcomeMessage, notSetUpMessage, type IntegrationOverview } from "@/lib/integrations/overview";
import { supabase } from "@/lib/supabase";

export type ConnectStatus = { db107: boolean; xero: { configured: boolean }; microsoft: { configured: boolean } };

/** POST to one of the integration routes; the error's own words on failure. */
export async function postIntegration(path: string): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin" }).catch(() => null);
  const body = (res ? await res.json().catch(() => ({})) : {}) as Record<string, unknown>;
  if (!res || !res.ok) return { ok: false, error: typeof body.error === "string" ? body.error : "That didn't work. Try again." };
  return { ok: true, body };
}

/**
 * Admin > Integrations > Microsoft 365 (E7, migration 107): Connect sends the admin to Microsoft to sign in and approve; Microsoft sends
 * them back here with ?microsoft=connected and the card says "All connected" with the mailbox and since when. Disconnect (confirmed) and
 * Test ("Working: <mailbox>" or Microsoft's exact reason). Connect is disabled until the platform owner has entered the app details.
 * Before 107 is applied the card says so and does nothing else.
 */
export function MicrosoftConnectCard({ status }: { status: ConnectStatus | null }) {
  const params = useSearchParams();
  const [overview, setOverview] = useState<IntegrationOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const available = status?.db107 === true;

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("integration_overview", { p_provider: "microsoft" });
    if (error) return toast.error(friendlyError(error, "Couldn't load Microsoft 365."));
    setOverview(data as IntegrationOverview);
  }, []);

  useEffect(() => { if (available) void load(); }, [available, load]);

  const outcome = params.get("microsoft");
  useEffect(() => {
    if (!outcome) return;
    if (outcome === "connected") toast.success(microsoftOutcomeMessage(outcome));
    else toast.error(microsoftOutcomeMessage(outcome));
  }, [outcome]);

  async function connect() {
    setBusy(true);
    try {
      const r = await postIntegration("/api/integrations/microsoft/connect");
      if (!r.ok) toast.error(r.error);
      else if (typeof r.body.url === "string") window.location.assign(r.body.url);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setConfirm(false);
    setBusy(true);
    try {
      const r = await postIntegration("/api/integrations/microsoft/disconnect");
      if (!r.ok) toast.error(r.error);
      else toast.success("Disconnected from Microsoft 365. Tolra sends no mail as that mailbox.");
      setTest(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setTest(null);
    try {
      const r = await postIntegration("/api/integrations/microsoft/test");
      setTest(r.ok ? { ok: true, text: String(r.body.message ?? "Working") } : { ok: false, text: r.error });
    } finally {
      setBusy(false);
    }
  }

  const linked = overview?.status === "connected" || overview?.status === "needs_reconnect";
  return (
    <Card data-testid="microsoft-card">
      <CardHeader>
        <CardTitle>Microsoft 365</CardTitle>
        <CardDescription>Send Tolra&apos;s e-mails from this company&apos;s own mailbox. Someone with that mailbox signs in at Microsoft once and approves.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status === null ? <p className="text-sm text-slate-500">Loading…</p> : !available ? (
          <p className="text-sm text-slate-500" data-testid="microsoft-needs-107">{NEEDS_107}</p>
        ) : !overview ? <p className="text-sm text-slate-500">Loading…</p> : (
          <>
            <p className="text-sm" data-testid="microsoft-status">
              <strong>{cardStatusLabel(overview, "microsoft")}</strong>
              {overview.tenant_name && linked ? <>: <strong>{overview.tenant_name}</strong></> : null}
              {overview.connected_at && linked ? <> since {fmtDate(overview.connected_at)}</> : null}
            </p>
            {overview.status === "needs_reconnect" ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{overview.status_reason ?? "Microsoft 365 needs to be connected again."}</p>
            ) : null}
            {!status.microsoft.configured && overview.status !== "connected" ? (
              <p className="text-sm text-slate-600" data-testid="microsoft-not-set-up">{notSetUpMessage("microsoft")}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {overview.status !== "connected" ? (
                <Button onClick={connect} disabled={busy || !status.microsoft.configured}>{overview.status === "needs_reconnect" ? "Connect again" : "Connect Microsoft 365"}</Button>
              ) : null}
              {overview.status === "connected" ? <Button variant="outline" onClick={runTest} disabled={busy}>Test</Button> : null}
              {linked ? <Button variant="outline" onClick={() => setConfirm(true)} disabled={busy}>Disconnect</Button> : null}
            </div>
            {test ? <p role={test.ok ? "status" : "alert"} className={`text-sm ${test.ok ? "text-emerald-700" : "text-red-700"}`} data-testid="microsoft-test-result">{test.text}</p> : null}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirm}
        title="Disconnect Microsoft 365?"
        description="Tolra stops sending as this mailbox at once (its stored sign-in is deleted). You can connect again at any time."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onCancel={() => setConfirm(false)}
      />
    </Card>
  );
}
