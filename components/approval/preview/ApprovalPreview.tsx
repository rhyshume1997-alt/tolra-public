"use client";

/**
 * BOUNDARY (Approval Queue, Module 4 by the coordinator's decision: ASSUMPTION for the project owner to confirm, docs/MODULES.md does not list app/(dashboard)/approval; PREVIEW ONLY).
 * Inputs: none from the server. Everything shown is fictional sample data (made-up companies and people on reserved ".example" addresses, as of 23/11/2026) held in this file, plus the person's clicks.
 * Message text is plain placeholder text, not real correspondence. Outputs: a look-and-feel prototype of the real Approval Queue (app/(dashboard)/approval/page.tsx): the info notice with the waiting count,
 * the Columns picker, the draft cards (Copy to Clipboard, Mark as Sent Manually, Open in email app, Edit, Full preview, Send via Resend instead, Skip), the chase reminder card (Edit, Approve and send,
 * Skip, Pause chasing for this customer), the "no provider" notice, Needs checking, Reopened jobs to sign off, Recently Sent, and the states (loading, failed with Retry, nothing waiting, Access Denied).
 * The only state is LOCAL UI state. It reads and writes no table, calls no mail, provider, Resend, chase or server route, opens no e-mail app, copies nothing, and sends nothing: every action that
 * would send, save, mark, skip, pause, approve, reject or copy answers with the neutral "Preview only ... Nothing was saved." toast (after the real page's own confirm question, drawn as a dialog) and
 * nothing changes. The one real-condition answer shown is the real "E-mail sending isn't set up" refusal when the dock says sending is not set up.
 * It does NOT import components/chase/*, components/approval-recovery, components/reopen-approvals or lib/reopen-sign-off (they pull in the database client): their visible controls and wording are reproduced
 * here and pinned to their source text by tests/unit/approvalPreview.test.ts. Run-time imports from lib/ are pure leaf modules only (lib/dates, lib/product).
 * MUST NOT CHANGE: wording, control order and who sees what mirror today's page (admin and office only; the settle and reopen decisions and Resend are admin only). Do not wire this file to real data or real
 * actions, do not add a control the real page lacks, and keep controls at a 48 px hit area. Not reproduced: the real "Approve and send" dialog and the card's "Approve and send" button, which only open for a
 * draft flagged chase and are never reached (a chase draft draws the chase card instead). Delete the four preview files to remove it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, Callout, Dialog, EmptyState, Field, Input, LoadingState, Popover, SegmentedControl, Sheet, StatusBadge, Switch, Textarea, ToastProvider,
  cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { PRODUCT } from "@/lib/product";

import s from "./ApprovalPreview.module.css";

/* ================================================================== */
/* 1. Types and constants                                              */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type Screen = "ready" | "loading" | "error" | "empty";
export type ApprovalItem = {
  id: string; badge: string; tone: "red" | "amber" | "blue"; customer: string; detail: string; drafted: string; to: string; subject: string; body: string;
  chase: boolean; canApprove: boolean; failedBefore: boolean; related: string;
  /** Chase only: the invoice number and customer id shown on the chase card. */
  invoiceNumber?: string;
};
export type HeldItem = { id: string; to: string; subject: string; status: string; related: string; drafted: string };
export type ReopenRow = { id: string; record_ref: string | null; reason: string; requested_by: string; requested_at: string; reopened_at: string | null };

/** The real page's words (app/(dashboard)/approval/page.tsx and the components it draws), pinned by the tests. */
export const PAGE_TITLE = "Approval Queue";
export const PAGE_SUBTITLE = "Emails Tolra has drafted wait here for you to check before they go to customers.";
export const INFO = "Check each draft before sending. Chase reminders can be approved and sent here when email sending is set up. Customer statements and system-created invoice drafts also offer Approve and send in Full preview when a provider is configured. To send a draft yourself, copy it or open it in your email app, then choose Mark as Sent Manually after you have sent it.";
export const NO_PROVIDER = "E-mail sending isn't set up for this company.";
export const NO_PROVIDER_TOAST = "E-mail sending isn't set up, so this wasn't sent. Copy it or open it in your email client instead.";
export const LOAD_ERROR = "Couldn't load the approval queue.";
export const NOTHING_WAITING = "Nothing waiting";
export const NOTHING_WAITING_TEXT = "No drafted emails are waiting for approval.";
export const SKIP_DAYS = 7;
export const TYPE_LABEL: Record<string, string> = {
  invoice: "INVOICE", quote: "QUOTE", sales_order: "SALES ORDER", purchase_order: "PURCHASE ORDER", delivery_note: "DELIVERY NOTE", rfq: "RFQ", job: "JOB", general: "GENERAL",
};
/** The columns picker's list (lib/org-settings COLUMN_TABLES "approvals"): key, label, locked. */
export const COLUMN_LIST: Array<{ key: string; label: string; locked?: boolean }> = [
  { key: "type", label: "Type" }, { key: "customer", label: "Recipient", locked: true }, { key: "detail", label: "Subject line", locked: true }, { key: "drafted", label: "Drafted date" },
  { key: "to", label: "To address", locked: true }, { key: "subject", label: "Subject" }, { key: "preview", label: "Message preview" },
];
export const COLUMN_SCOPE = "Changes apply to everyone in this company.";
export const COLUMN_RESET = "Reset to default (show all columns)";
export const CARD_BUTTONS = ["Copy to Clipboard", "Mark as Sent Manually", "Open in email app", "Edit", "Full preview"] as const;
export const CHASE_BUTTONS = ["Edit", "Approve and send", "Skip", "Pause chasing for this customer"] as const;
export const CHASE_MANUAL = ["Copy draft", "Open in email app", "Mark as Sent Manually"] as const;
export const RESEND_LABEL = "Send via Resend instead";
export const CHECKING = {
  title: "Needs checking",
  sending: "This email was being sent when something stopped, so we don't know if it went.",
  unknown: "We couldn't confirm whether this email was sent.",
  rest: "It will not be sent again, and cannot be sent another way, until someone has checked your mail provider's sent items and recorded what happened.",
  sent: "I checked: it was sent", notSent: "I checked: it was not sent (return to the queue)", adminOnly: "An admin needs to check and record this.",
};
export const REOPEN = {
  title: "Reopened jobs to sign off",
  admin: "Approve or reject each reopen. A rejection is recorded against the reopen; it does not undo it or the work done since.",
  other: "An admin approves or rejects these with their own login.",
};
export const RECENT_TITLE = "Recently Sent";
export const NOTHING_SENT = "Nothing has been sent yet.";

/* ================================================================== */
/* 2. Sample data (fictional)                                          */
/* ================================================================== */

const msg = (greeting: string, line: string) => `${greeting},\n\n${line}\n\nThis is sample text for the preview, not a real message.\n\nExample Engineering Ltd (sample)`;
export const SEED_ITEMS: ApprovalItem[] = [
  { id: "d1", badge: TYPE_LABEL.invoice, tone: "amber", customer: "Halden Precision", detail: "Invoice INV-1190 for November", drafted: fmtDate("2026-11-23"), to: "accounts@halden-precision.example", subject: "Invoice INV-1190 for November", body: msg("Hello", "Sample draft sending an invoice created by the system."), chase: false, canApprove: true, failedBefore: false, related: "inv-1190" },
  { id: "d2", badge: TYPE_LABEL.general, tone: "blue", customer: "Brightwell Valves", detail: "Statement of account, November", drafted: fmtDate("2026-11-22"), to: "buying@brightwell.example", subject: "Statement of account, November", body: msg("Hello", "Sample draft of a customer statement.\nA second line of sample text.\nA third line.\nA fourth line.\nA fifth line.\nA sixth line that the preview box hides."), chase: false, canApprove: true, failedBefore: true, related: "customer_statement:c-brightwell" },
  { id: "d3", badge: TYPE_LABEL.invoice, tone: "amber", customer: "Kestrel Components", detail: "Payment reminder, invoice INV-1172", drafted: fmtDate("2026-11-22"), to: "accounts@kestrel.example", subject: "Payment reminder, invoice INV-1172", body: msg("Hello", "Sample payment reminder for an overdue invoice."), chase: true, canApprove: false, failedBefore: false, related: "inv-1172", invoiceNumber: "INV-1172" },
  { id: "d4", badge: TYPE_LABEL.quote, tone: "blue", customer: "Marlow Hydraulics", detail: "Following up quote QUO-0438", drafted: fmtDate("2026-11-21"), to: "purchasing@marlow-hydraulics.example", subject: "Following up quote QUO-0438", body: msg("Hello", "Sample quote follow-up."), chase: false, canApprove: false, failedBefore: false, related: "quo-0438" },
  { id: "d5", badge: TYPE_LABEL.purchase_order, tone: "blue", customer: "Meridian Subsea Components and Associated Group Holdings (UK) Limited", detail: "Purchase order PO-0387 with a very long subject line so the card has to wrap it onto more than one line without breaking the layout", drafted: fmtDate("2026-11-20"), to: "tenders@meridian-subsea.example", subject: "Purchase order PO-0387 with a very long subject line so the card has to wrap it onto more than one line without breaking the layout", body: msg("Hello", "Sample purchase order message."), chase: false, canApprove: false, failedBefore: false, related: "po-0387" },
  { id: "d6", badge: TYPE_LABEL.delivery_note, tone: "blue", customer: "Ashby Rail Services", detail: "Delivery note DN-0211", drafted: fmtDate("2026-11-19"), to: "supply@ashby-rail.example", subject: "Delivery note DN-0211", body: msg("Hello", "Sample delivery note message."), chase: false, canApprove: false, failedBefore: false, related: "dn-0211" },
];
export const SEED_HELD: HeldItem[] = [
  { id: "h1", to: "orders@tern-marine.example", subject: "Invoice INV-1184", status: "unknown", related: "invoice", drafted: fmtDate("2026-11-18") },
  { id: "h2", to: "orders@northgate-fab.example", subject: "Job J-0431 update", status: "sending", related: "job", drafted: fmtDate("2026-11-17") },
];
export const SEED_REOPEN: ReopenRow[] = [
  { id: "ro1", record_ref: "J-0412", reason: "A second operation was missed. Sample reason text for the preview.", requested_by: "Sam Okoro", requested_at: "2026-11-22T14:10:00Z", reopened_at: null },
  { id: "ro2", record_ref: "J-0425", reason: "Reopened with the tick box because no admin was available. Sample reason text.", requested_by: "Priya Nair", requested_at: "2026-11-21T09:30:00Z", reopened_at: "2026-11-21T09:30:00Z" },
];
export const SEED_RECENT = [
  { id: "s1", customer: "Northgate Fabrication", when: fmtDateTime("2026-11-22T15:40:00Z"), status: `Sent by ${PRODUCT.name}` },
  { id: "s2", customer: "Coldharbour Automation", when: fmtDateTime("2026-11-21T11:15:00Z"), status: "Sent manually" },
  { id: "s3", customer: "Wren & Calder", when: fmtDateTime("2026-11-20T16:05:00Z"), status: `Sent by ${PRODUCT.name}` },
];

/* ================================================================== */
/* 3. Logic (mirrors the real page and components)                      */
/* ================================================================== */

export const canUseApproval = (role: Role) => role === "admin" || role === "office";
const TONE: Record<ApprovalItem["tone"], StatusTone> = { red: "danger", amber: "warn", blue: "info" };
/** The waiting sentence (page: loading || error ? "" : ` ${n} draft${n === 1 ? "" : "s"} waiting.`). */
export const waitingText = (n: number, loading: boolean, error: boolean) => (loading || error ? "" : ` ${n} draft${n === 1 ? "" : "s"} waiting.`);
/** Send via Resend instead: only when the server offers Resend AND an earlier send of this record failed (approval-recovery SendViaResendButton), on a card only when canApprove. */
export const showsResend = (available: boolean, failed: boolean) => available && failed;
export const cardShowsResend = (item: Pick<ApprovalItem, "canApprove" | "failedBefore">, available: boolean) => item.canApprove && showsResend(available, item.failedBefore);
/** reopen-sign-off approvalLine. */
export function approvalLine(row: Pick<ReopenRow, "reopened_at" | "record_ref">): { badge: string; detail: string; approveLabel: string } {
  const ref = row.record_ref ?? "The job";
  if (row.reopened_at) return { badge: "REOPENED, NO ADMIN WAS AVAILABLE", detail: `${ref} was reopened with the tick box. Approve to sign it off; rejecting records your decision but does not undo the reopen or the work done since.`, approveLabel: "Approve" };
  return { badge: "WAITING FOR AN ADMIN", detail: `${ref} is not reopened yet. Approve to reopen it now; reject and it stays as it is.`, approveLabel: "Approve and reopen" };
}
/** The confirm questions the real page asks with window.confirm (shown here as a dialog). */
export const confirmSend = (to: string) => `Send this exact reviewed message to ${to}?`;
export const confirmMarkSent = (customer: string) => `Mark the email to ${customer} as sent? Only do this once you've actually sent it.`;
export const confirmSkip = () => `Skip this reminder? It won't show again for ${SKIP_DAYS} days.`;
export const confirmResend = (to: string, subject: string) => `Send this failed email through Resend instead?\n\nTo: ${to}\nSubject: ${subject}\n\nThis is your own choice, it is recorded against your name, and it sends the message once.`;
export const confirmHeld = (to: string, outcome: "sent" | "not_sent") => (outcome === "sent" ? `Record that the email to ${to} WAS sent? Only do this after you have checked.` : `Record that the email to ${to} was NOT sent and return it to the queue? Only do this after you have checked.`);
export const confirmReject = (ref: string | null, reopened: boolean) => (reopened ? `Reject the reopen of ${ref ?? "this job"}? Your decision is recorded; the job stays reopened and the work is not undone.` : `Reject the reopen of ${ref ?? "this job"}? It is not reopened.`);
/** The first five lines of the message, as the card's preview box shows them. */
export const previewLines = (body: string) => body.split("\n").slice(0, 5);

/* ================================================================== */
/* 4. The page                                                         */
/* ================================================================== */

const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SENDING: Array<{ value: "on" | "off"; label: string }> = [{ value: "on", label: "Set up" }, { value: "off", label: "Not set up" }];
const SCREENS: Array<{ v: Screen; label: string }> = [{ v: "ready", label: "Sample queue" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "Nothing waiting" }];
type Confirm = { title: string; text: string; label: string; done: string };
type Dlg = { k: "edit"; id: string } | { k: "full"; id: string } | { k: "confirm"; c: Confirm };

export default function ApprovalPreview() {
  return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>;
}

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [sending, setSending] = useState(true);
  const [resend, setResend] = useState(true);
  const [held, setHeld] = useState(true);
  const [reopens, setReopens] = useState(true);
  const [recent, setRecent] = useState(true);
  const [hidden, setHidden] = useState<string[]>([]);
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  const [noProvider, setNoProvider] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); }, [toast]);

  const loading = screen === "loading";
  const error = screen === "error";
  const items = useMemo(() => (screen === "ready" ? SEED_ITEMS : []), [screen]);
  const isVisible = (key: string) => !hidden.includes(key);
  const isAdmin = role === "admin";
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const ask = (c: Confirm) => setDlg({ k: "confirm", c });
  const retry = () => { setScreen("loading"); toast.clear(); timer.current = window.setTimeout(() => { setScreen("ready"); preview("Sample queue shown again. No server was contacted."); }, 700); };
  const resetAll = () => { setRole("admin"); setScreen("ready"); setSending(true); setResend(true); setHeld(true); setReopens(true); setRecent(true); setHidden([]); setDlg(null); setNoProvider(false); toast.clear(); };
  const denied = !canUseApproval(role);
  const byId = (id: string) => items.find((i) => i.id === id)!;

  const actions = {
    copy: (i: ApprovalItem) => preview(`The draft for ${i.customer} was not copied.`),
    mail: (i: ApprovalItem) => preview(`Your email app was not opened for ${i.to}.`),
    markSent: (i: ApprovalItem) => ask({ title: "Mark as Sent Manually", text: confirmMarkSent(i.customer), label: "OK", done: `${i.customer} was not marked as sent.` }),
    skip: (i: ApprovalItem) => ask({ title: "Skip", text: confirmSkip(), label: "OK", done: `The reminder for ${i.customer} was not skipped.` }),
    resend: (i: ApprovalItem) => ask({ title: RESEND_LABEL, text: confirmResend(i.to, i.subject), label: "OK", done: "Nothing was sent through Resend." }),
    approve: (i: ApprovalItem) => ask({ title: "Approve and send", text: confirmSend(i.to), label: "OK", done: `Nothing was sent to ${i.to}.` }),
  };
  const chaseApprove = (i: ApprovalItem) => {
    if (!sending) { setNoProvider(true); toast.show({ title: "E-mail sending isn't set up", detail: NO_PROVIDER_TOAST, tone: "error" }); return; }
    preview(`The reminder for ${i.customer} was not sent.`);
  };

  const columnsPopover = (
    <Popover label="Columns" title="Approval Queue columns" size="md" data-testid="columns-trigger">
      <p className={s.colScope}>{COLUMN_SCOPE} In this preview they change this screen only.</p>
      {COLUMN_LIST.map((c) => (c.locked ? (
        <p key={c.key} className={s.colLocked} data-testid={`col-${c.key}`}><span>{c.label}</span><span>Always shown</span></p>
      ) : (
        <Switch key={c.key} label={c.label} checked={isVisible(c.key)} data-testid={`col-${c.key}`} onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== c.key) : [...h, c.key]))} />
      )))}
      <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHidden([])}>{COLUMN_RESET}</Button></div>
    </Popover>
  );

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="approval-preview" data-role={role}>
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
              <p className={s.dockLabel}>E-mail sending (provider)</p>
              <SegmentedControl label="E-mail sending" value={sending ? "on" : "off"} options={SENDING} size="sm" onChange={(v) => { setSending(v === "on"); setNoProvider(false); toast.clear(); }} />
              <p className={s.dockLabel}>Screen state</p>
              <div className={s.dockStates} role="group" aria-label="Screen state">
                {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => { setScreen(x.v); toast.clear(); }}>{x.label}</button>)}
              </div>
              <Switch label="Resend offered by the server" checked={resend} onChange={setResend} />
              <Switch label="Messages that need checking" checked={held} onChange={setHeld} />
              <Switch label="Reopens waiting for sign-off" checked={reopens} onChange={setReopens} />
              <Switch label="Recently sent" checked={recent} onChange={setRecent} />
              <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
            </div>
          </Popover>
          {denied ? null : columnsPopover}
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
          <Callout tone="info" lead="" data-testid="approval-info">{INFO}{waitingText(items.length, loading, error)}</Callout>
          {noProvider ? <Callout tone="warn" lead="" role="status" data-testid="approval-no-provider">{NO_PROVIDER}</Callout> : null}
          {error ? (
            <div className={s.errorCard} role="alert" data-testid="load-error"><p className={s.errorText}>{LOAD_ERROR}</p><Button variant="secondary" onClick={retry}>Retry</Button></div>
          ) : null}

          <section className={s.queue} aria-label="Drafts waiting for approval">
            {loading ? <LoadingState label="Loading the approval queue" rows={4} /> : !error && items.length === 0 ? (
              <EmptyState title={NOTHING_WAITING} detail={NOTHING_WAITING_TEXT} headingLevel={2} />
            ) : items.map((item) => (item.chase ? (
              <ChaseCard key={item.id} item={item} role={role} resend={resend} sending={sending} preview={preview} actions={actions} onApprove={() => chaseApprove(item)} />
            ) : (
              <article key={item.id} className={s.card} data-approval={item.id}>
                <div className={s.cardHead}>
                  <div className={s.cardTitle}>
                    {isVisible("type") ? <StatusBadge tone={TONE[item.tone]}>{item.badge}</StatusBadge> : null}
                    <h2 className={s.customer}>{item.customer}</h2>
                    <p className={s.detail}>{item.detail}</p>
                  </div>
                  {isVisible("drafted") ? <p className={cx(s.drafted, tabularNumbers)}>Drafted: {item.drafted}</p> : null}
                </div>
                <dl className={s.facts}>
                  <dt>To:</dt><dd>{item.to}</dd>
                  {isVisible("subject") ? <><dt>Subject:</dt><dd>&quot;{item.subject}&quot;</dd></> : null}
                </dl>
                {isVisible("preview") ? <div className={s.previewBox}>{previewLines(item.body).map((line, i) => <p key={`${item.id}-${i}`}>{line || " "}</p>)}</div> : null}
                <div className={s.actions}>
                  <Button variant="primary" onClick={() => actions.copy(item)}>Copy to Clipboard</Button>
                  <Button variant="secondary" onClick={() => actions.markSent(item)}>Mark as Sent Manually</Button>
                  <Button variant="secondary" onClick={() => actions.mail(item)}>Open in email app</Button>
                  <Button variant="secondary" onClick={() => setDlg({ k: "edit", id: item.id })}>Edit</Button>
                  <Button variant="secondary" onClick={() => setDlg({ k: "full", id: item.id })}>Full preview</Button>
                  {cardShowsResend(item, resend) ? <Button variant="secondary" onClick={() => actions.resend(item)}>{RESEND_LABEL}</Button> : null}
                  <Button variant="quiet" className={s.skip} onClick={() => actions.skip(item)}>Skip</Button>
                </div>
              </article>
            )))}
          </section>

          {held && SEED_HELD.length ? (
            <section className={s.block} aria-label="Needs checking" data-testid="needs-checking">
              <h2 className={s.blockTitle}>{CHECKING.title}</h2>
              {SEED_HELD.map((h) => (
                <article key={h.id} className={cx(s.card, s.cardWarn)} data-held={h.id}>
                  <h3 className={s.heldTitle}>{h.to}</h3>
                  <p className={s.detail}>{h.subject}</p>
                  <p className={s.heldNote} role="status">{h.status === "sending" ? CHECKING.sending : CHECKING.unknown} {CHECKING.rest}</p>
                  {isAdmin ? (
                    <div className={s.actions}>
                      <Button variant="secondary" onClick={() => ask({ title: CHECKING.sent, text: confirmHeld(h.to, "sent"), label: "OK", done: "Nothing was recorded." })}>{CHECKING.sent}</Button>
                      <Button variant="secondary" onClick={() => ask({ title: CHECKING.notSent, text: confirmHeld(h.to, "not_sent"), label: "OK", done: "Nothing was recorded." })}>{CHECKING.notSent}</Button>
                    </div>
                  ) : <p className={s.detail}>{CHECKING.adminOnly}</p>}
                </article>
              ))}
            </section>
          ) : null}

          {reopens && SEED_REOPEN.length ? (
            <section className={s.block} data-testid="reopen-list" aria-labelledby="reopen-title">
              <div>
                <h2 id="reopen-title" className={s.blockTitle}>{REOPEN.title}</h2>
                <p className={s.detail}>{isAdmin ? REOPEN.admin : REOPEN.other}</p>
              </div>
              {SEED_REOPEN.map((r) => {
                const line = approvalLine(r);
                return (
                  <article key={r.id} className={s.card} data-reopen-request={r.id}>
                    <div className={s.cardHead}>
                      <div className={s.cardTitle}>
                        <StatusBadge tone={r.reopened_at ? "warn" : "info"}>{line.badge}</StatusBadge>
                        <h3 className={s.customer}>{r.record_ref ?? "Job"}</h3>
                        <p className={s.detail}>{line.detail}</p>
                      </div>
                      <p className={s.drafted}>{r.requested_by}, {fmtDateTime(r.requested_at)}</p>
                    </div>
                    <p className={s.reason}><span className={s.reasonLabel}>Reason: </span>{r.reason}</p>
                    {isAdmin ? (
                      <div className={s.actions}>
                        <Button variant="primary" onClick={() => preview(`${r.record_ref} was not ${r.reopened_at ? "signed off" : "reopened"}.`)}>{line.approveLabel}</Button>
                        <Button variant="secondary" onClick={() => ask({ title: "Reject", text: confirmReject(r.record_ref, Boolean(r.reopened_at)), label: "OK", done: "No decision was recorded." })}>Reject</Button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </section>
          ) : null}

          <section className={s.block} aria-labelledby="recent-title">
            <h2 id="recent-title" className={s.blockTitle}>{RECENT_TITLE}</h2>
            <div className={s.recent}>
              {recent && !loading && !error ? SEED_RECENT.map((r) => (
                <div key={r.id} className={s.recentRow}><p className={s.recentName}>{r.customer}</p><p className={s.detail}>{r.when} · {r.status}</p></div>
              )) : <p className={s.recentEmpty}>{loading ? "Loading..." : NOTHING_SENT}</p>}
            </div>
          </section>
        </>
      )}

      {dlg?.k === "edit" ? <EditSheet item={byId(dlg.id)} onClose={() => setDlg(null)} onSave={() => { setDlg(null); preview("The draft was not updated."); }} /> : null}
      {dlg?.k === "full" ? (
        <Sheet open size="md" onClose={() => setDlg(null)} testId="dlg-full" title="Full Email Preview" description={byId(dlg.id).customer}
          footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Close</Button>{byId(dlg.id).canApprove ? <Button variant="primary" onClick={() => { const i = byId(dlg.id); setDlg(null); actions.approve(i); }}>Approve and send</Button> : null}</>}>
          <dl className={s.facts}><dt>To:</dt><dd>{byId(dlg.id).to}</dd><dt>Subject:</dt><dd>{byId(dlg.id).subject}</dd></dl>
          <div className={s.fullBody}>{byId(dlg.id).body}</div>
        </Sheet>
      ) : null}
      {dlg?.k === "confirm" ? (
        <Dialog open title={dlg.c.title} confirmLabel={dlg.c.label} onConfirm={() => { const d = dlg.c.done; setDlg(null); preview(d); }} onClose={() => setDlg(null)}>
          <p className={s.confirmText} data-testid="confirm-text">{dlg.c.text}</p>
        </Dialog>
      ) : null}
    </div>
  );
}

type Actions = { copy: (i: ApprovalItem) => void; mail: (i: ApprovalItem) => void; markSent: (i: ApprovalItem) => void; skip: (i: ApprovalItem) => void; resend: (i: ApprovalItem) => void; approve: (i: ApprovalItem) => void };

/** The chase reminder card (components/chase/approval-card.tsx) with the manual actions row (page.tsx), reproduced locally. */
function ChaseCard({ item, role, resend, sending, preview, actions, onApprove }: { item: ApprovalItem; role: Role; resend: boolean; sending: boolean; preview: (d: string) => void; actions: Actions; onApprove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [error, setError] = useState("");
  const save = () => {
    if (!subject.trim() || !body.trim()) { setError("Enter a subject and a message before saving."); return; }
    setError(""); setEditing(false); setSubject(item.subject); setBody(item.body);
    preview("The draft was not saved. The saved text is unchanged.");
  };
  return (
    <article className={s.card} data-approval={item.id} data-chase="true" data-sending={sending ? "on" : "off"} data-role={role}>
      <h2 className={s.customer}>Payment reminder — {item.customer}</h2>
      <p className={s.detail}>Invoice {item.invoiceNumber} · To: {item.to}</p>
      <p className={s.detail}>This is a draft. Check it before you approve and send it.</p>
      {editing ? (
        <div className={s.form}>
          <Field label="Subject"><Input value={subject} onChange={(e) => { setError(""); setSubject(e.target.value); }} /></Field>
          <Field label="Message"><Textarea rows={8} value={body} onChange={(e) => { setError(""); setBody(e.target.value); }} /></Field>
          <div className={s.actions}>
            <Button variant="primary" onClick={save}>Save draft</Button>
            <Button variant="secondary" onClick={() => { setSubject(item.subject); setBody(item.body); setEditing(false); setError(""); }}>Cancel edit</Button>
          </div>
        </div>
      ) : <div className={s.chaseText}><p className={s.chaseSubject}>{item.subject}</p><p className={s.chaseBody}>{item.body}</p></div>}
      {error ? <p role="alert" className={s.err}>{error}</p> : null}
      <div className={s.actions}>
        <Button variant="secondary" disabled={editing} onClick={() => setEditing(true)}>Edit</Button>
        <Button variant="primary" disabled={editing} onClick={onApprove}>Approve and send</Button>
        <Button variant="secondary" disabled={editing} onClick={() => preview(`The reminder for ${item.customer} was not skipped.`)}>Skip</Button>
        <Button variant="secondary" disabled={editing} onClick={() => preview(`Chasing was not paused for ${item.customer}.`)}>Pause chasing for this customer</Button>
      </div>
      <div className={cx(s.actions, s.manual)}>
        <Button variant="secondary" onClick={() => actions.copy(item)}>Copy draft</Button>
        <Button variant="secondary" onClick={() => actions.mail(item)}>Open in email app</Button>
        <Button variant="secondary" onClick={() => actions.markSent(item)}>Mark as Sent Manually</Button>
        {showsResend(resend, item.failedBefore) ? <Button variant="secondary" onClick={() => actions.resend(item)}>{RESEND_LABEL}</Button> : null}
      </div>
    </article>
  );
}

function EditSheet({ item, onClose, onSave }: { item: ApprovalItem; onClose: () => void; onSave: () => void }) {
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  return (
    <Sheet open size="md" onClose={onClose} testId="dlg-edit" title="Edit Email" description="Adjust the subject or message before sending."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onSave}>Save Draft</Button></>}>
      <div className={s.form}>
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Message"><Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      </div>
    </Sheet>
  );
}
