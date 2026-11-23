"use client";

/**
 * BOUNDARY (Admin > Activity, PREVIEW ONLY: nothing here is wired to anything).
 * OWNERSHIP ASSUMPTION FOR THE OWNER TO CONFIRM: docs/MODULES.md gives /admin/activity no module. By the coordinator's decision it is treated as a company-admin screen under
 * Module 1 (Auth / Company / Users / Admin). If it belongs elsewhere, move these four files; nothing else depends on them.
 * Inputs: none from the server. Everything shown is fictional sample data (one made-up company, people with no e-mail addresses, as of 23/11/2026) held in this file, plus the
 * person's clicks and filters. Outputs: the Admin > Activity look-and-feel prototype (filters, the log, Load more, empty, loading and failed states) whose only state is LOCAL UI state.
 * It calls NO Supabase, rpc, fetch or auth code. The sentences in the log are made by the REAL pure functions of lib/activity.ts (describeEntry, actorLabel, recordLabel,
 * recordTypeLabel, RECORD_TYPES) and lib/people.ts (memberLabel, withUsernames) from sample rows. The filter logic mirrors the real page's dayStart and the real rpc arguments
 * (person, record type, from, to) over the sample rows; the mirrored text is pinned to app/(dashboard)/admin/activity/page.tsx by tests/unit/adminActivityPreview.test.ts.
 * Entries are read-only: there is no edit or delete anywhere, as on the real page. The Role control in Preview controls only changes which screen is drawn; it grants nothing.
 * Retry and Load more answer with the neutral "Preview only ... Nothing was saved." toast.
 * MUST NOT CHANGE: wording, filters, the admin-only rule and the rule that a name is never an e-mail address mirror today's page. Do not wire this to real data, a session or an
 * action, do not add a control the real page lacks, keep every control at a 48 px hit area. Delete the four preview files to remove it completely.
 */

import { useCallback, useMemo, useState, useEffect } from "react";
import {
  Button, EmptyState, FailedState, Field, Input, LoadingState, Panel, Popover, SegmentedControl, Select, ToastProvider, cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import { actorLabel, describeEntry, RECORD_TYPES, recordLabel, recordTypeLabel, type ActivityEntry } from "@/lib/activity";
import { fmtDateTime } from "@/lib/dates";
import { memberLabel, withUsernames, type PeopleMap } from "@/lib/people";
import type { UserRole } from "@/types";

import s from "./ActivityPreview.module.css";

export type Role = UserRole;
export type Screen = "ready" | "loading" | "empty-start" | "error" | "error-013" | "more" | "loading-more";

/* ---------- the real page's wording (app/(dashboard)/admin/activity/page.tsx), pinned by the test ---------- */
export const PAGE_TITLE = "Activity";
export const SUBTITLE = "Everything created, changed or deleted, by whom and when. Entries are permanent: nobody can edit or delete them.";
export const EMPTY_TEXT = "No activity matches these filters.";
export const ERROR_013 = "The activity log isn't switched on yet (database update 013).";
export const ERROR_GENERIC = "Couldn't load the activity.";
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
/** The page size the real rpc is asked for; "Load more" appears when a page came back full. */
export const PAGE = 100;

/** Start of a local day, as an ISO timestamp (the database compares in UTC): mirrors the real page's dayStart. */
export const dayStart = (date: string, plusDays = 0) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d + plusDays).toISOString();
};

export type Member = { user_id: string; full_name: string | null; username: string | null };
/** Fictional people. No e-mail addresses anywhere: names only, as on the real page. */
export const MEMBERS: Member[] = [
  { user_id: "u01", full_name: "Priya Raman", username: "priyar" },
  { user_id: "u04", full_name: "Callum Reeve", username: "creeve" },
  { user_id: "u06", full_name: "Harvey Lindqvist", username: "hlindqvist" },
  { user_id: "u08", full_name: null, username: "iboateng" },
];
const COMPANY_PEOPLE: PeopleMap = { u01: "Priya Raman", u04: "Callum Reeve", u06: "Harvey Lindqvist" };

const E = (id: string, at: string, who: string | null, action: string, table: string, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id, created_at: at, actor_name: who, actor_user_id: who ? ({ "Priya Raman": "u01", "Callum Reeve": "u04", "Harvey Lindqvist": "u06", "iboateng": "u08" } as Record<string, string>)[who] ?? null : null,
  action, entity_table: table, entity_id: null, changes: null, snapshot: null, metadata: null, record_table: table, record_id: null, record_label: null, ...extra,
});
/** Fictional log rows in the shape org_activity returns, newest first. */
export const SAMPLE_ENTRIES: ActivityEntry[] = [
  E("a01", "2026-11-23T08:41:00Z", "Priya Raman", "UPDATE", "quotes", { changes: { status: { from: "Draft", to: "Sent" } }, record_label: "Q-2041" }),
  E("a02", "2026-11-23T08:12:00Z", "Callum Reeve", "INSERT", "quotes", { snapshot: { quote_ref: "Q-2042" }, record_label: "Q-2042" }),
  E("a03", "2026-11-22T16:50:00Z", "Callum Reeve", "INSERT", "quote_line_items", { snapshot: { description: "Bracket, 6 mm mild steel", quantity: 40, unit_price: 12.5 }, record_table: "quotes", record_label: "Q-2042" }),
  E("a04", "2026-11-22T15:03:00Z", "Harvey Lindqvist", "INSERT", "jobs", { snapshot: { job_no: "J-0433" }, record_label: "J-0433" }),
  E("a05", "2026-11-22T14:20:00Z", "Priya Raman", "RECORD_PAYMENT", "invoices", { metadata: { amount: 1840, paid_on: "2026-11-22", method: "bank transfer", reference: "BACS-48812" }, record_label: "INV-1187" }),
  E("a06", "2026-11-21T11:36:00Z", "Priya Raman", "UPDATE", "customers", { changes: { phone: { from: "01632 960101", to: "01632 960155" }, credit_limit: { from: 5000, to: 8000 } }, record_label: "Wexcombe Plastics Ltd" }),
  E("a07", "2026-11-21T09:05:00Z", "Callum Reeve", "UPDATE", "sales_orders", { changes: { delivery_date: { from: "2026-11-27", to: "2026-12-02" } }, record_label: "SO-0612" }),
  E("a08", "2026-11-20T17:44:00Z", "Harvey Lindqvist", "INSPECT_JOB", "jobs", { record_label: "J-0430" }),
  E("a09", "2026-11-20T13:10:00Z", "Priya Raman", "DELETE", "quote_line_items", { snapshot: { description: "Deburring, per part" }, record_table: "quotes", record_label: "Q-2039" }),
  E("a10", "2026-11-19T10:22:00Z", "iboateng", "UPDATE", "machines", { changes: { name: { from: "Lathe 2", to: "Lathe 2 (CNC)" } }, record_label: null }),
  E("a11", "2026-11-18T07:00:00Z", "System", "UPDATE", "invoices", { changes: { status: { from: "Sent", to: "Overdue" } }, record_label: "INV-1169", actor_user_id: null }),
  E("a12", "2026-11-17T12:30:00Z", "Priya Raman", "VOID_INVOICE", "invoices", { metadata: { reason: "Raised against the wrong customer." }, record_label: "INV-1175" }),
];

/** What the real rpc does with the four filters, applied to the sample rows. */
export function applyFilters(rows: ActivityEntry[], f: { actor: string; table: string; from: string; to: string }): ActivityEntry[] {
  const from = f.from ? Date.parse(dayStart(f.from)) : null;
  const to = f.to ? Date.parse(dayStart(f.to, 1)) : null;
  return rows.filter((r) => {
    const at = Date.parse(r.created_at);
    return (!f.actor || r.actor_user_id === f.actor) && (!f.table || (r.record_table ?? r.entity_table) === f.table) && (from === null || at >= from) && (to === null || at < to);
  });
}

const SCREENS: Array<{ v: Screen; label: string }> = [
  { v: "ready", label: "Ready (12 sample entries)" },
  { v: "more", label: "Ready, with Load more" },
  { v: "loading", label: "Loading" },
  { v: "loading-more", label: "Loading more" },
  { v: "empty-start", label: "Nothing logged yet" },
  { v: "error", label: "Couldn't load" },
  { v: "error-013", label: "Log not switched on (update 013)" },
];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }));
export const canUseActivity = (role: Role): boolean => role === "admin";

export default function ActivityPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [actor, setActor] = useState("");
  const [table, setTable] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [timer, setTimer] = useState<number | null>(null);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);
  const people = useMemo(() => withUsernames(COMPANY_PEOPLE, MEMBERS), []);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseActivity(role);
  const loading = screen === "loading";
  const failed = screen === "error" || screen === "error-013";
  const rows = useMemo(() => (screen === "empty-start" || loading || failed ? [] : applyFilters(SAMPLE_ENTRIES, { actor, table, from, to })), [screen, loading, failed, actor, table, from, to]);
  const more = (screen === "more" || screen === "loading-more") && !failed;
  const pick = (v: Screen) => { toast.clear(); setScreen(v); };
  const reset = () => { toast.clear(); setScreen("ready"); setRole("admin"); setActor(""); setTable(""); setFrom(""); setTo(""); };
  const retry = () => { setScreen("loading"); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample entries shown again. No server was contacted." }); }, 700)); };
  const filtered = Boolean(actor || table || from || to);

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="activity-preview" data-role={role} data-screen={screen}>
      <header className={s.head}>
        <div>
          <div className={s.titleLine}>
            <h1 className={s.title}>{denied ? "Access Denied" : PAGE_TITLE}</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
            <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
              <div className={s.dock}>
                <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated, nothing is granted and no request is made.</p>
                <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
                <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
                <p className={s.dockLabel}>Screen state</p>
                <div className={s.dockStates} role="group" aria-label="Screen state">
                  {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => pick(x.v)}>{x.label}</button>)}
                </div>
                <Button size="sm" variant="secondary" data-testid="dock-reset" onClick={reset}>Reset preview</Button>
              </div>
            </Popover>
          </div>
          <p className={s.subtitle}>{denied ? "Redirecting you back to the dashboard." : SUBTITLE}</p>
        </div>
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied" aria-label="Access denied">
          <p className={s.deniedNote}>Only an admin can read the activity log.</p>
          <p className={s.deniedPreview}>Preview only: no redirect happens here. Activity is for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : (
        <>
          <Panel label="Filters" data-testid="filters">
            <div className={s.filters}>
              <Field label="Person">
                <Select aria-label="Person" value={actor} onChange={(e) => setActor(e.target.value)}>
                  <option value="">Everyone</option>
                  {MEMBERS.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
                </Select>
              </Field>
              <Field label="Record type">
                <Select aria-label="Record type" value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="">All</option>
                  {RECORD_TYPES.map((type) => <option key={type.table} value={type.table}>{type.label}</option>)}
                </Select>
              </Field>
              <Field label="From">
                <Input aria-label="From" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input aria-label="To" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>
          </Panel>

          {screen === "error" ? <FailedState headingLevel={2} title={ERROR_GENERIC} detail="This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" /> : null}
          {screen === "error-013" ? <FailedState headingLevel={2} title={ERROR_013} detail="This is a simulated message: no request was made." onRetry={retry} retryLabel="Retry" /> : null}

          {loading ? <LoadingState label="Loading the activity" rows={6} /> : failed ? null : !rows.length ? (
            <EmptyState headingLevel={2} title={EMPTY_TEXT} detail={filtered ? "Clear a filter to see more." : undefined} />
          ) : (
            <Panel label="Activity log" bare data-testid="log-panel">
              <ul className={s.log} aria-label="Activity entries">
                {rows.map((entry) => {
                  const { title, details } = describeEntry(entry, people);
                  const type = recordTypeLabel(entry.record_table ?? entry.entity_table);
                  const badge = [title.startsWith(type) ? null : type, recordLabel(entry)].filter(Boolean).join(" ");
                  return (
                    <li key={entry.id} className={s.entry}>
                      <p className={cx(s.when, tabularNumbers)}>{fmtDateTime(entry.created_at)}</p>
                      <p className={s.actor} data-testid="activity-actor">{actorLabel(entry, people)}</p>
                      <div className={s.what}>
                        <p className={s.title2}>{badge ? <span className={s.chip}>{badge}</span> : null}{title}</p>
                        {details.length ? <ul className={s.details}>{details.slice(0, 10).map((line, i) => <li key={i}>{line}</li>)}</ul> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}
          {more && rows.length ? (
            <div className={s.more}>
              <Button variant="secondary" disabled={screen === "loading-more"} onClick={() => preview("No more entries are loaded.")}>{screen === "loading-more" ? "Loading…" : "Load more"}</Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
