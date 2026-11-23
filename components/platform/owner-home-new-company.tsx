"use client";

// Owner Home (module 12): the "New company" dialog. Inputs: open flag and callbacks. Output: one POST to /api/platform/organizations
// (the existing route, which calls platform_create_organization). Starts a BLANK company: no sample data, no e-mail sent; the company's
// own admin then works through the existing 9-step setup guide. Must not change: the route, lib/new-company rules, or add any seed data.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { checkNewCompany, COMPANY_NAME_MAX, COMPANY_SLUG_RULES, slugFromName } from "@/lib/new-company";

const EMPTY = { name: "", slug: "", adminEmail: "", confirmEmail: "" };
type Field = "name" | "slug" | "adminEmail";

export function NewCompanyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (made: { name: string; adminEmail: string }) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: Field | null; message: string } | null>(null);

  async function create() {
    const checked = checkNewCompany(form);
    if (!checked.ok) return setError({ field: checked.field, message: checked.error });
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/platform/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...checked.value, confirmEmail: form.confirmEmail }) });
      const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; field?: Field; code?: string };
      if (response.status === 403 && result.code === "mfa_required") return void window.location.assign("/mfa");
      if (!response.ok || !result.ok) return setError({ field: result.field ?? null, message: result.error || "Couldn't create the company. Try again." });
      setForm(EMPTY);
      setSlugEdited(false);
      onCreated({ name: checked.value.name, adminEmail: checked.value.adminEmail });
    } catch {
      setError({ field: null, message: "Can't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy && !next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription>Starts a blank company with no sample data and its first admin. No e-mail is sent. The admin then works through the setup guide in the company.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            Company name
            <Input aria-label="Company name" value={form.name} maxLength={COMPANY_NAME_MAX} autoComplete="off" className="h-11"
              onChange={(event) => { const name = event.target.value; setForm((c) => ({ ...c, name, slug: slugEdited ? c.slug : slugFromName(name) })); }} />
            {error?.field === "name" ? <span role="alert" className="text-xs font-normal text-red-700">{error.message}</span> : null}
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            Web address (slug)
            <Input aria-label="Slug" value={form.slug} maxLength={48} autoCapitalize="none" spellCheck={false} autoComplete="off" className="h-11"
              onChange={(event) => { setSlugEdited(true); setForm({ ...form, slug: event.target.value.toLowerCase() }); }} />
            <span className="text-xs font-normal text-slate-500">Filled in from the name; change it if you like. {COMPANY_SLUG_RULES} It can&apos;t be changed later.</span>
            {error?.field === "slug" ? <span role="alert" className="text-xs font-normal text-red-700">{error.message}</span> : null}
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            First admin&apos;s e-mail
            <Input aria-label="First admin e-mail" type="email" value={form.adminEmail} maxLength={254} autoCapitalize="none" spellCheck={false} autoComplete="off" className="h-11"
              onChange={(event) => setForm({ ...form, adminEmail: event.target.value })} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            Type the e-mail again
            <Input aria-label="First admin e-mail again" type="email" value={form.confirmEmail} maxLength={254} autoCapitalize="none" spellCheck={false} autoComplete="off" className="h-11"
              onChange={(event) => setForm({ ...form, confirmEmail: event.target.value })} />
            <span className="text-xs font-normal text-slate-500">Check it is exactly right: if this person already has a login, they become the company&apos;s admin at once.</span>
            {error?.field === "adminEmail" ? <span role="alert" className="text-xs font-normal text-red-700">{error.message}</span> : null}
          </label>
          {error && !error.field ? <p role="alert" className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700">{error.message}</p> : null}
          <Button type="submit" disabled={busy} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">{busy ? "Creating..." : "Create company"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
