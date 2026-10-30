"use client";

import { Building2, Plus, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AppCredentialsCard } from "@/components/platform/app-credentials-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/friendly-error";
import { checkNewCompany, COMPANY_NAME_MAX, COMPANY_SLUG_RULES, slugFromName } from "@/lib/new-company";
import { PRODUCT } from "@/lib/product";
import { clockTime } from "@/lib/session-info";
import { supabase } from "@/lib/supabase";

type PlatformCompany = {
  organization_id: string; name: string; slug: string; status: string; active_members: number; own_membership: boolean; support_expires_at: string | null;
};

const HOURS = [1, 2, 4, 8];
const EMPTY_FORM = { name: "", slug: "", adminEmail: "", confirmEmail: "" };
type CreateField = "name" | "slug" | "adminEmail";

/**
 * The platform owner's company list. The database lists every company only for a platform owner (platform_list_organizations
 * refuses anyone else); entering one needs a reason and opens an expiring, read-only support session that is logged.
 */
export default function PlatformPage() {
  const [companies, setCompanies] = useState<PlatformCompany[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(2);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [slugEdited, setSlugEdited] = useState(false);
  const [createError, setCreateError] = useState<{ field: CreateField | null; message: string } | null>(null);
  const [created, setCreated] = useState<{ name: string; adminEmail: string } | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return setError("Sign-in isn't available right now. Please contact support.");
    const { data, error: listError } = await supabase.rpc("platform_list_organizations");
    if (listError) return setError(friendlyError(listError, "Couldn't load the companies."));
    setCompanies((data ?? []) as PlatformCompany[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setSlugEdited(false);
    setCreateError(null);
    setCreating(true);
  }

  function changeName(name: string) {
    setForm((current) => ({ ...current, name, slug: slugEdited ? current.slug : slugFromName(name) }));
  }

  async function createCompany() {
    const checked = checkNewCompany(form);
    if (!checked.ok) return setCreateError({ field: checked.field, message: checked.error });
    setBusy(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/platform/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...checked.value, confirmEmail: form.confirmEmail }) });
      const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; field?: CreateField; code?: string };
      if (response.status === 403 && result.code === "mfa_required") {
        window.location.assign("/mfa");
        return;
      }
      if (!response.ok || !result.ok) {
        setCreateError({ field: result.field ?? null, message: result.error || "Couldn't create the company. Try again." });
        return;
      }
      setCreating(false);
      setCreated({ name: checked.value.name, adminEmail: checked.value.adminEmail });
      await load();
    } catch {
      setCreateError({ field: null, message: "Can't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  async function enter(company: PlatformCompany) {
    if (!supabase) return;
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
    try {
      await supabase?.auth.signOut();
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col">
        <Badge className="w-fit bg-brand text-brand-ink">{PRODUCT.name} platform</Badge>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">Companies</h1>
          <Button onClick={openCreate} disabled={busy} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover"><Plus className="size-4" />New company</Button>
        </div>
        <p className="mt-3 max-w-2xl text-slate-500">
          Entering a company opens a support session: read-only, for the time you choose, with the reason recorded where that company&apos;s administrators can see it.
          Write access is a separate step inside the company.
        </p>

        {created ? (
          <p role="status" data-testid="company-created" className="mt-6 rounded-lg border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800">
            {created.name} is set up. {created.adminEmail} becomes its first admin: straight away if they already have a login, otherwise when their login is created.
          </p>
        ) : null}

        {error ? <p role="alert" className="mt-6 rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700">{error}</p> : null}

        <div className="mt-8 grid gap-4" data-testid="platform-list">
          {companies === null && !error ? <><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></> : null}
          {(companies ?? []).map((company) => {
            const open = entering === company.organization_id;
            const ready = reason.trim().length >= 5;
            return (
              <Card key={company.organization_id} className="border-slate-200" data-company={company.slug}>
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-ink"><Building2 className="size-5" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-950">{company.name}</p>
                      <p className="text-xs text-slate-500">
                        {company.active_members} active {company.active_members === 1 ? "member" : "members"}
                        {company.status !== "active" ? `, ${company.status}` : ""}
                        {company.own_membership ? ", you are a member" : ""}
                        {company.support_expires_at ? `, your support access runs to ${clockTime(company.support_expires_at)}` : ""}
                      </p>
                    </div>
                    <Button variant="outline" disabled={company.status !== "active" || busy} onClick={() => { setEntering(open ? null : company.organization_id); setError(null); }} aria-label={`Enter ${company.name}`}>
                      {open ? "Cancel" : "Enter"}
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
                      <Button type="submit" disabled={!ready || busy} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">{busy ? "Entering..." : "Enter company"}</Button>
                    </form>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>


        <Dialog open={creating} onOpenChange={(open) => { if (!busy) setCreating(open); }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>New company</DialogTitle>
              <DialogDescription>Creates an empty company with its first admin. No e-mail is sent. The company fills in its own details in Settings.</DialogDescription>
            </DialogHeader>
            <form className="grid gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void createCompany(); }}>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Company name
                <Input aria-label="Company name" value={form.name} maxLength={COMPANY_NAME_MAX} onChange={(event) => changeName(event.target.value)} className="h-11" autoComplete="off" />
                {createError?.field === "name" ? <span role="alert" className="text-xs font-normal text-red-700">{createError.message}</span> : null}
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Web address (slug)
                <Input aria-label="Slug" value={form.slug} maxLength={48} onChange={(event) => { setSlugEdited(true); setForm({ ...form, slug: event.target.value.toLowerCase() }); }} className="h-11" autoCapitalize="none" spellCheck={false} autoComplete="off" />
                <span className="text-xs font-normal text-slate-500">Filled in from the name; change it if you like. {COMPANY_SLUG_RULES} It can&apos;t be changed later.</span>
                {createError?.field === "slug" ? <span role="alert" className="text-xs font-normal text-red-700">{createError.message}</span> : null}
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                First admin&apos;s e-mail
                <Input aria-label="First admin e-mail" type="email" value={form.adminEmail} maxLength={254} onChange={(event) => setForm({ ...form, adminEmail: event.target.value })} className="h-11" autoCapitalize="none" spellCheck={false} autoComplete="off" />
                <span className="text-xs font-normal text-slate-500">They get admin access when they sign in with this e-mail. Someone who already has a login is added at once.</span>
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                Type the e-mail again
                <Input aria-label="First admin e-mail again" type="email" value={form.confirmEmail} maxLength={254} onChange={(event) => setForm({ ...form, confirmEmail: event.target.value })} className="h-11" autoCapitalize="none" spellCheck={false} autoComplete="off" />
                <span className="text-xs font-normal text-slate-500">Check it is exactly right: if this person already has a login, they become the company&apos;s admin at once.</span>
                {createError?.field === "adminEmail" ? <span role="alert" className="text-xs font-normal text-red-700">{createError.message}</span> : null}
              </label>
              {createError && !createError.field ? <p role="alert" className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700">{createError.message}</p> : null}
              <Button type="submit" disabled={busy} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">{busy ? "Creating..." : "Create company"}</Button>
            </form>
          </DialogContent>
        </Dialog>

        <AppCredentialsCard />

        <Button variant="ghost" className="mt-6 min-h-11 w-fit text-slate-500" onClick={() => void signOut()}>Sign out</Button>
      </div>
    </main>
  );
}
