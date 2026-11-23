"use client";

/**
 * BOUNDARY (Customer portal, Module 10, PREVIEW ONLY, customer facing and security sensitive: nothing here is wired to anything).
 * Inputs: none from the server. Everything shown is fictional sample data (made-up companies and people, no e-mail address anywhere, as of 23/11/2026) held in this file,
 * plus the person's clicks. Outputs: the customer portal look-and-feel prototype: sign in, check your e-mail, enter your code, the one generic refusal, and the signed-in
 * Home, Quotes and Jobs screens (with their empty, loading and switched-off states). Its only state is LOCAL UI state (which screen to draw, which tabs, which sample data).
 * It contains NO authentication, NO session, NO cookie, NO token, NO API call, NO fetch, NO real code check, NO e-mail sending, NO rate limit, NO logging and NO storage.
 * The "Signed in screens" choice in Preview screens only changes which screen is drawn; it signs nobody in and grants nothing.
 * The sign-in form and the code form keep their real native checks (type email, 8 digits) but no input has a name and nothing is read from them: the typed value is never
 * put in state, in the page address, in a toast or anywhere else, and the form is cleared. Every action answers with the neutral "Preview only" toast and nothing changes.
 * Run-time imports from the app are pure modules only: lib/money (gbp) and components/portal/format (portalDate); everything else from lib/portal is a TYPE. lib/portal/types.ts
 * and lib/portal/refusal.ts are server-only, so the words they and the real pages hold are mirrored here and pinned to the source text by tests/unit/portal-preview.test.ts.
 * v2 (owner approved, STRUCTURAL-CHANGES-BRIEF 5, 10, 11): the shared PreviewBar replaces the yellow tag and bar; the signed in header carries the shop's name and a navy monogram (fictional,
 * no logo); Home gets two summary cards that COUNT ONLY rows the Quotes and Jobs screens already show ("Quotes to look at" = quotes whose status word is "Awaiting your answer", "Jobs in progress"
 * = jobs whose stage word is "In progress"), each linking to that existing screen, plus a "Latest" list of the first rows of those same lists; quote and job cards on a phone are the shared
 * StackedRows; the title is the shared PageHeader; type uses the v4 scale. No new data source, no new action, no account or contact wording, no `sends`, no e-mail.
 * MUST NOT CHANGE: wording, screens, columns, tabs-per-permission and the "one generic refusal" rule mirror today's portal. Never show, vary by, or invent: whether a contact,
 * code, document or account exists, the `sends` list, an e-mail address, an id, a token, a reason for a refusal. Do not wire this to real data, a session or an action; do not
 * add a control the real portal lacks; keep every control at a 48 px hit area. Delete the four preview files (this component and its .module.css,
 * app/portal/preview/page.tsx, tests/unit/portal-preview.test.ts) to remove it completely.
 */

import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Button, Field, Input, LoadingState, PageHeader, PreviewBar, ScrollTable, Select, StackedRows, StatTile, StatTiles, StatusBadge, ToastProvider, cx, premiumTokens, tabularNumbers, typeScale, useToast } from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { portalDate } from "@/components/portal/format";
import { gbp } from "@/lib/money";
import type { PortalJob, PortalJobStage, PortalPermission, PortalQuote, PortalSession } from "@/lib/portal/types";

import s from "./PortalPreview.module.css";

/* ---------- the real portal's wording (mirrored from server-only or inline sources; every string is pinned to its source by the test) ---------- */
export const COPY = {
  signinTitle: "Sign in to the customer portal",
  signinIntro: "Enter your e-mail address and we will send you a sign-in link and code.",
  emailLabel: "E-mail address",
  sendLabel: "Send me a link and code",
  sentTitle: "Check your e-mail",
  sentText: "If this address can use the portal, we've e-mailed a link and code. They work once, for 10 minutes.",
  backLabel: "Back to sign in",
  codeTitle: "Enter your sign-in code",
  codeLabel: "8-digit code from the e-mail",
  codeRefused: "We couldn't verify your code. Please try again or request a new code.",
  newCodeLabel: "Request a new code",
  codeSubmit: "Sign in",
  refusalTitle: "We couldn't sign you in",
  refusalMessage: "This link or code didn't work. Ask the company that invited you to send a new sign-in link.",
  home: "Home",
  signOut: "Sign out",
  homeText: "Use the tabs above to see your documents.",
  quotesEmpty: "No quotes to show.",
  jobsEmpty: "No jobs to show.",
  notFoundTitle: "Page not found",
  notFoundText: "We can't find this page, or you don't have access to it.",
} as const;

export const welcome = (displayName: string) => `Welcome, ${displayName}`;
export const homeLine = (s: Pick<PortalSession, "customerName" | "companyName">) => `${s.customerName} at ${s.companyName}.`;

/** components/portal/quotes-table.tsx STATUS and jobs-table.tsx STAGE: the words the customer sees. */
export const QUOTE_STATUS: Record<PortalQuote["status"], string> = { sent: "Awaiting your answer", accepted: "Accepted", rejected: "Declined" };
export const JOB_STAGE: Record<PortalJobStage, string> = { not_started: "Not started", in_progress: "In progress", complete: "Complete" };
/** Tone is this preview's design choice only (the real portal has plain text). Declined is neutral on purpose: it is the customer's own answer, not a fault. */
export const QUOTE_TONE: Record<PortalQuote["status"], StatusTone> = { sent: "info", accepted: "ok", rejected: "neutral" };
export const JOB_TONE: Record<PortalJobStage, StatusTone> = { not_started: "neutral", in_progress: "progress", complete: "ok" };
export const QUOTE_COLUMNS = ["Quote", "Status", "Sent", "Valid until", "Your PO", "Total"] as const;
export const JOB_COLUMNS = ["Job", "Your PO", "Due", "Stage"] as const;

/** components/portal/portal-frame.tsx TABS: a tab exists only for a permission the contact holds. */
export const TABS: { permission: PortalPermission; screen: "quotes" | "jobs"; label: string }[] = [
  { permission: "quotes", screen: "quotes", label: "Quotes" },
  { permission: "jobs", screen: "jobs", label: "Jobs" },
];

/** The neutral answer to every action. It never says anything was saved, sent, checked or signed in. */
export const PREVIEW_ANSWERS = {
  send: { title: "Preview only", detail: "Nothing was sent." },
  code: { title: "Preview only", detail: "Nothing was checked and nobody was signed in." },
  signOut: { title: "Preview only", detail: "Nothing was changed." },
} as const;

/* ---------- sample data (fictional; no e-mail addresses; the real portal never shows one) ---------- */
export type PreviewSession = Pick<PortalSession, "displayName" | "companyName" | "customerName">;
export type SampleKind = "typical" | "long";
export interface Sample { session: PreviewSession; quotes: PortalQuote[]; jobs: PortalJob[] }

const TYPICAL: Sample = {
  session: { displayName: "Dana", customerName: "Marlowe Packaging Ltd", companyName: "Fernhill Engineering Ltd" },
  quotes: [
    { quoteRef: "QUO-0428", status: "sent", sentAt: "2026-11-20T09:12:00Z", validUntil: "2026-12-18T00:00:00Z", customerPo: null, totalValue: 4860 },
    { quoteRef: "QUO-0421", status: "sent", sentAt: "2026-11-12T14:03:00Z", validUntil: "2026-12-10T00:00:00Z", customerPo: "MP-77120", totalValue: 1234.5 },
    { quoteRef: "QUO-0412", status: "accepted", sentAt: "2026-10-29T10:40:00Z", validUntil: "2026-11-26T00:00:00Z", customerPo: "MP-76988", totalValue: 18250 },
    { quoteRef: "QUO-0399", status: "accepted", sentAt: "2026-10-04T08:55:00Z", validUntil: "2026-11-01T00:00:00Z", customerPo: "MP-76702", totalValue: 972.4 },
    { quoteRef: "QUO-0371", status: "rejected", sentAt: "2026-09-15T16:20:00Z", validUntil: null, customerPo: null, totalValue: 52300 },
    { quoteRef: "QUO-0344", status: "rejected", sentAt: null, validUntil: null, customerPo: null, totalValue: null },
  ],
  jobs: [
    { jobNo: "JOB-3318", customerPo: "MP-77120", dueDate: "2026-12-04T00:00:00Z", stage: "not_started" },
    { jobNo: "JOB-3304", customerPo: "MP-76988", dueDate: "2026-11-30T00:00:00Z", stage: "in_progress" },
    { jobNo: "JOB-3291", customerPo: "MP-76702", dueDate: "2026-11-18T00:00:00Z", stage: "complete" },
    { jobNo: "JOB-3277", customerPo: null, dueDate: null, stage: "in_progress" },
    { jobNo: "JOB-3250", customerPo: "MP-76311", dueDate: "2026-10-23T00:00:00Z", stage: "complete" },
  ],
};

const LONG: Sample = {
  session: {
    displayName: "Bartholomew Featherstonehaugh-Wolstenholme",
    customerName: "Ravensworth, Pennington & Llewellyn-Thistlethwaite Precision Components Limited",
    companyName: "Hartley Brook Engineering and Fabrication Partnership (Northern Division)",
  },
  quotes: [
    { quoteRef: "QUO-2026-0428-REV-C-LONG-REFERENCE-EXAMPLE", status: "sent", sentAt: "2026-11-20T09:12:00Z", validUntil: "2026-12-18T00:00:00Z", customerPo: "RPLT/NORTH-WORKS/ENGINEERING/2026/0045678-REV2", totalValue: 1234567.5 },
    { quoteRef: "QUO-0421", status: "accepted", sentAt: "2026-11-12T14:03:00Z", validUntil: "2026-12-10T00:00:00Z", customerPo: "MP-77120", totalValue: 0 },
    { quoteRef: "QUO-0399", status: "rejected", sentAt: "2026-10-04T08:55:00Z", validUntil: null, customerPo: null, totalValue: null },
  ],
  jobs: [
    { jobNo: "JOB-2026-3318-ASSEMBLY-AND-FINISH-LONG-NUMBER", customerPo: "RPLT/NORTH-WORKS/ENGINEERING/2026/0045678-REV2", dueDate: "2026-12-04T00:00:00Z", stage: "in_progress" },
    { jobNo: "JOB-3304", customerPo: null, dueDate: null, stage: "not_started" },
    { jobNo: "JOB-3291", customerPo: "MP-76702", dueDate: "2026-11-18T00:00:00Z", stage: "complete" },
  ],
};
export const sampleFor = (kind: SampleKind): Sample => (kind === "long" ? LONG : TYPICAL);

/* ---------- screens ---------- */
export type Screen = "signin" | "sent" | "code" | "code-refused" | "refused" | "home" | "quotes" | "jobs" | "quotes-empty" | "jobs-empty" | "loading" | "off";
export type TabsKind = "both" | "quotes" | "jobs";

export const SIGNED_OUT: Screen[] = ["signin", "sent", "code", "code-refused", "refused"];
export const SIGNED_IN: Screen[] = ["home", "quotes", "jobs", "quotes-empty", "jobs-empty", "loading"];
export const SCREEN_LABEL: Record<Screen, string> = {
  signin: "Sign in",
  sent: "Check your e-mail",
  code: "Enter your sign-in code",
  "code-refused": "Code did not work",
  refused: "We couldn't sign you in (the one refusal)",
  home: "Home",
  quotes: "Quotes",
  jobs: "Jobs",
  "quotes-empty": "Quotes, none to show",
  "jobs-empty": "Jobs, none to show",
  loading: "Loading (not in today's portal)",
  off: "Page not found (portal off, or no access)",
};

export const tabsFor = (kind: TabsKind): PortalPermission[] => (kind === "quotes" ? ["quotes"] : kind === "jobs" ? ["jobs"] : ["quotes", "jobs"]);

/** Pure: the screen actually drawn. A signed-in page whose permission the contact lacks is the 404 (real pages call notFound()), never a list. */
export function effectiveScreen(screen: Screen, permissions: PortalPermission[]): Screen {
  if ((screen === "quotes" || screen === "quotes-empty") && !permissions.includes("quotes")) return "off";
  if ((screen === "jobs" || screen === "jobs-empty") && !permissions.includes("jobs")) return "off";
  return screen;
}
export const isSignedIn = (screen: Screen): boolean => SIGNED_IN.includes(screen);

/** Pure: what the page heading says. */
export function titleFor(screen: Screen, session: PreviewSession): string {
  switch (screen) {
    case "signin": return COPY.signinTitle;
    case "sent": return COPY.sentTitle;
    case "code": case "code-refused": return COPY.codeTitle;
    case "refused": return COPY.refusalTitle;
    case "home": return welcome(session.displayName);
    case "quotes": case "quotes-empty": return "Quotes";
    case "jobs": case "jobs-empty": return "Jobs";
    case "loading": return "Quotes";
    case "off": return COPY.notFoundTitle;
  }
}

/** Pure: "-" for a missing value, as the real tables show it. */
export const orDash = (value: string | null): string => (value === null || value === "" ? "-" : value);
export const money = (value: number | null): string => (value === null ? "-" : gbp(value));

/** Pure: the shop's monogram for the header, the first letters of its first two words (a navy tile, never a logo). */
export function monogram(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("");
}

export const LATEST_COUNT = 3;
export interface HomeSummary {
  quotesToLookAt: number; quotesTotal: number; jobsInProgress: number; jobsTotal: number;
  latestQuotes: PortalQuote[]; latestJobs: PortalJob[];
}
/** Pure: Home counts ONLY rows the Quotes and Jobs screens already list (same rows, same order, same status and stage words); a section the contact has no permission for is not summarised. */
export function homeSummary(data: Pick<Sample, "quotes" | "jobs">, permissions: PortalPermission[]): HomeSummary {
  const q = permissions.includes("quotes") ? data.quotes : [];
  const j = permissions.includes("jobs") ? data.jobs : [];
  return {
    quotesToLookAt: q.filter((x) => x.status === "sent").length, quotesTotal: q.length,
    jobsInProgress: j.filter((x) => x.stage === "in_progress").length, jobsTotal: j.length,
    latestQuotes: q.slice(0, LATEST_COUNT), latestJobs: j.slice(0, LATEST_COUNT),
  };
}

/* ---------- small pieces ---------- */
function Dash() {
  return (
    <>
      <span aria-hidden="true" className={s.dash}>-</span>
      <span className={s.srOnly}>Not given</span>
    </>
  );
}
const Val = ({ v }: { v: string | null }) => (v === null || v === "" ? <Dash /> : <>{v}</>);
const DateVal = ({ v }: { v: string | null }) => (portalDate(v) === "-" ? <Dash /> : <span className={tabularNumbers}>{portalDate(v)}</span>);
const MoneyVal = ({ v }: { v: number | null }) => (v === null ? <Dash /> : <span className={tabularNumbers}>{gbp(v)}</span>);

function Link({ children, onClick, testId, className, current }: { children: ReactNode; onClick: () => void; testId?: string; className?: string; current?: boolean }) {
  return (
    <a href="#preview" className={cx(s.link, className)} data-testid={testId} aria-current={current ? "page" : undefined} onClick={(e) => { e.preventDefault(); onClick(); }}>{children}</a>
  );
}

/** Clears the form after a valid submit so nothing typed is held. The values are never read. */
function useNeutralSubmit(answer: { title: string; detail: string }) {
  const toast = useToast();
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    toast.show({ title: answer.title, detail: answer.detail });
    e.currentTarget.reset();
  };
}

function SigninForm() {
  const onSubmit = useNeutralSubmit(PREVIEW_ANSWERS.send);
  return (
    <form className={s.form} onSubmit={onSubmit} data-testid="portal-signin-form">
      <Field label={COPY.emailLabel}>
        <Input type="email" autoComplete="email" required maxLength={254} className={s.big} />
      </Field>
      <Button type="submit" variant="primary" size="lg" className={s.submit}>{COPY.sendLabel}</Button>
    </form>
  );
}

function CodeForm({ refusedId }: { refusedId?: string }) {
  const onSubmit = useNeutralSubmit(PREVIEW_ANSWERS.code);
  return (
    <form className={s.form} onSubmit={onSubmit} data-testid="portal-code-form">
      <Field label={COPY.codeLabel}>
        <Input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} required aria-describedby={refusedId} className={cx(s.big, s.codeInput, tabularNumbers)} />
      </Field>
      <Button type="submit" variant="primary" size="lg" className={s.submit}>{COPY.codeSubmit}</Button>
    </form>
  );
}

function Quotes({ quotes }: { quotes: PortalQuote[] }) {
  if (quotes.length === 0) return <p className={s.empty} data-testid="portal-quotes-empty">{COPY.quotesEmpty}</p>;
  return (
    <>
      <ScrollTable label="Your quotes" className={cx(s.tbl, s.onlyWide)}>
        <thead>
          <tr>{QUOTE_COLUMNS.map((c) => <th key={c} scope="col" className={c === "Total" ? s.right : undefined}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {quotes.map((q) => (
            <tr key={q.quoteRef}>
              <td className={cx(s.ref, tabularNumbers)}>{q.quoteRef}</td>
              <td><StatusBadge tone={QUOTE_TONE[q.status]}>{QUOTE_STATUS[q.status]}</StatusBadge></td>
              <td><DateVal v={q.sentAt} /></td>
              <td><DateVal v={q.validUntil} /></td>
              <td className={s.po}><Val v={q.customerPo} /></td>
              <td className={s.right}><MoneyVal v={q.totalValue} /></td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      <StackedRows
        className={s.onlyNarrow}
        label="Your quotes"
        data-testid="portal-quotes"
        rows={quotes.map((q) => ({
          id: q.quoteRef,
          title: <span className={tabularNumbers}>{q.quoteRef}</span>,
          status: <StatusBadge tone={QUOTE_TONE[q.status]}>{QUOTE_STATUS[q.status]}</StatusBadge>,
          fields: [
            { label: "Sent", value: <DateVal v={q.sentAt} /> },
            { label: "Valid until", value: <DateVal v={q.validUntil} /> },
            { label: "Your PO", value: <span className={s.po}><Val v={q.customerPo} /></span> },
            { label: "Total", value: <MoneyVal v={q.totalValue} /> },
          ],
        }))}
      />
    </>
  );
}

function Jobs({ jobs }: { jobs: PortalJob[] }) {
  if (jobs.length === 0) return <p className={s.empty} data-testid="portal-jobs-empty">{COPY.jobsEmpty}</p>;
  return (
    <>
      <ScrollTable label="Your jobs" className={cx(s.tbl, s.onlyWide)}>
        <thead>
          <tr>{JOB_COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.jobNo}>
              <td className={cx(s.ref, tabularNumbers)}>{j.jobNo}</td>
              <td className={s.po}><Val v={j.customerPo} /></td>
              <td><DateVal v={j.dueDate} /></td>
              <td><StatusBadge tone={JOB_TONE[j.stage]}>{JOB_STAGE[j.stage]}</StatusBadge></td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      <StackedRows
        className={s.onlyNarrow}
        label="Your jobs"
        data-testid="portal-jobs"
        rows={jobs.map((j) => ({
          id: j.jobNo,
          title: <span className={tabularNumbers}>{j.jobNo}</span>,
          status: <StatusBadge tone={JOB_TONE[j.stage]}>{JOB_STAGE[j.stage]}</StatusBadge>,
          fields: [
            { label: "Your PO", value: <span className={s.po}><Val v={j.customerPo} /></span> },
            { label: "Due", value: <DateVal v={j.dueDate} /> },
          ],
        }))}
      />
    </>
  );
}

function LatestList({ title, label, rows, onAll, allLabel, testId }: { title: string; label: string; rows: Array<{ id: string; ref: string; word: string; tone: StatusTone; date: string | null; dateLabel: string }>; onAll: () => void; allLabel: string; testId: string }) {
  if (rows.length === 0) return null;
  return (
    <section className={s.latest} aria-labelledby={`${testId}-h`} data-testid={testId}>
      <div className={s.latestHead}>
        <h2 id={`${testId}-h`} className={cx(typeScale.section, s.h2)}>{title}</h2>
        <Link onClick={onAll} className={s.allLink}>{allLabel}</Link>
      </div>
      <ul className={s.latestList} aria-label={label}>
        {rows.map((r) => (
          <li key={r.id} className={s.latestRow}>
            <span className={cx(typeScale.name, tabularNumbers, s.latestRef)}>{r.ref}</span>
            <StatusBadge tone={r.tone} mode="text">{r.word}</StatusBadge>
            <span className={cx(typeScale.secondary, tabularNumbers, s.latestDate)}>{r.dateLabel} <DateVal v={r.date} /></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Home({ data, permissions, go }: { data: Sample; permissions: PortalPermission[]; go: (next: Screen) => void }) {
  const sum = homeSummary(data, permissions);
  const hasQuotes = permissions.includes("quotes");
  const hasJobs = permissions.includes("jobs");
  const columns = hasQuotes && hasJobs ? 2 : 1;
  return (
    <div className={s.homeWrap} data-testid="portal-home">
      <p className={s.home}>
        <strong>{data.session.customerName}</strong> at <strong>{data.session.companyName}</strong>. {COPY.homeText}
      </p>
      {hasQuotes || hasJobs ? (
        <StatTiles label="At a glance" columns={columns} className={s.tiles}>
          {hasQuotes ? (
            <StatTile label="Quotes to look at" value={sum.quotesToLookAt} hint={`${QUOTE_STATUS.sent} (${sum.quotesTotal} quotes in all)`} href="#preview" onClick={(e) => { e.preventDefault(); go("quotes"); }} data-testid="portal-tile-quotes" />
          ) : null}
          {hasJobs ? (
            <StatTile label="Jobs in progress" value={sum.jobsInProgress} hint={`${sum.jobsTotal} jobs in all`} href="#preview" onClick={(e) => { e.preventDefault(); go("jobs"); }} data-testid="portal-tile-jobs" />
          ) : null}
        </StatTiles>
      ) : null}
      <div className={cx(s.latestGrid, columns === 1 && s.latestOne)}>
        {hasQuotes ? (
          <LatestList
            title="Latest quotes" label="Latest quotes" testId="portal-latest-quotes" allLabel="All quotes" onAll={() => go("quotes")}
            rows={sum.latestQuotes.map((q) => ({ id: q.quoteRef, ref: q.quoteRef, word: QUOTE_STATUS[q.status], tone: QUOTE_TONE[q.status], date: q.sentAt, dateLabel: "Sent" }))}
          />
        ) : null}
        {hasJobs ? (
          <LatestList
            title="Latest jobs" label="Latest jobs" testId="portal-latest-jobs" allLabel="All jobs" onAll={() => go("jobs")}
            rows={sum.latestJobs.map((j) => ({ id: j.jobNo, ref: j.jobNo, word: JOB_STAGE[j.stage], tone: JOB_TONE[j.stage], date: j.dueDate, dateLabel: "Due" }))}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ---------- the preview ---------- */
function Stage() {
  const toast = useToast();
  const [screen, setScreen] = useState<Screen>("signin");
  const [tabs, setTabs] = useState<TabsKind>("both");
  const [kind, setKind] = useState<SampleKind>("typical");
  const [controlsOpen, setControlsOpen] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);

  const permissions = tabsFor(tabs);
  const shown = effectiveScreen(screen, permissions);
  const data = sampleFor(kind);
  const signedIn = isSignedIn(shown);
  const title = titleFor(shown, data.session);

  // A link click is a page load in the real portal, so focus returns to the heading; the preview selects never steal focus.
  useEffect(() => {
    if (moveFocus.current) {
      moveFocus.current = false;
      const h = heading.current?.querySelector("h1");
      if (h) { h.tabIndex = -1; h.focus(); }
    }
  }, [shown]);
  const go = (next: Screen) => { moveFocus.current = true; setScreen(next); };
  const choose = (next: Screen) => { toast.clear(); setScreen(next); };

  let body: ReactNode;
  switch (shown) {
    case "signin":
      body = (<><p className={s.lede}>{COPY.signinIntro}</p><SigninForm /></>);
      break;
    case "sent":
      body = (
        <>
          <p className={s.lede} data-testid="portal-sent">{COPY.sentText}</p>
          <Link onClick={() => go("signin")}>{COPY.backLabel}</Link>
        </>
      );
      break;
    case "code":
    case "code-refused":
      body = (
        <>
          {shown === "code-refused" ? (
            <p className={s.notice} id="portal-code-refused" data-testid="portal-code-refused">
              {COPY.codeRefused}
              <Link onClick={() => go("signin")} className={s.noticeLink}>{COPY.newCodeLabel}</Link>
            </p>
          ) : null}
          <CodeForm refusedId={shown === "code-refused" ? "portal-code-refused" : undefined} />
        </>
      );
      break;
    case "refused":
      body = (<><p className={s.notice} data-testid="portal-refusal">{COPY.refusalMessage}</p><SigninForm /></>);
      break;
    case "home": body = <Home data={data} permissions={permissions} go={go} />; break;
    case "quotes": body = <Quotes quotes={data.quotes} />; break;
    case "quotes-empty": body = <Quotes quotes={[]} />; break;
    case "jobs": body = <Jobs jobs={data.jobs} />; break;
    case "jobs-empty": body = <Jobs jobs={[]} />; break;
    case "loading": body = <LoadingState label="Loading your documents" rows={4} />; break;
    case "off":
      body = <p className={s.lede}>{COPY.notFoundText}</p>;
      break;
  }

  const tabButtons = TABS.filter((t) => permissions.includes(t.permission));
  const current = shown === "quotes-empty" || shown === "loading" ? "quotes" : shown === "jobs-empty" ? "jobs" : shown;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="portal-preview" data-screen={shown} data-auth={signedIn ? "false" : "true"}>
      <aside aria-label="Preview">
        <PreviewBar
          label="Preview only, sample data, nothing sent"
          controls={<Button aria-expanded={controlsOpen} aria-controls="portal-preview-controls" onClick={() => setControlsOpen((v) => !v)} data-testid="dock-toggle">Preview screens</Button>}
        />
      {controlsOpen ? (
        <section className={s.panel} id="portal-preview-controls" aria-label="Preview screens">
          <div className={s.panelIn}>
            <Field label="Screen" hint="Signed in screens are only drawn here. No one is signed in. This is not a real sign-in.">
              <Select value={screen} onChange={(e) => choose(e.target.value as Screen)} data-testid="dock-screen">
                <optgroup label="Signed out">
                  {SIGNED_OUT.map((v) => <option key={v} value={v}>{SCREEN_LABEL[v]}</option>)}
                </optgroup>
                <optgroup label="Signed in (preview switch, no real session)">
                  {SIGNED_IN.map((v) => <option key={v} value={v}>{SCREEN_LABEL[v]}</option>)}
                </optgroup>
                <optgroup label="Other">
                  <option value="off">{SCREEN_LABEL.off}</option>
                </optgroup>
              </Select>
            </Field>
            <Field label="Tabs this contact may see" hint="A page without its permission is the 404.">
              <Select value={tabs} onChange={(e) => { toast.clear(); setTabs(e.target.value as TabsKind); }} data-testid="dock-tabs">
                <option value="both">Quotes and Jobs</option>
                <option value="quotes">Quotes only</option>
                <option value="jobs">Jobs only</option>
              </Select>
            </Field>
            <Field label="Sample data" hint="Long names show how text wraps.">
              <Select value={kind} onChange={(e) => { toast.clear(); setKind(e.target.value as SampleKind); }} data-testid="dock-sample">
                <option value="typical">Typical</option>
                <option value="long">Long names</option>
              </Select>
            </Field>
          </div>
        </section>
      ) : null}
      </aside>

      <header className={s.top} data-testid="portal-header">
        <div className={s.topIn}>
          {signedIn ? (
            <>
              <div className={s.brandRow}>
                <span className={s.brand} data-testid="portal-brand">
                  <span className={s.monogram} aria-hidden="true">{monogram(data.session.companyName)}</span>
                  <span className={cx(typeScale.card, s.brandName)}>{data.session.companyName}</span>
                </span>
                <Button variant="quiet" onClick={() => toast.show(PREVIEW_ANSWERS.signOut)} data-testid="portal-signout">{COPY.signOut}</Button>
              </div>
              <nav aria-label="Portal" className={s.nav}>
                <Link className={s.tab} current={current === "home"} onClick={() => go("home")} testId="portal-tab-home">{COPY.home}</Link>
                {tabButtons.map((t) => (
                  <Link key={t.screen} className={s.tab} current={current === t.screen} onClick={() => go(t.screen)} testId={`portal-tab-${t.permission}`}>{t.label}</Link>
                ))}
              </nav>
            </>
          ) : (
            <p className={cx(typeScale.card, s.wordmark)}>Customer portal</p>
          )}
        </div>
      </header>

      <main className={signedIn ? s.content : s.auth}>
        <div key={shown} className={cx(s.screen, !signedIn && s.card1)}>
          <div ref={heading}><PageHeader title={title} className={s.ph} /></div>
          {body}
        </div>
      </main>
    </div>
  );
}

export default function PortalPreview() {
  return (
    <ToastProvider placement="bottom-centre" offset={16}>
      <Stage />
    </ToastProvider>
  );
}
