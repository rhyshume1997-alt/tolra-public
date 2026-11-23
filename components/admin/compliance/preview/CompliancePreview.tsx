"use client";

/**
 * BOUNDARY (Admin > Security, route /admin/compliance, PREVIEW ONLY: nothing here is wired to anything).
 * OWNERSHIP ASSUMPTION FOR THE OWNER TO CONFIRM: docs/MODULES.md gives /admin/compliance no module. By the coordinator's decision it is treated as a company-admin screen under
 * Module 1 (Auth / Company / Users / Admin). If it belongs elsewhere, move these four files; nothing else depends on them.
 * Inputs: none from the server. Everything shown is fictional sample data (made-up people on reserved ".example" addresses, made-up integrity codes, as of 23/11/2026) held in this
 * file, plus the person's clicks and search. Outputs: the Security look-and-feel prototype (four control cards, Alerts, the Audit Log with search) whose only state is LOCAL UI state.
 * It calls NO Supabase, fetch, e-mail or auth code and sends NOTHING: "Send test alert" and "Refresh activity log" answer with the neutral "Preview only ... Nothing was saved."
 * toast. The only alert outcomes that can be drawn (Preview controls) are the real "not sent" and error sentences from lib/alert-test-message.ts describeAlertTest; the "Sent" success
 * is never drawn, because that would simulate an e-mail going out. The Role control only changes which screen is drawn; it grants nothing.
 * Labels come from the REAL pure functions auditActionLabel and recordTypeLabel (lib/activity.ts), describeAlertTest (lib/alert-test-message.ts), fmtDateTime and PRODUCT.
 * The search rule (a match in e-mail, action, table, id or hash, case-insensitive) mirrors the real page and is pinned to its source by tests/unit/adminCompliancePreview.test.ts.
 * MUST NOT CHANGE: wording, the four control texts, the columns, the admin-only rule and "Pending" for an entry with no integrity code mirror today's page. Do not wire this to real
 * data, a session or an action, do not add a control the real page lacks (the real page has no export or delete here and neither may this), keep every control at a 48 px hit area.
 * Delete the four preview files to remove it completely.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Button, Callout, EmptyState, Field, Input, LoadingState, Panel, Popover, ScrollTable, SegmentedControl, StatusBadge, ToastProvider, cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import { auditActionLabel, recordTypeLabel } from "@/lib/activity";
import { ALERT_TEST_NETWORK_ERROR, describeAlertTest, type AlertTestOutcome } from "@/lib/alert-test-message";
import { fmtDateTime } from "@/lib/dates";
import { PRODUCT } from "@/lib/product";
import type { UserRole } from "@/types";

import s from "./CompliancePreview.module.css";

export type Role = UserRole;
export type Screen = "ready" | "loading" | "empty" | "error";
export type AlertSample = "none" | "rate-limited" | "disabled" | "not-production" | "no-provider" | "unreachable" | "server-error";

/* ---------- the real page's wording (app/(dashboard)/admin/compliance/page.tsx), pinned by the test ---------- */
export const PAGE_TITLE = "Security";
export const subtitleFor = (name: string) => `How ${name} protects your company's records.`;
export const CONTROLS = [
  { title: "Access by role", description: "Each person signs in with their own account. Their role decides which pages they can open and what they can change. Administrator accounts can also be protected with a code from an authenticator app." },
  { title: "Company separation", description: "Every record belongs to one company, and the database only shows people the records of their own company." },
  { title: "Audit log", description: "Changes to records are logged automatically. Entries are added to the end of the log, linked to the one before, and cannot be edited or deleted. Only administrators can read it." },
  { title: "Exports and downloads", description: "Exports, PDF downloads and print packs are recorded in the audit log, with who did it and when." },
] as const;
export const ALERTS_TEXT = "When the live app hits a server error it e-mails the owner. Send a made-up test error to check that e-mail arrives. Only one test is allowed per hour.";
export const AUDIT_TEXT = "The 25 latest actions: exports, changes to records and admin changes.";
export const ERROR_TEXT = "Couldn't load the audit log.";
export const EMPTY_TEXT = "No audit entries yet.";
export const NO_MATCH_TEXT = "No entries match your search.";
export const PENDING = "Pending";
export const COLUMNS = ["When", "User", "Action", "Record", "Integrity code"] as const;
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
export const canUseCompliance = (role: Role): boolean => role === "admin";

export type AuditEntry = { id: string; actor_email: string | null; action: string; entity_table: string; entity_id: string | null; hash: string | null; created_at: string };
/** A made-up 64-character hex string (an obviously repeating pattern, never a real hash). */
const fakeHash = (n: number) => (n * 7919 + 4096).toString(16).padStart(8, "0").repeat(8);
const A = (n: number, at: string, email: string | null, action: string, table: string, hash: string | null): AuditEntry => ({ id: `aud-${String(n).padStart(2, "0")}`, actor_email: email, action, entity_table: table, entity_id: null, hash, created_at: at });
/** Fictional audit rows (newest first). The integrity codes are made-up hex strings, not real hashes. */
export const SAMPLE_AUDIT: AuditEntry[] = [
  A(1, "2026-11-23T08:41:00Z", "priya.raman@fernhill.example", "UPDATE", "quotes", fakeHash(1)),
  A(2, "2026-11-23T08:12:00Z", "callum.reeve@fernhill.example", "INSERT", "quotes", fakeHash(2)),
  A(3, "2026-11-22T16:02:00Z", "priya.raman@fernhill.example", "EXPORT_CSV", "invoices", fakeHash(3)),
  A(4, "2026-11-22T14:20:00Z", "priya.raman@fernhill.example", "RECORD_PAYMENT", "invoices", fakeHash(4)),
  A(5, "2026-11-21T11:36:00Z", "priya.raman@fernhill.example", "UPDATE", "customers", fakeHash(5)),
  A(6, "2026-11-20T17:44:00Z", "harvey.lindqvist@fernhill.example", "INSPECT_JOB", "jobs", fakeHash(6)),
  A(7, "2026-11-20T13:10:00Z", "tomas.whitcombe@fernhill.example", "DELETE", "quote_line_items", null),
  A(8, "2026-11-19T10:22:00Z", null, "UPDATE", "machines", fakeHash(7)),
];
export const SAMPLE_ALERT_BODIES: Record<Exclude<AlertSample, "none" | "unreachable" | "server-error">, { sent: false; reason: string }> = {
  "rate-limited": { sent: false, reason: "rate-limited" }, disabled: { sent: false, reason: "disabled" }, "not-production": { sent: false, reason: "not-production" }, "no-provider": { sent: false, reason: "no-provider" },
};
/** The alert sentence to draw for a sample: always from the real describeAlertTest, and never the "Sent" success. */
export function alertOutcomeFor(sample: AlertSample): AlertTestOutcome | null {
  if (sample === "none") return null;
  if (sample === "unreachable") return ALERT_TEST_NETWORK_ERROR;
  if (sample === "server-error") return describeAlertTest(500, null);
  return describeAlertTest(200, SAMPLE_ALERT_BODIES[sample]);
}

/** The real page's search: a case-insensitive match in e-mail, action, table, id or hash. */
export function searchEntries(entries: AuditEntry[], query: string): AuditEntry[] {
  const search = query.toLowerCase().trim();
  if (!search) return entries;
  return entries.filter((entry) => [entry.actor_email, entry.action, entry.entity_table, entry.entity_id, entry.hash].filter(Boolean).some((value) => String(value).toLowerCase().includes(search)));
}

export const NARROW_QUERY = "(max-width: 760px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(NARROW_QUERY); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

const SCREENS: Array<{ v: Screen; label: string }> = [
  { v: "ready", label: "Ready (8 sample entries)" }, { v: "loading", label: "Loading the audit log" }, { v: "empty", label: "No audit entries yet" }, { v: "error", label: "Couldn't load the audit log" },
];
const ALERTS: Array<{ v: AlertSample; label: string }> = [
  { v: "none", label: "No result shown" }, { v: "rate-limited", label: "Not sent: rate limited" }, { v: "disabled", label: "Not sent: alerts switched off" }, { v: "not-production", label: "Not sent: not Production" },
  { v: "no-provider", label: "Not sent: no e-mail provider key" }, { v: "unreachable", label: "Could not reach the server" }, { v: "server-error", label: "The server answered 500" },
];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }));

export default function CompliancePreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const narrow = useNarrow();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [alertSample, setAlertSample] = useState<AlertSample>("none");
  const [query, setQuery] = useState("");
  const [timer, setTimer] = useState<number | null>(null);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseCompliance(role);
  const loading = screen === "loading";
  const entries = useMemo(() => (screen === "ready" ? SAMPLE_AUDIT : []), [screen]);
  const shown = useMemo(() => searchEntries(entries, query), [entries, query]);
  const outcome = alertOutcomeFor(alertSample);
  const pick = (v: Screen) => { toast.clear(); setScreen(v); };
  const reset = () => { toast.clear(); setScreen("ready"); setRole("admin"); setAlertSample("none"); setQuery(""); };
  const refresh = () => {
    toast.clear();
    setScreen("loading");
    setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample entries shown again. No server was contacted." }); }, 700));
  };

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="compliance-preview" data-role={role} data-screen={screen}>
      <header className={s.headRow}>
        <div>
          <div className={s.titleLine}>
            <h1 className={s.title}>{denied ? "Access Denied" : PAGE_TITLE}</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
            <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
              <div className={s.dock}>
                <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated, nothing is granted, no request is made and no e-mail is sent.</p>
                <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
                <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
                <p className={s.dockLabel}>Audit log state</p>
                <div className={s.dockStates} role="group" aria-label="Audit log state">
                  {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => pick(x.v)}>{x.label}</button>)}
                </div>
                <p className={s.dockLabel}>Alert test result (real wording)</p>
                <div className={s.dockStates} role="group" aria-label="Alert test result">
                  {ALERTS.map((x) => <button key={x.v} type="button" aria-pressed={alertSample === x.v} className={s.dockBtn} onClick={() => setAlertSample(x.v)}>{x.label}</button>)}
                </div>
                <Button size="sm" variant="secondary" data-testid="dock-reset" onClick={reset}>Reset preview</Button>
              </div>
            </Popover>
          </div>
          <p className={s.subtitle}>{denied ? "Redirecting you back to the dashboard." : subtitleFor(PRODUCT.name)}</p>
        </div>
        {denied ? null : <Button variant="primary" disabled={loading} data-testid="refresh" onClick={refresh}>Refresh activity log</Button>}
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied" aria-label="Access denied">
          <p className={s.deniedNote}>Only an admin can open Security.</p>
          <p className={s.deniedPreview}>Preview only: no redirect happens here. Security is for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : (
        <>
          <ul className={s.controls} aria-label="How your records are protected">
            {CONTROLS.map((c) => (
              <li key={c.title} className={s.control}>
                <h2 className={s.controlTitle}>{c.title}</h2>
                <p className={s.controlText}>{c.description}</p>
              </li>
            ))}
          </ul>

          <Panel title="Alerts" data-testid="alerts-panel">
            <div className={s.alertBody}>
              <p className={s.alertText}>{ALERTS_TEXT}</p>
              <Button variant="secondary" data-testid="send-test-alert" onClick={() => preview("A test alert e-mail would be requested. No e-mail was sent.")}>Send test alert</Button>
              <div role="status" aria-live="polite" data-testid="alert-outcome">
                {outcome ? <Callout tone={outcome.tone === "error" ? "error" : "warn"} lead="" role="note">{outcome.text}</Callout> : null}
              </div>
            </div>
          </Panel>

          <Panel title="Audit Log" bare data-testid="audit-panel">
            <div className={s.searchRow} style={{ padding: "0 18px 16px" }}>
              <p className={s.alertText}>{AUDIT_TEXT}</p>
              {screen === "error" ? <Callout tone="error" lead="" role="alert">{ERROR_TEXT}</Callout> : null}
              <Field label="Search audit entries" className={s.search}>
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search audit entries..." data-testid="audit-search" />
              </Field>
            </div>
            {loading ? <LoadingState label="Loading the audit log" rows={5} /> : narrow ? (
              shown.length ? (
                <ul className={s.records} aria-label="Audit entries">
                  {shown.map((e) => (
                    <li key={e.id} className={s.record}>
                      <div className={s.recordTop}><span className={cx(s.cellStrong, tabularNumbers)}>{fmtDateTime(e.created_at)}</span><StatusBadge tone="neutral">{auditActionLabel(e.action)}</StatusBadge></div>
                      <span>{e.actor_email || "System"}</span>
                      <span>{recordTypeLabel(e.entity_table)}</span>
                      <span className={e.hash ? s.mono : s.pending}>{e.hash || PENDING}</span>
                    </li>
                  ))}
                </ul>
              ) : screen === "error" ? null : <p className={s.emptyCell}>{entries.length ? NO_MATCH_TEXT : EMPTY_TEXT}</p>
            ) : shown.length ? (
              <ScrollTable label="Audit entries table" dense>
                <thead><tr>{COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                <tbody>
                  {shown.map((e) => (
                    <tr key={e.id}>
                      <td className={cx(s.when, tabularNumbers)}>{fmtDateTime(e.created_at)}</td>
                      <td>{e.actor_email || "System"}</td>
                      <td><StatusBadge tone="neutral">{auditActionLabel(e.action)}</StatusBadge></td>
                      <td>{recordTypeLabel(e.entity_table)}</td>
                      <td className={e.hash ? s.mono : s.pending}>{e.hash || PENDING}</td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            ) : screen === "error" ? null : <EmptyState compact headingLevel={3} title={entries.length ? NO_MATCH_TEXT : EMPTY_TEXT} />}
          </Panel>
        </>
      )}
    </div>
  );
}
