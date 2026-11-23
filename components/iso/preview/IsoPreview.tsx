"use client";

/**
 * BOUNDARY (ISO templates, Module 9, PM-approved 6a, PREVIEW ONLY: nothing here is wired to anything).
 * Inputs: none from the server. Everything shown is fictional sample data (one made-up company, the nine real document titles and clauses, sample record counts and four sample
 * nonconformance records, as of 23/11/2026) held in this file, plus the person's clicks. Outputs: the Admin > ISO templates look-and-feel prototype (switch panel, pack button,
 * Documents table, Gap checklist table, NCR review reminder) whose only state is LOCAL UI state. It makes NO PDF and NO zip, writes NO file, reads NO company settings, and calls NO
 * Supabase, e-mail, AI, Xero or network code. The Role control in Preview controls only changes which screen is drawn; it grants nothing. No action reports success: every
 * download, the switch and the CSV button answer with the neutral "Preview only ... Nothing was saved." toast and nothing changes (the switch stays as drawn).
 * CONTROLLED DOCUMENTS: no wording of any ISO document is written, shown or changed here. The nine documents appear only as the real list's title and clause (imported from
 * lib/iso/document-list.ts), the gap list is built by the REAL buildGapChecklist from sample counts, and the page wording (off notice, switch card text, disclaimer line, headings,
 * column names, reminder text) is the real page's, pinned by tests/unit/isoPreview.test.ts. The lib/iso modules imported here are pure (document-list, gap-checklist, iso-switch).
 * The reminder rule (reviewDays, overdue) lives in lib/iso/ncr-review-reminder.ts, which reaches Supabase through lib/jobs, so it is mirrored here and the test pins the
 * mirror to the real function.
 * MUST NOT CHANGE: wording, columns, buttons, the admin-only rule and the off-by-default rule mirror today's page; status "Records present" is a self-assessment that records exist,
 * shown with a word and never in a success colour (no green: it is not a pass); the reminder never feeds the gap list. Do not wire this to real data, a session or an action, do not add
 * a control the real page lacks, keep every control at a 48 px hit area. Delete the four preview files (this component and its .module.css, app/(dashboard)/admin/iso/preview/page.tsx,
 * tests/unit/isoPreview.test.ts) to remove it completely.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  Button, Field, Input, LoadingState, Panel, Popover, ScrollTable, SegmentedControl, StatusBadge, Switch, ToastProvider, cx, premiumTokens, srOnly, tabularNumbers, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { fmtDate } from "@/lib/dates";
import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { buildGapChecklist, EMPTY_EVIDENCE, gapStatusLabel } from "@/lib/iso/gap-checklist";
import type { GapEvidence, GapStatus } from "@/lib/iso/gap-checklist";
import { canSeeIso, ISO_OFF_NOTICE } from "@/lib/iso/iso-switch";
import type { NcrRow } from "@/lib/jobs/ncr-register";
import type { UserRole } from "@/types";

import s from "./IsoPreview.module.css";

export type Role = UserRole;
export type Screen = "ready" | "off" | "loading-settings" | "loading-data" | "partly-unread" | "all-unread" | "no-overdue" | "not-available" | "busy";

/* ---------- the real page's wording (components/iso/iso-pack-view.tsx and iso-switch-card.tsx), pinned by the test ---------- */
export const COMPANY_NAME = "Fernhill Engineering Ltd";
export const PAGE_TITLE = "ISO templates";
export const SWITCH_LABEL = "ISO 9001 draft templates";
export const SWITCH_TEXT = "Off until you switch it on. Draft documents and a self-check list for your own review. They only read records Tolra already keeps. Admin only.";
export const DISCLAIMER = "Template and self-check aid. Needs company review. Not certification evidence.";
export const NOT_AVAILABLE_NOTE = "The ISO templates are not available in this mode.";
export const PACK_HINT = "All nine documents and the gap checklist, as PDFs.";
export const REMINDER_NOTE = "An internal reminder only. It does not change the gap checklist.";
export const DAYS_LABEL = "Remind after (days open, this visit only)";
export const NCR_UNREAD = "Nonconformance records could not be read.";
export const PDF_ERROR = "Couldn't make the PDF. Try again.";
export const ZIP_ERROR = "Couldn't make the zip. Try again.";
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
export const PREVIEW_TODAY = "2026-11-23";

/** The real page's subtitle for a company name. */
export const subtitleFor = (companyName: string) => `Branded draft templates and a self-check list for ${companyName}. ${DISCLAIMER}`;
/** The real page's note when records could not be read. */
export const unreadNote = (unread: readonly string[]) => `Some records could not be read (${unread.join(", ")}). Those clauses show as not evidenced.`;
/** The real page's empty answer for the reminder. */
export const noOverdueText = (days: number) => `No confirmed NCR has been open for more than ${days} days.`;

/* ---------- the reminder rule, mirrored from lib/iso/ncr-review-reminder.ts (pinned to its source and compared with the real function by the test) ---------- */
export const REVIEW_DAYS_DEFAULT = 7;
/** The typed override as a whole number of days (1 or more); anything else is the default. */
export function reviewDays(typed: string | number | null | undefined): number {
  const n = typeof typed === "number" ? typed : Number(String(typed ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : REVIEW_DAYS_DEFAULT;
}
/** Whole calendar days from one YYYY-MM-DD date to another (never negative): lib/jobs/ncr-register.ts daysBetween. */
export function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}
export type PreviewNcr = Pick<NcrRow, "key" | "record" | "raisedAt" | "raisedDate" | "reason" | "open" | "notLinked" | "recordClass">;
export type OverdueNcr = { row: PreviewNcr; daysOpen: number };
/** Confirmed, open NCRs raised more than `days` calendar days before `today`, oldest first. */
export function overdueNcrs(rows: PreviewNcr[], today: string, days = REVIEW_DAYS_DEFAULT): OverdueNcr[] {
  return rows
    .filter((r) => r.recordClass === "Confirmed NCR" && r.open && !r.notLinked && Boolean(r.raisedDate))
    .map((row) => ({ row, daysOpen: daysBetween(row.raisedDate, today) }))
    .filter((o) => o.daysOpen > days)
    .sort((a, b) => b.daysOpen - a.daysOpen || a.row.key.localeCompare(b.row.key));
}

/* ---------- sample data (fictional) ---------- */
const NCR = (key: string, record: string, raisedDate: string, reason: string, extra: Partial<PreviewNcr> = {}): PreviewNcr => ({
  key, record, raisedAt: `${raisedDate}T09:30:00Z`, raisedDate, reason, open: true, notLinked: false, recordClass: "Confirmed NCR", ...extra,
});
/** Sample register rows: two are open longer than the default seven days; one is open for six days; one closed; one "Not linked" (never a confirmed NCR). */
export const SAMPLE_NCRS: PreviewNcr[] = [
  NCR("rework:r1", "J-0412 Rework 2026-10-26", "2026-10-26", "Bore out of tolerance on three parts."),
  NCR("rework:r2", "J-0398 Inspection fail 2026-11-09", "2026-11-09", "Thread gauge would not go on the second batch."),
  NCR("problem:p1", "J-0430 Problem 2026-11-17", "2026-11-17", "Wrong material certificate supplied."),
  NCR("rework:r3", "J-0377 Rework 2026-11-02", "2026-11-02", "Surface finish below the drawing.", { open: false }),
  NCR("fail:f1", "J-0401 Inspection fail (no rework) 2026-11-05", "2026-11-05", "Measured notes only.", { notLinked: true, open: false, recordClass: "Not linked" }),
];
/** Sample record counts the real buildGapChecklist turns into rows: Records present (7.2, 8.5.2), Minor (7.5.3, 8.4), Major (8.2, 8.5.1), and the rest Not evidenced. */
export const SAMPLE_EVIDENCE: GapEvidence = {
  inspectors: { current: 3, withReason: 3 },
  changeHistoryPresent: true,
  drawingRevision: { flagged: 4, finished: 2, finishedMissing: 1, truncated: false },
  suppliers: { total: 12, approved: 10, conditional: 1, blocked: 1, truncated: false },
  traceability: { flagged: 6, finished: 3, finishedMissing: 0, truncated: false },
};
/** Only the supplier read failed: those clauses fall back to Not evidenced (the real rules). */
export const PARTLY_UNREAD_EVIDENCE: GapEvidence = { ...SAMPLE_EVIDENCE, suppliers: null, traceability: null };

/** Status to badge: a word always, never a success colour (Records present is a self-assessment that records exist, not a pass). */
export const STATUS_TONE: Record<GapStatus, StatusTone> = { Met: "info", Minor: "warn", Major: "danger", "Not evidenced by Tolra": "neutral" };

type View = {
  settingsLoaded: boolean; on: boolean; available: boolean; dataReady: boolean; busy: boolean;
  evidence: GapEvidence; unread: string[]; ncrRows: PreviewNcr[] | null;
};
/** What each Screen state draws (the real page's four early returns, then the ready page and its three read outcomes). */
export function viewFor(screen: Screen): View {
  const base: View = { settingsLoaded: true, on: true, available: true, dataReady: true, busy: false, evidence: SAMPLE_EVIDENCE, unread: [], ncrRows: SAMPLE_NCRS };
  switch (screen) {
    case "off": return { ...base, on: false };
    case "loading-settings": return { ...base, settingsLoaded: false };
    case "loading-data": return { ...base, dataReady: false };
    case "partly-unread": return { ...base, evidence: PARTLY_UNREAD_EVIDENCE, unread: ["suppliers", "traceable jobs"] };
    case "all-unread": return { ...base, evidence: EMPTY_EVIDENCE, unread: ["all records"], ncrRows: null };
    case "no-overdue": return { ...base, ncrRows: SAMPLE_NCRS.filter((r) => r.key !== "rework:r1" && r.key !== "rework:r2") };
    case "not-available": return { ...base, available: false };
    case "busy": return { ...base, busy: true };
    default: return base;
  }
}
export const canUseIso = (role: Role): boolean => canSeeIso(role);

const SCREENS: Array<{ v: Screen; label: string }> = [
  { v: "ready", label: "Ready (switched on)" },
  { v: "off", label: "Switched off (the default)" },
  { v: "loading-settings", label: "Loading company settings" },
  { v: "loading-data", label: "Reading records" },
  { v: "partly-unread", label: "Some records unreadable" },
  { v: "all-unread", label: "No records readable" },
  { v: "no-overdue", label: "No NCR over the limit" },
  { v: "busy", label: "A file is being made" },
  { v: "not-available", label: "Not available in this mode" },
];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }));

/** Narrow screens (640 px and under) draw the long tables as stacked records so no column hides behind a sideways scroll. */
export const NARROW_QUERY = "(max-width: 640px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(NARROW_QUERY); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

export default function IsoPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [daysText, setDaysText] = useState(String(REVIEW_DAYS_DEFAULT));
  const view = useMemo(() => viewFor(screen), [screen]);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const narrow = useNarrow();
  const denied = !canUseIso(role);
  const gapRows = useMemo(() => buildGapChecklist(view.evidence), [view.evidence]);
  const days = reviewDays(daysText);
  const overdue = useMemo(() => (view.ncrRows ? overdueNcrs(view.ncrRows, PREVIEW_TODAY, days) : []), [view.ncrRows, days]);
  const pickScreen = (v: Screen) => { toast.clear(); setScreen(v); };
  const reset = () => { toast.clear(); setScreen("ready"); setRole("admin"); setDaysText(String(REVIEW_DAYS_DEFAULT)); };
  const off = !denied && view.settingsLoaded && !view.on;
  const ready = !denied && view.settingsLoaded && view.on && view.available;
  const showSubtitle = ready;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="iso-preview" data-role={role} data-screen={screen}>
      <header className={s.head}>
        <div className={s.titleBlock}>
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
                  {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => pickScreen(x.v)}>{x.label}</button>)}
                </div>
                <p className={s.dockLabel}>Sample message</p>
                <Button size="sm" variant="secondary" data-testid="dock-error" onClick={() => toast.show({ title: PDF_ERROR, tone: "error" })}>Show the PDF error message</Button>
                <Button size="sm" variant="secondary" data-testid="dock-reset" onClick={reset}>Reset preview</Button>
              </div>
            </Popover>
          </div>
          <p className={s.subtitle}>
            {denied ? "Redirecting you back to the dashboard." : showSubtitle ? subtitleFor(COMPANY_NAME) : null}
          </p>
        </div>
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied" aria-label="Access denied">
          <p className={s.deniedNote}>Only an admin can open the ISO templates.</p>
          <p className={s.deniedPreview}>Preview only: no redirect happens here. The ISO templates are for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : !view.settingsLoaded ? (
        <LoadingState label="Loading ISO templates" rows={5} />
      ) : (
        <>
          {off ? <p className={s.offNotice} data-testid="off-notice">{ISO_OFF_NOTICE}</p> : null}
          <SwitchPanel on={view.on} onToggle={(next) => preview(`${SWITCH_LABEL} would be switched ${next ? "on" : "off"} for your company. The switch stays as drawn here.`)} />
          {!view.on ? null : !view.available ? (
            <p className={s.offNotice} data-testid="not-available">{NOT_AVAILABLE_NOTE}</p>
          ) : !view.dataReady ? (
            <LoadingState label="Reading your records" rows={6} />
          ) : (
            <>
              {view.unread.length ? <p className={cx(s.hint, s.unread)} data-testid="unread-note">{unreadNote(view.unread)}</p> : null}
              <div className={s.packBar}>
                <Button variant="primary" disabled={view.busy} data-testid="download-pack" onClick={() => preview("The pack (a zip of all nine documents and the gap checklist) would download.")}>Download pack (zip)</Button>
                <span className={s.hint}>{PACK_HINT}</span>
              </div>
              <Panel title="Documents" bare data-testid="documents-panel">
                <ScrollTable label="Documents table" dense>
                  <thead><tr><th scope="col">Document</th><th scope="col">Clause</th><th scope="col"><span className={srOnly}>Download</span></th></tr></thead>
                  <tbody>
                    {ISO_DOCUMENTS.map((d) => (
                      <tr key={d.id}>
                        <td className={s.cellStrong}>{d.title}</td>
                        <td className={cx(s.clause, tabularNumbers)}>{d.clause}</td>
                        <td className={s.right}>
                          <Button size="sm" variant="secondary" disabled={view.busy} aria-label={`Download PDF: ${d.title}`} data-testid={`doc-${d.id}`} onClick={() => preview(`${d.title} would download as a PDF.`)}>Download PDF</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
              </Panel>
              <Panel
                title="Gap checklist"
                bare
                data-testid="gap-panel"
                actions={
                  <div className={s.btnRow}>
                    <Button size="sm" variant="secondary" disabled={view.busy} data-testid="gap-pdf" onClick={() => preview("The gap checklist would download as a PDF.")}>Download checklist (PDF)</Button>
                    <Button size="sm" variant="secondary" data-testid="gap-csv" onClick={() => preview("The gap checklist would download as a CSV file.")}>Download checklist (CSV)</Button>
                  </div>
                }
              >
                {narrow ? (
                  <ul className={s.records} aria-label="Gap checklist">
                    {gapRows.map((r) => (
                      <li key={r.clause} className={s.record}>
                        <div className={s.recordTop}><span className={cx(s.cellStrong, tabularNumbers)}>Clause {r.clause}</span><StatusBadge tone={STATUS_TONE[r.status]}>{gapStatusLabel(r.status)}</StatusBadge></div>
                        <p className={s.recordTitle}>{r.requirement}</p>
                        <p className={s.recordBasis}>{r.basis}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                <ScrollTable label="Gap checklist table" dense>
                  <thead><tr><th scope="col">Clause</th><th scope="col">Requirement</th><th scope="col">Status</th><th scope="col">Basis</th></tr></thead>
                  <tbody>
                    {gapRows.map((r) => (
                      <tr key={r.clause}>
                        <td className={cx(s.clause, s.cellStrong, tabularNumbers)}>{r.clause}</td>
                        <td className={s.requirement}>{r.requirement}</td>
                        <td className={s.status}><StatusBadge tone={STATUS_TONE[r.status]}>{gapStatusLabel(r.status)}</StatusBadge></td>
                        <td className={s.basis}>{r.basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
                )}
              </Panel>
              <Panel title="NCR review reminder" data-testid="reminder-panel">
                <div className={s.reminderBody}>
                  <p className={s.hint}>{REMINDER_NOTE}</p>
                  <Field label={DAYS_LABEL} className={s.daysField}>
                    <Input inputMode="numeric" value={daysText} onChange={(e) => setDaysText(e.target.value)} data-testid="days-input" />
                  </Field>
                  {!view.ncrRows ? <p className={s.reminderEmpty} data-testid="ncr-unread">{NCR_UNREAD}</p>
                    : !overdue.length ? <p className={s.reminderEmpty} data-testid="ncr-none">{noOverdueText(days)}</p> : (
                      narrow ? (
                        <ul className={s.records} aria-label="NCRs open for too long">
                          {overdue.map((o) => (
                            <li key={o.row.key} className={s.record}>
                              <div className={s.recordTop}><span className={s.cellStrong}>{o.row.record}</span></div>
                              <p className={s.recordBasis}>Raised {fmtDate(o.row.raisedAt)}, <span className={tabularNumbers}>{o.daysOpen}</span> days open</p>
                              <p className={s.recordBasis}>{o.row.reason}</p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                      <ScrollTable label="NCRs open for too long" dense>
                        <thead><tr><th scope="col">Record</th><th scope="col">Raised</th><th scope="col" className={s.right}>Days open</th><th scope="col">Reason</th></tr></thead>
                        <tbody>
                          {overdue.map((o) => (
                            <tr key={o.row.key}>
                              <td className={s.cellStrong}>{o.row.record}</td>
                              <td className={cx(s.clause, tabularNumbers)}>{fmtDate(o.row.raisedAt)}</td>
                              <td className={cx(s.right, tabularNumbers)}>{o.daysOpen}</td>
                              <td className={s.requirement}>{o.row.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </ScrollTable>
                      )
                    )}
                </div>
              </Panel>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** The real switch card: heading, its explanation and one switch row. Preview: the switch only answers with the toast. */
function SwitchPanel({ on, onToggle }: { on: boolean; onToggle: (next: boolean) => void }) {
  return (
    <Panel title={SWITCH_LABEL} data-testid="iso-switch-card">
      <p className={s.body}>{SWITCH_TEXT}</p>
      <div className={s.switchWrap}>
        <Switch label={SWITCH_LABEL} checked={on} onChange={onToggle} data-testid="iso-switch" />
      </div>
    </Panel>
  );
}
