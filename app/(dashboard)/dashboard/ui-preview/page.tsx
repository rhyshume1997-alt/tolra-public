"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW, PREVIEW ONLY). Inputs: none (sample content for layout only). Output: every component of
 * components/ui/premium in every state, at /dashboard/ui-preview, behind the normal dashboard sign-in.
 * Must not change: it reads and writes nothing (no Supabase, no fetch, no storage). Nothing here saves, finishes or sends anything, and
 * no control reports success: a confirm just closes and says "Preview only". v2 adds SegmentedControl, Sheet, form fields, StatTile and the toast, dialog,
 * popover, state-panel and selection-bar options. v3 adds the sections from "Button v3" down: danger and pressed buttons, menu hints, table variants, panel, callout, disclosure, list rows, form group, error
 * summary, date range, link tiles, wrapped chips and segments, nested sheets and large fields. Delete this route when a real module has adopted the set.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  Button, Callout, Checkbox, ChipGroup, DateRangeGroup, Dialog, Disclosure, EmptyState, ErrorSummary, FailedState, Field, FilterChip, FormGroup, Input, List, ListRow, LoadingState, Menu, Panel, Popover,
  ScrollTable, SegmentedControl, Select, SelectionBar, Sheet, StatTile, StatTiles, StatusBadge, Switch, Textarea, ToastProvider, rowClickIsForRow, useToast, premiumTokens, tabularNumbers, cx,
  type ErrorSummaryItem, type ToastPlacement,
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

type Place = { placement: ToastPlacement; offset?: number };
type SheetKind = null | "sm" | "md" | "lg";

function Showcase({ setPlace }: { setPlace: (p: Place) => void }) {
  const toast = useToast();
  const [view, setView] = useState<"table" | "cards" | "board">("table");
  const [role, setRole] = useState<"admin" | "office" | "operator">("office");
  const [size, setSize] = useState<"all" | "open" | "late">("open");
  const [tab, setTab] = useState<"details" | "history">("details");
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [tileOn, setTileOn] = useState<"open" | null>(null);
  const [form, setForm] = useState({ name: "", qty: "0", note: "" });
  const [sw, setSw] = useState({ a: false, b: true, c: false });
  const [chips, setChips] = useState({ open: true, rework: false, late: false });
  const [dlg, setDlg] = useState<null | "confirm" | "fields" | "busy" | "secondary">(null);
  const [busyError, setBusyError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [failedRetries, setFailedRetries] = useState(0);
  const [cols, setCols] = useState({ machine: true, material: true, value: false });
  const [selOpts, setSelOpts] = useState<string[]>([]);

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

      <Section id="s-seg" title="Segmented control" note="One choice of a few, for a view switch, a role switch or a filter. Radio group semantics (arrow keys move and select, Tab enters on the selected one), or tabs when each option has its own panel. 40 or 32 px high, 48 px hit area, disabled options stay visible and are skipped by the arrows.">
        <div style={{ display: "grid", gap: 14 }}>
          <Cell label="View switch (radio group, 40 px)"><SegmentedControl label="View" value={view} onChange={setView} data-testid="seg-view" options={[{ value: "table", label: "Table", testId: "seg-table" }, { value: "cards", label: "Cards" }, { value: "board", label: "Board" }]} /></Cell>
          <Cell label="Role switch, one option off (32 px)"><SegmentedControl label="Role" size="sm" value={role} onChange={setRole} data-testid="seg-role" options={[{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "operator", label: "Operator", disabled: true, disabledReason: "Not available for your role" }]} /></Cell>
          <Cell label="Filter with counts as words"><SegmentedControl label="Show" value={size} onChange={setSize} options={[{ value: "all", label: "All 24" }, { value: "open", label: "Open 19" }, { value: "late", label: "Late 2" }]} /></Cell>
          <Cell label="Tabs (each option shows a panel)">
            <div style={{ display: "grid", gap: 8 }}>
              <SegmentedControl kind="tabs" label="Job sections" value={tab} onChange={setTab} data-testid="seg-tabs" options={[{ value: "details", label: "Details", controls: "panel-details" }, { value: "history", label: "History", controls: "panel-history" }]} />
              <div id={tab === "details" ? "panel-details" : "panel-history"} role="tabpanel" aria-label={tab === "details" ? "Details" : "History"} style={{ fontSize: 13, color: "#3b4559" }}>{tab === "details" ? "Details panel: sample content." : "History panel: sample content."}</div>
            </div>
          </Cell>
          <div style={row}>
            <Cell label="Selected and disabled"><SegmentedControl label="Locked view" value="table" onChange={() => {}} options={[{ value: "table", label: "Table", disabled: true }, { value: "cards", label: "Cards", disabled: true }]} /></Cell>
            <Cell label="Whole control disabled"><SegmentedControl label="Loading view" disabled value="cards" onChange={() => {}} options={[{ value: "table", label: "Table" }, { value: "cards", label: "Cards" }]} /></Cell>
            <Cell label="Focus ring (keyboard)"><SegmentedControl label="Focus sample" value="b" onChange={() => {}} options={[{ value: "a", label: "First" }, { value: "b", label: "Second", testId: "seg-focus" }]} /></Cell>
          </div>
        </div>
      </Section>

      <Section id="s-fields" title="Form fields" note="Field gives the label, hint and error and wires id, aria-describedby and aria-invalid. The visible control is 40 px inside a 48 px hit box. An error is words plus a red edge, never colour alone.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "10px 20px" }} data-testid="fields-grid">
          <Field label="Customer" hint="Pick the customer this job is for."><Input placeholder="Customer name" data-testid="f-default" /></Field>
          <Field label="Job name" required error={form.name.trim() === "" ? "Enter a job name." : undefined}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="f-live-error" /></Field>
          <Field label="Quantity" error="Quantity must be at least 1." hint="Whole numbers only."><Input inputMode="numeric" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} data-testid="f-error" /></Field>
          <Field label="Job number (locked)" hint="Set when the job is created."><Input value="J-0431" disabled data-testid="f-disabled" /></Field>
          <Field label="Due date" optional><Input type="date" data-testid="f-date" /></Field>
          <Field label="Machine"><Select defaultValue="" data-testid="f-select"><option value="">Choose a machine</option><option>Laser 2</option><option>Press 1</option><option>Mill 3</option></Select></Field>
          <Field label="Material" error="Choose a material."><Select defaultValue="" data-testid="f-select-error"><option value="">Choose a material</option><option>S355</option><option>304</option></Select></Field>
          <Field label="Machine (locked)"><Select disabled defaultValue="Laser 2"><option>Laser 2</option></Select></Field>
          <Field label="Note" hint="Shown to the whole team." wide><Textarea rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} data-testid="f-area" /></Field>
          <Field label="Note with an error" error="The note is too long (2,140 of 2,000)." wide><Textarea rows={2} defaultValue="Sample" data-testid="f-area-error" /></Field>
          <Field label="Focus ring"><Input defaultValue="Focused look" style={{ boxShadow: "inset 0 0 0 2px var(--ui-accent)" }} /></Field>
        </div>
      </Section>

      <Section id="s-tile" title="Stat tile" note="A label, one tabular figure, an optional hint and a delta in words. No chart, no icon. Loading shows a dash. With onPress it is a toggle that filters the list below.">
        <StatTiles label="Sample figures" columns={4}>
          <StatTile label="Open jobs" value="19" hint="£42,310.00 on the books" data-testid="tile-a" />
          <StatTile label="Late jobs" value="2" hint="Past their due date" delta="Up 1 on last week" deltaTone="danger" />
          <StatTile label="On time rate" value="94%" hint="Finished jobs, last 30 days" delta="Same as last week" />
          <StatTile label="Hours booked" value="1,284.5" delta="Down 3.0 on last week" deltaTone="warn" />
        </StatTiles>
        <StatTiles label="Loading and pressable" columns={4}>
          <StatTile label="Open jobs" value="19" loading data-testid="tile-loading" />
          <StatTile label="Drafts" value="—" loading hint="hidden while loading" />
          <StatTile label="Open quotes" value="7" hint="Filter the list" pressed={tileOn === "open"} onPress={() => setTileOn(tileOn === "open" ? null : "open")} data-testid="tile-press" />
          <StatTile label="Accepted" value="12" hint="Filter the list" onPress={() => previewOnly("No filter was applied.")} />
        </StatTiles>
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
          <Popover label="Locked first" title="Columns (first is locked)" data-testid="pop-locked">
            <Switch label="Job number" hint="Always shown" checked disabled onChange={() => {}} />
            <Switch label="Customer" checked={cols.machine} onChange={(v) => setCols({ ...cols, machine: v })} data-testid="pop-first-enabled" />
          </Popover>
        </div>
      </Section>

      <Section id="s-dialog" title="Dialog" note="One pattern: navy primary on the right, outlined Cancel beside it. Opens on the safe button. The busy state runs 2 seconds, then shows an error, because no request exists to succeed.">
        <div style={row}>
          <Button onClick={() => setDlg("confirm")} data-testid="open-confirm">Confirmation</Button>
          <Button onClick={() => setDlg("fields")} data-testid="open-fields">With a field</Button>
          <Button onClick={() => { setBusyError(undefined); setDlg("busy"); }} data-testid="open-busy">Busy then error</Button>
          <Button onClick={() => setDlg("secondary")} data-testid="open-secondary">With a middle action</Button>
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
          open={dlg === "secondary"}
          title="Leave this quote?"
          description="You have changes that are not saved. Choose what to do with them."
          confirmLabel="Save and leave"
          secondaryLabel="Leave without saving"
          onSecondary={() => { setDlg(null); previewOnly("Nothing was discarded."); }}
          onClose={() => setDlg(null)}
          onConfirm={() => { setDlg(null); previewOnly("Nothing was saved."); }}
        />
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

      <Section id="s-sheet" title="Sheet" note="A wide modal for a longer form or a detail view: header, a body that scrolls on its own, a footer of your own buttons. Focus is trapped, Escape closes, focus returns to the button that opened it. Sizes sm 520, md 680, lg 860.">
        <div style={row}>
          <Button onClick={() => setSheet("sm")} data-testid="open-sheet-sm">Small sheet</Button>
          <Button onClick={() => setSheet("md")} data-testid="open-sheet-md">Medium sheet</Button>
          <Button onClick={() => setSheet("lg")} data-testid="open-sheet-lg">Large sheet, long body</Button>
        </div>
        <Sheet open={sheet !== null} size={sheet ?? "md"} testId="sheet" onClose={() => setSheet(null)}
          title={sheet === "lg" ? "Quote QUO-0412 details" : sheet === "md" ? "Edit job" : "Send quote"}
          description={sheet === "lg" ? "A long body scrolls while the header and footer stay." : "Sample content for layout only."}
          footer={<>
            <Button variant="secondary" onClick={() => setSheet(null)}>Cancel</Button>
            <Button variant="secondary" onClick={() => previewOnly("Nothing was saved as a draft.")}>Save draft</Button>
            <Button variant="primary" onClick={() => { setSheet(null); previewOnly("Nothing was sent."); }}>{sheet === "sm" ? "Send quote" : "Save changes"}</Button>
          </>}>
          <Field label="Customer"><Select defaultValue="Hartley Engineering"><option>Hartley Engineering</option><option>Northfield Fabrication</option></Select></Field>
          <Field label="Note" hint="Shown on the quote."><Textarea rows={3} /></Field>
          {sheet === "lg" ? Array.from({ length: 14 }, (_, i) => (
            <p key={i} style={{ margin: 0, color: "#3b4559" }}>Line {i + 1}: Bracket, 6mm plate, laser cut and folded. Sample body text to make this sheet scroll inside its own body.</p>
          )) : null}
        </Sheet>
      </Section>

      <Section id="s-toast" title="Toast" note="Neutral, one layer: a new message replaces the old one, nothing stacks. No green success tone. Info closes itself after 5 seconds and pauses on hover; an error stays until dismissed.">
        <div style={row}>
          <Button onClick={() => toast.show({ title: "Preview only", detail: "The job was not paused. Nothing was saved." })} data-testid="toast-info">Show message</Button>
          <Button onClick={() => toast.show({ title: "Could not load jobs", detail: "The connection dropped. Try again in a moment.", tone: "error" })} data-testid="toast-error">Show error</Button>
          <Button variant="quiet" onClick={toast.clear}>Clear</Button>
        </div>
        <div style={row} role="group" aria-label="Toast placement">
          <span style={cap}>Placement</span>
          {([["top-right", undefined, "Top right (default)"], ["bottom-right", undefined, "Bottom right"], ["bottom-left", undefined, "Bottom left"], ["bottom-centre", undefined, "Bottom centre"], ["top-right", 130, "Top right, 130 px down"]] as const).map(([p, o, l]) => (
            <Button key={l} size="sm" onClick={() => { setPlace({ placement: p, offset: o }); toast.show({ title: "Preview only", detail: `${l}. Nothing was saved.` }); }} data-testid={`place-${p}${o ? "-" + o : ""}`}>{l}</Button>
          ))}
        </div>
      </Section>

      <Section id="s-bar" title="Selection bar" note="Idle is one quiet line. Active is a navy bar with the live count and actions. Tick rows in the table below to drive the live one.">
        <div style={{ display: "grid", gap: 10 }}>
          <Cell label="Idle"><div style={{ width: "100%" }}><SelectionBar count={0} filteredTotal={5} noun="job" onSelectAll={() => {}} onClear={() => {}}><Button size="sm" variant="secondary" disabled>Finish selected</Button></SelectionBar></div></Cell>
          <Cell label="Idle, Select all and Clear kept visible (selectAll and clear = always)"><div style={{ width: "100%" }}><SelectionBar count={selOpts.length} filteredTotal={24} noun="quote" selectAll="always" clear="always" idleNote="Nothing selected. 24 quotes match." statusText={({ count, filteredTotal }) => `${count} of ${filteredTotal} quotes ticked`} onSelectAll={() => setSelOpts(Array.from({ length: 24 }, (_, i) => String(i)))} onClear={() => setSelOpts([])} stickyTop="0px"><Button size="sm" variant="secondary" disabled={selOpts.length === 0}>Export selected</Button></SelectionBar></div></Cell>
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

      <Section id="s-state" title="Empty, loading and failed" note="Honest panels: no numbers, no sample data. A real page zeroes or hides its own counters while one of these shows. headingLevel (2 to 6, default 3) lets a page match its own heading outline; here the section is an h2, so these are h3.">
        <div style={{ display: "grid", gap: 14 }}>
          <EmptyState headingLevel={3} title="No jobs yet" detail="Jobs you create appear here. Start with your first one." action={<Button variant="primary" onClick={() => previewOnly("No job was created.")}>New job</Button>} />
          <LoadingState label="Loading jobs" rows={4} />
          <FailedState
            title="Could not load jobs"
            detail={failedRetries === 0 ? "The connection dropped before the list arrived. Nothing has changed." : `Still no connection after ${failedRetries} ${failedRetries === 1 ? "try" : "tries"}. Nothing has changed.`}
            onRetry={() => setFailedRetries((n) => n + 1)}
            retryLabel="Try again"
          />
        </div>
      </Section>

      <ShowcaseV3 previewOnly={previewOnly} />
    </div>
  );
}

/* ---------------------------------------------------------------- v3 ---------------------------------------------------------------- */

const MINI_COLS = ["Job", "Customer", "Description", "Qty", "Value", "Actions"] as const;

function ShowcaseV3({ previewOnly }: { previewOnly: (what: string) => void }) {
  const [pressed, setPressed] = useState({ a: false, b: true, c: false });
  const [rowOpen, setRowOpen] = useState<string | null>(null);
  const [recSel, setRecSel] = useState<string[]>([]);
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [innerName, setInnerName] = useState("");
  const [chips, setChips] = useState<string[]>(["Open"]);
  const [segWrap, setSegWrap] = useState<"a" | "b" | "c">("a");
  const [grp, setGrp] = useState({ name: "", qty: "0", due: "" });
  const [attempts, setAttempts] = useState(0);
  const [range, setRange] = useState({ from: "2026-11-01", to: "2026-11-23" });
  const [applied, setApplied] = useState("Not applied yet");
  const [disc, setDisc] = useState<boolean | null>(null);

  const errors: ErrorSummaryItem[] = [
    ...(grp.name.trim() === "" ? [{ fieldId: "g-name", label: "Job name", message: "Enter a job name." }] : []),
    ...(!(Number(grp.qty) >= 1) ? [{ fieldId: "g-qty", label: "Quantity", message: "Quantity must be at least 1." }] : []),
    ...(grp.due === "" ? [{ fieldId: "g-due", label: "Due date", message: "Choose a due date." }] : []),
  ];
  const show = attempts > 0;
  const total = ROWS.slice(0, 3).reduce((n, r) => n + r.qty, 0);

  return (
    <>
      <Section id="s-v3-btn" title="Button v3: danger, pressed, full width" note="danger = red outline (the first step of a destructive action), dangerSolid = red fill (the final confirm), dangerQuiet = red text (a row action). aria-pressed on secondary or quiet draws the navy pressed look with no override. fullWidth with size lg and primary is the full-width form action.">
        {(["danger", "dangerSolid", "dangerQuiet"] as const).map((v) => (
          <div key={v} style={row} data-testid={`btn-row-${v}`}>
            <span style={{ ...cap, width: 90 }}>{v}</span>
            {(["sm", "md", "lg"] as const).map((sz) => (<Button key={sz} variant={v} size={sz}>{sz === "sm" ? "Delete 32" : sz === "md" ? "Delete 40" : "Delete 48"}</Button>))}
            <Button variant={v} disabled>Disabled</Button>
            <Button variant={v} loading>Deleting</Button>
            <Button variant={v} style={focusRing}>Focus ring</Button>
          </div>
        ))}
        <div style={row} data-testid="btn-row-pressed">
          <span style={{ ...cap, width: 90 }}>pressed</span>
          <Button variant="secondary" aria-pressed={pressed.a} onClick={() => setPressed({ ...pressed, a: !pressed.a })} data-testid="press-secondary">Compact list</Button>
          <Button variant="secondary" aria-pressed={pressed.b} onClick={() => setPressed({ ...pressed, b: !pressed.b })} data-testid="press-secondary-on">Cards (on)</Button>
          <Button variant="quiet" aria-pressed={pressed.c} onClick={() => setPressed({ ...pressed, c: !pressed.c })} data-testid="press-quiet">Quiet toggle</Button>
          <Button variant="secondary" aria-pressed disabled>Disabled on</Button>
          <Button variant="secondary" size="sm" aria-pressed>Small on</Button>
        </div>
        <div style={{ maxWidth: 360 }} data-testid="btn-full"><Button variant="primary" size="lg" fullWidth onClick={() => previewOnly("Nothing was saved.")}>Save and continue</Button></div>
      </Section>

      <Section id="s-v3-menu" title="Menu v3: named trigger, full width, reasons" note="aria-label names the trigger for what it acts on (it keeps the visible word inside it). fullWidth fills a narrow column. An item hint is words under the label, read as its description: use it to say why an item is off. title is a tooltip.">
        <div style={row}>
          <Menu label="More" aria-label="More actions for Tomas Whitcombe" data-testid="menu-named" items={[
            { id: "edit", label: "Edit", onSelect: () => previewOnly("Edit was not opened.") },
            { id: "pw", label: "Set password", onSelect: () => previewOnly("No password was set."), title: "Sets a new sign-in password" },
            { id: "del", label: "Remove", disabled: true, separatorBefore: true, hint: "You cannot remove your own account.", onSelect: () => {} },
          ]} />
          <div style={{ width: 260 }}>
            <Menu label="Export" fullWidth data-testid="menu-full" items={[
              { id: "csv", label: "CSV", onSelect: () => previewOnly("CSV export was not run.") },
              { id: "x", label: "Email", disabled: true, hint: "Add the customer's email address first.", onSelect: () => {} },
            ]} />
          </div>
        </div>
      </Section>

      <Section id="s-v3-chips" title="Chips, segments and selection bar when they wrap" note="Wrapped chips and segments keep 48 px hit areas with a 16 px row gap, so they never overlap. The frames below are 280 px wide to force wrapping.">
        <div style={{ width: 280, display: "grid", gap: 18 }} data-testid="wrap-frame">
          <ChipGroup label="Wrapped filters" className="">
            {["Open", "Rework", "Late", "Waiting", "Finished", "Archived"].map((c) => (
              <FilterChip key={c} selected={chips.includes(c)} count={c === "Open" ? 19 : undefined} onToggle={() => setChips(chips.includes(c) ? chips.filter((x) => x !== c) : [...chips, c])}>{c}</FilterChip>
            ))}
          </ChipGroup>
          <SegmentedControl label="Wrapped period" value={segWrap} onChange={setSegWrap} data-testid="seg-wrap" options={[{ value: "a", label: "Last 3 months" }, { value: "b", label: "Last 6 months" }, { value: "c", label: "Last 12 months" }]} />
          <SelectionBar count={2} filteredTotal={5} noun="job" onSelectAll={() => {}} onClear={() => {}} stickyTop="0px"><Button size="sm" variant="primary" onClick={() => previewOnly("No jobs were finished.")}>Finish selected (2)</Button></SelectionBar>
        </div>
      </Section>

      <Section id="s-v3-table" title="Table v3: dense, totals, pinned Actions, clickable rows, record groups" note="The frames are 620 px wide so the tables scroll. Dense = 48 px rows. The totals row is a tfoot. pinLast keeps Actions in view with a shadow on its left edge only while columns are hidden. A colspan sub-row no longer leaks the first-column shadow.">
        <div style={{ maxWidth: 620, display: "grid", gap: 20 }}>
          <ScrollTable label="Dense jobs with totals and pinned Actions" dense pinLast>
            <thead><tr>{MINI_COLS.map((c, i) => <th key={c} scope="col" style={i === 0 ? { minWidth: 120 } : i === 2 ? { minWidth: 220 } : undefined}>{c}</th>)}</tr></thead>
            <tbody>
              {ROWS.slice(0, 3).map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}><strong className={tabularNumbers}>{r.id}</strong></td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.customer}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.desc}</td>
                  <td className={tabularNumbers} style={{ textAlign: "right" }}>{r.qty}</td>
                  <td className={tabularNumbers} style={{ textAlign: "right", whiteSpace: "nowrap" }}>{r.value}</td>
                  <td><Button size="sm" variant="secondary" data-testid="dense-action" onClick={() => previewOnly(`${r.id} was not changed.`)}>Open</Button></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row">Total</th><td /><td /><td className={tabularNumbers} style={{ textAlign: "right" }} data-testid="tfoot-qty">{total}</td><td className={tabularNumbers} style={{ textAlign: "right", whiteSpace: "nowrap" }}>13,265.50</td><td /></tr></tfoot>
          </ScrollTable>
          <ScrollTable label="Clickable rows">
            <thead><tr>{MINI_COLS.slice(0, 5).map((c) => <th key={c} scope="col" style={c === "Description" ? { minWidth: 220 } : undefined}>{c}</th>)}</tr></thead>
            <tbody>
              {ROWS.slice(0, 3).map((r) => (
                <tr key={r.id} data-clickable="true" data-selected={rowOpen === r.id} data-testid="click-row" onClick={(e) => { if (rowClickIsForRow(e.target, e.currentTarget)) { setRowOpen(r.id); previewOnly(`${r.id} row opened.`); } }}>
                  <td style={{ whiteSpace: "nowrap" }}><a href="#s-v3-table" onClick={(e) => { e.preventDefault(); setRowOpen(r.id); previewOnly(`${r.id} link opened.`); }}><strong className={tabularNumbers}>{r.id}</strong></a></td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.customer}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.desc}</td>
                  <td className={tabularNumbers} style={{ textAlign: "right" }}>{r.qty}</td>
                  <td className={tabularNumbers} style={{ textAlign: "right", whiteSpace: "nowrap" }}>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          <ScrollTable label="Records with sub-rows">
            <thead><tr><th scope="col" style={{ minWidth: 200 }}>Person</th><th scope="col">Role</th><th scope="col">Last login</th><th scope="col" style={{ minWidth: 160 }}>Status</th></tr></thead>
            {[["Callum Reeve", "Admin", "20 Nov"], ["Tomas Whitcombe", "Office", "18 Nov"]].map(([n, role, last]) => {
              const on = recSel.includes(n);
              return (
                <tbody key={n} data-record="true" data-selected={on} data-testid="record">
                  <tr>
                    <td style={{ whiteSpace: "nowrap" }}><div style={{ display: "flex", alignItems: "center", gap: 4 }}><Checkbox aria-label={`Select ${n}`} checked={on} onChange={() => setRecSel(on ? recSel.filter((x) => x !== n) : [...recSel, n])} /><strong>{n}</strong></div></td>
                    <td>{role}</td>
                    <td className={tabularNumbers} style={{ whiteSpace: "nowrap" }}>{last}</td>
                    <td><StatusBadge tone="ok">Active</StatusBadge></td>
                  </tr>
                  <tr data-sub="true"><td colSpan={4}><div style={{ color: "#566074", fontSize: 12.5 }} data-testid="subrow-note">Clock-in: on site only. A full-width note under the record: it stays at the left edge, is never wider than what you can see, and must not widen the table.</div></td></tr>
                </tbody>
              );
            })}
          </ScrollTable>
        </div>
      </Section>

      <Section id="s-v3-panel" title="Panel, callout, disclosure and list rows" note="Panel takes a heading level so a page keeps its outline (this section is an h2, so panels are h3). Callout has a left bar and words, no icon. Disclosure is the native details element. List rows are 56 px (48 dense); a row with href is one big link.">
        <div style={{ display: "grid", gap: 16, maxWidth: 760 }}>
          <Panel title="Panel with actions" headingLevel={3} actions={<Button size="sm" variant="secondary" onClick={() => previewOnly("Nothing was added.")}>Add line</Button>}>
            <p style={{ margin: 0, color: "#3b4559" }}>A white card with a heading you place in your outline, an actions slot, and a body.</p>
          </Panel>
          <Panel title="Bare panel for a list" headingLevel={3} bare data-testid="panel-bare">
            <List label="Recent jobs" plain>
              {ROWS.slice(0, 2).map((r) => <ListRow key={r.id} title={r.id} meta={`${r.customer}, ${r.desc}`} trailing={<StatusBadge tone={r.tone}>{r.status}</StatusBadge>} />)}
            </List>
          </Panel>
          <Callout tone="neutral">Neutral: a quiet note with a grey bar.</Callout>
          <Callout tone="info" action={<Button size="sm" variant="secondary" onClick={() => previewOnly("The filter was not cleared.")}>Show all</Button>}>Showing quotes past their valid-until date only.</Callout>
          <Callout tone="warn">The job was paused, so booking it again needs a restart first.</Callout>
          <Callout tone="error" lead="Could not save">Quantity must be at least 1.</Callout>
          <Disclosure summary="Despatched but not invoiced (3)" onToggle={(o) => setDisc(o)} data-testid="disc">
            <p style={{ margin: 0, color: "#3b4559" }}>Three delivery notes are waiting for an invoice. The same rows and words as the full list.</p>
          </Disclosure>
          <Disclosure summary="Open by default" defaultOpen><p style={{ margin: 0, color: "#3b4559" }}>Content shown from the start.</p></Disclosure>
          <p style={cap}>Disclosure toggled: {disc === null ? "not yet" : disc ? "open" : "closed"}</p>
          <List label="Customers" data-testid="list-rows">
            <ListRow title="Hartley Engineering" meta="3 open jobs, last order 12 Nov" href="#s-v3-panel" onClick={(e) => { e.preventDefault(); previewOnly("Hartley Engineering was not opened."); }} trailing={<Button size="sm" variant="secondary" onClick={() => previewOnly("No statement was drafted.")}>Draft statement</Button>} />
            <ListRow title="Northfield Fabrication" meta="1 open job" href="#s-v3-panel" onClick={(e) => { e.preventDefault(); previewOnly("Northfield was not opened."); }} />
            <ListRow title="Calder Hydraulics (plain row)" meta="No link, no actions" />
          </List>
          <List label="Customers, dense" dense><ListRow title="Dense row" meta="48 px" trailing={<Button size="sm" variant="quiet">Edit</Button>} /><ListRow title="Dense row two" /></List>
          <EmptyState compact headingLevel={3} title="No jobs for this customer" detail="Jobs you create for them appear here." />
        </div>
      </Section>

      <Section id="s-v3-form" title="Form group, error summary, date range, large fields" note="FormGroup titles a set of fields (role=group + heading, or fieldset + legend). Press Save with errors: the summary lists each problem as a link and focus moves to the first invalid field. DateRangeGroup wires From after To to both inputs; Apply then focuses From.">
        <div style={{ display: "grid", gap: 18, maxWidth: 720 }}>
          <form noValidate onSubmit={(e) => { e.preventDefault(); setAttempts((n) => n + 1); if (errors.length === 0) previewOnly("Nothing was saved."); }} style={{ display: "grid", gap: 14 }} data-testid="group-form">
            {show && errors.length > 0 ? <ErrorSummary errors={errors} focusSignal={attempts} headingLevel={3} data-testid="err-summary" /> : null}
            <FormGroup title="Job details" headingLevel={3} hint="What is being made and for whom." columns={2} data-testid="group-a">
              <Field id="g-name" label="Job name" required error={show && grp.name.trim() === "" ? "Enter a job name." : undefined}><Input value={grp.name} onChange={(e) => setGrp({ ...grp, name: e.target.value })} /></Field>
              <Field id="g-qty" label="Quantity" required error={show && !(Number(grp.qty) >= 1) ? "Quantity must be at least 1." : undefined}><Input inputMode="numeric" value={grp.qty} onChange={(e) => setGrp({ ...grp, qty: e.target.value })} /></Field>
            </FormGroup>
            <FormGroup title="Dates" headingLevel={3} as="fieldset" columns={2} data-testid="group-b">
              <Field id="g-due" label="Due date" required error={show && grp.due === "" ? "Choose a due date." : undefined}><Input type="date" value={grp.due} onChange={(e) => setGrp({ ...grp, due: e.target.value })} /></Field>
            </FormGroup>
            <div><Button variant="primary" type="submit" data-testid="group-save">Save job</Button></div>
          </form>
          <DateRangeGroup label="Report period" from={range.from} to={range.to} onFromChange={(v) => setRange({ ...range, from: v })} onToChange={(v) => setRange({ ...range, to: v })} onApply={() => setApplied(`Applied ${range.from} to ${range.to}`)} data-testid="range" />
          <p style={cap} data-testid="range-applied">{applied}</p>
          <div style={{ maxWidth: 360, display: "grid", gap: 12 }}>
            <Field label="Large text (16 px, 48 px visible)" large hint="Stops iOS zooming on focus."><Input placeholder="Customer name" data-testid="f-large" /></Field>
            <Field label="Large select" large><Select defaultValue="" data-testid="f-large-select"><option value="">Choose a machine</option><option>Laser 2</option></Select></Field>
            <Field label="Large note" large><Textarea rows={2} data-testid="f-large-area" /></Field>
            <Field label="Large with error" large error="Enter a name."><Input data-testid="f-large-error" /></Field>
          </div>
        </div>
      </Section>

      <Section id="s-v3-tile" title="Stat tile as a link" note="href makes the tile a link; status is a dot plus word; definition is the plain-words meaning, shown on hover and read by screen readers as the description.">
        <StatTiles label="Linked figures" columns={4}>
          <StatTile label="Needs attention" value="3" hint="Open the list" status="Act now" statusTone="danger" href="#s-v3-tile" definition="Jobs past their due date that are not finished." onClick={(e) => { e.preventDefault(); previewOnly("The attention list was not opened."); }} data-testid="tile-link-a" />
          <StatTile label="Waiting" value="5" status="Watch" statusTone="warn" href="#s-v3-tile" onClick={(e) => e.preventDefault()} data-testid="tile-link-b" />
          <StatTile label="Done today" value="12" status="Done" statusTone="ok" definition="Jobs finished since midnight." data-testid="tile-status-only" />
          <StatTile label="Open quotes" value="7" href="#s-v3-tile" loading onClick={(e) => e.preventDefault()} data-testid="tile-link-loading" />
        </StatTiles>
      </Section>

      <Section id="s-v3-nest" title="Nested sheet" note="A sheet opened from inside another sheet: Escape closes only the inner one, Tab stays inside the inner one, and the outer sheet is untouched. The inner sheet also opens a confirm dialog (three levels).">
        <div style={row}><Button onClick={() => setOuter(true)} data-testid="open-outer">Open outer sheet</Button></div>
        <Sheet open={outer} size="md" testId="sheet-outer" onClose={() => setOuter(false)} title="New sales order" description="The outer sheet."
          footer={<><Button variant="secondary" onClick={() => setOuter(false)}>Cancel</Button><Button variant="primary" onClick={() => { setOuter(false); previewOnly("Nothing was saved."); }}>Save order</Button></>}>
          <Field label="Customer"><Select defaultValue="Hartley Engineering"><option>Hartley Engineering</option><option>Northfield Fabrication</option></Select></Field>
          <div><Button variant="secondary" size="sm" onClick={() => setInner(true)} data-testid="open-inner">Add new customer</Button></div>
          <Field label="Note"><Textarea rows={2} /></Field>
          <Sheet open={inner} size="sm" testId="sheet-inner" onClose={() => setInner(false)} title="Add new customer" description="The inner sheet."
            footer={<><Button variant="secondary" onClick={() => setInner(false)}>Cancel</Button><Button variant="primary" onClick={() => setDiscard(true)} data-testid="open-discard">Discard?</Button></>}>
            <Field label="Customer name"><Input value={innerName} onChange={(e) => setInnerName(e.target.value)} data-testid="inner-name" /></Field>
            <Dialog open={discard} title="Discard this customer?" confirmLabel="Discard" onClose={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setInner(false); }} />
          </Sheet>
        </Sheet>
      </Section>
    </>
  );
}

export default function UiPreviewPage() {
  const [place, setPlace] = useState<Place>({ placement: "top-right" });
  return (
    <ToastProvider placement={place.placement} offset={place.offset}>
      <Showcase setPlace={setPlace} />
    </ToastProvider>
  );
}
