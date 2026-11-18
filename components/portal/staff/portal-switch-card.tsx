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
 * BOUNDARY: customer-portal on/off card (admin). Inputs: nothing. Calls only /api/portal/staff/status. NOT mounted anywhere (PR6 mounts it).
 * Switching on asks for a fresh authenticator code (sendWithCode); switching off never waits for one. The reason is sent once and kept in
 * no state after the call. Must not show or store anything but the switch state.
 */
type StatusBody = { enabled?: boolean; changedAt?: string | null; error?: string; code?: unknown };

export function PortalSwitchCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { requestCode, codeDialog } = useCodePrompt();

  const load = useCallback(async () => {
    const a = await staffRequest<StatusBody>("GET", "/api/portal/staff/status");
    setEnabled(a.ok && typeof a.body?.enabled === "boolean" ? a.body.enabled : null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function change(next: boolean) {
    setBusy(true);
    try {
      const outcome = await sendWithCode<StatusBody>(() => staffRequest<StatusBody>("POST", "/api/portal/staff/status", { enabled: next, reason }), requestCode);
      if (outcome.result === "cancelled") return;
      if (outcome.result === "failed") { toast.error(outcome.answer.body?.error ?? "Couldn't change the portal. Nothing was changed."); return; }
      setReason("");
      setEnabled(next);
      toast.success(next ? "Customer portal switched on." : "Customer portal switched off.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer portal</CardTitle>
        <CardDescription>{enabled === null ? "Not available right now." : enabled ? "On: invited contacts can sign in." : "Off: nobody can sign in to the portal."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recorded in the audit log)" aria-label="Reason" />
        <Button type="button" disabled={busy || enabled === null || reason.trim() === ""} onClick={() => void change(!enabled)}>
          {enabled ? "Switch off" : "Switch on"}
        </Button>
      </CardContent>
      {codeDialog}
    </Card>
  );
}
