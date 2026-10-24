"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { XeroMappings } from "@/components/xero-mappings";
import { XeroSendLog } from "@/components/xero-send-log";
import { NEEDS_DATABASE_UPDATE, databaseHas084, missingDbObject } from "@/lib/db-features";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { connectOutcomeMessage, overviewSummary, type IntegrationOverview } from "@/lib/integrations/overview";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

/**
 * Admin > Integrations (G22): one card per accounting system; Xero first. Per company (the one signed in to) and OFF until an admin
 * connects; nothing is sent until both account codes and every VAT rate used are mapped. Shows the connection (never a token), what is
 * not mapped yet and the send log's counts, then the mappings and the send log (PR 2). Hidden until the database has 084.
 */
export function IntegrationsPanel() {
  const params = useSearchParams();
  const [overview, setOverview] = useState<IntegrationOverview | null>(null);
  const [missing084, setMissing084] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [has084, setHas084] = useState<boolean | null>(null);
  const [version, setVersion] = useState(0);
  const { organizations } = useUser();
  const company = organizations.find((org) => org.is_current)?.name ?? null;

  useEffect(() => { let active = true; void databaseHas084().then((value) => { if (active) setHas084(value); }); return () => { active = false; }; }, []);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("integration_overview", { p_provider: "xero" });
    if (error) {
      if (missingDbObject(error)) setMissing084(true);
      else toast.error(friendlyError(error, "Couldn't load the integrations."));
      return;
    }
    setOverview(data as IntegrationOverview);
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => { if (has084) void load(); }, [has084, load]);

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

  if (has084 === null) return <p className="text-sm text-slate-500">Loading…</p>;
  if (missing084 || !has084) return <p className="text-sm text-slate-500" data-testid="integrations-needs-084">{NEEDS_DATABASE_UPDATE}</p>;
  const summary = overview ? overviewSummary(overview) : null;
  const linked = overview ? overview.status === "connected" || overview.status === "needs_reconnect" : false;
  const anySends = overview ? Object.values(overview.counts ?? {}).some((n) => Number(n) > 0) : false;

  return (
    <div className="space-y-6">
      {company ? <p className="text-sm text-slate-600" data-testid="integrations-company">For <strong>{company}</strong>. Each company has its own page: switch company to set up the other.</p> : null}
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
      {overview && linked ? <XeroMappings connected={overview.status === "connected"} unmapped={overview.unmapped ?? []} onChanged={() => void load()} /> : null}
      {overview && (linked || anySends) ? <XeroSendLog reloadKey={version} onChanged={() => void load()} /> : null}
    </div>
  );
}
