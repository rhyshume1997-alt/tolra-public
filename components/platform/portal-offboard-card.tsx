"use client";

// Platform owner screen: remove one company's customer-portal links and portal switch. Inputs: the company list the database gives a
// platform owner (platform_list_organizations). Outputs: one POST to /api/platform/portal-offboard (the route and database do every
// check). Must not change: it never deletes a company; the owner types the company's web address to confirm; a stale authenticator
// code is handled by sendWithCode and the shared code dialog.

import { useEffect, useState } from "react";

import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/friendly-error";
import { sendWithCode } from "@/lib/mfa-step-up";
import { OFFBOARD_REASON_MAX } from "@/lib/platform/portal-offboard";
import { supabase } from "@/lib/supabase";

type Company = { organization_id: string; name: string; slug: string };
type Body = { error?: string; code?: unknown; removedLinks?: number; removedSwitch?: boolean };

export function PortalOffboardCard() {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [orgId, setOrgId] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { requestCode, codeDialog } = useCodePrompt();

  useEffect(() => {
    let live = true;
    void (async () => {
      if (!supabase) return setMessage({ ok: false, text: "Sign-in isn't available right now." });
      const { data, error } = await supabase.rpc("platform_list_organizations");
      if (!live) return;
      if (error) return setMessage({ ok: false, text: friendlyError(error, "Couldn't load the companies.") });
      setCompanies((data ?? []) as Company[]);
    })();
    return () => { live = false; };
  }, []);

  const company = companies?.find((c) => c.organization_id === orgId) ?? null;
  const ready = !!company && reason.trim().length > 0 && confirm.trim() === company.slug;

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setMessage(null);
    const send = async () => {
      const response = await fetch("/api/platform/portal-offboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: orgId, reason: reason.trim() }) });
      return { ok: response.ok, status: response.status, body: (await response.json().catch(() => null)) as Body | null };
    };
    try {
      const outcome = await sendWithCode<Body>(send, requestCode);
      if (outcome.result === "cancelled") return setMessage({ ok: false, text: "Cancelled. Nothing was changed." });
      if (outcome.result === "done") {
        const b = outcome.answer.body;
        setReason("");
        setConfirm("");
        return setMessage({ ok: true, text: `Removed ${b?.removedLinks ?? 0} portal link(s)${b?.removedSwitch ? " and the portal switch" : ""}. The company itself was not deleted.` });
      }
      setMessage({ ok: false, text: outcome.answer.body?.error || "Couldn't remove the portal links. Nothing was changed." });
    } catch {
      setMessage({ ok: false, text: "Can't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Remove a company&apos;s customer-portal links</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">Removes this company&apos;s document-to-customer portal links and its portal switch, so the company can be removed later. It does not delete the company, its documents or its customers. Every removal is written to the audit log. You will be asked for a fresh authenticator code.</p>
        <label className="grid gap-1 text-sm">Company
          <select aria-label="Company" className="h-11 rounded-md border px-2" value={orgId} onChange={(e) => { setOrgId(e.target.value); setConfirm(""); }} disabled={busy || !companies}>
            <option value="">Choose a company</option>
            {(companies ?? []).map((c) => <option key={c.organization_id} value={c.organization_id}>{c.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">Reason (no personal data)
          <Input aria-label="Reason" value={reason} maxLength={OFFBOARD_REASON_MAX} onChange={(e) => setReason(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        {company ? (
          <label className="grid gap-1 text-sm">Type the company&apos;s web address ({company.slug}) to confirm
            <Input aria-label="Confirm web address" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </label>
        ) : null}
        <Button disabled={!ready || busy} onClick={() => void submit()} className="min-h-11">{busy ? "Removing..." : "Remove portal links"}</Button>
        {message ? <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-green-700" : "text-sm text-red-700"}>{message.text}</p> : null}
        {codeDialog}
      </CardContent>
    </Card>
  );
}
