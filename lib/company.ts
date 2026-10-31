/**
 * Single source of truth for the details of the company that issues documents.
 * Everything that prints company information (PDFs, print pages, worksheets,
 * email sign-offs) must read from here rather than hard-coding strings.
 *
 * Each organisation stores its own profile in organization_settings.company_profile
 * (see supabase/migrations/006_production_hardening.sql). Documents must use the
 * signed-in organisation's profile; JNR's details below are only the seed for
 * JNR's own organisation and the demo-mode fallback.
 */

import { useEffect, useState } from "react";

import { type BankDetails, EMPTY_BANK_DETAILS, parseBankDetails } from "@/lib/bank-details";
import { companyLogoUrl, isHexColour } from "@/lib/branding";
import type { ShellBrand } from "@/lib/brand-pending";
import { announceCompanyChanged } from "@/lib/company-sync";
import { DEMO_MODE } from "@/lib/demo";
import { type PrintLayout, parsePrintLayout, withStoredPrintLayout } from "@/lib/print-layout";
import { supabase } from "@/lib/supabase";

export type CompanyProfile = {
  key: string;
  /** Short trading name used in the app UI and email sign-offs. */
  name: string;
  /** Name exactly as it is printed at the top of customer documents. */
  documentName: string;
  addressLines: string[];
  phone: string;
  fax: string;
  email: string;
  website: string;
  vatNumber: string;
  /** VAT registered: documents can carry VAT. Off = no document gets VAT and no VAT number is printed. Default on. */
  vatRegistered: boolean;
  /** Standard rate for new document lines and carriage, e.g. 20. */
  defaultVatRate: number;
  /** Brand colours (#rrggbb, or "" for the product default), used on the branded sign-in page. */
  brandPrimary: string;
  brandAccent: string;
  /** One line under the company name on the sign-in page. */
  loginTagline: string;
  /** Show this organisation's logo, colours and tagline at /login?org=<slug>. Off by default: nothing about the
   *  organisation is public until an admin switches it on. */
  brandedLogin: boolean;
  /** Sign-in page look: "light" (default) or "dark" (website style: dark page, display headline, eyebrow). */
  loginStyle: "light" | "dark";
  /** Small uppercase line above the headline on the dark sign-in page, e.g. "CNC machining and fabrication, Hamilton". */
  loginEyebrow: string;
  /** Square PNG (512px or more) for the installed app / home-screen icon and favicon: "<organization_id>/<file>".
   *  Empty: the logo is used, then the product icon. */
  appIconPath: string;
  /** Object path of the uploaded logo in the private org-logos bucket: "<organization_id>/<file>". */
  logoPath: string;
  /** The logo, ready for PDFs (data: URL). Only set when logoPath is inside the signed-in organisation's folder. */
  logoSrc?: string;
  /** The logo at a cacheable URL for the app's own pages (app/api/company-logo). Only set when logoPath is inside the signed-in
   *  organisation's folder; the route serves it only to a session working in that organisation. */
  logoUrl?: string;
  defaultQuoteTerms: string;
  defaultInvoiceTerms: string;
  /** Closing lines printed on quotes. */
  defaultCustomerMessage: string[];
  /** Closing lines printed on invoices; empty = the default wording built from the invoice terms (defaultInvoiceMessage()). */
  defaultInvoiceMessage: string[];
  /** Bank details printed in a "Payment details" block on invoices (never quotes); every field empty = nothing printed. */
  bankDetails: BankDetails;
  /**
   * Off unless an admin switches it on. When on, an invoice's PDF takes the credit notes applied to it off its Balance due
   * (and says so on one extra line in the box beside the invoice number); when off, the PDF is exactly the approved layout and
   * figures. Read from the CURRENT profile when the PDF is made, not from the issue-time snapshot: credits arrive after issue.
   */
  showCreditsInBalance: boolean;
  /** The company's normal working hours ("HH:MM", local time) and days (ISO weekday numbers, Mon = 1 ... Sun = 7). Used only to label
   *  time on a booking split by day as basic or out of hours: it never blocks a plan and is never used to calculate pay. */
  workStart: string;
  workEnd: string;
  workDays: number[];
  /** Each worked day's own hours, keyed by ISO weekday (Mon = 1 ... Sun = 7); only worked days are present, an end of "24:00" is midnight.
   *  Optional: a profile saved before per-day hours has none, and every work day then uses workStart..workEnd. Whenever it is saved,
   *  workStart/workEnd/workDays are saved with it (the earliest start, the latest end, the worked days) so older readers keep working. */
  workHoursByDay?: Record<number, DayHours>;
  /** The job worksheet print layout an admin chose (Settings > Print layout; lib/print-layout). Absent: never chosen, so the company's
   *  default applies. saveCompanyProfile keeps whatever the stored row holds, even while the rest of the profile is incomplete. */
  printLayout?: PrintLayout;
};

/** One day's working hours ("HH:MM"; an end of "24:00" is midnight). */
export type DayHours = { start: string; end: string };

export type WorkingHours = Pick<CompanyProfile, "workStart" | "workEnd" | "workDays" | "workHoursByDay">;

/** Used whenever a company hasn't set its working hours (or what is stored can't be read): 08:00 to 16:00, Monday to Friday. */
export const DEFAULT_WORKING_HOURS: WorkingHours = { workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5] };

/** Minutes after midnight of "HH:MM" (00:00 to 23:59, or 24:00 when `allowMidnightEnd`); null when it isn't that. */
export function clockMinutes(value: unknown, allowMidnightEnd = false): number | null {
  if (typeof value !== "string") return null;
  if (allowMidnightEnd && value === "24:00") return 1440;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A day's hours when `value` is a start and an end that are valid "HH:MM" with the end after the start; otherwise null. */
function validDayHours(value: unknown): DayHours | null {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const start = clockMinutes(v.start);
  const end = clockMinutes(v.end, true);
  return start !== null && end !== null && end > start ? { start: v.start as string, end: v.end as string } : null;
}

/**
 * Reads working hours leniently from a stored profile: a start and end that are valid "HH:MM" with the end after the start, and a
 * non-empty list of ISO weekdays. A pair of times that isn't valid falls back to the default pair, an unreadable day list to the default days.
 * Per-day hours (workHoursByDay) are read only when stored: each worked day keeps its own valid entry, and a day whose entry is missing or
 * invalid uses workStart..workEnd. A profile with no per-day hours reads exactly as before (no workHoursByDay).
 */
export function parseWorkingHours(value: unknown): WorkingHours {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const start = clockMinutes(v.workStart);
  const end = clockMinutes(v.workEnd, true);
  const times = start !== null && end !== null && end > start ? { workStart: v.workStart as string, workEnd: v.workEnd as string } : { workStart: DEFAULT_WORKING_HOURS.workStart, workEnd: DEFAULT_WORKING_HOURS.workEnd };
  const days = Array.isArray(v.workDays) && v.workDays.length && v.workDays.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)
    ? Array.from(new Set(v.workDays as number[])).sort((a, b) => a - b)
    : [...DEFAULT_WORKING_HOURS.workDays];
  const stored = v.workHoursByDay && typeof v.workHoursByDay === "object" && !Array.isArray(v.workHoursByDay) ? (v.workHoursByDay as Record<string, unknown>) : null;
  if (!stored) return { ...times, workDays: days };
  const workHoursByDay: Record<number, DayHours> = {};
  for (const day of days) workHoursByDay[day] = validDayHours(stored[day]) ?? { start: times.workStart, end: times.workEnd };
  return { ...times, workDays: days, workHoursByDay };
}

/** The hours of one ISO weekday (Mon = 1 ... Sun = 7): null when it isn't a work day, else its own hours, else workStart..workEnd. */
export function hoursForDay(hours: WorkingHours, isoDay: number | null): DayHours | null {
  if (isoDay === null || !hours.workDays.includes(isoDay)) return null;
  return validDayHours(hours.workHoursByDay?.[isoDay]) ?? { start: hours.workStart, end: hours.workEnd };
}

/** When a day starts: its own start on a work day, otherwise the general workStart. */
export function workStartOn(hours: WorkingHours, isoDay: number | null): string {
  return hoursForDay(hours, isoDay)?.start ?? hours.workStart;
}

/**
 * The profile fields to save from per-day hours (only the worked days): workHoursByDay as given, and the older fields derived from it so
 * older code and readers still work: workDays = the worked days, workStart = the earliest start, workEnd = the latest end.
 * Returns null when no day is worked. The caller has already checked each day.
 */
export function workingHoursToSave(byDay: Record<number, DayHours>): Required<Pick<WorkingHours, "workStart" | "workEnd" | "workDays" | "workHoursByDay">> | null {
  const workDays = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  if (!workDays.length) return null;
  const starts = workDays.map((d) => clockMinutes(byDay[d].start) ?? 0);
  const ends = workDays.map((d) => clockMinutes(byDay[d].end, true) ?? 0);
  const workStart = byDay[workDays[starts.indexOf(Math.min(...starts))]].start;
  const workEnd = byDay[workDays[ends.indexOf(Math.max(...ends))]].end;
  const workHoursByDay: Record<number, DayHours> = {};
  for (const d of workDays) workHoursByDay[d] = { start: byDay[d].start, end: byDay[d].end };
  return { workStart, workEnd, workDays, workHoursByDay };
}

/** The working hours of a loaded profile, or the defaults when there is none. */
export function workingHoursOf(profile: Partial<WorkingHours> | null | undefined): WorkingHours {
  return parseWorkingHours(profile ?? {});
}

/** Days used when a company's invoice terms hold no whole number of days ("On receipt", "End of month", empty). */
export const FALLBACK_TERMS_DAYS = 30;

/**
 * The whole number of days in a free-text terms string: "30 days" and "14" give that number, "Net 60" and "60 days from invoice"
 * give 60 (the first number wins). No number, or 0 ("On receipt", "End of month"), gives FALLBACK_TERMS_DAYS.
 */
export function parseTermsDays(terms: string | null | undefined): number {
  const match = /\d+/.exec(terms ?? "");
  const days = match ? Number(match[0]) : 0;
  return Number.isSafeInteger(days) && days > 0 ? days : FALLBACK_TERMS_DAYS;
}

/** The default invoice message, one sentence per line, built from the invoice terms. No bank details: they print in their own block. */
export function defaultInvoiceMessage(terms: string | null | undefined): string[] {
  const days = parseTermsDays(terms);
  return [
    `Payment is due within ${days} ${days === 1 ? "day" : "days"} of the invoice date.`,
    "Please quote the invoice number as your payment reference.",
    "Thank you for your business.",
  ];
}

/**
 * The closing lines for an invoice: the company's own invoice message when it has one (it always wins, unchanged), otherwise the
 * default built from `terms` (the invoice's own terms) or, without those, the company's invoice terms.
 */
export function invoiceMessage(company: Pick<CompanyProfile, "defaultInvoiceMessage" | "defaultInvoiceTerms">, terms?: string | null): string[] {
  return company.defaultInvoiceMessage.length ? company.defaultInvoiceMessage : defaultInvoiceMessage(terms || company.defaultInvoiceTerms);
}

export const COMPANY_PROFILES = {
  jnr: {
    key: "jnr",
    name: "JNR Engineering Ltd",
    documentName: "J N R Engineering Ltd",
    addressLines: ["Unit 1", "Example Industrial Estate", "Northfield", "ML3 1AA"],
    phone: "01698 000 0000",
    fax: "01698 000 0001",
    email: "info@jnr.example",
    website: "www.jnrengineering.co.uk",
    vatNumber: "GB000000000",
    vatRegistered: true,
    defaultVatRate: 20,
    brandPrimary: "",
    brandAccent: "",
    loginTagline: "",
    brandedLogin: false,
    loginStyle: "light",
    loginEyebrow: "",
    appIconPath: "",
    logoPath: "",
    defaultQuoteTerms: "Valid for 7 days",
    defaultInvoiceTerms: "30 days",
    defaultCustomerMessage: [
      "Quotations are valid for 7 days.",
      "Quotation is based on all parts being ordered.",
      "Please use Quote # as Ref",
    ],
    defaultInvoiceMessage: [],
    bankDetails: EMPTY_BANK_DETAILS,
    showCreditsInBalance: false,
    workStart: "08:00",
    workEnd: "16:00",
    workDays: [1, 2, 3, 4, 5],
  },
} as const satisfies Record<string, Omit<CompanyProfile, "addressLines" | "defaultCustomerMessage" | "defaultInvoiceMessage" | "workDays"> & { addressLines: readonly string[]; defaultCustomerMessage: readonly string[]; defaultInvoiceMessage: readonly string[]; workDays: readonly number[] }>;

export type CompanyKey = keyof typeof COMPANY_PROFILES;

const REQUIRED: Array<keyof CompanyProfile> = ["documentName", "addressLines"];

/** Builds a full profile from a stored jsonb value; returns null when required fields are missing. */
export function parseCompanyProfile(value: unknown): CompanyProfile | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  const list = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).map(String).filter(Boolean) : []);
  const profile: CompanyProfile = {
    key: str("key") || "org",
    name: str("name") || str("documentName"),
    documentName: str("documentName") || str("name"),
    addressLines: list("addressLines"),
    phone: str("phone"),
    fax: str("fax"),
    email: str("email"),
    website: str("website"),
    vatNumber: str("vatNumber"),
    vatRegistered: v.vatRegistered !== false,
    defaultVatRate: typeof v.defaultVatRate === "number" && Number.isFinite(v.defaultVatRate) && v.defaultVatRate >= 0 && v.defaultVatRate <= 100 ? v.defaultVatRate : 20,
    brandPrimary: isHexColour(v.brandPrimary) ? v.brandPrimary.toLowerCase() : "",
    brandAccent: isHexColour(v.brandAccent) ? v.brandAccent.toLowerCase() : "",
    loginTagline: str("loginTagline").slice(0, 120),
    brandedLogin: v.brandedLogin === true,
    loginStyle: v.loginStyle === "dark" ? "dark" : "light",
    loginEyebrow: str("loginEyebrow").slice(0, 80),
    appIconPath: str("appIconPath"),
    logoPath: str("logoPath"),
    defaultQuoteTerms: str("defaultQuoteTerms") || "Valid for 30 days",
    defaultInvoiceTerms: str("defaultInvoiceTerms") || "30 days",
    defaultCustomerMessage: list("defaultCustomerMessage"),
    defaultInvoiceMessage: list("defaultInvoiceMessage"),
    bankDetails: parseBankDetails(v.bankDetails),
    showCreditsInBalance: v.showCreditsInBalance === true,
    ...parseWorkingHours(v),
    ...(parsePrintLayout(v.printLayout) ? { printLayout: parsePrintLayout(v.printLayout) as PrintLayout } : {}),
  };
  const complete = REQUIRED.every((k) => (Array.isArray(profile[k]) ? (profile[k] as string[]).length > 0 : Boolean(profile[k])))
    // A VAT-registered company must print its VAT number.
    && (!profile.vatRegistered || Boolean(profile.vatNumber));
  return complete ? profile : null;
}

/** Demo mode only. No logo is bundled with the app: every organisation uploads its own (Settings > Company details). */
export const JNR_PROFILE: CompanyProfile = {
  ...COMPANY_PROFILES.jnr,
  addressLines: [...COMPANY_PROFILES.jnr.addressLines],
  defaultCustomerMessage: [...COMPANY_PROFILES.jnr.defaultCustomerMessage],
  defaultInvoiceMessage: [...COMPANY_PROFILES.jnr.defaultInvoiceMessage],
  bankDetails: { ...COMPANY_PROFILES.jnr.bankDetails },
  workDays: [...COMPANY_PROFILES.jnr.workDays],
};

export const LOGO_BUCKET = "org-logos";

/** True when `path` is an object inside this organisation's own folder of the logo bucket. */
export function isOwnLogoPath(organizationId: string | null | undefined, path: string | null | undefined) {
  return Boolean(organizationId && path && path.startsWith(`${organizationId}/`) && !path.includes(".."));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Downloads the organisation's logo as a data: URL for react-pdf. Anything outside the organisation's own
 * folder is ignored, and storage RLS only serves the signed-in organisation's folder, so a document can never
 * carry another company's logo. Any failure means "no logo": documents then print the company name.
 */
export async function loadOrgLogo(organizationId: string | null | undefined, path: string): Promise<string | undefined> {
  if (!supabase || !isOwnLogoPath(organizationId, path)) return undefined;
  try {
    const { data, error } = await supabase.storage.from(LOGO_BUCKET).download(path);
    if (error || !data) throw error ?? new Error("Logo not found");
    return await blobToDataUrl(data);
  } catch (err) {
    console.error("[company] logo could not be loaded", err);
    return undefined;
  }
}

/**
 * Writes the organisation's company profile (never the resolved logo image or its URL) and reloads it. The print layout is saved on
 * its own (Settings > Print layout, lib/print-layout) and is kept from the stored row, which can hold it even while the rest of the
 * profile is incomplete (parseCompanyProfile null): this save merges it back rather than replacing it.
 */
export async function saveCompanyProfile(organizationId: string, next: Omit<CompanyProfile, "logoSrc">) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: stored, error: readError } = await supabase.from("organization_settings").select("company_profile").eq("organization_id", organizationId).maybeSingle();
  if (readError) throw readError;
  const { error } = await supabase
    .from("organization_settings")
    .upsert({ organization_id: organizationId, company_profile: withStoredPrintLayout(next, (stored as { company_profile?: unknown } | null)?.company_profile), updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
  if (error) throw error;
  await loadCompanyProfile(true);
  // The other open tabs hold the old copy until they load again: tell them (lib/company-sync.ts).
  announceCompanyChanged();
}

export function storedProfile(profile: CompanyProfile): Omit<CompanyProfile, "logoSrc"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { logoSrc, logoUrl, ...rest } = profile;
  return rest;
}

let active: CompanyProfile | null = null;
let loaded = false;
let loadFailed = false;
let loadPromise: Promise<CompanyProfile | null> | null = null;
/** What the shell wears until the full profile has loaded (primeShellBrand): the server's name, colours and logo URL, nothing else. */
let provisional: ShellCompany | null = null;
/** primeShellBrand works once per page load, and never after a reset (the page is about to be left). */
let primed = false;
const listeners = new Set<() => void>();

export class CompanyProfileMissingError extends Error {
  constructor() {
    super("Company details aren't set up yet. An admin can add them in Settings > Company details.");
  }
}

/** The profile could not be read (network or database error), as opposed to not being set up. */
export class CompanyProfileLoadError extends Error {
  constructor() {
    super("Couldn't load company details. Try again.");
  }
}

/** Loads the signed-in organisation's profile once per page load. A failed load is not cached: the next call retries. */
export function loadCompanyProfile(force = false): Promise<CompanyProfile | null> {
  if (loadPromise && !force) return loadPromise;
  let failed = false;
  loadPromise = (async () => {
    try {
      if (!supabase) return DEMO_MODE ? JNR_PROFILE : null;
      const { data, error } = await supabase.from("organization_settings").select("organization_id, company_profile").maybeSingle();
      if (error) throw error;
      const profile = parseCompanyProfile(data?.company_profile);
      if (!profile) return DEMO_MODE ? JNR_PROFILE : null;
      return { ...profile, logoUrl: companyLogoUrl(data?.organization_id, profile.logoPath), logoSrc: await loadOrgLogo(data?.organization_id, profile.logoPath) };
    } catch (err) {
      console.error(err);
      failed = true;
      return DEMO_MODE ? JNR_PROFILE : null;
    }
  })().then((profile) => {
    loadFailed = failed;
    if (failed) loadPromise = null;
    active = profile;
    loaded = !failed;
    listeners.forEach((fn) => fn());
    return profile;
  });
  return loadPromise;
}

/** The few fields the app shell (sidebar, top bar, colours) shows. */
export type ShellCompany = Pick<CompanyProfile, "name" | "brandPrimary" | "brandAccent" | "logoUrl" | "logoSrc">;

/**
 * Holds the brand the server read for this session (app/(dashboard)/layout.tsx: as the signed-in user, under RLS, and only the name,
 * colours and logo URL) so the shell shows the company's name, colours and logo on its first paint instead of a placeholder while the
 * full profile loads. It is NOT the company profile: getCompanyProfile, requireCompanyProfile and useCompanyProfile never see it, and
 * the full profile is always read by the browser as before. Once per page load, never after a reset.
 */
export function primeShellBrand(brand: ShellBrand) {
  // Browser only: on the server this module's state would be shared by every request (and so every company).
  if (typeof window === "undefined" || primed) return;
  primed = true;
  provisional = { name: brand.name, brandPrimary: brand.brandPrimary, brandAccent: brand.brandAccent, logoUrl: brand.logoUrl };
}

/** Call on sign-out so the next user in this tab can't see the previous organisation's details. */
export function resetCompanyProfile() {
  active = null;
  loaded = false;
  loadFailed = false;
  loadPromise = null;
  provisional = null;
  primed = true;
  listeners.forEach((fn) => fn());
}

/**
 * Synchronous accessor for document builders. Throws CompanyProfileMissingError
 * when the organisation has no complete profile, so no document is ever printed
 * with another company's name or VAT number. Await loadCompanyProfile() first
 * (or use useCompanyProfile) before calling it.
 */
export function getCompanyProfile(): CompanyProfile {
  if (active) return active;
  if (DEMO_MODE) return JNR_PROFILE;
  throw new CompanyProfileMissingError();
}

/** Like getCompanyProfile but awaits loading first. Use in download/print handlers. */
export async function requireCompanyProfile(): Promise<CompanyProfile> {
  let profile = loaded ? active : await loadCompanyProfile();
  if (!profile && loadFailed) profile = await loadCompanyProfile();
  if (profile) return profile;
  if (DEMO_MODE) return JNR_PROFILE;
  throw loadFailed ? new CompanyProfileLoadError() : new CompanyProfileMissingError();
}

export function useCompanyProfile() {
  const [state, setState] = useState<{ profile: CompanyProfile | null; loading: boolean }>({ profile: active, loading: !loaded && !loadFailed });
  useEffect(() => {
    const sync = () => setState({ profile: active, loading: !loaded && !loadFailed });
    listeners.add(sync);
    void loadCompanyProfile().then(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  return state;
}

/**
 * What the shell shows: the full profile once it has loaded, and until then the server's brand (primeShellBrand) if there is one.
 * Only the shell uses this; everything that prints or edits company details uses useCompanyProfile.
 */
export function useShellCompany(): { profile: ShellCompany | null; loading: boolean } {
  const { profile, loading } = useCompanyProfile();
  return pickShellCompany(profile, loading, provisional);
}

/** The full profile once it has loaded (found or not); until then the held brand, if any, and the shell no longer shows its placeholder. */
export function pickShellCompany(profile: ShellCompany | null, loading: boolean, held: ShellCompany | null): { profile: ShellCompany | null; loading: boolean } {
  return loading && held ? { profile: held, loading: false } : { profile, loading };
}

/** The brand held for the shell (primeShellBrand), or null. */
export const getShellBrand = (): ShellCompany | null => provisional;

/** "Tel/ Fax" line as printed in the document footer. */
export function companyTelFax(company: CompanyProfile) {
  return `${company.phone}/ ${company.fax}`;
}

/** Document footer contact rows that have something to show: no empty "Email:" or "Website:" labels (audit D26). */
export function footerContactRows(company: Pick<CompanyProfile, "phone" | "fax" | "email" | "website" | "vatRegistered" | "vatNumber">): Array<[string, string]> {
  const has = (value: string | null | undefined) => Boolean(value && value.trim());
  const rows: Array<[string, string]> = [];
  if (has(company.phone) && has(company.fax)) rows.push(["Tel/ Fax:", `${company.phone.trim()}/ ${company.fax.trim()}`]);
  else if (has(company.phone)) rows.push(["Tel:", company.phone.trim()]);
  else if (has(company.fax)) rows.push(["Fax:", company.fax.trim()]);
  if (has(company.email)) rows.push(["Email:", company.email.trim()]);
  if (has(company.website)) rows.push(["Website:", company.website.trim()]);
  if (company.vatRegistered !== false && has(company.vatNumber)) rows.push(["VAT:", String(company.vatNumber).trim()]);
  return rows;
}
