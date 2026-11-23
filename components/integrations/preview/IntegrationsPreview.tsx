"use client";

/**
 * BOUNDARY (Admin > Integrations, PREVIEW ONLY: nothing here is wired to anything, and nothing here can connect, sign in, send, transfer or call an integration).
 * v2 (claude/portal-admin-v2, owner approved STRUCTURAL-CHANGES-BRIEF items 4, 7, 9, 10, 11): shared PreviewBar and PageHeader replace the local preview pill and h1, text uses the v4 type scale, a row with several actions shows one primary and a More menu, narrow records use the shared StackedRows. Presentation only: wording, controls, states, roles and rules are unchanged.
 * OWNERSHIP ASSUMPTION FOR THE OWNER TO CONFIRM: docs/MODULES.md gives Module 6 (Integrations) components/integrations/** and settings cards, but does not name the route
 * app/(dashboard)/admin/integrations/**. By the coordinator's decision the route is treated as Module 6's. If it belongs elsewhere, move these files; nothing else depends on them.
 * Inputs: none from the server. Everything shown is fictional (one made-up company and two made-up Xero or mailbox names, as of 23/11/2026) held in this file, plus the person's clicks.
 * Outputs: the Admin > Integrations look-and-feel prototype: the four guided setup cards (AI, Xero, Microsoft 365, Resend) with the e-mail guide, then "More" (the AI pointer, the Xero
 * send-now and accountant-link card, the accounting status table). It calls NO Supabase, fetch, OAuth, e-mail, AI or Xero code. Every integration is OFF by default and NOTHING is ever
 * drawn as connected, signed in, authorised, ready or successful: the states that can be drawn (Preview controls) are default (off, not connected), checking, unreadable, not set up on this
 * server, and needs connecting again. The "connected" states, the "On" state of every switch, a verified Resend sender and every success message are deliberately NOT drawn.
 * Every Connect, Reconnect, Disconnect, Save key, Save limit, Check domain and E-mail-the-accountant control answers with the neutral "Preview only ... Nothing was saved." toast
 * (Disconnect first shows the real confirmation wording); no authenticator-code step is drawn. The Role control only changes which screen is drawn; it grants nothing. The API-key field is
 * a password field whose text stays in this component's state and is cleared on Save, as on the real card; it goes nowhere and no key is stored.
 * Run-time imports from lib/ are pure modules only (integrations/overview, integrations/xero-setup-state, integrations/accounting-status, email-choice-guide constants); the AI and Microsoft 365
 * and Resend card wording lives in files that reach Supabase or fetch, so it is mirrored here and pinned to that source text by tests/unit/adminIntegrationsPreview.test.ts.
 * NOT DRAWN: the accountant-invite card, the accounting clouds cards, the send log, the Xero date-range send and Held for review (they sit under "More" on the real page).
 * MUST NOT CHANGE: wording, card order, the off-by-default rule, "Connected is not On", the admin-only rule. Do not wire this to real data, a session or an action, do not add a control the
 * real page lacks, keep every control at a 48 px hit area. Delete the preview files to remove it completely.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Button, Callout, Dialog, Field, Input, LoadingState, Panel, Popover, ScrollTable, SegmentedControl, StatusBadge, Switch, ToastProvider, cx, premiumTokens, useToast, PageHeader, PreviewBar } from "@/components/ui/premium";
import { EMAIL_CHOICE_APPROVAL, EMAIL_CHOICE_OTHER, EMAIL_CHOICE_OUTLOOK } from "@/components/email-choice-guide";
import { accountingStatuses } from "@/lib/integrations/accounting-status";
import { cardStatusLabel, connectCardView, type IntegrationOverview } from "@/lib/integrations/overview";
import { activationFor, connectionLine, EMERGENCY_NOTE, serverBehaviour, setupSteps, type XeroInputs } from "@/lib/integrations/xero-setup-state";
import type { UserRole } from "@/types";

import s from "./IntegrationsPreview.module.css";

export type Role = UserRole;
export type Overall = "default" | "checking" | "unreadable" | "not-set-up" | "reconnect";
type Tone = "off" | "working" | "attention";
type StepState = "done" | "next" | "later";
type Step = { label: string; state: StepState; hint?: string };
type Activation = { label: string; on: boolean | null; disabledReason?: string | null; help?: string; hideSwitch?: boolean; statusText?: string };
export type CardModel = { id: "ai" | "xero" | "microsoft" | "resend"; title: string; summary: string; connection: { tone: Tone; label: string }; steps: Step[]; activation: Activation; footnote?: string };

/* ---------- the real page's wording (admin/integrations/page.tsx, integrations-overview.tsx, the four setup cards, ai-setup.ts), pinned by the test ---------- */
export const COMPANY_NAME = "Fernhill Engineering Ltd";
export const PAGE_TITLE = "Integrations";
export const SUBTITLE = "Connect AI, Xero and e-mail one step at a time. Everything here is off until an admin connects it and turns it on.";
export const MORE_TEXT = "Everything else on this page: the accountant's tools, the accounting clouds, and the send log.";
export const AI_SUMMARY = "Choose who provides the AI, then turn it on as its own step. It only makes suggestions: a person checks and approves everything.";
export const XERO_SUMMARY = "One way, Tolra to Xero: issued invoices, issued credit notes and their customers. Nothing is read back; payments stay in Xero.";
export const MS_SUMMARY = "Send Tolra's e-mails from this company's own Microsoft 365 mailbox, and read its inbox into RFQs (read only).";
export const RESEND_SUMMARY = "Sends Tolra's e-mails from the server's verified sender address when this company has no Microsoft 365 mailbox connected.";
export const NO_KEY_REASON = "Save your Anthropic key first. AI can't be turned on without one.";
export const SERVER_OFF_REASON = "AI is switched off on this server (the AI_HELPER_ENABLED setting), so it can't be turned on here.";
export const STATUS_ERROR_REASON = "Couldn't read the AI status. Try again in a moment.";
export const AI_FOOTNOTE = "AI is switched off for the whole server by the AI_HELPER_ENABLED setting (and the assistant by AI_ASSISTANT_ENABLED). If either is off here, it can't be turned on from this card. Saving a key never turns AI on.";
export const AI_HELP = "Uses your company's own Anthropic account and key. Everything it does counts towards your monthly limit, and it stops when that is reached.";
export const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";
export const MS_FOOTNOTE = "If Microsoft 365 fails, Tolra does not switch to Resend by itself: the message stays unsent until someone resolves it.";
export const MS_ONE_MAILBOX = "One mailbox per company: this company's mailbox is never shared with another company.";
export const MS_HELP = "One mailbox per company. Nothing is sent without a person sending or approving each message.";
export const RESEND_HELP = "No automatic fallback: Resend is only used when no Microsoft 365 mailbox is connected.";
export const RESEND_FOOTNOTE = "Resend is never used automatically after a Microsoft 365 failure. A test e-mail goes only to your own address and is recorded in the audit log without the address or text.";
export const XERO_DISCONNECT_TITLE = "Disconnect from Xero?";
export const XERO_DISCONNECT_TEXT = "Nothing more is sent. Anything queued and not yet sent is dropped (it is never sent to another organisation). The send log stays.";
export const MS_DISCONNECT_TITLE = "Disconnect Microsoft 365?";
export const MS_DISCONNECT_TEXT = "Tolra stops sending as this mailbox at once (its stored sign-in is deleted). You can connect again at any time.";
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
export const canUseIntegrations = (role: Role): boolean => role === "admin";
export const poundsAndPence = (pence: number) => `£${(pence / 100).toFixed(2)}`;

const OV = (status: IntegrationOverview["status"], tenant: string | null = null): IntegrationOverview => ({ provider: "xero", status, tenant_name: tenant, connected_at: null, status_reason: null, unmapped: [], counts: {}, contact_problems: 0 });
/** The inputs to the REAL xero-setup-state functions, per overall state. Nothing here is connected. */
export function xeroInputs(o: Overall): XeroInputs {
  const hold = { available: true, on: false as boolean | null, set: () => undefined };
  switch (o) {
    case "checking": return { configured: null, overview: null, launchHold: hold };
    case "unreadable": return { configured: null, overview: null, loadError: true, launchHold: hold };
    case "not-set-up": return { configured: false, overview: OV("not_connected"), launchHold: hold };
    case "reconnect": return { configured: true, overview: OV("needs_reconnect", "Fernhill Fabrication Ltd (sample)"), launchHold: hold };
    default: return { configured: true, overview: OV("not_connected"), launchHold: hold };
  }
}

export function aiCard(o: Overall): CardModel {
  const base = { id: "ai" as const, title: "AI", summary: AI_SUMMARY, footnote: AI_FOOTNOTE };
  if (o === "not-set-up") return { ...base, connection: { tone: "attention", label: "AI is switched off on this server" }, steps: [{ label: "Server switch", state: "next", hint: "AI is off for this server. Nothing here can change that." }], activation: { label: "Turn on AI", on: false, disabledReason: SERVER_OFF_REASON } };
  if (o === "checking") return { ...base, connection: { tone: "working", label: "Checking…" }, steps: [], activation: { label: "Turn on AI", on: null, disabledReason: "Loading the AI status." } };
  if (o === "unreadable") return { ...base, connection: { tone: "attention", label: "Couldn't read the AI status" }, steps: [], activation: { label: "Turn on AI", on: null, disabledReason: STATUS_ERROR_REASON } };
  return {
    ...base, connection: { tone: "off", label: "No key saved" },
    steps: [
      { label: "Choose Anthropic with your own key", state: "done" },
      { label: "Get a key from Anthropic", state: "next", hint: "Make the key in an Anthropic account your business owns, and set a spend limit there too." },
      { label: "Paste and save the key", state: "later" },
      { label: "Turn on AI", state: "later", hint: "A separate step. Saving a key never turns AI on." },
    ],
    activation: { label: "Turn on AI", on: false, disabledReason: NO_KEY_REASON, help: AI_HELP },
  };
}

/** The real connection line, with its green "ok" tone (a connected company) folded to plain: the preview never draws a connected state, so it can never be green. */
const neutral = (c: { tone: "off" | "working" | "attention" | "ok"; label: string }): CardModel["connection"] => ({ tone: c.tone === "ok" ? "off" : c.tone, label: c.label });
export function xeroCard(o: Overall): CardModel {
  const i = xeroInputs(o);
  const a = activationFor(i);
  return { id: "xero", title: "Xero", summary: XERO_SUMMARY, connection: neutral(connectionLine(i)), steps: setupSteps(i), activation: { label: a.label, on: a.on, disabledReason: a.disabledReason, help: a.help }, footnote: EMERGENCY_NOTE };
}

const MS_STEPS: Step[] = [
  { label: "Connect with your Microsoft work account", state: "next", hint: "Someone who owns the company mailbox signs in at Microsoft and approves. Admins only, with a confirmed authenticator code." },
  { label: "Test", state: "later", hint: "Asks Microsoft who is signed in now. Sends no e-mail." },
  { label: "E-mails go out from this mailbox once a person sends or approves them", state: "later", hint: "Nothing is sent without a person: they click Send, or the message waits as a draft in Approvals." },
];
export function microsoftCard(o: Overall): CardModel {
  const connection: CardModel["connection"] = o === "checking" || o === "unreadable" ? { tone: "working", label: "Checking…" }
    : o === "not-set-up" ? { tone: "off", label: "Not set up on this server" }
    : o === "reconnect" ? { tone: "attention", label: "Needs reconnecting (Fernhill Mail (sample))" } : { tone: "off", label: "Not connected" };
  const sending = o === "checking" || o === "unreadable" ? "Sending: checking" : o === "reconnect" ? "Sending: paused until you reconnect" : "Sending: not set up";
  return { id: "microsoft", title: "Microsoft 365", summary: MS_SUMMARY, connection, steps: MS_STEPS, activation: { label: "Sending", on: null, hideSwitch: true, statusText: sending, help: MS_HELP }, footnote: MS_FOOTNOTE };
}

const RESEND_STEPS: Step[] = [
  { label: "The platform owner puts the Resend key and a verified sender domain on the server", state: "next", hint: "Set once for the whole server, not per company. It is a sender address, not a mailbox: nobody signs in and nothing is read." },
  { label: "Check domain", state: "later", hint: "Read only: asks Resend whether the key and the sender domain are accepted. Sends nothing." },
  { label: "Send a test e-mail to yourself", state: "later", hint: "One plain e-mail to your own address, after you confirm. Needs a recent authenticator code." },
];
export function resendCard(o: Overall): CardModel {
  const connection: CardModel["connection"] = o === "checking" ? { tone: "working", label: "Checking…" } : o === "unreadable" ? { tone: "attention", label: "Couldn't check Resend. Try again." } : { tone: "off", label: "Not set up on this server" };
  const sending = o === "checking" ? "Sending: checking" : o === "unreadable" ? "Sending: waiting for the Microsoft 365 connection to be checked"
    : o === "reconnect" ? "Sending: paused. Reconnect Microsoft 365; Tolra will not switch to Resend by itself." : "Sending: not set up";
  return { id: "resend", title: "Resend", summary: RESEND_SUMMARY, connection, steps: RESEND_STEPS, activation: { label: "Sending", on: null, hideSwitch: true, statusText: sending, help: RESEND_HELP }, footnote: RESEND_FOOTNOTE };
}
export const CARDS = (o: Overall): CardModel[] => [aiCard(o), xeroCard(o), microsoftCard(o), resendCard(o)];

/** The state word on a card's badge: "AI: Off", "transfers: Off", "Unknown" while it is not known, and the status text when the card has no switch. Never "On". */
export function badgeFor(c: CardModel): string {
  if (c.activation.hideSwitch) return c.activation.statusText ?? c.activation.label;
  return `${c.activation.label.replace(/^Turn on /, "")}: ${c.activation.on === null ? "Unknown" : c.activation.on ? "On" : "Off"}`;
}

export function statusRows(o: Overall) {
  if (o === "checking") return null;
  if (o === "unreadable") return "unavailable" as const;
  const i = xeroInputs(o);
  return accountingStatuses({ configured: i.configured, overview: i.overview, enabled: false, last: null, lastReadOk: true });
}

const OVERALLS: Array<{ v: Overall; label: string }> = [
  { v: "default", label: "Off, nothing connected (default)" }, { v: "checking", label: "Checking each status" }, { v: "unreadable", label: "Status couldn't be read" },
  { v: "not-set-up", label: "Not set up on this server" }, { v: "reconnect", label: "Needs connecting again" },
];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }));

export default function IntegrationsPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

type Ask = "xero" | "microsoft" | null;

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [overall, setOverall] = useState<Overall>("default");
  const [ask, setAsk] = useState<Ask>(null);
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState("10.00");
  const [accountant, setAccountant] = useState("");
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseIntegrations(role);
  const cards = useMemo(() => CARDS(overall), [overall]);
  const pick = (v: Overall) => {
    toast.clear(); setAsk(null); setOverall(v);
    if (v === "unreadable") toast.show({ title: "Couldn't load Microsoft 365.", tone: "error" });
  };
  const reset = () => { toast.clear(); setAsk(null); setRole("admin"); setOverall("default"); setKey(""); setAccountant(""); };
  const xi = xeroInputs(overall);
  const behaviour = serverBehaviour(xi);
  const xv = connectCardView("xero", xi.configured);
  const rows = useMemo(() => statusRows(overall), [overall]);
  const showAiSetup = overall === "default" || overall === "reconnect";
  const reconnect = overall === "reconnect";

  const extras = (c: CardModel): ReactNode => {
    if (c.id === "ai") {
      if (!showAiSetup) return null;
      return (
        <>
          <fieldset className={s.fieldset} data-testid="ai-provider">
            <legend className={s.legend}>Who provides the AI</legend>
            <label className={s.radio}><input type="radio" name="ai-provider" checked readOnly /> <span>Anthropic, with your company&apos;s own key</span></label>
          </fieldset>
          <p className={s.body} data-testid="ai-cap-line">Monthly limit (your own key): {poundsAndPence(1000)} a month. Used this month: {poundsAndPence(0)}.</p>
          <p className={s.body} data-testid="ai-assistant-line" data-state="off">Assistant: off</p>
          <form className={s.fieldset} aria-label="Anthropic API key" onSubmit={(e) => { e.preventDefault(); setKey(""); preview("The key would be saved, after an authenticator code. No key was stored."); }}>
            <p className={s.body}>Get a key from Anthropic: <a href={ANTHROPIC_KEYS_URL} target="_blank" rel="noopener noreferrer" className={s.link}>{ANTHROPIC_KEYS_URL}</a></p>
            <Field label="Anthropic API key" hint="It is stored encrypted and is never shown again. Saving it needs a fresh authenticator code." className={s.keyField}>
              <Input name="ai-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" />
            </Field>
            <div><Button type="submit" variant="secondary" disabled={!key.trim()} data-testid="save-key">Save key</Button></div>
            <p className={s.small}>Replacing or removing the key switches AI off. You turn it on again with the switch above.</p>
          </form>
          <form className={s.fieldset} aria-label="Monthly limit" onSubmit={(e) => { e.preventDefault(); preview("The monthly limit would be saved."); }}>
            <Field label="Monthly limit (£)" hint="When the limit is reached AI stops for the month. Saving it never turns AI on or off. If AI is on, saving asks for a fresh authenticator code." className={s.limitField}>
              <Input name="ai-limit" inputMode="decimal" autoComplete="off" value={limit} onChange={(e) => setLimit(e.target.value)} />
            </Field>
            <div><Button type="submit" variant="secondary" data-testid="save-limit">Save limit</Button></div>
          </form>
        </>
      );
    }
    if (c.id === "xero") {
      const linked = reconnect;
      const canConnect = xi.configured === true && xi.overview !== null;
      const amber = behaviour.kind === "unknown" || behaviour.kind === "needs_reconnect" || behaviour.kind === "held";
      return (
        <>
          <p className={cx(s.note, amber && s.noteWarn)} data-testid="xero-behaviour" data-kind={behaviour.kind}>{behaviour.text}</p>
          <div className={s.actions}>
            {linked ? null : <Button variant="primary" disabled={!canConnect} data-testid="xero-connect" onClick={() => preview("Xero sign-in would start. Nothing was connected.")}>Connect to Xero</Button>}
            {reconnect ? <Button variant="primary" data-testid="xero-connect-again" onClick={() => preview("Xero sign-in would start. Nothing was connected.")}>Connect again</Button> : null}
            {linked ? <Button variant="secondary" data-testid="xero-disconnect" onClick={() => setAsk("xero")}>Disconnect</Button> : null}
          </div>
        </>
      );
    }
    if (c.id === "microsoft") {
      const available = true;
      const notSet = overall === "not-set-up";
      return (
        <>
          <p className={s.small} data-testid="microsoft-one-mailbox">{MS_ONE_MAILBOX}</p>
          {reconnect ? <p className={cx(s.note, s.noteWarn)}>Microsoft 365 needs to be connected again.</p> : null}
          {available && !notSet && overall !== "checking" && overall !== "unreadable" ? (
            <div className={s.approve} data-testid="microsoft-admin-approval">
              <p style={{ margin: 0 }}><strong>If Microsoft says an administrator must approve first:</strong> your Microsoft administrator approves Tolra once. You can get a one-time link to send them (it shows exactly what Tolra asks for, and works for 24 hours).</p>
              <div><Button size="sm" variant="secondary" onClick={() => preview("A one-time approval link would be made. No link was made.")}>Get the link for your Microsoft admin</Button></div>
            </div>
          ) : null}
          <div className={s.actions}>
            <Button variant="primary" disabled={notSet || overall === "checking" || overall === "unreadable"} data-testid="ms-connect" onClick={() => preview("Microsoft sign-in would start. Nothing was connected.")}>{reconnect ? "Reconnect" : "Connect Microsoft 365"}</Button>
            {reconnect ? <Button variant="secondary" data-testid="ms-disconnect" onClick={() => setAsk("microsoft")}>Disconnect</Button> : null}
          </div>
        </>
      );
    }
    return (
      <div className={s.actions}>
        <Button size="sm" variant="secondary" disabled={overall !== "unreadable"} data-testid="resend-check" onClick={() => preview("The Resend domain check would run. No request was made.")}>Check domain</Button>
        <Button size="sm" variant="secondary" disabled data-testid="resend-test-send">Send a test e-mail to me</Button>
      </div>
    );
  };

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="integrations-preview" data-role={role} data-overall={overall}>
      <PreviewBar
        data-testid="preview-bar"
        controls={
          <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
            <div className={s.dock}>
              <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated, nothing is granted, nothing is connected and no request is made.</p>
              <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
              <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
              <p className={s.dockLabel}>What each card reports</p>
              <div className={s.dockStates} role="group" aria-label="What each card reports">
                {OVERALLS.map((x) => <button key={x.v} type="button" aria-pressed={overall === x.v} className={s.dockBtn} onClick={() => pick(x.v)}>{x.label}</button>)}
              </div>
              <Button size="sm" variant="secondary" data-testid="dock-reset" onClick={reset}>Reset preview</Button>
            </div>
          </Popover>
        }
      />
      <PageHeader
        title={denied ? "Access Denied" : PAGE_TITLE}
        description={denied ? "Redirecting you back to the dashboard." : SUBTITLE}
      />

      {denied ? (
        <section className={s.denied} data-testid="access-denied" aria-label="Access denied">
          <p className={s.deniedNote}>Only an admin can set up integrations.</p>
          <p className={s.deniedPreview}>Preview only: no redirect happens here. Integrations are for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : (
        <div className={s.stack}>
          <p className={s.company} data-testid="integrations-company">For <strong>{COMPANY_NAME}</strong>. Each company has its own page: switch company to set up the other.</p>
          <div className={s.cards} data-testid="integrations-setup-cards">
            {cards.slice(0, 2).map((c) => <SetupCard key={c.id} c={c} onToggle={() => preview(`${c.activation.label} would change. The switch stays as drawn here.`)}>{extras(c)}</SetupCard>)}
            <Panel title="Which e-mail should Tolra send from?" data-testid="email-choice-guide">
              <div className={s.card}>
                <p className={s.small}>Pick one of the two below. You do not need both.</p>
                <p className={s.body}>{EMAIL_CHOICE_OUTLOOK}</p>
                <p className={s.body}>{EMAIL_CHOICE_OTHER}</p>
                <p className={s.small}>{EMAIL_CHOICE_APPROVAL}</p>
              </div>
            </Panel>
            {cards.slice(2).map((c) => <SetupCard key={c.id} c={c} onToggle={() => undefined}>{extras(c)}</SetupCard>)}
          </div>

          <section className={s.section} aria-labelledby="integrations-more-title" data-testid="integrations-more">
            <h2 id="integrations-more-title" className={s.h2}>More</h2>
            <p className={s.body}>{MORE_TEXT}</p>
            <p className={s.body} data-testid="ai-more-note">AI is switched on or off in the AI card above. Which AI features are used, and the monthly limit, are on the <a href="/ai-helper" className={s.link}>AI settings page</a>.</p>
            <Panel title="Xero: send now and the accountant's link" data-testid="xero-more">
              {overall === "checking" || overall === "unreadable" ? <p className={s.small} role="status">Loading…</p> : (
                <div className={s.card}>
                  <p className={s.body}>One way, Tolra to Xero: issued invoices, issued credit notes and their customers, with Tolra&apos;s numbers. Voids are sent as voids. Nothing is ever read back into Tolra; payments stay in Xero.</p>
                  <p className={s.conn} data-testid="xero-status"><strong>{cardStatusLabel(xi.overview!)}</strong></p>
                  {reconnect ? <p className={cx(s.note, s.noteWarn)}>Xero needs to be connected again. Sending is paused until an admin connects again.</p> : null}
                  {xv.notSetUp ? <p className={s.note} data-testid="xero-not-set-up">{xv.message}</p> : null}
                  {xv.notSetUp ? null : (
                    <div className={s.invite} data-testid="xero-invite">
                      <p className={s.conn}><strong>The accountant does the Xero sign-in?</strong></p>
                      <div className={s.inviteRow}>
                        <Field label="Accountant's e-mail address" className={s.inviteField}>
                          <Input type="email" placeholder="accountant@firm.example" value={accountant} onChange={(e) => setAccountant(e.target.value)} data-testid="xero-invite-email" />
                        </Field>
                        <Button variant="secondary" disabled={!accountant.trim()} data-testid="xero-invite-send" onClick={() => preview("A connect link would be e-mailed to the accountant. No e-mail was sent.")}>E-mail the accountant a connect link</Button>
                      </div>
                    </div>
                  )}
                  <p className={s.small}>Each company connects its own Xero organisation. Documents issued before the company connects are never sent.</p>
                </div>
              )}
            </Panel>
            <Panel title="Accounting status" bare data-testid="accounting-status">
              <div style={{ padding: "0 18px 14px" }}><p className={s.body}>This shows setup and the latest recorded transfer. It does not test a live account.</p></div>
              {rows === null ? <div role="status" style={{ padding: "0 18px 16px" }}><LoadingState label="Loading status…" rows={2} /></div>
                : rows === "unavailable" ? <p role="status" className={s.note} style={{ margin: "0 18px 16px" }}>Status unavailable. No readiness is confirmed.</p> : (
                  <ScrollTable label="Accounting status table" dense>
                    <thead><tr>{["Provider", "Available", "Setup", "Connection", "Mapping", "Transfers", "Ready", "Last transfer", "Failures"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                    <tbody>
                      {rows.map((r) => <tr key={r.id}>{[r.name, r.available ? "Available" : "Unavailable", r.configuration, r.connection, r.mapping, r.transfers, r.readiness, r.lastTransfer, r.failures].map((v, i) => <td key={i}>{v}</td>)}</tr>)}
                    </tbody>
                  </ScrollTable>
                )}
            </Panel>
          </section>
        </div>
      )}

      <Dialog
        open={ask !== null}
        title={ask === "microsoft" ? MS_DISCONNECT_TITLE : XERO_DISCONNECT_TITLE}
        description={ask === "microsoft" ? MS_DISCONNECT_TEXT : XERO_DISCONNECT_TEXT}
        confirmLabel="Disconnect"
        onConfirm={() => { const a = ask; setAsk(null); preview(a === "microsoft" ? "Microsoft 365 would be disconnected." : "Xero would be disconnected."); }}
        onClose={() => setAsk(null)}
      />
    </div>
  );
}

/** The shared frame of the four guided cards: title and state word, one sentence, CONNECTION, numbered steps, the card's own controls, ACTIVATION (its own switch, never on here), footnote. */
function SetupCard({ c, children, onToggle }: { c: CardModel; children?: ReactNode; onToggle: () => void }) {
  const toneClass = c.connection.tone === "attention" ? s.connAttention : c.connection.tone === "working" ? s.connWorking : s.connLabel;
  return (
    <Panel title={c.title} actions={<StatusBadge tone="neutral"><span data-testid={`activation-badge-${c.id}`}>{badgeFor(c)}</span></StatusBadge>} data-testid={`setup-card-${c.id}`}>
      <div className={s.card}>
        <p className={s.body}>{c.summary}</p>
        <p className={s.conn} data-testid={`connection-${c.id}`}><strong>Connection: </strong><span className={toneClass}>{c.connection.label}</span></p>
        {c.steps.length ? (
          <ol className={s.steps} aria-label={`${c.title} setup steps`}>
            {c.steps.map((st, i) => (
              <li key={st.label} data-state={st.state} className={cx(s.step, st.state === "done" && s.stepDone, st.state === "next" && s.stepNext, st.state === "later" && s.stepLater)}>
                <span className={s.stepState}>{i + 1}. {st.state === "done" ? "Done" : st.state === "next" ? "Next" : "Later"}</span>
                <span className={s.stepLabel}>{st.label}</span>
                {st.hint ? <p className={s.stepHint}>{st.hint}</p> : null}
              </li>
            ))}
          </ol>
        ) : null}
        {children ? <div className={s.extras}>{children}</div> : null}
        {c.activation.hideSwitch ? (
          <div className={s.activation} data-testid={`activation-${c.id}`}>
            <p className={s.activationStatus} data-testid={`activation-status-${c.id}`}>{c.activation.statusText}</p>
            {c.activation.help ? <p className={s.small}>{c.activation.help}</p> : null}
          </div>
        ) : (
          <div className={s.activation} data-testid={`activation-${c.id}`}>
            <Switch label={c.activation.label} checked={false} onChange={onToggle} disabled hideState={c.activation.on === null} />
            {c.activation.help ? <p className={s.small}>{c.activation.help}</p> : null}
            {c.activation.disabledReason ? <p className={s.why} data-testid={`activation-why-${c.id}`}>{c.activation.disabledReason}</p> : null}
          </div>
        )}
        {c.footnote ? <p className={s.small}>{c.footnote}</p> : null}
      </div>
    </Panel>
  );
}
