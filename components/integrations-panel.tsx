"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { type ConnectStatus, MicrosoftConnectCard, postIntegration } from "@/components/microsoft-connect-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { XeroMappings } from "@/components/xero-mappings";
import { XeroSendLog } from "@/components/xero-send-log";
import { NEEDS_DATABASE_UPDATE, databaseHas084, missingDbObject } from "@/lib/db-features";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { NEEDS_107, cardStatusLabel, connectOutcomeMessage, notSetUpMessage, overviewSummary, type IntegrationOverview } from "@/lib/integrations/overview";
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
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAt: string | null } | null>(null);
  const [openInvites, setOpenInvites] = useState<Array<{ id: string; created_at: string; expires_at: string; created_by_name: string | null }>>([]);
  const [cancelInvite, setCancelInvite] = useState<string | null>(null);
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

  // What the page may offer (107): whether the app details exist for each provider, and whether the database has 107. A failure here
  // leaves Xero as it was (Connect enabled; the route says if it isn't set up) and hides only what needs 107.
  useEffect(() => {
    let active = true;
    void fetch("/api/integrations/status", { credentials: "same-origin" })
      .then(async (res) => (res.ok ? ((await res.json()) as ConnectStatus) : null))
      .catch(() => null)
      .then((value) => { if (active) setStatus(value ?? { db107: false, xero: { configured: true }, microsoft: { configured: false } }); });
    return () => { active = false; };
  }, []);

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
      setTest(null);
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

  const loadInvites = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("integration_invites_open", { p_provider: "xero" });
    if (!error) setOpenInvites((data ?? []) as typeof openInvites);
  }, []);

  useEffect(() => { if (has084 && status?.db107) void loadInvites(); }, [has084, status, loadInvites, version]);

  async function revokeInvite() {
    const id = cancelInvite;
    setCancelInvite(null);
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/integrations/invite?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => null);
      const body = (res ? await res.json().catch(() => ({})) : {}) as { error?: string };
      if (!res?.ok) toast.error(body.error ?? "Couldn't cancel the link. Try again.");
      else toast.success("Link cancelled: it no longer works.");
      setInvite(null);
      await loadInvites();
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setTest(null);
    try {
      const r = await postIntegration("/api/integrations/xero/test");
      setTest(r.ok ? { ok: true, text: String(r.body.message ?? "Working") } : { ok: false, text: r.error });
    } finally {
      setBusy(false);
    }
  }

  async function makeInvite() {
    setBusy(true);
    try {
      const r = await postIntegration("/api/integrations/invite");
      if (!r.ok) toast.error(r.error);
      else if (typeof r.body.url === "string") setInvite({ url: r.body.url, expiresAt: typeof r.body.expiresAt === "string" ? r.body.expiresAt : null });
      await loadInvites();
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      toast.success("Link copied. Send it to the accountant: it works once, for 24 hours.");
    } catch {
      toast.error("Couldn't copy: select the link and copy it.");
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
                <strong>{cardStatusLabel(overview)}</strong>
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
              {status && !status.xero.configured && overview.status !== "connected" ? (
                <p className="text-sm text-slate-600" data-testid="xero-not-set-up">{notSetUpMessage("xero")}{status.xero.problem ? ` ${status.xero.problem}` : ""}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {overview.status !== "connected" ? (
                  <Button onClick={connect} disabled={busy || status?.xero.configured === false}>{overview.status === "needs_reconnect" ? "Connect again" : "Connect to Xero"}</Button>
                ) : null}
                {overview.status === "connected" ? <Button variant="outline" onClick={sendNow} disabled={busy}>Send now</Button> : null}
                {overview.status === "connected" ? <Button variant="outline" onClick={runTest} disabled={busy}>Test</Button> : null}
                {overview.status !== "not_connected" && overview.status !== "disconnected" ? (
                  <Button variant="outline" onClick={() => setConfirmDisconnect(true)} disabled={busy}>Disconnect</Button>
                ) : null}
              </div>
              {test ? <p role={test.ok ? "status" : "alert"} className={`text-sm ${test.ok ? "text-emerald-700" : "text-red-700"}`} data-testid="xero-test-result">{test.text}</p> : null}
              <div className="space-y-2 border-t border-slate-100 pt-3" data-testid="xero-invite">
                <p className="text-sm font-medium text-slate-700">The accountant does the Xero sign-in?</p>
                {status === null ? null : !status.db107 ? (
                  <p className="text-sm text-slate-500" data-testid="xero-invite-needs-107">{NEEDS_107}</p>
                ) : !status.xero.configured ? (
                  <p className="text-sm text-slate-500">{notSetUpMessage("xero")}</p>
                ) : (
                  <>
                    <Button variant="outline" onClick={makeInvite} disabled={busy}>Send the accountant a connect link</Button>
                    {invite ? (
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <input readOnly aria-label="Connect link" value={invite.url} onFocus={(e) => e.currentTarget.select()} className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 font-mono text-xs" data-testid="xero-invite-url" />
                          <Button variant="outline" size="sm" onClick={copyInvite}>Copy</Button>
                        </div>
                        <p className="text-xs text-slate-500">Works once{invite.expiresAt ? `, until ${fmtDate(invite.expiresAt)} (24 hours)` : ", for 24 hours"}. It opens Xero&apos;s sign-in for this company only and gives no access to Tolra.</p>
                      </div>
                    ) : null}
                    {openInvites.length ? (
                      <ul className="space-y-1" data-testid="xero-open-invites">
                        {openInvites.map((i) => (
                          <li key={i.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                            <span>Open link{i.created_by_name ? ` from ${i.created_by_name}` : ""}, made {fmtDateTime(i.created_at)}, expires {fmtDateTime(i.expires_at)}</span>
                            <Button variant="outline" size="sm" onClick={() => setCancelInvite(i.id)} disabled={busy}>Cancel</Button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
              </div>
              <p className="text-xs text-slate-500">
                Each company connects its own Xero organisation. Documents issued before the company connects are never sent.
              </p>
            </>
          )}
        </CardContent>
        <ConfirmDialog
          open={cancelInvite !== null}
          title="Cancel this connect link?"
          description="It stops working at once. Anyone who has it can't use it to connect Xero."
          confirmLabel="Cancel link"
          onConfirm={revokeInvite}
          onCancel={() => setCancelInvite(null)}
        />
        <ConfirmDialog
          open={confirmDisconnect}
          title="Disconnect from Xero?"
          description="Nothing more is sent. Anything queued and not yet sent is dropped (it is never sent to another organisation). Open connect links are cancelled. The send log stays."
          confirmLabel="Disconnect"
          onConfirm={disconnect}
          onCancel={() => setConfirmDisconnect(false)}
        />
      </Card>
      <MicrosoftConnectCard status={status} />
      {overview && linked ? <XeroMappings connected={overview.status === "connected"} unmapped={overview.unmapped ?? []} onChanged={() => void load()} /> : null}
      {overview && (linked || anySends) ? <XeroSendLog reloadKey={version} onChanged={() => void load()} /> : null}
    </div>
  );
}
