"use client";

/**
 * BOUNDARY (Email history, Integrations module 6 by the coordinator's decision: ASSUMPTION for the project owner to confirm, docs/MODULES.md does not list app/(dashboard)/email; PREVIEW ONLY).
 * Inputs: none from the server. Everything shown is fictional sample data (made-up companies and people on reserved ".example" addresses, as of 23/11/2026) held in this file, plus the person's
 * clicks. Message bodies are plain placeholder text, not real correspondence. Outputs: a look-and-feel prototype of the real Email & Payment Automation page (app/(dashboard)/email/page.tsx): the
 * "Coming soon" notice, the five email-history counts, the filter chips, the table (To, Subject, Related to, Date, Status, Actions), View, the needs-checking panel with its admin-only
 * "It was sent" / "It was not sent", and the states (loading, failed with Retry, no emails recorded, Access Denied). The only state is LOCAL UI state. It reads and writes no table, calls no mail,
 * Microsoft 365, Resend or server route, and sends nothing: every action answers with the neutral "Preview only ... Nothing was saved." toast.
 * Run-time imports from lib/ are pure leaf modules only (lib/status-colours emailStatusKey, lib/dates, lib/product). The few rules that live inline in the real page (the status words, the counts, the
 * filter, the needs-checking panel and who may settle it, the role gate) are mirrored here and pinned to that source text by tests/unit/emailHistoryPreview.test.ts.
 * MUST NOT CHANGE: wording, columns and filter semantics mirror today's page (admin and office only; only an admin settles an unknown job e-mail). Do not wire this file to real data or real actions, do
 * not add a control the real page lacks (no search, no compose, no resend), and keep controls at a 48 px hit area. Delete the four preview files to remove it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, Callout, ChipGroup, EmptyState, FilterChip, LoadingState, Panel, Popover, ScrollTable, SegmentedControl, Sheet, StatTile, StatTiles, StatusBadge, ToastProvider,
  cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { fmtDateTime } from "@/lib/dates";
import { PRODUCT } from "@/lib/product";
import { emailStatusKey } from "@/lib/status-colours";

import s from "./EmailHistoryPreview.module.css";

/* ================================================================== */
/* 1. Types and constants                                              */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type Screen = "ready" | "loading" | "error" | "empty";
export type EmailRow = { id: string; to: string; subject: string; body: string; status: string; related: string; when: string };

/** The real page's words (app/(dashboard)/email/page.tsx), pinned by the tests. */
export const PAGE_TITLE = "Email & Payment Automation";
export const PAGE_SUBTITLE = "Emails sent from Tolra, with a record of each. Automatic follow-ups are not available yet.";
export const COMING_SOON = "Coming soon: automatic email reading, quote follow-ups and payment reminders. Nothing on this page sends email yet. Drafts are reviewed in the Approval Queue.";
export const HISTORY_TITLE = "Email history";
export const HISTORY_NOTE = `Counts of the most recent 100 emails recorded by ${PRODUCT.name}.`;
export const NO_EMAILS = "No emails recorded yet.";
export const LOAD_ERROR = "Couldn't load email history.";
export const UNKNOWN_NOTE = "We couldn't confirm whether this was sent. Check with the customer or the provider's log before sending it again.";
export const ADMIN_SETTLES = "An administrator can settle this.";
export const COLUMNS = ["To", "Subject", "Related to", "Date", "Status", "Actions"] as const;
export const STATUS_LABEL: Record<string, string> = {
  drafted: "Drafted", copied: "Copied", sent_manually: "Sent manually", sent_via_system: "Sent", failed: "Failed", sending: "Sending", unknown: "Needs checking",
};
/** The five tiles: label, status each filters to. */
export const TILES: Array<{ label: string; status: string }> = [
  { label: "Drafted", status: "drafted" }, { label: "Sent manually", status: "sent_manually" }, { label: `Sent by ${PRODUCT.name}`, status: "sent_via_system" },
  { label: "Failed", status: "failed" }, { label: "Needs checking", status: "unknown" },
];
export const FILTER_OPTIONS = [
  { label: "All", value: "all" }, { label: "Drafted", value: "drafted" }, { label: "Sent manually", value: "sent_manually" }, { label: "Sent", value: "sent_via_system" },
  { label: "Failed", value: "failed" }, { label: "Needs checking", value: "unknown" },
];
const TONE: Record<string, StatusTone> = { drafted: "neutral", copied: "neutral", sent_manually: "ok", sent_via_system: "ok", failed: "danger", sending: "progress", unknown: "warn" };

/* ================================================================== */
/* 2. Sample data (fictional)                                          */
/* ================================================================== */

const body = (greeting: string, line: string) => `${greeting},\n\n${line}\n\nThis is sample text for the preview, not a real message.\n\nExample Engineering Ltd (sample)`;
const row = (id: string, to: string, subject: string, status: string, related: string, iso: string, line: string): EmailRow => (
  { id, to, subject, status, related, when: fmtDateTime(iso), body: body("Hello", line) }
);

export const SEED_EMAILS: EmailRow[] = [
  row("e12", "accounts@halden-precision.example", "Statement of account, November", "drafted", "customer statement", "2026-11-23T08:05:00Z", "Sample draft of a statement of account."),
  row("e11", "buyer@kestrel.example", "Quote QUO-0442 for sensor housings", "sent_via_system", "quote", "2026-11-22T15:40:00Z", "Sample message sending a quote."),
  row("e10", "purchasing@marlow-hydraulics.example", "Delivery note DN-0211", "sent_manually", "delivery note", "2026-11-22T11:15:00Z", "Sample message about a delivery."),
  row("e09", "orders@tern-marine.example", "Invoice INV-1190", "unknown", "job", "2026-11-21T16:30:00Z", "Sample message about a job."),
  row("e08", "buying@brightwell.example", "Payment reminder, invoice INV-1172", "failed", "invoice", "2026-11-21T09:00:00Z", "Sample payment reminder."),
  row("e07", "supply@ashby-rail.example", "Purchase order PO-0387", "sent_via_system", "purchase order", "2026-11-20T14:20:00Z", "Sample purchase order message."),
  row("e06", "orders@northgate-fab.example", "Sales order SO-0309 confirmation", "sent_via_system", "sales order", "2026-11-19T10:45:00Z", "Sample order confirmation."),
  row("e05", "projects@wren-calder.example", "Job J-0431 update", "drafted", "job", "2026-11-19T08:10:00Z", "Sample job update."),
  row("e04", "buyer@coldharbour.example", "Invoice INV-1164", "unknown", "invoice", "2026-11-18T13:05:00Z", "Sample message about an invoice."),
  row("e03", "tenders@meridian-subsea.example", "Quote QUO-0431 with a very long subject line so the table has to wrap it onto more than one line without breaking the layout", "sent_manually", "quote", "2026-11-17T12:00:00Z", "Sample message about a quote."),
  row("e02", "accounts@kestrel.example", "Credit note CN-0044", "sending", "credit note", "2026-11-16T09:30:00Z", "Sample credit note message."),
  row("e01", "buyer@halden-precision.example", "General enquiry", "copied", "general", "2026-11-15T16:55:00Z", "Sample general message."),
];

/* ================================================================== */
/* 3. Logic (mirrors the real page; the status key is the real function) */
/* ================================================================== */

export { emailStatusKey };
export const canUseEmail = (role: Role) => role === "admin" || role === "office";
/** Only an admin settles an unknown job e-mail; shown for status unknown and related job (page: item.status === "unknown" && item.related === "job"). */
export const showsSettlePanel = (r: Pick<EmailRow, "status" | "related">) => r.status === "unknown" && r.related === "job";
export const canSettle = (role: Role) => role === "admin";
/** The counts (page: count(status), dashes while loading or failed). */
export function countOf(rows: readonly EmailRow[], status: string, loading: boolean, error: boolean): string {
  return loading || error ? "—" : String(rows.filter((r) => r.status === status).length);
}
/** The filter (page: filters.has("all") ? rows : rows.filter(row => filters.has(row.status))). */
export const visibleRows = (rows: readonly EmailRow[], filters: ReadonlySet<string>) => (filters.has("all") ? [...rows] : rows.filter((r) => filters.has(r.status)));
/** The chip toggle (components/filter-bar.tsx toggle). */
export function toggleFilter(active: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(active);
  if (value === "all") { next.clear(); next.add("all"); } else {
    next.delete("all");
    if (next.has(value)) next.delete(value); else next.add(value);
    if (next.size === 0) next.add("all");
  }
  return next;
}

/* ================================================================== */
/* 4. The page                                                         */
/* ================================================================== */

const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen; label: string }> = [{ v: "ready", label: "Sample history" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No emails recorded" }];

export default function EmailHistoryPreview() {
  return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>;
}

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [filters, setFilters] = useState<Set<string>>(new Set(["all"]));
  const [viewing, setViewing] = useState<EmailRow | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const loading = screen === "loading";
  const error = screen === "error";
  const rows = useMemo(() => (screen === "ready" ? SEED_EMAILS : []), [screen]);
  const visible = useMemo(() => visibleRows(rows, filters), [rows, filters]);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const retry = () => { setScreen("loading"); toast.clear(); timer.current = window.setTimeout(() => { setScreen("ready"); preview("Sample history shown again. No server was contacted."); }, 700); };
  const resetAll = () => { setRole("admin"); setScreen("ready"); setFilters(new Set(["all"])); setViewing(null); toast.clear(); };
  const denied = !canUseEmail(role);

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="email-preview" data-role={role}>
      <header className={s.head}>
        <div className={s.headText}>
          {denied ? null : <h1 className={s.title}>{PAGE_TITLE}</h1>}
          {denied ? null : <p className={s.subtitle}>{PAGE_SUBTITLE}</p>}
        </div>
        <div className={s.previewBar}>
          <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
          <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
            <div className={s.dock}>
              <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated and no request is made and nothing is sent.</p>
              <p className={s.dockLabel}>Role</p>
              <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
              <p className={s.dockLabel}>Screen state</p>
              <div className={s.dockStates} role="group" aria-label="Screen state">
                {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => { setScreen(x.v); toast.clear(); }}>{x.label}</button>)}
              </div>
              <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
            </div>
          </Popover>
        </div>
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <h1 className={s.deniedTitle}>Access Denied</h1>
          <p className={s.deniedText}>Redirecting you back to the dashboard.</p>
          <p className={s.deniedNote}>In this preview nobody is redirected. The real page is for admin and office only.</p>
        </section>
      ) : (
        <>
          <Callout tone="warn" lead="" data-testid="coming-soon">{COMING_SOON}</Callout>

          <Panel title={HISTORY_TITLE} headingLevel={2} data-testid="history-panel">
            <p className={s.note}>{HISTORY_NOTE}</p>
            <StatTiles label="Email history counts" columns={4} className={s.tiles}>
              {TILES.map((t) => (
                <StatTile key={t.status} label={t.label} value={countOf(rows, t.status, loading, error)} loading={loading || error} pressed={filters.size === 1 && filters.has(t.status)}
                  onPress={() => setFilters(new Set([t.status]))} data-testid={`tile-${t.status}`} className={s.tile} />
              ))}
            </StatTiles>
          </Panel>

          <div className={s.filterRow}>
            <span className={s.filterLabel} id="email-filters-label">Filters</span>
            <ChipGroup label="Filters">
              {FILTER_OPTIONS.map((o) => <FilterChip key={o.value} selected={filters.has(o.value)} onToggle={() => setFilters((f) => toggleFilter(f, o.value))} data-testid={`chip-${o.value}`}>{o.label}</FilterChip>)}
            </ChipGroup>
          </div>

          {error ? (
            <div className={s.errorCard} role="alert" data-testid="load-error">
              <p className={s.errorText}>{LOAD_ERROR}</p>
              <Button variant="secondary" onClick={retry}>Retry</Button>
            </div>
          ) : null}

          {loading ? <LoadingState label="Loading email history" rows={5} /> : visible.length === 0 && !error ? (
            <EmptyState title={NO_EMAILS} headingLevel={2} compact />
          ) : error ? null : (
            <ScrollTable label="Emails" dense className={s.cardTable}>
              <thead><tr>{COLUMNS.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} data-email={r.id}>
                    <td data-label="To" className={s.to}>{r.to}</td>
                    <td data-label="Subject" className={s.subject}>{r.subject}</td>
                    <td data-label="Related to" className={s.related}>{r.related}</td>
                    <td data-label="Date" className={cx(s.nowrap, tabularNumbers)}>{r.when}</td>
                    <td data-label="Status">
                      <div className={s.statusCell}>
                        <StatusBadge tone={TONE[r.status] ?? "neutral"}>{STATUS_LABEL[r.status] ?? r.status}</StatusBadge>
                        {showsSettlePanel(r) ? (
                          <div className={s.settle} data-testid="settle-panel">
                            <p>{UNKNOWN_NOTE}</p>
                            {canSettle(role) ? (
                              <div className={s.settleActions}>
                                <Button size="sm" variant="secondary" onClick={() => preview("It would be recorded as sent.")}>It was sent</Button>
                                <Button size="sm" variant="secondary" onClick={() => preview("It would be recorded as not sent and could be sent again.")}>It was not sent</Button>
                              </div>
                            ) : <p className={s.settleNote}>{ADMIN_SETTLES}</p>}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Actions" data-actions><Button size="sm" variant="secondary" aria-label={`View email to ${r.to}`} onClick={() => { toast.clear(); setViewing(r); }}>View</Button></td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          )}
        </>
      )}

      {viewing ? (
        <Sheet open size="md" onClose={() => setViewing(null)} testId="dlg-view" title={viewing.subject} description={`To ${viewing.to} · ${viewing.when}`} closeButton={false} footer={<Button variant="secondary" onClick={() => setViewing(null)}>Close</Button>}>
          <div className={s.emailBody}>{viewing.body}</div>
        </Sheet>
      ) : null}
    </div>
  );
}
