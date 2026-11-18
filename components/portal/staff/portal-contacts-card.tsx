"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { sendWithCode } from "@/lib/mfa-step-up";
import { staffRequest } from "./portal-staff-api";

/**
 * BOUNDARY: portal contacts of ONE customer (admin). Input: customerId. Calls only /api/portal/staff/contacts and its revoke route.
 * NOT mounted anywhere (PR6 mounts it). Inviting asks for a fresh authenticator code (sendWithCode). The e-mail, name and reason are
 * sent once and cleared; nothing is logged. Must not call the customer-side portal routes.
 */
type Row = { contactId: string; email: string; displayName: string; permissions: string[]; revokedAt: string | null; liveSessions: number };
type Body = { error?: string; code?: unknown };

export function PortalContactsCard({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [quotes, setQuotes] = useState(true);
  const [jobs, setJobs] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { requestCode, codeDialog } = useCodePrompt();

  const load = useCallback(async () => {
    const a = await staffRequest<Body>("GET", `/api/portal/staff/contacts?customer=${encodeURIComponent(customerId)}`);
    setRows(a.ok && Array.isArray(a.body) ? (a.body as unknown as Row[]) : []);
  }, [customerId]);
  useEffect(() => { void load(); }, [load]);

  async function invite() {
    const permissions = [quotes ? "quotes" : null, jobs ? "jobs" : null].filter(Boolean);
    setBusy(true);
    try {
      const outcome = await sendWithCode<Body>(() => staffRequest<Body>("POST", "/api/portal/staff/contacts", { customerId, email, name, permissions, reason }), requestCode);
      if (outcome.result === "cancelled") return;
      if (outcome.result === "failed") { toast.error(outcome.answer.body?.error ?? "Couldn't invite the contact. Nothing was changed."); return; }
      setEmail(""); setName(""); setReason("");
      toast.success("Contact added. They can ask for a sign-in link on the portal.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(contactId: string) {
    const why = window.prompt("Reason for removing this contact's access");
    if (!why?.trim()) return;
    setBusy(true);
    try {
      const a = await staffRequest<Body>("POST", `/api/portal/staff/contacts/${encodeURIComponent(contactId)}/revoke`, { reason: why });
      if (!a.ok) toast.error(a.body?.error ?? "Couldn't remove the contact. Nothing was changed.");
      else toast.success("Access removed. Their sessions have ended.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portal contacts</CardTitle>
        <CardDescription>People at this customer who can see their quotes and jobs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.contactId} className="flex items-center justify-between gap-2 text-sm">
              <span>{r.displayName} ({r.email}) {r.revokedAt ? "- removed" : `- ${r.permissions.join(", ")}`}</span>
              {!r.revokedAt && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke(r.contactId)}>Remove</Button>}
            </li>
          ))}
        </ul>
        <div className="grid gap-2">
          <Input type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail" aria-label="E-mail" />
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" />
          <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recorded in the audit log)" aria-label="Reason" />
          <label className="text-sm"><input type="checkbox" checked={quotes} onChange={(e) => setQuotes(e.target.checked)} /> Quotes</label>
          <label className="text-sm"><input type="checkbox" checked={jobs} onChange={(e) => setJobs(e.target.checked)} /> Jobs</label>
          <Button type="button" disabled={busy || !email.trim() || !name.trim() || !reason.trim() || (!quotes && !jobs)} onClick={() => void invite()}>Add contact</Button>
        </div>
      </CardContent>
      {codeDialog}
    </Card>
  );
}
