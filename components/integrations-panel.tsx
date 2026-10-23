"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { missingDbObject } from "@/lib/db-features";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { connectOutcomeMessage, overviewSummary, type IntegrationOverview } from "@/lib/integrations/overview";
import { supabase } from "@/lib/supabase";

/**
 * Admin > Integrations (G22): one card per accounting system; Xero first. Per company and OFF until an admin connects; nothing is sent
 * until every account and VAT rate used is mapped (the mapping page and the send log come in the next PR). Shows the connection (never a
 * token), what is not mapped yet and the send log's counts.
 */
export function IntegrationsPanel() {
  const params = useSearchParams();
  const [overview, setOverview] = useState<IntegrationOverview | null>(null);
  const [missing084, setMissing084] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("integration_overview", { p_provider: "xero" });
    if (error) {
      if (missingDbObject(error)) setMissing084(true);
      else toast.error(friendlyError(error, "Couldn't load the integrations."));
      return;
    }
    setOverview(data as IntegrationOverview);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const outcome = params.get("xero");
  useEffect(() => {
    if (!outcome) return;
    const message = connectOutcomeMessage(outcome);
    if (outcome === "connected") toast.success(message);
    else toast.error(message);
  }, [outcome]);

  async function post(path: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(path, { method: "POST", credentials: "same-origin" });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      toast.error(typeof body.error === "string" ? body.error : "That didn't work. Try again.");
      return null;
    }
    return body;
  }

  async function connect() {
    setBusy(true);
    try {
      const body = await post("/api/integrations/xero/connect");
      if (body && typeof body.url === "string") window.location.assign(body.url);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setConfirmDisconnect(false);
    setBusy(true);
    try {
      if (await post("/api/integrations/xero/disconnect")) toast.success("Disconnected from Xero. Nothing more is sent.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setBusy(true);
    try {
      const body = await post("/api/integrations/xero/send");
      if (body) toast.success(body.skipped === "not_configured" ? "Xero is not set up on this server yet." : `Sent ${Number(body.sent ?? 0)}; failed ${Number(body.failed ?? 0)}.`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (missing084) {
    return <p className="text-sm text-slate-500">Integrations need the database update 084. Ask the platform owner to apply it.</p>;
  }
  const summary = overview ? overviewSummary(overview) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Xero</CardTitle>
        <CardDescription>
          One way, Tolra to Xero: issued invoices, issued credit notes and their customers, with Tolra&apos;s numbers. Voids are sent as voids.
          Nothing is ever read back into Tolra; payments stay in Xero.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!overview ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <p className="text-sm" data-testid="xero-status">
              <strong>{summary!.statusLabel}</strong>
              {overview.tenant_name ? <> to <strong>{overview.tenant_name}</strong></> : null}
              {overview.connected_at && overview.status !== "not_connected" ? <> since {fmtDate(overview.connected_at)}</> : null}
            </p>
            {overview.status === "needs_reconnect" ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                {overview.status_reason ?? "Xero needs to be connected again."} Sending is paused until an admin connects again.
              </p>
            ) : null}
            {summary!.unmappedLabel ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="xero-unmapped">{summary!.unmappedLabel}</p>
            ) : null}
            {summary!.countsLabel ? <p className="text-sm text-slate-600">{summary!.countsLabel}</p> : null}
            <div className="flex flex-wrap gap-2">
              {overview.status !== "connected" ? (
                <Button onClick={connect} disabled={busy}>{overview.status === "needs_reconnect" ? "Connect again" : "Connect to Xero"}</Button>
              ) : null}
              {overview.status === "connected" ? <Button variant="outline" onClick={sendNow} disabled={busy}>Send now</Button> : null}
              {overview.status !== "not_connected" && overview.status !== "disconnected" ? (
                <Button variant="outline" onClick={() => setConfirmDisconnect(true)} disabled={busy}>Disconnect</Button>
              ) : null}
            </div>
            <p className="text-xs text-slate-500">
              Each company connects its own Xero organisation. Documents issued before the company connects are never sent.
            </p>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect from Xero?"
        description="Nothing more is sent. Anything queued and not yet sent is dropped (it is never sent to another organisation). The send log stays."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </Card>
  );
}
