/**
 * Admin > Data: what is each sheet, and which column is which field. No guessing about the data itself: only the headers (and a Kind
 * column) are read here. Linking and matching are done by the database (migrations 076 and 085); this file never looks a record up.
 *
 * Order of trust for a header (docs: lib/import-synonyms.ts): the company's saved mapping, then our own export columns
 * (lib/import-columns.ts, the file a person gets from Export CSV), then the synonym list. A sheet's kind: a saved mapping with the
 * same header layout, else the best score of headers against each kind's fields; a tie or a weak score leaves the kind for the admin to
 * choose (never guessed). A mixed sheet is read only with a Kind column.
 */
import { IMPORT_COLUMNS } from "@/lib/import-columns";
import { FIELD_SYNONYMS, KIND_COLUMN_HEADERS, KIND_WORDS, NUMBER_PREFIXES, PEOPLE_COLUMNS } from "@/lib/import-synonyms";
import { IMPORT_KINDS, type ImportKind, hasLines, isLineField, targetOf, targetsFor } from "@/lib/import-targets";

export type Cell = string | number | boolean | Date | null | undefined;

/** One sheet as read from the file. Row numbers are the file's own (the header row is row 1). */
export type ParsedSheet = { name: string; headers: string[]; rows: Cell[][]; rowNumbers: number[] };

/** A saved mapping (import_mappings): header layout -> {normalised header: target field, or "" for ignore}. */
export type SavedMapping = { kind: ImportKind; header_signature: string; mapping: Record<string, string> };

export type ColumnSource = "saved" | "export" | "synonym" | "manual" | "none";
export type ColumnPlan = {
  index: number;
  header: string;
  /** The header as compared. */
  norm: string;
  /** A target field key (`lines.x` for a line), or null: not imported. */
  target: string | null;
  source: ColumnSource;
  /** Why a column with no target is left out: it is calculated in Tolra, a person on another kind of document, or a second match for a field. */
  reason?: "derived" | "people" | "duplicate" | "kind" | "empty";
  /** For "people": what it is called ("PO sent by"). For "duplicate": the field it also matched. */
  detail?: string;
  /** Some cell below the header has a value (an empty column is not offered for mapping). */
  hasData: boolean;
};

export type SheetPlan = {
  id: string;
  sheetName: string;
  /** What the admin or the detection chose; null = not chosen yet. */
  kind: ImportKind | null;
  /** The best guess when `kind` is null (shown as "Looks like ..."). */
  suggestion: ImportKind | null;
  /** How the kind was found. */
  kindSource: "saved" | "headers" | "kind column" | "manual" | "none";
  /** True when a sheet's rows were split off by its Kind column. */
  fromKindColumn: boolean;
  headers: string[];
  signature: string;
  columns: ColumnPlan[];
  rows: Cell[][];
  rowNumbers: number[];
  /** Rows a Kind column could not place (value, file row). */
  unplaced: { row: number; value: string }[];
};

// ---------------------------------------------------------------------------------------------------------------------
// Words

/** Lower case, "&" as "and", letters and digits and single spaces only: "Inv No." and "INV-NO" and "inv  no" match. */
export function normaliseHeader(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/%/g, " pct ")
    .replace(/#/g, " no ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const compact = (value: unknown) => normaliseHeader(value).replace(/ /g, "");

// "vat %" is looked up as "vat pct", "no" for "#": the synonym list is normalised the same way, so write it either way.
const compactWords = (list: string[]) => new Set(list.map(compact));

type Lookup = Map<string, string>;
function synonymLookup(kind: ImportKind): Lookup {
  const map: Lookup = new Map();
  for (const [field, words] of Object.entries(FIELD_SYNONYMS[kind])) for (const word of words) { const key = compact(word); if (!map.has(key)) map.set(key, field); }
  return map;
}
const SYNONYMS = Object.fromEntries(IMPORT_KINDS.map((k) => [k, synonymLookup(k)])) as Record<ImportKind, Lookup>;

// ---------------------------------------------------------------------------------------------------------------------
// Our own export's columns -> the field they fill (null: calculated in Tolra, nothing to import)

type Bridge = { target: string | null; rank: number };
const EXPORT_TARGET: Record<ImportKind, Record<string, string | null>> = {
  customers: { name: "name", contact_name: "contact_name", email: "email", phone: "phone", mobile: "mobile", address: "address", notes: "notes" },
  suppliers: { name: "name", contact_name: "contact_name", email: "email", phone: "phone", notes: "notes", on_time_rate: null, reliability_status: null },
  stock: {},
  quotes: {
    quote_ref: "quote_ref", version: null, customer: "customer", description: "description", quote_date: "quote_date", valid_until: "valid_until",
    sent_date: null, vat_enabled: "vat_enabled", total: "total_value", status: null, stored_status: "status",
  },
  sales_orders: {
    ref: "so_number", customer: "customer", customer_po: "customer_po", quote_ref: "quote_ref", order_date: "order_date", delivery_date: "delivery_date",
    net: "total_value", vat_enabled: null, vat_rate: null, status: "status", job_no: null,
  },
  jobs: {
    job_no: "job_no", customer: "customer", description: "description", customer_po: "customer_po", quote_ref: "quote_ref", drawing_no: "drawing_no",
    quantity_required: "quantity_required", date_received: "date_received", date_required: "due_date", started: null, finished: null, inspected: null,
    stage: "stage", status: "status", internal: null,
  },
  purchase_orders: {
    po_ref: "po_ref", supplier: "supplier", order_date: "order_date", expected_delivery: "expected_delivery", net: "total_value", vat_enabled: "vat_enabled",
    status: "status", sent_date: null, received_date: null, notes: "notes",
  },
  invoices: {
    reference: "invoice_ref", customer: "customer", invoice_date: "invoice_date", due_date: "due_date", tax_point: null, terms: "terms", quote_ref: "quote_ref",
    customer_po: "customer_po", net: "subtotal", vat: "vat", total: "total", paid: null, credited: null, balance: null, status: null, stored_status: "status",
  },
  payments: {
    invoice_ref: "invoice_ref", paid_on: "paid_on", amount: "amount", method: "method", reference: "reference", source: null, type: "_type", reversed: "_reversed",
    void_reason: null, recorded_on: null,
  },
  // No export of their own yet: read by their headers (lib/import-synonyms.ts).
  credit_notes: {},
  delivery_notes: {},
};
/** A column that is the stored value wins over the page's derived one when both are in the file ("Stored Status" over "Status"). */
const STORED_RANK = new Set(["stored_status"]);

function exportLookup(kind: ImportKind): Map<string, Bridge> {
  const map = new Map<string, Bridge>();
  const specs = IMPORT_COLUMNS[kind as keyof typeof IMPORT_COLUMNS] as readonly { key: string; header: string }[] | undefined;
  for (const spec of specs ?? []) {
    const target = EXPORT_TARGET[kind][spec.key];
    if (target === undefined) continue;
    map.set(compact(spec.header), { target, rank: STORED_RANK.has(spec.key) ? 20 : 10 });
  }
  return map;
}
const EXPORTS = Object.fromEntries(IMPORT_KINDS.map((k) => [k, exportLookup(k)])) as Record<ImportKind, Map<string, Bridge>>;

// ---------------------------------------------------------------------------------------------------------------------
// Sheet signature (the saved mapping's key): the set of headers, order-free

export async function headerSignature(headers: string[]): Promise<string> {
  const text = headers.map(normaliseHeader).filter(Boolean).sort().join("\n");
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------------------------------
// Kind words

/** "Invoices" / "invoice" / "SO": the kind a word names (sheet name or Kind cell). */
export function kindFromWord(value: unknown): ImportKind | null {
  const word = compact(value);
  if (!word) return null;
  for (const kind of IMPORT_KINDS) if (KIND_WORDS[kind].some((w) => compact(w) === word)) return kind;
  return null;
}

const KIND_COLUMN_SET = compactWords(KIND_COLUMN_HEADERS);

/**
 * The column that says what each row is, when there is one: its header is a Kind word and at least two different kinds are named in
 * it (our payments export has a "Type" column, Payment or Reversal, which is not one).
 */
export function findKindColumn(sheet: ParsedSheet): number | null {
  for (let i = 0; i < sheet.headers.length; i += 1) {
    if (!KIND_COLUMN_SET.has(compact(sheet.headers[i]))) continue;
    const kinds = new Set<string>();
    let named = 0;
    let filled = 0;
    for (const row of sheet.rows) {
      const cell = cellText(row[i]);
      if (!cell) continue;
      filled += 1;
      const kind = kindFromWord(cell);
      if (kind) { kinds.add(kind); named += 1; }
    }
    if (kinds.size >= 2 && named * 2 >= filled) return i;
    if (compact(sheet.headers[i]) === "kind" && kinds.size >= 1) return i;
  }
  return null;
}

const cellText = (cell: Cell): string => (cell === null || cell === undefined ? "" : cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell).trim());

// ---------------------------------------------------------------------------------------------------------------------
// Columns of one sheet read as one kind

type Candidate = { index: number; target: string | null; source: ColumnSource; rank: number; reason?: ColumnPlan["reason"]; detail?: string };

const PEOPLE_LOOKUP = new Map(PEOPLE_COLUMNS.flatMap((p) => p.headers.map((h) => [compact(h), p.label] as const)));

/** Every word any kind knows as a header: synonyms, our export columns, the person columns, a Kind column. */
const KNOWN_HEADERS: Set<string> = new Set([
  ...IMPORT_KINDS.flatMap((k) => [...SYNONYMS[k].keys(), ...EXPORTS[k].keys()]),
  ...PEOPLE_LOOKUP.keys(), ...KIND_COLUMN_SET,
]);

/**
 * How much a row looks like a header row: the number of its different cells that are a word some kind knows as a header. A title row
 * ("Marpet customers, October") or a blank row scores 0 or 1; a real header row scores 2 or more.
 */
export function headerScore(cells: Cell[]): number {
  const seen = new Set<string>();
  for (const cell of cells) {
    if (cell === null || cell === undefined || cell instanceof Date || typeof cell === "number") continue;
    const word = compact(cell);
    if (word && KNOWN_HEADERS.has(word)) seen.add(word);
  }
  return seen.size;
}
/** A bare "Description" is the line's when the sheet has quantity or price columns (an invoice or quote with a row per line). */
const BARE_DESCRIPTION = new Set(["description", "details"]);

/**
 * Fills `columns` for a kind: saved mapping, export spec, synonyms; one column per field (the strongest, then the leftmost), except a
 * joined field ("Address1" ... "Address6" all fill the address).
 */
export function mapColumns(headers: string[], rows: Cell[][], kind: ImportKind, saved: SavedMapping | null, kindColumn: number | null = null): ColumnPlan[] {
  const targets = new Set(targetsFor(kind).map((t) => t.key));
  const exportBridge = EXPORTS[kind];
  const synonyms = SYNONYMS[kind];
  const candidates: Candidate[] = headers.map((header, index) => {
    const norm = normaliseHeader(header);
    if (index === kindColumn) return { index, target: null, source: "none", rank: 0, reason: "kind" };
    if (!norm) return { index, target: null, source: "none", rank: 0, reason: "empty" };
    if (saved && Object.prototype.hasOwnProperty.call(saved.mapping, norm)) {
      const target = saved.mapping[norm] || null;
      return { index, target: target && targets.has(target) ? target : null, source: "saved", rank: 100 };
    }
    const key = compact(header);
    const bridge = exportBridge.get(key);
    if (bridge) return bridge.target === null ? { index, target: null, source: "export", rank: 0, reason: "derived" } : { index, target: bridge.target, source: "export", rank: bridge.rank };
    const field = synonyms.get(key);
    if (field) return { index, target: field, source: "synonym", rank: 5 };
    // A person on another kind of document ("Delivery note signed by" on an invoice sheet): reported, not imported.
    const people = PEOPLE_LOOKUP.get(key);
    if (people) return { index, target: null, source: "none", rank: 0, reason: "people", detail: people };
    return { index, target: null, source: "none", rank: 0 };
  });

  // A bare "Description" on a sheet with line columns is the line's description.
  if (hasLines(kind)) {
    const lineColumns = candidates.some((c) => c.target === "lines.quantity" || c.target === "lines.unit_price");
    if (lineColumns && !candidates.some((c) => c.target === "lines.description")) {
      const bare = candidates.find((c) => c.source === "synonym" && c.target === "description" && BARE_DESCRIPTION.has(compact(headers[c.index])));
      if (bare) bare.target = "lines.description";
    }
  }

  // One column per field (a joined field takes them all).
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    if (!c.target || targetOf(kind, c.target)?.joined) continue;
    const current = best.get(c.target);
    if (!current || c.rank > current.rank) best.set(c.target, c);
  }
  return candidates.map((c) => {
    let { target, reason, detail } = c;
    if (target && !targetOf(kind, target)?.joined && best.get(target) !== c) { detail = targetOf(kind, target)?.label; target = null; reason = "duplicate"; }
    const hasData = rows.some((row) => cellText(row[c.index]) !== "");
    return { index: c.index, header: String(headers[c.index] ?? ""), norm: normaliseHeader(headers[c.index]), target, source: c.source, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}), hasData };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Which kind

type Score = { kind: ImportKind; score: number };

/**
 * A credit note or delivery note number column says what the sheet is (an invoice or job sheet never has one), as it did when 076 only
 * reported them: its key weighs 6, any other kind's 3.
 */
const KEY_WEIGHT: Partial<Record<ImportKind, number>> = { credit_notes: 6, delivery_notes: 6 };

/** Score of the headers against each kind (0 = cannot be that kind: its match key is not there). */
export function scoreKinds(sheet: Pick<ParsedSheet, "name" | "headers" | "rows">): Score[] {
  const nameKind = kindFromWord(sheet.name);
  return IMPORT_KINDS.map((kind) => {
    const columns = mapColumns(sheet.headers, sheet.rows, kind, null);
    const matched = new Set<string>();
    let score = 0;
    for (const c of columns) {
      if (c.reason === "derived") { score += 2; continue; }
      if (!c.target || matched.has(c.target)) continue;
      matched.add(c.target);
      const field = targetOf(kind, c.target);
      const isKey = Boolean(field?.key_field) || (kind === "payments" && ["paid_on", "amount"].includes(c.target));
      score += isKey ? KEY_WEIGHT[kind] ?? 3 : c.source === "export" ? 2 : 1;
    }
    const keyed = kind === "payments" ? matched.has("invoice_ref") && (matched.has("paid_on") || matched.has("amount")) : targetsFor(kind).some((t) => t.key_field && matched.has(t.key));
    if (!keyed) return { kind, score: 0 };
    if (nameKind === kind) score += 3;
    return { kind, score };
  });
}

/** The kind the headers say, only when sure: a clear best score. Otherwise null and the best guess. */
export function detectKind(sheet: Pick<ParsedSheet, "name" | "headers" | "rows">): { kind: ImportKind | null; suggestion: ImportKind | null } {
  const ranked = scoreKinds(sheet).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { kind: null, suggestion: null };
  const [top, next] = ranked;
  const sure = top.score >= 5 && top.score - (next?.score ?? 0) >= 2;
  return { kind: sure ? top.kind : null, suggestion: top.kind };
}

/**
 * A sheet whose headers name no kind: its first filled column's numbers (every one CRD-, or DLN-) or its name ("Credit notes") suggest one.
 * Only a suggestion ("looks like ..."): the admin chooses.
 */
export function suggestFromSheet(sheet: Pick<ParsedSheet, "name" | "headers" | "rows">): ImportKind | null {
  const first = sheet.headers.findIndex((_, i) => sheet.rows.some((row) => cellText(row[i]) !== ""));
  if (first >= 0) {
    const values = sheet.rows.map((row) => cellText(row[first])).filter(Boolean);
    if (values.length) for (const [kind, prefix] of Object.entries(NUMBER_PREFIXES)) if (values.every((v) => prefix!.test(v))) return kind as ImportKind;
  }
  return kindFromWord(sheet.name);
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans

let planCounter = 0;
const nextId = () => `sheet-${(planCounter += 1)}`;

const savedFor = (saved: SavedMapping[], kind: ImportKind, signature: string) => saved.find((s) => s.kind === kind && s.header_signature === signature) ?? null;

/**
 * One or more plans for a sheet. A sheet with a Kind column becomes one plan per kind named in it (rows no kind names are `unplaced`:
 * a problem the admin sees, never a guess); any other sheet is one plan. A saved mapping for the same header layout fixes the kind.
 */
export async function planSheet(sheet: ParsedSheet, saved: SavedMapping[]): Promise<SheetPlan[]> {
  const signature = await headerSignature(sheet.headers);
  const kindColumn = findKindColumn(sheet);

  if (kindColumn !== null) {
    const groups = new Map<ImportKind, { rows: Cell[][]; numbers: number[] }>();
    const unplaced: { row: number; value: string }[] = [];
    sheet.rows.forEach((row, i) => {
      if (row.every((c) => cellText(c) === "")) return;
      const word = cellText(row[kindColumn]);
      const kind = kindFromWord(word);
      if (!kind) { unplaced.push({ row: sheet.rowNumbers[i], value: word }); return; }
      const group = groups.get(kind) ?? { rows: [], numbers: [] };
      group.rows.push(row);
      group.numbers.push(sheet.rowNumbers[i]);
      groups.set(kind, group);
    });
    const plans: SheetPlan[] = [];
    for (const [kind, group] of groups) {
      plans.push({
        id: nextId(), sheetName: sheet.name, kind, suggestion: kind, kindSource: "kind column", fromKindColumn: true,
        headers: sheet.headers, signature, rows: group.rows, rowNumbers: group.numbers, unplaced: [],
        columns: mapColumns(sheet.headers, group.rows, kind, savedFor(saved, kind, signature), kindColumn),
      });
    }
    if (unplaced.length) {
      if (!plans.length) plans.push(emptyPlan(sheet, signature));
      plans[0].unplaced = unplaced;
    }
    return plans;
  }

  const savedKind = IMPORT_KINDS.map((k) => savedFor(saved, k, signature)).find(Boolean) ?? null;
  const detected = savedKind ? { kind: savedKind.kind, suggestion: savedKind.kind } : detectKind(sheet);
  // Not sure from the headers: CRD- / DLN- numbers or the sheet's name come first for the suggestion.
  const found = detected.kind ? detected : { kind: null, suggestion: suggestFromSheet(sheet) ?? detected.suggestion };
  const plan: SheetPlan = {
    ...emptyPlan(sheet, signature), kind: found.kind, suggestion: found.suggestion, kindSource: savedKind ? "saved" : found.kind ? "headers" : "none",
    rows: sheet.rows, rowNumbers: sheet.rowNumbers,
    columns: found.kind ? mapColumns(sheet.headers, sheet.rows, found.kind, savedKind) : blankColumns(sheet.headers, sheet.rows),
  };
  return [plan];
}

/** Columns of a sheet whose kind is not chosen: nothing mapped yet (a person column is still named). */
function blankColumns(headers: string[], rows: Cell[][]): ColumnPlan[] {
  return headers.map((header, index) => {
    const people = PEOPLE_LOOKUP.get(compact(header));
    return {
      index, header: String(header ?? ""), norm: normaliseHeader(header), target: null, source: "none" as const,
      ...(people ? { reason: "people" as const, detail: people } : {}), hasData: rows.some((row) => cellText(row[index]) !== ""),
    };
  });
}

function emptyPlan(sheet: ParsedSheet, signature: string): SheetPlan {
  return {
    id: nextId(), sheetName: sheet.name, kind: null, suggestion: null, kindSource: "none", fromKindColumn: false,
    headers: sheet.headers, signature, columns: [], rows: [], rowNumbers: [], unplaced: [],
  };
}

/** The admin chose what a sheet is: its columns are read again for that kind (the saved mapping for that kind and layout, if any). */
export function chooseKind(plan: SheetPlan, kind: ImportKind | null, saved: SavedMapping[]): SheetPlan {
  if (kind === null) return { ...plan, kind: null, kindSource: "none", columns: blankColumns(plan.headers, plan.rows) };
  const kindColumn = plan.fromKindColumn ? plan.columns.find((c) => c.reason === "kind")?.index ?? null : null;
  return { ...plan, kind, kindSource: "manual", columns: mapColumns(plan.headers, plan.rows, kind, savedFor(saved, kind, plan.signature), kindColumn) };
}

/** The admin picked a field (or "ignore" = null) for a column. A field a second column already has moves to this one (a joined field is shared). */
export function chooseTarget(plan: SheetPlan, index: number, target: string | null): SheetPlan {
  const shared = Boolean(target && plan.kind && targetOf(plan.kind, target)?.joined);
  const columns = plan.columns.map((c) => {
    if (c.index === index) return { ...c, target, source: "manual" as const, reason: target ? undefined : c.reason, detail: undefined };
    if (target && !shared && c.target === target) return { ...c, target: null, source: "manual" as const, reason: "duplicate" as const, detail: plan.kind ? targetOf(plan.kind, target)?.label : undefined };
    return c;
  });
  return { ...plan, columns };
}

/** The mapping to save for this layout: every named column's field, or "" for ignore. Null when nothing was chosen by hand. */
export function mappingToSave(plan: SheetPlan): Record<string, string> | null {
  if (!plan.kind) return null;
  if (plan.kindSource !== "manual" && !plan.columns.some((c) => c.source === "manual")) return null;
  const mapping: Record<string, string> = {};
  for (const c of plan.columns) if (c.norm && c.reason !== "kind") mapping[c.norm] = c.target ?? "";
  return mapping;
}

/** Columns that name a person on another kind of document: reported, not imported. */
export const peopleColumns = (plan: SheetPlan) => plan.columns.filter((c) => c.reason === "people");

/** Headers nothing recognised that have data: offered for mapping (a field, or ignore). */
export const unrecognisedColumns = (plan: SheetPlan) => plan.columns.filter((c) => !c.target && c.hasData && c.source === "none" && !c.reason);

/** Does the sheet fill the kind's match key? (A sheet that doesn't gets a problem on every row from the database; this says why up front.) */
export function missingKeyField(plan: SheetPlan): string | null {
  if (!plan.kind) return null;
  const mapped = new Set(plan.columns.map((c) => c.target));
  const key = targetsFor(plan.kind).find((t) => t.key_field);
  return key && !mapped.has(key.key) && !isLineField(key.key) ? key.label : null;
}
