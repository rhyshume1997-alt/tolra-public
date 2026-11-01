/**
 * The global search (top bar; app/api/search/route.ts). One query, a few small reads in parallel through the SIGNED-IN person's own
 * Supabase client (row level security scopes every read to their company; the company id is also filtered explicitly), grouped, at most
 * GROUP_LIMIT results a group. Each result links to the page that already opens that record (lib/record-link, lib/invoice-link,
 * lib/job-link), so searching adds no new way to see anything.
 *
 * Who sees what mirrors the pages: a group is searched only when the person's role may open its page (middleware ROUTE_ROLES; the
 * sections in lib/sections.ts) and an admin has not hidden that page from them (Page access).
 */
import { invoiceHref } from "@/lib/invoice-link";
import { jobHref } from "@/lib/job-link";
import { customerHref, purchaseOrderHref, quoteHref } from "@/lib/record-link";

export const MIN_QUERY = 2;
export const MAX_QUERY = 100;
export const GROUP_LIMIT = 5;
/** A read that takes longer than this is left out of the answer (the group is reported as unavailable), not waited for. */
export const SEARCH_TIMEOUT_MS = 4000;

export type GroupKey = "quotes" | "invoices" | "jobs" | "purchase_orders" | "customers" | "lines";
export const GROUP_LABELS: Record<GroupKey, string> = {
  quotes: "Quotes",
  invoices: "Invoices",
  jobs: "Jobs",
  purchase_orders: "Supplier purchase orders",
  customers: "Customers",
  lines: "Line text",
};
export const GROUP_ORDER: GroupKey[] = ["quotes", "invoices", "jobs", "purchase_orders", "customers", "lines"];

/** The roles that may open each group's page (middleware ROUTE_ROLES) and the page-access section an admin can hide it under. */
const GROUP_ACCESS: Record<Exclude<GroupKey, "lines">, { roles: string[]; section: string }> = {
  quotes: { roles: ["admin", "office"], section: "quotes" },
  invoices: { roles: ["admin", "office"], section: "invoices" },
  jobs: { roles: ["admin", "office", "workshop", "viewer"], section: "jobs" },
  purchase_orders: { roles: ["admin", "office"], section: "purchase-orders" },
  customers: { roles: ["admin", "office"], section: "customers" },
};

export type SearchResult = { id: string; title: string; subtitle: string; href: string };
export type SearchGroup = { key: GroupKey; label: string; results: SearchResult[] };
export type SearchAnswer = {
  query: string;
  /** Only groups with at least one result, in GROUP_ORDER. */
  groups: SearchGroup[];
  /** Groups whose read failed or timed out (the answer is incomplete for these). */
  unavailable: GroupKey[];
};

/** The text as typed: trimmed, runs of white space collapsed, cut to MAX_QUERY. */
export function normaliseQuery(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY).trim();
}

/**
 * The text as an ilike pattern for a PostgREST `or` filter. The characters the person typed that mean something to ilike (backslash,
 * % and _) are escaped, so "a_b" never matches "axb"; the characters that would end or reopen the filter text itself (comma, brackets,
 * quotes, and * which PostgREST also reads as %) can be matched by any single character instead.
 */
export function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, "\\$&").replace(/[,()"*]/g, "_");
  return `%${escaped}%`;
}

/** The groups this person's roles and page access let them search, in display order. */
export function allowedGroups(roles: ReadonlyArray<string | null | undefined>, hiddenSections: ReadonlyArray<string> = []): GroupKey[] {
  const held = roles.filter(Boolean) as string[];
  const open = (group: Exclude<GroupKey, "lines">) => {
    const access = GROUP_ACCESS[group];
    return access.roles.some((role) => held.includes(role)) && !hiddenSections.includes(access.section);
  };
  const allowed = GROUP_ORDER.filter((key): key is Exclude<GroupKey, "lines"> => key !== "lines" && open(key));
  // Line text belongs to a quote or an invoice, so it needs access to one of those pages.
  const lines = open("quotes") || open("invoices");
  return GROUP_ORDER.filter((key) => (key === "lines" ? lines : allowed.includes(key)));
}

type Reply = PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;
/** The part of the Supabase client this module uses (a test stands in for it). */
export type SearchQuery = {
  select(columns: string): SearchQuery;
  eq(column: string, value: unknown): SearchQuery;
  or(filter: string): SearchQuery;
  ilike(column: string, pattern: string): SearchQuery;
  order(column: string, options: { ascending: boolean }): SearchQuery;
  limit(n: number): Reply;
};
export type SearchClient = { from(table: string): SearchQuery };

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const joinParts = (...parts: string[]) => parts.filter(Boolean).join(" \u00b7 ");

/** A column that the database does not have yet (a migration not applied): 42703 from Postgres, PGRST204 from PostgREST. */
export function missingColumn(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /column .* does not exist|could not find the .* column/i.test(error.message ?? "");
}

async function read(query: Reply): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(error.message ?? "search read failed"), { code: error.code ?? undefined });
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** customer_po is not on every table until migration 123: ask with it, and when the database says the column is not there, ask without it. */
async function withOptionalPo(run: (withPo: boolean) => Reply): Promise<Row[]> {
  try {
    return await read(run(true));
  } catch (error) {
    if (missingColumn(error as { code?: string; message?: string })) return read(run(false));
    throw error;
  }
}

const orFilter = (columns: string[], pattern: string) => columns.map((column) => `${column}.ilike.${pattern}`).join(",");

type Finder = (db: SearchClient, org: string, pattern: string) => Promise<SearchResult[]>;

const FINDERS: Record<Exclude<GroupKey, "lines">, Finder> = {
  quotes: async (db, org, pattern) => {
    const rows = await withOptionalPo((withPo) =>
      db.from("quotes").select(withPo ? "id, quote_ref, customer, customer_po" : "id, quote_ref, customer")
        .eq("organization_id", org).or(orFilter(withPo ? ["quote_ref", "customer", "customer_po"] : ["quote_ref", "customer"], pattern))
        .order("created_at", { ascending: false }).limit(GROUP_LIMIT));
    return rows.map((row) => ({ id: text(row.id), title: text(row.quote_ref) || "Quote", subtitle: joinParts(text(row.customer), text(row.customer_po) && `PO ${text(row.customer_po)}`), href: quoteHref(text(row.id)) }));
  },
  invoices: async (db, org, pattern) => {
    const rows = await withOptionalPo((withPo) =>
      db.from("invoices").select(withPo ? "id, invoice_ref, customer, customer_po" : "id, invoice_ref, customer")
        .eq("organization_id", org).or(orFilter(withPo ? ["invoice_ref", "customer", "customer_po"] : ["invoice_ref", "customer"], pattern))
        .order("created_at", { ascending: false }).limit(GROUP_LIMIT));
    // A draft has no number yet.
    return rows.map((row) => ({ id: text(row.id), title: text(row.invoice_ref) || "Draft invoice", subtitle: joinParts(text(row.customer), text(row.customer_po) && `PO ${text(row.customer_po)}`), href: invoiceHref(text(row.id)) }));
  },
  jobs: async (db, org, pattern) => {
    const rows = await read(db.from("jobs").select("id, job_no, customer, description")
      .eq("organization_id", org).or(orFilter(["job_no", "description", "customer"], pattern))
      .order("created_at", { ascending: false }).limit(GROUP_LIMIT));
    return rows.map((row) => ({ id: text(row.id), title: text(row.job_no) || "Job", subtitle: joinParts(text(row.customer), text(row.description)), href: jobHref({ id: text(row.id), job_no: text(row.job_no) }) }));
  },
  purchase_orders: async (db, org, pattern) => {
    const rows = await read(db.from("purchase_orders").select("id, po_ref, po_number, supplier")
      .eq("organization_id", org).or(orFilter(["po_number", "po_ref", "supplier"], pattern))
      .order("created_at", { ascending: false }).limit(GROUP_LIMIT));
    return rows.map((row) => ({ id: text(row.id), title: text(row.po_ref) || text(row.po_number) || "Purchase order", subtitle: text(row.supplier), href: purchaseOrderHref(text(row.id)) }));
  },
  customers: async (db, org, pattern) => {
    const rows = await read(db.from("customers").select("id, name, email")
      .eq("organization_id", org).or(orFilter(["name", "email"], pattern))
      .order("name", { ascending: true }).limit(GROUP_LIMIT));
    return rows.map((row) => ({ id: text(row.id), title: text(row.name) || "Customer", subtitle: text(row.email), href: customerHref(text(row.id)) }));
  },
};

/** The parent a line item's read embedded (PostgREST returns one object, or a one-item array). */
function parentOf(row: Row, table: string): Row | null {
  const value = row[table];
  const one = Array.isArray(value) ? value[0] : value;
  return one && typeof one === "object" ? (one as Row) : null;
}

const clip = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max - 1)}\u2026` : value);

/** Quote and invoice line descriptions, each result pointing at its parent document. Only the documents the person may open are read. */
async function findLines(db: SearchClient, org: string, pattern: string, kinds: Array<"quotes" | "invoices">): Promise<SearchResult[]> {
  const reads = kinds.map(async (kind): Promise<SearchResult[]> => {
    const lineTable = kind === "quotes" ? "quote_line_items" : "invoice_line_items";
    const parentKey = kind === "quotes" ? "quote_id" : "invoice_id";
    const refKey = kind === "quotes" ? "quote_ref" : "invoice_ref";
    const rows = await read(db.from(lineTable).select(`id, ${parentKey}, description, ${kind}(id, ${refKey}, customer)`)
      .eq("organization_id", org).ilike("description", pattern).order("created_at", { ascending: false }).limit(GROUP_LIMIT));
    return rows.flatMap((row): SearchResult[] => {
      const parent = parentOf(row, kind);
      const parentId = text(parent?.id) || text(row[parentKey]);
      if (!parentId) return [];
      const label = kind === "quotes" ? "Quote" : "Invoice";
      const ref = text(parent?.[refKey]) || (kind === "quotes" ? "" : "draft");
      return [{ id: text(row.id), title: clip(text(row.description)), subtitle: joinParts(`${label} ${ref}`.trim(), text(parent?.customer)), href: kind === "quotes" ? quoteHref(parentId) : invoiceHref(parentId) }];
    });
  });
  const settled = await Promise.allSettled(reads);
  const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  // Every read failed: the group is unavailable rather than quietly empty.
  if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason;
  return ok.flat().slice(0, GROUP_LIMIT);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("search timed out")), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs the search for the allowed groups in parallel. A group that fails or times out is left out and named in `unavailable`; the
 * others still answer. A query shorter than MIN_QUERY (after trimming) reads nothing.
 */
export async function runSearch(db: SearchClient, org: string, rawQuery: string, allowed: GroupKey[], timeoutMs = SEARCH_TIMEOUT_MS): Promise<SearchAnswer> {
  const query = normaliseQuery(rawQuery);
  if (query.length < MIN_QUERY || !allowed.length) return { query, groups: [], unavailable: [] };
  const pattern = likePattern(query);
  const lineKinds = (["quotes", "invoices"] as const).filter((kind) => allowed.includes(kind));
  const settled = await Promise.allSettled(allowed.map((key) => withTimeout(
    key === "lines" ? findLines(db, org, pattern, lineKinds) : FINDERS[key](db, org, pattern),
    timeoutMs,
  )));
  const groups: SearchGroup[] = [];
  const unavailable: GroupKey[] = [];
  settled.forEach((outcome, index) => {
    const key = allowed[index];
    if (outcome.status === "rejected") { unavailable.push(key); return; }
    const results = outcome.value.filter((result) => result.id).slice(0, GROUP_LIMIT);
    if (results.length) groups.push({ key, label: GROUP_LABELS[key], results });
  });
  return { query, groups, unavailable };
}
