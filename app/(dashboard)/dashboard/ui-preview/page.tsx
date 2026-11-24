"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW, PREVIEW ONLY). Inputs: none (sample content for layout only). Output: every component of
 * components/ui/premium in every state, at /dashboard/ui-preview, behind the normal dashboard sign-in.
 * Must not change: it reads and writes nothing (no Supabase, no fetch, no storage). Nothing here saves, finishes or sends anything, and
 * no control reports success: a confirm just closes and says "Preview only". v2 adds SegmentedControl, Sheet, form fields, StatTile and the toast, dialog,
 * popover, state-panel and selection-bar options. v3 adds the sections from "Button v3" down: danger and pressed buttons, menu hints, table variants, panel, callout, disclosure, list rows, form group, error
 * summary, date range, link tiles, wrapped chips and segments, nested sheets and large fields. v4 (craft pass) shows the type scale, the elevation levels, PageHeader, Tabs, the StatusBadge modes and the info-neutral tone, StackedRows,
 * v5 (gaps found by the module builders) is the last block of sections ("v5:"): short-label and phone segmented control, PreviewBar at 390, SelectionBar on phones, danger menu items, the danger dialog and multi-line text, pinned columns, the attention disclosure, a StatTile control slot,
 * the 48 px icon button and expander, RemovableChip, FiltersPopover and the label-in-name helper. v6 (no sideways scrolling) is the "v6:" section: stacked ScrollTable options, collapseToSelect, Tabs More, long words; every other section must fit 320 to 1024 px wide.
 * the PreviewBar, the Panel nested and flat variants and a Type specimen (the same Tolra content in each candidate font that this build can load; nothing is changed by it), and the header of this page is itself a PreviewBar plus a PageHeader. Delete this route when a real module has adopted the set.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Button, Callout, Checkbox, ChipGroup, DateRangeGroup, Dialog, Disclosure, EmptyState, ErrorSummary, FailedState, Field, FilterChip, FormGroup, Input, List, ListRow, LoadingState, Menu, Panel, Popover,
  ScrollTable, SegmentedControl, Select, SelectionBar, Sheet, StatTile, StatTiles, StatusBadge, Switch, Textarea, ToastProvider, rowClickIsForRow, useToast, premiumTokens, tabularNumbers, srOnly, cx,
  PageHeader, PreviewBar, StackedRows, TabPanel, Tabs, typeScale,
  ExpanderButton, FiltersPopover, RemovableChip, RemovableChips, PREVIEW_SHORT_LABEL, attentionSummary, nameContainsVisible, nameWithVisible,
  type ActiveFilter, type ErrorSummaryItem, type FilterGroup, type StackedRow, type ToastPlacement,
} from "@/components/ui/premium";

const sec: CSSProperties = { display: "grid", gap: 14, paddingTop: 24, borderTop: "1px solid rgba(14,23,38,0.1)" };
const h2: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" };
const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 };
const cap: CSSProperties = { margin: 0, color: "#566074", fontSize: 13, lineHeight: "18px" };
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
      <PreviewBar data-testid="preview-bar" controls={
        <Popover label="Preview controls" title="Preview controls" data-testid="pbar-controls">
          <Switch label="Sample control one" hint="Does nothing here" checked={sw.a} onChange={(v) => setSw({ ...sw, a: v })} />
          <Switch label="Sample control two" checked={sw.b} onChange={(v) => setSw({ ...sw, b: v })} />
        </Popover>
      } />
      <PageHeader title="Shared UI preview" description="Every component of the shared set in each state. Sample content for layout only: nothing on this page reads or saves any data." data-testid="page-header-main" />

      <Section id="s-type" title="Type scale and figures" note="IBM Plex Sans throughout (weights 400, 500, 600). Weight carries the hierarchy: 600 for names and titles, 500 for labels and captions, 400 for body and secondary text. 13 px is the smallest running text; 12 px only for table headers, captions and badges. Figures that line up in columns use tabular figures.">
        <div style={{ display: "grid", gap: 10 }} data-testid="type-scale">
          {([
            ["page", "26 / 32, 600, tracked tight (22 / 28 under 640 px)", "Job board"],
            ["section", "18 / 24, 600", "Open jobs this week"],
            ["card", "15 / 22, 600", "Hartley Engineering"],
            ["label", "13 / 18, 600", "Customer reference"],
            ["body", "14 / 20, 400", "Bracket, 6mm plate, laser cut and folded"],
            ["name", "14 / 20, 600", "J-0431 Bracket, 6mm plate"],
            ["secondary", "13 / 18, 400, muted", "Due Friday, Laser 2, 120 off"],
            ["caption", "12 / 16, 500, muted", "Updated 14:32 by Sam"],
            ["tableHead", "12 / 16, 600, uppercase, tracked", "Customer"],
            ["numeral", "28 / 32, 600, tabular (24 / 28 under 640 px)", "£12,480.50"],
          ] as const).map(([k, spec, sample]) => (
            <div key={k} style={{ display: "grid", gap: 2, paddingBottom: 6 }}>
              <span style={cap}><strong style={{ fontWeight: 600, color: "#0e1726" }}>{k}</strong> {spec}</span>
              <span className={cx(premiumTokens, typeScale[k])} data-testid={`type-${k}`}>{sample}</span>
            </div>
          ))}
        </div>
        <div style={{ ...row, gap: 32, alignItems: "baseline" }}>
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

      <ShowcaseV4 previewOnly={previewOnly} />

      <FontSpecimenSection />

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

      <Section id="s-badge" title="Status badge" note="One grammar: dot plus word. Never colour alone. Pill is the quiet tinted chip; text drops the chip where the word already says it. info-neutral is for records that exist (not green, not amber).">
        <div style={row} data-testid="badges">
          <StatusBadge tone="neutral">Not started</StatusBadge>
          <StatusBadge tone="info-neutral">3 linked</StatusBadge>
          <StatusBadge tone="progress">Running</StatusBadge>
          <StatusBadge tone="info">Sent</StatusBadge>
          <StatusBadge tone="warn">At risk</StatusBadge>
          <StatusBadge tone="ok">On time</StatusBadge>
          <StatusBadge tone="danger">Late</StatusBadge>
          <StatusBadge tone="warn" plain>Plain: waiting</StatusBadge>
        </div>
        <div style={row} data-testid="badges-text">
          <StatusBadge mode="text" tone="neutral">Not started</StatusBadge>
          <StatusBadge mode="text" tone="info-neutral">3 linked</StatusBadge>
          <StatusBadge mode="text" tone="progress">Running</StatusBadge>
          <StatusBadge mode="text" tone="info">Sent</StatusBadge>
          <StatusBadge mode="text" tone="warn">At risk</StatusBadge>
          <StatusBadge mode="text" tone="ok">On time</StatusBadge>
          <StatusBadge mode="text" tone="danger">Late</StatusBadge>
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

      <Section id="s-table" title="Table finish" note="Above 1024 px: sticky first column, a right edge fade while more columns are hidden, a shadow on the first column only once scrolled sideways, 64 px rows. At 1024 px and under (phone and tablet) the SAME table is stacked records: a title line, label and value pairs, the Open action at the bottom. Nothing scrolls sideways there.">
        <SelectionBar count={sel.length} filteredTotal={ROWS.length} noun="job" onSelectAll={() => setSel(allIds)} onClear={() => setSel([])} stickyTop="0px">
          <Button size="sm" variant="primary" disabled={sel.length === 0} onClick={() => previewOnly(`${sel.length} jobs were not finished.`)} data-testid="bulk-finish">Finish selected ({sel.length})</Button>
        </SelectionBar>
        <ScrollTable label="Sample jobs (stacked at 1024 px and under, scrolls sideways only on desktop)">
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

      <ShowcaseV5 previewOnly={previewOnly} />
    </div>
  );
}

/* ---------------------------------------------------------------- v4 ---------------------------------------------------------------- */

const STACK_ROWS: StackedRow[] = ROWS.slice(0, 3).map((r) => ({
  id: r.id,
  title: `${r.id} ${r.desc}`,
  status: <StatusBadge mode="text" tone={r.tone}>{r.status}</StatusBadge>,
  fields: [{ label: "Customer", value: r.customer }, { label: "Due", value: r.due }, { label: "Machine", value: r.machine }, { label: "Value", value: <span className={tabularNumbers}>£{r.value}</span> }],
  actions: <><Button size="sm" variant="secondary">View</Button><Button size="sm" variant="quiet">More</Button></>,
  testId: `stack-${r.id}`,
}));

function Elev({ name, shadow, note }: { name: string; shadow: string; note: string }) {
  return (
    <div className={premiumTokens} style={{ display: "grid", gap: 6 }}>
      <div style={{ height: 72, borderRadius: 14, background: "#fff", boxShadow: shadow, display: "grid", placeItems: "center" }} data-testid={`elev-${name}`}><span className={typeScale.name}>{name}</span></div>
      <span style={cap}>{note}</span>
    </div>
  );
}

function ShowcaseV4({ previewOnly }: { previewOnly: (what: string) => void }) {
  const [tab, setTab] = useState<"today" | "overdue" | "week" | "all">("today");
  const [tab2, setTab2] = useState<"a" | "b">("a");
  return (
    <>
      <Section id="s-v4-elev" title="Elevation and nesting" note="Four levels: flat (hairline), raised (card: hairline, soft shadow, 1 px inner highlight), overlay (menu, popover, toast) and modal (dialog, sheet). Panel variants: raised (default), flat, and nested, which draws no card at all so a panel inside a panel is never a card in a card.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 16, padding: 16, background: "#eef1f6", borderRadius: 14 }}>
          <Elev name="flat" shadow="var(--ui-elev-flat)" note="--ui-elev-flat" />
          <Elev name="raised" shadow="var(--ui-elev-raised)" note="--ui-elev-raised" />
          <Elev name="overlay" shadow="var(--ui-elev-overlay)" note="--ui-elev-overlay" />
          <Elev name="modal" shadow="var(--ui-elev-modal)" note="--ui-elev-modal" />
        </div>
        <div style={{ display: "grid", gap: 16 }}>
          <Panel title="Raised panel (default)" headingLevel={3} data-testid="panel-raised" actions={<Button size="sm" variant="secondary" onClick={() => previewOnly("Nothing was added.")}>Add line</Button>}>
            <div style={{ display: "grid", gap: 14 }}>
              <StatTiles label="Inside a panel, flat tiles" columns={3}>
                <StatTile flat label="Open" value="19" hint="Not archived" />
                <StatTile flat label="Late" value="2" delta="Down 1 on last week" deltaTone="ok" />
                <StatTile flat label="Due today" value="4" />
              </StatTiles>
              <Panel nested title="Nested panel: no card, a hairline above" headingLevel={4} data-testid="panel-nested">
                <ScrollTable flush label="Jobs inside a panel">
                  <thead><tr><th scope="col">Job</th><th scope="col">Customer</th><th scope="col">Status</th></tr></thead>
                  <tbody>{ROWS.slice(0, 2).map((r) => (<tr key={r.id}><td><span className={typeScale.name}>{r.id}</span></td><td>{r.customer}</td><td><StatusBadge mode="text" tone={r.tone}>{r.status}</StatusBadge></td></tr>))}</tbody>
                </ScrollTable>
              </Panel>
              <EmptyState compact headingLevel={4} title="No notes yet" detail="A compact empty state draws no card of its own." />
            </div>
          </Panel>
          <Panel variant="flat" title="Flat panel (hairline only)" headingLevel={3} data-testid="panel-flat">
            <p style={{ margin: 0, color: "#3b4559" }}>For a page that already sits on a raised surface, or where several panels sit side by side.</p>
          </Panel>
        </div>
      </Section>

      <Section id="s-v4-header" title="Page header" note="Title in the page style, an optional description, optional actions. One heading only. Actions wrap under the text on a narrow screen. The header of this very page is one.">
        <div style={{ display: "grid", gap: 28 }}>
          <PageHeader title="Quotes" description="Prices we have offered. Draft quotes can still change; sent quotes are the record." headingLevel={3} data-testid="ph-full" actions={<><Button variant="secondary" onClick={() => previewOnly("Nothing was exported.")}>Export</Button><Button variant="primary" onClick={() => previewOnly("No quote was created.")}>New quote</Button></>} />
          <PageHeader title="Machine schedule" headingLevel={3} data-testid="ph-title-only" />
          <div style={{ maxWidth: 340, borderTop: "1px dashed rgba(14,23,38,0.2)", paddingTop: 12 }}>
            <span style={cap}>A 340 px frame</span>
            <PageHeader title="Delivery notes" description="Goes with finished work." headingLevel={3} data-testid="ph-narrow" actions={<Button variant="primary">New delivery note</Button>} />
          </div>
        </div>
      </Section>

      <Section id="s-v4-tabs" title="Tabs" note="Underline tabs for the sections of one screen: 44 px, a 2 px navy bar, the first label on the content edge. Left and Right move and select, Home and End jump, Tab enters on the selected tab. Use SegmentedControl for a view of the same data.">
        <div style={{ display: "grid", gap: 14 }}>
          <div data-testid="tabs-wrap">
            <Tabs label="Dashboard sections" value={tab} onChange={setTab} data-testid="tabs-main" tabs={[
              { value: "today", label: "Today", count: 29, controls: "tp-today", id: "t-today", testId: "tab-today" },
              { value: "overdue", label: "Overdue", count: 7, controls: "tp-overdue", id: "t-overdue" },
              { value: "week", label: "This week", count: 41, controls: "tp-week", id: "t-week" },
              { value: "all", label: "Archive", disabled: true, disabledReason: "Not available in the preview", controls: "tp-all", id: "t-all" },
            ]} />
            <div style={{ paddingTop: 16 }}>
              <TabPanel id="tp-today" tabId="t-today" hidden={tab !== "today"}><span className={typeScale.secondary}>Today: 29 things need you. The first tab label starts exactly where the content starts.</span></TabPanel>
              <TabPanel id="tp-overdue" tabId="t-overdue" hidden={tab !== "overdue"}><span className={typeScale.secondary}>Overdue: 7 jobs past their date.</span></TabPanel>
              <TabPanel id="tp-week" tabId="t-week" hidden={tab !== "week"}><span className={typeScale.secondary}>This week: 41 jobs.</span></TabPanel>
            </div>
          </div>
          <div style={{ maxWidth: 360 }}>
            <Tabs label="Two sections" value={tab2} onChange={setTab2} tabs={[{ value: "a", label: "Details" }, { value: "b", label: "History", count: 3 }]} data-testid="tabs-two" />
          </div>
        </div>
      </Section>

      <Section id="s-v4-stack" title="Stacked rows" note="The narrow form of a table: one record per row, label and value pairs, actions underneath. Always shown here. A real screen pairs it with the table: ScrollTable narrowHidden plus StackedRows narrowOnly, so under 640 px only the stacked form shows.">
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ maxWidth: 390 }}><StackedRows label="Jobs, stacked" rows={STACK_ROWS} data-testid="stack-demo" /></div>
          <div data-testid="stack-pair">
            <ScrollTable narrowHidden label="Jobs, table form (hidden under 640 px)">
              <thead><tr><th scope="col">Job</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Due</th></tr></thead>
              <tbody>{ROWS.slice(0, 3).map((r) => (<tr key={r.id}><td><span className={typeScale.name}>{r.id}</span></td><td>{r.customer}</td><td><StatusBadge mode="text" tone={r.tone}>{r.status}</StatusBadge></td><td>{r.due}</td></tr>))}</tbody>
            </ScrollTable>
            <StackedRows narrowOnly label="Jobs, stacked form (shown under 640 px)" rows={STACK_ROWS} data-testid="stack-narrow" />
          </div>
        </div>
      </Section>

      <Section id="s-v4-preview" title="Preview bar" note="ONE 28 px strip holds the preview tag and the Preview controls trigger, so the page title row carries neither. Any Button in the slot (a Popover or Menu trigger too) becomes a 24 px text button with a 48 px hit area. The bar at the top of this page is the live one.">
        <div style={{ display: "grid", gap: 12 }}>
          <PreviewBar data-testid="pbar-plain" />
          <PreviewBar data-testid="pbar-demo" controls={<Button size="sm" variant="secondary" data-testid="pbar-demo-btn" onClick={() => previewOnly("The controls were not opened.")}>Preview controls</Button>} />
          <div style={{ maxWidth: 390 }}><PreviewBar data-testid="pbar-narrow" controls={<Button size="sm" variant="secondary">Preview controls</Button>} /></div>
        </div>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------- type specimen ---------------------------------------------------------------- */

/** Candidate UI fonts. `weights` says what a same-origin copy would offer; a font this build cannot load is omitted (never faked). */
const CANDIDATES = [
  { name: "IBM Plex Sans", note: "the shared set's font now: static 400 500 600 from @fontsource (bundled, same origin)" },
  { name: "Archivo", note: "the real app's current font (before): static 400 to 700, 650 snaps to 700" },
  { name: "Inter", note: "variable 100 to 900" },
  { name: "Geist", note: "variable 100 to 900" },
  { name: "Public Sans", note: "variable 100 to 900" },
  { name: "Instrument Sans", note: "variable 400 to 700" },
  { name: "Figtree", note: "variable 300 to 900" },
] as const;

/** True when the browser really has this family (its text measures differently from both generic fallbacks). */
function fontAvailable(name: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  const t = "mmmmmmmmmmlliWQ0O8B1234567890";
  const w = (f: string) => { ctx.font = `16px ${f}`; return ctx.measureText(t).width; };
  return w(`"${name}", monospace`) !== w("monospace") || w(`"${name}", serif`) !== w("serif");
}

function Specimen({ name, note }: { name: string; note: string }) {
  const fam = `"${name}", system-ui, sans-serif`;
  const tab1 = useRef<HTMLSpanElement>(null);
  const tab0 = useRef<HTMLSpanElement>(null);
  const pro1 = useRef<HTMLSpanElement>(null);
  const pro0 = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState<string>("measuring");
  useEffect(() => {
    document.fonts.ready.then(() => {
      const r = (x: React.RefObject<HTMLSpanElement | null>) => (x.current ? x.current.getBoundingClientRect().width : 0);
      const t1 = r(tab1), t0 = r(tab0), p1 = r(pro1), p0 = r(pro0);
      setW(`tabular 11111.11 = ${t1.toFixed(1)} px, 00000.00 = ${t0.toFixed(1)} px (${Math.abs(t1 - t0) < 0.1 ? "equal" : "NOT equal"}); proportional ${p1.toFixed(1)} vs ${p0.toFixed(1)} px (${Math.abs(p1 - p0) < 0.1 ? "equal, no difference" : "differ"})`);
    });
  }, []);
  const frame: CSSProperties = { ["--ui-font-override" as string]: fam, display: "grid", gap: 16, padding: 16, background: "#fff", borderRadius: 14, boxShadow: "0 0 0 1px rgba(14,23,38,0.1)", minWidth: 0 };
  const probe: CSSProperties = { fontFamily: fam, fontSize: 22, fontWeight: 600, display: "inline-block" };
  const amb = (bg: string, fg: string): CSSProperties => ({ fontFamily: fam, fontSize: 13, lineHeight: "20px", padding: "6px 10px", background: bg, color: fg, borderRadius: 8, overflowWrap: "anywhere" });
  return (
    <div className={premiumTokens} style={frame} data-testid={`spec-${name.replace(/ /g, "-")}`}>
      <div style={{ display: "grid", gap: 2 }}>
        <span className={typeScale.card}>{name}</span>
        <span style={cap}>{note}</span>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span ref={tab1} className={tabularNumbers} style={probe}>11111.11</span>
          <span ref={tab0} className={tabularNumbers} style={probe}>00000.00</span>
          <span ref={pro1} style={{ ...probe, fontVariantNumeric: "proportional-nums", fontFeatureSettings: '"pnum" 1' }}>11111.11</span>
          <span ref={pro0} style={{ ...probe, fontVariantNumeric: "proportional-nums", fontFeatureSettings: '"pnum" 1' }}>00000.00</span>
        </span>
        <span style={cap} data-testid="spec-widths">{w}</span>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <div style={amb("#fff", "#0e1726")}>0 O o  1 l I |  5 6 S  8 B 3  rn m  cl d. Hamburgefonstiv 13 px on white. Quote Q-2041, 1,240.50</div>
        <div style={amb("#1e3472", "#ffffff")}>0 O o  1 l I |  5 6 S  8 B 3  rn m  cl d. Hamburgefonstiv 13 px on navy. Quote Q-2041, 1,240.50</div>
        <div style={{ ...amb("#fff", "#0e1726"), fontSize: 14 }}>Hamburgefonstiv 14 px: bracket, 6mm plate, laser cut and folded for Hartley Engineering.</div>
      </div>
      <StatTiles label={`${name} figures`} columns={2}>
        <StatTile flat label="Open value" value="£42,310.00" hint="19 open jobs" delta="£8,120.50 overdue" deltaTone="danger" />
        <StatTile flat label="Paid this month" value="£126,904.75" hint="31 invoices" />
      </StatTiles>
      <ScrollTable flush dense label={`${name} jobs`}>
        <thead><tr><th scope="col">Job</th><th scope="col">Customer</th><th scope="col" style={{ textAlign: "right" }}>Qty</th><th scope="col" style={{ textAlign: "right" }}>Value</th><th scope="col">Status</th></tr></thead>
        <tbody>
          {ROWS.slice(0, 4).map((r) => (
            <tr key={r.id}><td><span className={typeScale.name}>{r.id}</span></td><td>{r.customer}</td><td className={tabularNumbers} style={{ textAlign: "right" }}>{r.qty}</td><td className={tabularNumbers} style={{ textAlign: "right" }}>{r.value}</td><td><StatusBadge mode="text" tone={r.tone}>{r.status}</StatusBadge></td></tr>
          ))}
        </tbody>
      </ScrollTable>
      <div style={{ display: "grid", gap: 0, gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 12 }}>
        <Field label="Customer reference" hint="As on their purchase order"><Input defaultValue="PO-100482" /></Field>
        <Field label="Quantity" error="Quantity must be at least 1."><Input defaultValue="0" /></Field>
      </div>
      <div style={{ display: "grid", gap: 8, padding: 16, borderRadius: 14, boxShadow: "var(--ui-elev-modal)" }}>
        <span className={cx(premiumTokens, typeScale.section)}>Finish 2 jobs?</span>
        <span className={cx(premiumTokens, typeScale.body)} style={{ color: "#3b4559" }}>They move to Complete and leave the shop-floor list. This can&apos;t be undone.</span>
        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><Button variant="secondary">Cancel</Button><Button variant="primary">Finish 2 jobs</Button></span>
      </div>
      <div style={row}>
        <StatusBadge tone="info-neutral">3 linked</StatusBadge><StatusBadge tone="progress">Running</StatusBadge><StatusBadge tone="warn">At risk</StatusBadge><StatusBadge tone="ok">On time</StatusBadge><StatusBadge tone="danger">Late</StatusBadge>
      </div>
    </div>
  );
}

function FontSpecimenSection() {
  const [avail, setAvail] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const c of CANDIDATES) {
        try { await Promise.all([400, 500, 600, 700].map((wt) => document.fonts.load(`${wt} 16px "${c.name}"`))); } catch { /* not loadable */ }
        out[c.name] = fontAvailable(c.name);
      }
      if (live) setAvail(out);
    })();
    return () => { live = false; };
  }, []);
  const shown = CANDIDATES.filter((c) => avail?.[c.name]);
  const omitted = CANDIDATES.filter((c) => avail && !avail[c.name]).map((c) => c.name);
  return (
    <Section id="s-v4-fonts" title="Type specimen" note="The same Tolra content in each candidate font: KPI figures with currency, a dense table with right-aligned tabular numerals, a form, a dialog title, status badges and 12 px uppercase table headers. Only fonts this build can really load are drawn; the rest are listed as omitted. The swap is one line: set --ui-font-override on any ancestor (or change the default of --ui-font in the tokens). The default font is not changed by this page.">
      <p style={cap} data-testid="spec-omitted">{avail === null ? "Checking which fonts can load…" : omitted.length ? `Not loadable here, omitted: ${omitted.join(", ")}.` : "All candidates loaded."}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 520px), 1fr))", gap: 16 }} data-testid="spec-grid">
        {shown.map((c) => <Specimen key={c.name} name={c.name} note={c.note} />)}
      </div>
    </Section>
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

      <Section id="s-v3-table" title="Table v3: dense, totals, pinned Actions, clickable rows, record groups" note="Above 1024 px the frames are 620 px wide so the tables scroll; at 1024 px and under every one of them is stacked (totals as a block, sub-rows as notes, clickable rows kept). Dense = 48 px rows. The totals row is a tfoot. pinLast keeps Actions in view with a shadow on its left edge only while columns are hidden. A colspan sub-row no longer leaks the first-column shadow.">
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
                  <tr data-sub="true"><td colSpan={4}><div style={{ color: "#566074", fontSize: 13 }} data-testid="subrow-note">Clock-in: on site only. A full-width note under the record: it stays at the left edge, is never wider than what you can see, and must not widen the table.</div></td></tr>
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

/* ---------------------------------------------------------------- v5 ---------------------------------------------------------------- */

type FilterState = { statuses: string[]; show: string };
const FILTER_DEFAULT: FilterState = { statuses: [], show: "open" };
const FILTER_STATUSES = [["late", "Late"], ["waiting", "Waiting"], ["rework", "Rework"], ["done", "Complete"]] as const;
const SHOW_LABEL: Record<string, string> = { open: "Open", done: "Done", all: "All" };

function ShowcaseV5({ previewOnly }: { previewOnly: (what: string) => void }) {
  const [seg, setSeg] = useState<"all" | "list" | "3" | "6">("all");
  const [segPhone, setSegPhone] = useState<"open" | "done" | "archived" | "all">("open");
  const [segLong, setSegLong] = useState<"m3" | "m6" | "m12" | "all" | "custom">("m12");
  const [tab6, setTab6] = useState("a");
  const [segSm, setSegSm] = useState<"3" | "6">("3");
  const [barSel, setBarSel] = useState(2);
  const [danger, setDanger] = useState<null | "menu" | "plain" | "multi">(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerErr, setDangerErr] = useState<string | undefined>();
  const [attn, setAttn] = useState(2);
  const [unit, setUnit] = useState<"hours" | "days">("hours");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [chips, setChips] = useState(["Status: Late", "Show: Done", "Machine: Laser 2"]);
  const [filters, setFilters] = useState<FilterState>(FILTER_DEFAULT);

  useEffect(() => {
    if (!dangerBusy) return;
    const t = setTimeout(() => { setDangerBusy(false); setDangerErr("Preview only: no request was sent, so nothing was deleted."); }, 1800);
    return () => clearTimeout(t);
  }, [dangerBusy]);

  const groups: FilterGroup[] = [
    { kind: "segmented", id: "show", label: "Show", options: [{ value: "open", label: "Open", testId: "fp-show-open" }, { value: "done", label: "Done", testId: "fp-show-done" }, { value: "all", label: "All", testId: "fp-show-all" }], value: filters.show, onChange: (v) => setFilters((f) => ({ ...f, show: v })) },
    { kind: "chips", id: "status", label: "Status", options: FILTER_STATUSES.map(([value, label]) => ({ value, label, testId: `fp-chip-${value}` })), selected: filters.statuses, onToggle: (v) => setFilters((f) => ({ ...f, statuses: f.statuses.includes(v) ? f.statuses.filter((x) => x !== v) : [...f.statuses, v] })) },
  ];
  const active: ActiveFilter[] = [
    ...(filters.show !== "open" ? [{ id: "show", label: `Show: ${SHOW_LABEL[filters.show]}`, onRemove: () => setFilters((f) => ({ ...f, show: "open" })) }] : []),
    ...filters.statuses.map((v) => ({ id: `status-${v}`, label: `Status: ${FILTER_STATUSES.find((s) => s[0] === v)?.[1] ?? v}`, onRemove: () => setFilters((f) => ({ ...f, statuses: f.statuses.filter((x) => x !== v) })) })),
  ];
  const dangerItems = [
    { id: "view", label: "View job", onSelect: () => previewOnly("The job was not opened."), testId: "v5-menu-view", elementId: "v5-menu-view-btn" },
    { id: "dup", label: "Duplicate job", onSelect: () => previewOnly("Nothing was duplicated."), testId: "v5-menu-dup" },
    { id: "archive", label: "Archive job", onSelect: () => previewOnly("Nothing was archived."), disabled: true, hint: "Finish the job first", testId: "v5-menu-archive" },
    { id: "delete", label: "Delete job J-0431", danger: true, onSelect: () => setDanger("menu"), testId: "v5-menu-delete", elementId: "v5-menu-delete-btn" },
  ];
  const wide = ["Job", "Customer", "Description", "Machine", "Qty", "Value", "Actions"] as const;
  const pinRows = ROWS.slice(0, 3);
  // n = 3 pins a tick box column, the job and the customer (about 300 px); n = 2 pins the job and the customer (about 276 px).
  const pinTable = (n: 0 | 2 | 3, last: boolean, label: string) => (
    <ScrollTable label={label} pinFirst={n} pinLast={last} dense>
      <thead><tr>
        {n === 3 ? <th scope="col" style={{ width: 56, minWidth: 56 }}><span className={srOnly}>Select</span></th> : null}
        {wide.map((c, i) => <th key={c} scope="col" style={i === 0 ? { minWidth: 96, width: 96 } : i === 1 ? { minWidth: n === 3 ? 148 : 180, width: n === 3 ? 148 : 180 } : i === 2 ? { minWidth: 240 } : undefined}>{c}</th>)}
      </tr></thead>
      <tbody>
        {pinRows.map((r) => (
          <tr key={r.id}>
            {n === 3 ? <td style={{ padding: 0 }}><Checkbox aria-label={`Select ${r.id}`} checked={false} onChange={() => {}} /></td> : null}
            <td style={{ whiteSpace: "nowrap" }}><strong className={tabularNumbers}>{r.id}</strong></td>
            <td style={{ whiteSpace: "nowrap" }}>{r.customer}</td>
            <td style={{ whiteSpace: "nowrap" }}>{r.desc}</td>
            <td style={{ whiteSpace: "nowrap" }}>{r.machine}</td>
            <td className={tabularNumbers} style={{ textAlign: "right" }}>{r.qty}</td>
            <td className={tabularNumbers} style={{ textAlign: "right", whiteSpace: "nowrap" }}>{r.value}</td>
            <td><Button size="sm" variant="secondary" onClick={() => previewOnly(`${r.id} was not changed.`)}>Open</Button></td>
          </tr>
        ))}
        <tr data-sub="true"><td colSpan={n === 3 ? 8 : 7}><div style={{ color: "#566074", fontSize: 13 }}>A full-width note row: it is never pinned and leaks no shadow.</div></td></tr>
      </tbody>
    </ScrollTable>
  );

  return (
    <>
      <Section id="s-v5-seg" title="v5: segmented control with short labels, and on a phone" note="Every segment is at least 48 px wide and 48 px tall (a 48 px hit area, neighbours touch but never overlap). v6: under 640 px the control never scrolls: it fills the width, its segments share the row and wrap onto more rows 16 px apart. The 358 px frames below show the phone form.">
        <div style={{ display: "grid", gap: 18 }}>
          <Cell label="Short labels"><SegmentedControl label="View" value={seg} onChange={setSeg} data-testid="v5-seg-short" options={[{ value: "all", label: "All", testId: "v5-seg-all" }, { value: "list", label: "List", testId: "v5-seg-list" }, { value: "3", label: "3", testId: "v5-seg-3" }, { value: "6", label: "6", testId: "v5-seg-6" }]} /></Cell>
          <Cell label="Small, months"><SegmentedControl label="Months" size="sm" value={segSm} onChange={setSegSm} data-testid="v5-seg-sm" options={[{ value: "3", label: "3" }, { value: "6", label: "6" }]} /></Cell>
          <Cell label="Longer labels (a phone's width: the segments wrap onto a second row)">
            <div style={{ width: "100%", maxWidth: 358, minWidth: 0 }} data-testid="v5-seg-frame-long">
              <SegmentedControl label="Period" value={segLong} onChange={setSegLong} data-testid="v5-seg-long" options={[{ value: "m3", label: "Last 3 months" }, { value: "m6", label: "Last 6 months" }, { value: "m12", label: "Last 12 months" }, { value: "all", label: "All time" }]} />
            </div>
          </Cell>
          <Cell label="Four segments in a 358 px column (a phone's width)">
            <div style={{ width: "100%", maxWidth: 358, minWidth: 0 }} data-testid="v5-seg-frame">
              <SegmentedControl label="Show" value={segPhone} onChange={setSegPhone} data-testid="v5-seg-phone" options={[{ value: "open", label: "Open (24)" }, { value: "done", label: "Done (131)" }, { value: "archived", label: "Archived (5)" }, { value: "all", label: "All" }]} />
            </div>
          </Cell>
        </div>
      </Section>

      <Section id="s-v5-pbar" title="v5: preview bar at 390 px" note="Under 640 px the label wraps to a second short line instead of being cut with an ellipsis, and the controls trigger keeps its 48 px hit area. Or pass shortLabel: phones show the short words, the full label stays readable by assistive technology and names the group.">
        <div style={{ display: "grid", gap: 24, maxWidth: 390 }}>
          <div style={{ display: "grid", gap: 6 }}><span style={cap}>Default label</span><PreviewBar data-testid="v5-pbar-wrap" controls={<Button size="sm" variant="secondary">Preview controls</Button>} /></div>
          <div style={{ display: "grid", gap: 6 }}><span style={cap}>A longer label (wraps, never cut)</span><PreviewBar data-testid="v5-pbar-long" label="Preview, sample data, nothing is saved. Roles and states here are simulated." controls={<Button size="sm" variant="secondary">Preview controls</Button>} /></div>
          <div style={{ display: "grid", gap: 6 }}><span style={cap}>shortLabel (full text stays for assistive technology)</span><PreviewBar data-testid="v5-pbar-short" shortLabel={PREVIEW_SHORT_LABEL} controls={<Button size="sm" variant="secondary">Preview controls</Button>} /></div>
        </div>
      </Section>

      <Section id="s-v5-bar" title="v5: selection bar on a phone" note="v6: under 640 px an active bar never scrolls: the count, then the actions wrapped 16 px apart. With compact the row is the count, one primary action and a More menu holding Select all, Clear selection and your other actions. Narrow your browser under 640 px to see both; above that they look like the normal bar.">
        <div style={{ display: "grid", gap: 14 }}>
          <Cell label="Default: the actions wrap under the count on a phone">
            <div style={{ width: "100%" }}>
              <SelectionBar count={barSel} filteredTotal={24} noun="job" stickyTop="0px" onSelectAll={() => setBarSel(24)} onClear={() => setBarSel(0)}>
                <Button size="sm" variant="primary" onClick={() => previewOnly("No jobs were finished.")}>Finish selected ({barSel})</Button>
                <Button size="sm" variant="secondary" onClick={() => previewOnly("Nothing was printed.")}>Print workshop pack</Button>
                <Button size="sm" variant="secondary" onClick={() => previewOnly("Nothing was exported.")}>Export selected</Button>
              </SelectionBar>
            </div>
          </Cell>
          <Cell label="compact: count + primary + More on a phone">
            <div style={{ width: "100%" }}>
              <SelectionBar count={barSel} filteredTotal={24} noun="job" stickyTop="0px" onSelectAll={() => setBarSel(24)} onClear={() => setBarSel(0)}
                compact={{ primary: <Button size="sm" variant="primary" onClick={() => previewOnly("No jobs were finished.")}>Finish ({barSel})</Button>, more: [{ id: "print", label: "Print workshop pack", onSelect: () => previewOnly("Nothing was printed.") }, { id: "export", label: "Export selected", onSelect: () => previewOnly("Nothing was exported.") }] }}>
                <Button size="sm" variant="primary" onClick={() => previewOnly("No jobs were finished.")}>Finish selected ({barSel})</Button>
                <Button size="sm" variant="secondary" onClick={() => previewOnly("Nothing was printed.")}>Print workshop pack</Button>
                <Button size="sm" variant="secondary" onClick={() => previewOnly("Nothing was exported.")}>Export selected</Button>
              </SelectionBar>
            </div>
          </Cell>
          <Button size="sm" variant="quiet" onClick={() => setBarSel(barSel ? 0 : 2)} data-testid="v5-bar-toggle">{barSel ? "Clear both bars" : "Select 2 jobs in both bars"}</Button>
        </div>
      </Section>

      <Section id="s-v5-menu" title="v5: menu danger item, per-item test id and id" note="danger: red words, a red tint on hover and focus, and a separator before the first danger item. The LABEL says what is destroyed ('Delete job J-0431'), so colour is never the only signal; a screen reader also hears 'destructive'. testId puts a data-testid, elementId a DOM id, on the item button. The danger item opens the danger dialog below.">
        <div style={row}>
          <Menu label="More" aria-label="More actions for J-0431" items={dangerItems} data-testid="v5-menu" />
        </div>
      </Section>

      <Section id="s-v5-dialog" title="v5: danger dialog and multi-line text" note="Convention for anything destructive: the title names the verb and the thing ('Delete job J-0431?'); the description says what is lost, one fact per line (a line break is kept); the confirm is the red solid button named with that verb ('Delete job', never 'OK'); Cancel is the first focus, always; role is alertdialog. Navy primary stays for every non-destructive confirm.">
        <div style={row}>
          <Button variant="danger" onClick={() => { setDangerErr(undefined); setDanger("plain"); }} data-testid="v5-open-danger">Delete job…</Button>
          <Button variant="secondary" onClick={() => { setDangerErr(undefined); setDanger("multi"); }} data-testid="v5-open-multi">Delete with fields and several lines…</Button>
        </div>
        <Dialog open={danger === "plain" || danger === "menu"} tone="danger" title="Delete job J-0431?" description={"This removes the job, its 3 worksheets and its time bookings.\nInvoices already raised for it are kept.\nThis cannot be undone."}
          confirmLabel="Delete job" onConfirm={() => { if (danger === "menu") { setDanger(null); previewOnly("Nothing was deleted."); } else { setDangerErr(undefined); setDangerBusy(true); } }}
          onClose={() => setDanger(null)} busy={dangerBusy} error={dangerErr} confirmTestId="v5-danger-confirm" cancelTestId="v5-danger-cancel" />
        <Dialog open={danger === "multi"} tone="danger" title="Delete 2 customers?" description={"Two customers will be removed from the list.\nTheir quotes and jobs stay and show the name only."} confirmLabel="Delete 2 customers"
          onConfirm={() => { setDanger(null); previewOnly("Nothing was deleted."); }} onClose={() => setDanger(null)} confirmTestId="v5-multi-confirm">
          <Field label="Type DELETE to confirm"><Input data-testid="v5-multi-field" /></Field>
        </Dialog>
      </Section>

      <Section id="s-v5-table" title="v5: pin the first N columns, and pin the last" note="pinFirst={2} or {3} keeps the first columns in view while the rest scroll under them; each sticks after the one before it (measured widths), and only the LAST pinned column shows the soft shadow, only once scrolled. pinFirst={0} pins nothing. If the pinned columns would fill more than 60% of the visible width nothing is pinned. A colspan row is never pinned and leaks no shadow. 560 px frames.">
        <div style={{ display: "grid", gap: 20, maxWidth: 560 }}>
          <div style={{ display: "grid", gap: 6 }}><span style={cap}>pinFirst 2 + pinLast</span>{pinTable(2, true, "Two pinned columns and pinned Actions")}</div>
          <div style={{ display: "grid", gap: 6 }}><span style={cap}>pinFirst 3</span>{pinTable(3, false, "Three pinned columns")}</div>
          <div style={{ display: "grid", gap: 6 }}><span style={cap}>pinFirst 0</span>{pinTable(0, false, "No pinned column")}</div>
        </div>
      </Section>

      <Section id="s-v5-disc" title="v5: disclosure summary variants" note="attention is the summary for a count of things that need a person: 'N things need attention' (amber tint, 3 px bar). clear is its green twin. The words carry the meaning; attentionSummary(n) writes them. Native details: Enter and Space toggle, the row is 48 px.">
        <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
          <Disclosure variant={attn ? "attention" : "clear"} summary={<span data-testid="v5-attn-summary">{attentionSummary(attn)}</span>} data-testid="v5-attn">
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              <li>2 people have no display name, so the Job Board cannot say who a job is assigned to.</li>
              <li>Two-step sign-in is off for 1 administrator.</li>
            </ul>
          </Disclosure>
          <div style={row}>
            <Button size="sm" variant="secondary" onClick={() => setAttn(attn === 0 ? 2 : attn - 1)} data-testid="v5-attn-dec">Fix one</Button>
            <span style={cap}>{attn === 0 ? "Nothing left: the same disclosure turns to its clear style." : `${attn} to go.`}</span>
          </div>
        </div>
      </Section>

      <Section id="s-v5-tile" title="v5: stat tile with a control slot" note="control puts ONE inline control on the label row (here an Hours | Days toggle); it wraps under the label on a narrow tile. Only a plain tile takes it (a tile that is a button or link is already a control). The control names itself.">
        <StatTiles label="Tiles with a control" columns={3}>
          <StatTile label="Machine time" value={unit === "hours" ? "182 h" : "22.8 days"} hint="This month" control={
            <SegmentedControl label="Show machine time in" size="sm" value={unit} onChange={setUnit} options={[{ value: "hours", label: "Hours", testId: "v5-unit-hours" }, { value: "days", label: "Days", testId: "v5-unit-days" }]} data-testid="v5-unit" />
          } data-testid="v5-tile-control" />
          <StatTile label="Open jobs" value="19" hint="No control here" />
          <StatTile label="Late jobs" value="3" onPress={() => {}} control={<span>never drawn</span>} hint="A pressable tile skips the slot" />
        </StatTiles>
      </Section>

      <Section id="s-v5-icon" title="v5: 48 px icon button, expander and removable chip" note="Button size='icon' is a 48 x 48 square for an icon-only action; it needs an aria-label. ExpanderButton is the chevron version with aria-expanded. RemovableChip is a 32 px chip (a word and a cross) with a 48 px hit area; RemovableChips lists them with a 16 px row gap.">
        <div style={{ display: "grid", gap: 14 }}>
          <div style={row}>
            <ExpanderButton expanded={!!open.a} onToggle={() => setOpen((o) => ({ ...o, a: !o.a }))} label="Show details for J-0431" controls="v5-exp-a" data-testid="v5-expander" />
            <span className={typeScale.name}>J-0431 Bracket, 6mm plate</span>
            <Button size="icon" variant="quiet" aria-label="Close preview" data-testid="v5-icon-secondary" onClick={() => previewOnly("Nothing was closed.")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </Button>
          </div>
          {open.a ? <p id="v5-exp-a" style={{ ...cap, margin: 0 }}>Details for J-0431 open here: customer, machine and due date.</p> : null}
          <RemovableChips label="Active filters (sample)" data-testid="v5-chips">
            {chips.map((c) => <RemovableChip key={c} onRemove={() => setChips(chips.filter((x) => x !== c))} data-testid="v5-chip">{c}</RemovableChip>)}
            {chips.length === 0 ? <Button size="sm" variant="quiet" onClick={() => setChips(["Status: Late", "Show: Done", "Machine: Laser 2"])}>Put the chips back</Button> : null}
          </RemovableChips>
        </div>
      </Section>

      <Section id="s-v5-filters" title="v5: Filters popover" note="The composition the previews each built: a 'Filters (n)' button, a popover with a SegmentedControl and a ChipGroup, a quiet 'Clear filters' only while something is on, and the active filters as removable chips. Escape returns focus to the Filters button; removing a chip moves focus to the next chip (or the button); Clear filters returns focus to the button.">
        <div style={{ display: "grid", gap: 10, maxWidth: 640 }}>
          <FiltersPopover groups={groups} active={active} onClear={() => setFilters(FILTER_DEFAULT)} data-testid="v5-filters" />
          <p style={{ ...cap, margin: 0 }} data-testid="v5-filters-state">Filtering: show {SHOW_LABEL[filters.show]}, {filters.statuses.length ? filters.statuses.join(", ") : "any status"}.</p>
        </div>
      </Section>

      <Section id="s-v6" title="v6: no sideways scrolling (stacked table options, Select collapse, Tabs More)" note="Phone and tablet rule: nothing here scrolls sideways at 1024 px and under. These demos use the new options: primary and columnPriority on a ScrollTable (which cell is the title, which cells come first), actionsColumn, stackHide, a SegmentedControl that collapses to the shared Select under 640 px, Tabs that move into a More menu, and a long unbroken word.">
        <div style={{ display: "grid", gap: 18, minWidth: 0 }}>
          <ScrollTable label="Jobs with a chosen title and field order" primary={1} columnPriority={[3, 2]} stackHide={[4]} dense>
            <thead><tr><th scope="col">Job</th><th scope="col">Customer</th><th scope="col">Due</th><th scope="col">Status</th><th scope="col">Internal ref</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {ROWS.slice(0, 3).map((r) => (
                <tr key={r.id}><td>{r.id}</td><td>{r.customer}</td><td>{r.due}</td><td><StatusBadge tone={r.tone}>{r.status}</StatusBadge></td><td>REF-{r.id}</td><td><Button size="sm" variant="secondary" onClick={() => previewOnly(`${r.id} was not changed.`)}>Open</Button><Button size="sm" variant="quiet">Copy</Button></td></tr>
              ))}
            </tbody>
          </ScrollTable>
          <Cell label="collapseToSelect: segments above 640 px, the shared Select under it">
            <SegmentedControl collapseToSelect label="Period" value={segLong} onChange={setSegLong} data-testid="v6-seg-collapse" options={[{ value: "m3", label: "Last 3 months" }, { value: "m6", label: "Last 6 months" }, { value: "m12", label: "Last 12 months" }, { value: "all", label: "All time" }, { value: "custom", label: "Custom range" }]} />
          </Cell>
          <Cell label="Tabs with overflow=more (the tabs that do not fit go into More)">
            <div style={{ width: "100%", maxWidth: 360, minWidth: 0 }}>
              <Tabs overflow="more" label="Sections" value={tab6} onChange={setTab6} data-testid="v6-tabs-more" tabs={[{ value: "a", label: "Overview" }, { value: "b", label: "Schedule", count: 12 }, { value: "c", label: "Materials" }, { value: "d", label: "Documents" }, { value: "e", label: "History" }]} />
            </div>
          </Cell>
          <Cell label="A long unbroken word and number wrap instead of widening the page">
            <Panel title="Supercalifragilisticexpialidocious_customer_reference_000000000000000000000000000000">
              <p style={{ margin: 0 }}>Reference 12345678901234567890123456789012345678901234567890 and https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all/ever/and/ever</p>
            </Panel>
          </Cell>
        </div>
      </Section>

      <Section id="s-v5-name" title="v5: label in name helper" note="An aria-label that is longer than the drawn words must still START with them (label in name, axe 'label-content-name-mismatch'). nameWithVisible(visible, detail) builds it; nameContainsVisible checks it. For schedule bars, link tiles and 'Add customer, Hartley' buttons.">
        <div style={{ display: "grid", gap: 8 }}>
          {([["J-0437 Lathe 2", "due Friday, running"], ["Book it", "J-0437 on Lathe 2"], ["Open", "Open jobs: 19"]] as const).map(([v, d]) => (
            <div key={v} style={row} data-testid="v5-name-row">
              <Button size="sm" variant="secondary" aria-label={nameWithVisible(v, d)} data-testid="v5-name-btn">{v}</Button>
              <code style={{ fontSize: 13 }}>{nameWithVisible(v, d)}</code>
              <span style={cap}>{nameContainsVisible(nameWithVisible(v, d), v) ? "contains the drawn words" : "mismatch"}</span>
            </div>
          ))}
        </div>
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
