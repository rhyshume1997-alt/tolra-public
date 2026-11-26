/**
 * BOUNDARY (module 9, ISO templates). The owner's explicit approval of 26 Nov supersedes the old "no saved documents, no SQL" line of
 * docs/MODULES.md for THIS task only: the nine drafts are now editable and saved as append-only versions (proposal p171, not applied anywhere
 * but the scratch database).
 *
 * Pure rules for an editable ISO document (no React, no browser, no I/O). Inputs: the filled draft (lib/iso/fill.ts), saved version rows (or
 * their metadata) and typed text. Outputs: the editable body, validation, gap detection, "locked", "latest approved", which version prints, and
 * the FilledDocument the PDF draws (approved wording or saved draft or today's generated draft).
 * Must not change: the limits mirror the database function save_iso_document (30 sections, heading 1..200, text 0..20000, note 0..500, name 1..200,
 * body 200000 bytes); a version is never edited (a save is a new version); an approved version is locked; the footer is always the existing
 * "Template and self-check aid. Needs company review. Not certification evidence." wording; a gap is the text "[to complete]" and is never hidden.
 */
import { DRAFT_HEADER, PAGE_FOOTER, TO_COMPLETE, type FilledDocument } from "@/lib/iso/fill";

export type IsoBodySection = { heading: string; text: string };
export type IsoBody = { sections: IsoBodySection[] };
export type IsoVersionStatus = "draft" | "approved";

/** One saved version without its text (the history list). Field names are the database column names. */
export type IsoVersionMeta = {
  id: string;
  doc_id: string;
  version: number;
  status: IsoVersionStatus;
  change_note: string | null;
  restored_from: number | null;
  created_by: string;
  created_by_name: string;
  created_at: string;
  approved_by_name: string | null;
  approved_at: string | null;
};
export type IsoVersion = IsoVersionMeta & { body: IsoBody };

export const ISO_LIMITS = { sections: 30, heading: 200, text: 20000, note: 500, name: 200, bodyBytes: 200000 } as const;

/** The editable body of a filled draft: each section's lines joined by a line break. A blank-table section keeps only its wording (the table itself always comes from the template). */
export function bodyFromFilled(doc: Pick<FilledDocument, "sections">): IsoBody {
  return { sections: doc.sections.map((s) => ({ heading: s.heading, text: s.lines.join("\n") })) };
}

/** Reads a stored body defensively; null when it is not the expected shape. */
export function parseBody(value: unknown): IsoBody | null {
  if (!value || typeof value !== "object") return null;
  const sections = (value as { sections?: unknown }).sections;
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const out: IsoBodySection[] = [];
  for (const s of sections) {
    if (!s || typeof s !== "object") return null;
    const { heading, text } = s as { heading?: unknown; text?: unknown };
    if (typeof heading !== "string" || typeof text !== "string") return null;
    out.push({ heading, text });
  }
  return { sections: out };
}

/** The first problem with a body about to be saved (the words shown to the person), or null when it can be saved. */
export function validateBody(body: IsoBody): string | null {
  if (body.sections.length < 1 || body.sections.length > ISO_LIMITS.sections) return "This document has an unexpected number of sections.";
  for (const s of body.sections) {
    if (s.heading.length < 1 || s.heading.length > ISO_LIMITS.heading) return "A section heading is missing or too long.";
    if (s.text.length > ISO_LIMITS.text) return `"${s.heading}" is longer than ${ISO_LIMITS.text.toLocaleString("en-GB")} characters.`;
  }
  if (new TextEncoder().encode(JSON.stringify(body)).length > ISO_LIMITS.bodyBytes) return "This document is too long to save.";
  return null;
}

export function validateChangeNote(note: string): string | null {
  return note.trim().length > ISO_LIMITS.note ? `The change note is longer than ${ISO_LIMITS.note} characters.` : null;
}

export function validateApproverName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Type the approver's name.";
  return n.length > ISO_LIMITS.name ? "The name is too long." : null;
}

/** True when two bodies hold exactly the same words (used to tell whether anything was edited). */
export function sameBody(a: IsoBody, b: IsoBody): boolean {
  return a.sections.length === b.sections.length && a.sections.every((s, i) => s.heading === b.sections[i].heading && s.text === b.sections[i].text);
}

/** How many gaps ("[to complete]") a text holds. */
export function countGapsInText(text: string): number {
  return text.split(TO_COMPLETE).length - 1;
}
export function countGaps(body: IsoBody): number {
  return body.sections.reduce((n, s) => n + countGapsInText(s.text), 0);
}

/** A line cut into plain and gap pieces, so the page can highlight the gaps (a gap is also announced as words, never colour alone). */
export function splitGaps(line: string): Array<{ text: string; gap: boolean }> {
  const parts = line.split(TO_COMPLETE);
  const out: Array<{ text: string; gap: boolean }> = [];
  parts.forEach((p, i) => {
    if (p) out.push({ text: p, gap: false });
    if (i < parts.length - 1) out.push({ text: TO_COMPLETE, gap: true });
  });
  return out;
}

/** The next gap at or after `from`, wrapping round to the start; null when there is none. */
export function nextGapRange(text: string, from: number): { start: number; end: number } | null {
  if (!text.includes(TO_COMPLETE)) return null;
  let at = text.indexOf(TO_COMPLETE, Math.max(0, from));
  if (at < 0) at = text.indexOf(TO_COMPLETE);
  return { start: at, end: at + TO_COMPLETE.length };
}

export const isLocked = (v: Pick<IsoVersionMeta, "status">): boolean => v.status === "approved";

const byVersionDesc = (a: Pick<IsoVersionMeta, "version">, b: Pick<IsoVersionMeta, "version">) => b.version - a.version;

/** The versions of one document, newest first. */
export function versionsOf<T extends Pick<IsoVersionMeta, "doc_id" | "version">>(all: readonly T[], docId: string): T[] {
  return all.filter((v) => v.doc_id === docId).sort(byVersionDesc);
}

/** The latest approved version ("the approved version"), or null. */
export function latestApproved<T extends Pick<IsoVersionMeta, "version" | "status">>(versions: readonly T[]): T | null {
  return [...versions].filter((v) => v.status === "approved").sort(byVersionDesc)[0] ?? null;
}

/** The latest saved version of any status, or null. */
export function latestSaved<T extends Pick<IsoVersionMeta, "version">>(versions: readonly T[]): T | null {
  return [...versions].sort(byVersionDesc)[0] ?? null;
}

export type PrintChoice =
  | { kind: "approved"; version: IsoVersionMeta }
  | { kind: "draft"; version: IsoVersionMeta }
  | { kind: "generated"; version: null };

/** Which version the PDF prints: the latest approved; else the latest saved draft; else today's generated draft. */
export function whichVersionPrints(versions: readonly IsoVersionMeta[]): PrintChoice {
  const approved = latestApproved(versions);
  if (approved) return { kind: "approved", version: approved };
  const saved = latestSaved(versions);
  return saved ? { kind: "draft", version: saved } : { kind: "generated", version: null };
}

/** The words for the status column and the editor's header. */
export function printChoiceLabel(choice: PrintChoice): string {
  if (choice.kind === "approved") return `Approved, version ${choice.version.version}`;
  if (choice.kind === "draft") return `Draft, version ${choice.version.version}`;
  return "Generated draft, not saved";
}

/** Where the editor starts: the latest saved version (a locked approved one starts a NEW draft when saved), else today's generated draft. */
export function editorStart(versions: readonly IsoVersion[], generated: IsoBody): { body: IsoBody; baseVersion: number; from: "saved" | "generated"; fromVersion: IsoVersion | null } {
  const latest = latestSaved(versions);
  return latest ? { body: latest.body, baseVersion: latest.version, from: "saved", fromVersion: latest } : { body: generated, baseVersion: 0, from: "generated", fromVersion: null };
}

const day = (iso: string | null | undefined) => (iso && !Number.isNaN(new Date(iso).getTime()) ? new Date(iso).toISOString().slice(0, 10) : "");

export function approvedHeader(v: Pick<IsoVersionMeta, "version" | "approved_by_name" | "approved_at">): string {
  return `APPROVED version ${v.version}: approved by ${v.approved_by_name ?? TO_COMPLETE} on ${day(v.approved_at) || TO_COMPLETE}`;
}

/**
 * The document the PDF draws. `generated` is today's filled draft (it supplies the company name, address, clause, file name and the blank
 * tables); `chosen` is the version that prints, with its text, or null to print today's generated draft unchanged. A section is matched by
 * heading, so a blank table stays with its section. An approved version gets an "APPROVED" header; a draft keeps the existing DRAFT header.
 * The footer is always the existing wording.
 */
export function effectiveDocument(generated: FilledDocument, chosen: { kind: "approved" | "draft"; version: IsoVersion } | null): FilledDocument {
  if (!chosen) return generated;
  const { version, kind } = chosen;
  return {
    ...generated,
    header: kind === "approved" ? approvedHeader(version) : DRAFT_HEADER,
    footer: PAGE_FOOTER,
    sections: version.body.sections.map((s) => ({
      heading: s.heading,
      lines: s.text.split("\n"),
      blankTable: generated.sections.find((g) => g.heading === s.heading)?.blankTable,
    })),
  };
}

/** The plain-language reason a save or approval was refused, from the database's error code and hint. Never exposes the raw message. */
export function isoErrorText(err: { code?: string | null; hint?: string | null } | null | undefined, action: "save" | "approve"): string {
  const code = err?.code ?? "";
  const hint = err?.hint ?? "";
  if (hint === "stale_version" || code === "40001") return "Someone saved a newer version while you were editing. Reload to see it, then make your changes again.";
  if (hint === "already_approved" || code === "55000") return "That version is already approved.";
  if (hint === "mfa_required") return "Confirm your authenticator code first, then try again.";
  if (code === "42501") return "Only an admin of this company can do that.";
  if (code === "22023") return "The text could not be saved because it does not fit the limits. Check the lengths and try again.";
  if (code === "P0002") return "That version could not be found. Reload and try again.";
  return action === "save" ? "Couldn't save. Nothing was changed. Try again." : "Couldn't approve. Nothing was changed. Try again.";
}
