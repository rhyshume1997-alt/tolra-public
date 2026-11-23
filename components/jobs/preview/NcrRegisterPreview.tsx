"use client";

/**
 * BOUNDARY (NCR register, Jobs / Schedule / Time / Workshop module 2, PREVIEW ONLY). Inputs: none from the server. Everything shown is fictional sample data (made-up companies and
 * people, as of 23/11/2026) held in this file, plus the person's clicks. Outputs: a look-and-feel prototype of the NCR register (components/jobs/ncr-register.tsx): the From / To / Type /
 * Status filters, Download CSV, the summary tiles, the rework hours and material cost line, the register table with its 13 columns, the legacy list, and every state the real page has
 * (company switch off, not available in this mode, loading, cannot be read, no records match, some records not listed, Access Denied). The only state is LOCAL UI state. It reads and
 * writes no Supabase table, calls no server action or API route, and downloads nothing: Download CSV answers with the neutral "Preview only ... Nothing was saved." toast.
 * Run-time imports from lib/ are pure functions and constants only (lib/jobs/ncr-register: buildNcrRows, filterNcrRows, splitByClass, summariseNcrRows, countConcessions, defaultRange;
 * lib/jobs/ncr-register-switch; lib/dates; lib/money). The rows, tiles, filters and the open / closed rules are the REAL functions, not copies. The few rules that live inline in the real
 * component (the column list, the tile labels and order, the wording, the cell rules, the role gate) are mirrored here and pinned to that source text by tests/unit/ncrRegisterPreview.test.ts.
 * The real register is OFF by default (company switch) and admin and office only; the "Preview controls" draw each state, they switch nothing.
 * MUST NOT CHANGE: wording, columns, filter semantics and the role gate mirror today's register (admin and office only; workshop and viewer see "Access Denied"). Do not wire this file to
 * real data or real actions, do not add a control the real page lacks (no search box, no sort, no row actions), and keep controls at a 48 px hit area. Delete the four preview files to remove it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, EmptyState, Field, Input, LoadingState, Popover, SegmentedControl, Select, StatTile, StatTiles, StatusBadge, ScrollTable, ToastProvider,
  cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { fmtDate } from "@/lib/dates";
import {
  buildNcrRows, countConcessions, defaultRange, filterNcrRows, NCR_CONFIRMED_TYPES, splitByClass, summariseNcrRows,
  type NcrRow, type NcrSources, type NcrStatusFilter, type NcrType,
} from "@/lib/jobs/ncr-register";
import { NCR_REGISTER_OFF_NOTICE, canSeeNcrRegister } from "@/lib/jobs/ncr-register-switch";
import { gbp } from "@/lib/money";

import s from "./NcrRegisterPreview.module.css";

/* ================================================================== */
/* 1. Types and constants                                              */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type Screen = "ready" | "loading" | "error" | "unavailable" | "empty";

/** "Today" of the sample (the real page uses the clock). */
export const SAMPLE_NOW = "2026-11-23T12:00:00Z";
export const SAMPLE_DATE = "2026-11-23";

/** The real page's words (components/jobs/ncr-register.tsx), pinned by the tests. */
export const PAGE_TITLE = "NCR register";
export const PAGE_SUBTITLE = "Read-only list of nonconformance records (rework, failed inspections, concessions and problems) for ISO 9001 clause 8.7.";
export const NOT_AVAILABLE = "The NCR register is not available in this mode.";
export const CANNOT_READ = "The NCR register can't be read right now.";
export const NO_MATCH = "No records match these filters.";
export const NOT_LISTED = "Some records are not listed: narrow the date range.";
export const LEGACY_TITLE = "Failed inspections with no linked rework (legacy)";
export const LEGACY_NOTE = "Not counted in the figures above. These are failed inspections older than the rework records, or whose rework link was lost.";
/** The 13 columns of the register table, in order. */
export const NCR_COLUMNS = ["Record", "Raised", "Type", "Reason / description", "Qty affected", "Scrapped", "Remade", "Status", "Closed", "Days open", "Replacements", "Rework hours", "Material cost"] as const;
export const LEGACY_COLUMNS = ["Record", "Raised", "Customer", "Inspection notes"] as const;
/** Columns whose cells are numbers (right aligned, tabular figures). */
const NUMERIC = new Set<string>(["Qty affected", "Scrapped", "Remade", "Days open", "Replacements", "Rework hours", "Material cost"]);

/* ================================================================== */
/* 2. Sample data (fictional)                                          */
/* ================================================================== */

const NOW_JOBS = [
  { id: "j1", job_no: "J-0412", customer: "Halden Precision" },
  { id: "j2", job_no: "J-0418", customer: "Kestrel Components" },
  { id: "j3", job_no: "J-0421", customer: "Marlow Hydraulics" },
  { id: "j4", job_no: "J-0425", customer: "Tern Marine Engineering" },
  { id: "j5", job_no: "J-0430", customer: "Brightwell Valves" },
  { id: "j6", job_no: "J-0433", customer: "Ashby Rail Services" },
  { id: "j7", job_no: "J-0437", customer: "Northgate Fabrication" },
  { id: "j8", job_no: "J-0440", customer: "Meridian Subsea Components and Associated Group Holdings (UK) Limited" },
  { id: "j9", job_no: "J-0388", customer: "Coldharbour Automation" },
];

type RW = NcrSources["reworks"][number];
const rw = (o: Partial<RW> & Pick<RW, "id" | "job_id" | "status" | "reason" | "raised_at">): RW => ({
  inspection_id: null, instructions: "", affects_all: false, quantity_affected: null, quantity_scrapped: 0, quantity_remade: 0, sales_order_line_id: null,
  closed_at: null, closed_how: null, follow_up_of: null, ...o,
});
type IN = NcrSources["inspections"][number];
const insp = (o: Partial<IN> & Pick<IN, "id" | "job_id" | "result" | "inspected_at">): IN => ({ concession_reason: null, measured_notes: null, inspector_name: null, ...o });

/** Sample records covering every type, status and rule of lib/jobs/ncr-register (chains, replacements, concessions, problems, legacy fails). */
export const SAMPLE_SOURCES: NcrSources = {
  jobs: NOW_JOBS,
  reworks: [
    rw({ id: "r1", job_id: "j1", inspection_id: "i1", status: "in_progress", reason: "Bore 0.04 mm oversize on 6 of 12 housings", instructions: "Sleeve and re-bore, then re-inspect", quantity_affected: 6, raised_at: "2026-11-17T09:12:00Z" }),
    rw({ id: "r2", job_id: "j2", status: "open", reason: "Anodise colour out of specification", instructions: "Strip and re-anodise the batch", affects_all: true, raised_at: "2026-11-20T08:30:00Z" }),
    rw({ id: "r3", job_id: "j3", inspection_id: "i3", status: "finished", reason: "Flatness 0.08 mm against the 0.05 mm drawing limit", instructions: "Re-grind both faces", quantity_affected: 4, quantity_scrapped: 1, quantity_remade: 1, raised_at: "2026-11-10T10:00:00Z" }),
    rw({ id: "r4", job_id: "j4", inspection_id: "i4", status: "closed", reason: "Weld porosity at the cleat base", instructions: "Grind out, re-weld, dye penetrant test", quantity_affected: 8, raised_at: "2026-10-28T09:00:00Z", closed_at: "2026-11-04T15:20:00Z", closed_how: "passed" }),
    rw({ id: "r5a", job_id: "j5", inspection_id: "i5", status: "closed", reason: "Thread gauge no-go enters on 5 of 80", instructions: "Re-tap and gauge every body", quantity_affected: 5, quantity_scrapped: 2, raised_at: "2026-10-15T09:00:00Z", closed_at: "2026-10-22T11:00:00Z", closed_how: "superseded" }),
    rw({ id: "r5b", job_id: "j5", inspection_id: "i6", status: "closed", reason: "Thread gauge still failing on 3 of 5", instructions: "Re-tap with the finishing tap", quantity_affected: 3, quantity_remade: 2, raised_at: "2026-10-22T11:00:00Z", closed_at: "2026-11-03T14:00:00Z", closed_how: "passed" }),
    rw({ id: "r6", job_id: "j6", status: "closed", reason: "Paint 20 µm over thickness on 14 brackets", instructions: "Light abrasion and re-coat", quantity_affected: 14, raised_at: "2026-09-30T09:00:00Z", closed_at: "2026-10-06T10:00:00Z", closed_how: "concession" }),
    rw({ id: "r7a", job_id: "j7", status: "closed", reason: "Guard frame holes mislocated by 1.5 mm", instructions: "Re-drill and sleeve", affects_all: true, quantity_scrapped: 2, raised_at: "2026-11-05T09:00:00Z", closed_at: "2026-11-11T16:00:00Z", closed_how: "passed" }),
    rw({ id: "r7b", job_id: "j7", status: "open", reason: "Replacement frames, holes to be re-checked", instructions: "Make two replacement frames", affects_all: false, quantity_affected: 2, raised_at: "2026-11-12T09:30:00Z", follow_up_of: "r7a" }),
  ],
  inspections: [
    insp({ id: "i1", job_id: "j1", result: "fail", measured_notes: "Bore 0.04 mm over", inspector_name: "Priya Nair", inspected_at: "2026-11-17T09:12:00Z" }),
    insp({ id: "i3", job_id: "j3", result: "fail", measured_notes: "Flatness 0.08 mm", inspector_name: "Tomas Brandt", inspected_at: "2026-11-10T10:00:00Z" }),
    insp({ id: "i4", job_id: "j4", result: "fail", measured_notes: "Porosity visible at the cleat base", inspector_name: "Priya Nair", inspected_at: "2026-10-28T09:00:00Z" }),
    insp({ id: "i5", job_id: "j5", result: "fail", measured_notes: "No-go gauge enters", inspector_name: "Tomas Brandt", inspected_at: "2026-10-15T09:00:00Z" }),
    insp({ id: "i6", job_id: "j5", result: "fail", measured_notes: "No-go gauge still enters", inspector_name: "Tomas Brandt", inspected_at: "2026-10-22T11:00:00Z" }),
    insp({ id: "ic1", job_id: "j6", result: "concession", concession_reason: "Customer accepted the extra thickness by phone", inspector_name: "Ana Whitfield", inspected_at: "2026-10-06T10:00:00Z" }),
    insp({ id: "ic2", job_id: "j9", result: "concession", concession_reason: "Cosmetic scratch inside a non-sealing bore, customer agreed", inspector_name: "Priya Nair", inspected_at: "2026-11-13T13:40:00Z" }),
    insp({ id: "ic3", job_id: "j9", result: "concession", concession_reason: "Chamfer 0.2 mm under, customer agreed", inspector_name: "Ana Whitfield", inspected_at: "2026-07-08T11:10:00Z" }),
    insp({ id: "i7", job_id: "j3", result: "fail", measured_notes: "Surface finish Ra 3.2 against 1.6 drawn", inspector_name: "Tomas Brandt", inspected_at: "2026-09-12T09:00:00Z" }),
    insp({ id: "i8", job_id: "j9", result: "fail", measured_notes: "Hole position out by 0.12 mm", inspector_name: "Priya Nair", inspected_at: "2026-10-05T14:25:00Z" }),
  ],
  problems: [
    { id: "p1", job_id: "j8", reason: "machine", note: "Spindle chatter on the finish pass, speed reduced", status: "open", reported_at: "2026-11-19T07:50:00Z", resolved_at: null, resolution_note: null },
    { id: "p2", job_id: "j2", reason: "material", note: "Bar stock certificate missing for heat 55821", status: "resolved", reported_at: "2026-11-02T10:05:00Z", resolved_at: "2026-11-04T09:00:00Z", resolution_note: "Certificate received from the supplier and filed" },
    { id: "p3", job_id: "j8", reason: "drawing", note: "Drawing MS-114 revision F shows a 0.01 mm positional tolerance on all four ports that the revision log does not mention; waiting for the customer to confirm which revision applies before the next batch runs", status: "open", reported_at: "2026-10-27T15:00:00Z", resolved_at: null, resolution_note: null },
  ],
  entries: [
    { id: "e1", rework_id: "r4", kind: "hours", hours: 3.5 }, { id: "e2", rework_id: "r4", kind: "hours", hours: "1.25" }, { id: "e3", rework_id: "r4", kind: "material", hours: null },
    { id: "e4", rework_id: "r3", kind: "hours", hours: 2.5 }, { id: "e5", rework_id: "r3", kind: "hours", hours: 1.75 }, { id: "e6", rework_id: "r3", kind: "material", hours: null },
    { id: "e7", rework_id: "r5a", kind: "hours", hours: 4 }, { id: "e8", rework_id: "r5b", kind: "hours", hours: 2.5 }, { id: "e9", rework_id: "r5b", kind: "material", hours: null },
    { id: "e10", rework_id: "r6", kind: "hours", hours: 1.5 }, { id: "e11", rework_id: "r1", kind: "hours", hours: 2 },
  ],
  entryValues: [{ entry_id: "e3", material_cost: 18.4 }, { entry_id: "e6", material_cost: 42.5 }, { entry_id: "e9", material_cost: "96" }],
};

export const EMPTY_SOURCES: NcrSources = { reworks: [], inspections: [], problems: [], entries: [], entryValues: [], jobs: [] };

/* ================================================================== */
/* 3. Logic (real lib functions; the rest mirrors the real component)  */
/* ================================================================== */

export { buildNcrRows, filterNcrRows, splitByClass, summariseNcrRows, countConcessions, defaultRange };
export const canUseNcr = (role: Role) => canSeeNcrRegister(role);

export type Filters = { from: string; to: string; type: "all" | NcrType; status: NcrStatusFilter };
export const DEFAULT_FILTERS: Filters = { ...defaultRange(SAMPLE_NOW), type: "all", status: "all" };

/** The rows, legacy rows and summary exactly as the real component derives them (useMemo in NcrRegisterBody). */
export function register(sources: NcrSources, f: Filters, now: string = SAMPLE_NOW) {
  const all = buildNcrRows(sources, now);
  const rows = splitByClass(filterNcrRows(all, { from: f.from, to: f.to, type: f.type, status: f.status })).confirmed;
  const legacy = splitByClass(filterNcrRows(all, { from: f.from, to: f.to, type: "all", status: "all" })).notLinked;
  const summary = summariseNcrRows([...rows, ...legacy]);
  return { rows, legacy, summary };
}

/** The tiles, label and value, in the real order. */
export function tilesFor(summary: ReturnType<typeof summariseNcrRows>, sources: NcrSources | null, range: { from: string; to: string }): [string, string][] {
  return [
    ["Total", String(summary.total)],
    ["Open", String(summary.open)],
    ["Closed", String(summary.closed)],
    ["Concession inspections (by inspection date)", String(sources ? countConcessions(sources, range) : 0)],
    ["Failed inspections, no linked rework (legacy)", String(summary.notLinked)],
    ...NCR_CONFIRMED_TYPES.map((t): [string, string] => [t, String(summary.byType[t])]),
    ["Quantity scrapped", String(summary.quantityScrapped)],
    ["Average days to close", summary.averageDaysToClose === null ? "None closed" : String(summary.averageDaysToClose)],
  ];
}

/** Tone for the status word: open records warn (a failed-again chain more strongly), closed records are ok, a legacy row is neutral. */
export function statusTone(r: Pick<NcrRow, "open" | "notLinked" | "statusText">): StatusTone {
  if (r.notLinked) return "neutral";
  if (!r.open) return "ok";
  return r.statusText === "Failed again" ? "danger" : "warn";
}

/** One cell's text as the real table writes it. */
export function cell(r: NcrRow, col: (typeof NCR_COLUMNS)[number]): string {
  switch (col) {
    case "Record": return r.record;
    case "Raised": return fmtDate(r.raisedAt);
    case "Type": return r.type;
    case "Reason / description": return r.reason;
    case "Qty affected": return r.affectsAll ? "All" : String(r.quantityAffected ?? "");
    case "Scrapped": return String(r.scrapped ?? "");
    case "Remade": return String(r.remade ?? "");
    case "Status": return r.statusText;
    case "Closed": return r.closedAt ? `${fmtDate(r.closedAt)}${r.closedHow ? `, ${r.closedHow}` : ""}` : "";
    case "Days open": return String(r.daysOpen ?? "");
    case "Replacements": return String(r.replacements || "");
    case "Rework hours": return String(r.hours ?? "");
    case "Material cost": return r.materialCost === null ? "" : gbp(r.materialCost);
  }
}

/* ================================================================== */
/* 4. The page                                                         */
/* ================================================================== */

/** "J-0412 Inspection fail 2026-11-17": the job and type, with the date on its own line. The text is the real record text, unchanged. */
function Record({ text }: { text: string }) {
  const at = text.lastIndexOf(" ");
  return <span className={s.record}>{text.slice(0, at)} <span className={s.recordDate}>{text.slice(at + 1)}</span></span>;
}

const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SWITCH: Array<{ value: "off" | "on"; label: string }> = [{ value: "off", label: "Off (default)" }, { value: "on", label: "On" }];
const SCREENS: Array<{ v: Screen; label: string }> = [
  { v: "ready", label: "Sample records" }, { v: "loading", label: "Loading" }, { v: "error", label: "Cannot be read" }, { v: "empty", label: "No records at all" }, { v: "unavailable", label: "Not available in this mode" },
];
const TYPE_OPTIONS: Array<{ value: "all" | NcrType; label: string }> = [{ value: "all", label: "All types" }, ...NCR_CONFIRMED_TYPES.map((t) => ({ value: t, label: t as string }))];
const STATUS_OPTIONS: Array<{ value: NcrStatusFilter; label: string }> = [{ value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "closed", label: "Closed" }];

export default function NcrRegisterPreview() {
  return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>;
}

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [on, setOn] = useState(true);
  const [screen, setScreen] = useState<Screen>("ready");
  const [truncated, setTruncated] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  const first = useRef(true);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  // The real page reads again when the date range changes (state "loading" until the answer): shown here for 300 ms, no request is made.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setBusy(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setBusy(false), 300);
  }, [filters.from, filters.to]);

  const sources = screen === "empty" ? EMPTY_SOURCES : SAMPLE_SOURCES;
  const { rows, legacy, summary } = useMemo(() => register(sources, filters), [sources, filters]);
  const tiles = useMemo(() => tilesFor(summary, sources, filters), [summary, sources, filters]);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const resetAll = () => { setRole("admin"); setOn(true); setScreen("ready"); setTruncated(false); setFilters(DEFAULT_FILTERS); toast.clear(); };
  const denied = !canUseNcr(role);
  const loading = screen === "loading" || busy;

  const dock = (
    <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
      <div className={s.dock}>
        <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated and no request is made.</p>
        <p className={s.dockLabel}>Role</p>
        <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
        <p className={s.dockLabel}>Company switch (NCR register)</p>
        <SegmentedControl label="Company switch" value={on ? "on" : "off"} options={SWITCH} size="sm" onChange={(v) => { setOn(v === "on"); toast.clear(); }} />
        <p className={s.dockLabel}>Screen state</p>
        <div className={s.dockStates} role="group" aria-label="Screen state">
          {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => { setScreen(x.v); toast.clear(); }}>{x.label}</button>)}
          <button type="button" aria-pressed={truncated} className={s.dockBtn} onClick={() => setTruncated((t) => !t)}>Some records not listed</button>
        </div>
        <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
      </div>
    </Popover>
  );

  const bar = (
    <div className={s.previewBar}>
      <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
      {dock}
    </div>
  );
  const mainView = !denied && on && screen !== "unavailable";

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="ncr-preview" data-role={role}>

      {mainView ? null : bar}
      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <h1 className={s.deniedTitle}>Access Denied</h1>
          <p className={s.deniedText}>Redirecting you back to the dashboard.</p>
          <p className={s.deniedNote}>In this preview nobody is redirected. The real register is for admin and office only.</p>
        </section>
      ) : !on ? (
        <p className={s.statement} data-testid="switch-off">{NCR_REGISTER_OFF_NOTICE}</p>
      ) : screen === "unavailable" ? (
        <p className={s.statement} data-testid="unavailable">{NOT_AVAILABLE}</p>
      ) : (
        <>
          <header className={s.head}>
            <div className={s.headText}>
              <h1 className={s.title}>{PAGE_TITLE}</h1>
              <p className={s.subtitle}>{PAGE_SUBTITLE}</p>
            </div>
            {bar}
          </header>

          <section className={s.filters} aria-label="Filters" data-testid="filters">
            <Field label="From"><Input type="date" name="from" value={filters.from} onChange={(e) => set("from", e.target.value)} /></Field>
            <Field label="To"><Input type="date" name="to" value={filters.to} onChange={(e) => set("to", e.target.value)} /></Field>
            <Field label="Type">
              <Select name="type" value={filters.type} onChange={(e) => set("type", e.target.value as "all" | NcrType)}>
                {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
            <Field label="Status">
              <Select name="status" value={filters.status} onChange={(e) => set("status", e.target.value as NcrStatusFilter)}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
            <div className={s.filterAction}>
              <Button variant="secondary" data-testid="download-csv" disabled={!rows.length && !legacy.length} onClick={() => preview("The CSV file was not made or downloaded.")}>Download CSV</Button>
            </div>
          </section>

          {screen === "error" ? (
            <p className={s.statement} role="alert" data-testid="cannot-read">{CANNOT_READ}</p>
          ) : loading ? (
            <LoadingState label="Loading the NCR register" rows={5} />
          ) : (
            <>
              <StatTiles label="Summary" columns={4} className={s.tiles}>
                {tiles.map(([label, value], i) => (
                  <StatTile key={label} label={label} value={value} className={cx(s.tile, i < 3 && s.tileKey, i === tiles.length - 1 && s.tileLast)} data-testid={`tile-${i}`} />
                ))}
              </StatTiles>
              <p className={s.note} data-testid="hours-line">Rework hours and material cost: {summary.hours} h, {gbp(summary.materialCost)} in total.</p>
              {truncated ? <p className={s.note} data-testid="not-listed">{NOT_LISTED}</p> : null}
              {!rows.length ? (
                <EmptyState title={NO_MATCH} headingLevel={2} compact />
              ) : (
                <ScrollTable label="NCR register" dense>
                  <thead>
                    <tr>{NCR_COLUMNS.map((h) => <th key={h} scope="col" className={cx(NUMERIC.has(h) && s.right, NUMERIC.has(h) && s.numHead, h === "Reason / description" && s.reasonHead)}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} data-ncr={r.key}>
                        {NCR_COLUMNS.map((col) => {
                          const text = cell(r, col);
                          if (col === "Record") return <td key={col}><Record text={text} /></td>;
                          if (col === "Reason / description") return <td key={col} className={s.reason}>{text}{r.action ? <span className={s.action}>{r.action}</span> : null}</td>;
                          if (col === "Status") return <td key={col}><StatusBadge tone={statusTone(r)}>{text}</StatusBadge></td>;
                          if (NUMERIC.has(col)) return <td key={col} className={cx(s.right, tabularNumbers)}>{text}</td>;
                          return <td key={col} className={col === "Raised" || col === "Closed" ? s.nowrap : undefined}>{text}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
              )}
              {legacy.length ? (
                <section className={s.legacy} aria-labelledby="ncr-legacy-title" data-testid="legacy">
                  <h2 id="ncr-legacy-title" className={s.legacyTitle}>{LEGACY_TITLE}</h2>
                  <p className={s.note}>{LEGACY_NOTE}</p>
                  <ScrollTable label="Failed inspections with no linked rework" dense>
                    <thead><tr>{LEGACY_COLUMNS.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                    <tbody>
                      {legacy.map((r) => (
                        <tr key={r.key} data-ncr={r.key}>
                          <td><Record text={r.record} /></td><td className={s.nowrap}>{fmtDate(r.raisedAt)}</td><td className={s.customer}>{r.customer}</td><td className={s.reason}>{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </ScrollTable>
                </section>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
