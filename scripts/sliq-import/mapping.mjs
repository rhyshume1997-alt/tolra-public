// The one place that says which source column feeds which canonical field. Mappings live in JSON files under
// scripts/sliq-import/mappings/ (or any path given with --mapping): columns are matched by HEADER NAME (case and extra spaces
// ignored), never by position. Nothing is guessed: a required column that is not in the file stops the run with a list.
//
//   status "stub"        every column empty: the run stops.
//   status "provisional" the likely SliQ headers from research, NOT confirmed against the JNR controller's real files. Dry runs work and say
//                        so; --write is refused until the file says "confirmed": true.
//   status "confirmed"   checked against the real headers (the synthetic fixtures' mapping is confirmed by construction).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class MappingError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = "MappingError";
    this.problems = problems;
  }
}

const MAPPINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "mappings");

/** kind -> canonical field -> { type, required }. */
export const CANONICAL = {
  customers: {
    key: { type: "text", required: false },
    name: { type: "text", required: true },
    contact: { type: "text", required: false },
    address: { type: "text", required: false },
    postcode: { type: "text", required: false },
    email: { type: "text", required: false },
    phone: { type: "text", required: false },
    vatNumber: { type: "text", required: false },
    notes: { type: "text", required: false },
  },
  suppliers: {
    key: { type: "text", required: false },
    name: { type: "text", required: true },
    contact: { type: "text", required: false },
    address: { type: "text", required: false },
    postcode: { type: "text", required: false },
    email: { type: "text", required: false },
    phone: { type: "text", required: false },
    vatNumber: { type: "text", required: false },
    notes: { type: "text", required: false },
  },
  products: {
    code: { type: "text", required: true },
    description: { type: "text", required: true },
    unitPrice: { type: "money", required: false },
    stock: { type: "integer", required: false }, // present and numeric = a stock item; blank = a price-list item, not written
    vatRate: { type: "percent", required: false },
  },
  quotes: {
    number: { type: "text", required: true },
    date: { type: "date", required: false },
    customer: { type: "text", required: true },
    net: { type: "money", required: false },
    vat: { type: "money", required: false },
    gross: { type: "money", required: true },
    status: { type: "status", required: true },
    validUntil: { type: "date", required: false },
    notes: { type: "text", required: false },
    discount: { type: "discount", required: false },
  },
  invoices: {
    number: { type: "text", required: true },
    docType: { type: "docType", required: false },
    date: { type: "date", required: true },
    dueDate: { type: "date", required: false },
    customer: { type: "text", required: true },
    net: { type: "money", required: true },
    vat: { type: "money", required: true },
    gross: { type: "money", required: true },
    status: { type: "status", required: true },
    amountPaid: { type: "money", required: false },
    relatedInvoice: { type: "text", required: false },
    notes: { type: "text", required: false },
    vatCode: { type: "text", required: false },
    discount: { type: "discount", required: false },
  },
  creditNotes: {
    number: { type: "text", required: true },
    date: { type: "date", required: true },
    customer: { type: "text", required: true },
    net: { type: "money", required: true },
    vat: { type: "money", required: true },
    gross: { type: "money", required: true },
    relatedInvoice: { type: "text", required: false },
    reason: { type: "text", required: false },
    notes: { type: "text", required: false },
  },
  allocations: {
    creditNoteNumber: { type: "text", required: true },
    invoiceNumber: { type: "text", required: true },
    amount: { type: "money", required: true },
    date: { type: "date", required: false },
  },
  invoiceLines: {
    documentNumber: { type: "text", required: true },
    description: { type: "text", required: true },
    quantity: { type: "quantity", required: true },
    unitPrice: { type: "money", required: true },
    net: { type: "money", required: false },
    vatRate: { type: "percent", required: false },
    vatAmount: { type: "money", required: false },
    vatCode: { type: "text", required: false },
    discount: { type: "discount", required: false },
  },
  payments: {
    invoiceNumber: { type: "text", required: true },
    date: { type: "date", required: true, blankOk: true }, // a blank date is allowed: that payment stays "to confirm"
    amount: { type: "money", required: true },
    method: { type: "text", required: false },
    reference: { type: "text", required: false },
  },
  purchaseOrders: {
    number: { type: "text", required: true },
    supplier: { type: "text", required: true },
    orderDate: { type: "date", required: false },
    deliveryDate: { type: "date", required: false },
    total: { type: "money", required: false },
    status: { type: "poStatus", required: false },
    jobRef: { type: "text", required: false }, // the job the order was bought for (linked by jobs-write.mjs)
  },
};

/** Identifier fields: a numeric spreadsheet cell here may have lost leading zeros, so it is reported. */
export const IDENTIFIER_FIELDS = new Set(["number", "documentNumber", "invoiceNumber", "creditNoteNumber", "code", "key", "relatedInvoice"]);

export const FILE_KINDS = [
  { kind: "customers", required: true },
  { kind: "invoices", required: true },
  { kind: "suppliers", required: false },
  { kind: "products", required: false },
  { kind: "quotes", required: false },
  { kind: "invoiceLines", required: false },
  { kind: "payments", required: false },
  { kind: "creditNotes", required: false },
  { kind: "allocations", required: false },
  { kind: "purchaseOrders", required: false },
];

/** Header matching ignores case and extra spaces. */
export const normHeader = (h) => String(h ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Loads a mapping by name (scripts/sliq-import/mappings/<name>.json) or by path to a JSON file. */
export function getProfile(idOrPath) {
  const file = /^[a-z0-9-]+$/.test(idOrPath) ? path.join(MAPPINGS_DIR, `${idOrPath}.json`) : path.resolve(idOrPath);
  let raw;
  let fileBytes;
  try {
    fileBytes = readFileSync(file);
    raw = JSON.parse(fileBytes.toString("utf8"));
  } catch (e) {
    throw new MappingError(`Mapping "${idOrPath}" cannot be read (${e.code === "ENOENT" ? "no such mapping file" : e.message}).`);
  }
  if (!["stub", "provisional", "confirmed"].includes(raw.status)) throw new MappingError(`Mapping ${file}: "status" must be stub, provisional or confirmed.`);
  const files = {};
  for (const { kind } of FILE_KINDS) {
    const f = raw.files?.[kind] ?? {};
    files[kind] = { file: [].concat(f.file ?? `${kind}.csv`), columns: f.columns ?? {} };
  }
  return {
    id: raw.id ?? path.basename(file, ".json"),
    fileName: path.basename(file),
    fileSha256: createHash("sha256").update(fileBytes).digest("hex"), // the whole file is part of what an approval covers
    label: raw.label ?? raw.id,
    status: raw.status,
    isStub: raw.status === "stub",
    isProvisional: raw.status === "provisional",
    confirmed: raw.status === "confirmed" && raw.confirmed !== false,
    dateFormat: raw.dateFormat ?? null, // recorded confirmation (optional); a flag overrides it
    encoding: raw.encoding ?? null,
    files,
    statusWords: raw.statusWords ?? { invoice: {}, quote: {}, po: {} },
    docTypeWords: raw.docTypeWords ?? {},
    paymentMethodWords: raw.paymentMethodWords ?? {},
    reverseChargeCodes: raw.reverseChargeCodes ?? [],
  };
}

/** A column spec is a header, a list of headers (joined, text only) or { anyOf: [headers] } (the first one present). */
export function resolveColumn(spec, headersNorm) {
  if (spec === undefined || spec === null || spec === "") return { mapped: false, present: [], wanted: [] };
  const wanted = Array.isArray(spec) ? spec : spec.anyOf ? spec.anyOf : [spec];
  const present = wanted.filter((h) => headersNorm.includes(normHeader(h)));
  const used = spec.anyOf ? present.slice(0, 1) : present;
  return { mapped: true, present: used, wanted, join: Array.isArray(spec) };
}

/**
 * Checks a profile against the headers found. `found` = { kind: { headers } }.
 * A problem is: a required file missing, a required field unmapped or its column absent, a header present twice (after
 * ignoring case and spaces), or the same header feeding two fields. Optional columns that are absent are not problems.
 */
export function checkMapping(profile, found) {
  const problems = [];
  for (const { kind, required } of FILE_KINDS) {
    const spec = profile.files[kind];
    const got = found[kind];
    const fileName = got?.file ?? spec.file[0];
    if (!got) {
      if (required) problems.push({ file: fileName, kind, problem: "file missing", detail: `required file ${spec.file.join(" or ")} (or a worksheet with the right headers) was not found` });
      continue;
    }
    const norm = got.headers.map(normHeader);
    const used = new Map();
    for (const [field, def] of Object.entries(CANONICAL[kind])) {
      const r = resolveColumn(spec.columns[field], norm);
      if (!r.mapped) {
        if (def.required) problems.push({ file: fileName, kind, field, problem: "required field not mapped", detail: `no source column is mapped to "${field}"` });
        continue;
      }
      if (r.present.length === 0 || (r.join && def.required && r.present.length < r.wanted.length)) {
        if (def.required) problems.push({ file: fileName, kind, field, problem: "column missing", detail: `column ${r.wanted.map((w) => `"${w}"`).join(" or ")} (for "${field}") is not in the file` });
        continue;
      }
      for (const h of r.present) {
        const n = norm.filter((x) => x === normHeader(h)).length;
        if (n > 1) problems.push({ file: fileName, kind, field, problem: "column ambiguous", detail: `column "${h}" appears ${n} times in the file` });
        if (used.has(normHeader(h))) problems.push({ file: fileName, kind, field, problem: "column mapped twice", detail: `"${h}" feeds both "${used.get(normHeader(h))}" and "${field}"` });
        used.set(normHeader(h), field);
      }
    }
    for (const field of Object.keys(spec.columns)) {
      if (!(field in CANONICAL[kind])) problems.push({ file: fileName, kind, field, problem: "unknown canonical field", detail: `"${field}" is not a field of ${kind}` });
    }
  }
  return problems;
}

export function describeProblems(profile, problems) {
  const lines = problems.map((p) => `  - ${p.file}: ${p.problem}: ${p.detail}`);
  const note = profile.isStub
    ? "\nThe SliQ column mapping is a STUB (scripts/sliq-import/mappings): no headers are mapped. Nothing is guessed.\n"
    : profile.isProvisional
      ? "\nProvisional mapping, confirm against the real headers: these are the likely SliQ headers, not yet checked against the JNR controller's files.\n"
      : "\n";
  return `Mapping "${profile.id}" cannot read this folder:${note}${lines.join("\n")}\nNothing was read further and nothing was written.`;
}

/** The source columns of a file that no canonical field uses (listed in the report). */
export function unmappedColumns(profile, kind, headers) {
  const norm = headers.map(normHeader);
  const usedSet = new Set();
  for (const field of Object.keys(CANONICAL[kind])) for (const h of resolveColumn(profile.files[kind].columns[field], norm).present) usedSet.add(normHeader(h));
  return headers.filter((h) => !usedSet.has(normHeader(h)));
}
