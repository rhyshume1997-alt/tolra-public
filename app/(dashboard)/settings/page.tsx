"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Archive, Building2, Columns3, FileArchive, ImageUp, LayoutList, Mail, Trash2, Workflow } from "lucide-react";

import { AiHelperSettingsCard } from "@/components/ai-helper/settings-card";
import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { validateBankDetails } from "@/lib/bank-details";
import { auditEvent } from "@/lib/audit";
import { type DayHours, defaultInvoiceMessage, isOwnLogoPath, LOGO_BUCKET, saveCompanyProfile as persistCompanyProfile, storedProfile, useCompanyProfile } from "@/lib/company";
import { companyFormToHydrate, EMPTY_COMPANY, workingHoursFromForm, type CompanyForm } from "@/lib/company-form";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useSaving } from "@/lib/use-saving";
import { useUser } from "@/lib/use-user";
import { hexOr, isHexColour, PRODUCT_BRANDING, textOn } from "@/lib/branding";
import { NAV_TOGGLES, resetHiddenColumns, saveOrgSettings, screensByGroup, setColumnHidden, setItemShown, setNavHidden, shownCount, type SaveResult, useOrgSettings } from "@/lib/org-settings";
import { PRODUCT } from "@/lib/product";
import { WEEKDAY_OPTIONS } from "@/lib/machine-schedule";
import { BREAK_MINUTES, LUNCH_MINUTES, MIN_DAY_HOURS, formatHoursMinutes, paidDay, paidWeek } from "@/lib/working-hours";
import { TimeSettingsCard } from "@/components/time/time-settings-card";
import { SiteNetworkCard } from "@/components/time/site-network-card";

const navSections = Array.from(new Set(NAV_TOGGLES.map((item) => item.section)));

function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${checked ? "bg-brand" : "bg-slate-300"}`}>
      <span className={`inline-block size-5 rounded-full bg-white shadow transition ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };
const LOGO_MAX_BYTES = 1024 * 1024;

function CompanyDetailsCard() {
  const { profile, loading } = useCompanyProfile();
  const { organizations } = useUser();
  const currentSlug = organizations.find((org) => org.is_current)?.slug ?? "";
  const [origin, setOrigin] = useState("");
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const { saving, run } = useSaving();
  const [form, setForm] = useState<CompanyForm>(EMPTY_COMPANY);
  const [hydrated, setHydrated] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Points the profile at `nextPath` (or no logo when empty), then deletes the previous file of this organisation. */
  async function replaceLogo(organizationId: string, nextPath: string) {
    if (!supabase || !profile) throw new Error("Save the company details first.");
    const previous = profile.logoPath;
    await persistCompanyProfile(organizationId, { ...storedProfile(profile), logoPath: nextPath });
    setForm((current) => ({ ...current, logoPath: nextPath }));
    if (previous && previous !== nextPath && isOwnLogoPath(organizationId, previous)) {
      const { error } = await supabase.storage.from(LOGO_BUCKET).remove([previous]);
      if (error) console.error("[settings] old logo not removed", error);
    }
  }

  async function uploadLogo(file: File) {
    const ext = LOGO_TYPES[file.type];
    if (!ext) { toast.error("Upload a PNG or JPG image."); return; }
    if (file.size > LOGO_MAX_BYTES) { toast.error("The logo must be 1 MB or smaller."); return; }
    if (!profile) { toast.error("Save the company details first, then upload the logo."); return; }
    setLogoBusy(true);
    let uploaded: string | null = null;
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const organizationId = await getCurrentOrganizationId();
      const path = `${organizationId}/logo-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from(LOGO_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw error;
      uploaded = path;
      await replaceLogo(organizationId, path);
      uploaded = null;
      void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", metadata: { section: "company_logo", change: "upload" } });
      toast.success("Logo uploaded. It now prints on your documents.");
    } catch (err) {
      if (uploaded && supabase) void supabase.storage.from(LOGO_BUCKET).remove([uploaded]);
      toast.error(friendlyError(err, "Couldn't upload the logo. Try again."));
    } finally {
      setLogoBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removeLogo() {
    setLogoBusy(true);
    try {
      await replaceLogo(await getCurrentOrganizationId(), "");
      void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", metadata: { section: "company_logo", change: "remove" } });
      toast.success("Logo removed. Documents now print the company name instead.");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't remove the logo. Try again."));
    } finally {
      setLogoBusy(false);
    }
  }

  // The form is editable only once the profile has been loaded into it (`ready`), so nothing typed can be overwritten by the hydrate.
  useEffect(() => {
    const next = companyFormToHydrate(loading, hydrated, profile);
    if (next) {
      setForm(next);
      setHydrated(true);
    }
  }, [hydrated, loading, profile]);
  const ready = hydrated;
  const week = paidWeek(form.workDays.map((day) => form.workHours[day]));

  const set = (key: Exclude<keyof CompanyForm, "vatRegistered" | "brandedLogin" | "loginStyle" | "showCreditsInBalance" | "workDays" | "workHours" | "bank">) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));

  function save() {
    const documentName = form.documentName.trim();
    const addressLines = lines(form.addressLines);
    const vatNumber = form.vatNumber.trim();
    if (!documentName) { toast.error("Enter the company name as it should appear on documents."); return; }
    if (!addressLines.length) { toast.error("Enter at least one address line."); return; }
    for (const [label, value] of [["Brand colour", form.brandPrimary], ["Accent colour", form.brandAccent]] as const) {
      if (value.trim() && !isHexColour(value.trim())) { toast.error(`${label} must look like #1e3472.`); return; }
    }
    if (form.vatRegistered && !vatNumber) { toast.error("Enter your VAT number, or switch off VAT registered."); return; }
    const defaultVatRate = Number(form.defaultVatRate);
    if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) { toast.error("Enter a valid company email address."); return; }
    const hoursToSave = workingHoursFromForm(form);
    if ("error" in hoursToSave) { toast.error(hoursToSave.error); return; }
    const bankCheck = validateBankDetails(form.bank);
    if (bankCheck.errors.length) { toast.error(bankCheck.errors[0]); return; }
    const next = {
      key: profile?.key ?? "org",
      name: form.name.trim() || documentName,
      documentName,
      addressLines,
      phone: form.phone.trim(),
      fax: form.fax.trim(),
      email: form.email.trim(),
      website: form.website.trim(),
      vatNumber,
      vatRegistered: form.vatRegistered,
      defaultVatRate: Number.isFinite(defaultVatRate) ? defaultVatRate : 20,
      brandPrimary: isHexColour(form.brandPrimary) ? form.brandPrimary.toLowerCase() : "",
      brandAccent: isHexColour(form.brandAccent) ? form.brandAccent.toLowerCase() : "",
      loginTagline: form.loginTagline.trim().slice(0, 120),
      brandedLogin: form.brandedLogin,
      loginStyle: form.loginStyle,
      loginEyebrow: form.loginEyebrow.trim().slice(0, 80),
      appIconPath: profile?.appIconPath ?? "",
      logoPath: profile?.logoPath ?? "",
      defaultQuoteTerms: form.defaultQuoteTerms.trim(),
      defaultInvoiceTerms: form.defaultInvoiceTerms.trim(),
      defaultCustomerMessage: lines(form.defaultCustomerMessage),
      defaultInvoiceMessage: lines(form.defaultInvoiceMessage),
      bankDetails: bankCheck.bank,
      showCreditsInBalance: form.showCreditsInBalance,
      ...hoursToSave.fields,
    };
    void run(async () => {
      try {
        await persistCompanyProfile(await getCurrentOrganizationId(), next);
        void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", metadata: { section: "company_profile" } });
        toast.success("Company details saved");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't save company details. Try again."));
      }
    });
  }

  const bankField = (label: string, key: keyof CompanyForm["bank"], props: React.ComponentProps<typeof Input> = {}) => (
    <div><label htmlFor={`bank-${key}`} className="text-sm font-semibold text-slate-700">{label}</label><Input id={`bank-${key}`} className="mt-2" value={form.bank[key]} onChange={(event) => setForm((current) => ({ ...current, bank: { ...current.bank, [key]: event.target.value } }))} {...props} /></div>
  );

  type TextKey = Exclude<keyof CompanyForm, "vatRegistered" | "brandedLogin" | "loginStyle" | "showCreditsInBalance" | "workDays" | "workHours" | "bank">;
  const field = (label: string, key: TextKey, props: React.ComponentProps<typeof Input> = {}) => (
    <div><label htmlFor={`company-${key}`} className="text-sm font-semibold text-slate-700">{label}</label><Input id={`company-${key}`} className="mt-2" value={form[key]} onChange={set(key)} {...props} /></div>
  );

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Building2 className="size-5 text-brand-accent" /> Company details</CardTitle></CardHeader>
      <CardContent>
       <fieldset disabled={!ready} aria-busy={!ready} data-testid="company-details-form" data-loaded={ready ? "true" : "false"} className="m-0 min-w-0 space-y-4 border-0 p-0">
        <p className="text-sm text-slate-500">These details print on every quote, invoice and delivery note. Documents can&apos;t be generated until the company name and address (and the VAT number, when VAT registered) are set.</p>
        {!loading && !profile ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Company details haven&apos;t been set up yet.</div> : null}
        <div className="grid gap-4 md:grid-cols-2">
          {field("Trading name", "name", { placeholder: "Shown in the app" })}
          {field("Name on documents *", "documentName", { placeholder: "As printed on documents" })}
        </div>
        <div><label htmlFor="company-addressLines" className="text-sm font-semibold text-slate-700">Address (one line per row) *</label><Textarea id="company-addressLines" className="mt-2" rows={4} value={form.addressLines} onChange={set("addressLines")} /></div>
        <div className="grid gap-4 md:grid-cols-3">
          {field("Phone", "phone", { type: "tel", inputMode: "tel", autoComplete: "tel" })}
          {field("Fax", "fax", { type: "tel", inputMode: "tel" })}
          {field("Email", "email", { type: "email", inputMode: "email" })}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {field("Website", "website")}
          {field(form.vatRegistered ? "VAT number *" : "VAT number", "vatNumber")}
        </div>
        <div className="grid gap-4 rounded-lg border p-3 md:grid-cols-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">VAT registered</p>
              <p className="text-xs text-slate-500">Off: no quote, invoice, sales order or PO gets VAT, and no VAT number is printed.</p>
            </div>
            <Switch checked={form.vatRegistered} onChange={(checked) => setForm((current) => ({ ...current, vatRegistered: checked }))} label="VAT registered" />
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700" htmlFor="default-vat-rate">Default VAT rate</label>
            <select id="default-vat-rate" className="mt-2 h-10 w-full rounded-lg border px-3 text-sm disabled:opacity-50" disabled={!form.vatRegistered}
              value={form.defaultVatRate} onChange={(event) => setForm((current) => ({ ...current, defaultVatRate: event.target.value }))}>
              <option value="20">20% (standard)</option>
              <option value="5">5% (reduced)</option>
              <option value="0">0% (zero rated)</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">New document lines and carriage start at this rate. Each line can be changed.</p>
          </div>
        </div>
        <div>
          <label className="text-sm font-semibold text-slate-700">Logo on documents</label>
          <div className="mt-2 flex flex-wrap items-center gap-4 rounded-lg border p-3">
            <div className="flex h-24 w-36 items-center justify-center rounded border bg-white">
              {profile?.logoSrc
                ? <Image src={profile.logoSrc} alt="Company logo" width={144} height={96} unoptimized className="max-h-24 w-auto object-contain" />
                : <span className="px-2 text-center text-xs text-slate-500">No logo. Documents print the company name.</span>}
            </div>
            <div className="space-y-2">
              <input ref={fileInput} type="file" accept="image/png,image/jpeg" className="hidden" aria-label="Logo file"
                onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadLogo(file); }} />
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={logoBusy || loading || !profile} onClick={() => fileInput.current?.click()}>
                  <ImageUp className="size-4" /> {logoBusy ? "Working..." : profile?.logoPath ? "Replace logo" : "Upload logo"}
                </Button>
                {profile?.logoPath ? (
                  <Button type="button" variant="outline" className="text-red-700" disabled={logoBusy} onClick={() => void removeLogo()}>
                    <Trash2 className="size-4" /> Remove
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">PNG or JPG, up to 1 MB. Printed top right on quotes, invoices, purchase orders and delivery notes. Only this company can see it.</p>
            </div>
          </div>
        </div>
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">Sign-in page branding</p>
              <p className="text-xs text-slate-500">Show your logo, colours and tagline on your own sign-in link. Off: the link shows the neutral {PRODUCT.name} page and nothing about your company.</p>
            </div>
            <Switch checked={form.brandedLogin} onChange={(checked) => setForm((current) => ({ ...current, brandedLogin: checked }))} label="Branded sign-in page" />
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_1fr_2fr]">
            {([["Brand colour", "brandPrimary", PRODUCT_BRANDING.primary], ["Accent colour", "brandAccent", PRODUCT_BRANDING.accent]] as const).map(([label, key, fallback]) => (
              <div key={key}>
                <label className="text-sm font-semibold text-slate-700" htmlFor={`colour-${key}`}>{label}</label>
                <div className="mt-2 flex items-center gap-2">
                  <input id={`colour-${key}`} type="color" aria-label={`${label} picker`} className="h-10 w-12 cursor-pointer rounded border"
                    value={isHexColour(form[key]) ? form[key] : fallback} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />
                  <Input value={form[key]} placeholder={fallback} maxLength={7} onChange={set(key)} aria-label={`${label} hex`} />
                </div>
              </div>
            ))}
            {field("Sign-in tagline", "loginTagline", { placeholder: "Precision CNC machining since 1998", maxLength: 120 })}
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
            <div>
              <label className="text-sm font-semibold text-slate-700" htmlFor="login-style">Sign-in style</label>
              <select id="login-style" className="mt-2 h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm"
                value={form.loginStyle} onChange={(event) => setForm((current) => ({ ...current, loginStyle: event.target.value === "dark" ? "dark" : "light" }))}>
                <option value="light">Light</option>
                <option value="dark">Dark, website style</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">Dark: your brand colour as the page, the tagline as a large headline.</p>
            </div>
            {field("Eyebrow line (dark style)", "loginEyebrow", { placeholder: "CNC machining and fabrication, Hamilton", maxLength: 80 })}
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg p-3 text-sm" style={{ background: `linear-gradient(120deg, ${hexOr(form.brandPrimary, PRODUCT_BRANDING.primary)}, ${hexOr(form.brandAccent, PRODUCT_BRANDING.accent)})`, color: textOn(hexOr(form.brandPrimary, PRODUCT_BRANDING.primary)) }}>
            <span className="font-semibold">{form.name || form.documentName || "Your company"}</span>
            <span className="opacity-80">{form.loginTagline || PRODUCT_BRANDING.tagline}</span>
          </div>
          {currentSlug ? (
            <p className="text-xs text-slate-500">
              Your sign-in link: <code className="rounded bg-slate-100 px-1">{origin}/login?org={currentSlug}</code>
              {form.brandedLogin ? "" : " (switch branding on and save to use it)"}
            </p>
          ) : null}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {field("Default quote terms", "defaultQuoteTerms", { placeholder: "Valid for 30 days" })}
          {field("Default invoice terms", "defaultInvoiceTerms", { placeholder: "30 days" })}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div><label htmlFor="quote-message" className="text-sm font-semibold text-slate-700">Quote message (one line per row)</label><Textarea id="quote-message" className="mt-2" rows={4} value={form.defaultCustomerMessage} onChange={set("defaultCustomerMessage")} /><p className="mt-1 text-xs text-slate-500">Printed at the foot of new quotes.</p></div>
          <div><label htmlFor="invoice-message" className="text-sm font-semibold text-slate-700">Invoice message (one line per row)</label><Textarea id="invoice-message" className="mt-2" rows={4} value={form.defaultInvoiceMessage} onChange={set("defaultInvoiceMessage")} placeholder={defaultInvoiceMessage(form.defaultInvoiceTerms).join("\n")} /><p className="mt-1 text-xs text-slate-500">Printed at the foot of new invoices. It starts filled with the standard wording, built from your default invoice terms (30 days if they give no number of days): edit it to change it. If you clear it, the standard wording is still used. Invoices already issued keep the wording they were issued with.</p></div>
        </div>
        <fieldset className="space-y-3 rounded-lg border p-3" data-testid="bank-details">
          <legend className="px-1 text-sm font-semibold text-slate-700">Bank details (printed on invoices)</legend>
          <p className="text-xs text-slate-500">Printed in a &quot;Payment details&quot; block on invoices only, never on quotes. Only the boxes you fill in are printed; leave them all empty to print nothing. Invoices already issued print the bank details set here today.</p>
          <div className="grid gap-4 md:grid-cols-2">
            {bankField("Account name", "accountName", { autoComplete: "off" })}
            {bankField("Bank name", "bankName", { autoComplete: "off" })}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {bankField("Sort code", "sortCode", { inputMode: "numeric", placeholder: "12-34-56", maxLength: 10, autoComplete: "off" })}
            {bankField("Account number", "accountNumber", { inputMode: "numeric", placeholder: "8 digits", maxLength: 12, autoComplete: "off" })}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {bankField("IBAN (optional)", "iban", { autoComplete: "off" })}
            {bankField("BIC (optional)", "bic", { autoComplete: "off" })}
          </div>
        </fieldset>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" checked={form.showCreditsInBalance} onChange={(event) => setForm((current) => ({ ...current, showCreditsInBalance: event.target.checked }))} />
          <span><span className="font-semibold">Show credit notes in Balance due on invoice PDFs</span><span className="block text-xs text-slate-500">Off: an invoice PDF is exactly as approved and ignores credit notes. On: Balance due is the total less payments and less the credit notes applied, with one &quot;Less credit notes&quot; line added beside the invoice number. Applies when a PDF is made, so an invoice reprinted after a credit shows it.</span></span>
        </label>
        <fieldset className="space-y-3 rounded-lg border p-3" data-testid="working-hours">
          <legend className="px-1 text-sm font-semibold text-slate-700">Working hours</legend>
          <p className="text-xs text-slate-500">Your normal working hours, day by day. On the schedule, a booking split by day shows each day&apos;s time as basic (inside that day&apos;s hours) or out of hours. It is only a label: any time can still be booked, and nothing works out pay.</p>
          <div className="grid gap-2" data-testid="working-hours-days">
            {WEEKDAY_OPTIONS.map((option) => {
              const iso = option.dow === 0 ? 7 : option.dow;
              const works = form.workDays.includes(iso);
              const day = form.workHours[iso];
              const paid = works ? paidDay(day.start, day.end) : null;
              const setDay = (patch: Partial<DayHours>) => setForm((current) => ({ ...current, workHours: { ...current.workHours, [iso]: { ...current.workHours[iso], ...patch } } }));
              return (
                <div key={iso} className="grid grid-cols-2 items-end gap-x-3 gap-y-2 rounded-lg border p-3 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_6.5rem]" data-testid="working-hours-day">
                  <label className="col-span-2 flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700 sm:col-span-1">
                    <input type="checkbox" className="size-5" checked={works}
                      onChange={(event) => setForm((current) => ({ ...current, workDays: event.target.checked ? [...current.workDays.filter((d) => d !== iso), iso] : current.workDays.filter((d) => d !== iso) }))} />
                    {option.label}
                    <span className="whitespace-nowrap font-normal text-slate-500">Works</span>
                  </label>
                  <label className="grid min-w-0 gap-1 text-xs font-medium text-slate-600">Start
                    <Input type="time" aria-label={`${option.label} start`} className="h-11" disabled={!works} value={day.start} onChange={(event) => setDay({ start: event.target.value })} />
                  </label>
                  <label className="grid min-w-0 gap-1 text-xs font-medium text-slate-600">Finish
                    <Input type="time" aria-label={`${option.label} finish`} className="h-11" disabled={!works} value={day.end} onChange={(event) => setDay({ end: event.target.value })} />
                  </label>
                  <p className="col-span-2 flex min-h-11 items-center text-sm font-semibold text-slate-800 sm:col-span-1 sm:justify-end" data-testid="working-hours-day-paid">
                    {!works ? <span className="font-normal text-slate-400">Not worked</span> : paid ? <>Paid {formatHoursMinutes(paid.paid)}</> : <span className="font-normal text-amber-800">Check times</span>}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-800" data-testid="working-hours-week">
            <p className="font-semibold">
              Week: <span data-testid="working-hours-week-at-work">{formatHoursMinutes(week.atWork)}</span> at work,{" "}
              <span data-testid="working-hours-week-breaks">{formatHoursMinutes(week.breaks)}</span> breaks,{" "}
              <span data-testid="working-hours-week-paid">{formatHoursMinutes(week.paid)}</span> paid
            </p>
            <p className="mt-1 text-xs text-slate-500">Paid hours, breaks unpaid. Pay comes from clock in and out. On a day of {MIN_DAY_HOURS} hours or more at work, {LUNCH_MINUTES} minutes for lunch and {BREAK_MINUTES} minutes for a break come off; on a shorter day nothing does.</p>
          </div>
          <p className="text-xs text-slate-500">A finish of 00:00 means midnight.</p>
        </fieldset>
        <Button className="bg-brand text-brand-ink" disabled={saving || !ready} onClick={save}>{saving ? "Saving..." : "Save company details"}</Button>
       </fieldset>
      </CardContent>
    </Card>
  );
}

function WorkshopEmailCard() {
  const { user, profile } = useUser();
  const { saving, run } = useSaving();
  const [email, setEmail] = useState<string | null>(null);
  const value = email ?? profile?.workshop_email ?? "";

  function save() {
    const trimmed = value.trim();
    if (trimmed && !/^\S+@\S+\.\S+$/.test(trimmed)) { toast.error("Enter a valid email address."); return; }
    void run(async () => {
      try {
        if (!supabase || !user) throw new Error("Not signed in.");
        const { error } = await supabase.from("user_profiles").update({ workshop_email: trimmed || null }).eq("id", user.id);
        if (error) throw error;
        toast.success("Workshop email saved");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn't save the workshop email. Try again."));
      }
    });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Mail className="size-5 text-brand-accent" /> Workshop Email Settings</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label htmlFor="workshop-email" className="text-sm font-semibold text-slate-700">Workshop Email</label>
          <Input id="workshop-email" className="mt-2" type="email" placeholder="workshop@yourcompany.co.uk" value={value} onChange={(event) => setEmail(event.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Pre-filled when you send a job sheet to the workshop. Saved on your own account; it applies after you next sign in.</p>
        </div>
        <div className="rounded-lg border bg-slate-50 p-4 text-sm text-slate-600"><p className="font-semibold text-slate-950">Email Sender</p><p>Email sending from your own domain isn&apos;t set up yet. Until it is, job emails are saved as drafts.</p></div>
        <Button className="bg-brand text-brand-ink" disabled={saving} onClick={save}>{saving ? "Saving..." : "Save Settings"}</Button>
      </CardContent>
    </Card>
  );
}

/** How long finished records stay in the Done lists before moving to Archived (migration 028). Nothing is deleted. */
function ArchiveSettingsCard() {
  const [months, setMonths] = useState("12");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!supabase) return;
    void supabase.from("organization_settings").select("archive_after_months").maybeSingle().then(({ data }) => {
      const value = Number((data as { archive_after_months?: unknown } | null)?.archive_after_months);
      if (Number.isFinite(value) && value >= 1) setMonths(String(value));
    });
  }, []);
  async function save() {
    const value = Number(months);
    if (!Number.isInteger(value) || value < 1 || value > 120) {
      toast.error("Enter a whole number of months from 1 to 120.");
      return;
    }
    setSaving(true);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const organizationId = await getCurrentOrganizationId();
      const { error } = await supabase.from("organization_settings").upsert({ organization_id: organizationId, archive_after_months: value, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
      if (error) throw error;
      void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", metadata: { section: "archive", archive_after_months: value } });
      toast.success(`Finished records move to Archived after ${value} month${value === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the archive setting."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Archive className="size-5 text-brand-accent" /> Archive</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">Finished jobs, decided quotes, paid invoices, received purchase orders, converted or closed sales orders and delivered notes move from <strong>Done</strong> to <strong>Archived</strong> after this long. Archived records are never deleted: they stay searchable, viewable and printable under Show &gt; Archived, and admin or office can archive or unarchive any record by hand.</p>
        <label className="flex flex-wrap items-center gap-2">Archive after <Input aria-label="Archive after months" className="w-24" type="number" inputMode="numeric" min={1} max={120} step={1} value={months} onChange={(event) => setMonths(event.target.value)} /> months</label>
        <Button className="bg-brand text-brand-ink" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save archive setting"}</Button>
      </CardContent>
    </Card>
  );
}

/**
 * Accepting a quote makes its sales order; this decides whether that order then makes its job straight away (not started), or waits
 * for Convert to Job (migration 058: organization_settings.auto_convert_sales_orders, default on; admin only, through
 * set_auto_convert_sales_orders, which asks for the second step and is audited).
 */
function AutoConvertCard() {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!supabase) return;
    void supabase.from("organization_settings").select("auto_convert_sales_orders").maybeSingle().then(({ data, error }) => {
      if (error) return; // the database predates 058: the card stays unavailable
      setOn((data as { auto_convert_sales_orders?: boolean } | null)?.auto_convert_sales_orders !== false);
    });
  }, []);
  async function change(next: boolean) {
    setSaving(true);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.rpc("set_auto_convert_sales_orders", { p_on: next });
      if (error) throw error;
      setOn(data !== false);
      toast.success(data !== false ? "Sales orders made from accepted quotes now become jobs automatically" : "Sales orders now wait for Convert to Job");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the sales order setting."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Workflow className="size-5 text-brand-accent" /> Quote to job</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">Accepting a quote creates its sales order. With this on, the sales order also creates its job straight away, as <strong>not started</strong>. With it off, the order waits on Sales Orders for <strong>Convert to Job</strong>.</p>
        {on === null ? <p className="text-slate-500">This setting isn&apos;t available yet.</p> : (
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <span className="font-medium text-slate-800">Make the job automatically</span>
            <Switch checked={on} label="Make the job automatically" onChange={(checked) => { if (!saving) void change(checked); }} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Customer sign-off on jobs (migration 072: organization_settings.customer_signoff_enabled, default off; admin only, through
 * set_customer_signoff_enabled, which asks for the second step and is audited). Off: the job screens and prints are as before.
 */
function CustomerSignOffCard() {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!supabase) return;
    void supabase.from("organization_settings").select("customer_signoff_enabled").maybeSingle().then(({ data, error }) => {
      if (error) return; // the database predates 072: the card stays unavailable
      setOn((data as { customer_signoff_enabled?: boolean } | null)?.customer_signoff_enabled === true);
    });
  }, []);
  async function change(next: boolean) {
    setSaving(true);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { data, error } = await supabase.rpc("set_customer_signoff_enabled", { p_on: next });
      if (error) throw error;
      setOn(data === true);
      toast.success(data === true ? "Customers can now sign off jobs on site" : "Customer sign-off on jobs is off");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the customer sign-off setting."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Workflow className="size-5 text-brand-accent" /> Customer sign-off</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">With this on, each job&apos;s worksheet has a <strong>Customer sign off</strong> box: the fitter hands their phone to the customer, who prints their name, signs and can add a comment. It works offline and uploads once back online, and it prints on the job worksheet. Sign-offs already recorded stay on their jobs if you turn it off.</p>
        {on === null ? <p className="text-slate-500">This setting isn&apos;t available yet.</p> : (
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <span className="font-medium text-slate-800">Customer sign-off on jobs</span>
            <Switch checked={on} label="Customer sign-off on jobs" onChange={(checked) => { if (!saving) void change(checked); }} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Year-end export: every issued document PDF for a period plus a summary spreadsheet, in one zip (lib/year-end-export). */
function YearEndExportCard() {
  const thisYear = new Date().getFullYear();
  const [from, setFrom] = useState(`${thisYear - 1}-01-01`);
  const [to, setTo] = useState(`${thisYear - 1}-12-31`);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pickYear = (year: number) => { setFrom(`${year}-01-01`); setTo(`${year}-12-31`); };
  async function run() {
    if (!from || !to || to < from) {
      toast.error("Choose a start date and an end date after it.");
      return;
    }
    setBusy(true);
    setProgress({ done: 0, total: 0, label: "Collecting documents" });
    try {
      const [{ buildYearEndZip }, { requireCompanyProfile }] = await Promise.all([import("@/lib/year-end-export"), import("@/lib/company")]);
      const company = await requireCompanyProfile();
      const { zip, summary, problems, unresolved } = await buildYearEndZip(from, to, company, (done, total, label) => setProgress({ done, total, label }));
      const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${company.name.replace(/[^\w\- ]/g, "_")} documents ${from} to ${to}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      if (unresolved) toast.warning(`${summary.length} documents exported, including ${unresolved} unresolved record${unresolved === 1 ? "" : "s"} left out of the figures. See README.txt and problems.txt.`);
      else toast.success(`${summary.length} documents exported${problems.length ? ` (${problems.length} without a PDF: see problems.txt)` : ""}`);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't build the export."));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><FileArchive className="size-5 text-brand-accent" /> Year-end export</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">One zip with the PDF of every issued invoice, sent quote, purchase order and delivery note in the period, plus <strong>summary.csv</strong> (opens in Excel: number, date, customer, net, VAT, gross, paid, balance due, paid date) and <strong>payments.csv</strong> (every payment recorded on those invoices). An invoice whose payment amount is not known is left blank and listed in problems.txt. Drafts are left out. The export is logged.</p>
        <div className="flex flex-wrap gap-2">{[thisYear, thisYear - 1, thisYear - 2].map((year) => <Button key={year} size="sm" variant="outline" onClick={() => pickYear(year)}>{year}</Button>)}</div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">From <Input aria-label="Export from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></label>
          <label className="flex items-center gap-2">To <Input aria-label="Export to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></label>
        </div>
        <Button className="bg-brand text-brand-ink" disabled={busy} onClick={() => void run()}>{busy ? "Building export..." : "Download year-end export"}</Button>
        {progress ? <p role="status" className="text-xs text-slate-500">{progress.total ? `${progress.done} of ${progress.total}: ${progress.label}` : progress.label}</p> : null}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const settings = useOrgSettings();
  const [saving, setSaving] = useState(false);

  async function persist(save: Promise<SaveResult>, what: string, oldData: Record<string, unknown>, newData: Record<string, unknown>, metadata: Record<string, unknown>) {
    setSaving(true);
    const result = await save;
    setSaving(false);
    if (result.dropped) return;
    if (result.denied) return void toast.error(result.message ?? `You can't change ${what.toLowerCase()}.`);
    if (result.localOnly) toast.message(`${what} saved in this browser only (Supabase unavailable).`);
    else toast.success(`${what} saved`);
    void auditEvent({ action: "organization_settings.update", entityTable: "organization_settings", oldData, newData, metadata });
  }

  function toggleNav(key: string, label: string, visible: boolean) {
    const oldData = { hiddenNav: settings.hiddenNav };
    const next = visible ? settings.hiddenNav.filter((item) => item !== key) : Array.from(new Set([...settings.hiddenNav, key]));
    void persist(setNavHidden(key, !visible), "Menu settings", oldData, { hiddenNav: next }, { item: label, visible });
  }

  function toggleColumn(tableKey: string, columnKey: string, visible: boolean) {
    const current = settings.hiddenColumns[tableKey] ?? [];
    const table = screensByGroup().flatMap((entry) => entry.screens).find((screen) => screen.key === tableKey);
    if (!table || table.columns.find((column) => column.key === columnKey)?.locked) return;
    const next = setItemShown(table, current, columnKey, visible);
    void persist(setColumnHidden(tableKey, columnKey, !visible), "Display settings", { hiddenColumns: { [tableKey]: current } }, { hiddenColumns: { [tableKey]: next } }, { table: tableKey, column: columnKey, visible });
  }

  /** Reset to default = nothing hidden. Each screen is cleared as its own merge-save, so other screens and the menu are untouched. */
  function resetScreens(screenKeys: string[] | undefined, label: string) {
    const before = settings.hiddenColumns;
    const after = resetHiddenColumns(before, screenKeys);
    const cleared = Object.keys(before).filter((key) => !(key in after) && (before[key] ?? []).length > 0);
    if (!cleared.length) return;
    const oldData = { hiddenColumns: Object.fromEntries(cleared.map((key) => [key, before[key]])) };
    const newData = { hiddenColumns: Object.fromEntries(cleared.map((key) => [key, [] as string[]])) };
    void persist(saveOrgSettings(newData), "Display settings", oldData, newData, { reset: label });
  }

  return (
    <RoleGate allowed={["admin"]}>
      <div className="space-y-6">
        <div><h1 className="page-title">Settings</h1><p className="mt-2 text-sm text-slate-500">Company-wide settings for {PRODUCT.name}. Only admins can change them.</p></div>
        {settings.loaded && settings.localOnly ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Supabase is unavailable (or the organization_settings migration has not been run), so menu and column choices are stored in this browser only.</div> : null}
        <CompanyDetailsCard />
        <ArchiveSettingsCard />
        <AutoConvertCard />
        <TimeSettingsCard />
        <SiteNetworkCard />
        <CustomerSignOffCard />
        <YearEndExportCard />
        <AiHelperSettingsCard />
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><LayoutList className="size-5 text-brand-accent" /> Menu Sections</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm text-slate-500">Turn off sections you do not use. Hidden items disappear from the sidebar for everyone in the organisation. Dashboard and Settings are always shown.</p>
            {navSections.map((section) => (
              <div key={section}>
                <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{section}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {NAV_TOGGLES.filter((item) => item.section === section).map((item) => {
                    const visible = !settings.hiddenNav.includes(item.key);
                    return (
                      <div key={item.key} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                        <span className="text-sm font-medium text-slate-800">{item.label}</span>
                        <Switch checked={visible} label={`Show ${item.label}`} onChange={(checked) => toggleNav(item.key, item.label, checked)} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Columns3 className="size-5 text-brand-accent" /> Display</CardTitle></CardHeader>
          <CardContent className="space-y-5" data-testid="display-settings">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="min-w-0 flex-1 basis-64 text-sm text-slate-500">Choose what each screen shows. Changes apply to everyone in this company. Locked items are always shown. Admin and office users can also change these from the Columns button on each screen.</p>
              <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={() => resetScreens(undefined, "all")}>Reset all to default</Button>
            </div>
            {screensByGroup().map(({ group, screens }) => (
              <section key={group} aria-label={`${group} screens`} className="space-y-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group}</p>
                {screens.map((table) => {
                  const hidden = settings.hiddenColumns[table.key] ?? [];
                  const { shown, total } = shownCount(table, hidden);
                  return (
                    <div key={table.key} data-testid={`display-screen-${table.key}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-900">{table.label}</p>
                          <p className="text-xs text-slate-500">{table.description}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-slate-500" data-testid={`display-count-${table.key}`}>{shown} of {total} shown</span>
                          <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={hidden.length === 0} aria-label={`Reset ${table.label} to default`} onClick={() => resetScreens([table.key], table.label)}>Reset to default</Button>
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {table.columns.map((column) => {
                          const visible = column.locked || !hidden.includes(column.key);
                          return (
                            <label key={column.key} className="flex min-w-0 items-center gap-3 rounded-lg border p-3">
                              <input type="checkbox" className="size-4 shrink-0" checked={visible} disabled={column.locked} onChange={(event) => toggleColumn(table.key, column.key, event.target.checked)} />
                              <span className="min-w-0 text-sm text-slate-800">{column.label}{column.locked ? <span className="ml-1 text-xs text-slate-500">(always shown)</span> : null}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
            {saving ? <p className="text-xs text-slate-500">Saving...</p> : null}
          </CardContent>
        </Card>
        <WorkshopEmailCard />
      </div>
    </RoleGate>
  );
}
