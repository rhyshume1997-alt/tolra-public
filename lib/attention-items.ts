/**
 * "Needs attention": one role-aware list of things that have gone quiet, so nothing goes stale silently. Pure rules only
 * (no database, no React): lib/attention-load.ts reads the rows, the dashboard shows the sections.
 *
 * Every rule gives a count of everything that qualifies, the oldest few items (oldest first) and a "View all" page.
 * Dates are calendar dates in Europe/London (lib/dates calendarDate), so a timestamp near midnight lands on the right day
 * in summer, and "N days" is whole calendar days between two such dates.
 *
 * CUTOFF: an item whose trigger date is more than ATTENTION_CUTOFF_DAYS (365) days ago is left out. A company moving in with
 * years of imported history (old unpaid invoices, long-expired quotes) would otherwise open on a wall of stale items on day
 * one; those stay findable on their own pages. Exactly 365 days old is still shown, 366 is not.
 *
 * ROLES: admin sees every rule. Office sees the non-money rules (the dashboard already keeps invoice figures from office).
 * Workshop and viewer see only the workshop rules: late jobs, jobs awaiting inspection, delivery notes awaiting. Money rules
 * (overdue invoices, draft invoices, uninvoiced delivery notes) are never offered to workshop or viewer, and the loader does
 * not even read those tables for them.
 */
import { calendarDate } from "@/lib/dates";
import { requiredDate } from "@/lib/job-status";
import { gbp } from "@/lib/money";
import { isOpenDraft } from "@/lib/open-drafts";
import { invoiceLifecycle, owed } from "@/lib/receivables";
import { storedQuoteStatus } from "@/lib/quote-status";

export const ATTENTION_CUTOFF_DAYS = 365;
/** A sent quote with no decision after more than this many days is flagged. */
export const QUOTE_NO_DECISION_DAYS = 14;
/** A draft invoice older than this many days that has not been issued is flagged. */
export const DRAFT_INVOICE_DAYS = 2;
/** What the dashboard's draft-invoice count covers: only drafts older than this, so it can be smaller than Invoicing's total of drafts. */
export const DRAFT_INVOICE_RULE_TITLE = `Draft invoices over ${DRAFT_INVOICE_DAYS} days old (newer drafts are on Invoicing)`;
/** A delivery note still 'awaiting' for more than this many days is flagged. */
export const DELIVERY_AWAITING_DAYS = 1;
/** How many items each section lists (the count always covers all of them). */
export const ATTENTION_TOP = 5;

export type AttentionRole = "admin" | "office" | "workshop" | "viewer";

export type AttentionRuleId =
  | "quotes-expired"
  | "quotes-no-decision"
  | "rfqs-clarification"
  | "pos-late"
  | "jobs-late"
  | "invoices-overdue"
  | "invoices-draft"
  | "delivery-awaiting"
  | "jobs-inspection"
  | "delivery-uninvoiced";

type Rule = { id: AttentionRuleId; title: string; href: string; roles: AttentionRole[]; money: boolean };

const ALL: AttentionRole[] = ["admin", "office", "workshop", "viewer"];
const OFFICE: AttentionRole[] = ["admin", "office"];

export const ATTENTION_RULES: Rule[] = [
  { id: "quotes-expired", title: "Draft or sent quotes past their valid-until date", href: "/quotes?filter=expired", roles: OFFICE, money: false },
  { id: "quotes-no-decision", title: `Quotes sent over ${QUOTE_NO_DECISION_DAYS} days ago with no decision`, href: "/quotes?filter=no-decision", roles: OFFICE, money: false },
  { id: "rfqs-clarification", title: "RFQs awaiting clarification", href: "/rfq?filter=clarification", roles: OFFICE, money: false },
  { id: "pos-late", title: "Purchase orders past their expected delivery", href: "/purchase-orders?filter=late", roles: OFFICE, money: false },
  { id: "jobs-late", title: "Jobs past their required date", href: "/jobs?filter=overdue", roles: ALL, money: false },
  { id: "invoices-overdue", title: "Overdue invoices", href: "/invoices?filter=overdue", roles: ["admin"], money: true },
  { id: "invoices-draft", title: DRAFT_INVOICE_RULE_TITLE, href: "/invoices?filter=draft-old", roles: ["admin"], money: true },
  { id: "delivery-awaiting", title: "Delivery notes awaiting for over a day", href: "/delivery-notes?filter=awaiting-old", roles: ALL, money: false },
  { id: "jobs-inspection", title: "Jobs waiting for inspection", href: "/jobs?filter=awaiting-inspection", roles: ALL, money: false },
  { id: "delivery-uninvoiced", title: "Delivery notes despatched with no invoice", href: "/delivery-notes?filter=not-invoiced", roles: ["admin"], money: true },
];

/** The rules this role may see (the loader reads only these). */
export function rulesForRole(role: AttentionRole): Rule[] {
  return ATTENTION_RULES.filter((rule) => rule.roles.includes(role));
}

// ----- rows (only the columns the rules need; null = that read failed) -----------------------------------------------------------
type Row = Record<string, unknown>;
export type AttentionInput = {
  /** Quotes still stored as draft or sent. */
  quotes: Row[] | null;
  /** RFQs with status 'clarification'. */
  rfqs: Row[] | null;
  /** Ids of RFQs that already have a quote (any status). Null when that read failed: the RFQ section then fails too. */
  quotedRfqIds: string[] | null;
  /** Purchase orders. */
  purchaseOrders: Row[] | null;
  /** Unfinished jobs. */
  lateJobs: Row[] | null;
  /** Finished, not yet inspected jobs. */
  finishedJobs: Row[] | null;
  /** Invoices not paid. */
  invoices: Row[] | null;
  /** Delivery notes (status awaiting, or sent out). */
  deliveryNotes: Row[] | null;
};

export type AttentionItem = { key: string; title: string; detail: string; href: string; ageDays: number };
export type AttentionSection = {
  id: AttentionRuleId;
  title: string;
  /** Where "View all" goes (the list page, filtered to these rows: lib/list-filter). */
  href: string;
  count: number;
  items: AttentionItem[];
  /** True when the read behind this section failed: show "couldn't load", never a count. */
  failed: boolean;
};

// ----- date helpers -----------------------------------------------------------------------------------------------------------------
const DAY_MS = 86_400_000;
const utcDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}

/** The London calendar date of a DATE or timestamp value, or "" when there is none. */
const dayOf = (value: unknown) => calendarDate(value);
const text = (value: unknown) => (value == null ? "" : String(value));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Oldest first = largest age first; the key keeps the order the same on every load. */
const oldestFirst = (a: AttentionItem, b: AttentionItem) => b.ageDays - a.ageDays || a.key.localeCompare(b.key);

function section(rule: Rule, rows: Row[] | null, build: (row: Row) => AttentionItem | null): AttentionSection {
  if (!rows) return { id: rule.id, title: rule.title, href: rule.href, count: 0, items: [], failed: true };
  const found: AttentionItem[] = [];
  for (const row of rows) {
    const item = build(row);
    if (item && item.ageDays <= ATTENTION_CUTOFF_DAYS) found.push(item);
  }
  found.sort(oldestFirst);
  return { id: rule.id, title: rule.title, href: rule.href, count: found.length, items: found.slice(0, ATTENTION_TOP), failed: false };
}

const quoteHref = (id: unknown) => `/quotes?quote=${encodeURIComponent(text(id))}`;
const jobHref = (id: unknown) => `/jobs?job=${encodeURIComponent(text(id))}`;

// ----- the rules --------------------------------------------------------------------------------------------------------------------
/**
 * Builds the sections for a role, in the order of ATTENTION_RULES. `today` is the London date (YYYY-MM-DD).
 * Sections the role may not see are not returned.
 */
export function buildAttention(input: AttentionInput, role: AttentionRole, today: string): AttentionSection[] {
  const rule = (id: AttentionRuleId) => ATTENTION_RULES.find((r) => r.id === id)!;
  const visible = new Set(rulesForRole(role).map((r) => r.id));
  const out: Record<AttentionRuleId, () => AttentionSection> = {
    // Expired: still draft or sent and valid-until before today (lib/quote-status effectiveQuoteStatus). Valid on its last day.
    "quotes-expired": () => section(rule("quotes-expired"), input.quotes, (row) => {
      const stored = storedQuoteStatus(row.status);
      const until = dayOf(row.valid_until);
      if ((stored !== "draft" && stored !== "sent") || !until || until >= today) return null;
      const days = daysBetween(until, today);
      return { key: `qx-${row.id}`, title: `Quote ${text(row.quote_ref)} expired`, detail: `${text(row.customer)} (${stored}, expired ${plural(days, "day")} ago)`, href: quoteHref(row.id), ageDays: days };
    }),
    // Sent, still in date (an expired one is already in the list above), no decision more than 14 days after it was sent.
    "quotes-no-decision": () => section(rule("quotes-no-decision"), input.quotes, (row) => {
      const until = dayOf(row.valid_until);
      if (storedQuoteStatus(row.status) !== "sent" || (until && until < today)) return null;
      const sent = dayOf(row.sent_at);
      if (!sent) return null;
      const days = daysBetween(sent, today);
      if (days <= QUOTE_NO_DECISION_DAYS) return null;
      return { key: `qs-${row.id}`, title: `Quote ${text(row.quote_ref)} has had no reply`, detail: `${text(row.customer)} (sent ${plural(days, "day")} ago)`, href: quoteHref(row.id), ageDays: days };
    }),
    // Clarification with no quote made yet (as the RFQ page counts outstanding RFQs); age from when it came in.
    "rfqs-clarification": () => section(rule("rfqs-clarification"), input.quotedRfqIds ? input.rfqs : null, (row) => {
      if (text(row.status) !== "clarification" || input.quotedRfqIds!.includes(text(row.id))) return null;
      const created = dayOf(row.created_at);
      if (!created) return null;
      const days = Math.max(0, daysBetween(created, today));
      return { key: `rfq-${row.id}`, title: "RFQ awaiting clarification", detail: `${`${text(row.customer)} - ${text(row.description)}`.slice(0, 90)} (${plural(days, "day")})`, href: "/rfq", ageDays: days };
    }),
    // Ordered (not a draft), not received or cancelled, expected before today.
    "pos-late": () => section(rule("pos-late"), input.purchaseOrders, (row) => {
      const status = text(row.status).toLowerCase();
      const due = dayOf(row.expected_delivery);
      if (!due || due >= today || row.received_at || ["draft", "received", "cancelled"].includes(status)) return null;
      const days = daysBetween(due, today);
      return { key: `po-${row.id}`, title: `PO ${text(row.po_ref || row.po_number)} not received`, detail: `${text(row.supplier)} (expected ${plural(days, "day")} ago)`, href: "/purchase-orders", ageDays: days };
    }),
    // Unfinished (internal jobs too), required date (else due date) before today (lib/job-status).
    "jobs-late": () => section(rule("jobs-late"), input.lateJobs, (row) => {
      const due = requiredDate({ date_required: row.date_required as string | null, due_date: row.due_date as string | null });
      if (row.finished_at || !due || due >= today) return null;
      const days = daysBetween(due, today);
      return { key: `jl-${row.id}`, title: `Job ${text(row.job_no)} is past its required date`, detail: `${text(row.customer) || "Internal"} (${plural(days, "day")} late)`, href: jobHref(row.id), ageDays: days };
    }),
    // Collectible (not draft/void/paid), payment confirmed, something still owed, due date before today (lib/receivables).
    "invoices-overdue": () => section(rule("invoices-overdue"), input.invoices, (row) => {
      const due = dayOf(row.due_date);
      const inv = row as { status?: string; total?: number; amount_paid?: number; credited_amount?: number; refunded_amount?: number; payment_unverified?: boolean };
      if (invoiceLifecycle(inv.status) !== "collectible" || inv.payment_unverified || !due || due >= today) return null;
      const left = owed(inv);
      if (left <= 0) return null;
      const days = daysBetween(due, today);
      return { key: `io-${row.id}`, title: `Invoice ${text(row.invoice_ref)} overdue`, detail: `${text(row.customer)} ${gbp(left, 0)} (${plural(days, "day")} overdue)`, href: "/invoices", ageDays: days };
    }),
    // Still a draft more than 2 days after it was created.
    "invoices-draft": () => section(rule("invoices-draft"), input.invoices, (row) => {
      if (!isOpenDraft(row.status as string | null, false)) return null; // archived drafts are already removed by the loader (lib/attention-load)
      const created = dayOf(row.created_at);
      if (!created) return null;
      const days = daysBetween(created, today);
      if (days <= DRAFT_INVOICE_DAYS) return null;
      return { key: `id-${row.id}`, title: `Draft invoice ${text(row.invoice_ref)} not issued`, detail: `${text(row.customer)} (draft for ${plural(days, "day")})`, href: "/invoices", ageDays: days };
    }),
    // Awaiting for more than a day, counted from its last change (when it was set awaiting), else from creation.
    "delivery-awaiting": () => section(rule("delivery-awaiting"), input.deliveryNotes, (row) => {
      if (text(row.status) !== "awaiting") return null;
      const since = dayOf(row.updated_at) || dayOf(row.created_at);
      if (!since) return null;
      const days = daysBetween(since, today);
      if (days <= DELIVERY_AWAITING_DAYS) return null;
      return { key: `da-${row.id}`, title: `Delivery note ${text(row.dn_number)} awaiting`, detail: `${text(row.customer)} (${plural(days, "day")})`, href: "/delivery-notes", ageDays: days };
    }),
    // Finished, not inspected; a job failed back to rework is being fixed, not waiting for an inspector.
    "jobs-inspection": () => section(rule("jobs-inspection"), input.finishedJobs, (row) => {
      const finished = dayOf(row.finished_at);
      if (!finished || row.inspected_at || text(row.stage) === "rework") return null;
      const days = Math.max(0, daysBetween(finished, today));
      return { key: `ji-${row.id}`, title: `Job ${text(row.job_no)} waiting for inspection`, detail: `${text(row.customer) || "Internal"} (finished ${plural(days, "day")} ago)`, href: jobHref(row.id), ageDays: days };
    }),
    // Sent out (despatched, delivered, signed) and not linked to an invoice.
    "delivery-uninvoiced": () => section(rule("delivery-uninvoiced"), input.deliveryNotes, (row) => {
      if (!["despatched", "delivered", "signed"].includes(text(row.status)) || row.invoice_id) return null;
      const since = dayOf(row.delivery_date) || dayOf(row.created_at);
      if (!since) return null;
      const days = Math.max(0, daysBetween(since, today));
      return { key: `du-${row.id}`, title: `Delivery note ${text(row.dn_number)} not invoiced`, detail: `${text(row.customer)} (${text(row.status)} ${plural(days, "day")} ago)`, href: "/delivery-notes", ageDays: days };
    }),
  };
  return ATTENTION_RULES.filter((r) => visible.has(r.id)).map((r) => out[r.id]());
}
