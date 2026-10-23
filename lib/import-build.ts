/**
 * Admin > Data: the sheets (each with its kind and columns) as the payload migration 076's import_company_data reads.
 *
 * What this does to a cell: writes it the way 076 reads it (a date as YYYY-MM-DD, a number as a plain decimal), nothing else. It does not
 * match, link, default or correct anything: the document number, the customer's name and the links are 076's to decide, and every
 * problem comes back from its dry run with the row the file gave.
 *
 * Order: the kinds go in the import's dependency order (customers, suppliers, stock, quotes, sales orders, jobs, purchase orders, invoices
 * with their lines, payments, credit notes, delivery notes), whatever order the sheets are in the file. All sheets go in ONE payload: a
 * payment or a credit note is written with its invoice (the database refuses one for an invoice already in Tolra), so an invoice sheet,
 * a payments sheet and a credit notes sheet are one import.
 */
import { type Cell, type SheetPlan, peopleColumns } from "@/lib/import-detect";
import { IMPORT_KINDS, type ImportKind, KIND_LABEL, KIND_ONE, hasLines, isLineField, targetOf, targetsFor } from "@/lib/import-targets";

export type ImportRecord = Record<string, unknown>;
export type ImportPayload = { file_name: string; file_sha256: string } & Partial<Record<ImportKind, ImportRecord[]>>;

/** A problem found before the database is asked (a row no Kind names). The database's own problems come back from the dry run. */
export type ClientProblem = { sheet: string; row: number; field: string | null; message: string };

/** Something the admin should know that does not stop the import. */
export type Notice = { tone: "info" | "warning"; message: string };

export type BuiltImport = {
  payload: ImportPayload;
  /** Rows per kind (a quote with lines is one). */
  records: Record<ImportKind, number>;
  problems: ClientProblem[];
  notices: Notice[];
  /** Sheets in the order they will be imported. */
  order: { sheet: string; kind: ImportKind; rows: number }[];
};

// ---------------------------------------------------------------------------------------------------------------------
// Cells

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** A plain decimal: at most 6 places, no exponent, no trailing zeros ("12.5", "3"). Spreadsheet float noise (1234.5600000001) is cut at 6 places. */
export function decimalText(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const text = n.toFixed(6).replace(/\.?0+$/, "");
  return text === "-0" || text === "" ? "0" : text;
}

/** A date cell as 076 reads it. A real date, YYYY-MM-DD, or day first (UK) DD/MM/YYYY, DD.MM.YYYY or DD-MM-YYYY. Anything else is left as written (the database says why). */
export function dateText(cell: Exclude<Cell, null | undefined>): string {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? "" : cell.toISOString().slice(0, 10);
  const text = String(cell).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const uk = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (uk) return iso(Number(uk[3]), Number(uk[2]), Number(uk[1])) ?? text;
  const stamp = /^(\d{4})-(\d{2})-(\d{2})[T ]/.exec(text);
  if (stamp) return `${stamp[1]}-${stamp[2]}-${stamp[3]}`;
  return text;
}

/** A number cell: a number as a plain decimal; text with a pound sign, spaces or thousands commas cleaned ("£1,234.50" -> "1234.50"); anything else as written. */
export function numberText(cell: Exclude<Cell, null | undefined>): string {
  if (typeof cell === "number") return decimalText(cell);
  const text = String(cell).trim();
  const cleaned = text.replace(/^£\s*/, "").replace(/\s+/g, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) return cleaned.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(cleaned) && cleaned !== text) return cleaned;
  return text;
}

/** One cell as the payload's text for a field of this type; undefined for an empty cell. */
export function cellValue(cell: Cell, type: "text" | "date" | "number" | "money" | "bool"): string | undefined {
  if (cell === null || cell === undefined) return undefined;
  let text: string;
  if (type === "date") text = dateText(cell);
  else if (type === "number" || type === "money") text = numberText(cell);
  else if (typeof cell === "boolean") text = cell ? "true" : "false";
  else if (cell instanceof Date) text = Number.isNaN(cell.getTime()) ? "" : cell.toISOString().slice(0, 10);
  else if (typeof cell === "number") text = decimalText(cell);
  else text = String(cell);
  return text.trim() === "" ? undefined : text;
}

const isBlank = (row: Cell[]) => row.every((c) => c === null || c === undefined || String(c).trim() === "");

// ---------------------------------------------------------------------------------------------------------------------
// A customer's or supplier's joined and notes-only fields

const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0"]);
/** Same words, whatever the case and punctuation ("ACME Ltd." and "Acme Ltd"). */
const sameText = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, "") === b.toLowerCase().replace(/[^a-z0-9]+/g, "");
const isZero = (value: string) => /^-?0+(\.0+)?$/.test(value.trim());
const money = (value: string) => (/^-?\d+(\.\d+)?$/.test(value) ? `£${value}` : value);

/** What each notes-only field is called in the notice ("credit limit" for both of its columns). */
const NOTE_LINE: Record<string, string> = {
  delivery_address: "delivery address", credit_limit_used: "credit limit", credit_limit: "credit limit", vat_number: "VAT number", website: "website",
  terms_days: "payment terms", terms_message: "payment terms",
};

/**
 * A customer's or supplier's fields as 076 reads them. The address is its parts one per line, in column order, leaving out a part that only
 * repeats the name (an export's first address line is often the business name). What Tolra has no column for yet is written into the
 * notes, one labelled line each, after the file's own notes: the delivery address (left out when it is the same as the address), the
 * credit limit (left out when it is not in use and zero), the VAT number, the website and the payment terms. Those fields are never sent
 * on their own.
 */
export function partyFields(fields: Record<string, string>, parts: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) if (!targetOf("customers", key)?.into_notes) out[key] = value;
  const name = fields.name ?? "";
  const linesOf = (key: string) => (parts[key] ?? []).filter((part) => !(name && sameText(part, name)));
  const address = linesOf("address");
  if (address.length) out.address = address.join("\n");

  const notes: string[] = fields.notes ? [fields.notes] : [];
  const delivery = linesOf("delivery_address");
  const sameAsAddress = delivery.length === address.length && delivery.every((part, i) => sameText(part, address[i]));
  if (delivery.length && !sameAsAddress) notes.push(`Delivery address: ${delivery.join(", ")}`);

  const flag = fields.credit_limit_used?.trim().toLowerCase();
  const inUse = flag !== undefined && YES.has(flag);
  const notInUse = flag !== undefined && NO.has(flag);
  const limit = fields.credit_limit;
  if (limit !== undefined && !(isZero(limit) && !inUse)) notes.push(`Credit limit: ${money(limit)}${notInUse ? " (not in use)" : ""}`);
  else if (limit === undefined && inUse) notes.push("Credit limit: in use, no amount given");

  if (fields.vat_number) notes.push(`VAT number: ${fields.vat_number}`);
  if (fields.website) notes.push(`Website: ${fields.website}`);

  const message = fields.terms_message;
  const days = fields.terms_days;
  // "30 days" already says 30; "Payment on receipt" with 0 days gets the days added.
  const saysDays = Boolean(message && days && message.match(/\d+/g)?.includes(days));
  const terms = message && days && !saysDays ? `${message} (${days} days)` : message ?? (days ? `${days} days` : undefined);
  if (terms) notes.push(`Payment terms: ${terms}`);

  if (notes.length) out.notes = notes.join("\n");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// One sheet's records

type SheetRecords = { records: ImportRecord[]; skippedReversals: number };

function recordsOf(plan: SheetPlan & { kind: ImportKind }): SheetRecords {
  const kind = plan.kind;
  const columns = plan.columns.filter((c) => c.target && !c.target.startsWith("_"));
  const flags = {
    type: plan.columns.find((c) => c.target === "_type")?.index,
    reversed: plan.columns.find((c) => c.target === "_reversed")?.index,
  };
  const head = columns.filter((c) => !isLineField(c.target!));
  const lineCols = columns.filter((c) => isLineField(c.target!));
  const keyColumn = plan.columns.find((c) => c.target && targetOf(kind, c.target)?.key_field);
  const grouped = hasLines(kind) && lineCols.length > 0;
  const type = (c: (typeof columns)[number]) => targetOf(kind, c.target!)!.type;
  let skippedReversals = 0;

  const records: ImportRecord[] = [];
  const byKey = new Map<string, ImportRecord>();
  plan.rows.forEach((row, i) => {
    if (isBlank(row)) return;
    if (kind === "payments") {
      const isReversal = flags.type !== undefined && String(row[flags.type] ?? "").trim().toLowerCase() === "reversal";
      const wasReversed = flags.reversed !== undefined && YES.has(String(row[flags.reversed] ?? "").trim().toLowerCase());
      if (isReversal || wasReversed) { skippedReversals += 1; return; }
    }
    let fields: Record<string, string> = {};
    const parts: Record<string, string[]> = {};
    for (const c of head) {
      const value = cellValue(row[c.index], type(c));
      if (value === undefined) continue;
      if (targetOf(kind, c.target!)?.joined) (parts[c.target!] ??= []).push(value.trim());
      else fields[c.target!] = value;
    }
    if (kind === "customers" || kind === "suppliers") fields = partyFields(fields, parts);
    const line: Record<string, string> = {};
    for (const c of lineCols) {
      const value = cellValue(row[c.index], type(c));
      if (value !== undefined) line[c.target!.slice("lines.".length)] = value;
    }
    const keyValue = keyColumn ? fields[keyColumn.target!]?.trim() : undefined;
    if (grouped && keyValue) {
      const existing = byKey.get(keyValue);
      if (existing) {
        for (const [k, v] of Object.entries(fields)) if (!(k in existing)) existing[k] = v;
        if (Object.keys(line).length) (existing.lines as ImportRecord[]).push(line);
        return;
      }
      const record: ImportRecord = { row: plan.rowNumbers[i], ...fields, lines: Object.keys(line).length ? [line] : [] };
      byKey.set(keyValue, record);
      records.push(record);
      return;
    }
    const record: ImportRecord = { row: plan.rowNumbers[i], ...fields };
    if (grouped) record.lines = Object.keys(line).length ? [line] : [];
    records.push(record);
  });
  return { records, skippedReversals };
}

// ---------------------------------------------------------------------------------------------------------------------
// The whole import

/** The payload for every sheet that has a kind, with what could not go in and what the admin should be told. */
export function buildImport(plans: SheetPlan[], file: { name: string; sha256: string }): BuiltImport {
  const problems: ClientProblem[] = [];
  const notices: Notice[] = [];
  const records = Object.fromEntries(IMPORT_KINDS.map((k) => [k, 0])) as Record<ImportKind, number>;
  const sections: Partial<Record<ImportKind, ImportRecord[]>> = {};
  const order: BuiltImport["order"] = [];

  const ordered = plans
    .filter((p): p is SheetPlan & { kind: ImportKind } => p.kind !== null)
    .sort((a, b) => IMPORT_KINDS.indexOf(a.kind) - IMPORT_KINDS.indexOf(b.kind));

  for (const plan of ordered) {
    const { records: rows, skippedReversals } = recordsOf(plan);
    sections[plan.kind] = [...(sections[plan.kind] ?? []), ...rows];
    records[plan.kind] += rows.length;
    order.push({ sheet: plan.sheetName, kind: plan.kind, rows: rows.length });
    if (skippedReversals) notices.push({ tone: "info", message: `${plan.sheetName}: ${skippedReversals} reversed payment row${skippedReversals === 1 ? "" : "s"} (a Reversal, or a payment that was reversed) left out, as the export says an import should.` });
  }

  for (const plan of plans) {
    for (const u of plan.unplaced) {
      problems.push({ sheet: plan.sheetName, row: u.row, field: "kind", message: u.value ? `The Kind "${u.value}" is not one Tolra knows (${IMPORT_KINDS.map((k) => KIND_LABEL[k].toLowerCase()).join(", ")}).` : "The Kind is empty: a mixed sheet needs a Kind on every row." });
    }
    if (plan.kind) {
      const kind = plan.kind;
      const mapped = new Set(plan.columns.filter((c) => c.target && c.hasData).map((c) => c.target));
      const lines = [...new Set(targetsFor(kind).filter((t) => t.into_notes && mapped.has(t.key)).map((t) => NOTE_LINE[t.key] ?? t.key))];
      if (lines.length) {
        const list = lines.length === 1 ? lines[0] : `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
        const one = lines.length === 1;
        notices.push({ tone: "info", message: `${plan.sheetName}: ${list} ${one ? "has" : "have"} no place of ${one ? "its" : "their"} own in Tolra yet, so ${one ? "it goes" : "they go"} into each ${KIND_ONE[kind]}'s notes.` });
      }
    }
    for (const c of peopleColumns(plan)) {
      if (c.hasData && plan.kind) notices.push({ tone: "info", message: `${plan.sheetName}: the column "${c.header}" (${c.detail}) is not part of ${KIND_LABEL[plan.kind].toLowerCase()}, so it is not imported.` });
    }
  }

  return { payload: { file_name: file.name.slice(0, 255), file_sha256: file.sha256, ...sections }, records, problems, notices, order };
}

// ---------------------------------------------------------------------------------------------------------------------
// Size (what the database will be asked to write, upper bound: nothing matched)

/** Audit rows writing this payload would add at most (076: a record 1, each line 1, an invoice 1 more; payments none; 085: a credit note given without lines gets one). */
export function estimateSize(payload: ImportPayload): { records: number; lines: number; audit_rows: number } {
  let records = 0;
  let lines = 0;
  let audit = 0;
  for (const kind of IMPORT_KINDS) {
    const list = payload[kind] ?? [];
    for (const record of list) {
      records += 1;
      const n = Array.isArray(record.lines) ? record.lines.length : 0;
      lines += n;
      audit += kind === "payments" ? 0 : kind === "invoices" ? 2 + n : kind === "credit_notes" ? 1 + Math.max(n, 1) : 1 + n;
    }
  }
  return { records, lines, audit_rows: audit };
}
