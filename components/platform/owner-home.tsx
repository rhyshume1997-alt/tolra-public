"use client";

// Owner Home (module 12): the platform owner's first screen at /platform, behind PLATFORM_OWNER_HOME_ENABLED (off by default).
// Inputs: GET /api/platform/owner-home (read only). Outputs: calls platform_enter_organization (existing function, needs a reason) and
// opens the New company dialog (existing POST route). While the switch is off, or the read fails to say it is on, the `legacy` page
// is shown exactly as before. Must not change: no AI, no e-mail, no writes of its own; entering stays a read-only support session.

import { Building2, Plus, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { NewCompanyDialog } from "@/components/platform/owner-home-new-company";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/friendly-error";
import type { OwnerHomeCompany, OwnerHomeData } from "@/lib/platform/owner-home/counts";
import { PRODUCT } from "@/lib/product";
import { clockTime } from "@/lib/session-info";
import { supabase } from "@/lib/supabase";

type Load = { state: "loading" } | { state: "off" } | { state: "error"; message: string } | { state: "on"; data: OwnerHomeData };
const HOURS = [1, 2, 4, 8];
const show = (value: number | null) => (value === null ? "–" : String(value));
const when = (value: string | null) => (value ? clockTime(value) : "–");

export function OwnerHomeGate({ legacy, children }: { legacy: ReactNode; children?: ReactNode }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const read = useCallback(async () => {
    try {
      const response = await fetch("/api/platform/owner-home", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as Partial<OwnerHomeData> & { enabled?: boolean; error?: string };
      if (response.status === 403 && (body as { code?: string }).code === "mfa_required") return void window.location.assign("/mfa");
      if (!response.ok) return setLoad({ state: "off" });
      setLoad(body.enabled === true ? { state: "on", data: body as OwnerHomeData } : { state: "off" });
    } catch {
      setLoad({ state: "off" });
    }
  }, []);

  useEffect(() => { void read(); }, [read]);

  if (load.state === "loading") return <main className="min-h-screen bg-slate-50 px-5 py-10"><div className="mx-auto max-w-4xl"><Skeleton className="h-24 w-full" /></div></main>;
  if (load.state !== "on") return <>{legacy}</>;
  return <OwnerHome data={load.data} reload={read}>{children}</OwnerHome>;
}

function OwnerHome({ data, reload, children }: { data: OwnerHomeData; reload: () => Promise<void>; children?: ReactNode }) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; adminEmail: string } | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter(company: OwnerHomeCompany) {
    if (!supabase) return setError("Sign-in isn't available right now. Please contact support.");
    setBusy(true);
    setError(null);
    const { error: enterError } = await supabase.rpc("platform_enter_organization", { p_org: company.organization_id, p_reason: reason, p_hours: hours });
    if (enterError) {
      setBusy(false);
      return setError(friendlyError(enterError, "Couldn't enter that company."));
    }
    window.location.assign("/dashboard");
  }

  async function signOut() {
    try { await supabase?.auth.signOut(); } finally { window.location.assign("/login"); }
  }

  const t = data.totals;
  return (
    <main className="min-h-screen bg-slate-50 px-5 py-10" data-testid="owner-home">
      <div className="mx-auto flex w-full max-w-5xl flex-col">
        <Badge className="w-fit bg-brand text-brand-ink">{PRODUCT.name} platform</Badge>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">Home</h1>
          <Button onClick={() => { setCreated(null); setCreating(true); }} disabled={busy} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover"><Plus className="size-4" />New company</Button>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="owner-metrics">
          <Metric label="Active companies" value={`${t.activeCompanies} of ${t.companies}`} />
          <Metric label="Users" value={String(t.users)} />
          <Metric label="Open issues" value={String(t.openIssues)} />
          <Metric label="Latest activity" value={when(data.latestActivity)} />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {data.fullCounts ? "" : "Jobs, invoices and last activity show a dash until the company counts are connected. "}
          Errors are not recorded here yet.
        </p>

        {created ? (
          <p role="status" data-testid="company-created" className="mt-6 rounded-lg border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800">
            {created.name} is set up with no sample data. {created.adminEmail} becomes its first admin and works through the setup guide.
          </p>
        ) : null}
        {error ? <p role="alert" className="mt-6 rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700">{error}</p> : null}

        <div className="mt-6 grid gap-4" data-testid="owner-company-list">
          {data.companies.length === 0 ? <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">No companies yet. Use New company to start one.</p> : null}
          {data.companies.map((company) => {
            const open = entering === company.organization_id;
            const ready = reason.trim().length >= 5;
            return (
              <Card key={company.organization_id} className="border-slate-200" data-company={company.slug}>
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-ink"><Building2 className="size-5" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-950">{company.name} <Badge variant="outline" className="ml-1 align-middle">{company.status}</Badge></p>
                      <p className="mt-1 text-xs text-slate-500" data-testid="company-counts">
                        Users {show(company.users)} · Jobs {show(company.jobs)} · Invoices {show(company.invoices)} · Open issues {show(company.openIssues)} · Last activity {when(company.lastActivity)}
                      </p>
                    </div>
                    <Button variant="outline" disabled={company.status !== "active" || busy} aria-label={`Enter ${company.name}`}
                      onClick={() => { setEntering(open ? null : company.organization_id); setError(null); }}>
                      {open ? "Cancel" : "Enter company"}
                    </Button>
                  </div>
                  {open ? (
                    <form className="mt-4 grid gap-3 border-t border-slate-100 pt-4" onSubmit={(event) => { event.preventDefault(); if (ready) void enter(company); }}>
                      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                        Why are you entering {company.name}?
                        <Input aria-label="Reason" value={reason} maxLength={500} placeholder="e.g. Helping with the year-end export (ticket 123)" onChange={(event) => setReason(event.target.value)} className="h-11" />
                      </label>
                      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                        Support access lasts
                        <select aria-label="Support access lasts" className="h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
                          {HOURS.map((value) => <option key={value} value={value}>{value} {value === 1 ? "hour" : "hours"}</option>)}
                        </select>
                      </label>
                      <p className="flex items-start gap-2 text-xs text-slate-500"><ShieldAlert className="mt-0.5 size-4 shrink-0" />Read-only. The entry, your reason and any write access you ask for are logged.</p>
                      <Button type="submit" disabled={!ready || busy} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">{busy ? "Entering..." : "Enter"}</Button>
                    </form>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <NewCompanyDialog open={creating} onClose={() => setCreating(false)} onCreated={(made) => { setCreating(false); setCreated(made); void reload(); }} />

        {children}

        <Button variant="ghost" className="mt-6 min-h-11 w-fit text-slate-500" onClick={() => void signOut()}>Sign out</Button>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-950">{value}</p>
    </div>
  );
}
