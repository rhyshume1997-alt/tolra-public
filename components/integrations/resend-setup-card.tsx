"use client";

import { useCallback, useEffect, useState } from "react";

import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SetupCard, type ConnectionTone, type SetupStep } from "@/components/integrations/setup-card";
import { Button } from "@/components/ui/button";
import { sendWithCode } from "@/lib/mfa-step-up";
import { supabase } from "@/lib/supabase";

type Status = { state: "not_configured" | "configured" | "connected" | "error"; message: string; sender: string | null };
type TestAnswer = { ok?: boolean; code?: string; message?: string; error?: string };

const CONNECTION: Record<Status["state"], { tone: ConnectionTone; label: (s: Status) => string }> = {
  not_configured: { tone: "off", label: () => "Not set up on this server" },
  configured: { tone: "working", label: (s) => `Key and sender address are set${s.sender ? ` (${s.sender})` : ""}; the sender domain has not been checked yet` },
  connected: { tone: "ok", label: (s) => `Key accepted and sender domain verified${s.sender ? ` (sending as ${s.sender})` : ""}` },
  error: { tone: "attention", label: (s) => s.message },
};

/**
 * Admin > Integrations > Resend, in the shared SetupCard frame (W-F3). For companies that are not on Microsoft 365. Resend is the SERVER's
 * (the platform owner sets the key and a verified sender domain: not per company, not a mailbox). "Check domain" is the existing read-only
 * test; "Send a test e-mail to me" is the one explicit send: admin only, a recent authenticator code, one to the admin's own address,
 * confirmed in a dialog naming recipient and sender. There is no separate Resend switch: customer e-mails still need approval.
 * `microsoftStatus`: the latest company connection state, shared by the Microsoft card (including errors/reconnection).
 * `microsoftConnected`: compatibility flag for callers that only know a connected/not-connected result.
 * `adminEmail`: the signed-in admin's address if the page already knows it; otherwise read from the browser session.
 */
export function ResendSetupCard({ microsoftConnected = false, microsoftStatus, adminEmail }: { microsoftConnected?: boolean; microsoftStatus?: string | null; adminEmail?: string | null }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { requestCode, codeDialog } = useCodePrompt();
  const email = adminEmail ?? sessionEmail;

  const call = useCallback(async (method: "GET" | "POST") => {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/resend", { method, credentials: "same-origin" }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as Status | null) : null;
      setStatus(body ?? { state: "error", message: "Couldn't check Resend. Try again.", sender: null });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void call("GET"); }, [call]);
  useEffect(() => {
    if (adminEmail || !supabase) return;
    void supabase.auth.getUser().then(({ data }) => setSessionEmail(data?.user?.email ?? null)).catch(() => undefined);
  }, [adminEmail]);

  async function sendTest() {
    setConfirm(false);
    setBusy(true);
    setResult(null);
    try {
      const outcome = await sendWithCode<TestAnswer>(async () => {
        const res = await fetch("/api/integrations/resend/test-send", { method: "POST", credentials: "same-origin" }).catch(() => null);
        const body = res ? ((await res.json().catch(() => null)) as TestAnswer | null) : null;
        return { ok: Boolean(res?.ok), status: res?.status ?? 0, body };
      }, requestCode);
      if (outcome.result === "cancelled") return setResult({ ok: false, text: "Cancelled. Nothing was sent." });
      const { answer } = outcome;
      if (outcome.result === "done") return setResult({ ok: true, text: answer.body?.message ?? "Test e-mail sent. Check your inbox." });
      // A request that never got an answer may or may not have gone: never "nothing was sent".
      setResult({ ok: false, text: answer.status === 0 ? "We could not confirm whether the test e-mail was sent: check your inbox before trying again." : (answer.body?.message ?? answer.body?.error ?? "That didn't work. Nothing was retried.") });
    } finally {
      setBusy(false);
    }
  }

  const state = status?.state ?? null;
  const microsoftInUse = microsoftConnected || microsoftStatus === "connected";
  const microsoftHeld = microsoftStatus === "needs_reconnect";
  const microsoftUnknown = microsoftStatus === null || (microsoftStatus !== undefined && !["connected", "needs_reconnect", "not_connected", "disconnected"].includes(microsoftStatus));
  const ready = state === "configured" || state === "connected";
  const sending = status === null ? "Sending: checking"
    : microsoftInUse ? "Sending: not used while Microsoft 365 is connected"
    : microsoftHeld ? "Sending: paused. Reconnect Microsoft 365; Tolra will not switch to Resend by itself."
    : microsoftUnknown ? "Sending: waiting for the Microsoft 365 connection to be checked"
    : state === "configured" ? "Sending: set up, not yet verified. Check the domain or send a test to yourself. Each message needs a person to send or approve it."
    : state === "connected" ? "Sending: ready (Tolra's verified sender). Each message needs a person to send or approve it. Scheduled reminders and chasing wait in Approvals until a person approves them; a message you send yourself goes out when you click Send." : "Sending: not set up";
  const connection = status ? { tone: CONNECTION[status.state].tone, label: CONNECTION[status.state].label(status) } : { tone: "working" as const, label: "Checking…" };
  const steps: SetupStep[] = [
    { label: "The platform owner puts the Resend key and a verified sender domain on the server", state: ready ? "done" : "next", hint: "Set once for the whole server, not per company. It is a sender address, not a mailbox: nobody signs in and nothing is read." },
    { label: "Check domain", state: state === "connected" ? "done" : ready ? "next" : "later", hint: "Read only: asks Resend whether the key and the sender domain are accepted. Sends nothing." },
    { label: "Send a test e-mail to yourself", state: result?.ok ? "done" : ready ? "next" : "later", hint: "One plain e-mail to your own address, after you confirm. Needs a recent authenticator code." },
  ];

  return (
    <SetupCard
      id="resend"
      title="Resend"
      summary="Sends Tolra's e-mails from the server's verified sender address when this company has no Microsoft 365 mailbox connected."
      connection={connection}
      steps={steps}
      activation={{ label: "Sending", on: null, hideSwitch: true, statusText: sending, help: "No automatic fallback: Resend is only used when no Microsoft 365 mailbox is connected." }}
      footnote="Resend is never used automatically after a Microsoft 365 failure. A test e-mail goes only to your own address and is recorded in the audit log without the address or text."
    >
      {microsoftInUse ? <p className="text-xs text-amber-800" data-testid="resend-ms-note">This company is connected to Microsoft 365, so Resend is not used for it.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || state === "not_configured" || status === null} onClick={() => void call("POST")}>Check domain</Button>
        <Button size="sm" variant="outline" disabled={busy || !ready || !email} onClick={() => setConfirm(true)} data-testid="resend-test-send">Send a test e-mail to me</Button>
      </div>
      {status && state !== "error" ? <p className="text-xs text-slate-600" data-testid="resend-status-message">{status.message}</p> : null}
      {result ? <p role={result.ok ? "status" : "alert"} className={`text-sm ${result.ok ? "text-emerald-700" : "text-red-700"}`} data-testid="resend-test-result">{result.text}</p> : null}
      <ConfirmDialog
        open={confirm}
        title="Send a test e-mail?"
        description={<p data-testid="resend-confirm-text">Tolra will send ONE plain e-mail to <strong>{email}</strong> (your own address) from <strong>{status?.sender ?? "the server's sender address"}</strong> using Resend. It is not retried if the answer is unclear.</p>}
        confirmLabel="Send test e-mail"
        busy={busy}
        onConfirm={() => void sendTest()}
        onCancel={() => setConfirm(false)}
      />
      {codeDialog}
    </SetupCard>
  );
}
