"use client";

/**
 * BOUNDARY (PREVIEW ONLY). OWNERSHIP ASSUMPTION, TO BE CONFIRMED BY THE OWNER: docs/MODULES.md assigns the Settings page (app/(dashboard)/settings/page.tsx) to no module. It is
 * the company-wide settings hub, so for this preview ONLY it is treated as Module 1 (Auth / Company / Users / Admin). Several cards on the real page belong to other modules (Job reports,
 * ISO, Costing rates, Email templates and schedules, Hours and the workshop network, AI): none of their components or internals are imported here. Their visible controls, wording and states
 * are reproduced locally from the real source (read only) and pinned to it by tests/unit/settingsPreview.test.ts.
 * Inputs: none from the server. Everything shown is fictional sample data (one made-up company, "Fernhill Engineering Ltd", addresses on reserved ".example" domains and documentation IP
 * addresses) held in this file, plus the person's clicks and typing. Outputs: a Settings look-and-feel prototype whose only state is LOCAL UI state held in memory (no localStorage, no
 * cookie, no URL change). It contains NO fetch, Supabase, auth, session, e-mail, payment, AI, Xero or file-upload call; the logo picker only checks the chosen file's type and size and never reads
 * or sends it. No action reports success: every Save, switch, tick, Reset, Delete, Lock and Use-this-network answers with the neutral "Preview only ... Nothing was saved." toast and the
 * stored value does not change (draft form fields do change while you type, as on the real page, but are never kept). Company switches that gate other modules (Sales Orders, job reports, ISO,
 * customer sign-off, e-mail schedules, AI) show the real off defaults; nothing is drawn as connected, authorised or saved. The authenticator-code step-up dialog the real Costing rates save
 * can ask for is deliberately not drawn.
 * Run-time imports from lib/ are pure functions and constants (bank-details, branding, product, company, company-form, working-hours, time-sheet, time-features, org-settings,
 * sales-orders-switch, machine-schedule, print-layout, site-network, clock-in-lock, dates, people, costing/app-rates, email templates and schedules, chase steps) and types; none is called
 * for data (the hooks and database functions in them are not used). The form checks are the REAL functions; the few rules that live inline in the page and its cards are mirrored here.
 * MUST NOT CHANGE: wording, controls, defaults and which role may see the page (Admin only) mirror today's page. Do not wire this to real data, a session or an action, do not add a setting
 * the real page lacks, keep every control at a 48 px hit area. Delete the four preview files (this component and its .module.css, app/(dashboard)/settings/preview/page.tsx,
 * tests/unit/settingsPreview.test.ts) to remove it completely.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Button, Callout, Checkbox, Dialog, Disclosure, Field, FormGroup, Input, LoadingState, Panel, Popover, SegmentedControl, Select, Switch, Textarea, ToastProvider, cx, premiumTokens, useToast,
} from "@/components/ui/premium";
import { EMPTY_BANK_DETAILS, validateBankDetails } from "@/lib/bank-details";
import { hexOr, isHexColour, PRODUCT_BRANDING, textOn } from "@/lib/branding";
import { type DayHours, defaultInvoiceMessage } from "@/lib/company";
import { EMPTY_COMPANY, workingHoursFromForm, type CompanyForm } from "@/lib/company-form";
import { clockInLockDecision } from "@/lib/clock-in-lock";
import { type CostingRates, blankCostingRates } from "@/components/costing/types";
import { NOT_APPLIED_MESSAGE as COSTING_NOT_APPLIED, NOT_SET_UP_MESSAGE, ratesGaps, ratesProblem } from "@/lib/costing/app-rates";
import { fmtDateTime } from "@/lib/dates";
import { DEFAULT_CHASE_STEPS } from "@/lib/email/chase/steps";
import { type EmailScheduleFrequency, type EmailScheduleKind, weekdayName } from "@/lib/email/schedules/due";
import {
  type ScheduleForm, DAILY_RUN_NOTE, EXACT_TIME_SENDING, FREQUENCY_LABEL, SCHEDULE_LABELS, SCHEDULE_NOT_AVAILABLE, defaultForm, nextRunLine, patchFromForm,
} from "@/lib/email/schedules/form";
import {
  BODY_MAX, DEFAULT_TEMPLATES, SAMPLE_VARS, SUBJECT_MAX, TEMPLATE_KEYS, type TemplateKey, type TemplateText, renderTemplate, unknownPlaceholders,
} from "@/lib/email/templates/defaults";
import { detailLabel, detailParts, detailText, emailSections, insertDetail, sectionsBody, type EmailSections } from "@/lib/email/templates/editor";
import { TEMPLATES_NOT_APPLIED_MESSAGE, templateProblem } from "@/lib/email/templates/store";
import { WEEKDAY_OPTIONS } from "@/lib/machine-schedule";
import { NAV_TOGGLES, resetHiddenColumns, screensByGroup, shownCount } from "@/lib/org-settings";
import { UNKNOWN } from "@/lib/people";
import { PRINT_LAYOUT_OPTIONS, type CompanyPrintLayout, type PrintLayout, printLayoutLabel, resolvePrintLayout } from "@/lib/print-layout";
import { PRODUCT } from "@/lib/product";
import { SALES_ORDERS_KEY, salesOrdersEnabled } from "@/lib/sales-orders-switch";
import { SITE_NETWORK_IP_RETENTION_DAYS, SITE_NETWORK_LABEL_MAX, onSavedNetwork } from "@/lib/site-network";
import { TIME_NEEDS_DATABASE_UPDATE } from "@/lib/time-features";
import { DEFAULT_TIME_SETTINGS, type TimeSettings } from "@/lib/time-sheet";
import { formatHoursMinutes, paidDay, paidHoursExplanation, paidWeek } from "@/lib/working-hours";

import s from "./SettingsPreview.module.css";

/* ------------------------------------------------------------------ sample data (fictional) ------------------------------------------------------------------ */

export const COMPANY_NAME = "Fernhill Engineering Ltd";
export const COMPANY_SLUG = "fernhill-engineering";
export const ME = "Priya Raman";
export const PREVIEW_TAG = "Preview, sample data, nothing is saved";
/** The one sentence that ends every toast: no action here ever persists anything. */
export const NOT_SAVED = "Nothing was saved.";

export type Role = "admin" | "office" | "workshop" | "viewer";
export const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" },
];
/** The real page is wrapped in <RoleGate allowed={["admin"]}> (and middleware.ts: ["/settings", ["admin"]]). */
export const canUseSettings = (role: Role) => role === "admin";

export const SEED_COMPANY: CompanyForm = {
  ...EMPTY_COMPANY,
  name: "Fernhill Engineering",
  documentName: COMPANY_NAME,
  addressLines: "Unit 4, Brookside Works\nFernhill Industrial Estate\nExampleton\nEX1 1AA",
  phone: "01632 960123",
  fax: "",
  email: "office@fernhill.example",
  website: "www.fernhill.example",
  vatNumber: "GB000000000",
  vatRegistered: true,
  defaultVatRate: "20",
  brandPrimary: "#1e3472",
  brandAccent: "#2e52b8",
  loginTagline: "Precision CNC machining since 1998",
  brandedLogin: false,
  loginStyle: "light",
  loginEyebrow: "",
  defaultQuoteTerms: "Valid for 30 days",
  defaultInvoiceTerms: "30 days",
  defaultCustomerMessage: "Thank you for the opportunity to quote.\nPrices exclude carriage unless stated.",
  defaultInvoiceMessage: defaultInvoiceMessage("30 days").join("\n"),
  bank: { accountName: COMPANY_NAME, bankName: "Example Bank plc", sortCode: "20-00-00", accountNumber: "12345678", iban: "", bic: "" },
  showCreditsInBalance: false,
  workHours: { ...EMPTY_COMPANY.workHours, 5: { start: "08:00", end: "14:30" } },
};

export const SEED_COSTING: CostingRates = {
  materials: [
    { id: "m1", name: "EN24T bar", unit: "kg", price: 3.85, scrapPct: 12 },
    { id: "m2", name: "316 stainless plate", unit: "kg", price: 6.9, scrapPct: 15 },
    { id: "m3", name: "M10 stud, zinc", unit: "each", price: 0.42, scrapPct: 0 },
  ],
  machines: [
    { id: "k1", name: "Vertical machining centre 1", hourlyRate: 38, labourPerHour: null },
    { id: "k2", name: "CNC lathe 2", hourlyRate: 32, labourPerHour: 28 },
  ],
  defaults: { labourPerHour: 32, programmingPerHour: 45, overheadPct: 150, marginPct: 20 },
};

export type SavedNetworkRow = { id: string; network: string; label: string; created_at: string };
/** 203.0.113.0/24 is the documentation range (RFC 5737): no real address. */
export const SEED_NETWORKS: SavedNetworkRow[] = [{ id: "n1", network: "203.0.113.24/32", label: "Workshop", created_at: "2026-10-19T09:12:00Z" }];
export const DEVICE_IPS = { saved: "203.0.113.24", other: "198.51.100.77", private: "192.168.1.20" } as const;
export type DeviceNet = "saved" | "other" | "private" | "unseen";
export const LOCK_SEED = { network: "203.0.113.24/32", locked_by: ME, locked_at: "2026-11-02T08:05:00Z" };

export const SEED_OVERRIDES: Partial<Record<TemplateKey, TemplateText>> = {
  quote: {
    subject: "Quote {{document_number}} from {{company_name}}",
    body: "Hello {{customer_name}}\n\nThank you for your enquiry. Quote {{document_number}} for {{total}} is attached.\n\nReply to this e-mail to accept it and we will confirm the lead time.\n\nKind regards,\n{{company_name}}",
  },
};
export const TEMPLATE_SAMPLE_VARS = { ...SAMPLE_VARS, company_name: COMPANY_NAME };

/** Sample company display choices: a few columns the company has hidden (Reset to default is live only for these screens). */
export const SEED_HIDDEN: Record<string, string[]> = { quotes: ["description", "valid"], customers: ["address"], hours: ["breaks"] };

/* ------------------------------------------------------------------ pure rules (real functions, or mirrored and pinned by the test) ------------------------------------------------------------------ */

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
export const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };
export const LOGO_MAX_BYTES = 1024 * 1024;

/** The checks of the real page's Company details "save()", in the same order; the first problem only (the real page stops at the first). */
export type CompanyProblem = { fieldId: string | null; message: string };
export function companyProblem(form: CompanyForm): CompanyProblem | null {
  const documentName = form.documentName.trim();
  const addressLines = lines(form.addressLines);
  const vatNumber = form.vatNumber.trim();
  if (!documentName) return { fieldId: "company-documentName", message: "Enter the company name as it should appear on documents." };
  if (!addressLines.length) return { fieldId: "company-addressLines", message: "Enter at least one address line." };
  for (const [label, key, value] of [["Brand colour", "brandPrimary", form.brandPrimary], ["Accent colour", "brandAccent", form.brandAccent]] as const) {
    if (value.trim() && !isHexColour(value.trim())) return { fieldId: `colour-${key}`, message: `${label} must look like #1e3472.` };
  }
  if (form.vatRegistered && !vatNumber) return { fieldId: "company-vatNumber", message: "Enter your VAT number, or switch off VAT registered." };
  if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) return { fieldId: "company-email", message: "Enter a valid company email address." };
  const hours = workingHoursFromForm(form);
  if ("error" in hours) return { fieldId: null, message: hours.error };
  const bank = validateBankDetails(form.bank);
  if (bank.errors.length) {
    const message = bank.errors[0];
    return { fieldId: /^The account number/.test(message) ? "bank-accountNumber" : "bank-sortCode", message };
  }
  return null;
}

/** The logo checks of the real page's uploadLogo(), in order. Only the file's type and size are looked at; the file itself is never read. */
export function logoProblem(file: { type: string; size: number }, hasProfile: boolean): string | null {
  if (!LOGO_TYPES[file.type]) return "Upload a PNG or JPG image.";
  if (file.size > LOGO_MAX_BYTES) return "The logo must be 1 MB or smaller.";
  if (!hasProfile) return "Save the company details first, then upload the logo.";
  return null;
}

export const archiveProblem = (months: string): string | null => {
  const value = Number(months);
  return !Number.isInteger(value) || value < 1 || value > 120 ? "Enter a whole number of months from 1 to 120." : null;
};
export const exportProblem = (from: string, to: string): string | null => (!from || !to || to < from ? "Choose a start date and an end date after it." : null);
export const emailProblem = (value: string): string | null => (value.trim() && !/^\S+@\S+\.\S+$/.test(value.trim()) ? "Enter a valid email address." : null);

export type ChaseTone = "before_due" | "friendly" | "firm" | "final";
export const CHASE_TONE_LABELS: Record<ChaseTone, string> = { before_due: "Before the due date", friendly: "Friendly", firm: "Firm", final: "Final reminder" };
export const chaseProblem = (rows: Array<{ days: string }>): string | null =>
  rows.some((row) => !/^-?\d+$/.test(row.days) || !Number.isSafeInteger(Number(row.days))) ? "Enter a whole number of days for each step." : null;

/** The real card's printLayoutStatus(). */
export function printLayoutStatus(company: CompanyPrintLayout): string {
  if (company.source === "saved") return `Your company prints the ${printLayoutLabel(company.layout)} layout.`;
  if (company.source === "default") return `Not chosen yet: your company prints the ${printLayoutLabel(company.layout)} layout, the default for your company.`;
  return `The setting couldn't be read, so worksheets print the ${printLayoutLabel(company.layout)} layout for now.`;
}

/** The "n of m" and Reset rules of Settings > Display, from the real org-settings functions. */
export function displayCounts(hiddenColumns: Record<string, string[]>) {
  return screensByGroup().flatMap((entry) => entry.screens).map((screen) => ({ key: screen.key, ...shownCount(screen, hiddenColumns[screen.key] ?? []), canReset: (hiddenColumns[screen.key] ?? []).length > 0 }));
}
/** Which screens a reset would clear (the real resetScreens: nothing hidden means nothing happens). */
export function resetPlan(hiddenColumns: Record<string, string[]>, screenKeys?: string[]): string[] {
  const after = resetHiddenColumns(hiddenColumns, screenKeys);
  return Object.keys(hiddenColumns).filter((key) => !(key in after) && (hiddenColumns[key] ?? []).length > 0);
}

/* ------------------------------------------------------------------ preview plumbing ------------------------------------------------------------------ */

type CardState = "ready" | "loading" | "not-applied" | "error";
type States = {
  page: "ready" | "checking" | "local-only";
  company: "ready" | "loading" | "not-set-up";
  hours: "ready" | "loading" | "needs-update" | "error";
  costing: CardState | "blank";
  schedules: CardState;
  chase: "ready" | "loading" | "error";
  templates: CardState;
  autoConvert: "available" | "unavailable";
  signOff: "available" | "unavailable";
  print: CompanyPrintLayout["source"] | "loading";
};
type Flags = { ai: boolean; has075: boolean; has114: boolean; retention: boolean; canRename: boolean; logo: boolean; hidden: boolean; networks: boolean; check: boolean; locked: boolean; device: DeviceNet; offSite: number };
const INITIAL_STATES: States = { page: "ready", company: "ready", hours: "ready", costing: "ready", schedules: "ready", chase: "ready", templates: "ready", autoConvert: "available", signOff: "available", print: "default" };
/** AI is off by default (the real card is hidden unless AI_HELPER_ENABLED is on for the server). */
const INITIAL_FLAGS: Flags = { ai: false, has075: true, has114: true, retention: true, canRename: true, logo: true, hidden: true, networks: true, check: false, locked: false, device: "saved", offSite: 2 };

type Preview = (detail: string) => void;

/** Spreads a heading and a paragraph the same way in every panel. */
function Lead({ children }: { children: ReactNode }) {
  return <p className={s.lead}>{children}</p>;
}
function Note({ children, className, ...rest }: { children: ReactNode; className?: string; "data-testid"?: string }) {
  return <p className={cx(s.note, className)} data-testid={rest["data-testid"]}>{children}</p>;
}
/** A boxed switch row (the real page draws each switch in its own bordered row). */
function SwitchBox({ children }: { children: ReactNode }) {
  return <div className={s.switchBox}>{children}</div>;
}
function CheckRow({ checked, onChange, disabled, children, ...rest }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; children: ReactNode; "data-testid"?: string }) {
  return (
    <label className={s.checkRow} data-disabled={disabled ? "true" : undefined}>
      <Checkbox checked={checked} disabled={disabled} data-testid={rest["data-testid"]} onChange={(event) => onChange(event.target.checked)} />
      <span className={s.checkText}>{children}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ Company details ------------------------------------------------------------------ */

type TextKey = Exclude<keyof CompanyForm, "vatRegistered" | "brandedLogin" | "loginStyle" | "showCreditsInBalance" | "workDays" | "workHours" | "bank">;

function CompanyDetails({ state, timeSettings, hasLogo, preview }: { state: States["company"]; timeSettings: TimeSettings | null; hasLogo: boolean; preview: Preview }) {
  const loading = state === "loading";
  const profile = state === "ready";
  const ready = !loading;
  const [form, setForm] = useState<CompanyForm>(() => (profile ? SEED_COMPANY : EMPTY_COMPANY));
  const [problem, setProblem] = useState<CompanyProblem | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [origin, setOrigin] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const week = paidWeek(form.workDays.map((day) => form.workHours[day]), timeSettings ?? undefined);
  const edit = (patch: Partial<CompanyForm>) => { setForm((current) => ({ ...current, ...patch })); setProblem(null); };
  const set = (key: TextKey) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => edit({ [key]: event.target.value } as Partial<CompanyForm>);
  const errorFor = (id: string) => (problem?.fieldId === id ? problem.message : undefined);

  useEffect(() => {
    if (!focusSignal || !problem) return;
    const target = problem.fieldId ? document.getElementById(problem.fieldId) : errorRef.current;
    (target as HTMLElement | null)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  function save() {
    const found = companyProblem(form);
    setProblem(found);
    if (found) { setFocusSignal((n) => n + 1); return; }
    preview("Company details would be saved.");
  }

  function pickLogo(file: File | undefined) {
    if (!file) return;
    const found = logoProblem({ type: file.type, size: file.size }, profile);
    if (fileInput.current) fileInput.current.value = "";
    setLogoError(found);
    if (!found) preview("The logo would be uploaded and printed on your documents.");
  }

  const field = (label: string, key: TextKey, props: React.ComponentProps<typeof Input> = {}, opts: { required?: boolean; hint?: string } = {}) => (
    <Field label={label} id={`company-${key}`} error={errorFor(`company-${key}`)} required={opts.required} hint={opts.hint}>
      <Input value={form[key]} onChange={set(key)} {...props} />
    </Field>
  );
  const bankField = (label: string, key: keyof CompanyForm["bank"], props: React.ComponentProps<typeof Input> = {}) => (
    <Field label={label} id={`bank-${key}`} error={errorFor(`bank-${key}`)}>
      <Input value={form.bank[key]} onChange={(event) => edit({ bank: { ...form.bank, [key]: event.target.value } })} {...props} />
    </Field>
  );

  return (
    <Panel title="Company details" busy={loading} data-testid="company-details">
      <fieldset disabled={!ready} aria-busy={!ready} data-testid="company-details-form" data-loaded={ready ? "true" : "false"} className={s.bare}>
        <Lead>These details print on every quote, invoice and delivery note. Documents can&apos;t be generated until the company name and address (and the VAT number, when VAT registered) are set.</Lead>
        {!loading && !profile ? <Callout tone="warn" lead="" role="status">Company details haven&apos;t been set up yet.</Callout> : null}

        <div className={s.stack}>
          <div className={s.grid2}>
            {field("Trading name", "name", { placeholder: "Shown in the app" })}
            {field("Name on documents", "documentName", { placeholder: "As printed on documents" }, { required: true })}
          </div>
          <Field label="Address (one line per row)" id="company-addressLines" error={errorFor("company-addressLines")} required>
            <Textarea rows={4} value={form.addressLines} onChange={set("addressLines")} />
          </Field>
          <div className={s.grid3}>
            {field("Phone", "phone", { type: "tel", inputMode: "tel", autoComplete: "tel" })}
            {field("Fax", "fax", { type: "tel", inputMode: "tel" })}
            {field("Email", "email", { type: "email", inputMode: "email" })}
          </div>
          <div className={s.grid2}>
            {field("Website", "website")}
            {field("VAT number", "vatNumber", {}, { required: form.vatRegistered })}
          </div>

          <div className={s.block}>
            <div className={s.grid2}>
              <Switch label="VAT registered" hint="Off: no quote, invoice, sales order or PO gets VAT, and no VAT number is printed." checked={form.vatRegistered} onChange={(checked) => edit({ vatRegistered: checked })} />
              <Field label="Default VAT rate" hint="New document lines and carriage start at this rate. Each line can be changed.">
                <Select value={form.defaultVatRate} disabled={!form.vatRegistered} onChange={(event) => edit({ defaultVatRate: event.target.value })}>
                  <option value="20">20% (standard)</option>
                  <option value="5">5% (reduced)</option>
                  <option value="0">0% (zero rated)</option>
                </Select>
              </Field>
            </div>
          </div>

          <FormGroup title="Logo on documents" headingLevel={3} data-testid="logo-group">
            <div className={s.logoRow}>
              <div className={s.logoBox}>
                {hasLogo && profile
                  ? <svg role="img" aria-label="Company logo" viewBox="0 0 144 96" width="144" height="96"><rect x="0" y="0" width="144" height="96" fill="#ffffff" /><rect x="34" y="24" width="48" height="48" rx="6" fill="#1e3472" /><path d="M46 60V36h22v5H52v5h13v5H52v9z" fill="#ffffff" /><rect x="90" y="34" width="26" height="5" rx="2" fill="#2e52b8" /><rect x="90" y="45" width="20" height="5" rx="2" fill="#9aa6c2" /><rect x="90" y="56" width="24" height="5" rx="2" fill="#9aa6c2" /></svg>
                  : <span className={s.logoNone}>No logo. Documents print the company name.</span>}
              </div>
              <div className={s.logoSide}>
                <input ref={fileInput} type="file" accept="image/png,image/jpeg" className={s.hiddenFile} aria-label="Logo file" tabIndex={-1} onChange={(event) => pickLogo(event.target.files?.[0])} />
                <div className={s.btnRow}>
                  <Button variant="secondary" disabled={loading || !profile} onClick={() => fileInput.current?.click()}>{hasLogo && profile ? "Replace logo" : "Upload logo"}</Button>
                  {hasLogo && profile ? <Button variant="dangerQuiet" onClick={() => preview("The logo would be removed. Documents would print the company name instead.")}>Remove</Button> : null}
                </div>
                <Note>PNG or JPG, up to 1 MB. Printed top right on quotes, invoices, purchase orders and delivery notes. Only this company can see it.</Note>
                {logoError ? <p className={s.fieldMsg} role="alert"><span className={s.msgLead}>Problem:</span> {logoError}</p> : null}
              </div>
            </div>
          </FormGroup>

          <FormGroup title="Sign-in page branding" headingLevel={3} data-testid="branding-group">
            <Switch label="Branded sign-in page" hint={`Show your logo, colours and tagline on your own sign-in link. Off: the link shows the neutral ${PRODUCT.name} page and nothing about your company.`} checked={form.brandedLogin} onChange={(checked) => edit({ brandedLogin: checked })} />
            <div className={s.gridBrand}>
              {([["Brand colour", "brandPrimary", PRODUCT_BRANDING.primary], ["Accent colour", "brandAccent", PRODUCT_BRANDING.accent]] as const).map(([label, key, fallback]) => (
                <Field key={key} label={label} id={`colour-${key}`} error={errorFor(`colour-${key}`)}>
                  <div className={s.colourRow}>
                    <input type="color" aria-label={`${label} picker`} className={s.colourPick} value={isHexColour(form[key]) ? form[key] : fallback} onChange={(event) => edit({ [key]: event.target.value } as Partial<CompanyForm>)} />
                    <Input value={form[key]} placeholder={fallback} maxLength={7} onChange={set(key)} aria-label={`${label} hex`} />
                  </div>
                </Field>
              ))}
              {field("Sign-in tagline", "loginTagline", { placeholder: "Precision CNC machining since 1998", maxLength: 120 })}
            </div>
            <div className={s.gridStyle}>
              <Field label="Sign-in style" hint="Dark: your brand colour as the page, the tagline as a large headline.">
                <Select value={form.loginStyle} onChange={(event) => edit({ loginStyle: event.target.value === "dark" ? "dark" : "light" })}>
                  <option value="light">Light</option>
                  <option value="dark">Dark, website style</option>
                </Select>
              </Field>
              {field("Small heading (dark style)", "loginEyebrow", { placeholder: "CNC machining and fabrication, Hamilton", maxLength: 80 })}
            </div>
            <div className={s.brandStrip} data-testid="brand-strip" style={{ background: `linear-gradient(120deg, ${hexOr(form.brandPrimary, PRODUCT_BRANDING.primary)}, ${hexOr(form.brandAccent, PRODUCT_BRANDING.accent)})`, color: textOn(hexOr(form.brandPrimary, PRODUCT_BRANDING.primary)) }}>
              <span className={s.stripName}>{form.name || form.documentName || "Your company"}</span>
              <span className={s.stripTag}>{form.loginTagline || PRODUCT_BRANDING.tagline}</span>
            </div>
            {profile ? (
              <Note>
                Your sign-in link: <code className={s.code}>{origin}/login?org={COMPANY_SLUG}</code>
                {form.brandedLogin ? "" : " (switch branding on and save to use it)"}
              </Note>
            ) : null}
          </FormGroup>

          <div className={s.grid2}>
            {field("Default quote terms", "defaultQuoteTerms", { placeholder: "Valid for 30 days" })}
            {field("Default invoice terms", "defaultInvoiceTerms", { placeholder: "30 days" })}
          </div>
          <div className={s.grid2}>
            <Field label="Quote message (one line per row)" id="quote-message" hint="Printed at the foot of new quotes.">
              <Textarea rows={4} value={form.defaultCustomerMessage} onChange={set("defaultCustomerMessage")} />
            </Field>
            <Field label="Invoice message (one line per row)" id="invoice-message" hint="Printed at the foot of new invoices. It starts filled with the standard wording, built from your default invoice terms (30 days if they give no number of days): edit it to change it. If you clear it, the standard wording is still used. Invoices already issued keep the wording they were issued with.">
              <Textarea rows={4} value={form.defaultInvoiceMessage} onChange={set("defaultInvoiceMessage")} placeholder={defaultInvoiceMessage(form.defaultInvoiceTerms).join("\n")} />
            </Field>
          </div>

          <FormGroup as="fieldset" title="Bank details (printed on invoices)" columns={2} hint={`Printed in a "Payment details" block on invoices only, never on quotes. Only the boxes you fill in are printed; leave them all empty to print nothing. Invoices already issued print the bank details set here today.`} data-testid="bank-details">
            {bankField("Account name", "accountName", { autoComplete: "off" })}
            {bankField("Bank name", "bankName", { autoComplete: "off" })}
            {bankField("Sort code", "sortCode", { inputMode: "numeric", placeholder: "12-34-56", maxLength: 10, autoComplete: "off" })}
            {bankField("Account number", "accountNumber", { inputMode: "numeric", placeholder: "8 digits", maxLength: 12, autoComplete: "off" })}
            {bankField("IBAN (optional)", "iban", { autoComplete: "off" })}
            {bankField("BIC (optional)", "bic", { autoComplete: "off" })}
          </FormGroup>

          <div className={s.block}>
            <CheckRow checked={form.showCreditsInBalance} onChange={(checked) => edit({ showCreditsInBalance: checked })}>
              <span className={s.checkTitle}>Show credit notes in Balance due on invoice PDFs</span>
              <span className={s.checkHint}>Off: an invoice PDF is exactly as approved and ignores credit notes. On: Balance due is the total less payments and less the credit notes applied, with one &quot;Less credit notes&quot; line added beside the invoice number. Applies when a PDF is made, so an invoice reprinted after a credit shows it.</span>
            </CheckRow>
          </div>

          <FormGroup as="fieldset" title="Working hours" hint="Your normal working hours, day by day. On the schedule, a booking split by day shows each day's time as basic (inside that day's hours) or out of hours. It is only a label: any time can still be booked, and nothing works out pay." data-testid="working-hours">
            <div className={s.days} data-testid="working-hours-days">
              <div className={s.dayHead} aria-hidden="true"><span>Day</span><span>Start</span><span>Finish</span><span className={s.paidHead}>Paid</span></div>
              {WEEKDAY_OPTIONS.map((option) => {
                const iso = option.dow === 0 ? 7 : option.dow;
                const works = form.workDays.includes(iso);
                const day = form.workHours[iso];
                const paid = works && timeSettings ? paidDay(day.start, day.end, timeSettings) : null;
                const setDay = (patch: Partial<DayHours>) => edit({ workHours: { ...form.workHours, [iso]: { ...form.workHours[iso], ...patch } } });
                return (
                  <div key={iso} className={s.day} data-testid="working-hours-day">
                    <label className={s.dayWorks}>
                      <Checkbox checked={works} onChange={(event) => edit({ workDays: event.target.checked ? [...form.workDays.filter((d) => d !== iso), iso] : form.workDays.filter((d) => d !== iso) })} />
                      <span className={s.dayName}>{option.label}</span>
                      <span className={s.dayWorksWord}>Works</span>
                    </label>
                    <label className={s.dayTime}><span className={s.dayTimeLabel}>Start</span>
                      <Input type="time" aria-label={`${option.label} start`} disabled={!works} value={day.start} onChange={(event) => setDay({ start: event.target.value })} />
                    </label>
                    <label className={s.dayTime}><span className={s.dayTimeLabel}>Finish</span>
                      <Input type="time" aria-label={`${option.label} finish`} disabled={!works} value={day.end} onChange={(event) => setDay({ end: event.target.value })} />
                    </label>
                    <p className={s.dayPaid} data-testid="working-hours-day-paid">
                      {!works ? <span className={s.faint}>Not worked</span> : !timeSettings ? <span>Hours settings not loaded</span> : paid ? <>Paid {formatHoursMinutes(paid.paid)}</> : <span className={s.warnText}>Check times</span>}
                    </p>
                  </div>
                );
              })}
            </div>
            {timeSettings ? (
              <div className={s.weekBox} data-testid="working-hours-week">
                <p className={s.weekLine}>
                  Week: <span data-testid="working-hours-week-at-work">{formatHoursMinutes(week.atWork)}</span> at work,{" "}
                  <span data-testid="working-hours-week-breaks">{formatHoursMinutes(week.breaks)}</span> breaks,{" "}
                  <span data-testid="working-hours-week-paid">{formatHoursMinutes(week.paid)}</span> paid
                </p>
                <Note>{paidHoursExplanation(timeSettings)} Planned hours only; pay comes from clock records.</Note>
              </div>
            ) : <p role="status" className={s.note}>Load the Hours settings below to see planned paid hours.</p>}
            <Note>A finish of 00:00 means midnight.</Note>
          </FormGroup>

          {problem && !problem.fieldId ? <div ref={errorRef} tabIndex={-1} className={s.focusable}><Callout tone="error" lead="Problem" role="alert">{problem.message}</Callout></div> : null}
          <div className={s.saveRow}><Button variant="primary" size="lg" disabled={!ready} onClick={save}>Save company details</Button></div>
        </div>
      </fieldset>
    </Panel>
  );
}

/* ------------------------------------------------------------------ small cards ------------------------------------------------------------------ */

function ArchiveCard({ preview }: { preview: Preview }) {
  const [months, setMonths] = useState("12");
  const [error, setError] = useState<string | null>(null);
  function save() {
    const found = archiveProblem(months);
    setError(found);
    if (found) { document.getElementById("archive-months")?.focus(); return; }
    const value = Number(months);
    preview(`Finished records would move to Archived after ${value} month${value === 1 ? "" : "s"}.`);
  }
  return (
    <Panel title="Archive" data-testid="archive-card">
      <div className={s.stack}>
        <Lead>Finished jobs, decided quotes, paid invoices, received purchase orders, converted or closed sales orders and delivered notes move from <strong>Done</strong> to <strong>Archived</strong> after this long. Archived records are never deleted: they stay searchable, viewable and printable under Show &gt; Archived, and admin or office can archive or unarchive any record by hand.</Lead>
        <div className={s.inlineField}>
          <Field label="Archive after" id="archive-months" error={error ?? undefined} className={s.monthsField}>
            <Input aria-label="Archive after months" type="number" inputMode="numeric" min={1} max={120} step={1} value={months} onChange={(event) => { setMonths(event.target.value); setError(null); }} />
          </Field>
          <span className={s.unit}>months</span>
        </div>
        <div className={s.saveRow}><Button variant="primary" onClick={save}>Save archive setting</Button></div>
      </div>
    </Panel>
  );
}

function AutoConvertCard({ available, preview }: { available: boolean; preview: Preview }) {
  const on = true; // organization_settings.auto_convert_sales_orders: on unless it was explicitly set to false
  return (
    <Panel title="Quote to job" data-testid="auto-convert-card">
      <div className={s.stack}>
        <Lead>Accepting a quote creates its sales order. With this on, the sales order also creates its job straight away, as <strong>not started</strong>. With it off, the order waits on Sales Orders for <strong>Convert to Job</strong>.</Lead>
        {!available ? <Note>This setting isn&apos;t available yet.</Note> : (
          <SwitchBox><Switch label="Make the job automatically" checked={on} onChange={(checked) => preview(checked ? "Sales orders made from accepted quotes would become jobs automatically." : "Sales orders would wait for Convert to Job.")} /></SwitchBox>
        )}
      </div>
    </Panel>
  );
}

function HoursCard({ state, preview }: { state: States["hours"]; preview: Preview }) {
  const [t, setT] = useState<TimeSettings>(DEFAULT_TIME_SETTINGS);
  const loaded = state === "ready";
  const num = (key: keyof TimeSettings, label: string, step = 1, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" step={step} min={0} value={String(t[key])} onChange={(event) => setT({ ...t, [key]: Number(event.target.value) })} />
    </Field>
  );
  return (
    <Panel title="Hours" data-testid="hours-card">
      <div className={s.stack}>
        {state === "needs-update" ? <Callout tone="warn" lead="" role="status" data-testid="time-needs-update">{TIME_NEEDS_DATABASE_UPDATE}</Callout> : (
          <>
            <Lead>How Weekly hours works out paid time. Hours only: Tolra holds no pay rates. Overtime is not worked out: tick Overtime on the day.</Lead>
            <div className={s.block}>
              <CheckRow checked={t.breaksPaid} onChange={(checked) => setT({ ...t, breaksPaid: checked })}>
                <span className={s.checkTitle}>Breaks are paid</span>
                <span className={s.checkHintWarn}>Off: breaks are unpaid and deducted (JNR, confirmed Sun 18 Oct).</span>
              </CheckRow>
            </div>
            <div className={s.grid2}>
              {num("lunchMinutes", "Lunch (minutes)")}
              {num("breakMinutes", "Break (minutes)")}
              {num("breakMinDayHours", "Deduct breaks on days of at least (hours)", 0.25, "On those days the greater of lunch + break and the clocked breaks is deducted; on shorter days only clocked breaks.")}
              {num("longSessionHours", "Flag clock-ins or job time left running after (hours)")}
            </div>
            <div className={s.block}>
              <CheckRow checked={t.approverRoles.includes("office")} onChange={(checked) => setT({ ...t, approverRoles: checked ? ["admin", "office"] : ["admin"] })}>
                <span className={s.checkTitle}>Office can approve weekly hours too</span>
                <span className={s.checkHint}>Admins always can.</span>
              </CheckRow>
            </div>
            {state === "error" ? <Callout tone="error" lead="Problem" role="alert">Couldn&apos;t load the hours settings. Reload the page to try again.</Callout> : null}
            <div className={s.saveRow}><Button variant="primary" disabled={!loaded} onClick={() => preview("The hours settings would be saved.")}>Save hours settings</Button></div>
          </>
        )}
      </div>
    </Panel>
  );
}

function NetworkCard({ flags, preview }: { flags: Flags; preview: Preview }) {
  const networks = flags.networks ? SEED_NETWORKS : [];
  const here = flags.device === "unseen" ? { ip: null as string | null, private: null as boolean | null } : { ip: DEVICE_IPS[flags.device], private: flags.device === "private" };
  const onSaved = here.ip ? onSavedNetwork(here.ip, networks.map((n) => n.network)) : false;
  const mode: "off" | "flag" = flags.check ? "flag" : "off";
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [label, setLabel] = useState("");
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);
  return (
    <Panel title="Workshop network" data-testid="site-network-card">
      <div id="workshop-network" className={s.stack}>
        <Lead>
          A phone can&apos;t tell Tolra which Wi-Fi it is on. Tolra sees the public internet address a clock in comes from: every device on the
          site Wi-Fi shares the router&apos;s one address. With the check on <strong>Flag</strong>, clock actions of people marked{" "}
          <strong>On site only</strong> (Admin &gt; Users) that come from another network are flagged for the office. <strong>The Flag check never
          refuses; the network lock below does.</strong> Clock actions saved offline and synced later show &ldquo;synced later, network unknown&rdquo;. Off: nothing is checked
          or recorded. If the broadband provider changes the address, every check shows &ldquo;not on the site network&rdquo; until you save the
          new one: stand on the workshop Wi-Fi and click Use this network.
        </Lead>
        {flags.retention ? (
          <Lead>
            <span data-testid="site-network-retention">The internet address of each checked clock action is kept for {SITE_NETWORK_IP_RETENTION_DAYS} days, then deleted. Whether it was on
            the site network, and the flag, are kept. A new address is never trusted on its own: only the buttons below save a network.</span>
          </Lead>
        ) : null}
        <p className={s.here} data-testid="site-network-here">
          This device reaches Tolra from <span className={s.mono}>{here.ip ?? "an address Tolra can't see"}</span>
          {here.ip ? (onSaved ? ": a saved site network." : ": not a saved site network.") : "."}
        </p>
        <div className={s.subhead}>
          <h3 className={s.h3}>Saved site networks</h3>
          {networks.length ? (
            <ul className={s.netList}>
              {networks.map((n) => (
                <li key={n.id} className={s.netRow} data-testid="site-network-row">
                  {renaming?.id === n.id ? (
                    <div className={s.renameRow}>
                      <Input value={renaming.label} maxLength={SITE_NETWORK_LABEL_MAX} aria-label={`New name for ${n.label}`} data-testid="site-network-rename-input" onChange={(event) => setRenaming({ ...renaming, label: event.target.value })} />
                      <span className={s.mono}>{n.network}</span>
                    </div>
                  ) : <span className={s.netName}><span className={s.netLabel}>{n.label}</span> <span className={s.mono}>{n.network}</span></span>}
                  <span className={s.btnRow}>
                    {renaming?.id === n.id ? (
                      <>
                        <Button size="sm" variant="primary" disabled={!renaming.label.trim() || renaming.label.trim().length > SITE_NETWORK_LABEL_MAX} data-testid="site-network-rename-save" onClick={() => { preview(`${n.label} would be renamed to "${renaming.label.trim()}".`); setRenaming(null); }}>Save name</Button>
                        <Button size="sm" variant="secondary" onClick={() => setRenaming(null)}>Cancel</Button>
                      </>
                    ) : flags.canRename ? <Button size="sm" variant="secondary" aria-label={`Rename ${n.label}`} data-testid="site-network-rename" onClick={() => setRenaming({ id: n.id, label: n.label })}>Rename</Button> : null}
                    <Button size="sm" variant="dangerQuiet" aria-label={`Remove ${n.label}`} onClick={() => preview(`${n.label} would be removed.`)}>Remove</Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : <Note>None saved yet.</Note>}
        </div>
        <div className={s.addNet}>
          <Field label="Network name" optional className={s.netField}>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} placeholder="Name, e.g. Workshop" aria-label="Network name" />
          </Field>
          <Button variant="primary" disabled={!here.ip || here.private === true} data-testid="use-this-network" onClick={() => { preview(`This network (${here.ip}) would be saved${label.trim() ? ` as "${label.trim()}"` : ""}.`); setLabel(""); }}>Use this network</Button>
        </div>
        <SwitchBox>
          <div className={s.checkInRow}>
            <span className={s.checkInText}>
              <span className={s.checkTitle}>Check clock-ins: {mode === "flag" ? "Flag" : "Off"}</span>
              <span className={s.checkHint}>{networks.length ? "Flag only: never refuses a clock in." : "Save the site network first."}</span>
            </span>
            <Button size="sm" variant={mode === "flag" ? "secondary" : "primary"} disabled={mode === "off" && !networks.length} data-testid="site-network-switch"
              onClick={() => preview(mode === "flag" ? "The clock-in check would be turned off." : "Clock-ins would be checked (flag only).")}>
              {mode === "flag" ? "Turn off" : "Turn on (flag only)"}
            </Button>
          </div>
        </SwitchBox>
        {flags.retention ? (
          <div className={s.purgeRow}>
            <span className={s.note}>Kept clock-in addresses: older than {SITE_NETWORK_IP_RETENTION_DAYS} days are deleted automatically.</span>
            <span className={s.btnRow}>
              <Button size="sm" variant="secondary" data-testid="site-network-purge-expired" onClick={() => preview("Expired addresses would be deleted.")}>Delete expired addresses</Button>
              <Button size="sm" variant="danger" data-testid="site-network-purge-all" onClick={() => setConfirmPurgeAll(true)}>Delete all</Button>
            </span>
          </div>
        ) : null}
      </div>
      <Dialog
        open={confirmPurgeAll}
        title="Delete every kept clock-in address?"
        description={`This deletes the internet address of every checked clock action in this company, including those from the last ${SITE_NETWORK_IP_RETENTION_DAYS} days. Whether each one was on the site network, and its flag, are kept. Deleted addresses can't be brought back.`}
        confirmLabel="Delete all addresses"
        cancelLabel="Keep them"
        onClose={() => setConfirmPurgeAll(false)}
        onConfirm={() => { setConfirmPurgeAll(false); preview("All kept addresses would be deleted."); }}
      />
    </Panel>
  );
}

function ClockLockCard({ flags, preview }: { flags: Flags; preview: Preview }) {
  const [confirm, setConfirm] = useState<"lock" | "unlock" | null>(null);
  const saved = flags.networks ? SEED_NETWORKS.map((n) => n.network) : [];
  const here = flags.device === "unseen" ? { ip: null as string | null, network: null as string | null, private: null as boolean | null } : { ip: DEVICE_IPS[flags.device], network: `${DEVICE_IPS[flags.device]}/32`, private: flags.device === "private" };
  const lock = flags.locked ? LOCK_SEED : null;
  const canCapture = Boolean(here.ip) && here.private !== true;
  const fromHere = lock && here.ip ? clockInLockDecision({ lockedNetwork: lock.network, savedNetworks: saved, source: "clock", deviceAt: null, receivedAt: new Date(), ip: here.ip, offSiteAllowed: false }) : null;
  const lockFamily = lock?.network.includes(":") ? "IPv6" : "IPv4";
  const lockedBy = lock?.locked_by ?? UNKNOWN;
  return (
    <Panel title="Clock-in network lock" data-testid="clock-in-lock-card">
      <div className={s.stack}>
        <Lead>
          Lock clock-in to the network this device is on now (e.g. press it on John&apos;s office PC on the workshop Wi-Fi). Everyone clocks in
          from this network unless an admin marks them as able to clock in off site (Admin &gt; Users: <strong>Can clock in off site</strong>).
          While locked, clocking in, clocking out and breaks from anywhere other than this network or a saved site network above are{" "}
          <strong>refused</strong>. The office or an admin can still add or correct time on the sheet. A clock action saved offline and synced later can&apos;t prove where it was made: it is
          kept and shown as &ldquo;network not checked&rdquo; in Weekly hours. If the broadband address changes, clock-ins are refused until you
          re-capture here: ask the provider for a fixed (static) address first.
        </Lead>
        {flags.offSite ? <Note><span data-testid="clock-in-lock-off-site">{flags.offSite === 1 ? "1 person" : `${flags.offSite} people`} can clock in off site.</span></Note> : null}
        <p className={s.here} data-testid="clock-in-lock-here">
          This device reaches Tolra from <span className={s.mono}>{here.ip ?? "an address Tolra can't see"}</span>
          {fromHere ? (fromHere.decision === "refused" ? ": not the locked network (a clock-in from here would be refused)." : ": clock-ins from here go in.") : "."}
        </p>
        {lock ? (
          <div className={s.lockBox}>
            <span data-testid="clock-in-lock-state">
              Locked to <span className={s.mono}>{lock.network}</span> ({lockFamily}) since {fmtDateTime(lock.locked_at)} by {lockedBy}.
              <span className={s.checkHint} data-testid="clock-in-lock-family">
                Locked to {lock.network} ({lockFamily}). If your broadband also uses the other kind of address, add it under Site network
                above, or press Re-capture from a device on that address.
              </span>
            </span>
            <span className={s.btnRow}>
              <Button size="sm" variant="secondary" disabled={!canCapture} data-testid="clock-in-lock-recapture" onClick={() => setConfirm("lock")}>Re-capture</Button>
              <Button size="sm" variant="secondary" data-testid="clock-in-lock-unlock" onClick={() => setConfirm("unlock")}>Unlock</Button>
            </span>
          </div>
        ) : (
          <div className={s.lockBox}>
            <span data-testid="clock-in-lock-state">Unlocked: clock-in works from any network.</span>
            <Button size="sm" variant="primary" disabled={!canCapture} data-testid="clock-in-lock-button" onClick={() => setConfirm("lock")}>Lock clock-in to this network</Button>
          </div>
        )}
      </div>
      <Dialog
        open={confirm === "lock"}
        title={lock ? "Re-capture the clock-in network?" : "Lock clock-in to this network?"}
        description={`Clock-in will be locked to ${here.network ?? "this device's network"}${lock ? ` instead of ${lock.network}` : ""}. Everyone not marked as able to clock in off site can then clock in only from it (or a saved site network). Only do this on the workshop network.`}
        confirmLabel={lock ? "Re-capture" : "Lock"}
        onClose={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); preview(lock ? "The clock-in network would be re-captured." : "Clock-in would be locked to this network."); }}
      />
      <Dialog
        open={confirm === "unlock"}
        title="Unlock clock-in?"
        description="Everyone can then clock in from any network again."
        confirmLabel="Unlock"
        onClose={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); preview("Clock-in would be unlocked."); }}
      />
    </Panel>
  );
}

function SignOffCard({ available, preview }: { available: boolean; preview: Preview }) {
  const on = false; // organization_settings.customer_signoff_enabled: off by default
  return (
    <Panel title="Customer sign-off" data-testid="signoff-card">
      <div className={s.stack}>
        <Lead>With this on, each job&apos;s worksheet has a <strong>Customer sign off</strong> box: the fitter hands their phone to the customer, who prints their name, signs and can add a comment. It works offline and uploads once back online, and it prints on the job worksheet. Sign-offs already recorded stay on their jobs if you turn it off.</Lead>
        {!available ? <Note>This setting isn&apos;t available yet.</Note> : (
          <SwitchBox><Switch label="Customer sign-off on jobs" checked={on} onChange={(checked) => preview(checked ? "Customers would be able to sign off jobs on site." : "Customer sign-off on jobs would be off.")} /></SwitchBox>
        )}
      </div>
    </Panel>
  );
}

/** The three Job reports switches and the ISO switch: all OFF by default (markers absent from hidden_nav). */
export const JOB_REPORT_ROWS = ["Planned vs actual machine time on job worksheets", "NCR register", "Reports page"] as const;
export const ISO_LABEL = "ISO 9001 draft templates";

function JobReportsCard({ preview }: { preview: Preview }) {
  return (
    <Panel title="Job reports" data-testid="job-reports-card">
      <div className={s.stack}>
        <Lead>All are off until you switch them on. They only read records Tolra already keeps, and are shown to admin and office.</Lead>
        <div className={s.switchList}>
          {JOB_REPORT_ROWS.map((label) => (
            <SwitchBox key={label}><Switch label={label} checked={false} onChange={(checked) => preview(`${label} would be switched ${checked ? "on" : "off"}.`)} /></SwitchBox>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function IsoCard({ preview }: { preview: Preview }) {
  return (
    <Panel title={ISO_LABEL} data-testid="iso-switch-card">
      <div className={s.stack}>
        <Lead>Off until you switch it on. Draft documents and a self-check list for your own review. They only read records Tolra already keeps. Admin only.</Lead>
        <SwitchBox><Switch label={ISO_LABEL} checked={false} onChange={(checked) => preview(`${ISO_LABEL} would be switched ${checked ? "on" : "off"}.`)} /></SwitchBox>
      </div>
    </Panel>
  );
}

function PrintLayoutCard({ source, preview }: { source: States["print"]; preview: Preview }) {
  const company: CompanyPrintLayout | null = source === "loading" ? null
    : source === "saved" ? resolvePrintLayout({ stored: "basic", slug: COMPANY_SLUG })
    : source === "default" ? resolvePrintLayout({ stored: null, slug: COMPANY_SLUG })
    : resolvePrintLayout(null);
  return (
    <Panel title="Print layout" data-testid="print-layout-card">
      <div className={s.stack}>
        <Lead>The layout the job worksheet and the workshop pack print in. <strong>Basic</strong> is a plain job sheet: job number, customer, description, quantity, dates, an operations and notes area and sign-off boxes. <strong>JNR sheet</strong> is the full JNR worksheet (material cert, heat / cast, machines, part checklist). Anyone printing can still pick the other layout on the print page.</Lead>
        <Lead>The JNR sheet prints material cert, heat/cast, machines and the part checklist; Basic prints only the traceability numbers, and only on traceable jobs.</Lead>
        {company === null ? <Note>Loading…</Note> : (
          <>
            <div className={s.layoutRow}>
              <Field label="Print layout" id="print-layout" className={s.layoutField}>
                <Select data-testid="print-layout-setting" value={company.layout} onChange={(event) => preview(`Worksheets would print in the ${printLayoutLabel(event.target.value as PrintLayout)} layout.`)}>
                  {PRINT_LAYOUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
              </Field>
            </div>
            <Note><span data-print-layout-source={company.source}>{printLayoutStatus(company)}</span></Note>
          </>
        )}
      </div>
    </Panel>
  );
}

function YearEndCard({ preview }: { preview: Preview }) {
  const thisYear = new Date().getFullYear();
  const [from, setFrom] = useState(`${thisYear - 1}-01-01`);
  const [to, setTo] = useState(`${thisYear - 1}-12-31`);
  const [error, setError] = useState<string | null>(null);
  const pickYear = (year: number) => { setFrom(`${year}-01-01`); setTo(`${year}-12-31`); setError(null); };
  function run() {
    const found = exportProblem(from, to);
    setError(found);
    if (found) { document.getElementById("export-from")?.focus(); return; }
    preview("The year-end export would be built and downloaded. No file was made.");
  }
  return (
    <Panel title="Year-end export" data-testid="year-end-card">
      <div className={s.stack}>
        <Lead>One zip with the PDF of every issued invoice, sent quote, purchase order and delivery note in the period, plus <strong>summary.csv</strong> (opens in Excel: number, date, customer, net, VAT, gross, paid, balance due, paid date) and <strong>payments.csv</strong> (every payment recorded on those invoices). An invoice whose payment amount is not known is left blank and listed in problems.txt. Drafts are left out. The export is logged.</Lead>
        <div className={s.btnRow} role="group" aria-label="Pick a year">{[thisYear, thisYear - 1, thisYear - 2].map((year) => <Button key={year} size="sm" variant="secondary" onClick={() => pickYear(year)}>{year}</Button>)}</div>
        <div className={s.rangeRow}>
          <Field label="From" id="export-from" error={error ?? undefined}><Input aria-label="Export from" type="date" value={from} invalid={!!error} onChange={(event) => { setFrom(event.target.value); setError(null); }} /></Field>
          <Field label="To" id="export-to"><Input aria-label="Export to" type="date" value={to} invalid={!!error} onChange={(event) => { setTo(event.target.value); setError(null); }} /></Field>
        </div>
        <div className={s.saveRow}><Button variant="primary" onClick={run}>Download year-end export</Button></div>
      </div>
    </Panel>
  );
}

function AiCard({ preview }: { preview: Preview }) {
  return (
    <Panel title="AI" data-testid="ai-helper-settings-link">
      <div className={s.stack}>
        <Lead>Switch AI on or off in Integrations. The monthly limit and your company&apos;s own Anthropic key are in the AI section.</Lead>
        <div className={s.btnRow}>
          <Button variant="secondary" onClick={() => preview("This would open Integrations.")}>Open Integrations</Button>
          <Button variant="secondary" onClick={() => preview("This would open the AI section.")}>Open the AI section</Button>
        </div>
      </div>
    </Panel>
  );
}

function WorkshopEmailCard({ preview }: { preview: Preview }) {
  const [email, setEmail] = useState("workshop@fernhill.example");
  const [error, setError] = useState<string | null>(null);
  function save() {
    const found = emailProblem(email);
    setError(found);
    if (found) { document.getElementById("workshop-email")?.focus(); return; }
    preview("The workshop email would be saved.");
  }
  return (
    <Panel title="Workshop Email Settings" data-testid="workshop-email-card">
      <div className={s.stack}>
        <Field label="Workshop Email" id="workshop-email" error={error ?? undefined} hint="Pre-filled when you send a job sheet to the workshop. Saved on your own account; it applies after you next sign in.">
          <Input type="email" placeholder="workshop@yourcompany.co.uk" value={email} onChange={(event) => { setEmail(event.target.value); setError(null); }} />
        </Field>
        <Callout tone="neutral" lead="" role="note"><strong>Email Sender</strong>{" "}Email sending from your own domain isn&apos;t set up yet. Until it is, job emails are saved as drafts.</Callout>
        <div className={s.saveRow}><Button variant="primary" onClick={save}>Save Settings</Button></div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ Costing rates ------------------------------------------------------------------ */

const entered = (v: string): number | null => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
let rowCounter = 0;
const newRowId = () => `new-${++rowCounter}`;
export const COSTING_LOAD_ERROR = "Couldn't load the costing rates. Try again.";

function CostingCard({ state, preview }: { state: States["costing"]; preview: Preview }) {
  const [rates, setRates] = useState<CostingRates>(state === "blank" ? blankCostingRates : SEED_COSTING);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<States["costing"]>(state);
  const change = (patch: Partial<CostingRates>) => { setRates({ ...rates, ...patch }); setNotice(null); };
  const modifyMaterial = (id: string, patch: Partial<CostingRates["materials"][number]>) => change({ materials: rates.materials.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const modifyMachine = (id: string, patch: Partial<CostingRates["machines"][number]>) => change({ machines: rates.machines.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const modifyDefaults = (patch: Partial<CostingRates["defaults"]>) => change({ defaults: { ...rates.defaults, ...patch } });
  const gaps = ratesGaps(rates);
  const num = (name: string, value: number | null, update: (n: number | null) => void, label: string, step = "0.01") => (
    <Field label={name}><Input aria-label={label} type="number" min="0" step={step} value={value ?? ""} onChange={(event) => update(entered(event.target.value))} /></Field>
  );
  function save() {
    const problem = ratesProblem(rates);
    if (problem) { setNotice(problem); return; }
    setNotice(null);
    preview("The costing rates would be saved.");
  }
  return (
    <Panel title="Costing rates" busy={view === "loading"} data-testid="costing-card">
      <div id="setup-costing" className={s.stack}>
        {view === "loading" ? <p className={s.note}>Loading costing rates…</p> : null}
        {view === "not-applied" ? <Callout tone="neutral" lead="" role="status">{COSTING_NOT_APPLIED}</Callout> : null}
        {view === "error" ? (
          <Callout tone="error" lead="Problem" role="alert" action={<Button size="sm" variant="secondary" onClick={() => { setView("loading"); window.setTimeout(() => { setView("ready"); preview("Sample costing rates would be loaded again. No request was made."); }, 700); }}>Try again</Button>}>{COSTING_LOAD_ERROR}</Callout>
        ) : null}
        {view === "ready" || view === "blank" ? (
          <>
            <Lead>All prices are in pounds. Enter your own materials, machines and rates: nothing is filled in for you, and quotes can only be priced from what you enter here.</Lead>
            {gaps.blank
              ? <Callout tone="warn" lead="" role="status">{NOT_SET_UP_MESSAGE}</Callout>
              : gaps.missing.length > 0 ? <Callout tone="warn" lead="" role="status">Still to enter: {gaps.missing.join(", ")}.</Callout> : null}
            <h3 className={s.h3}>Materials</h3>
            {rates.materials.map((m, i) => (
              <div key={m.id} className={s.costRow5}>
                <Field label="Material"><Input aria-label={`Material name, row ${i + 1}`} placeholder="Material name" maxLength={80} value={m.name} onChange={(event) => modifyMaterial(m.id, { name: event.target.value })} /></Field>
                <Field label="Priced"><Select aria-label={`Material unit, row ${i + 1}`} value={m.unit} onChange={(event) => modifyMaterial(m.id, { unit: event.target.value as "kg" | "each" })}><option value="kg">Per kg</option><option value="each">Each</option></Select></Field>
                {num("Price £", m.price, (price) => modifyMaterial(m.id, { price }), `Price £, material row ${i + 1}`)}
                {num("Scrap %", m.scrapPct, (scrapPct) => modifyMaterial(m.id, { scrapPct }), `Scrap %, material row ${i + 1}`)}
                <div className={s.rowEnd}><Button variant="dangerQuiet" onClick={() => change({ materials: rates.materials.filter((x) => x.id !== m.id) })}>Remove material</Button></div>
              </div>
            ))}
            <div><Button variant="secondary" onClick={() => change({ materials: [...rates.materials, { id: newRowId(), name: "", unit: "kg", price: null, scrapPct: null }] })}>Add material</Button></div>
            <h3 className={s.h3}>Machines</h3>
            {rates.machines.map((m, i) => (
              <div key={m.id} className={s.costRow4}>
                <Field label="Machine"><Input aria-label={`Machine name, row ${i + 1}`} placeholder="Machine name" maxLength={80} value={m.name} onChange={(event) => modifyMachine(m.id, { name: event.target.value })} /></Field>
                {num("Machine £ per hour", m.hourlyRate, (hourlyRate) => modifyMachine(m.id, { hourlyRate }), `Machine £ per hour, row ${i + 1}`)}
                {num("Labour £ per hour (optional)", m.labourPerHour, (labourPerHour) => modifyMachine(m.id, { labourPerHour }), `Machine labour £ per hour (optional), row ${i + 1}`)}
                <div className={s.rowEnd}><Button variant="dangerQuiet" onClick={() => change({ machines: rates.machines.filter((x) => x.id !== m.id) })}>Remove machine</Button></div>
              </div>
            ))}
            <div><Button variant="secondary" onClick={() => change({ machines: [...rates.machines, { id: newRowId(), name: "", hourlyRate: null, labourPerHour: null }] })}>Add machine</Button></div>
            <h3 className={s.h3}>Company rates</h3>
            <div className={s.grid2}>
              {num("Labour £ per hour", rates.defaults.labourPerHour, (labourPerHour) => modifyDefaults({ labourPerHour }), "Labour £ per hour")}
              {num("Programming £ per hour", rates.defaults.programmingPerHour, (programmingPerHour) => modifyDefaults({ programmingPerHour }), "Programming £ per hour")}
              {num("Overhead %", rates.defaults.overheadPct, (overheadPct) => modifyDefaults({ overheadPct }), "Overhead %")}
              {num("Margin %", rates.defaults.marginPct, (marginPct) => modifyDefaults({ marginPct }), "Margin %")}
            </div>
            <Note>Overhead % is charged on machine and labour time: 100 means none, 150 means half as much again. Margin % is added on top of cost. A machine&apos;s own labour rate, if you give one, replaces the company labour rate for that machine.</Note>
            {notice ? <Callout tone="error" lead="Problem" role="alert">{notice}</Callout> : null}
            <div className={s.saveRow}><Button variant="primary" onClick={save}>Save costing rates</Button></div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ Email schedules (and payment chasing) ------------------------------------------------------------------ */

const KINDS: EmailScheduleKind[] = ["invoice_reminder", "timesheet"];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
export const CHASE_LOAD_ERROR = "Could not load payment chasing. Ask the person who looks after Tolra to check the setup.";

function ChaseSteps({ state, preview }: { state: States["chase"]; preview: Preview }) {
  const prefix = useId();
  const nextId = useRef(DEFAULT_CHASE_STEPS.length);
  const [rows, setRows] = useState(() => DEFAULT_CHASE_STEPS.map((step, id) => ({ id, days: String(step.offset_days), tone: step.tone as ChaseTone })));
  const [error, setError] = useState("");
  if (state === "loading") return <p role="status" className={s.note}>Loading payment chasing…</p>;
  if (state === "error") return <p role="status" className={s.note}>{CHASE_LOAD_ERROR}</p>;
  const changed = () => setError("");
  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    changed();
    const found = chaseProblem(rows);
    if (found) { setError(found); return; }
    preview("The chase steps would be saved.");
  }
  return (
    <div className={s.chase} data-testid="chase-steps">
      <Note data-testid="chase-steps-suggested">The steps below are suggestions. Save them to start using them.</Note>
      <form onSubmit={save} className={s.stack} aria-label="Payment chasing settings" noValidate>
        <h3 className={s.h4}>Payment chasing</h3>
        <Lead>Choose when to chase an invoice. Use a negative number for days before the due date, 0 for the due date, and a positive number for days after.</Lead>
        <Callout tone="neutral" lead="" role="note">Chasers are drafts for approval. You check and approve each email before it is sent.</Callout>
        {rows.length === 0 ? <Note>No chase steps. Add a step to start chasing.</Note> : null}
        {rows.map((row, index) => (
          <div key={row.id} data-testid="chase-step" className={s.chaseRow}>
            <Field label={`Days from due date — step ${index + 1}`} id={`${prefix}-${row.id}-days`}>
              <Input type="number" step="1" value={row.days} onChange={(event) => { changed(); setRows((current) => current.map((item) => (item.id === row.id ? { ...item, days: event.target.value } : item))); }} />
            </Field>
            <Field label={`Tone — step ${index + 1}`} id={`${prefix}-${row.id}-tone`}>
              <Select value={row.tone} onChange={(event) => { changed(); setRows((current) => current.map((item) => (item.id === row.id ? { ...item, tone: event.target.value as ChaseTone } : item))); }}>
                {Object.entries(CHASE_TONE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
            <div className={s.rowEnd}><Button variant="dangerQuiet" aria-label={`Remove step ${index + 1}`} onClick={() => { changed(); setRows((current) => current.filter((item) => item.id !== row.id)); }}>Remove</Button></div>
          </div>
        ))}
        {error ? <Callout tone="error" lead="Problem" role="alert">{error}</Callout> : null}
        <div className={s.btnRow}>
          <Button variant="secondary" onClick={() => { changed(); const id = nextId.current++; setRows((current) => [...current, { id, days: "7", tone: "friendly" }]); }}>Add step</Button>
          <Button type="submit" variant="primary">Save chase steps</Button>
        </div>
      </form>
    </div>
  );
}

function ScheduleEditor({ kind, chase, preview }: { kind: EmailScheduleKind; chase: States["chase"]; preview: Preview }) {
  const [form, setForm] = useState<ScheduleForm>(() => defaultForm(kind));
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const labels = SCHEDULE_LABELS[kind];
  const set = (patch: Partial<ScheduleForm>) => { setForm((f) => ({ ...f, ...patch })); setError(null); };
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const line = useMemo(() => nextRunLine(kind, form, now), [kind, form, now]);
  const id = (name: string) => `email-schedule-${kind}-${name}`;
  function save() {
    const made = patchFromForm(kind, form, new Date());
    if (!made.ok) { setError(made.error); return; }
    preview(`${labels.title} would be saved.`);
  }
  return (
    <section className={s.schedule} aria-label={labels.title} data-testid={`email-schedule-${kind}`}>
      <Switch label={`${labels.title}`} hint={labels.blurb} checked={form.enabled} onChange={(enabled) => set({ enabled })} />
      <div className={s.gridSchedule}>
        <Field label="How often" id={id("frequency")}>
          <Select value={form.frequency} onChange={(event) => set({ frequency: event.target.value as EmailScheduleFrequency })}>
            {labels.frequencies.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
          </Select>
        </Field>
        {form.frequency === "weekly" ? (
          <Field label="Day" id={id("weekday")}>
            <Select value={form.weekday} onChange={(event) => set({ weekday: Number(event.target.value) })}>
              {WEEKDAYS.map((d) => <option key={d} value={d}>{weekdayName(d)}</option>)}
            </Select>
          </Field>
        ) : null}
        {form.frequency === "once" ? (
          <Field label="Date" id={id("date")}><Input type="date" value={form.onceDate} onChange={(event) => set({ onceDate: event.target.value })} /></Field>
        ) : null}
        <Field label="Time of day" id={id("time")}><Input type="time" value={form.time} onChange={(event) => set({ time: event.target.value })} /></Field>
      </div>
      {kind === "timesheet" ? (
        <Field label="Send to" id={id("recipients")} hint="One address per line, or separated by commas. Each person's timesheet is sent as its own e-mail.">
          <Textarea rows={2} placeholder="Leave empty to send to every admin of this company" value={form.recipients} onChange={(event) => set({ recipients: event.target.value })} />
        </Field>
      ) : (
        <Note>Each reminder is drafted for the invoice&apos;s customer, at the e-mail address on their customer record, and waits in the Approval Queue for you to approve. Customers without an address are skipped.</Note>
      )}
      <p className={s.nextRun} data-testid={`email-schedule-${kind}-next`} role="status">{line}</p>
      {error ? <Callout tone="error" lead="Problem" role="alert">{error}</Callout> : null}
      <div className={s.saveRow}><Button variant="primary" aria-label={`Save ${labels.title}`} onClick={save}>Save</Button></div>
      {kind === "invoice_reminder" ? <ChaseSteps state={chase} preview={preview} /> : null}
    </section>
  );
}

function SchedulesCard({ state, chase, preview }: { state: States["schedules"]; chase: States["chase"]; preview: Preview }) {
  return (
    <Panel title="Email schedules" busy={state === "loading"} data-testid="email-schedules-card">
      <div className={s.stack}>
        {state === "loading" ? <Note>Loading...</Note> : null}
        {state === "not-applied" ? <Callout tone="warn" lead="" role="status">{SCHEDULE_NOT_AVAILABLE}</Callout> : null}
        {state === "error" ? <Callout tone="error" lead="Problem" role="alert">Couldn&apos;t load the e-mail schedules. Reload the page to try again.</Callout> : null}
        {state === "ready" ? (
          <>
            <Lead>Set when Tolra sends reminders and timesheets for you. All times are UK time. {EXACT_TIME_SENDING ? "" : DAILY_RUN_NOTE} Nothing is sent until you turn a schedule on.</Lead>
            {KINDS.map((kind) => <ScheduleEditor key={kind} kind={kind} chase={chase} preview={preview} />)}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ Email templates ------------------------------------------------------------------ */

/** What the editor shows for `key`: the unsaved draft, else the company's saved text, else the default. */
export function editorText(key: TemplateKey, drafts: Partial<Record<TemplateKey, TemplateText>>, overrides: Partial<Record<TemplateKey, TemplateText>>): TemplateText {
  return drafts[key] ?? overrides[key] ?? { subject: DEFAULT_TEMPLATES[key].subject, body: DEFAULT_TEMPLATES[key].body };
}

function DetailField({ id, label, hint, value, allowed, onChange, singleLine = false }: { id: string; label: string; hint: string; value: string; allowed: readonly string[]; onChange: (value: string) => void; singleLine?: boolean }) {
  const cursor = useRef({ index: 0, position: 0 });
  const [choice, setChoice] = useState(allowed[0] ?? "");
  const parts = detailParts(value);
  return (
    <fieldset className={s.detail}>
      <legend className={s.detailLegend}>{label}</legend>
      <p className={s.detailHint}>{hint}</p>
      <div className={s.detailBox}>
        {parts.map((part, index) => part.kind === "detail"
          ? (
            <span key={index} className={s.chip}>{detailLabel(part.name)}
              <button type="button" className={s.chipX} aria-label={`Remove ${detailLabel(part.name)} from ${label}`} onClick={() => onChange(detailText(parts.filter((_, i) => i !== index)))}>×</button>
            </span>
          )
          : (
            <textarea key={index} id={index === 0 ? id : undefined} aria-label={`${label} text ${index + 1}`} rows={singleLine ? 1 : 3} value={part.text} className={s.detailText}
              onSelect={(event) => { cursor.current = { index, position: event.currentTarget.selectionStart }; }}
              onFocus={(event) => { cursor.current = { index, position: event.currentTarget.selectionStart }; }}
              onChange={(event) => { const next = [...parts]; next[index] = { kind: "text", text: singleLine ? event.target.value.replace(/[\r\n\u2028\u2029]+/g, " ") : event.target.value }; onChange(detailText(next)); }} />
          ))}
      </div>
      {allowed.length > 0 ? (
        <div className={s.insertRow}>
          <label className={s.insertLabel}><span>Insert detail into {label}</span>
            <Select aria-label={`Detail for ${label}`} value={choice} onChange={(event) => setChoice(event.target.value)}>{allowed.map((name) => <option key={name} value={name}>{detailLabel(name)}</option>)}</Select>
          </label>
          <Button size="sm" variant="secondary" onClick={() => onChange(insertDetail(value, cursor.current.index, cursor.current.position, choice, allowed))}>Add detail</Button>
        </div>
      ) : null}
    </fieldset>
  );
}

function TemplateEditor({ templateKey, value, custom, dirty, onChange, onSave, onReset, problem }: {
  templateKey: TemplateKey; value: TemplateText; custom: boolean; dirty: boolean; onChange: (next: TemplateText) => void; onSave: () => void; onReset: () => void; problem: string | null;
}) {
  const definition = DEFAULT_TEMPLATES[templateKey];
  const preview = renderTemplate(templateKey, TEMPLATE_SAMPLE_VARS, value);
  const unknown = unknownPlaceholders(`${value.subject}\n${value.body}`);
  const id = `email-template-${templateKey}`;
  const [sections, setSections] = useState(() => emailSections(value.body));
  const ownBody = useRef(value.body);
  useEffect(() => {
    if (value.body !== ownBody.current) { ownBody.current = value.body; setSections(emailSections(value.body)); }
  }, [value.body]);
  function editSection(section: keyof EmailSections, text: string) {
    const next = { ...sections, [section]: text };
    const body = sectionsBody(next);
    ownBody.current = body;
    setSections(next);
    onChange({ ...value, body });
  }
  return (
    <Disclosure
      data-testid={id}
      summary={<span className={s.tplSummary}><span className={s.tplName}>{definition.label}</span><span className={cx(s.tplState, custom && s.tplCustom)}>{custom ? "Your own text" : "Default text"}{dirty ? " (unsaved changes)" : ""}</span></span>}
    >
      <p className={s.tplUsed}>{definition.usedFor}</p>
      <div className={s.tplGrid}>
        <div className={s.tplEdit}>
          <DetailField id={`${id}-subject`} label="Subject line" hint="The short heading people see in their inbox." value={value.subject} singleLine allowed={definition.placeholders} onChange={(subject) => onChange({ ...value, subject })} />
          <DetailField id={`${id}-greeting`} label="Greeting" hint="How you say hello. Add a customer or contact name with Add detail." value={sections.greeting} allowed={definition.placeholders} onChange={(text) => editSection("greeting", text)} />
          <DetailField id={`${id}-body`} label="Main message" hint="What you want to say. Use Add detail for the amount, due date, document number or job." value={sections.message} allowed={definition.placeholders} onChange={(text) => editSection("message", text)} />
          <DetailField id={`${id}-signoff`} label="Sign-off" hint="How you finish the email, including your company name if you want it." value={sections.signoff} allowed={definition.placeholders} onChange={(text) => editSection("signoff", text)} />
          <p className={s.note}>Subject: {value.subject.length} of {SUBJECT_MAX} characters. Message: {value.body.length} of {BODY_MAX} characters.</p>
          {unknown.length ? <Callout tone="warn" lead="" role="alert">Not a placeholder this e-mail fills in, so it will show as typed: {unknown.map((name) => `{{${name}}}`).join(" ")}</Callout> : null}
          {problem ? <Callout tone="error" lead="Problem" role="alert">{problem}</Callout> : null}
          <div className={s.btnRow}>
            <Button variant="primary" disabled={!dirty} onClick={onSave}>Save</Button>
            <Button variant="secondary" disabled={!custom && !dirty} onClick={onReset}>Reset to default</Button>
          </div>
        </div>
        <div className={s.tplPreview} aria-live="polite">
          <p className={s.previewHead}>Preview (example details)</p>
          <div className={s.mail}>
            <p className={s.mailSubject} data-testid={`${id}-preview-subject`}>{preview.subject}</p>
            <p className={s.mailBody} data-testid={`${id}-preview-body`}>{preview.text}</p>
          </div>
        </div>
      </div>
    </Disclosure>
  );
}

function TemplatesCard({ state, preview }: { state: States["templates"]; preview: Preview }) {
  const [drafts, setDrafts] = useState<Partial<Record<TemplateKey, TemplateText>>>({});
  const [problems, setProblems] = useState<Partial<Record<TemplateKey, string>>>({});
  const clearProblem = (key: TemplateKey) => setProblems((current) => { const next = { ...current }; delete next[key]; return next; });
  function save(key: TemplateKey) {
    const found = templateProblem(editorText(key, drafts, SEED_OVERRIDES));
    if (found) { setProblems((current) => ({ ...current, [key]: found })); return; }
    clearProblem(key);
    preview(`${DEFAULT_TEMPLATES[key].label} template would be saved.`);
  }
  function reset(key: TemplateKey) {
    // As on the real page: with no saved text the draft is simply dropped (no request); with saved text the reset would be a request, so it only answers.
    if (!SEED_OVERRIDES[key]) { setDrafts((current) => { const next = { ...current }; delete next[key]; return next; }); clearProblem(key); return; }
    preview(`${DEFAULT_TEMPLATES[key].label} template would be reset to default.`);
  }
  return (
    <Panel title="Email templates" busy={state === "loading"} data-testid="email-templates-card">
      <div id="setup-email" className={s.stack}>
        <Lead>Write each part in its own box. Use Add detail to insert names, amounts and dates without typing markers. The preview shows example details as you type. Saved templates keep the same format and still need approval before sending when approval is required.</Lead>
        {state === "loading" ? <p className={s.note} role="status">Loading templates...</p> : null}
        {state === "not-applied" ? <Callout tone="warn" lead="" role="status">{TEMPLATES_NOT_APPLIED_MESSAGE} Until then every e-mail uses its default text.</Callout> : null}
        {state === "error" ? <Callout tone="error" lead="Problem" role="alert">Couldn&apos;t load the e-mail templates. Reload the page to try again.</Callout> : null}
        {state === "ready" ? (
          <div className={s.tplList}>
            {TEMPLATE_KEYS.map((key) => {
              const value = editorText(key, drafts, SEED_OVERRIDES);
              const saved = SEED_OVERRIDES[key] ?? { subject: DEFAULT_TEMPLATES[key].subject, body: DEFAULT_TEMPLATES[key].body };
              return (
                <TemplateEditor key={key} templateKey={key} value={value} custom={Boolean(SEED_OVERRIDES[key])} dirty={value.subject !== saved.subject || value.body !== saved.body}
                  problem={problems[key] ?? null} onChange={(next) => { clearProblem(key); setDrafts((current) => ({ ...current, [key]: next })); }} onSave={() => save(key)} onReset={() => reset(key)} />
              );
            })}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ Menu sections and Display ------------------------------------------------------------------ */

const navSections = Array.from(new Set(NAV_TOGGLES.map((item) => item.section)));
export const SALES_ORDERS_NOTE = "Off to start with. Accepted quotes still make their order and job in the background.";

function MenuCard({ preview }: { preview: Preview }) {
  /** The company's hidden_nav list: nothing hidden, and the Sales Orders marker absent (Sales Orders is off until an admin switches it on). */
  const hiddenNav: string[] = [];
  return (
    <Panel title="Menu Sections" data-testid="menu-sections-card">
      <div className={s.stack}>
        <Lead>Turn off sections you do not use. Hidden items disappear from the sidebar for everyone in the organisation. Dashboard and Settings are always shown.</Lead>
        {navSections.map((section) => (
          <div key={section} className={s.menuGroup}>
            <h3 className={s.h3}>{section}</h3>
            <div className={s.grid2}>
              {NAV_TOGGLES.filter((item) => item.section === section).map((item) => {
                const visible = item.key === SALES_ORDERS_KEY ? salesOrdersEnabled(hiddenNav) : !hiddenNav.includes(item.key);
                return (
                  <SwitchBox key={item.key}>
                    <Switch label={item.label} hint={item.key === SALES_ORDERS_KEY ? SALES_ORDERS_NOTE : undefined} checked={visible} data-key={item.key}
                      onChange={(checked) => preview(`${item.label} would be ${checked ? "shown in" : "hidden from"} the menu for everyone in the organisation.`)} />
                  </SwitchBox>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function DisplayCard({ hidden, preview }: { hidden: Record<string, string[]>; preview: Preview }) {
  const reset = (screenKeys: string[] | undefined, label: string) => {
    const cleared = resetPlan(hidden, screenKeys);
    if (!cleared.length) return; // the real page does nothing when nothing is hidden
    preview(`${label === "all" ? "Every screen" : label} would be reset to its default columns.`);
  };
  return (
    <Panel title="Display" data-testid="display-card">
      <div className={s.stack} data-testid="display-settings">
        <div className={s.displayHead}>
          <Lead>Choose what each screen shows. Changes apply to everyone in this company. Locked items are always shown. Admin and office users can also change these from the Columns button on each screen.</Lead>
          <Button variant="secondary" size="sm" onClick={() => reset(undefined, "all")}>Reset all to default</Button>
        </div>
        {screensByGroup().map(({ group, screens }) => (
          <section key={group} aria-label={`${group} screens`} className={s.displayGroup}>
            <h3 className={s.h3}>{group}</h3>
            <div className={s.screenList}>
              {screens.map((table) => {
                const current = hidden[table.key] ?? [];
                const { shown, total } = shownCount(table, current);
                return (
                  <Disclosure
                    key={table.key}
                    data-testid={`display-screen-${table.key}`}
                    summary={
                      <span className={s.screenSummary}>
                        <span className={s.screenText}><span className={s.screenName}>{table.label}</span><span className={s.screenDesc}>{table.description}</span></span>
                        <span className={cx(s.screenCount, current.length > 0 && s.screenCountChanged)} data-testid={`display-count-${table.key}`}>{shown} of {total} shown</span>
                      </span>
                    }
                  >
                    <div className={s.screenTools}>
                      <Button variant="secondary" size="sm" disabled={current.length === 0} aria-label={`Reset ${table.label} to default`} onClick={() => reset([table.key], table.label)}>Reset to default</Button>
                    </div>
                    <div className={s.colGrid}>
                      {table.columns.map((column) => {
                        const visible = column.locked || !current.includes(column.key);
                        return (
                          <CheckRow key={column.key} checked={visible} disabled={column.locked} onChange={(checked) => preview(`${column.label} would be ${checked ? "shown" : "hidden"} on ${table.label}.`)}>
                            <span className={s.colLabel}>{column.label}{column.locked ? <span className={s.alwaysShown}> (always shown)</span> : null}</span>
                          </CheckRow>
                        );
                      })}
                    </div>
                  </Disclosure>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ the page ------------------------------------------------------------------ */

function Dock({ role, setRole, states, setStates, flags, setFlags, reset }: { role: Role; setRole: (r: Role) => void; states: States; setStates: (s: States) => void; flags: Flags; setFlags: (f: Flags) => void; reset: () => void }) {
  const pick = <K extends keyof States>(key: K, label: string, options: Array<[States[K], string]>) => (
    <label className={s.dockSelect}><span>{label}</span>
      <Select value={states[key] as string} onChange={(event) => setStates({ ...states, [key]: event.target.value as States[K] })}>{options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}</Select>
    </label>
  );
  const flag = (key: keyof Flags, label: string, hint?: string) => (
    <Switch label={label} hint={hint} checked={flags[key] as boolean} onChange={(on) => setFlags({ ...flags, [key]: on })} data-testid={`dock-${key}`} />
  );
  return (
    <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
      <div className={s.dock}>
        <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated, nothing is granted and no request is made.</p>
        <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
        <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={setRole} />
        <p className={s.dockLabel}>Page and card states</p>
        {pick("page", "Page", [["ready", "Ready"], ["checking", "Checking access"], ["local-only", "Company settings unavailable"]])}
        {pick("company", "Company details", [["ready", "Ready"], ["loading", "Loading"], ["not-set-up", "Not set up yet"]])}
        {pick("hours", "Hours", [["ready", "Ready"], ["loading", "Not loaded yet"], ["needs-update", "Database update needed"], ["error", "Failed to load"]])}
        {pick("costing", "Costing rates", [["ready", "Rates entered"], ["blank", "No rates entered yet"], ["loading", "Loading"], ["not-applied", "Database update needed"], ["error", "Failed to load"]])}
        {pick("schedules", "Email schedules", [["ready", "Ready"], ["loading", "Loading"], ["not-applied", "Database update needed"], ["error", "Failed to load"]])}
        {pick("chase", "Payment chasing steps", [["ready", "Ready"], ["loading", "Loading"], ["error", "Failed to load"]])}
        {pick("templates", "Email templates", [["ready", "Ready"], ["loading", "Loading"], ["not-applied", "Database update needed"], ["error", "Failed to load"]])}
        {pick("autoConvert", "Quote to job", [["available", "Available"], ["unavailable", "Not available yet"]])}
        {pick("signOff", "Customer sign-off", [["available", "Available"], ["unavailable", "Not available yet"]])}
        {pick("print", "Print layout", [["default", "Not chosen yet"], ["saved", "Chosen by an admin"], ["fallback", "Could not be read"], ["loading", "Loading"]])}
        <p className={s.dockLabel}>Company and database features</p>
        {flag("ai", "AI helper on this server", "Off by default: the AI card is hidden until it is on.")}
        {flag("has075", "Database has 075", "Workshop network card.")}
        {flag("has114", "Database has 114", "Clock-in network lock card.")}
        {flag("retention", "Database has 078", "Kept-address retention.")}
        {flag("canRename", "Database has 128", "Rename a saved network.")}
        {flag("logo", "Company has a logo")}
        {flag("hidden", "Company has hidden some columns")}
        {flag("networks", "Site network saved")}
        {flag("check", "Clock-in check on (Flag)")}
        {flag("locked", "Clock-in locked")}
        <label className={s.dockSelect}><span>This device reaches Tolra from</span>
          <Select value={flags.device} onChange={(event) => setFlags({ ...flags, device: event.target.value as DeviceNet })}>
            <option value="saved">The saved site network</option><option value="other">Another network</option><option value="private">A private address</option><option value="unseen">An address Tolra cannot see</option>
          </Select>
        </label>
        <Button size="sm" variant="secondary" onClick={reset}>Reset preview</Button>
      </div>
    </Popover>
  );
}

function SettingsScreen() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [states, setStatesRaw] = useState<States>(INITIAL_STATES);
  const [flags, setFlags] = useState<Flags>(INITIAL_FLAGS);
  const preview: Preview = useCallback((detail) => toast.show({ title: "Preview only", detail: `${detail} ${NOT_SAVED}` }), [toast]);
  const setStates = (next: States) => { toast.clear(); setStatesRaw(next); };
  const denied = !canUseSettings(role);
  const timeSettings = states.hours === "ready" ? DEFAULT_TIME_SETTINGS : null;
  const hidden = flags.hidden ? SEED_HIDDEN : {};

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="settings-preview" data-role={role}>
      <header className={s.head}>
        <div className={s.titleBlock}>
          <div className={s.titleLine}>
            <h1 className={s.title}>{denied ? "Access Denied" : "Settings"}</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">{PREVIEW_TAG}</span>
            <Dock role={role} setRole={(r) => { toast.clear(); setRole(r); }} states={states} setStates={setStates} flags={flags} setFlags={(f) => { toast.clear(); setFlags(f); }} reset={() => { toast.clear(); setRole("admin"); setStatesRaw(INITIAL_STATES); setFlags(INITIAL_FLAGS); }} />
          </div>
          <p className={s.subtitle}>{denied ? "Redirecting you back to the dashboard." : `Company-wide settings for ${PRODUCT.name}. Only admins can change them.`}</p>
        </div>
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <p className={s.deniedNote}>Preview only: no redirect happens here. Settings is for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : states.page === "checking" ? (
        <LoadingState label="Checking your access" rows={5} />
      ) : (
        <>
          {states.page === "local-only" ? <Callout tone="warn" lead="" role="status" data-testid="local-only-banner">Company settings aren&apos;t available right now. Menu and column choices are saved in this browser only.</Callout> : null}
          <div id="setup-company"><CompanyDetails key={`company-${states.company}-${states.hours}`} state={states.company} timeSettings={timeSettings} hasLogo={flags.logo} preview={preview} /></div>
          <ArchiveCard preview={preview} />
          <AutoConvertCard key={`convert-${states.autoConvert}`} available={states.autoConvert === "available"} preview={preview} />
          <div id="setup-breaks"><HoursCard key={states.hours} state={states.hours} preview={preview} /></div>
          {flags.has075 ? <NetworkCard flags={flags} preview={preview} /> : null}
          {flags.has075 && flags.has114 ? <ClockLockCard flags={flags} preview={preview} /> : null}
          <SignOffCard available={states.signOff === "available"} preview={preview} />
          <JobReportsCard preview={preview} />
          <IsoCard preview={preview} />
          <PrintLayoutCard source={states.print} preview={preview} />
          <YearEndCard preview={preview} />
          {flags.ai ? <AiCard preview={preview} /> : null}
          <CostingCard key={`costing-${states.costing}`} state={states.costing} preview={preview} />
          <SchedulesCard key={`schedules-${states.schedules}-${states.chase}`} state={states.schedules} chase={states.chase} preview={preview} />
          <MenuCard preview={preview} />
          <DisplayCard hidden={hidden} preview={preview} />
          <WorkshopEmailCard preview={preview} />
          <TemplatesCard key={`templates-${states.templates}`} state={states.templates} preview={preview} />
        </>
      )}
    </div>
  );
}

export default function SettingsPreview() {
  return (
    <ToastProvider placement="bottom-right">
      <SettingsScreen />
    </ToastProvider>
  );
}
