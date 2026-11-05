"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Status = { state: "not_configured" | "configured" | "connected" | "error"; message: string; sender: string | null };
const LABEL: Record<Status["state"], string> = { not_configured: "Not configured", configured: "Configured", connected: "Connected", error: "Error" };

/** Admin > Integrations > Resend: the status of the server's Resend key and sender address, and a Test (read only: sends nothing). */
export function ResendStatusCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(method: "GET" | "POST") {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/resend", { method, credentials: "same-origin" }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as Status | null) : null;
      setStatus(body ?? { state: "error", message: "Couldn't check Resend. Try again.", sender: null });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void call("GET"); }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resend e-mail</CardTitle>
        <CardDescription>Sends e-mail from the verified sender address when no Microsoft 365 mailbox is connected. Customer e-mails are only sent when someone clicks Send.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {status ? <p><strong>{LABEL[status.state]}</strong>: {status.message}</p> : <p>Checking…</p>}
        <Button size="sm" variant="outline" disabled={busy || status?.state === "not_configured"} onClick={() => void call("POST")}>Test</Button>
      </CardContent>
    </Card>
  );
}
