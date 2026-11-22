/**
 * Module K (worksheet builder): a company's own worksheet layouts. A layout is a named, ordered list of blocks from the fixed palette
 * (blocks.ts). A company starts from Basic, from the JNR sheet or from blank.
 *
 * Inputs: stored JSON (organization_settings.company_profile.worksheetBuilder, any shape) or an admin's edits. Outputs: validated layouts.
 * Nothing is trusted from storage: parseWorksheetBuilder keeps only known kinds and fields, trims and limits text, and drops anything else,
 * so a hand-edited or corrupt value can never put markup, an unknown block or an oversized value on a sheet.
 * Must not change: stored field names (id, name, base, blocks, ...); the Basic and JNR sheets themselves (components/job-worksheet-*-print.tsx),
 * which these seeds only imitate in content.
 * Pure (no React, no I/O).
 */
import { CHECKLIST_ITEMS } from "@/lib/job-worksheet";
import {
  BLOCK_KINDS, MAX_BLOCKS, MAX_CHECKLIST_ITEMS, MAX_FREE_TEXT, MAX_LABEL, MAX_LAYOUTS, MAX_LAYOUT_NAME, PALETTE,
  type BlockKind, type ChecklistItem, type WorksheetBlock, BLOCK_FIELDS,
} from "@/lib/worksheet-builder/blocks";

export type LayoutBase = "basic" | "jnr" | "blank";

/** What a layout looked like until `replacedAt` (kept so a worksheet signed off earlier still reprints as it was signed). */
export type LayoutRevision = { replacedAt: string; name: string; blocks: WorksheetBlock[] };

export type WorksheetLayout = {
  id: string;
  /** What the company calls it in the Print layout list. */
  name: string;
  /** What it was started from (information only; the blocks are the layout). */
  base: LayoutBase;
  blocks: WorksheetBlock[];
  /** ISO time of the last edit (set when saved). */
  updatedAt?: string;
  /** Earlier versions, oldest first, at most MAX_HISTORY. */
  history?: LayoutRevision[];
  /** Deleted layouts are archived, not erased: a worksheet signed off on one still reprints as signed. Never listed or offered. */
  archived?: boolean;
};

export const MAX_HISTORY = 10;

/** The builder's stored state: the layouts, and which one the company prints by default (null: Basic or JNR sheet as before). */
export type WorksheetBuilderState = { layouts: WorksheetLayout[]; activeId: string | null };

/** The key inside organization_settings.company_profile. */
export const WORKSHEET_BUILDER_KEY = "worksheetBuilder";

export const EMPTY_BUILDER_STATE: WorksheetBuilderState = { layouts: [], activeId: null };

/** Value of the print-page picker for a custom layout. */
export const CUSTOM_CHOICE_PREFIX = "custom:";
export const customChoice = (id: string) => `${CUSTOM_CHOICE_PREFIX}${id}`;
export const customChoiceId = (value: string | null | undefined): string | null => (value && value.startsWith(CUSTOM_CHOICE_PREFIX) ? value.slice(CUSTOM_CHOICE_PREFIX.length) : null);

const block = (kind: BlockKind, extra: Partial<WorksheetBlock> = {}): WorksheetBlock => ({ id: kind, kind, visible: true, label: PALETTE[kind].defaultLabel, ...extra });
const hidden = (kind: BlockKind, extra: Partial<WorksheetBlock> = {}): WorksheetBlock => block(kind, { visible: false, ...extra });
const standardChecklist = (): ChecklistItem[] => CHECKLIST_ITEMS.map((item) => ({ key: item.key, label: item.label }));

/** Same content as the Basic sheet: plain job sheet, traceability only on traceable jobs, operations and notes, sign-off boxes. */
export function basicBlocks(): WorksheetBlock[] {
  return [
    block("header", { label: "JOB SHEET" }), block("jobDetails"), block("quantityDates"), block("materialTrace", { traceableOnly: true }),
    block("description"), block("drawings"), block("operations"), block("internalSignOff"), block("customerSignOff"), block("inspection"),
    hidden("machines"), hidden("checklist", { items: standardChecklist() }),
  ];
}

/** Same content as the JNR sheet: machines and times, part checklist, JNR wording as free text. */
export function jnrBlocks(): WorksheetBlock[] {
  return [
    block("header", { label: "(SINGLE PART) WORKSHEET" }), block("jobDetails"), block("quantityDates"), block("materialTrace", { traceableOnly: false }), block("description"),
    block("machines"), block("drawings"), block("checklist", { items: standardChecklist() }),
    block("freeText", { id: "freeText-1", label: "Notice", text: "ALL PARTS MUST BE CHECKED AND MARKED FOR IDENTIFICATION BEFORE SIGN OFF (e.g. Black Ink Marker). ANY EXCESS MATERIAL MUST BE MARKED WITH MATERIAL GRADE AND HEAT/CAST NUMBER." }),
    block("internalSignOff", { label: "Internal sign off" }), block("customerSignOff"), block("inspection"),
    hidden("operations"),
  ];
}

/** Blank: only the blocks that cannot be removed, plus the header. The company adds the rest. */
export function blankBlocks(): WorksheetBlock[] {
  return [block("header"), block("materialTrace", { traceableOnly: true }), block("internalSignOff"), block("customerSignOff", { visible: false }), block("inspection")];
}

export function startingBlocks(base: LayoutBase): WorksheetBlock[] {
  return base === "basic" ? basicBlocks() : base === "jnr" ? jnrBlocks() : blankBlocks();
}

/** A new layout from a starting point. The id is made by the caller's makeId (tests pass a fixed one). */
export function newLayout(base: LayoutBase, name: string, makeId: () => string = randomId): WorksheetLayout {
  return { id: makeId(), name: cleanText(name, MAX_LAYOUT_NAME) || "My worksheet", base, blocks: startingBlocks(base) };
}

export function randomId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

/** An id for an added block: kind plus a short random part, unique in the layout. */
export function newBlockId(kind: BlockKind, layout: Pick<WorksheetLayout, "blocks">, makeId: () => string = randomId): string {
  let id = `${kind}-${makeId().slice(0, 6)}`;
  while (layout.blocks.some((existing) => existing.id === id)) id = `${kind}-${makeId().slice(0, 6)}`;
  return id;
}

/** A block added from the palette (a repeatable kind may be added again; the others once). */
export function addBlock(layout: WorksheetLayout, kind: BlockKind, makeId: () => string = randomId): WorksheetLayout {
  if (layout.blocks.length >= MAX_BLOCKS) return layout;
  const existing = layout.blocks.find((b) => b.kind === kind);
  if (existing && !PALETTE[kind].repeatable) return { ...layout, blocks: layout.blocks.map((b) => (b === existing ? { ...b, visible: true } : b)) };
  const extra: Partial<WorksheetBlock> = kind === "checklist" ? { items: standardChecklist() } : kind === "freeText" ? { text: "" } : kind === "materialTrace" ? { traceableOnly: true } : {};
  return { ...layout, blocks: [...layout.blocks, { id: PALETTE[kind].repeatable ? newBlockId(kind, layout, makeId) : kind, kind, visible: true, label: PALETTE[kind].defaultLabel, ...extra }] };
}

/** Moves a block one place up or down; a block at an end stays. */
export function moveBlock(layout: WorksheetLayout, id: string, direction: -1 | 1): WorksheetLayout {
  const at = layout.blocks.findIndex((b) => b.id === id);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= layout.blocks.length) return layout;
  const blocks = [...layout.blocks];
  [blocks[at], blocks[to]] = [blocks[to], blocks[at]];
  return { ...layout, blocks };
}

export function updateBlock(layout: WorksheetLayout, id: string, patch: Partial<WorksheetBlock>): WorksheetLayout {
  return { ...layout, blocks: layout.blocks.map((b) => (b.id === id ? { ...b, ...patch, id: b.id, kind: b.kind } : b)) };
}

export function removeBlock(layout: WorksheetLayout, id: string): WorksheetLayout {
  return { ...layout, blocks: layout.blocks.filter((b) => b.id !== id) };
}

// ---- Parsing what is stored ------------------------------------------------------------------------------------------------------------

/** Plain text only: control characters and angle brackets removed, trimmed, limited. (React escapes text anyway; this keeps stored data clean.) */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim().slice(0, max);
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const KEY_PATTERN = /^[A-Za-z0-9_:-]{1,40}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseBlock(raw: unknown, seen: Set<string>): WorksheetBlock | null {
  if (!isRecord(raw)) return null;
  const kind = BLOCK_KINDS.find((k) => k === raw.kind);
  if (!kind || typeof raw.id !== "string" || !ID_PATTERN.test(raw.id) || seen.has(raw.id)) return null;
  const out: WorksheetBlock = { id: raw.id, kind, visible: raw.visible !== false, label: cleanText(raw.label, MAX_LABEL) || PALETTE[kind].defaultLabel };
  if (isRecord(raw.fieldLabels) && BLOCK_FIELDS[kind]) {
    const labels: Record<string, string> = {};
    for (const field of BLOCK_FIELDS[kind] ?? []) {
      const text = cleanText(raw.fieldLabels[field.key], MAX_LABEL);
      if (text) labels[field.key] = text;
    }
    if (Object.keys(labels).length) out.fieldLabels = labels;
  }
  if (kind === "freeText") out.text = cleanText(raw.text, MAX_FREE_TEXT);
  if (kind === "materialTrace") out.traceableOnly = raw.traceableOnly === true;
  if (kind === "checklist") {
    const items: ChecklistItem[] = [];
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      if (!isRecord(item) || typeof item.key !== "string" || !KEY_PATTERN.test(item.key) || items.some((i) => i.key === item.key)) continue;
      const label = cleanText(item.label, MAX_LABEL);
      if (label) items.push({ key: item.key, label });
      if (items.length >= MAX_CHECKLIST_ITEMS) break;
    }
    out.items = items;
  }
  return out;
}

function parseBlocks(raw: unknown): WorksheetBlock[] {
  const seen = new Set<string>();
  const blocks: WorksheetBlock[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const parsed = parseBlock(item, seen);
    if (!parsed) continue;
    // A single-use kind appears once: the first one wins.
    if (!PALETTE[parsed.kind].repeatable && blocks.some((b) => b.kind === parsed.kind)) continue;
    seen.add(parsed.id);
    blocks.push(parsed);
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return blocks;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function parseLayout(raw: unknown): WorksheetLayout | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) return null;
  const base = raw.base === "basic" || raw.base === "jnr" || raw.base === "blank" ? raw.base : "blank";
  const layout: WorksheetLayout = { id: raw.id, name: cleanText(raw.name, MAX_LAYOUT_NAME) || "My worksheet", base, blocks: parseBlocks(raw.blocks) };
  if (typeof raw.updatedAt === "string" && ISO_TIME.test(raw.updatedAt)) layout.updatedAt = raw.updatedAt;
  const history: LayoutRevision[] = [];
  for (const item of Array.isArray(raw.history) ? raw.history : []) {
    if (!isRecord(item) || typeof item.replacedAt !== "string" || !ISO_TIME.test(item.replacedAt)) continue;
    history.push({ replacedAt: item.replacedAt, name: cleanText(item.name, MAX_LAYOUT_NAME) || layout.name, blocks: parseBlocks(item.blocks) });
  }
  if (history.length) layout.history = history.sort((a, b) => a.replacedAt.localeCompare(b.replacedAt)).slice(-MAX_HISTORY);
  if (raw.archived === true) layout.archived = true;
  return layout;
}

/** The layout after an admin saves an edit: the version it replaces is kept (when something changed) and the edit time recorded. */
export function commitLayoutEdit(previous: WorksheetLayout | undefined, next: WorksheetLayout, now: Date = new Date()): WorksheetLayout {
  const at = now.toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
  if (!previous) return { ...next, updatedAt: at, history: next.history ?? [] };
  const changed = previous.name !== next.name || JSON.stringify(previous.blocks) !== JSON.stringify(next.blocks);
  const history = changed ? [...(previous.history ?? []), { replacedAt: at, name: previous.name, blocks: previous.blocks }].slice(-MAX_HISTORY) : previous.history ?? [];
  return { ...next, history, updatedAt: changed ? at : previous.updatedAt };
}

/**
 * The layout as it stood when a worksheet was signed off: edits made to the layout after that never change how that worksheet reprints.
 * With no sign-off time (an unsigned job, or the live preview) it is the current layout.
 */
export function layoutAsOf(layout: WorksheetLayout, signedAtIso: string | null | undefined): WorksheetLayout {
  if (!signedAtIso) return layout;
  const signed = Date.parse(signedAtIso);
  if (Number.isNaN(signed)) return layout;
  const revision = (layout.history ?? []).find((entry) => Date.parse(entry.replacedAt) > signed);
  return revision ? { ...layout, name: revision.name, blocks: revision.blocks } : layout;
}

/** The layouts a company can pick: the ones not deleted. */
export const liveLayouts = (state: WorksheetBuilderState): WorksheetLayout[] => state.layouts.filter((layout) => !layout.archived);

/** company_profile.worksheetBuilder as stored (anything): the layouts that are valid, at most MAX_LAYOUTS, and the active one if it exists. */
export function parseWorksheetBuilder(raw: unknown): WorksheetBuilderState {
  if (!isRecord(raw)) return EMPTY_BUILDER_STATE;
  const layouts: WorksheetLayout[] = [];
  for (const item of Array.isArray(raw.layouts) ? raw.layouts : []) {
    const layout = parseLayout(item);
    if (layout && !layouts.some((l) => l.id === layout.id)) layouts.push(layout);
    // The cap counts layouts a company can see; archived ones are kept (up to 4 times as many) so signed worksheets still reprint as signed.
    if (layouts.length >= MAX_LAYOUTS * 5) break;
  }
  const kept: WorksheetLayout[] = [];
  let live = 0;
  for (const layout of layouts) {
    if (layout.archived) { kept.push(layout); continue; }
    if (live < MAX_LAYOUTS) { live += 1; kept.push(layout); }
  }
  const activeId = typeof raw.activeId === "string" && kept.some((l) => l.id === raw.activeId && !l.archived) ? raw.activeId : null;
  return { layouts: kept, activeId };
}

/** What a save writes: the state through the same parse, so storage only ever holds valid layouts. */
export function serialiseWorksheetBuilder(state: WorksheetBuilderState): WorksheetBuilderState {
  return parseWorksheetBuilder(state);
}

/** The Basic or JNR layout a custom layout falls back to where blocks cannot print (the workshop pack): its base, blank counting as Basic. */
export function packFallback(layout: Pick<WorksheetLayout, "base">): "basic" | "jnr" {
  return layout.base === "jnr" ? "jnr" : "basic";
}

// ---- Changing the stored state (applied to the freshly read state by store.updateWorksheetBuilderState) --------------------------------

/** Adds or replaces one layout (an edit is kept as a revision), leaving every other layout as it is. */
export function upsertLayout(state: WorksheetBuilderState, layout: WorksheetLayout, now: Date = new Date()): WorksheetBuilderState {
  const previous = state.layouts.find((l) => l.id === layout.id);
  const next = commitLayoutEdit(previous, layout, now);
  const layouts = previous ? state.layouts.map((l) => (l.id === layout.id ? next : l)) : [...state.layouts, next];
  return { ...state, layouts };
}

/** Deleting archives (see WorksheetLayout.archived); if it was the company's layout, Basic or JNR sheet applies again. */
export function archiveLayout(state: WorksheetBuilderState, id: string): WorksheetBuilderState {
  return { layouts: state.layouts.map((l) => (l.id === id ? { ...l, archived: true } : l)), activeId: state.activeId === id ? null : state.activeId };
}

/** The layout the company prints by default (null: Basic or JNR sheet). */
export function setActiveLayout(state: WorksheetBuilderState, id: string | null): WorksheetBuilderState {
  return { ...state, activeId: id && state.layouts.some((l) => l.id === id && !l.archived) ? id : null };
}
