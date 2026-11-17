"use client";
import { useEffect, useState } from "react";
import { ACCOUNTING_LABELS, type AccountingId, type BalanceEvidence } from "@/lib/accounting/types";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Status = { configured: boolean; status: string; tenantName: string | null };
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept, unmounted, until a real connector exists
function AccountingCloudCard({ provider }: { provider: AccountingId }) {
  const { profile } = useUser();
  const [invoices, setInvoices] = useState<Array<{ id: string; invoice_ref: string }>>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [evidence, setEvidence] = useState<BalanceEvidence | null>(null);
  const path = `/api/accounting/${provider}`;
  async function load() {
    const response = await fetch(`${path}/status`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load this company's accounting connection.");
    setStatus(await response.json());
  }
  useEffect(() => { let active = true; void fetch(`${path}/status`, { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw new Error();
    const next = await r.json(); if (active) setStatus(next);
  }).catch(() => { if (active) setMessage("Could not load this company's accounting connection."); }); return () => { active = false; }; }, [path]);
  async function action(name: "connect" | "disconnect" | "check") {
    setBusy(true); setMessage(""); setEvidence(null);
    try {
      const response = await fetch(`${path}/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(name === "check" ? { invoiceId } : {}) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not complete that action.");
      if (name === "connect") { window.location.assign(body.url); return; }
      if (name === "check") { setEvidence(body.evidence); setMessage(body.evidence ? body.message : "No exact invoice match found. Nothing changed."); }
      else { await load(); setMessage("Disconnected. Nothing changed in Tolra's invoices."); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not complete that action."); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    if (supabase && profile?.organization_id) void supabase.from("invoices").select("id,invoice_ref").eq("organization_id", profile.organization_id).order("created_at", { ascending: false }).limit(100).then(({ data, error }) => {
      if (active && !error) setInvoices((data ?? []).filter((row) => row.invoice_ref));
    });
    return () => { active = false; };
  }, [profile?.organization_id]);
  const connected = status?.status === "connected";
  return <Card>
    <CardHeader><CardTitle>{ACCOUNTING_LABELS[provider]}</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p>{!status ? "Loading connection…" : !status.configured ? "Not set up yet. Connect stays off until the app registration and database update are ready." : connected ? `All connected${status.tenantName ? `: ${status.tenantName}` : ""}` : "Not connected"}</p>
      <p className="text-sm text-slate-500">Read-only payment checks for review. No Tolra invoice is automatically marked paid. No invoices are sent to this service.</p>
      {!connected ? <Button disabled={!status?.configured || busy} onClick={() => void action("connect")}>Connect to {ACCOUNTING_LABELS[provider]}</Button>
        : <>
          <Button variant="outline" disabled={busy} onClick={() => void action("disconnect")}>Disconnect</Button>
          <label className="grid gap-1 text-sm">Invoice to check<select className="rounded border p-2" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}><option value="">Choose an invoice</option>{invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.invoice_ref}</option>)}</select></label>
          <Button disabled={busy || !invoiceId.trim() || !status?.configured} onClick={() => void action("check")}>Check payments</Button>
        </>}
      {evidence ? <p>Invoice {evidence.invoiceNumber}: total £{(evidence.totalPence / 100).toFixed(2)}, outstanding £{(evidence.outstandingPence / 100).toFixed(2)}. Balance evidence only; a credit can also reduce a balance.</p> : null}
      {message ? <p role="status">{message}</p> : null}
    </CardContent>
  </Card>;
}
/**
 * Boundary: Sage and QuickBooks are NOT offered until a real connector exists (they were read-only payment checks only).
 * AccountingCloudCard and the adapters/routes in lib/accounting are kept, unmounted. Do not re-mount without a real connector.
 * Inputs: none. Output: no visible cards, and no /api/accounting/<provider>/status fetch.
 */
export function AccountingCloudCards() {
  const { profile } = useUser();
  return <div className="space-y-6" key={`${profile?.id}:${profile?.organization_id}`}>
    {/* Intentionally empty: no Sage or QuickBooks card is mounted. */}
  </div>;
}
