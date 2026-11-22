/**
 * Module J (document templates): which printed design a company uses for each document type. Pure: no React, no I/O, no PDF library.
 *
 * Inputs: the value stored at organization_settings.company_profile.documentTemplates (read leniently), a document type, and the date a
 * document was issued. Outputs: the design id to print it with, and the next stored value when an admin switches the feature on or off
 * or picks a design.
 *
 * Stored shape (no migration; the profile is already the per-company jsonb and only an admin can write it, trigger 006):
 *   { enabled: boolean, quote?: Choice[], invoice?: Choice[], purchase_order?: Choice[], delivery_note?: Choice[] }
 *   Choice = { design: "<slug>", from: "<ISO date or date-time the choice took effect>" }
 * The list is append-only history. A document is printed with the choice in force on the day it was issued, so a document issued
 * before a change keeps its design for ever, and a document issued (or not yet issued) after it gets the new one.
 *
 * OFF by default: with no stored value, with enabled false, or with no choice for a type, everything prints the classic design, which is
 * exactly what every company printed before this module (components/pdf/BaseDocumentPDF.tsx, unchanged).
 *
 * Must not change: the stored key names, the default (classic, off), or the "history is only ever appended" rule. The numbers, VAT,
 * totals, bank details, payment wording and document numbering are NOT decided here (they come from components/pdf/templates/document-model.ts).
 * Other modules (the owner rollout) call setDesignChoice / withTemplatesEnabled and resolveDesignId; they never edit the stored shape directly.
 */

export const DOCUMENT_TYPES = ["quote", "invoice", "purchase_order", "delivery_note"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  quote: "Quotes",
  invoice: "Invoices",
  purchase_order: "Purchase orders",
  delivery_note: "Delivery notes",
};

/** The key inside organization_settings.company_profile. */
export const DOCUMENT_TEMPLATES_KEY = "documentTemplates";

/** What prints when nothing is chosen, the feature is off, or a chosen design no longer exists: today's layout. */
export const DEFAULT_DESIGN_ID = "classic";

export type DesignChoice = { design: string; from: string };

export type DocumentTemplateSettings = { enabled: boolean } & Partial<Record<DocumentType, DesignChoice[]>>;

export const NO_DOCUMENT_TEMPLATES: DocumentTemplateSettings = { enabled: false };

const DESIGN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_HISTORY = 200;

export const isDocumentType = (value: unknown): value is DocumentType => typeof value === "string" && (DOCUMENT_TYPES as readonly string[]).includes(value);
export const isDesignId = (value: unknown): value is string => typeof value === "string" && DESIGN_ID.test(value);

const toTime = (value: string) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
};

/** Reads the stored value leniently: anything unreadable is dropped, never thrown. Choices are returned oldest first. */
export function parseDocumentTemplates(value: unknown): DocumentTemplateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...NO_DOCUMENT_TEMPLATES };
  const raw = value as Record<string, unknown>;
  const out: DocumentTemplateSettings = { enabled: raw.enabled === true };
  for (const type of DOCUMENT_TYPES) {
    const list = raw[type];
    if (!Array.isArray(list)) continue;
    const choices: DesignChoice[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const { design, from } = item as Record<string, unknown>;
      if (isDesignId(design) && typeof from === "string" && toTime(from) !== null) choices.push({ design, from });
    }
    choices.sort((a, b) => (toTime(a.from) as number) - (toTime(b.from) as number));
    if (choices.length) out[type] = choices.slice(-MAX_HISTORY);
  }
  return out;
}

/**
 * The design a document prints with. `issuedAt` is when the document was issued (an ISO date or date-time); omit it for a document that
 * is not issued yet, which always gets the design in force now. A document issued before the company's first choice prints classic.
 */
export function resolveDesignId(settings: DocumentTemplateSettings | null | undefined, type: DocumentType, issuedAt?: string | null): string {
  if (!settings?.enabled) return DEFAULT_DESIGN_ID;
  const history = settings[type];
  if (!history?.length) return DEFAULT_DESIGN_ID;
  const at = issuedAt ? toTime(issuedAt) : null;
  if (at === null) return history[history.length - 1].design;
  let design = DEFAULT_DESIGN_ID;
  for (const choice of history) {
    if ((toTime(choice.from) as number) <= at) design = choice.design;
    else break;
  }
  return design;
}

/** The design in force now for a type (what the Settings screen shows as chosen). */
export const currentDesignId = (settings: DocumentTemplateSettings | null | undefined, type: DocumentType): string => {
  const history = settings?.[type];
  return history?.length ? history[history.length - 1].design : DEFAULT_DESIGN_ID;
};

/** The settings after an admin picks a design for a type. Appends to the history (never rewrites it); picking what is already in force changes nothing. */
export function setDesignChoice(settings: DocumentTemplateSettings | null | undefined, type: DocumentType, design: string, now: Date = new Date()): DocumentTemplateSettings {
  const base = parseDocumentTemplates(settings);
  if (!isDocumentType(type)) throw new Error("Unknown document type.");
  if (!isDesignId(design)) throw new Error("Unknown design.");
  if (currentDesignId(base, type) === design) return base;
  const history = base[type] ?? [];
  // A choice is never dated before an earlier one, so the history stays in order even if a clock moves back.
  const last = history.length ? (toTime(history[history.length - 1].from) as number) : 0;
  const from = new Date(Math.max(now.getTime(), last)).toISOString();
  return { ...base, [type]: [...history, { design, from }].slice(-MAX_HISTORY) };
}

/** The settings after the feature is switched on or off. Choices already made are kept either way. */
export const withTemplatesEnabled = (settings: DocumentTemplateSettings | null | undefined, enabled: boolean): DocumentTemplateSettings => ({ ...parseDocumentTemplates(settings), enabled });

/**
 * A profile about to be saved (Company details, logo) with the choices as stored in the row's raw company_profile: the stored value wins,
 * so saving Company details can never drop or roll back the document templates (the same rule as lib/print-layout withStoredPrintLayout).
 */
export function withStoredDocumentTemplates<T extends { documentTemplates?: DocumentTemplateSettings }>(next: T, storedProfile: unknown): T {
  const raw = storedProfile && typeof storedProfile === "object" && !Array.isArray(storedProfile) ? (storedProfile as Record<string, unknown>)[DOCUMENT_TEMPLATES_KEY] : undefined;
  const { documentTemplates: _drop, ...rest } = next; // eslint-disable-line @typescript-eslint/no-unused-vars
  return (raw === undefined ? rest : { ...rest, [DOCUMENT_TEMPLATES_KEY]: raw }) as T;
}
