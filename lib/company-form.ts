import { type BankDetails, EMPTY_BANK_DETAILS } from "@/lib/bank-details";
import { DEFAULT_WORKING_HOURS, type CompanyProfile, type DayHours, clockMinutes, hoursForDay, invoiceMessage, workingHoursToSave } from "@/lib/company";

export type CompanyForm = {
  name: string; documentName: string; addressLines: string; phone: string; fax: string; email: string; website: string; vatNumber: string;
  logoPath: string; defaultQuoteTerms: string; defaultInvoiceTerms: string; defaultCustomerMessage: string; defaultInvoiceMessage: string;
  /** Bank details printed on invoices. */
  bank: BankDetails;
  showCreditsInBalance: boolean;
  vatRegistered: boolean; defaultVatRate: string;
  brandPrimary: string; brandAccent: string; loginTagline: string; brandedLogin: boolean; loginStyle: "light" | "dark"; loginEyebrow: string;
  /** The ISO weekdays that are worked (Mon = 1 ... Sun = 7), and every weekday's start and end (type="time" values; an end of "00:00" is
   *  midnight, stored "24:00"). A day that isn't worked keeps its times so ticking it again brings them back. */
  workDays: number[]; workHours: Record<number, DayHours>;
};

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** All seven weekdays' hours for the form: a worked day its own hours, any other day the general start and end. */
function formWorkHours(profile: Pick<CompanyProfile, "workStart" | "workEnd" | "workDays" | "workHoursByDay">): Record<number, DayHours> {
  const out: Record<number, DayHours> = {};
  for (const day of ISO_DAYS) {
    const d = hoursForDay(profile, day) ?? { start: profile.workStart, end: profile.workEnd };
    out[day] = { start: d.start, end: d.end === "24:00" ? "00:00" : d.end };
  }
  return out;
}

const DAY_FULL_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * The working-hours fields to save from the form (workHoursByDay for the ticked days, and workStart/workEnd/workDays derived from it for
 * older readers), or the message to show when a ticked day has no valid start and finish or finishes before it starts. An end of 00:00 is midnight.
 */
export function workingHoursFromForm(form: Pick<CompanyForm, "workDays" | "workHours">): { error: string } | { fields: NonNullable<ReturnType<typeof workingHoursToSave>> } {
  if (!form.workDays.length) return { error: "Tick at least one working day." };
  const byDay: Record<number, DayHours> = {};
  for (const day of [...form.workDays].sort((a, b) => a - b)) {
    const entry = form.workHours[day];
    const end = entry?.end === "00:00" ? "24:00" : entry?.end;
    const start = clockMinutes(entry?.start);
    const finish = clockMinutes(end, true);
    const name = DAY_FULL_NAMES[day - 1];
    if (start === null || finish === null) return { error: `Enter ${name}'s start and finish times.` };
    // 00:00 to 00:00 would be a 24 hour day; Settings shows it as "Check times" (paidDay), so it isn't saved either.
    if (finish <= start || finish - start >= 1440) return { error: `${name} must finish after it starts.` };
    byDay[day] = { start: entry.start, end: end as string };
  }
  const fields = workingHoursToSave(byDay);
  return fields ? { fields } : { error: "Tick at least one working day." };
}

export const EMPTY_COMPANY: CompanyForm = { name: "", documentName: "", addressLines: "", phone: "", fax: "", email: "", website: "", vatNumber: "", logoPath: "", defaultQuoteTerms: "", defaultInvoiceTerms: "", defaultCustomerMessage: "", defaultInvoiceMessage: "", bank: { ...EMPTY_BANK_DETAILS }, showCreditsInBalance: false, vatRegistered: true, defaultVatRate: "20", brandPrimary: "", brandAccent: "", loginTagline: "", brandedLogin: false, loginStyle: "light", loginEyebrow: "", workDays: [...DEFAULT_WORKING_HOURS.workDays], workHours: formWorkHours(DEFAULT_WORKING_HOURS) };

export function toForm(profile: CompanyProfile | null): CompanyForm {
  if (!profile) return EMPTY_COMPANY;
  return {
    name: profile.name, documentName: profile.documentName, addressLines: profile.addressLines.join("\n"), phone: profile.phone, fax: profile.fax, email: profile.email,
    website: profile.website, vatNumber: profile.vatNumber, logoPath: profile.logoPath, defaultQuoteTerms: profile.defaultQuoteTerms,
    defaultInvoiceTerms: profile.defaultInvoiceTerms, defaultCustomerMessage: profile.defaultCustomerMessage.join("\n"), defaultInvoiceMessage: invoiceMessage(profile).join("\n"), bank: { ...profile.bankDetails }, showCreditsInBalance: profile.showCreditsInBalance,
    vatRegistered: profile.vatRegistered, defaultVatRate: String(profile.defaultVatRate),
    brandPrimary: profile.brandPrimary, brandAccent: profile.brandAccent, loginTagline: profile.loginTagline, brandedLogin: profile.brandedLogin, loginStyle: profile.loginStyle, loginEyebrow: profile.loginEyebrow,
    workDays: [...profile.workDays], workHours: formWorkHours(profile),
  };
}

/**
 * The form to load into the Company details card, or null when it must be left alone.
 * The card loads the profile once: never while it is still loading, and never again after that,
 * so a late-arriving profile can't overwrite what the person has already typed.
 */
export function companyFormToHydrate(loading: boolean, hydrated: boolean, profile: CompanyProfile | null): CompanyForm | null {
  if (loading || hydrated) return null;
  return toForm(profile);
}
