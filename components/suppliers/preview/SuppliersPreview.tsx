"use client";

/**
 * BOUNDARY (Suppliers, Module 5, PREVIEW ONLY). Inputs: none from the server. Everything shown is fictional sample data (10 suppliers, on reserved ".example"
 * addresses and Ofcom drama phone numbers) held in this file, plus the person's clicks. Outputs: a Suppliers list look-and-feel prototype (Export, Columns,
 * Cards / List / Table, Edit and Delete on every row, the real Add / Edit form with the admin-only status) whose only state is LOCAL UI state. It never
 * reads or writes Supabase, calls no server action, API route, e-mail, accounting or AI integration, and no action reports success: every action answers
 * with the neutral "Preview only ... Nothing was saved." toast and nothing changes (the real page's native delete confirmation becomes a sheet that asks the
 * same question and then answers the same way).
 * Run-time imports from lib/ are pure modules only (supplier-status, status-colours, dates, empty-hints, spreadsheet exportAllTitle). The real page checks the
 * form with two inline rules (a name is needed; an e-mail must contain "@"), not with a lib function, so they are mirrored here word for word and pinned to
 * app/(dashboard)/suppliers/page.tsx by tests/unit/suppliersPreview.test.ts.
 * MUST NOT CHANGE: wording, defaults, column order, form fields and the role gate mirror today's page (app/(dashboard)/suppliers/page.tsx: Admin and Office
 * only, Workshop and Viewer see "Access Denied"; only an admin changes a status, Office sees it read only; the Status column and field exist only when the
 * database has them). Do not wire this to real data or actions, add no control the real page lacks, keep row controls at a 48 px hit area. Delete the four
 * preview files (this component and its .module.css, app/(dashboard)/suppliers/preview/page.tsx, tests/unit/suppliersPreview.test.ts) to remove it completely.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import {
  Button, EmptyState, FailedState, Field, Input, LoadingState, Menu, Popover, ScrollTable, SegmentedControl, Select, Sheet, StatusBadge, Switch, Textarea,
  ToastProvider, cx, premiumTokens, useToast,
} from "@/components/ui/premium";
import type { MenuItem, StatusTone } from "@/components/ui/premium";
import { suppliersEmptyHint } from "@/lib/empty-hints";
import { DESK_QUERY, effectiveViewMode } from "@/lib/shell-status";
import { exportAllTitle } from "@/lib/spreadsheet";
import { STATUS_MAP } from "@/lib/status-colours";
import { canChangeSupplierStatus, isSupplierStatus, SUPPLIER_STATUS_BADGE, SUPPLIER_STATUS_LABELS, SUPPLIER_STATUSES, type SupplierStatus } from "@/lib/supplier-status";

import s from "./SuppliersPreview.module.css";

export type Role = "admin" | "office" | "workshop" | "viewer";
export type ViewMode = "cards" | "list" | "table";
export type Screen = "ready" | "loading" | "error" | "empty";
export type ColumnKey = "name" | "contact" | "email" | "phone" | "notes" | "status";

export const NAME_REQUIRED = "Enter a supplier name.";
export const EMAIL_INVALID = "Enter a valid email address.";
export const STATUS_HINT = "Conditional: a warning when a purchase order to it is issued. Blocked: purchase orders to it can't be issued.";
export const COLUMNS: Array<{ key: ColumnKey; label: string; locked?: boolean }> = [
  { key: "name", label: "Name", locked: true }, { key: "contact", label: "Contact" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "notes", label: "Notes" }, { key: "status", label: "Status" },
];

export type SeedSupplier = { id: string; name: string; email: string; contactName: string; phone: string; notes: string; supplierStatus?: SupplierStatus };
const P = (id: string, name: string, contactName: string, email: string, phone: string, notes: string, supplierStatus?: SupplierStatus): SeedSupplier => ({ id, name, contactName, email, phone, notes, supplierStatus });
export const SEED_SUPPLIERS: SeedSupplier[] = [
  P("s01", "Ironbridge Metals", "Alex Sample", "sales@ironbridge-metals.example", "01632 960201", "Bar and plate, 316 and duplex. 48 hour lead on stock sizes.", "approved"),
  P("s02", "Calder Bar & Tube", "Jamie Testfield", "orders@calder-bar-tube.example", "01632 960202", "Cut to length service. Mill certificates sent with every delivery.", "approved"),
  P("s03", "Fenwick Fasteners", "Morgan Placeholder", "trade@fenwick-fasteners.example", "01632 960203", "Marine grade A4 only.", "approved"),
  P("s04", "Harlow Tooling Supplies", "Sasha Dummerby", "accounts@harlow-tooling.example", "01632 960204", "Inserts, end mills, workholding. Account held on 30 days.", "approved"),
  P("s05", "Redfern Surface Treatments", "Robin Exampleton", "jobs@redfern-surface.example", "01632 960205", "Anodising and passivation. Last two batches late: check dates before promising customers.", "conditional"),
  P("s06", "Quayside Plastics", "", "sales@quayside-plastics.example", "", "", "approved"),
  P("s07", "Dunmore Castings & Forgings (Midlands) Limited", "Kit Mockridge", "enquiries@dunmore-castings.example", "01632 960207", "Failed incoming inspection twice in October. Not to be used until an admin reviews it.", "blocked"),
  P("s08", "Stanhope Heat Treatment", "Dana Testwell", "", "01632 960208", "Collect and return on Tuesdays and Fridays.", "conditional"),
  P("s09", "Pennant Gauge & Calibration", "Lee Placeholder", "lab@pennant-gauge.example", "01632 960209", "Calibration certificates traceable. Gauge hire available.", "approved"),
  P("s10", "Larkfield Packaging", "", "orders@larkfield-packaging.example", "01632 960210", "", "approved"),
];

/* ---------- pure logic ---------- */
export const canUseSuppliers = (r: Role) => r === "admin" || r === "office";
/** The real page: `canSetStatus = canChangeSupplierStatus(activeRole)` (admin only; the database refuses anyone else). */
export const canSetStatus = (r: Role) => canChangeSupplierStatus(r);
/** `statusAvailable`: the status is offered once the database has it, i.e. some supplier was read with one. */
export const statusAvailable = (list: readonly SeedSupplier[]) => list.some((x) => x.supplierStatus !== undefined);
/** Badge tone from the one status map (lib/status-colours): approved green, conditional yellow, blocked red. */
export const toneOf = (status: SupplierStatus): StatusTone => { const c = STATUS_MAP[SUPPLIER_STATUS_BADGE[status]].colour; return c === "green" ? "ok" : c === "yellow" ? "warn" : c === "red" ? "danger" : "neutral"; };
/** The form's status field: an admin gets the select for an existing status (or on a new supplier once the database has it); anyone else sees it read only. */
export function statusField(role: Role, editing: { id?: string; supplierStatus?: SupplierStatus }, available: boolean): "select" | "readonly" | "none" {
  if (canSetStatus(role) && (editing.supplierStatus !== undefined || (!editing.id && available))) return "select";
  if (!canSetStatus(role) && editing.supplierStatus !== undefined) return "readonly";
  return "none";
}
export const withoutStatus = (x: SeedSupplier): SeedSupplier => { const { supplierStatus: _s, ...rest } = x; void _s; return { ...rest } as SeedSupplier; };

export type SupplierValues = { name: string; contactName: string; email: string; phone: string; notes: string; supplierStatus?: SupplierStatus };
export type SupplierErrors = Partial<Record<"name" | "email", string>>;
/** The page's submit(): a name is needed; an e-mail, when given, must contain "@". Both are mirrored word for word (the page shows only the first, in a toast). */
export function validateSupplier(v: Pick<SupplierValues, "name" | "email">): SupplierErrors {
  const errors: SupplierErrors = {};
  const name = v.name.trim();
  const email = v.email.trim();
  if (!name) errors.name = NAME_REQUIRED;
  if (email && !email.includes("@")) errors.email = EMAIL_INVALID;
  return errors;
}

/* ---------- local pieces ---------- */
const VIEW_KEY = "suppliers-preview:view";
const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen; label: string }> = [{ v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No suppliers yet" }];
function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore((cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => window.matchMedia(query).matches, () => fallback);
}
const dash = <span className={s.none} aria-label="None">-</span>;
const mail = (email: string) => { const at = email.indexOf("@"); return at < 0 ? email : <>{email.slice(0, at + 1)}<wbr />{email.slice(at + 1)}</>; };
const Pill = ({ status }: { status: SupplierStatus }) => <span data-testid="supplier-status"><StatusBadge tone={toneOf(status)} plain={status === "approved"}>{SUPPLIER_STATUS_LABELS[status]}</StatusBadge></span>;

type Dlg = { k: "edit"; id?: string; values: SupplierValues } | { k: "delete"; id: string };

export default function SuppliersPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [view, setViewState] = useState<ViewMode>("table");
  const [hidden, setHidden] = useState<ColumnKey[]>([]);
  const [hasStatus, setHasStatus] = useState(true);
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  const [timer, setTimer] = useState<number | null>(null);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); }, [toast]);
  const wide = useMedia(DESK_QUERY, true);
  const notPhone = useMedia("(min-width: 768px)", true);
  useEffect(() => { try { const v = window.localStorage.getItem(VIEW_KEY); if (v === "cards" || v === "list" || v === "table") setViewState(v); } catch { /* defaults */ } }, []);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);
  const setView = (v: ViewMode) => { setViewState(v); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const shownView: ViewMode = effectiveViewMode(view, wide);
  const loaded = screen === "ready";
  const data = useMemo(() => (loaded ? SEED_SUPPLIERS.map((x) => (hasStatus ? x : withoutStatus(x))) : []), [loaded, hasStatus]);
  const showStatus = statusAvailable(data);
  const inView = (c: ColumnKey) => !hidden.includes(c) && (c !== "status" || showStatus);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseSuppliers(role);
  const retry = () => { setScreen("loading"); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample suppliers shown again. No server was contacted." }); }, 700)); };
  const resetAll = () => { setScreen("ready"); setHidden([]); setHasStatus(true); setDlg(null); toast.clear(); };
  const edit = (x: SeedSupplier) => setDlg({ k: "edit", id: x.id, values: { name: x.name, contactName: x.contactName, email: x.email, phone: x.phone, notes: x.notes, ...(x.supplierStatus ? { supplierStatus: x.supplierStatus } : {}) } });
  const add = () => setDlg({ k: "edit", values: { name: "", contactName: "", email: "", phone: "", notes: "" } });
  const target = dlg?.k === "delete" ? SEED_SUPPLIERS.find((x) => x.id === dlg.id) ?? null : null;
  /** The real menu's hover text ("Exports all N suppliers", lib/spreadsheet exportAllTitle) is shown as the item's own second half. */
  const scope = exportAllTitle("supplier", data.length).replace(/^Exports /, "");
  const exportItems: MenuItem[] = [
    { id: "csv", label: `CSV, ${scope}`, onSelect: () => preview(`A CSV of ${data.length} supplier${data.length === 1 ? "" : "s"} would download. No file was made.`) },
    { id: "xlsx", label: `Excel, ${scope}`, onSelect: () => preview(`An Excel file of ${data.length} supplier${data.length === 1 ? "" : "s"} would download. No file was made.`) },
  ];

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="suppliers-preview" data-role={role} data-pview={shownView}>
      <header className={s.head}>
        <div className={s.titleBlock}>
          <div className={s.titleLine}>
            <h1 className={s.title}>Suppliers</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
            <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
              <div className={s.dock}>
                <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated and no request is made.</p>
                <p className={s.dockLabel}>Role</p>
                <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
                <p className={s.dockLabel}>Screen state</p>
                <div className={s.dockStates} role="group" aria-label="Screen state">
                  {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => { toast.clear(); setDlgState(null); setScreen(x.v); }}>{x.label}</button>)}
                </div>
                <Switch label="Supplier status" hint="On when the database has it (migration 082)." checked={hasStatus} onChange={(on) => { setHasStatus(on); setDlgState(null); }} data-testid="dock-features" />
                <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
              </div>
            </Popover>
          </div>
          <p className={s.subtitle}>The companies we buy from. Used on purchase orders.</p>
        </div>
        {denied ? null : <div className={s.headControls}><Button variant="primary" data-testid="new-supplier" onClick={add}>New supplier</Button></div>}
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <h2 className={s.deniedTitle}>Access Denied</h2><p className={s.deniedText}>Redirecting you back to the dashboard.</p>
          <p className={s.deniedNote}>Preview only: no redirect happens here. Suppliers are for Admin and Office; Workshop and Viewer cannot open them.</p>
        </section>
      ) : (
        <>
          <section className={s.panel} aria-label="Export, columns and view" aria-busy={screen === "loading" || undefined}>
            <div className={s.panelRow}>
              <Menu label="Export" size="sm" variant="secondary" items={exportItems} data-testid="export-trigger" />
            </div>
            <div className={cx(s.panelRow, s.viewRow)}>
              <Popover label="Columns" title="Suppliers columns" size="sm" variant="secondary" data-testid="columns-trigger">
                <p className={s.colScope}>Changes apply to everyone in this company. In this preview they change this screen only.</p>
                {COLUMNS.filter((c) => c.key !== "status" || showStatus || !loaded).map((c) => (c.locked ? <p key={c.key} className={s.colLocked} data-testid={`col-${c.key}`}><span>{c.label}</span><span>Always shown</span></p>
                  : <Switch key={c.key} label={c.label} checked={!hidden.includes(c.key)} onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== c.key) : [...h, c.key]))} data-testid={`col-${c.key}`} />))}
                <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHidden([])}>Reset to default (show all columns)</Button></div>
              </Popover>
              {notPhone ? <SegmentedControl label="View" value={shownView} onChange={setView} size="sm" options={[
                { value: "cards", label: "Cards", testId: "view-cards-btn" }, { value: "list", label: "List", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-list-btn" }, { value: "table", label: "Table", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-table-btn" }]} /> : null}
            </div>
          </section>

          <p className={s.srOnly} role="status">{loaded ? `${data.length} ${data.length === 1 ? "supplier" : "suppliers"} shown` : ""}</p>
          <h2 className={s.srOnly}>Supplier list</h2>
          {screen === "loading" ? <LoadingState label="Loading suppliers" rows={6} />
            : screen === "error" ? <FailedState title="Couldn’t load suppliers." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" />
            : data.length === 0 ? <EmptyState title="No suppliers yet" detail={suppliersEmptyHint()} action={<Button variant="primary" onClick={add}>New supplier</Button>} />
            : shownView === "cards" ? (
              <div className={s.cards} data-testid="view-cards">
                {data.map((x) => (
                  <article key={x.id} className={s.card} data-supplier={x.name} aria-label={x.name}>
                    <div className={s.cardHead}><h3 className={s.cardName}>{x.name}</h3>{inView("status") && x.supplierStatus ? <Pill status={x.supplierStatus} /> : null}</div>
                    <dl className={s.dl}>
                      {inView("contact") ? <div><dt>Contact</dt><dd>{x.contactName || dash}</dd></div> : null}
                      {inView("phone") ? <div><dt>Phone</dt><dd className={s.nums}>{x.phone || dash}</dd></div> : null}
                      {inView("email") ? <div className={s.dlWide}><dt>Email</dt><dd>{x.email ? mail(x.email) : dash}</dd></div> : null}
                      {inView("notes") ? <div className={s.dlWide}><dt>Notes</dt><dd>{x.notes || dash}</dd></div> : null}
                    </dl>
                    <div className={s.cardActions}><Actions x={x} edit={edit} del={(id) => setDlg({ k: "delete", id })} /></div>
                  </article>
                ))}
              </div>
            ) : (
              <ScrollTable label="Suppliers" className={shownView === "list" ? s.dense : undefined}>
                <thead><tr>
                  <th className={s.thFirst}>Name</th>
                  {inView("contact") ? <th>Contact</th> : null}{inView("email") ? <th>Email</th> : null}{inView("phone") ? <th>Phone</th> : null}{inView("notes") ? <th>Notes</th> : null}{inView("status") ? <th>Status</th> : null}<th className={s.right}>Actions</th>
                </tr></thead>
                <tbody>{data.map((x) => (
                  <tr key={x.id} data-supplier={x.name}>
                    <td className={s.tdFirst}><span className={s.name}>{x.name}</span></td>
                    {inView("contact") ? <td className={s.contactCell}>{x.contactName || dash}</td> : null}
                    {inView("email") ? <td className={s.emailCell}>{x.email ? mail(x.email) : dash}</td> : null}
                    {inView("phone") ? <td className={cx(s.nowrap, s.nums)}>{x.phone || dash}</td> : null}
                    {inView("notes") ? <td>{x.notes ? <span className={s.clamp} title={x.notes}>{x.notes}</span> : dash}</td> : null}
                    {inView("status") ? <td>{x.supplierStatus ? <Pill status={x.supplierStatus} /> : dash}</td> : null}
                    <td className={s.right}><div className={s.rowActions}><Actions x={x} edit={edit} del={(id) => setDlg({ k: "delete", id })} /></div></td>
                  </tr>))}
                </tbody>
              </ScrollTable>
            )}
        </>
      )}

      {dlg?.k === "edit" && !denied ? <SupplierSheet key={dlg.id ?? "new"} dlg={dlg} role={role} available={showStatus} onClose={() => setDlg(null)} preview={preview} /> : null}
      <Sheet open={Boolean(target) && !denied} size="sm" title={target ? `Delete supplier "${target.name}"?` : ""} description="This can't be undone." onClose={() => setDlg(null)} testId="dlg-delete" closeButton={false}
        footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button variant="secondary" className={s.danger} data-testid="confirm-delete" onClick={() => { const n = target?.name; setDlg(null); preview(`${n} would be deleted.`); }}>Delete supplier</Button></>}>
        <p className={s.sheetNote}>Preview only. Nothing is deleted.</p>
      </Sheet>
    </div>
  );
}

function Actions({ x, edit, del }: { x: SeedSupplier; edit: (x: SeedSupplier) => void; del: (id: string) => void }) {
  return (
    <>
      <Button size="sm" variant="secondary" data-action="Edit" aria-label={`Edit ${x.name}`} onClick={() => edit(x)}>Edit</Button>
      <Button size="sm" variant="quiet" className={s.dangerQuiet} data-action="Delete" aria-label={`Delete ${x.name}`} onClick={() => del(x.id)}>Delete</Button>
    </>
  );
}

/** The Add / Edit form: the real fields in the real order, grouped; checks run on Save and then live, each beside its field. */
function SupplierSheet({ dlg, role, available, onClose, preview }: { dlg: Extract<Dlg, { k: "edit" }>; role: Role; available: boolean; onClose: () => void; preview: (d: string) => void }) {
  const [v, setV] = useState<SupplierValues>(dlg.values);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // First focus goes to the name (a scrolling body would otherwise take it), so typing can start at once.
  useEffect(() => { form.current?.querySelector<HTMLElement>('input[name="name"]')?.focus(); }, []);
  const errors = useMemo(() => validateSupplier(v), [v]);
  const shown = (k: keyof SupplierErrors) => (submitted || touched[k] ? errors[k] : undefined);
  const set = <K extends keyof SupplierValues>(k: K, value: SupplierValues[K]) => setV((p) => ({ ...p, [k]: value }));
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));
  const failing = (Object.keys(errors) as Array<keyof SupplierErrors>).filter((k) => submitted && errors[k]);
  const LABEL: Record<string, string> = { name: "Supplier name", email: "Email" };
  const existing = Boolean(dlg.id);
  const field = statusField(role, { id: dlg.id, supplierStatus: dlg.values.supplierStatus }, available);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(validateSupplier(v)).length) { requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    onClose();
    preview(`${v.name.trim()} would be ${existing ? "updated" : "added as a supplier"}.`);
  };
  return (
    <Sheet open size="md" title={existing ? "Edit supplier" : "Add supplier"} description="Supplier contact details." onClose={onClose} testId="dlg-supplier" closeButton={false}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="supplier-form" data-testid="save-supplier">Save Supplier</Button></>}>
      <form id="supplier-form" ref={form} onSubmit={submit} noValidate className={s.form} aria-label={existing ? "Edit supplier" : "Add supplier"}>
        {failing.length ? <p className={s.summary} role="alert" data-testid="form-summary">{failing.length === 1 ? "1 field needs attention" : `${failing.length} fields need attention`}: {failing.map((k) => LABEL[k]).join(", ")}.</p> : null}
        <div role="group" aria-labelledby="g-supplier" className={s.group}>
          <h3 id="g-supplier" className={s.legend}>Supplier</h3>
          <Field label="Supplier name" required error={shown("name")}><Input name="name" autoComplete="off" value={v.name} onChange={(e) => set("name", e.target.value)} onBlur={blur("name")} /></Field>
          <Field label="Contact name" optional><Input name="contact_name" autoComplete="off" value={v.contactName} onChange={(e) => set("contactName", e.target.value)} /></Field>
        </div>
        <div role="group" aria-labelledby="g-contact-details" className={s.group}>
          <h3 id="g-contact-details" className={s.legend}>Contact details</h3>
          <div className={s.pair}>
            <Field label="Email" optional error={shown("email")}><Input name="email" type="email" value={v.email} onChange={(e) => set("email", e.target.value)} onBlur={blur("email")} /></Field>
            <Field label="Phone" optional><Input name="phone" type="tel" inputMode="tel" autoComplete="tel" value={v.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
          </div>
        </div>
        <div role="group" aria-labelledby="g-notes" className={s.group}>
          <h3 id="g-notes" className={s.legend}>Notes</h3>
          <Field label="Notes" optional><Textarea name="notes" rows={3} value={v.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        </div>
        {field === "select" ? (
          <div role="group" aria-labelledby="g-approval" className={s.group}>
          <h3 id="g-approval" className={s.legend}>Approval</h3>
            <Field label="Status" hint={STATUS_HINT}>
              <Select name="supplier_status" value={v.supplierStatus ?? "approved"} onChange={(e) => { if (isSupplierStatus(e.target.value)) set("supplierStatus", e.target.value); }}>
                {SUPPLIER_STATUSES.map((st) => <option key={st} value={st}>{SUPPLIER_STATUS_LABELS[st]}</option>)}
              </Select>
            </Field>
          </div>
        ) : null}
        {field === "readonly" && dlg.values.supplierStatus ? (
          <div role="group" aria-labelledby="g-approval" className={s.group}>
          <h3 id="g-approval" className={s.legend}>Approval</h3>
            <p className={s.readOnly} data-testid="supplier-status-read-only"><span className={s.readOnlyLabel}>Status</span><Pill status={dlg.values.supplierStatus} /><span className={s.hint}>Only an admin changes it.</span></p>
          </div>
        ) : null}
      </form>
      <p className={s.sheetNote}>Preview only. Nothing is read from or saved to your account.</p>
    </Sheet>
  );
}
