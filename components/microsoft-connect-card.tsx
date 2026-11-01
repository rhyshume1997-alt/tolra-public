"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { NEEDS_107, cardStatusLabel, connectCardView, microsoftOutcomeMessage, type IntegrationOverview } from "@/lib/integrations/overview";
import { supabase } from "@/lib/supabase";

export type ConnectStatus = { db107: boolean; xero: { configured: boolean; problem?: string | null }; microsoft: { configured: boolean } };

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
  const view = connectCardView("microsoft", status ? status.microsoft.configured : null);
  const [approve, setApprove] = useState<{ url: string; mailto: string; permissions: Array<{ scope: string; text: string }>; expiresAt: string } | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("integration_overview", { p_provider: "microsoft" });
    if (error) return toast.error(friendlyError(error, "Couldn't load Microsoft 365."));
    setOverview(data as IntegrationOverview);
  }, []);

  useEffect(() => { if (available) void load(); }, [available, load]);

  const outcome = params.get("microsoft");
  // A calm card (never a toast, never red) while Microsoft 365 is not set up yet; "consent_blocked" has its own panel below.
  useEffect(() => {
    if (!outcome || outcome === "consent_blocked" || outcome === "not_configured") return;
    if (outcome === "connected" || outcome === "consent_approved") toast.success(microsoftOutcomeMessage(outcome));
    else toast.error(microsoftOutcomeMessage(outcome));
  }, [outcome]);

  async function makeApproveLink() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/microsoft/admin-consent", { method: "POST", credentials: "same-origin" }).catch(() => null);
      const body = (res ? await res.json().catch(() => ({})) : {}) as { url?: string; mailto?: string; permissions?: Array<{ scope: string; text: string }>; expiresAt?: string; error?: string };
      if (!res?.ok || !body.url || !body.mailto) return toast.error(body.error ?? "Couldn't make the link. Try again.");
      setApprove({ url: body.url, mailto: body.mailto, permissions: body.permissions ?? [], expiresAt: body.expiresAt ?? "" });
    } finally {
      setBusy(false);
    }
  }

  async function copyApprove() {
    if (!approve) return;
    try {
      await navigator.clipboard.writeText(approve.url);
      toast.success("Link copied. Send it to your Microsoft administrator: it works once, for 24 hours.");
    } catch {
      toast.error("Couldn't copy: select the link and copy it.");
    }
  }

  async function connect() {
    if (view.connectDisabled) return;
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
            {view.notSetUp && overview.status !== "connected" ? (
              <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="microsoft-not-set-up">{view.message}</p>
            ) : null}
            {outcome === "consent_approved" && !view.notSetUp ? (
              <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800" data-testid="microsoft-consent-approved">{microsoftOutcomeMessage("consent_approved")}</p>
            ) : null}
            {outcome === "consent_blocked" && view.offerApproveLink ? (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="microsoft-consent-blocked">
                <p><strong>{microsoftOutcomeMessage("consent_blocked")}</strong></p>
                <p>Ask your Microsoft administrator to approve it once. Send them this link: it shows them exactly what Tolra asks for.</p>
                {!approve ? (
                  <Button variant="outline" onClick={makeApproveLink} disabled={busy}>Get the link for your Microsoft admin</Button>
                ) : (
                  <div className="space-y-2" data-testid="microsoft-approve-link">
                    <p>Tolra asks for these permissions only:</p>
                    <ul className="list-disc space-y-0.5 pl-5" data-testid="microsoft-approve-permissions">
                      {approve.permissions.map((p) => <li key={p.scope}>{p.text}</li>)}
                    </ul>
                    <div className="flex flex-wrap items-center gap-2">
                      <input readOnly aria-label="Link for your Microsoft admin" value={approve.url} onFocus={(e) => e.currentTarget.select()} className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 font-mono text-xs text-slate-900" />
                      <Button variant="outline" size="sm" onClick={copyApprove}>Copy link</Button>
                      <a href={approve.mailto} className="inline-flex h-9 items-center rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900">Email it to them</a>
                    </div>
                    <p className="text-xs">Works once{approve.expiresAt ? `, until ${fmtDate(approve.expiresAt)} (24 hours)` : ", for 24 hours"}. After they approve, come back here and click Connect.</p>
                  </div>
                )}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {overview.status !== "connected" ? (
                <Button onClick={connect} disabled={busy || view.connectDisabled}>{overview.status === "needs_reconnect" ? "Connect again" : "Connect Microsoft 365"}</Button>
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
