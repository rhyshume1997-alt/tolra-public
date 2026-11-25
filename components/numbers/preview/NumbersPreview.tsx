"use client";

/**
 * BOUNDARY (v2: shared UI v4 plus structural items 10 and 11, the shared PreviewBar and PageHeader and the type scale; nothing else changes) (Numbers, Module 7, PREVIEW ONLY). Route /numbers/preview. Inputs: none from the server. Everything shown is fictional sample data (invoices, credit
 * notes, payments, machines and machine runs for the twelve London months to November 2026, as of Fri 20/11/2026) held in this file, plus the person's clicks.
 * Outputs: the Numbers look-and-feel prototype of app/(dashboard)/numbers/page.tsx: the Months choice (3, 6, 12), the Invoiced ex VAT and Received tiles, the three
 * questions (customer reliance, invoices into cash with its month table, machine time) and the real failure wording. Only LOCAL UI state; no Supabase, no server
 * action, no export, nothing saved: a Retry answers with the neutral "Preview only ... Nothing was changed." toast.
 * FIGURES ARE THE REAL ONES: londonMonthsEnding, windowOf, invoicedByMonth, receivedByMonth, cashByMonth, sumOrNull, customerConcentration and machineHours from lib/numbers
 * (pure) run over the sample rows, filtered to the window the way the page's database filters do. Pinned by tests/unit/numbersPreview.test.ts.
 * MUST NOT CHANGE: the three questions, their wording, the 3 / 6 / 12 choices, admin only (a non-admin is sent to /dashboard on the real page), "a failed read is a dash with
 * Couldn't load this. and a Retry, never 0". Do not wire to real data, add no metric or control the real page lacks, keep control hit areas at 48 px.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Button, PageHeader, Popover, PreviewBar, ScrollTable, SegmentedControl, ToastProvider, cx, premiumTokens, tabularNumbers, typeScale, useToast } from "@/components/ui/premium";
import { gbp } from "@/lib/money";
import { cashByMonth, customerConcentration, invoicedByMonth, londonMonthsEnding, machineHours, receivedByMonth, sumOrNull, windowOf } from "@/lib/numbers";
import type { NumberCredit, NumberInvoice, NumberMachine, NumberPayment, NumberRun } from "@/lib/numbers";

import s from "./NumbersPreview.module.css";

export type Role = "admin" | "office" | "workshop" | "viewer";
export type Screen = "ready" | "loading" | "failed" | "partial" | "no-figures" | "empty";
export const NOW = new Date("2026-11-20T14:20:00.000Z");
export const MONTH_CHOICES = [3, 6, 12] as const;
export const SHOWN_CUSTOMERS = 8;
export const FAILED = "Couldn’t load this.";

/* ---------------- the sample world ---------------- */
const CUSTOMERS = ["Marlow Hydraulics", "Tern Marine Engineering", "Coldharbour Automation", "Ashby Rail Services", "Kestrel Components", "Halden Precision", "Brightwell Valves", "Wren & Calder", "Pemberton Packaging", "Northgate Fabrication", "Old Mill Castings", "Dunmore Gearworks"];
const BASE = [7200, 5600, 4300, 3900, 3300, 3700, 2900, 2600, 2100, 1800, 1500, 1200];
const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTH_STARTS = londonMonthsEnding(NOW, 12).map((p) => p.start);
type Inv = NumberInvoice & { id: string };
export function buildInvoices(): Inv[] {
  const out: Inv[] = [];
  MONTH_STARTS.forEach((start, m) => CUSTOMERS.forEach((customer, c) => {
    if ((m + c) % 3 === 0) return;
    const net = Math.round((BASE[c] * (0.6 + ((m * 7 + c * 3) % 9) / 10)) / 50) * 50;
    const date = `${start.slice(0, 8)}${String(3 + ((c * 2) % 24)).padStart(2, "0")}`;
    const total = r2(net * 1.2);
    out.push({ id: `n-${m}-${c}`, customer, status: "sent", subtotal: net, vat: r2(total - net), carriage: 0, total, invoice_date: date, created_at: `${date}T09:00:00Z` });
  }));
  return out.filter((i) => (i.invoice_date as string) <= "2026-11-20");
}
export const INVOICES: Inv[] = buildInvoices();
export const CREDITS: NumberCredit[] = [
  { customer: "Tern Marine Engineering", status: "issued", vat: 240, total: 1440, credit_date: "2026-10-15" },
  { customer: "Kestrel Components", status: "issued", vat: 70, total: 420, credit_date: "2026-11-12" },
  { customer: "Marlow Hydraulics", status: "draft", vat: 100, total: 600, credit_date: "2026-11-18" },
];
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const PAYMENTS: NumberPayment[] = [
  ...INVOICES.map((i, k) => ({ amount: i.total as number, paid_on: addDays(i.invoice_date as string, 22 + (k % 17)) })).filter((p) => p.paid_on <= "2026-11-20"),
  { amount: -300, paid_on: "2026-11-17" },
];
export const MACHINES: NumberMachine[] = [{ id: "m1", name: "CNC Mill 1" }, { id: "m2", name: "CNC Mill 2" }, { id: "m3", name: "CNC Lathe 1" }, { id: "m4", name: "CNC Lathe 2" }, { id: "m5", name: "Wire erosion" }, { id: "m6", name: "Band saw" }];
const HOURS = [7.5, 8, 6.5, 5, 9, 4];
export const RUNS: NumberRun[] = MONTH_STARTS.flatMap((start, m) => MACHINES.flatMap((mc, k) => Array.from({ length: 1 + ((k * 2 + m) % 4) }, (_, j) => j).map((j) => {
  const day = addDays(start, 2 + j * 6 + (k % 3));
  return { machine_id: mc.id, started_at: `${day}T08:00:00.000Z`, ended_at: new Date(Date.parse(`${day}T08:00:00.000Z`) + HOURS[(k + m + j) % 6] * 3_600_000).toISOString() };
}))).filter((r) => r.started_at < NOW.toISOString());

type Read<T> = { rows: T[] } | { failed: true };
export type Loaded = { now: Date; invoices: Read<NumberInvoice>; credits: Read<NumberCredit>; payments: Read<NumberPayment>; machines: Read<NumberMachine>; runs: Read<NumberRun> };
const rowsOf = <T,>(read: Read<T>): T[] | null => ("rows" in read ? read.rows : null);
const FAIL = { failed: true } as const;
/** The rows the page's database filters would return for the chosen months (the window is applied to whichever date a row has). */
export function loadSample(months: number, screen: Screen): Loaded {
  const w = windowOf(londonMonthsEnding(NOW, months));
  if (screen === "failed") return { now: NOW, invoices: FAIL, credits: FAIL, payments: FAIL, machines: FAIL, runs: FAIL };
  const empty = screen === "empty";
  let invoices = empty ? [] : INVOICES.filter((i) => (i.invoice_date as string) >= w.start && (i.invoice_date as string) < w.end);
  if (screen === "no-figures") invoices = [...invoices, { id: "n-x", customer: "Halden Precision", status: "sent", subtotal: null, vat: null, carriage: null, total: null, invoice_date: addDays(w.end, -3), created_at: `${addDays(w.end, -3)}T09:00:00Z` }];
  const startAt = w.startAt.replace(".000Z", "Z"), endAt = w.endAt.replace(".000Z", "Z");
  return {
    now: NOW,
    invoices: { rows: invoices },
    credits: { rows: empty ? [] : CREDITS.filter((c) => c.status === "issued" && (c.credit_date as string) >= w.start && (c.credit_date as string) < w.end) },
    payments: screen === "partial" ? FAIL : { rows: empty ? [] : PAYMENTS.filter((p) => (p.paid_on as string) >= w.start && (p.paid_on as string) < w.end) },
    machines: { rows: MACHINES },
    runs: { rows: empty ? [] : RUNS.filter((r) => r.started_at < endAt && (r.ended_at === null || r.ended_at > startAt)) },
  };
}

/** The page's own view model: every figure through lib/numbers. */
export function numbersView(data: Loaded, months: number) {
  const periods = londonMonthsEnding(data.now, months);
  const invoices = rowsOf(data.invoices), credits = rowsOf(data.credits), payments = rowsOf(data.payments), machines = rowsOf(data.machines), runs = rowsOf(data.runs);
  const w = windowOf(periods);
  const invoiced = invoices && credits ? invoicedByMonth(invoices, credits, periods) : null;
  const received = payments ? receivedByMonth(payments, periods) : null;
  const cash = cashByMonth(periods, invoiced, received);
  return {
    periods, cash,
    invoicedTotal: invoiced ? sumOrNull(cash.map((m) => m.invoiced)) : null,
    receivedTotal: received ? sumOrNull(cash.map((m) => m.received)) : null,
    invoicedRead: Boolean(invoiced), receivedRead: Boolean(received),
    customers: invoices && credits ? customerConcentration(invoices, credits, w) : undefined,
    machines: machines && runs ? machineHours(runs, machines, w, data.now) : null,
  };
}
/** The customer bars as the page builds them: the top eight with their share, then everyone else together. */
export function customerRows(customers: NonNullable<ReturnType<typeof numbersView>["customers"]>) {
  return [
    ...customers.rows.slice(0, SHOWN_CUSTOMERS).map((row) => ({ key: row.customer, label: `${row.customer} · ${row.share}%`, value: row.value })),
    ...(customers.rows.length > SHOWN_CUSTOMERS ? [{ key: "others", label: `${customers.rows.length - SHOWN_CUSTOMERS} other customers`, value: customers.rows.slice(SHOWN_CUSTOMERS).reduce((sum, row) => sum + row.value, 0) }] : []),
  ];
}
export const kGbp = (value: number) => (Math.abs(value) >= 1000 ? `£${Math.round(value / 100) / 10}k` : `£${Math.round(value)}`);

/* ---------------- local pieces ---------------- */
function useWidth(initial = 640): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const read = () => setW(Math.max(200, Math.round(el.clientWidth)));
    read(); const ro = new ResizeObserver(read); ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, w];
}
function Panel({ title, meta, children, testId }: { title: string; meta?: ReactNode; children: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <section className={s.panel} aria-labelledby={id} data-testid={testId}>
      <header className={s.panelHead}><h2 className={s.panelTitle} id={id}>{title}</h2>{meta ? <span className={s.panelMeta}>{meta}</span> : null}</header>
      <div className={s.panelBody}>{children}</div>
    </section>
  );
}
function BarRows({ rows, format, empty }: { rows: Array<{ key: string; label: string; value: number }>; format: (v: number) => string; empty: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max === 0) return <p className={s.empty}>{empty}</p>;
  return (
    <ul className={s.bars}>{rows.map((r) => (
      <li key={r.key} className={s.barRow}><span className={s.barLabel}>{r.label}</span><span className={s.barTrack} aria-hidden="true"><span className={s.barFill} style={{ width: `${(r.value / max) * 100}%` }} /></span><span className={cx(s.barValue, tabularNumbers)}>{format(r.value)}</span></li>
    ))}</ul>
  );
}
function Failed({ onRetry }: { onRetry: () => void }) {
  return <p role="alert" className={s.failed} data-testid="numbers-failed"><span className={s.failedDash}>{"—"}</span> {FAILED} <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button></p>;
}
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const out: number[] = []; for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 100) / 100); return out;
}
/** Invoiced ex VAT and money received per month side by side on ONE money axis. A month that could not be read has no bar. Direct labels only when they fit. */
function CashBars({ data }: { data: Array<{ label: string; invoiced: number | null; received: number | null }> }) {
  const [ref, w] = useWidth();
  const tid = useId();
  const H = 232, L = 50, Rr = 8, T = 22, Bt = 28;
  const max = Math.max(0, ...data.flatMap((d) => [d.invoiced ?? 0, d.received ?? 0]));
  const ticks = niceTicks(max), hi = ticks[ticks.length - 1];
  const y = (v: number) => T + (1 - v / hi) * (H - T - Bt);
  const step = (w - L - Rr) / data.length;
  const bw = Math.max(6, Math.min(34, step * 0.3));
  const label = step >= 96;
  const everyLabel = step < 34 ? 2 : 1;
  return (
    <div>
      <div className={s.legend} aria-hidden="true"><span><i className={s.swInv} />Invoiced ex VAT</span><span><i className={s.swRec} />Received</span></div>
      <div ref={ref} data-testid="numbers-cash-chart">
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-labelledby={tid} className={s.svg}>
          <title id={tid}>{`Invoiced ex VAT and received by month: ${data.map((d) => `${d.label} invoiced ${d.invoiced === null ? "not read" : gbp(d.invoiced, 0)}, received ${d.received === null ? "not read" : gbp(d.received, 0)}`).join("; ")}.`}</title>
          {ticks.map((t) => <g key={t}><line x1={L} x2={w - Rr} y1={y(t)} y2={y(t)} className={t === 0 ? s.axisLine : s.gridLine} /><text x={L - 8} y={y(t) + 4} textAnchor="end" className={s.axisText}>{kGbp(t)}</text></g>)}
          {data.map((d, i) => {
            const c = L + step * i + step / 2;
            return (
              <g key={d.label}>
                {d.invoiced !== null ? <rect x={c - bw - 1} y={y(d.invoiced)} width={bw} height={Math.max(0, y(0) - y(d.invoiced))} className={s.barInv} /> : null}
                {d.received !== null ? <rect x={c + 1} y={y(d.received)} width={bw} height={Math.max(0, y(0) - y(d.received))} className={s.barRec} /> : null}
                {label && d.invoiced !== null ? <text x={c - bw / 2 - 1} y={y(d.invoiced) - 5} textAnchor="middle" className={s.valueText}>{kGbp(d.invoiced)}</text> : null}
                {label && d.received !== null ? <text x={c + bw / 2 + 1} y={y(d.received) - 5} textAnchor="middle" className={s.valueTextRec}>{kGbp(d.received)}</text> : null}
                {i % everyLabel === 0 ? <text x={c} y={H - 8} textAnchor="middle" className={s.axisText}>{d.label}</text> : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export default function NumbersPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [months, setMonths] = useState<number>(6);
  const [timer, setTimer] = useState<number | null>(null);
  const loading = screen === "loading";
  const data = useMemo(() => (loading ? null : loadSample(months, screen)), [loading, months, screen]);
  const view = useMemo(() => (data ? numbersView(data, months) : null), [data, months]);
  const periods = useMemo(() => londonMonthsEnding(NOW, months), [months]);
  const retry = () => { toast.clear(); setScreen("loading"); if (timer) window.clearTimeout(timer); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample figures shown again. No server was contacted." }); }, 700)); };
  const admin = role === "admin";
  const span = `Last ${months} months, ${periods[0].label} to ${periods[periods.length - 1].label}`;
  const customers = view?.customers;
  const rows = customers ? customerRows(customers) : [];
  const anyCash = view?.cash.some((m) => m.invoiced !== null || m.received !== null);

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="numbers-preview" data-role={role} data-screen={screen}>
      <PreviewBar controls={
        <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
          <div className={s.dock}>
            <p className={typeScale.caption}>Not part of Tolra. Sample data as of Friday 20 November 2026; states are simulated and no request is made.</p>
            <p className={typeScale.label}>Role (the view the person works in)</p>
            <SegmentedControl label="Role" value={role} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} options={[{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }]} />
            <p className={typeScale.label}>Screen state</p>
            <div className={s.dockStates} role="group" aria-label="Screen state">
              {([["ready", "Normal"], ["loading", "Loading"], ["failed", "Every read failed"], ["partial", "Payments couldn't load"], ["no-figures", "An invoice has no figures"], ["empty", "New company, no data"]] as Array<[Screen, string]>).map(([v, l]) => (
                <Button key={v} size="sm" variant="secondary" fullWidth aria-pressed={screen === v} onClick={() => { toast.clear(); setScreen(v); }}>{l}</Button>))}
            </div>
            <Button size="sm" variant="secondary" onClick={() => { setRole("admin"); setScreen("ready"); setMonths(6); toast.clear(); }}>Reset preview</Button>
          </div>
        </Popover>
      } />
      <PageHeader title="Numbers"
        description={admin ? <span data-testid="numbers-span">{span}. Months follow the UK calendar.</span> : undefined}
        actions={admin ? <div className={s.headControls}><span className={typeScale.label} id="months-label">Months</span><SegmentedControl label="Months to show" value={String(months)} onChange={(v) => setMonths(Number(v))} options={MONTH_CHOICES.map((n) => ({ value: String(n), label: String(n), testId: `months-${n}` }))} /></div> : undefined} />

      {!admin ? (
        <section className={s.gate} data-testid="not-admin"><h2 className={s.gateTitle}>Loading{"…"}</h2><p className={s.muted}>Preview only: no redirect happens here. On the real page a non-admin view is sent back to the Dashboard (Numbers is admin only).</p></section>
      ) : !view ? <p className={s.muted} role="status" data-testid="numbers-loading">Loading Numbers{"…"}</p> : (
        <>
          <div className={s.tiles}>
            <div className={s.tile} data-testid="tile-invoiced"><span className={s.tileLabel}>Invoiced ex VAT</span><span className={cx(s.tileValue, tabularNumbers)} data-testid="numbers-invoiced">{view.invoicedTotal === null ? "—" : gbp(view.invoicedTotal, 0)}</span><span className={s.tileSub}>{view.invoicedTotal === null ? FAILED : "Issued invoices, less credit notes on their own date"}</span></div>
            <div className={s.tile} data-testid="tile-received"><span className={s.tileLabel}>Received</span><span className={cx(s.tileValue, tabularNumbers)} data-testid="numbers-received">{view.receivedTotal === null ? "—" : gbp(view.receivedTotal, 0)}</span><span className={s.tileSub}>{view.receivedTotal === null ? FAILED : "Payments by the date received, reversals included"}</span></div>
          </div>

          <Panel title="1. Which customers are we relying on?" meta={customers && customers.topCustomer && customers.topShare !== null ? `Largest: ${customers.topCustomer}, ${customers.topShare}%` : undefined} testId="panel-customers">
            <div data-testid="numbers-customers">
              {customers === undefined ? <Failed onRetry={retry} />
                : customers === null ? <p className={s.failed} role="alert"><span className={s.failedDash}>{"—"}</span> Some invoices have no figures, so the shares can&rsquo;t be worked out yet.</p>
                  : <BarRows rows={rows} format={(v) => gbp(v, 0)} empty="No invoiced work in these months." />}
            </div>
          </Panel>

          <Panel title="2. Are invoices turning into cash?" meta="Invoiced ex VAT against money received, by month" testId="panel-cash">
            <div data-testid="numbers-cash">
              {!anyCash ? <Failed onRetry={retry} /> : (
                <>
                  <CashBars data={view.cash} />
                  <p className={s.note}>The gap is invoiced less received in that month, not money owed: a payment can settle an invoice from an earlier month.</p>
                  <div className={s.tableGap}>
                    <ScrollTable label="Invoiced, received and gap by month" dense>
                      <thead><tr><th scope="col">Month</th><th scope="col" className={s.right}>Invoiced</th><th scope="col" className={s.right}>Received</th><th scope="col" className={s.right}>Gap</th></tr></thead>
                      <tbody>{view.cash.map((m) => (
                        <tr key={m.key} data-testid={`numbers-cash-${m.key}`}><th scope="row">{m.label}</th><td className={s.right} data-col="invoiced">{m.invoiced === null ? "—" : gbp(m.invoiced, 0)}</td><td className={s.right} data-col="received">{m.received === null ? "—" : gbp(m.received, 0)}</td><td className={s.right} data-col="gap">{m.gap === null ? "—" : gbp(m.gap, 0)}</td></tr>))}</tbody>
                    </ScrollTable>
                  </div>
                  {!view.invoicedRead || !view.receivedRead ? <Failed onRetry={retry} /> : null}
                </>
              )}
            </div>
          </Panel>

          <Panel title="3. Where is machine time going?" meta="Recorded machine runs, not booked hours" testId="panel-machines">
            <div data-testid="numbers-machines">
              {view.machines === null ? <Failed onRetry={retry} /> : <BarRows rows={view.machines.map((row) => ({ key: row.id, label: row.machine, value: row.hours }))} format={(v) => `${v} h`} empty="No machine time recorded in these months." />}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
