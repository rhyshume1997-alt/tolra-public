"use client";

// Platform owner Companies panel (Owner Console, module 12): every company with its people, jobs and invoices, and Close or Reopen for each.
// Inputs: GET /api/platform/companies (counts) and POST /api/platform/companies/status (the route and release 164 do every check). It renders
// NOTHING when the panel is switched off (the route answers 404 to the owner unless PLATFORM_COMPANIES_ENABLED is exactly "true"). Must not change: it never
// deletes anything; Close needs the company's exact name typed, a reason and a fresh authenticator code (the shared code dialog); the screen
// text says plainly what Close does and that Reopen undoes it.

import { useCallback, useEffect, useState } from "react";

import { useCodePrompt } from "@/components/authenticator-code-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type CompanyRow, STATUS_REASON_MAX, STATUS_REASON_MIN } from "@/lib/platform/companies";
import { sendWithCode } from "@/lib/mfa-step-up";

type Body = { error?: string; code?: unknown };
type Load = { state: "loading" } | { state: "off" } | { state: "error" } | { state: "ready"; companies: CompanyRow[] };

export function CompaniesPanel() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { requestCode, codeDialog } = useCodePrompt();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/platform/companies", { cache: "no-store" });
      if (response.status === 404) return setLoad({ state: "off" });
      if (!response.ok) return setLoad({ state: "error" });
      const body = (await response.json().catch(() => null)) as { companies?: CompanyRow[] } | null;
      setLoad(body && Array.isArray(body.companies) ? { state: "ready", companies: body.companies } : { state: "error" });
    } catch {
      setLoad({ state: "error" });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  function toggle(id: string) {
    setOpen(open === id ? null : id);
    setConfirm("");
    setReason("");
    setMessage(null);
  }

  async function change(company: CompanyRow, status: "closed" | "active") {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const send = async () => {
      const response = await fetch("/api/platform/companies/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: company.organizationId, status, confirmName: confirm, reason: reason.trim() }) });
      return { ok: response.ok, status: response.status, body: (await response.json().catch(() => null)) as Body | null };
    };
    try {
      const outcome = await sendWithCode<Body>(send, requestCode);
      if (outcome.result === "cancelled") return setMessage({ ok: false, text: "Cancelled. Nothing was changed." });
      if (outcome.result === "done") {
        setOpen(null);
        setMessage({ ok: true, text: status === "closed" ? `${company.name} is closed. Nothing was deleted. Reopen it here any time.` : `${company.name} is open again.` });
        return void (await refresh());
      }
      setMessage({ ok: false, text: outcome.answer.body?.error || "Couldn't change the company. Nothing was changed." });
    } catch {
      setMessage({ ok: false, text: "Can't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  if (load.state === "off" || load.state === "loading") return null;
  if (load.state === "error") {
    return (
      <Card data-testid="companies-panel"><CardContent className="space-y-2 p-5">
        <p role="alert" className="text-sm text-red-700">Couldn&apos;t load the company counts.</p>
        <Button variant="outline" onClick={() => void refresh()}>Retry</Button>
      </CardContent></Card>
    );
  }

  return (
    <Card data-testid="companies-panel" className="mt-8 border-slate-200">
      <CardHeader><CardTitle>Companies</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-slate-600">People, jobs and invoices per company. Closing a company stops everyone in it signing in. Nothing is deleted, and Reopen puts it back.</p>
        {message ? <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-green-700" : "text-sm text-red-700"}>{message.text}</p> : null}
        <ul className="grid gap-3">
          {load.companies.map((company) => {
            const isOpen = open === company.organizationId;
            const closing = company.status === "active";
            const ready = reason.trim().length >= STATUS_REASON_MIN && (!closing || confirm.trim().length > 0);
            return (
              <li key={company.organizationId} data-company={company.slug} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-slate-950">{company.name} {company.status !== "active" ? <Badge variant="outline" data-testid="company-status">{company.status}</Badge> : null}</p>
                    <p className="text-xs text-slate-500" data-testid="company-counts">
                      {company.people} {company.people === 1 ? "person" : "people"}, {company.jobs} {company.jobs === 1 ? "job" : "jobs"}, {company.invoices} {company.invoices === 1 ? "invoice" : "invoices"} ({company.issuedInvoices} issued)
                    </p>
                  </div>
                  {company.status === "active" || company.status === "closed" ? (
                    <Button variant="outline" disabled={busy} onClick={() => toggle(company.organizationId)} aria-label={`${closing ? "Close" : "Reopen"} ${company.name}`}>
                      {isOpen ? "Cancel" : closing ? "Close" : "Reopen"}
                    </Button>
                  ) : null}
                </div>
                {isOpen ? (
                  <form className="mt-3 grid gap-3 border-t border-slate-100 pt-3" onSubmit={(event) => { event.preventDefault(); if (ready) void change(company, closing ? "closed" : "active"); }}>
                    {closing ? (
                      <>
                        <p className="text-sm text-amber-800" data-testid="close-warning">Everyone in {company.name} will be signed out and locked out until you reopen it. Nothing is deleted.</p>
                        <label className="grid gap-1 text-sm">Type the company&apos;s name ({company.name}) to confirm
                          <Input aria-label="Confirm company name" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} />
                        </label>
                      </>
                    ) : null}
                    <label className="grid gap-1 text-sm">Reason
                      <Input aria-label="Reason" value={reason} maxLength={STATUS_REASON_MAX} onChange={(e) => setReason(e.target.value)} disabled={busy} autoComplete="off" />
                    </label>
                    <Button type="submit" disabled={!ready || busy} className="min-h-11 w-fit">{busy ? "Working..." : closing ? "Close company" : "Reopen company"}</Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
        {codeDialog}
      </CardContent>
    </Card>
  );
}
