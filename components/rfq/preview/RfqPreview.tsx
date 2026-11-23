"use client";

/**
 * BOUNDARY (RFQ, Quotes / RFQ / Sales Orders module 3, PREVIEW ONLY). Inputs: none from the server. Everything shown is fictional sample data (made-up
 * companies on reserved ".example" addresses, as of 23/11/2026) held in this file, plus the person's clicks. Outputs: an RFQ Control Centre look-and-feel
 * prototype (the three intake tiles, Show by stage, status chips, the card list with its Columns picker, New RFQ, View, Clarify, Reply and Forward,
 * the e-mail link panels and the stored-e-mail viewer, Check inbox) whose only state is LOCAL UI state. It reads and writes no Supabase table, calls no
 * server action or API route, opens no e-mail app, reads no mailbox, and no action ever reports success: everything that would save, send, link or log
 * answers with the neutral "Preview only ... Nothing was saved." toast (or an inline preview note while a sheet is open) and nothing changes.
 * Run-time imports from lib/ are pure leaf modules only (rfq-stage, rfq-display, money, dates, empty-hints) and types. The stage, figures, spec and card-field
 * rules are the REAL functions, not copies. The few rules that live inline in app/(dashboard)/rfq/page.tsx (the list filter, which button a card shows, the
 * Reply / Forward and Check inbox gates, the clarification texts, the form's choices) are mirrored here and pinned to that source text by tests/unit/rfqPreview.test.ts.
 * Microsoft 365 inbox check and Reply / Forward are off by default on the real page (they need a connected mailbox): the "Inbox check" control in Preview controls
 * draws them as the real page does when connected; it connects nothing.
 * MUST NOT CHANGE: wording, defaults, field order, filter semantics and the role gate mirror today's RFQ Control Centre (admin and office only; workshop and
 * viewer see "Access Denied"; Reply and Forward admin only). Do not wire this file to real data or real actions, do not add a control the real page lacks
 * (no search box, no sort, no icons), and keep row controls at a 48 px hit area. Delete the four preview files to remove it completely.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Button, ChipGroup, EmptyState, Field, FailedState, FilterChip, Input, LoadingState, Popover, SegmentedControl, Select, Sheet, StatTile, StatTiles, StatusBadge, Switch,
  Textarea, ToastProvider, cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { fmtDate as realFmtDate } from "@/lib/dates";
import { rfqEmptyHint } from "@/lib/empty-hints";
import { gbp } from "@/lib/money";
import { RFQ_CARD_FIELDS, rfqCardFields } from "@/lib/rfq-display";
import {
  type LinkedQuote, type RfqStage, linkedQuotes, matchesStatusFilter, rfqFigures, rfqSpec, rfqStage, rfqStageLabel, shouldMarkClarification, showsStatusBadge,
} from "@/lib/rfq-stage";

import s from "./RfqPreview.module.css";

/* ================================================================== */
/* 1. Types and constants                                              */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type Screen = "ready" | "loading" | "error" | "empty" | "allquoted";
export type InboxMode = "none" | "delegated" | "legacy";
export type IntakeStatus = "new" | "clarification" | "ready" | "quoted";
export type StageFilter = RfqStage | "all";

export const SAMPLE_DATE = "2026-11-23";
export const COMPANY_NAME = "Example Engineering Ltd";
export const STAGES: Array<Exclude<StageFilter, "all">> = ["outstanding", "quoted", "won", "lost"];
export const STAGE_LABEL: Record<RfqStage, string> = { outstanding: "Outstanding", quoted: "Quoted", won: "Won", lost: "Lost" };
const STAGE_TONE: Record<RfqStage, StatusTone> = { outstanding: "neutral", quoted: "info", won: "ok", lost: "danger" };
export const STATUS_LABEL: Record<IntakeStatus, string> = { new: "New", clarification: "Clarification", ready: "Ready", quoted: "Quoted" };
const STATUS_TONE: Record<IntakeStatus, StatusTone> = { new: "info", clarification: "warn", ready: "ok", quoted: "neutral" };
/** The status chips (FilterBar options on the real page), in order. */
export const STATUS_CHIPS: Array<{ value: string; label: string }> = [{ value: "all", label: "All" }, { value: "new", label: "New" }, { value: "clarification", label: "Clarification" }, { value: "ready", label: "Ready" }];
/** The three tiles (label, status the tile filters to), in order. */
export const TILES: Array<{ label: string; status: "new" | "clarification" | "ready" }> = [
  { label: "New RFQs", status: "new" }, { label: "Waiting for details", status: "clarification" }, { label: "Ready to Quote", status: "ready" },
];
export const MATERIALS = ["Titanium Grade 5", "Aluminium 6082", "Stainless Steel 304", "Stainless Steel 316", "Mild Steel", "Brass C360", "Other"];
export const LIST_FILTER_LABEL = "RFQs awaiting clarification";
export const EMPTY_HINT = rfqEmptyHint();

export type SeedRfq = {
  id: string; customer: string; email: string; phone: string; description: string; value: number; quantity?: number; material?: string; status: IntakeStatus; received: string; notes?: string;
};
export type RfqRow = SeedRfq;
export type SeedQuote = { id: string; rfq_id: string; quote_ref: string; status: string; created_at: string };
export type SuggestionKind = { id: string; ref: string; po: string | null };
export type SeedEmail = {
  id: string; rfqId: string; fromName: string; fromAddress: string; subject: string; receivedAt: string; bodyText: string;
  linkStatus: "suggested" | "manual" | "auto" | null; linkedQuoteId: string | null; linkedPoNumber: string | null; linkedRef?: string; suggestions: SuggestionKind[];
};

/* ================================================================== */
/* 2. Sample data (fictional)                                          */
/* ================================================================== */

export const SEED_RFQS: SeedRfq[] = [
  { id: "r14", customer: "Halden Precision", email: "procurement@halden-precision.example", phone: "01698 555 0141", description: "Ground and lapped calibration fixtures, run of 6", value: 5400, quantity: 6, material: "Stainless Steel 316", status: "new", received: "2026-11-21", notes: "Drawing D-3002 rev C attached. Flatness 0.002 mm." },
  { id: "r13", customer: "Kestrel Components", email: "buyer@kestrel.example", phone: "01698 555 0112", description: "Sensor housings, anodised aluminium", value: 3500, quantity: 250, material: "Aluminium 6082", status: "ready", received: "2026-11-20", notes: "Black anodise. Drawing SH-310 attached." },
  { id: "r12", customer: "Marlow Hydraulics", email: "purchasing@marlow-hydraulics.example", phone: "01698 555 0178", description: "Hydraulic manifold blocks, 6061-T6, run of 40", value: 3460, quantity: 40, material: "Aluminium 6082", status: "ready", received: "2026-11-18", notes: "First-off inspection report wanted." },
  { id: "r11", customer: "Tern Marine Engineering", email: "orders@tern-marine.example", phone: "01698 555 0166", description: "Stainless deck cleats, 316, with backing plates", value: 2300, quantity: 24, material: "Stainless Steel 316", status: "new", received: "2026-11-17", notes: "" },
  { id: "r10", customer: "Pemberton Packaging", email: "", phone: "01698 555 0190", description: "Sealing jaw bars, tool steel", value: 1500, quantity: 16, material: "", status: "clarification", received: "2026-11-16", notes: "Material grade not specified. No email address given, phone only." },
  { id: "r09", customer: "Brightwell Valves", email: "buying@brightwell.example", phone: "01698 555 0123", description: "Ball valve bodies, 316 stainless, investment cast, finish machined", value: 4200, quantity: 80, material: "Stainless Steel 316", status: "clarification", received: "2026-11-14", notes: "Casting supplied free issue? Not stated." },
  { id: "r08", customer: "Ashby Rail Services", email: "supply@ashby-rail.example", phone: "01698 555 0105", description: "Brake bracket weldments, batch of 120", value: 5100, quantity: 120, material: "Mild Steel", status: "ready", received: "2026-11-13", notes: "RAL 7016 paint." },
  { id: "r07", customer: "Wren & Calder", email: "projects@wren-calder.example", phone: "01698 555 0134", description: "Conveyor idler rollers, galvanised, with bearing sets", value: 4200, quantity: 90, material: "Mild Steel", status: "new", received: "2026-11-12", notes: "" },
  { id: "r06", customer: "Northgate Fabrication", email: "orders@northgate-fab.example", phone: "01698 555 0150", description: "Guard frames for packing line", value: 3700, quantity: 8, material: "Mild Steel", status: "ready", received: "2026-11-10", notes: "" },
  { id: "r05", customer: "Coldharbour Automation", email: "buyer@coldharbour.example", phone: "01698 555 0187", description: "Linear actuator end caps", value: 1360, quantity: 200, material: "Aluminium 6082", status: "ready", received: "2026-10-30", notes: "" },
  { id: "r04", customer: "Kestrel Components", email: "buyer@kestrel.example", phone: "01698 555 0112", description: "Gimbal brackets, 7075, revised quantity", value: 4770, quantity: 150, material: "Other", status: "quoted", received: "2026-10-04", notes: "Quoted by phone before the system was used for this customer." },
  { id: "r03", customer: "Meridian Subsea Components and Associated Group Holdings (UK) Limited", email: "tenders@meridian-subsea.example", phone: "", description: "Subsea connector bodies, super duplex, with full material traceability, hydrostatic test certificates and third party witnessed inspection to the customer specification, supplied in three call-off batches over twelve months", value: 18400, quantity: 300, material: "Other", status: "new", received: "2026-10-02", notes: "Specification MS-QA-114 issue 6 applies." },
  { id: "r02", customer: "Wren & Calder", email: "projects@wren-calder.example", phone: "01698 555 0134", description: "Idler roller spares", value: 900, status: "new", received: "2026-09-18", notes: "" },
  { id: "r01", customer: "Brightwell Valves", email: "buying@brightwell.example", phone: "01698 555 0123", description: "Valve test blocks", value: 640, quantity: 4, material: "Stainless Steel 304", status: "ready", received: "2026-09-02", notes: "" },
];

/** The quotes made for RFQs (quotes.rfq_id). r12 has a draft and a sent one: the sent one speaks for it (lib/rfq-stage linkedQuotes). */
export const SEED_QUOTES: SeedQuote[] = [
  { id: "q38", rfq_id: "r12", quote_ref: "QUO-0438", status: "draft", created_at: "2026-11-19T09:10:00Z" },
  { id: "q37", rfq_id: "r11", quote_ref: "QUO-0437", status: "draft", created_at: "2026-11-18T10:00:00Z" },
  { id: "q36", rfq_id: "r08", quote_ref: "QUO-0436", status: "sent", created_at: "2026-11-17T08:30:00Z" },
  { id: "q34", rfq_id: "r06", quote_ref: "QUO-0434", status: "accepted", created_at: "2026-11-14T11:00:00Z" },
  { id: "q30", rfq_id: "r05", quote_ref: "QUO-0430", status: "rejected", created_at: "2026-11-01T09:00:00Z" },
  { id: "q29", rfq_id: "r01", quote_ref: "QUO-0391", status: "sent", created_at: "2026-09-03T09:00:00Z" },
  { id: "q28", rfq_id: "r01", quote_ref: "QUO-0392", status: "draft", created_at: "2026-09-04T09:00:00Z" },
];

/** RFQs made from an e-mail (inbound_emails.rfq_id): Reply and Forward show for these, admin only. rfq id -> stored message id. */
export const SEED_INBOUND: Record<string, string> = { r14: "m14", r09: "m09", r08: "m08", r06: "m06", r07: "m07" };

export const SEED_EMAILS: SeedEmail[] = [
  { id: "m08", rfqId: "r08", fromName: "Ana Whitfield", fromAddress: "supply@ashby-rail.example", subject: "PO ARS-20771 for brake brackets", receivedAt: "2026-11-19T14:22:00Z",
    bodyText: "Hello,\n\nPlease find our purchase order ARS-20771 for the 120 brake bracket weldments quoted on QUO-0436. Delivery by 18 December please.\n\nKind regards,\nAna Whitfield\nAshby Rail Services",
    linkStatus: "suggested", linkedQuoteId: null, linkedPoNumber: null, suggestions: [{ id: "q36", ref: "QUO-0436", po: "ARS-20771" }] },
  { id: "m06", rfqId: "r06", fromName: "Priya Naidoo", fromAddress: "orders@northgate-fab.example", subject: "Order NF-88213, guard frames", receivedAt: "2026-11-15T09:05:00Z",
    bodyText: "Hi,\n\nOrder NF-88213 attached for the eight guard frames. Please confirm the delivery date.\n\nThanks,\nPriya Naidoo",
    linkStatus: "manual", linkedQuoteId: "q34", linkedPoNumber: "NF-88213", linkedRef: "QUO-0434", suggestions: [] },
  { id: "m09", rfqId: "r09", fromName: "Tomasz Brandt", fromAddress: "buying@brightwell.example", subject: "RFQ: 316 ball valve bodies", receivedAt: "2026-11-14T08:41:00Z",
    bodyText: "Good morning,\n\nWe would like a price for 80 ball valve bodies in 316 stainless, drawing BV-220 attached. Our PO BW-5530 follows once the price is agreed. Please let us know if the casting should be quoted too.\n\nRegards,\nTomasz Brandt\nBrightwell Valves",
    linkStatus: "suggested", linkedQuoteId: null, linkedPoNumber: null, suggestions: [{ id: "q26", ref: "QUO-0426", po: "BW-5530" }, { id: "q40", ref: "QUO-0440", po: null }] },
];

/* ================================================================== */
/* 3. Logic (real lib functions where pure; the rest mirrors the page) */
/* ================================================================== */

export { linkedQuotes, rfqFigures, rfqStage, rfqStageLabel, rfqSpec, rfqCardFields, shouldMarkClarification, showsStatusBadge, matchesStatusFilter };

export const fmtDate = (iso: string) => realFmtDate(iso);
export const money = (value: number) => gbp(value, 0);
export const canUseRfq = (role: Role) => role === "admin" || role === "office";
/** Reply and Forward: admin only, and only for an RFQ made from an e-mail (rfq page: profile?.role === "admin" && inboundByRfq.has). */
export const canReplyForward = (role: Role, hasInbound: boolean) => role === "admin" && hasInbound;
/** Check inbox: shown only once the server says how the inbox is read. delegated: admin and office. legacy: admins only. */
export function showsCheckInbox(role: Role, mode: InboxMode): boolean {
  if (mode === "none") return false;
  if (role !== "admin" && role !== "office") return false;
  return mode === "delegated" ? true : role === "admin";
}

export type Filters = { stage: StageFilter; statuses: ReadonlySet<string>; listFilter: "clarification" | null };
export const DEFAULT_FILTERS: Filters = { stage: "outstanding", statuses: new Set(["all"]), listFilter: null };

/** Newest first (the page reads created_at descending, then id). */
export function newestFirst<T extends { received: string; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.received.localeCompare(a.received) || a.id.localeCompare(b.id));
}

export function visibleRfqs(rows: readonly RfqRow[], linked: Map<string, LinkedQuote>, f: Filters): RfqRow[] {
  const stageOf = (r: RfqRow) => rfqStage(r, linked.get(r.id));
  return newestFirst(rows).filter((rfq) => (f.listFilter ? stageOf(rfq) === "outstanding" && rfq.status === "clarification" : (f.stage === "all" || stageOf(rfq) === f.stage) && matchesStatusFilter(f.statuses as Set<string>, stageOf(rfq), rfq.status)));
}

/** A tile or chip count while the list is loading or failed is an em dash, never a stale number. */
export const tileCount = (loading: boolean, error: boolean, n: number) => (loading || error ? "—" : String(n));

/** Which main button a card shows (rfq page): Clarify while outstanding and awaiting clarification, else Open QUO-x when a quote exists, else Quote. */
export type CardMain = { kind: "clarify" } | { kind: "open"; ref: string; quoteId: string | undefined } | { kind: "quote" };
export function cardMain(rfq: Pick<RfqRow, "status">, stage: RfqStage, quote: LinkedQuote | undefined): CardMain {
  if (rfq.status === "clarification" && stage === "outstanding") return { kind: "clarify" };
  if (quote) return { kind: "open", ref: quote.ref, quoteId: quote.id };
  return { kind: "quote" };
}

/** The status shown on a card: the intake status while outstanding, else Quoted (rfq page: statusMeta[showsStatusBadge(stage) ? rfq.status : "quoted"]). */
export const shownStatus = (rfq: Pick<RfqRow, "status">, stage: RfqStage): IntakeStatus => (showsStatusBadge(stage) ? rfq.status : "quoted");

/** The clarification texts (rfq page TEMPLATES): the three quick fills, each with its own subject. */
export const TEMPLATES: Record<string, { subject: string; body: (company: string) => string }> = {
  "Material spec": {
    subject: "Material specification needed for your RFQ",
    body: (company) => `Hi,\n\nThanks for your RFQ. Before we can quote, could you please confirm the material specification (grade, condition and any certification you need)?\n\nBest regards,\n${company}`,
  },
  "Missing drawings": {
    subject: "Drawings needed for your RFQ",
    body: (company) => `Hi,\n\nThanks for your RFQ. We couldn't find drawings with your request. Could you please send the drawings (PDF or STEP, latest revision) so we can quote accurately?\n\nBest regards,\n${company}`,
  },
  "Quantity confirm": {
    subject: "Please confirm quantities for your RFQ",
    body: (company) => `Hi,\n\nThanks for your RFQ. Could you please confirm the quantities you need (and whether you would like prices for any additional quantity breaks)?\n\nBest regards,\n${company}`,
  },
};
/** What the Clarify sheet opens with when the company has no saved template (lib/email/templates/defaults rfq_clarify, pinned by test). */
export const clarifyDefault = (company: string, _customer: string) => ({
  subject: "Clarification needed for RFQ",
  text: `Hi,\n\nThanks for the RFQ. Before quoting, could you please confirm the missing details below?\n\nBest regards,\n${company}`,
});
export const NO_EMAIL_MESSAGE = "This RFQ has no email address. Add one before sending.";

/** The New RFQ form's checks. The real form uses the browser's own required / email / number checks; the preview shows them inline with the app's own validator wording. */
export type RfqForm = { customer: string; email: string; phone: string; description: string; quantity: string; material: string; value: string; status: string; notes: string };
export const EMPTY_FORM: RfqForm = { customer: "", email: "", phone: "", description: "", quantity: "", material: "", value: "", status: "new", notes: "" };
export const FORM_ORDER: Array<keyof RfqForm> = ["customer", "email", "phone", "description", "quantity", "material", "value", "status", "notes"];
export function formErrors(f: RfqForm): Partial<Record<keyof RfqForm, string>> {
  const e: Partial<Record<keyof RfqForm, string>> = {};
  if (!f.customer.trim()) e.customer = "Customer is required";
  else if (f.customer.trim().length > 200) e.customer = "Customer name is too long";
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = "Enter a valid email address";
  if (!f.description.trim()) e.description = "This field is required";
  if (f.quantity.trim() !== "" && !(Number(f.quantity) >= 0)) e.quantity = "Quantity can't be negative";
  if (f.value.trim() !== "") {
    const n = Number(f.value);
    if (!Number.isFinite(n)) e.value = "Value must be a number";
    else if (n < 0) e.value = "Value can't be negative";
    else if (Math.round(n * 100) / 100 !== n) e.value = "Value is in pounds and pence (at most 2 decimal places)";
  }
  return e;
}
export const FORM_LABEL: Record<keyof RfqForm, string> = { customer: "Customer", email: "Email", phone: "Phone", description: "Description", quantity: "Quantity", material: "Material", value: "Value", status: "Status", notes: "Notes" };
/** One line per problem, naming its field, in form order (the summary above the form). */
export const formSummary = (errors: Partial<Record<keyof RfqForm, string>>) => FORM_ORDER.filter((k) => errors[k]).map((k) => ({ key: k, message: `${FORM_LABEL[k]}: ${errors[k]}` }));

/* ================================================================== */
/* 4. Small local pieces                                               */
/* ================================================================== */

const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const INBOX: Array<{ value: InboxMode; label: string }> = [{ value: "none", label: "Not set up" }, { value: "delegated", label: "Office and admin" }, { value: "legacy", label: "Admin only" }];
type ScreenPick = Screen | "clarification" | "mailfail";
const SCREENS: Array<{ v: ScreenPick; label: string }> = [
  { v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No RFQs yet" }, { v: "allquoted", label: "Nothing outstanding" },
  { v: "clarification", label: "Dashboard link: Awaiting clarification" }, { v: "mailfail", label: "E-mail links could not be read" },
];

function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

type Dlg =
  | { k: "create" }
  | { k: "view"; id: string }
  | { k: "clarify"; id: string }
  | { k: "mail"; id: string; mode: "reply" | "forward" }
  | { k: "email"; id: string };

/* ================================================================== */
/* 5. The page                                                         */
/* ================================================================== */

export default function RfqPreview() {
  return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>;
}

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [mailFailed, setMailFailed] = useState(false);
  const [inbox, setInbox] = useState<InboxMode>("delegated");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [hidden, setHidden] = useState<string[]>([]);
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  const [checking, setChecking] = useState(false);
  const timers = useRef<number[]>([]);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); }, [toast]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

  const rows = useMemo(() => newestFirst(SEED_RFQS), []);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const linked = useMemo(() => linkedQuotes(SEED_QUOTES), []);
  const emailByRfq = useMemo(() => new Map(SEED_EMAILS.map((e) => [e.rfqId, e])), []);
  const emailById = useMemo(() => new Map(SEED_EMAILS.map((e) => [e.id, e])), []);
  const loading = screen === "loading";
  const failed = screen === "error";
  const data = useMemo(() => (screen === "ready" ? rows : screen === "allquoted" ? rows.filter((r) => rfqStage(r, linked.get(r.id)) !== "outstanding") : []), [screen, rows, linked]);
  const figures = useMemo(() => rfqFigures(data, linked), [data, linked]);
  const visible = useMemo(() => visibleRfqs(data, linked, filters), [data, linked, filters]);
  const fields = useMemo(() => rfqCardFields(hidden), [hidden]);
  const has = (key: string) => fields.some((f) => f.key === key);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseRfq(role);
  const stageOf = (r: RfqRow) => rfqStage(r, linked.get(r.id));

  const resetAll = () => { setScreen("ready"); setMailFailed(false); setFilters(DEFAULT_FILTERS); setHidden([]); setDlg(null); setInbox("delegated"); setRole("admin"); toast.clear(); };
  const pickScreen = (v: ScreenPick) => {
    toast.clear();
    if (v === "clarification") { setScreen("ready"); setMailFailed(false); setFilters({ ...DEFAULT_FILTERS, listFilter: "clarification" }); return; }
    setFilters((f) => ({ ...f, listFilter: null }));
    if (v === "mailfail") { setScreen("ready"); setMailFailed(true); return; }
    setMailFailed(false); setScreen(v);
  };
  const retry = () => {
    setScreen("loading"); setMailFailed(false);
    later(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample RFQs shown again. No server was contacted." }); }, 700);
  };
  const toggleStatus = (value: string) => setFilters((f) => {
    const next = new Set(f.statuses);
    if (value === "all") { next.clear(); next.add("all"); } else { next.delete("all"); if (next.has(value)) next.delete(value); else next.add(value); if (next.size === 0) next.add("all"); }
    return { ...f, statuses: next };
  });
  const checkInbox = () => {
    setChecking(true); toast.clear();
    later(() => { setChecking(false); preview("The inbox was not read. No request was made."); }, 900);
  };
  const quoteLink = (r: RfqRow) => preview(`This opens the Quote Generator to make a quote for ${r.customer} (/quotes?rfq=${r.id}).`);
  const openLink = (ref: string, quoteId?: string) => preview(`This opens ${ref} in the Quote Generator${quoteId ? ` (/quotes?quote=${quoteId})` : ""}.`);

  const stageOptions = [
    ...STAGES.map((value) => ({ value, label: `${STAGE_LABEL[value]} (${figures[value]})`, testId: `show-${value}` })),
    { value: "all" as const, label: "All", testId: "show-all" },
  ];

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="rfq-preview" data-role={role}>
      <header className={s.head}>
        <div className={s.titleBlock}>
          <div className={s.titleLine}>
            <h1 className={s.title}>RFQ Control Centre</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
            <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
              <div className={s.dock}>
                <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated and no request is made.</p>
                <p className={s.dockLabel}>Role</p>
                <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
                <p className={s.dockLabel}>Inbox check (Microsoft 365)</p>
                <SegmentedControl label="Inbox check" value={inbox} options={INBOX} size="sm" onChange={(v) => { setInbox(v); toast.clear(); }} />
                <p className={s.dockLabel}>Screen state</p>
                <div className={s.dockStates} role="group" aria-label="Screen state">
                  {SCREENS.map((x) => {
                    const cur: ScreenPick = filters.listFilter ? "clarification" : mailFailed ? "mailfail" : screen;
                    return <button key={x.v} type="button" aria-pressed={cur === x.v} className={s.dockBtn} onClick={() => pickScreen(x.v)}>{x.label}</button>;
                  })}
                </div>
                <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
              </div>
            </Popover>
          </div>
          <p className={s.subtitle}>RFQ means request for quote: a customer asking us for a price.</p>
        </div>
        {denied ? null : (
          <div className={s.headControls}>
            <Popover label="Columns" title="RFQ columns" size="md" data-testid="columns-trigger">
              <p className={s.colScope}>Changes apply to everyone in this company. In this preview they change this screen only.</p>
              {RFQ_CARD_FIELDS.map((f) => (f.locked ? (
                <p key={f.key} className={s.colLocked} data-testid={`col-${f.key}`}><span>{f.label}</span><span>Always shown</span></p>
              ) : (
                <Switch key={f.key} label={f.label} checked={!hidden.includes(f.key)} data-testid={`col-${f.key}`}
                  onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== f.key) : [...h, f.key]))} />
              )))}
              <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHidden([])}>Reset to default (show all columns)</Button></div>
            </Popover>
            {showsCheckInbox(role, inbox) ? <Button variant="secondary" disabled={checking} data-testid="check-inbox" onClick={checkInbox}>{checking ? "Checking…" : "Check inbox"}</Button> : null}
            <Button variant="primary" data-testid="new-rfq" onClick={() => setDlg({ k: "create" })}>New RFQ</Button>
          </div>
        )}
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <h2 className={s.deniedTitle}>Access Denied</h2>
          <p className={s.deniedText}>Redirecting you back to the dashboard.</p>
          <p className={s.deniedNote}>Preview only: no redirect happens here. The real RFQ Control Centre is for Admin and Office; Workshop and Viewer cannot open it.</p>
        </section>
      ) : (
        <>
          <StatTiles label="RFQ figures" columns={3} className={s.tiles3}>
            {TILES.map((t) => (
              <StatTile key={t.label} label={t.label} value={tileCount(loading, failed, figures[t.status])} loading={loading || failed} data-testid={`tile-${t.status}`} className={s.tileFlat}
                pressed={filters.statuses.size === 1 && filters.statuses.has(t.status)} onPress={() => setFilters((f) => ({ ...f, statuses: new Set([t.status]) }))} />
            ))}
          </StatTiles>

          <section className={s.panel} aria-label="Filters" aria-busy={loading || undefined}>
            {filters.listFilter ? (
              <div className={s.notice} role="status" data-testid="list-filter-notice">
                <p>Showing only: <strong>{LIST_FILTER_LABEL}</strong></p>
                <Button size="sm" variant="secondary" onClick={() => setFilters((f) => ({ ...f, listFilter: null }))}>Show everything</Button>
              </div>
            ) : null}
            <div className={s.panelRow}>
              <span className={s.panelLabel} id="show-label">Show</span>
              <SegmentedControl label="Show" value={filters.stage} options={stageOptions} disabled={loading} className={s.segFlow} onChange={(v) => setFilters((f) => ({ ...f, stage: v }))} />
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>Filters</span>
              <ChipGroup label="Filters">
                {STATUS_CHIPS.map((c) => <FilterChip key={c.value} selected={filters.statuses.has(c.value)} disabled={loading} onToggle={() => toggleStatus(c.value)} data-testid={`chip-${c.value}`}>{c.label}</FilterChip>)}
              </ChipGroup>
            </div>
          </section>

          {mailFailed && !failed ? (
            <div className={s.warnNote} role="status" data-testid="mail-links-failed">
              <p>Couldn&apos;t check which RFQs came from an email, so Reply and Forward may be missing.</p>
              <Button size="sm" variant="secondary" onClick={() => setMailFailed(false)}>Retry</Button>
            </div>
          ) : null}

          <h2 className={s.srOnly}>RFQs</h2>
          {loading ? <LoadingState label="Loading RFQs" rows={5} />
            : failed ? <FailedState title="Couldn’t load RFQs." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" />
            : visible.length === 0 ? (
              <EmptyState title={data.length ? "No RFQs match this filter" : "No RFQs yet"} detail={data.length ? "Try a different filter." : EMPTY_HINT}
                action={data.length ? <Button variant="secondary" onClick={() => setFilters({ ...DEFAULT_FILTERS, stage: "all" })}>Show all</Button> : <Button variant="primary" onClick={() => setDlg({ k: "create" })}>New RFQ</Button>} />
            ) : (
              <ul className={s.list} data-testid="rfq-list" aria-label="RFQs">
                {visible.map((r) => {
                  const stage = stageOf(r);
                  const q = linked.get(r.id);
                  const status = shownStatus(r, stage);
                  const main = cardMain(r, stage, q);
                  const email = emailByRfq.get(r.id);
                  const inbound = Boolean(SEED_INBOUND[r.id]);
                  return (
                    <li key={r.id} className={s.row} data-rfq={r.customer} data-stage={stage} data-status={r.status}>
                      <div className={s.rowMain}>
                        <div className={s.rowTitle}>
                          <h3 className={s.customer} data-rfq-field="customer">{r.customer}</h3>
                          {has("status") && showsStatusBadge(stage) ? <span data-rfq-field="status"><StatusBadge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusBadge></span> : null}
                          {has("stage") ? <span data-rfq-field="stage"><StatusBadge tone={STAGE_TONE[stage]} plain={stage === "outstanding"}>{rfqStageLabel(stage, q)}{q ? <> {"·"} <b className={tabularNumbers}>{q.ref}</b></> : null}</StatusBadge></span> : null}
                        </div>
                        {has("description") ? <p className={s.desc} data-rfq-field="description" title={r.description}>{r.description}</p> : null}
                        {has("value") || has("received") ? (
                          <p className={s.meta}>
                            {has("value") ? <span data-rfq-field="value"><span className={s.metaLabel}>Value</span> <b className={tabularNumbers}>{money(r.value)}</b></span> : null}
                            {has("received") ? <span data-rfq-field="received"><span className={s.metaLabel}>Received</span> <span className={tabularNumbers}>{fmtDate(r.received)}</span></span> : null}
                          </p>
                        ) : null}
                      </div>
                      <div className={s.rowActions} data-rfq-field="actions">
                        <Button size="sm" variant="secondary" aria-label={`View ${r.customer}`} data-action="View" onClick={() => setDlg({ k: "view", id: r.id })}>View</Button>
                        {canReplyForward(role, inbound) ? (<>
                          <Button size="sm" variant="quiet" aria-label={`Reply to the email from ${r.customer}`} data-action="Reply" onClick={() => setDlg({ k: "mail", id: r.id, mode: "reply" })}>Reply</Button>
                          <Button size="sm" variant="quiet" aria-label={`Forward the email from ${r.customer}`} data-action="Forward" onClick={() => setDlg({ k: "mail", id: r.id, mode: "forward" })}>Forward</Button>
                        </>) : null}
                        {main.kind === "clarify" ? <Button size="sm" variant="primary" aria-label={`Clarify ${r.customer}`} data-action="Clarify" onClick={() => setDlg({ k: "clarify", id: r.id })}>Clarify</Button>
                          : main.kind === "open" ? <Button size="sm" variant="secondary" aria-label={`Open ${main.ref}`} data-action="Open" onClick={() => openLink(main.ref, main.quoteId)}>Open {main.ref}</Button>
                          : <Button size="sm" variant="primary" aria-label={`Make a quote for ${r.customer}`} data-action="Quote" onClick={() => quoteLink(r)}>Quote</Button>}
                      </div>
                      {email ? <div className={s.rowEmail}><EmailLinkPanel email={email} onView={() => setDlg({ k: "email", id: email.id })} onLink={(ref) => preview(`This e-mail would be linked to ${ref}.`)} onOpen={openLink} /></div> : null}
                    </li>
                  );
                })}
              </ul>
            )}
        </>
      )}

      <Dialogs dlg={dlg} close={() => setDlg(null)} setDlg={setDlg} byId={byId} emailById={emailById} linked={linked} stageOf={stageOf} preview={preview} quoteLink={quoteLink} role={role} />
    </div>
  );
}

/* ---------------- e-mail link panel (components/inbound-email-links EmailLinkPanel, drawn quietly) ---------------- */

function EmailFacts({ email }: { email: SeedEmail }) {
  return (
    <p className={s.emailFacts}>
      <b>{email.fromName || email.fromAddress}</b>
      {email.fromName && email.fromAddress ? <> &lt;{email.fromAddress}&gt;</> : null}
      {email.receivedAt ? <> {"·"} <span className={tabularNumbers}>{fmtDate(email.receivedAt.slice(0, 10))}</span></> : null}
      {email.subject ? <> {"·"} <i>{email.subject}</i></> : null}
    </p>
  );
}
/** The sentence around the PO in the stored text (matchedSnippet on the real page). */
export function snippetFor(email: Pick<SeedEmail, "bodyText" | "subject">, po: string | null): string | null {
  if (!po) return null;
  const parts = `${email.subject}\n${email.bodyText}`.split(/(?<=[.!?])\s+|\n+/);
  return parts.find((x) => x.includes(po))?.trim() ?? null;
}

function EmailLinkPanel({ email, onView, onLink, onOpen }: { email: SeedEmail; onView: () => void; onLink: (ref: string) => void; onOpen: (ref: string, id?: string) => void }) {
  const linkedId = email.linkStatus === "manual" || email.linkStatus === "auto" ? email.linkedQuoteId : null;
  if (linkedId) {
    return (
      <div className={cx(s.emailPanel, s.emailLinked)} data-testid="email-link">
        <p className={s.emailHead}>
          <b>Customer PO email linked</b>
          {email.linkedRef ? <span className={cx(s.refChip, tabularNumbers)}>{email.linkedRef}</span> : null}
          {email.linkedPoNumber ? <span>PO <span className={tabularNumbers}>{email.linkedPoNumber}</span></span> : null}
        </p>
        <p className={s.emailLinks}>
          <button type="button" className={s.textLink} onClick={onView}>View email</button>
          <button type="button" className={s.textLink} onClick={() => onOpen(email.linkedRef ?? "the quote", linkedId)}>Open {email.linkedRef ?? "quote"}</button>
        </p>
      </div>
    );
  }
  if (email.linkStatus !== "suggested" || !email.suggestions.length) return null;
  return (
    <div className={cx(s.emailPanel, s.emailSuggest)} data-testid="email-link-suggestions">
      <p className={s.emailHead}><b>{email.suggestions.length > 1 ? "This email may be about one of these. Pick the right one:" : "This email may be the customer's PO:"}</b><button type="button" className={cx(s.textLink, s.headLink)} onClick={onView}>View email</button></p>
      <EmailFacts email={email} />
      <ul className={s.suggestList}>
        {email.suggestions.map((sg) => {
          const snip = snippetFor(email, sg.po);
          return (
            <li key={`${sg.id}:${sg.po ?? ""}`} className={s.suggestItem}>
              <Button size="sm" variant="secondary" onClick={() => onLink(sg.ref)}>Link to {sg.ref}</Button>
              {sg.po ? <span className={s.suggestPo}>PO <span className={tabularNumbers}>{sg.po}</span></span> : null}
              {snip ? <span className={s.snippet}>&ldquo;{snip}&rdquo;</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ================================================================== */
/* 6. Sheets (the real dialogs, none of them saves anything)           */
/* ================================================================== */

type DialogsProps = {
  dlg: Dlg | null; close: () => void; setDlg: (d: Dlg | null) => void; byId: Map<string, RfqRow>; emailById: Map<string, SeedEmail>; linked: Map<string, LinkedQuote>;
  stageOf: (r: RfqRow) => RfqStage; preview: (detail: string) => void; quoteLink: (r: RfqRow) => void; role: Role;
};

function Dialogs({ dlg, close, setDlg, byId, emailById, linked, stageOf, preview, quoteLink }: DialogsProps) {
  const r = dlg && "id" in dlg && dlg.k !== "email" ? byId.get(dlg.id) ?? null : null;
  // A toast sits under an open modal, so a finished action closes the sheet first and the toast follows.
  const finish = (detail: string) => { close(); preview(detail); };
  return (
    <>
      {dlg?.k === "create" ? <CreateSheet onClose={close} onSave={(name) => finish(`The RFQ for ${name} would be saved.`)} /> : null}
      {dlg?.k === "view" && r ? <ViewSheet r={r} onClose={close} onClarify={() => setDlg({ k: "clarify", id: r.id })} onQuote={() => { close(); quoteLink(r); }} /> : null}
      {dlg?.k === "clarify" && r ? <ClarifySheet r={r} moves={shouldMarkClarification(r, linked.get(r.id))} stage={stageOf(r)} onClose={close} onLogged={(moves) => finish(`The clarification e-mail to ${r.customer} would be logged as sent manually${moves ? " and the RFQ moved to Awaiting clarification" : ""}.`)} /> : null}
      {dlg?.k === "mail" && r ? <MailSheet r={r} mode={dlg.mode} onClose={close} onSend={() => finish(dlg.mode === "reply" ? `The reply to ${r.customer} would be sent from the connected mailbox. No e-mail was sent.` : `The e-mail from ${r.customer} would be forwarded. No e-mail was sent.`)} /> : null}
      {dlg?.k === "email" && emailById.get(dlg.id) ? <EmailSheet email={emailById.get(dlg.id) as SeedEmail} onClose={close} /> : null}
    </>
  );
}

/* ---------------- New RFQ ---------------- */

function CreateSheet({ onClose, onSave }: { onClose: () => void; onSave: (customer: string) => void }) {
  const [f, setF] = useState<RfqForm>(EMPTY_FORM);
  const [tried, setTried] = useState(false);
  const errors = tried ? formErrors(f) : {};
  const list = formSummary(errors);
  const summaryRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const idBase = useId();
  useEffect(() => { requestAnimationFrame(() => firstRef.current?.focus()); }, []);
  const set = (k: keyof RfqForm) => (e: { target: { value: string } }) => setF((c) => ({ ...c, [k]: e.target.value }));
  const submit = () => {
    const e = formErrors(f);
    if (Object.keys(e).length) { setTried(true); requestAnimationFrame(() => summaryRef.current?.focus()); return; }
    onSave(f.customer.trim());
  };
  const jump = (key: keyof RfqForm) => { const el = document.querySelector<HTMLElement>(`[data-form="${idBase}"] [name="${key}"]`); el?.focus(); };
  return (
    <Sheet open size="md" onClose={onClose} testId="dlg-create" title="Create New RFQ" description="Enter what the customer needs and how far the request has got."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save RFQ</Button></>}>
      <form className={s.form} data-form={idBase} noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {list.length ? (
          <div ref={summaryRef} tabIndex={-1} role="alert" className={s.summary} data-testid="error-summary">
            <p className={s.summaryTitle}>{list.length === 1 ? "There is 1 problem with this RFQ" : `There are ${list.length} problems with this RFQ`}</p>
            <ul>{list.map((x) => <li key={x.key}><button type="button" className={s.textLink} onClick={() => jump(x.key)}>{x.message}</button></li>)}</ul>
          </div>
        ) : null}
        <Field label="Customer" required error={errors.customer}><Input ref={firstRef} name="customer" value={f.customer} onChange={set("customer")} /></Field>
        <div className={s.formGrid}>
          <Field label="Email" optional error={errors.email}><Input name="email" type="email" inputMode="email" autoComplete="off" value={f.email} onChange={set("email")} /></Field>
          <Field label="Phone" optional><Input name="phone" type="tel" inputMode="tel" autoComplete="off" value={f.phone} onChange={set("phone")} /></Field>
        </div>
        <Field label="Description" required error={errors.description}><Textarea name="description" value={f.description} onChange={set("description")} /></Field>
        <div className={s.formGrid3}>
          <Field label="Quantity" optional error={errors.quantity}><Input name="quantity" type="number" inputMode="numeric" min="0" step="1" value={f.quantity} onChange={set("quantity")} /></Field>
          <Field label="Material" optional>
            <Select name="material" value={f.material} onChange={set("material")}><option value="">Choose material</option>{MATERIALS.map((m) => <option key={m}>{m}</option>)}</Select>
          </Field>
          <Field label="Value" optional error={errors.value}><Input name="value" type="number" inputMode="decimal" min="0" step="0.01" value={f.value} onChange={set("value")} /></Field>
        </div>
        <Field label="Status"><Select name="status" value={f.status} onChange={set("status")}><option value="new">New</option><option value="clarification">Clarification</option><option value="ready">Ready</option></Select></Field>
        <Field label="Notes" optional><Textarea name="notes" value={f.notes} onChange={set("notes")} /></Field>
      </form>
    </Sheet>
  );
}

/* ---------------- View ---------------- */

function ViewSheet({ r, onClose, onClarify, onQuote }: { r: RfqRow; onClose: () => void; onClarify: () => void; onQuote: () => void }) {
  const spec = rfqSpec(r.quantity, r.material);
  return (
    <Sheet open size="md" onClose={onClose} testId="dlg-view" title={r.customer} description="Customer request details"
      footer={<><Button variant="secondary" onClick={onClarify}>Clarify</Button><Button variant="primary" onClick={onQuote}>Create Quote</Button></>}>
      <p className={s.viewDesc}>{r.description}</p>
      <dl className={s.facts}>
        {spec.quantity ? <div><dt>Quantity</dt><dd className={tabularNumbers}>{spec.quantity}</dd></div> : null}
        {spec.material ? <div><dt>Material</dt><dd className={s.breakWords}>{spec.material}</dd></div> : null}
        <div><dt>Value</dt><dd className={tabularNumbers}>{money(r.value)}</dd></div>
        <div><dt>Email</dt><dd className={s.breakWords}>{r.email || "—"}</dd></div>
        <div className={s.factWide}><dt>Notes</dt><dd>{r.notes || "-"}</dd></div>
      </dl>
    </Sheet>
  );
}

/* ---------------- Clarification e-mail ---------------- */

function ClarifySheet({ r, moves, stage, onClose, onLogged }: { r: RfqRow; moves: boolean; stage: RfqStage; onClose: () => void; onLogged: (moves: boolean) => void }) {
  const base = useMemo(() => clarifyDefault(COMPANY_NAME, r.customer), [r.customer]);
  const [subject, setSubject] = useState(base.subject);
  const [body, setBody] = useState(base.text);
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const open = () => {
    if (!r.email) { setErr(NO_EMAIL_MESSAGE); setNote(""); return; }
    setErr(""); setOpened(true);
    setNote(`Preview only. Your e-mail app is not opened here, nothing is sent. In Tolra it opens addressed to ${r.email}.`);
  };
  return (
    <Sheet open size="md" onClose={onClose} testId="dlg-clarify" title="Clarification Email" description={`${r.customer}${r.email ? ` (${r.email})` : ""}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={opened ? "secondary" : "primary"} data-testid="open-mail" onClick={open}>Open in email app</Button>
        {opened ? <Button variant="primary" data-testid="sent-it" onClick={() => onLogged(moves && stage === "outstanding")}>{"I’ve sent it"}</Button> : null}
      </>}>
      <div className={s.chipsRow} role="group" aria-label="Quick texts">
        {Object.entries(TEMPLATES).map(([name, t]) => <Button key={name} size="sm" variant="secondary" onClick={() => { setSubject(t.subject); setBody(t.body(COMPANY_NAME)); }}>{name}</Button>)}
      </div>
      <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Message"><Textarea className={s.tall} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <p className={s.sheetNote}>This opens your email app with the message ready to send. Once you&apos;ve sent it, log it here.</p>
      {err ? <p role="alert" className={s.blockMsg}>{err}</p> : null}
      <p role="status" aria-live="polite" className={cx(s.sheetNote, s.sheetStatus)} data-testid="sheet-status">{note}</p>
    </Sheet>
  );
}

/* ---------------- Reply / Forward (Microsoft 365, admin only) ---------------- */

function MailSheet({ r, mode, onClose, onSend }: { r: RfqRow; mode: "reply" | "forward"; onClose: () => void; onSend: () => void }) {
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState("");
  const blocked = mode === "reply" ? !msg.trim() : !to.trim();
  return (
    <Sheet open size="sm" onClose={onClose} testId="dlg-mail" title={mode === "forward" ? "Forward email" : "Reply to email"}
      description={`${r.customer}${mode === "reply" && r.email ? ` (${r.email})` : ""}. Sent from the connected Microsoft 365 mailbox.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={blocked} onClick={onSend}>{mode === "forward" ? "Forward" : "Send reply"}</Button></>}>
      {mode === "forward" ? <Field label="Forward to" required><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field> : null}
      <Field label={mode === "forward" ? "Note (optional)" : "Message"} required={mode === "reply"}><Textarea className={s.tall} value={msg} onChange={(e) => setMsg(e.target.value)} /></Field>
    </Sheet>
  );
}

/* ---------------- The stored e-mail ---------------- */

function EmailSheet({ email, onClose }: { email: SeedEmail; onClose: () => void }) {
  return (
    <Sheet open size="md" onClose={onClose} testId="dlg-email" title={email.subject || "Email"}
      description={`${email.fromName || email.fromAddress}${email.fromName && email.fromAddress ? ` <${email.fromAddress}>` : ""} · ${fmtDate(email.receivedAt.slice(0, 10))}`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>} closeButton={false}>
      <pre className={s.emailBody} data-testid="email-body" tabIndex={0}>{email.bodyText || "(no text)"}</pre>
    </Sheet>
  );
}

