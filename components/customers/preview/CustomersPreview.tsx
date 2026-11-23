"use client";

/**
 * BOUNDARY (Customers, Module 5, PREVIEW ONLY). Inputs: none from the server. Everything shown is fictional sample data (14 customer names, as of 20/11/2026,
 * on reserved ".example" addresses and Ofcom drama phone numbers) held in this file, plus the person's clicks. Outputs: a Customers list look-and-feel
 * prototype (Show Active / Archived / All, Export, Columns, Cards / List / Table, row actions, the real Add / Edit form with delivery notes and the chase
 * pause) whose only state is LOCAL UI state. It never reads or writes Supabase, calls no server action, API route, e-mail, statement, accounting or AI
 * integration, and no action reports success: every action answers with the neutral "Preview only ... Nothing was saved." toast and nothing changes.
 * Run-time imports from lib/ are pure modules only (validation/schemas customerSchema, dates, money, empty-hints, spreadsheet exportAllTitle,
 * status-colours, email/chase/steps pauseActive). The form's checks are the REAL ones: customerSchema through the same call saveCustomer makes, plus the
 * page's own "Enter a customer name." rule. The chase-pause form's three checks live inline in components/chase/chase-pause.tsx and are mirrored here,
 * pinned to that source by tests/unit/customersPreview.test.ts.
 * MUST NOT CHANGE: wording, defaults, column order, form fields and the role gate mirror today's page (app/(dashboard)/customers/page.tsx: Admin and Office
 * only, Workshop and Viewer see "Access Denied"; Archive is admin and office; Mobile and Traceable only when the database has them). Do not wire this to
 * real data or actions, add no control the real page lacks, keep row controls at a 48 px hit area. Delete the four preview files (this component and its
 * .module.css, app/(dashboard)/customers/preview/page.tsx, tests/unit/customersPreview.test.ts) to remove it completely.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import {
  Button, Checkbox, EmptyState, FailedState, Field, Input, LoadingState, Menu, Popover, ScrollTable, SegmentedControl, Sheet, StatusBadge, Switch, Textarea,
  ToastProvider, cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import type { MenuItem, StatusTone } from "@/components/ui/premium";
import { fmtDate } from "@/lib/dates";
import { customersEmptyHint } from "@/lib/empty-hints";
import { pauseActive } from "@/lib/email/chase/steps";
import { gbp } from "@/lib/money";
import { DESK_QUERY, effectiveViewMode } from "@/lib/shell-status";
import { exportAllTitle } from "@/lib/spreadsheet";
import { deliveryNoteStatusKey } from "@/lib/status-colours";
import { customerSchema } from "@/lib/validation/schemas";

import s from "./CustomersPreview.module.css";

export type Role = "admin" | "office" | "workshop" | "viewer";
export type ViewMode = "cards" | "list" | "table";
export type PhaseValue = "open" | "archived" | "all";
export type Phase = "open" | "archived";
export type Screen = "ready" | "loading" | "error" | "empty" | "truncated" | "link" | "link-missing";
export type ColumnKey = "name" | "contact" | "email" | "phone" | "address";

/** The sample's "today": the chase-pause rules are worked out against it. */
export const TODAY = "2026-11-20";
export const NOT_SAVED_LABEL = "Not saved as a customer yet";
export const DOCUMENT_NAMES_TRUNCATED = "Only part of the names found on RFQs, quotes, sales orders and invoices could be listed: some may be missing here.";
export const NAME_REQUIRED = "Enter a customer name.";
export const COLUMNS: Array<{ key: ColumnKey; label: string; locked?: boolean }> = [
  { key: "name", label: "Name", locked: true }, { key: "contact", label: "Contact" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "address", label: "Address" },
];

export type SeedNote = { ref: string; status: string; date: string };
export type SeedCustomer = {
  id?: string; name: string; contactName: string; email: string; phone: string; address: string; notes: string;
  /** Migration 073: undefined means the database does not have it, so the form never offers it. */
  mobile?: string;
  /** Migration 082: undefined means the database does not have it. */
  traceableDefault?: boolean;
  notSaved?: true; manual?: "archived"; credit?: number; pause?: { reason: string; until: string | null }; deliveryNotes?: SeedNote[];
};
const C = (id: string, name: string, contactName: string, email: string, phone: string, address: string, extra: Partial<SeedCustomer> = {}): SeedCustomer => ({ id, name, contactName, email, phone, address, notes: "", mobile: "", traceableDefault: false, ...extra });
export const SEED_CUSTOMERS: SeedCustomer[] = [
  C("c01", "Marlow Hydraulics", "Alex Sample", "purchasing@marlow-hydraulics.example", "01632 960101", "Unit 4, Foundry Yard\nSampleford\nSF1 2AB", { mobile: "07700 900101", traceableDefault: true, notes: "Prefers delivery notes by e-mail.", deliveryNotes: [{ ref: "DLN-0212", status: "despatched", date: "2026-11-19" }, { ref: "DLN-0188", status: "signed", date: "2026-10-02" }] }),
  C("c02", "Tern Marine Engineering", "Jamie Testfield", "orders@tern-marine.example", "01632 960102", "Quay House, Harbour Road\nExampleton\nEX2 4TM", { credit: 1250, deliveryNotes: [{ ref: "DLN-0211", status: "despatched", date: "2026-11-16" }] }),
  C("c03", "Coldharbour Automation", "Morgan Placeholder", "buyer@coldharbour.example", "01632 960103", "Plot 12, Mockridge Park\nDummerby\nDB3 7QR", { mobile: "07700 900103", deliveryNotes: [{ ref: "DLN-0213", status: "awaiting", date: "2026-11-20" }] }),
  C("c04", "Ashby Rail Services", "Sasha Dummerby", "supply@ashby-rail.example", "01632 960104", "Depot Lane\nTestford\nTF4 1XX", { pause: { reason: "Query on delivery DLN-0206", until: "2026-12-04" }, deliveryNotes: [{ ref: "DLN-0206", status: "signed", date: "2026-11-16" }] }),
  C("c05", "Kestrel Components", "", "procurement@kestrel.example", "", "", { deliveryNotes: [{ ref: "DLN-0209", status: "delivered", date: "2026-11-18" }] }),
  C("c06", "Pemberton Packaging", "Robin Exampleton", "", "01632 960106", "Mill Road\nSampleford\nSF2 9LP", { mobile: "07700 900106" }),
  C("c07", "Halden Precision", "Kit Mockridge", "accounts@halden-precision.example", "01632 960107", "Unit 9, Precision Court\nTestford\nTF1 3BN", { deliveryNotes: [{ ref: "DLN-0208", status: "awaiting", date: "2026-11-18" }] }),
  C("c08", "Wren & Calder", "Dana Testwell", "projects@wren-calder.example", "01632 960108", "Calder House, Bridge Street\nExampleton\nEX1 8HG", { credit: 340.5, pause: { reason: "Awaiting remittance advice", until: null }, traceableDefault: true }),
  C("c09", "Brightwell Valves", "Lee Placeholder", "buying@brightwell.example", "01632 960109", "Valve Works, Station Approach\nDummerby\nDB1 2ZZ", { deliveryNotes: [{ ref: "DLN-0205", status: "delivered", date: "2026-11-06" }] }),
  C("c10", "Northgate Fabrication & Structural Engineering (Holdings) Limited", "Pat Sample-Testfield", "orders@northgate-fab.example", "01632 960110", "Northgate Works, Unit 21, Long Row Industrial Estate, Off Mockridge Bypass\nTestford\nTF9 6RT", { mobile: "07700 900110", notes: "Two delivery addresses: ask which one before despatch.", deliveryNotes: [{ ref: "DLN-0207", status: "signed", date: "2026-11-12" }, { ref: "DLN-0198", status: "signed", date: "2026-11-09" }] }),
  C("c11", "Old Mill Castings", "Sam Dummerby", "office@oldmill-castings.example", "01632 960111", "The Old Mill\nSampleford\nSF3 5DD", { manual: "archived" }),
  C("c12", "Dunmore Gearworks", "", "", "01632 960112", "", { manual: "archived" }),
  { name: "Riverside Fabrications", contactName: "", email: "", phone: "", address: "", notes: "", notSaved: true },
  { name: "Cobalt Tooling Ltd", contactName: "", email: "", phone: "", address: "", notes: "", notSaved: true },
];

/* ---------- pure logic ---------- */
/** The page's phaseFor: a record is archived only when it has an id AND was archived by hand (customers have no age rule and no Done). */
export const phaseFor = (c: Pick<SeedCustomer, "id" | "manual">): Phase => (c.id && c.manual === "archived" ? "archived" : "open");
export const visibleCustomers = (list: readonly SeedCustomer[], phase: PhaseValue): SeedCustomer[] => list.filter((c) => phase === "all" || phaseFor(c) === phase);
/** The page's phaseCounts: open is everything that is not archived (names found only on documents count as open). */
export const phaseCounts = (list: readonly SeedCustomer[]): { open: number; archived: number } => {
  const archived = list.filter((c) => phaseFor(c) === "archived").length;
  return { open: list.length - archived, archived };
};
/** An export holds saved customers only (names found only on documents are listed but never exported). */
export const exportable = (list: readonly SeedCustomer[]): SeedCustomer[] => list.filter((c) => !c.notSaved);
export const canUseCustomers = (r: Role) => r === "admin" || r === "office";
/** useArchive canManage. */
export const canManageArchive = (r: Role) => r === "admin" || r === "office";
export const chasePaused = (c: Pick<SeedCustomer, "pause">, today: string = TODAY) => Boolean(c.pause) && pauseActive(c.pause?.until, today);
export const toneOf = (status: string): StatusTone => { const k = deliveryNoteStatusKey(status); return k === "sent" ? "info" : k === "delivered" ? "ok" : "neutral"; };
/** Optional database fields off: the sample is read as a database without migrations 073 and 082 would return it. */
export const withFeatures = (c: SeedCustomer, on: boolean): SeedCustomer => { if (on) return c; const { mobile: _m, traceableDefault: _t, ...rest } = c; void _m; void _t; return rest; };

export type CustomerValues = { name: string; contactName: string; email: string; phone: string; mobile?: string; address: string; notes: string; traceableDefault?: boolean };
export type CustomerErrors = Partial<Record<"name" | "email" | "phone" | "mobile", string>>;
/**
 * The form's checks: the page's own empty-name rule, then the call saveCustomer makes (customerSchema on the trimmed name, trimmed email, phone, mobile).
 * The real page shows only the first message in a toast; the preview shows each one beside its field.
 */
export function validateCustomer(v: CustomerValues): CustomerErrors {
  const errors: CustomerErrors = {};
  const name = v.name.trim();
  const parsed = customerSchema.safeParse({ name, email: v.email.trim(), phone: v.phone, mobile: v.mobile });
  if (!parsed.success) for (const issue of parsed.error.issues) { const key = issue.path[0]; if ((key === "name" || key === "email" || key === "phone" || key === "mobile") && !errors[key]) errors[key] = issue.message; }
  if (!name) errors.name = NAME_REQUIRED;
  return errors;
}
export const draftFor = (name: string, features: boolean): CustomerValues => ({ name, contactName: "", email: "", phone: "", address: "", notes: "", ...(features ? { mobile: "", traceableDefault: false } : {}) });

export type PauseValues = { reason: string; until: string };
export type PauseErrors = Partial<Record<"reason" | "until", string>>;
/** components/chase/chase-pause.tsx save(): the same three checks, in the same order and words (mirrored; pinned to that source by the test). */
export function validatePause(v: PauseValues, today: string = TODAY): PauseErrors {
  const text = v.reason.trim();
  if (!text) return { reason: "Enter a reason for pausing." };
  if (text.length > 300) return { reason: "The reason can be up to 300 characters." };
  if (v.until && v.until < today) return { until: "The last day can't be in the past." };
  return {};
}

/* ---------- local pieces ---------- */
const VIEW_KEY = "customers-preview:view";
const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen; label: string }> = [
  { v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No customers yet" },
  { v: "truncated", label: "Some document names missing" }, { v: "link", label: "Search link opens a customer" }, { v: "link-missing", label: "Search link: customer gone" },
];
function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore((cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => window.matchMedia(query).matches, () => fallback);
}
const dash = <span className={s.none} aria-label="None">-</span>;
const lines = (address: string) => address.split(/\r?\n/).filter(Boolean).join(", ");
/** An address may break after its "@" (never in the middle of a word). */
const mail = (email: string) => { const at = email.indexOf("@"); return at < 0 ? email : <>{email.slice(0, at + 1)}<wbr />{email.slice(at + 1)}</>; };

type Editing = { id?: string; values: CustomerValues; source?: SeedCustomer };

export default function CustomersPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [view, setViewState] = useState<ViewMode>("table");
  const [phase, setPhase] = useState<PhaseValue>("open");
  const [hidden, setHidden] = useState<ColumnKey[]>([]);
  const [features, setFeatures] = useState(true);
  const [editing, setEditingState] = useState<Editing | null>(null);
  const [timer, setTimer] = useState<number | null>(null);
  const setEditing = useCallback((e: Editing | null) => { setEditingState(e); if (e) toast.clear(); }, [toast]);
  const wide = useMedia(DESK_QUERY, true);
  const notPhone = useMedia("(min-width: 768px)", true);
  useEffect(() => { try { const v = window.localStorage.getItem(VIEW_KEY); if (v === "cards" || v === "list" || v === "table") setViewState(v); } catch { /* defaults */ } }, []);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);
  const setView = (v: ViewMode) => { setViewState(v); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const shownView: ViewMode = effectiveViewMode(view, wide);
  const loaded = screen !== "loading" && screen !== "error" && screen !== "empty";
  const data = useMemo(() => (loaded ? SEED_CUSTOMERS.map((c) => withFeatures(c, features)) : []), [loaded, features]);
  const visible = useMemo(() => visibleCustomers(data, phase), [data, phase]);
  const counts = useMemo(() => phaseCounts(data), [data]);
  const saved = useMemo(() => exportable(data), [data]);
  const inView = (c: ColumnKey) => !hidden.includes(c);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseCustomers(role);
  const mayArchive = canManageArchive(role);
  const retry = () => { setScreen("loading"); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample customers shown again. No server was contacted." }); }, 700)); };
  const resetAll = () => { setScreen("ready"); setPhase("open"); setHidden([]); setFeatures(true); setEditing(null); toast.clear(); };
  const pickScreen = (v: Screen) => {
    toast.clear(); setEditingState(null); setScreen(v);
    if (v === "link") { const c = withFeatures(SEED_CUSTOMERS[4], features); setEditingState({ id: c.id, values: valuesOf(c), source: c }); }
    if (v === "link-missing") toast.show({ title: "That customer isn't in your list any more." });
  };
  const open = (c: SeedCustomer) => setEditing({ id: c.id, values: valuesOf(c), source: c });
  const add = (name: string) => setEditing({ values: draftFor(name, features) });
  const archive = (c: SeedCustomer) => preview(`${c.name} would be ${phaseFor(c) === "archived" ? "moved out of the archive" : "archived"}.`);
  /** The real menu's hover text ("Exports all N customers", lib/spreadsheet exportAllTitle) is shown as the item's own second half. */
  const scope = exportAllTitle("customer", saved.length).replace(/^Exports /, "");
  const exportItems: MenuItem[] = [
    { id: "csv", label: `CSV, ${scope}`, onSelect: () => preview(`A CSV of ${saved.length} customer${saved.length === 1 ? "" : "s"} would download. No file was made.`) },
    { id: "xlsx", label: `Excel, ${scope}`, onSelect: () => preview(`An Excel file of ${saved.length} customer${saved.length === 1 ? "" : "s"} would download. No file was made.`) },
  ];

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="customers-preview" data-role={role} data-pview={shownView}>
      <header className={s.head}>
        <div className={s.titleBlock}>
          <div className={s.titleLine}>
            <h1 className={s.title}>Customers</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
            <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
              <div className={s.dock}>
                <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated and no request is made.</p>
                <p className={s.dockLabel}>Role</p>
                <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
                <p className={s.dockLabel}>Screen state</p>
                <div className={s.dockStates} role="group" aria-label="Screen state">
                  {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => pickScreen(x.v)}>{x.label}</button>)}
                </div>
                <Switch label="Mobile and Traceable" hint="On when the database has them (migrations 073 and 082)." checked={features} onChange={(on) => { setFeatures(on); setEditingState(null); }} data-testid="dock-features" />
                <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
              </div>
            </Popover>
          </div>
          <p className={s.subtitle}>The companies we sell to. Used on quotes, sales orders and invoices.</p>
        </div>
        {denied ? null : <div className={s.headControls}><Button variant="primary" data-testid="new-customer" onClick={() => add("")}>New customer</Button></div>}
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <h2 className={s.deniedTitle}>Access Denied</h2><p className={s.deniedText}>Redirecting you back to the dashboard.</p>
          <p className={s.deniedNote}>Preview only: no redirect happens here. Customers are for Admin and Office; Workshop and Viewer cannot open them.</p>
        </section>
      ) : (
        <>
          <section className={s.panel} aria-label="Show, export and view" aria-busy={screen === "loading" || undefined}>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>Show</span>
              <SegmentedControl label="Show" value={phase} size="sm" disabled={screen === "loading"} onChange={setPhase} options={[
                { value: "open", label: `Active (${counts.open})`, testId: "show-open" }, { value: "archived", label: `Archived (${counts.archived})`, testId: "show-archived" }, { value: "all", label: "All", testId: "show-all" }]} />
            </div>
            <div className={cx(s.panelRow, s.viewRow)}>
              <Menu label="Export" size="sm" variant="secondary" items={exportItems} data-testid="export-trigger" />
              <Popover label="Columns" title="Customers columns" size="sm" variant="secondary" data-testid="columns-trigger">
                <p className={s.colScope}>Changes apply to everyone in this company. In this preview they change this screen only.</p>
                {COLUMNS.map((c) => (c.locked ? <p key={c.key} className={s.colLocked} data-testid={`col-${c.key}`}><span>{c.label}</span><span>Always shown</span></p>
                  : <Switch key={c.key} label={c.label} checked={inView(c.key)} onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== c.key) : [...h, c.key]))} data-testid={`col-${c.key}`} />))}
                <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHidden([])}>Reset to default (show all columns)</Button></div>
              </Popover>
              {notPhone ? <SegmentedControl label="View" value={shownView} onChange={setView} size="sm" options={[
                { value: "cards", label: "Cards", testId: "view-cards-btn" }, { value: "list", label: "List", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-list-btn" }, { value: "table", label: "Table", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-table-btn" }]} /> : null}
            </div>
          </section>

          {screen === "truncated" ? <p className={s.truncated} role="status" data-testid="customer-names-truncated">{DOCUMENT_NAMES_TRUNCATED}</p> : null}
          <p className={s.srOnly} role="status">{loaded ? `${visible.length} ${visible.length === 1 ? "customer" : "customers"} shown` : ""}</p>
          <h2 className={s.srOnly}>Customer list</h2>
          {screen === "loading" ? <LoadingState label="Loading customers" rows={6} />
            : screen === "error" ? <FailedState title="Couldn’t load customers." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" />
            : data.length === 0 ? <EmptyState title="No customers yet" detail={customersEmptyHint()} action={<Button variant="primary" onClick={() => add("")}>New customer</Button>} />
            : visible.length === 0 ? (
              <EmptyState title={phase === "archived" ? "No archived customers." : "Every customer is archived: see Show > Archived."} action={phase === "archived" ? <Button variant="secondary" onClick={() => setPhase("open")}>Show active</Button> : <Button variant="secondary" onClick={() => setPhase("archived")}>Show archived</Button>} />
            ) : shownView === "cards" ? (
              <div className={s.cards} data-testid="view-cards">
                {visible.map((c) => (
                  <article key={c.id ?? c.name} className={s.card} data-customer={c.name} aria-label={c.name}>
                    <div className={s.cardHead}><h3 className={s.cardName}>{c.name}</h3><NameNotes c={c} /></div>
                    <dl className={s.dl}>
                      {inView("contact") ? <div><dt>Contact</dt><dd>{c.contactName || dash}</dd></div> : null}
                      {inView("phone") ? <div><dt>Phone</dt><dd className={tabularNumbers}>{c.phone || dash}{c.mobile ? <span className={s.cellNote}>Mobile {c.mobile}</span> : null}</dd></div> : null}
                      {inView("email") ? <div className={s.dlWide}><dt>Email</dt><dd>{c.email ? mail(c.email) : dash}</dd></div> : null}
                      {inView("address") ? <div className={s.dlWide}><dt>Address</dt><dd>{c.address ? lines(c.address) : dash}</dd></div> : null}
                    </dl>
                    <div className={s.cardActions}><Actions c={c} mayArchive={mayArchive} open={open} add={add} preview={preview} archive={archive} /></div>
                  </article>
                ))}
              </div>
            ) : (
              <ScrollTable label="Customers" className={shownView === "list" ? s.dense : undefined}>
                <thead><tr>
                  <th className={s.thFirst}>Name</th>
                  {inView("contact") ? <th>Contact</th> : null}{inView("email") ? <th>Email</th> : null}{inView("phone") ? <th>Phone</th> : null}{inView("address") ? <th>Address</th> : null}<th className={s.right}>Actions</th>
                </tr></thead>
                <tbody>{visible.map((c) => (
                  <tr key={c.id ?? c.name} data-customer={c.name}>
                    <td className={s.tdFirst}><span className={s.nameCell}><span className={s.name}>{c.name}</span><NameNotes c={c} /></span></td>
                    {inView("contact") ? <td className={s.contactCell}>{c.contactName || dash}</td> : null}
                    {inView("email") ? <td className={s.emailCell}>{c.email ? mail(c.email) : dash}</td> : null}
                    {inView("phone") ? <td className={cx(s.nowrap, tabularNumbers)}>{c.phone || dash}{c.mobile ? <span className={s.cellNote}>Mobile {c.mobile}</span> : null}</td> : null}
                    {inView("address") ? <td>{c.address ? <span className={s.clamp} title={lines(c.address)}>{lines(c.address)}</span> : dash}</td> : null}
                    <td className={s.right}><div className={s.rowActions}><Actions c={c} mayArchive={mayArchive} open={open} add={add} preview={preview} archive={archive} /></div></td>
                  </tr>))}
                </tbody>
              </ScrollTable>
            )}
        </>
      )}

      {editing && !denied ? <CustomerSheet key={editing.id ?? `new-${editing.values.name}`} editing={editing} features={features} onClose={() => setEditing(null)} preview={preview} /> : null}
    </div>
  );
}

function valuesOf(c: SeedCustomer): CustomerValues {
  return { name: c.name, contactName: c.contactName, email: c.email, phone: c.phone, address: c.address, notes: c.notes, ...(c.mobile === undefined ? {} : { mobile: c.mobile }), ...(c.traceableDefault === undefined ? {} : { traceableDefault: c.traceableDefault }) };
}

/** Under the name: not saved yet, customer credit, chasing paused (the three notes the real cell can carry). */
function NameNotes({ c }: { c: SeedCustomer }) {
  return (
    <>
      {c.notSaved ? <span className={s.cellNote} data-testid="customer-not-saved">{NOT_SAVED_LABEL}</span> : null}
      {c.credit ? <span className={cx(s.cellNote, s.attention)} data-testid="customer-credit">Customer credit {gbp(c.credit, 2)}</span> : null}
      {chasePaused(c) ? <span className={s.cellNote}><span data-testid="chase-paused-badge"><StatusBadge tone="warn">Chasing paused</StatusBadge></span></span> : null}
    </>
  );
}

function Actions({ c, mayArchive, open, add, preview, archive }: { c: SeedCustomer; mayArchive: boolean; open: (c: SeedCustomer) => void; add: (name: string) => void; preview: (d: string) => void; archive: (c: SeedCustomer) => void }) {
  if (c.notSaved) return <Button size="sm" variant="secondary" data-action="Add customer" aria-label={`Add ${c.name} as a customer`} onClick={() => add(c.name)}>Add customer</Button>;
  const archived = phaseFor(c) === "archived";
  return (
    <>
      <Button size="sm" variant="secondary" data-action="Draft statement" aria-label={`Draft statement for ${c.name}`} onClick={() => preview(`A statement for ${c.name} would be drafted and saved in Approvals for checking. Nothing would be sent.`)}>Draft statement</Button>
      <Button size="sm" variant="secondary" data-action="Edit" aria-label={`Edit ${c.name}`} onClick={() => open(c)}>Edit</Button>
      {mayArchive ? <Button size="sm" variant="quiet" data-action="Archive" aria-label={`${archived ? "Unarchive" : "Archive"} ${c.name}`} onClick={() => archive(c)}>{archived ? "Unarchive" : "Archive"}</Button> : null}
    </>
  );
}

/** The Add / Edit form. The three groups follow the real form's fields in the real order; checks run on Save and then live, each beside its field. */
function CustomerSheet({ editing, features, onClose, preview }: { editing: Editing; features: boolean; onClose: () => void; preview: (d: string) => void }) {
  const [v, setV] = useState<CustomerValues>(editing.values);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // First focus goes to the name (a scrolling body would otherwise take it), so typing can start at once.
  useEffect(() => { form.current?.querySelector<HTMLElement>('input[name="name"]')?.focus(); }, []);
  const errors = useMemo(() => validateCustomer(v), [v]);
  const shown = (k: keyof CustomerErrors) => (submitted || touched[k] ? errors[k] : undefined);
  const set = <K extends keyof CustomerValues>(k: K, value: CustomerValues[K]) => setV((p) => ({ ...p, [k]: value }));
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));
  const failing = (Object.keys(errors) as Array<keyof CustomerErrors>).filter((k) => submitted && errors[k]);
  const LABEL: Record<string, string> = { name: "Customer name", email: "Email", phone: "Phone", mobile: "Mobile" };
  const existing = Boolean(editing.id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(validateCustomer(v)).length) { requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    onClose();
    preview(`${v.name.trim()} would be ${existing ? "updated" : "added as a customer"}.`);
  };
  return (
    <Sheet open size="md" title={existing ? "Edit customer" : "Add customer"} description="Customer contact details." onClose={onClose} testId="dlg-customer" closeButton={false}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="customer-form" data-testid="save-customer">Save Customer</Button></>}>
      <form id="customer-form" ref={form} onSubmit={submit} noValidate className={s.form} aria-label={existing ? "Edit customer" : "Add customer"}>
        {failing.length ? <p className={s.summary} role="alert" data-testid="form-summary">{failing.length === 1 ? "1 field needs attention" : `${failing.length} fields need attention`}: {failing.map((k) => LABEL[k]).join(", ")}.</p> : null}
        <div role="group" aria-labelledby="g-customer" className={s.group}>
          <h3 id="g-customer" className={s.legend}>Customer</h3>
          <Field label="Customer name" required error={shown("name")}><Input name="name" autoComplete="off" value={v.name} onChange={(e) => set("name", e.target.value)} onBlur={blur("name")} /></Field>
          <Field label="Contact name" optional><Input name="contact_name" autoComplete="off" value={v.contactName} onChange={(e) => set("contactName", e.target.value)} /></Field>
        </div>
        <div role="group" aria-labelledby="g-contact-details" className={s.group}>
          <h3 id="g-contact-details" className={s.legend}>Contact details</h3>
          <Field label="Email" optional hint="Where documents for this customer are e-mailed." error={shown("email")}><Input name="email" type="email" value={v.email} onChange={(e) => set("email", e.target.value)} onBlur={blur("email")} /></Field>
          <div className={cx(s.pair, v.mobile === undefined && s.pairOne)}>
            <Field label="Phone" optional error={shown("phone")}><Input name="phone" type="tel" inputMode="tel" autoComplete="tel" value={v.phone} onChange={(e) => set("phone", e.target.value)} onBlur={blur("phone")} /></Field>
            {v.mobile !== undefined ? <Field label="Mobile" optional error={shown("mobile")}><Input name="mobile" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} value={v.mobile} onChange={(e) => set("mobile", e.target.value)} onBlur={blur("mobile")} /></Field> : null}
          </div>
        </div>
        <div role="group" aria-labelledby="g-address-and-notes" className={s.group}>
          <h3 id="g-address-and-notes" className={s.legend}>Address and notes</h3>
          <Field label="Address" optional hint="Shown on documents. Put each line on its own row, or separate the lines with commas."><Textarea name="address" rows={3} autoComplete="off" value={v.address} onChange={(e) => set("address", e.target.value)} /></Field>
          <Field label="Notes" optional><Textarea name="notes" rows={3} value={v.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        </div>
        {v.traceableDefault !== undefined ? (
          <div role="group" aria-labelledby="g-jobs" className={s.group}>
          <h3 id="g-jobs" className={s.legend}>Jobs</h3>
            <label className={s.checkRow}>
              <Checkbox name="traceable_default" checked={v.traceableDefault} onChange={(e) => set("traceableDefault", e.target.checked)} />
              <span><span className={s.checkTitle}>Traceable material</span><span className={s.checkHint}>New jobs for this customer need the material cert no. and heat/cast no. before the inspection can pass.</span></span>
            </label>
          </div>
        ) : null}
      </form>
      {existing ? (
        <div className={s.extras}>
          <DeliveryNotesFor notes={editing.source?.deliveryNotes ?? []} preview={preview} />
          <ChasePanel source={editing.source} name={v.name} preview={preview} />
        </div>
      ) : null}
      <p className={s.sheetNote}>Preview only. Nothing is read from or saved to your account.</p>
    </Sheet>
  );
}

/** components/delivery-notes-for.tsx: a closed disclosure; each note's reference opens its print page (here: a Preview-only answer). */
function DeliveryNotesFor({ notes, preview }: { notes: SeedNote[]; preview: (d: string) => void }) {
  return (
    <details className={s.disclosure} data-testid="delivery-notes-for">
      <summary>Delivery notes</summary>
      {notes.length === 0 ? <p className={s.disclosureEmpty} data-testid="delivery-notes-none">No delivery notes yet.</p> : (
        <ul className={s.dnList} data-testid="delivery-notes-list">
          {notes.map((n) => (
            <li key={n.ref}>
              <button type="button" className={cx(s.linkBtn, tabularNumbers)} onClick={() => preview(`${n.ref} would open on the print page.`)}>{n.ref}</button>
              <StatusBadge tone={toneOf(n.status)}><span className={s.cap}>{n.status}</span></StatusBadge>
              <span className={cx(s.dnDate, tabularNumbers)}>{fmtDate(n.date)}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** components/chase/chase-pause.tsx for a customer: the paused state, the empty state and the Pause form. Nothing is written. */
function ChasePanel({ source, name, preview }: { source?: SeedCustomer; name: string; preview: (d: string) => void }) {
  const pause = source?.pause ?? null;
  const active = pause ? pauseActive(pause.until, TODAY) : false;
  const [editing, setEditing] = useState(false);
  const [p, setP] = useState<PauseValues>({ reason: "", until: "" });
  const [submitted, setSubmitted] = useState(false);
  const errs = validatePause(p);
  const form = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const save = () => {
    setSubmitted(true);
    if (Object.keys(validatePause(p)).length) { requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    setEditing(false); setSubmitted(false); setP({ reason: "", until: "" });
    preview(`Chasing would be paused for ${name}.`);
  };
  return (
    <section className={s.chase} aria-label="Chasing" data-testid="chase-pause-customer">
      {pause ? (
        <div className={s.chaseRow}>
          <div>
            <p className={s.chaseTitle} data-testid="chase-pause-status">{active ? "Chasing paused" : "Chasing pause ended"}{pause.until ? ` until ${fmtDate(pause.until)}` : ""}</p>
            <p className={s.chaseText}>Reason: {pause.reason}</p>
            <p className={s.hint}>No chase e-mails are drafted for this customer while it is paused.</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => preview(`Chasing would resume for ${name}.`)}>Resume chasing</Button>
        </div>
      ) : editing ? (
        <div ref={form} className={s.pauseForm}>
          <Field label="Reason" error={submitted ? errs.reason : undefined}><Input maxLength={300} value={p.reason} placeholder="e.g. Query on the delivery" onChange={(e) => setP((x) => ({ ...x, reason: e.target.value }))} /></Field>
          <Field label="Until" optional error={submitted ? errs.until : undefined}><Input type="date" value={p.until} onChange={(e) => setP((x) => ({ ...x, until: e.target.value }))} /></Field>
          <div className={s.pauseBtns}><Button size="sm" variant="primary" onClick={save}>Pause</Button><Button size="sm" variant="quiet" onClick={() => { setEditing(false); setSubmitted(false); requestAnimationFrame(() => trigger.current?.focus()); }}>Cancel</Button></div>
        </div>
      ) : (
        <div className={s.chaseRow}>
          <p className={s.chaseText}>Chase steps run for this customer.</p>
          <Button ref={trigger} size="sm" variant="secondary" onClick={() => setEditing(true)}>Pause chasing</Button>
        </div>
      )}
    </section>
  );
}

