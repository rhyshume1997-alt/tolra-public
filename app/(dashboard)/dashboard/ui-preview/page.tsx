"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW, PREVIEW ONLY). Inputs: none (sample content for layout only). Output: every component of
 * components/ui/premium in every state, at /dashboard/ui-preview, behind the normal dashboard sign-in.
 * Must not change: it reads and writes nothing (no Supabase, no fetch, no storage). Nothing here saves, finishes or sends anything, and
 * no control reports success: a confirm just closes and says "Preview only". Delete this route when a real module has adopted the set.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  Button, Checkbox, ChipGroup, Dialog, EmptyState, FailedState, FilterChip, LoadingState, Menu, Popover, ScrollTable, SelectionBar,
  StatusBadge, Switch, ToastProvider, useToast, premiumTokens, tabularNumbers, cx,
} from "@/components/ui/premium";

const sec: CSSProperties = { display: "grid", gap: 14, paddingTop: 24, borderTop: "1px solid rgba(14,23,38,0.1)" };
const h2: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" };
const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 };
const cap: CSSProperties = { margin: 0, color: "#566074", fontSize: 12.5 };
const focusRing: CSSProperties = { outline: "2px solid var(--ui-accent)", outlineOffset: 2 };

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section style={sec} aria-labelledby={id}>
      <div>
        <h2 id={id} style={h2}>{title}</h2>
        {note ? <p style={cap}>{note}</p> : null}
      </div>
      {children}
    </section>
  );
}
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return <div style={{ display: "grid", gap: 6, justifyItems: "start" }}><span style={cap}>{label}</span>{children}</div>;
}

const COLS = ["Job", "Customer", "Description", "Status", "Due", "Machine", "Quantity", "Material", "Value", "Owner", "Specification", "Actions"] as const;
const ROWS = [
  { id: "J-0431", customer: "Hartley Engineering", desc: "Bracket, 6mm plate", tone: "progress" as const, status: "Running", due: "Friday", machine: "Laser 2", qty: 120, mat: "S355", value: "1,240.00", owner: "Sam" },
  { id: "J-0432", customer: "Northfield Fabrication", desc: "Guard frame assembly", tone: "warn" as const, status: "Waiting", due: "Monday", machine: "Press 1", qty: 8, mat: "304", value: "3,905.50", owner: "Aisha" },
  { id: "J-0433", customer: "Calder Hydraulics", desc: "Manifold block", tone: "neutral" as const, status: "Not started", due: "Next week", machine: "Mill 3", qty: 40, mat: "6082", value: "8,120.00", owner: "Tom" },
  { id: "J-0434", customer: "Hartley Engineering", desc: "Mounting plate, drilled", tone: "ok" as const, status: "Complete", due: "Done", machine: "Laser 2", qty: 300, mat: "S275", value: "612.75", owner: "Sam" },
  { id: "J-0435", customer: "Pennine Rail", desc: "Cover panel, folded", tone: "danger" as const, status: "Late", due: "2 days over", machine: "Press 1", qty: 16, mat: "5251", value: "1,018.00", owner: "Aisha" },
];

function Showcase() {
  const toast = useToast();
  const [sw, setSw] = useState({ a: false, b: true, c: false });
  const [chips, setChips] = useState({ open: true, rework: false, late: false });
  const [dlg, setDlg] = useState<null | "confirm" | "fields" | "busy">(null);
  const [busyError, setBusyError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [failedRetries, setFailedRetries] = useState(0);
  const [cols, setCols] = useState({ machine: true, material: true, value: false });

  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => { setBusy(false); setBusyError("Preview only: no request was sent, so there is nothing to confirm."); }, 2200);
    return () => clearTimeout(t);
  }, [busy]);

  const previewOnly = (what: string) => toast.show({ title: "Preview only", detail: `${what} Nothing was saved.` });
  const allIds = ROWS.map((r) => r.id);

  return (
    <div className={cx(premiumTokens)} style={{ display: "grid", gap: 28, maxWidth: 1100, paddingBottom: 48 }}>
      <header style={{ display: "grid", gap: 6 }}>
        <h1 style={{ margin: 0, fontSize: 28, lineHeight: "34px", fontWeight: 650, letterSpacing: "-0.022em" }}>Shared UI preview</h1>
        <p style={{ margin: 0, color: "#3b4559" }}>
          Every component of the shared set in each state. Sample content for layout only: nothing on this page reads or saves any data.
        </p>
      </header>

      <Section id="s-type" title="Type and figures" note="Archivo throughout. Figures that line up in columns use tabular figures.">
        <div style={{ ...row, gap: 32, alignItems: "baseline" }}>
          <Cell label="Archivo 28 / 650"><span style={{ fontSize: 28, fontWeight: 650, letterSpacing: "-0.022em" }}>Job board</span></Cell>
          <Cell label="Tabular figures (digits share a width)">
            <span style={{ display: "flex", gap: 16 }}>
              <span className={tabularNumbers} style={{ fontSize: 22, fontWeight: 600 }} data-testid="tab-a">11111.11</span>
              <span className={tabularNumbers} style={{ fontSize: 22, fontWeight: 600 }} data-testid="tab-b">00000.00</span>
            </span>
          </Cell>
          <Cell label="Proportional (for comparison)">
            <span style={{ display: "flex", gap: 16 }}>
              <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "proportional-nums" }} data-testid="prop-a">11111.11</span>
              <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "proportional-nums" }} data-testid="prop-b">00000.00</span>
            </span>
          </Cell>
        </div>
      </Section>

      <Section id="s-btn" title="Button" note="Primary, secondary, quiet. Heights 32, 40, 48. Every control has a 48 px hit area (pseudo element), so the look stays refined. Hover and press are live: move the pointer over them.">
        {(["primary", "secondary", "quiet"] as const).map((v) => (
          <div key={v} style={row} data-testid={`btn-row-${v}`}>
            <span style={{ ...cap, width: 70 }}>{v}</span>
            {(["sm", "md", "lg"] as const).map((s) => (<Button key={s} variant={v} size={s} data-size={s}>{s === "sm" ? "Small 32" : s === "md" ? "Medium 40" : "Large 48"}</Button>))}
            <Button variant={v} disabled>Disabled</Button>
            <Button variant={v} loading>Working</Button>
            <Button variant={v} style={focusRing}>Focus ring</Button>
          </div>
        ))}
      </Section>

      <Section id="s-switch" title="Switch and checkbox" note="role=switch with the state also written as a word. The whole 48 px row toggles. Checkbox is a 20 px mark in a 48 px box.">
        <div style={{ display: "grid", gap: 2, maxWidth: 420 }}>
          <Switch label="Show rework jobs" hint="Adds the Rework tag to the list" checked={sw.a} onChange={(v) => setSw({ ...sw, a: v })} data-testid="sw-a" />
          <Switch label="Internal job" checked={sw.b} onChange={(v) => setSw({ ...sw, b: v })} data-testid="sw-b" />
          <Switch label="Job number (locked)" hint="Always shown" checked disabled onChange={() => {}} data-testid="sw-locked-on" />
          <Switch label="Costs (not allowed for your role)" checked={false} disabled onChange={() => {}} data-testid="sw-locked-off" />
          <Switch label="Focus ring" checked={sw.c} onChange={(v) => setSw({ ...sw, c: v })} data-testid="sw-focus" />
        </div>
        <div style={row}>
          <Cell label="Unchecked"><Checkbox aria-label="Sample row, unchecked" data-testid="cb-off" /></Cell>
          <Cell label="Checked"><Checkbox aria-label="Sample row, checked" defaultChecked data-testid="cb-on" /></Cell>
          <Cell label="Disabled"><Checkbox aria-label="Sample row, disabled" disabled /></Cell>
          <Cell label="Focus ring"><Checkbox aria-label="Sample row, focus" data-testid="cb-focus" /></Cell>
        </div>
      </Section>

      <Section id="s-chip" title="Filter chip" note="Unselected recedes, selected is navy with a check mark. 32 px high, 44 px hit area.">
        <ChipGroup label="Sample filters">
          <FilterChip selected={chips.open} count={19} onToggle={() => setChips({ ...chips, open: !chips.open })} data-testid="chip-open">Open</FilterChip>
          <FilterChip selected={chips.rework} count={2} onToggle={() => setChips({ ...chips, rework: !chips.rework })} data-testid="chip-rework">Rework</FilterChip>
          <FilterChip selected={chips.late} onToggle={() => setChips({ ...chips, late: !chips.late })} data-testid="chip-late">Late</FilterChip>
          <FilterChip selected={false} disabled count={0}>Disabled</FilterChip>
          <FilterChip selected disabled count={4}>Disabled on</FilterChip>
          <FilterChip selected={false} style={focusRing}>Focus ring</FilterChip>
        </ChipGroup>
      </Section>

      <Section id="s-badge" title="Status badge" note="One grammar: dot plus word. Never colour alone.">
        <div style={row} data-testid="badges">
          <StatusBadge tone="neutral">Not started</StatusBadge>
          <StatusBadge tone="progress">Running</StatusBadge>
          <StatusBadge tone="info">Sent</StatusBadge>
          <StatusBadge tone="warn">At risk</StatusBadge>
          <StatusBadge tone="ok">On time</StatusBadge>
          <StatusBadge tone="danger">Late</StatusBadge>
          <StatusBadge tone="warn" plain>Plain: waiting</StatusBadge>
        </div>
      </Section>

      <Section id="s-menu" title="Menu and popover" note="Menu: arrow keys, Home, End, Escape, Tab. Popover holds controls (here, Switches). Both render in a portal and keep the tokens.">
        <div style={row}>
          <Menu label="Export" data-testid="menu-export" items={[
            { id: "csv", label: "CSV", onSelect: () => previewOnly("CSV export was not run.") },
            { id: "xlsx", label: "Excel", onSelect: () => previewOnly("Excel export was not run.") },
            { id: "pdf", label: "PDF", onSelect: () => previewOnly("PDF export was not run.") },
            { id: "x", label: "Email (not available)", disabled: true, separatorBefore: true, onSelect: () => {} },
          ]} />
          <Popover label="Columns" title="Columns" data-testid="pop-cols">
            <Switch label="Machine" checked={cols.machine} onChange={(v) => setCols({ ...cols, machine: v })} />
            <Switch label="Material" checked={cols.material} onChange={(v) => setCols({ ...cols, material: v })} />
            <Switch label="Value" checked={cols.value} onChange={(v) => setCols({ ...cols, value: v })} />
            <Switch label="Job number" hint="Always shown" checked disabled onChange={() => {}} />
          </Popover>
        </div>
      </Section>

      <Section id="s-dialog" title="Dialog" note="One pattern: navy primary on the right, outlined Cancel beside it. Opens on the safe button. The busy state runs 2 seconds, then shows an error, because no request exists to succeed.">
        <div style={row}>
          <Button onClick={() => setDlg("confirm")} data-testid="open-confirm">Confirmation</Button>
          <Button onClick={() => setDlg("fields")} data-testid="open-fields">With a field</Button>
          <Button onClick={() => { setBusyError(undefined); setDlg("busy"); }} data-testid="open-busy">Busy then error</Button>
        </div>
        <Dialog
          open={dlg === "confirm"}
          title="Pause job J-0431?"
          description="The job moves to Waiting and the machine is released. You can start it again later."
          confirmLabel="Pause job"
          onClose={() => setDlg(null)}
          onConfirm={() => { setDlg(null); previewOnly("The job was not paused."); }}
        />
        <Dialog
          open={dlg === "fields"}
          title="Record inspection"
          description="Choose the result for J-0432."
          confirmLabel="Record inspection"
          onClose={() => setDlg(null)}
          onConfirm={() => { setDlg(null); previewOnly("No inspection was recorded."); }}
        >
          <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
            Note
            <textarea rows={3} style={{ font: "inherit", fontWeight: 400, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(14,23,38,0.24)", resize: "vertical" }} />
          </label>
        </Dialog>
        <Dialog
          open={dlg === "busy"}
          title="Finish 2 jobs?"
          description="Both jobs move to Waiting for inspection."
          confirmLabel="Finish 2 jobs"
          busy={busy}
          error={busyError}
          onClose={() => setDlg(null)}
          onConfirm={() => { setBusyError(undefined); setBusy(true); }}
        />
      </Section>

      <Section id="s-toast" title="Toast" note="Neutral, one layer: a new message replaces the old one, nothing stacks. No green success tone. Info closes itself after 5 seconds and pauses on hover; an error stays until dismissed.">
        <div style={row}>
          <Button onClick={() => toast.show({ title: "Preview only", detail: "The job was not paused. Nothing was saved." })} data-testid="toast-info">Show message</Button>
          <Button onClick={() => toast.show({ title: "Could not load jobs", detail: "The connection dropped. Try again in a moment.", tone: "error" })} data-testid="toast-error">Show error</Button>
          <Button variant="quiet" onClick={toast.clear}>Clear</Button>
        </div>
      </Section>

      <Section id="s-bar" title="Selection bar" note="Idle is one quiet line. Active is a navy bar with the live count and actions. Tick rows in the table below to drive the live one.">
        <div style={{ display: "grid", gap: 10 }}>
          <Cell label="Idle"><div style={{ width: "100%" }}><SelectionBar count={0} filteredTotal={5} noun="job" onSelectAll={() => {}} onClear={() => {}}><Button size="sm" variant="secondary" disabled>Finish selected</Button></SelectionBar></div></Cell>
          <Cell label="Active (static sample)"><div style={{ width: "100%" }}><SelectionBar count={2} filteredTotal={5} noun="job" onSelectAll={() => {}} onClear={() => {}} stickyTop="0px"><Button size="sm" variant="primary" onClick={() => previewOnly("No jobs were finished.")}>Finish selected (2)</Button></SelectionBar></div></Cell>
        </div>
      </Section>

      <Section id="s-table" title="Table finish" note="Sticky first column, a right edge fade while more columns are hidden, and a shadow on the first column only once scrolled sideways. Rows are 64 px with hover and selected tints.">
        <SelectionBar count={sel.length} filteredTotal={ROWS.length} noun="job" onSelectAll={() => setSel(allIds)} onClear={() => setSel([])} stickyTop="0px">
          <Button size="sm" variant="primary" disabled={sel.length === 0} onClick={() => previewOnly(`${sel.length} jobs were not finished.`)} data-testid="bulk-finish">Finish selected ({sel.length})</Button>
        </SelectionBar>
        <ScrollTable label="Sample jobs (scrolls sideways)">
          <thead>
            <tr>{COLS.map((c, i) => <th key={c} scope="col" style={i === 0 ? { minWidth: 200 } : undefined}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const on = sel.includes(r.id);
              return (
                <tr key={r.id} data-selected={on} data-row={r.id}>
                  <td style={{ minWidth: 200 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <Checkbox aria-label={`Select ${r.id}`} checked={on} onChange={() => setSel(on ? sel.filter((x) => x !== r.id) : [...sel, r.id])} data-testid="row-check" />
                      <strong className={tabularNumbers}>{r.id}</strong>
                    </div>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.customer}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.desc}</td>
                  <td><StatusBadge tone={r.tone}>{r.status}</StatusBadge></td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.due}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.machine}</td>
                  <td className={tabularNumbers} style={{ textAlign: "right" }}>{r.qty}</td>
                  <td>{r.mat}</td>
                  <td className={tabularNumbers} style={{ textAlign: "right", whiteSpace: "nowrap" }}>{r.value}</td>
                  <td>{r.owner}</td>
                  <td style={{ whiteSpace: "nowrap" }}>Rev B</td>
                  <td><Button size="sm" variant="secondary" data-testid="row-action" onClick={() => previewOnly(`${r.id} was not changed.`)}>Open</Button></td>
                </tr>
              );
            })}
          </tbody>
        </ScrollTable>
      </Section>

      <Section id="s-state" title="Empty, loading and failed" note="Honest panels: no numbers, no sample data. A real page zeroes or hides its own counters while one of these shows.">
        <div style={{ display: "grid", gap: 14 }}>
          <EmptyState title="No jobs yet" detail="Jobs you create appear here. Start with your first one." action={<Button variant="primary" onClick={() => previewOnly("No job was created.")}>New job</Button>} />
          <LoadingState label="Loading jobs" rows={4} />
          <FailedState
            title="Could not load jobs"
            detail={failedRetries === 0 ? "The connection dropped before the list arrived. Nothing has changed." : `Still no connection after ${failedRetries} ${failedRetries === 1 ? "try" : "tries"}. Nothing has changed.`}
            onRetry={() => setFailedRetries((n) => n + 1)}
            retryLabel="Try again"
          />
        </div>
      </Section>
    </div>
  );
}

export default function UiPreviewPage() {
  return (
    <ToastProvider>
      <Showcase />
    </ToastProvider>
  );
}
