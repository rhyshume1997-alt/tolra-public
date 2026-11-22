/**
 * Fills the draft documents (lib/iso/document-list.ts) for one company. Inputs: the company profile (or null), the facts read from
 * Tolra (or null when they could not be read) and a document. Output: plain text ready for the PDF, with a draft header and the footer
 * that goes on every page.
 * Must not change: a value that is missing prints "[to complete]" and is never guessed; facts come only from what is passed in; no
 * token is ever left unreplaced.
 *
 * Pure (no React, no browser, no I/O).
 */
import type { CompanyProfile } from "@/lib/company";
import type { IsoDocument } from "@/lib/iso/document-list";

export const TO_COMPLETE = "[to complete]";
export const DRAFT_HEADER = "DRAFT: template for company review";
export const PAGE_FOOTER = "Template and self-check aid. Needs company review. Not certification evidence.";

/** The counts the templates may state. Each is null when it could not be read. */
export type IsoFacts = {
  inspectors: number | null;
  suppliers: { total: number; approved: number; conditional: number; blocked: number } | null;
  traceableJobs: number | null;
  openNcrs: number | null;
};

export type FillContext = {
  company: Pick<CompanyProfile, "name" | "documentName" | "addressLines" | "phone" | "email" | "website"> | null;
  facts: IsoFacts | null;
};

export type FilledSection = { heading: string; lines: string[]; blankTable?: { columns: string[]; rows: string[][] } };
export type FilledDocument = {
  id: string; title: string; clause: string; filename: string;
  header: string; footer: string; companyName: string; addressLines: string[];
  sections: FilledSection[];
};

const text = (value: string | null | undefined) => (value && value.trim() ? value.trim() : TO_COMPLETE);
const count = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? String(value) : TO_COMPLETE);

/** The value of every token the wording may use. */
export function tokenValues(ctx: FillContext): Record<string, string> {
  const c = ctx.company;
  const f = ctx.facts;
  return {
    company: text(c?.documentName || c?.name),
    address: text(c?.addressLines?.filter((l) => l.trim()).join(", ")),
    phone: text(c?.phone),
    email: text(c?.email),
    website: text(c?.website),
    inspectors: count(f?.inspectors),
    suppliersTotal: count(f?.suppliers?.total),
    suppliersApproved: count(f?.suppliers?.approved),
    suppliersConditional: count(f?.suppliers?.conditional),
    suppliersBlocked: count(f?.suppliers?.blocked),
    traceableJobs: count(f?.traceableJobs),
    openNcrs: count(f?.openNcrs),
  };
}

/** Replaces every {{token}}; an unknown token prints "[to complete]". */
export function fillText(source: string, values: Record<string, string>): string {
  return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => values[key] ?? TO_COMPLETE);
}

export function fillDocument(doc: IsoDocument, ctx: FillContext): FilledDocument {
  const values = tokenValues(ctx);
  return {
    id: doc.id, title: doc.title, clause: doc.clause, filename: doc.filename,
    header: DRAFT_HEADER,
    footer: PAGE_FOOTER,
    companyName: values.company,
    addressLines: ctx.company?.addressLines?.filter((l) => l.trim()) ?? [],
    sections: doc.sections.map((s) => ({
      heading: s.heading,
      lines: s.lines.map((l) => fillText(l, values)),
      blankTable: s.blankTable ? { columns: s.blankTable.columns, rows: Array.from({ length: s.blankTable.rows }, () => s.blankTable!.columns.map(() => "")) } : undefined,
    })),
  };
}
