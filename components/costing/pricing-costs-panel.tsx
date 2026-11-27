"use client";
/**
 * Settings > Costing (Pricing and profit, stage A1), without its data hooks: everything comes in as props, which is what the tests drive.
 * Inputs: the signed-in role and user id, and the load / overview / designate / save calls (lib/costing/pricing-costs-store.ts). Outputs: for an
 * admin, the "Can see profit" chooser (one admin, or nobody); for the ONE designated admin only, the crew, running costs, targets and the
 * break-even helper. Every other admin sees the chooser and no figure at all.
 * Must not change: no figure is pre-filled (an empty company shows empty boxes); the break-even and profit rates are worked out from the boxes and
 * never saved; with nothing entered the helper shows "Enter your rates in Settings" and no number; profit is "profit before dividends"; a missing
 * table reads "not available yet" once, with no retry loop; the figures are never written to a toast, console or URL.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Callout, EmptyState, Field, Input, LoadingState, Panel, Select, StatTile, StatTiles, FailedState } from "@/components/ui/premium";
import {
  breakEvenRate, businessYear, canChangeProfitViewer, canSeeProfit, checkViewerChoice, ENTER_RATES_MESSAGE, formatPounds, monthlyRunningTotal,
  parseFigure, PROFIT_BASIS_NOTE, rateForProfitPercent, viewerChangeClearsFigures, LIMITS, type RunningCostPeriod,
} from "@/lib/costing/pricing-costs";
import { blankRow, formFromInputs, inputsFromForm, type CostingForm } from "@/lib/costing/pricing-costs-form";
import { NOT_AVAILABLE_MESSAGE, type LoadResult, type Overview, type OverviewResult, type WriteResult } from "@/lib/costing/pricing-costs-store";
import type { CostingInputs } from "@/lib/costing/pricing-costs";

import styles from "./pricing-costs.module.css";

export type PricingCostsPanelProps = {
  role: string;
  userId: string | null;
  load: () => Promise<LoadResult>;
  loadOverview: () => Promise<OverviewResult>;
  setViewer: (userId: string | null) => Promise<WriteResult & { figuresCleared?: boolean }>;
  save: (inputs: CostingInputs, baseVersion: number) => Promise<WriteResult>;
};

type State = { phase: "loading" } | { phase: "not_applied" } | { phase: "error"; message: string }
  | { phase: "ready"; stored: { version: number; inputs: CostingInputs } | null; overview: Overview | null };

export function PricingCostsPanel({ role, userId, load, loadOverview, setViewer, save }: PricingCostsPanelProps) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reload = useCallback(async () => {
    const isAdmin = canChangeProfitViewer(role);
    const [loaded, overview] = await Promise.all([load(), isAdmin ? loadOverview() : Promise.resolve<OverviewResult | null>(null)]);
    if (!alive.current) return;
    if (loaded.status === "not_applied" || overview?.status === "not_applied") return setState({ phase: "not_applied" });
    if (loaded.status === "error") return setState({ phase: "error", message: loaded.message });
    if (overview?.status === "error") return setState({ phase: "error", message: overview.message });
    setState({ phase: "ready", stored: loaded.stored, overview: overview?.status === "ok" ? overview.overview : null });
  }, [load, loadOverview, role]);
  useEffect(() => { void reload(); }, [reload]);

  if (state.phase === "loading") return <LoadingState label="Loading costing" rows={3} />;
  if (state.phase === "not_applied") return <p role="status" className={styles.note} data-testid="costing-not-available">{NOT_AVAILABLE_MESSAGE}</p>;
  if (state.phase === "error") return <FailedState title="Costing didn't load" detail={state.message} onRetry={() => { setState({ phase: "loading" }); void reload(); }} headingLevel={3} />;

  const designatedId = state.overview?.viewer?.id ?? null;
  // The database decides who may read the figures (row-level security); this check only keeps the screen in step with it.
  const showFigures = state.stored !== null && canSeeProfit(designatedId ?? userId, userId, role);
  return (
    <div className={styles.stack}>
      {canChangeProfitViewer(role) && state.overview ? <ViewerChooser overview={state.overview} setViewer={setViewer} onDone={reload} /> : null}
      {showFigures && state.stored ? <FiguresEditor key={state.stored.version} stored={state.stored} save={save} onSaved={reload} /> : (
        <p className={styles.note} data-testid="costing-hidden">Only the person chosen under Can see profit can see or change the costing figures.</p>
      )}
    </div>
  );
}

function ViewerChooser({ overview, setViewer, onDone }: { overview: Overview; setViewer: PricingCostsPanelProps["setViewer"]; onDone: () => Promise<void> }) {
  const current = overview.viewer?.id ?? "";
  const [choice, setChoice] = useState(current);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const changes = choice !== current;
  const clears = changes && current !== "" && viewerChangeClearsFigures(current, choice === "" ? null : choice);

  async function onSave() {
    const checked = checkViewerChoice(choice, overview.candidates);
    if (!checked.ok) return setNotice({ tone: "error", text: checked.error });
    setBusy(true); setNotice(null);
    const result = await setViewer(checked.userId);
    setBusy(false);
    if (result.kind !== "saved") return setNotice({ tone: "error", text: result.message });
    setNotice({ tone: "info", text: checked.userId === null ? "Nobody can see profit now." : "Saved. Only that person can see the costing figures now." });
    await onDone();
  }

  return (
    <Panel variant="nested" title="Can see profit" headingLevel={3} data-testid="costing-viewer">
      <div className={styles.stack}>
        <p className={styles.note}>Only one person can see or change the costing figures, and nobody else can, not even other admins. Nobody can see them until you choose someone.</p>
        <Field label="Who can see profit" hint={`The list shows the admins of your company. Profit means ${PROFIT_BASIS_NOTE}.`}>
          <Select value={choice} onChange={(e) => { setChoice(e.target.value); setNotice(null); }} disabled={busy}>
            <option value="">Nobody</option>
            {overview.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        {clears ? <Callout tone="warn">Changing who can see profit clears the saved figures. The person you choose starts with empty boxes.</Callout> : null}
        {notice ? <Callout tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</Callout> : null}
        <div className={styles.actions}><Button variant="primary" onClick={() => void onSave()} loading={busy} disabled={!changes || busy}>Save who can see profit</Button></div>
      </div>
    </Panel>
  );
}

function FiguresEditor({ stored, save, onSaved }: { stored: { version: number; inputs: CostingInputs }; save: PricingCostsPanelProps["save"]; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<CostingForm>(() => formFromInputs(stored.inputs));
  const [showErrors, setShowErrors] = useState(false);
  const [wantPct, setWantPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const parsed = inputsFromForm(form);
  const set = (key: Exclude<keyof CostingForm, "rows">, value: string) => { setForm((f) => ({ ...f, [key]: value })); setNotice(null); };
  const setRow = (key: string, patch: Partial<CostingForm["rows"][number]>) => { setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) })); setNotice(null); };
  const err = (key: "men" | "hoursPerWeek" | "weeksPerYear" | "hourlyCost" | "yearlyTarget" | "profitTargetPct") => (showErrors ? parsed.errors[key] : undefined);

  const monthly = monthlyRunningTotal(parsed.inputs.runningCosts);
  const year = businessYear(new Date());
  const pct = parseFigure(wantPct, LIMITS.profitPct - 0.01, { label: "The profit percent" });
  const breakEven = breakEvenRate(parsed.inputs);
  const forPct = rateForProfitPercent(parsed.inputs, pct.value);

  async function onSave() {
    setShowErrors(true);
    if (!parsed.valid) return setNotice({ tone: "error", text: "Check the boxes marked below. Nothing was saved." });
    setBusy(true); setNotice(null);
    const result = await save(parsed.inputs, stored.version);
    setBusy(false);
    if (result.kind !== "saved") return setNotice({ tone: "error", text: result.message });
    setNotice({ tone: "info", text: result.message });
    await onSaved();
  }

  return (
    <div className={styles.stack} data-testid="costing-figures">
      <p className={styles.note}>Enter your own figures. Nothing is filled in for you. Profit here means {PROFIT_BASIS_NOTE}: what is left after wages, running costs, suppliers and materials. Your own pay comes from dividends, so it is not counted as a cost.</p>

      <Panel variant="nested" title="Crew" headingLevel={3}>
        <div className={styles.grid}>
          <Field label="Men on the shop floor" error={err("men")}><Input inputMode="numeric" autoComplete="off" value={form.men} onChange={(e) => set("men", e.target.value)} /></Field>
          <Field label="Hours per week per man" error={err("hoursPerWeek")}><Input inputMode="decimal" autoComplete="off" value={form.hoursPerWeek} onChange={(e) => set("hoursPerWeek", e.target.value)} /></Field>
          <Field label="Working weeks per year" error={err("weeksPerYear")}><Input inputMode="decimal" autoComplete="off" value={form.weeksPerYear} onChange={(e) => set("weeksPerYear", e.target.value)} /></Field>
          <Field label="Hourly cost per man (£)" hint="What one man costs you for one hour." error={err("hourlyCost")}><Input inputMode="decimal" autoComplete="off" value={form.hourlyCost} onChange={(e) => set("hourlyCost", e.target.value)} /></Field>
        </div>
      </Panel>

      <Panel variant="nested" title="Running costs" headingLevel={3}>
        <div className={styles.stack}>
          {form.rows.length === 0 ? <EmptyState compact title="No running costs yet" detail="Add each regular business cost, for example rent or insurance." headingLevel={4} /> : null}
          <ul className={styles.rows} aria-label="Running costs">
            {form.rows.map((row, i) => {
              const rowErr = showErrors ? parsed.errors.rows[row.key] : undefined;
              return (
                <li key={row.key} className={styles.row} data-testid="running-cost-row">
                  <Field label="Name" error={rowErr?.name}><Input autoComplete="off" maxLength={LIMITS.nameLength} value={row.name} onChange={(e) => setRow(row.key, { name: e.target.value })} /></Field>
                  <Field label="Amount (£)" error={rowErr?.amount}><Input inputMode="decimal" autoComplete="off" value={row.amount} onChange={(e) => setRow(row.key, { amount: e.target.value })} /></Field>
                  <Field label="Monthly or yearly"><Select value={row.period} onChange={(e) => setRow(row.key, { period: e.target.value as RunningCostPeriod })}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></Select></Field>
                  <div><Button variant="quiet" aria-label={`Remove running cost ${i + 1}${row.name.trim() ? `: ${row.name.trim()}` : ""}`} onClick={() => { setForm((f) => ({ ...f, rows: f.rows.filter((r) => r.key !== row.key) })); setNotice(null); }}>Remove</Button></div>
                </li>
              );
            })}
          </ul>
          <div className={styles.actions}>
            <Button onClick={() => { setForm((f) => ({ ...f, rows: [...f.rows, blankRow()] })); setNotice(null); }} disabled={form.rows.length >= LIMITS.runningCosts}>Add a running cost</Button>
            <span className={styles.figure} data-testid="running-total">{monthly === null ? "No running costs entered yet" : `Monthly total: ${formatPounds(monthly)}`}</span>
          </div>
        </div>
      </Panel>

      <Panel variant="nested" title="Targets" headingLevel={3}>
        <div className={styles.stack}>
          <div className={styles.grid}>
            <Field label="Yearly target (£)" error={err("yearlyTarget")}><Input inputMode="decimal" autoComplete="off" value={form.yearlyTarget} onChange={(e) => set("yearlyTarget", e.target.value)} /></Field>
            <Field label="Monthly profit percent target (%)" hint={`Profit before dividends, as a percent of what you charge.`} error={err("profitTargetPct")}><Input inputMode="decimal" autoComplete="off" value={form.profitTargetPct} onChange={(e) => set("profitTargetPct", e.target.value)} /></Field>
          </div>
          <p className={styles.note}>Your business year runs 1 December to 30 November. This year: {year.label}.</p>
        </div>
      </Panel>

      {notice ? <Callout tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</Callout> : null}
      <div className={styles.actions}><Button variant="primary" onClick={() => void onSave()} loading={busy} disabled={busy}>Save costing figures</Button></div>

      <Panel variant="nested" title="Break-even helper" headingLevel={3} data-testid="break-even">
        <div className={styles.stack}>
          <p className={styles.note}>Worked out from the boxes above as you type. It is not saved. The break-even rate covers wages plus running costs, so it leaves nothing for profit.</p>
          <div className={styles.grid}>
            <Field label="Profit percent you want (%)" hint={`Profit before dividends, as a percent of what you charge.`} error={wantPct.trim() !== "" ? pct.error : undefined}>
              <Input inputMode="decimal" autoComplete="off" value={wantPct} onChange={(e) => setWantPct(e.target.value)} />
            </Field>
          </div>
          <StatTiles label="Hourly rates" columns={2}>
            <StatTile label="Rate to break even" value={breakEven === null ? "No figure yet" : `${formatPounds(breakEven)} an hour`} hint={breakEven === null ? ENTER_RATES_MESSAGE : "Covers wages plus running costs"} />
            <StatTile label={`Rate for ${pct.value !== null && !pct.error ? `${pct.value}%` : "your"} profit`} value={forPct === null ? "No figure yet" : `${formatPounds(forPct)} an hour`} hint={breakEven === null ? ENTER_RATES_MESSAGE : forPct === null ? "Enter a profit percent above" : `Profit before dividends`} />
          </StatTiles>
        </div>
      </Panel>
    </div>
  );
}
