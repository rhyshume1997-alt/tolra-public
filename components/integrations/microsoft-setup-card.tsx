"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { SetupCard, type ConnectionTone, type SetupStep } from "@/components/integrations/setup-card";
import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { postIntegration, type ConnectStatus } from "@/components/microsoft-connect-card";
import { postIntegrationWithCode } from "@/lib/integrations/post-with-code";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { ADMIN_CONSENT_STATEMENT, NEEDS_107, connectCardView, microsoftOutcomeMessage, type IntegrationOverview } from "@/lib/integrations/overview";
import { supabase } from "@/lib/supabase";

type Approve = { url: string; mailto: string; permissions: Array<{ scope: string; text: string }>; expiresAt: string };

/**
 * Admin > Integrations > Microsoft 365, in the shared SetupCard frame (W-F3). The same delegated sign-in as components/microsoft-connect-card.tsx
 * (which is unchanged and not rendered here) and the same routes: /api/integrations/microsoft/{connect,callback,admin-consent,test,disconnect}.
 * Connected means signed in; it does not send anything by itself. The Sending row is NOT a switch (the server has none): it states the rule.
 * One mailbox per company; no automatic fallback to Resend. `status` is the page's /api/integrations status answer, as for the old card.
 */
export function MicrosoftSetupCard({ status }: { status: ConnectStatus | null }) {
  const params = useSearchParams();
  const outcome = params.get("microsoft");
  const [overview, setOverview] = useState<IntegrationOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [approve, setApprove] = useState<Approve | null>(null);
  const { requestCode, codeDialog } = useCodePrompt();
  const available = status?.db107 === true;
  const view = connectCardView("microsoft", status ? status.microsoft.configured : null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("integration_overview", { p_provider: "microsoft" });
    if (error) return toast.error(friendlyError(error, "Couldn't load Microsoft 365."));
    setOverview(data as IntegrationOverview);
  }, []);
  useEffect(() => { if (available) void load(); }, [available, load]);

  async function run(path: string, onOk: (body: Record<string, unknown>) => void) {
    setBusy(true);
    try {
      const r = await postIntegrationWithCode(path, requestCode);
      if (!r.ok) toast.error(r.error); else onOk(r.body);
    } finally {
      setBusy(false);
    }
  }
  const connect = () => view.connectDisabled ? undefined : run("/api/integrations/microsoft/connect", (b) => { if (typeof b.url === "string") window.location.assign(b.url); });
  const disconnect = async () => { setConfirm(false); await run("/api/integrations/microsoft/disconnect", () => toast.success("Disconnected from Microsoft 365. Tolra sends no mail as that mailbox.")); setTest(null); await load(); };
  async function runTest() {
    setBusy(true); setTest(null);
    try {
      const r = await postIntegration("/api/integrations/microsoft/test");
      setTest(r.ok ? { ok: true, text: String(r.body.message ?? "Working") } : { ok: false, text: r.error });
    } finally { setBusy(false); }
  }
  async function makeLink() {
    setBusy(true);
    try {
      const r = await postIntegrationWithCode("/api/integrations/microsoft/admin-consent", requestCode);
      const body = (r.ok ? r.body : { error: r.error }) as Partial<Approve> & { error?: string };
      if (!r.ok || !body.url || !body.mailto) return toast.error(body.error ?? "Couldn't make the link. Try again.");
      setApprove({ url: body.url, mailto: body.mailto, permissions: body.permissions ?? [], expiresAt: body.expiresAt ?? "" });
    } finally { setBusy(false); }
  }

  const connected = overview?.status === "connected";
  const reconnect = overview?.status === "needs_reconnect";
  let connection: { tone: ConnectionTone; label: string };
  if (status === null) connection = { tone: "working", label: "Checking…" };
  else if (!available) connection = { tone: "off", label: NEEDS_107 };
  else if (view.notSetUp) connection = { tone: "off", label: "Not set up on this server" };
  else if (!overview) connection = { tone: "working", label: "Checking…" };
  else if (connected) connection = { tone: "ok", label: `Signed in as ${overview.tenant_name ?? "the company mailbox"}${overview.connected_at ? ` since ${fmtDate(overview.connected_at)}` : ""}` };
  else if (reconnect) connection = { tone: "attention", label: `Needs reconnecting${overview.tenant_name ? ` (${overview.tenant_name})` : ""}` };
  else connection = { tone: "off", label: "Not connected" };

  const tested = test?.ok === true;
  const steps: SetupStep[] = [
    { label: "Connect with your Microsoft work account", state: connected ? "done" : "next", hint: "Someone who owns the company mailbox signs in at Microsoft and approves. Admins only, with a confirmed authenticator code." },
    { label: "Test", state: tested ? "done" : connected ? "next" : "later", hint: "Asks Microsoft who is signed in now. Sends no e-mail." },
    { label: "E-mails go out from this mailbox once a person sends or approves them", state: connected && tested ? "done" : "later", hint: "Nothing is sent without a person: they click Send, or the message waits as a draft in Approvals." },
  ];
  const blocked = outcome === "consent_blocked" && view.offerApproveLink;

  return (
    <>
      {codeDialog}
      <SetupCard
        id="microsoft"
        title="Microsoft 365"
        summary="Send Tolra's e-mails from this company's own Microsoft 365 mailbox, and read its inbox into RFQs (read only)."
        connection={connection}
        steps={steps}
        activation={{
          label: "Sending",
          on: !overview ? null : connected,
          help: "Uses this mailbox once connected; every customer e-mail still needs approval.",
          disabledReason: "There is no separate switch: sending uses this mailbox as soon as it is connected, and a person still sends or approves each customer e-mail. Disconnect to stop.",
        }}
        footnote="If Microsoft 365 fails, Tolra does not switch to Resend by itself: the message stays unsent until someone resolves it."
      >
        <p className="text-xs text-slate-600" data-testid="microsoft-one-mailbox">One mailbox per company: this company&apos;s mailbox is never shared with another company.</p>
        {reconnect ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{overview?.status_reason ?? "Microsoft 365 needs to be connected again."}</p> : null}
        {outcome && outcome !== "consent_blocked" && outcome !== "not_configured" ? <p role="status" className="text-xs text-slate-600" data-testid="microsoft-outcome">{microsoftOutcomeMessage(outcome)}</p> : null}
        {available && !view.notSetUp ? (
          <div className="rounded-md border border-slate-200 p-3 text-xs text-slate-700" data-testid="microsoft-admin-approval">
            <p><strong>If Microsoft says an administrator must approve first:</strong> your Microsoft administrator approves Tolra once. You can get a one-time link to send them (it shows exactly what Tolra asks for, and works for 24 hours).</p>
            {blocked ? <p className="mt-1 text-amber-900" data-testid="microsoft-consent-blocked">{microsoftOutcomeMessage("consent_blocked")}</p> : null}
            {!approve ? (
              <Button className="mt-2" variant="outline" size="sm" onClick={makeLink} disabled={busy}>Get the link for your Microsoft admin</Button>
            ) : (
              <div className="mt-2 space-y-2" data-testid="microsoft-approve-link">
                <p>{ADMIN_CONSENT_STATEMENT}</p>
                <ul className="list-disc pl-5">{approve.permissions.map((p) => <li key={p.scope}>{p.text}</li>)}</ul>
                <input readOnly aria-label="Link for your Microsoft admin" value={approve.url} onFocus={(e) => e.currentTarget.select()} className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 font-mono text-xs" />
                <a href={approve.mailto} className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-xs">Email it to them</a>
                <p>After they approve, come back here and connect.</p>
              </div>
            )}
          </div>
        ) : null}
        {available ? (
          <div className="flex flex-wrap gap-2">
            {!connected ? <Button onClick={() => void connect()} disabled={busy || view.connectDisabled || !overview}>{reconnect ? "Reconnect" : "Connect Microsoft 365"}</Button> : null}
            {connected ? <Button variant="outline" onClick={() => void runTest()} disabled={busy}>Test</Button> : null}
            {connected || reconnect ? <Button variant="outline" onClick={() => setConfirm(true)} disabled={busy}>Disconnect</Button> : null}
          </div>
        ) : null}
        {test ? <p role={test.ok ? "status" : "alert"} className={`text-sm ${test.ok ? "text-emerald-700" : "text-red-700"}`} data-testid="microsoft-test-result">{test.text}</p> : null}
      </SetupCard>
      <ConfirmDialog open={confirm} title="Disconnect Microsoft 365?" description="Tolra stops sending as this mailbox at once (its stored sign-in is deleted). You can connect again at any time." confirmLabel="Disconnect" onConfirm={() => void disconnect()} onCancel={() => setConfirm(false)} />
    </>
  );
}
