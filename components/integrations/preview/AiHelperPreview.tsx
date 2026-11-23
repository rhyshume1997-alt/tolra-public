"use client";

/**
 * BOUNDARY (AI section, Integrations module 6 by the coordinator's decision: ASSUMPTION for the project owner to confirm, docs/MODULES.md does not list app/(dashboard)/ai-helper; PREVIEW ONLY).
 * Inputs: none from the server. Everything shown is fictional sample data held in this file, plus the person's clicks. Outputs: a look-and-feel prototype of the real AI page
 * (app/(dashboard)/ai-helper/page.tsx and components/ai-helper/*): the header, the "What this shows" card, the manage notice, the Round-up, RFQ email to draft quote and Tooly assistant panels, and
 * every state the real page has (loading, not switched on for this server, could not be loaded, AI off for this company as admin and as office, Access Denied). The only state is LOCAL UI state.
 * It calls NO model, AI provider, costing engine, server route or mail, and it NEVER shows a generated answer: Make round-up, Read email, Ask, Approve, Reject and Copy draft answer only with the
 * neutral "Preview only ... Nothing was saved." toast. The result areas (summary, suggestion, answer, draft) can be switched on from "Preview controls" and then hold only clearly labelled placeholder
 * text, "Sample answer, not generated", never something that reads as a real answer. The only checks that run are the real page's own local checks (required fields before Approve, attachments refused).
 * Run-time imports from lib/ are pure constants only (lib/ai-helper/limits RFQ_MAX_CHARS, lib/ai-helper/rfq ATTACHMENTS_REFUSED, components/tooly/poses). The few rules that live inline in the real files
 * (which panels show, the notices, the validation sentences, the labels) are mirrored here and pinned to that source text by tests/unit/aiHelperPreview.test.ts.
 * MUST NOT CHANGE: wording and the show/hide rules mirror today's page (admin and office only; setting AI up is NOT done here, it only links to Admin > Integrations). Do not wire this file to real data, a model
 * or a key, do not add a control the real page lacks, and never present a placeholder as an answer. Delete the four preview files to remove it.
 */

import { useCallback, useMemo, useState } from "react";
import { Button, Callout, Field, Input, Panel, Popover, SegmentedControl, Select, Switch, Textarea, ToastProvider, cx, premiumTokens, tabularNumbers, useToast } from "@/components/ui/premium";
import { RFQ_MAX_CHARS } from "@/lib/ai-helper/limits";
import { ATTACHMENTS_REFUSED } from "@/lib/ai-helper/rfq";
import { TOOLY_POSES } from "@/components/tooly/poses";

import s from "./AiHelperPreview.module.css";

/* ================================================================== */
/* 1. Types and constants                                              */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type Load = "loaded" | "loading" | "error";
export type Assistant = "unavailable" | "off" | "on";
/** The status the real page reads from /api/ai-helper/status (only the fields the page uses). */
export type Status = { roundup_enabled: boolean; rfq_enabled: boolean; can_manage: boolean; assistant_available: boolean; assistant_enabled: boolean };

/** The real page's words, pinned by the tests. */
export const PAGE_TITLE = "AI";
export const PAGE_SUBTITLE = "Suggestions for office paperwork. A person checks and approves everything; it never sends, issues, approves, voids, records payments or edits records.";
export const LOADING = "Loading...";
export const UNAVAILABLE = "The AI section is not switched on for this server.";
export const LOAD_ERROR = "The AI section could not be loaded. Try again in a moment.";
export const OFF_BASE = "AI is off for this company.";
export const OFF_MANAGE = " Turn it on in Admin > Integrations.";
export const OFF_NO_MANAGE = " An admin can turn it on in Admin > Integrations.";
export const MANAGE_ADMIN = "AI is set up in one place now, the AI card on Admin > Integrations: your key, the on/off switch and the monthly limit.";
export const MANAGE_LINK = "Open Admin > Integrations";
export const MANAGE_OTHER = "Only an admin sets up AI or turns it on or off. They do it in the AI card on Admin > Integrations.";
export const AI_SETUP_HREF = "/admin/integrations#ai";
export const WHAT_TITLE = "What this shows";
export const WHAT_INTRO = "The AI only suggests. A person checks and approves everything. It never sends, issues, approves, voids, records payments or edits your records.";
export const WHAT_ITEMS: Array<{ name: string; text: string }> = [
  { name: "Round-up.", text: "A daily or weekly summary of work that is late, waiting or unbilled, in plain words. It is read-only: it uses the same figures as your dashboard and changes nothing." },
  { name: "RFQ e-mail to draft quote.", text: "Paste a customer's RFQ e-mail and it prepares a draft quote. Prices come only from your fixed calculation, never from the AI, and anything it is unsure of is marked Needs human review. Nothing is saved until you approve it, and then only as a draft." },
  { name: "Finance check.", text: "Before you issue an invoice, purchase order or credit note, it lists suggestions on the draft (for example totals that do not add up, or a possible duplicate). You can accept or dismiss each one, and you can always issue without waiting for it." },
  { name: "Assistant.", text: "Ask a question about your recent quotes or jobs, or ask for a draft (a chaser e-mail, a note, quote wording). It only sees references, statuses and dates (no amounts, notes or contact details; customer names are replaced before anything leaves Tolra). Drafts are text for you to copy: it never sends, saves or changes anything." },
];
export const PLACEHOLDER_ANSWER = "Sample answer, not generated";
export const ROUNDUP = { title: "Round-up", text: "What is late, waiting or not yet invoiced, from your own records. Read only.", periods: [{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }], make: "Make round-up", periodLabel: "Round-up period" };
export const RFQ = {
  title: "RFQ email to draft quote",
  text: "Paste the customer's email text. Attachments and drawings are not read yet (a later version). Anything missing or unclear is marked \"Needs human review\"; prices come only from your costing calculation, worked out again when you approve. A line it can't price is saved at £0.00 and marked for you to price in the draft. Nothing is saved until you approve it, and it is only ever a draft.",
  read: "Read email", approve: "Approve and create draft quote", reject: "Reject", textLabel: "RFQ email text",
  noPrice: "No price yet: priced from your costing calculation when you approve, or saved at £0.00 for you to price in the draft",
};
export const ASSISTANT = {
  title: "Tooly", tag: "Your workshop helper. Suggestions only.",
  text: "Ask about your recent quotes or jobs, or ask for a draft. Suggestions only: it never sends, saves or changes anything. Online only.",
  topics: [{ value: "quotes", label: "Quotes" }, { value: "jobs", label: "Jobs" }], ask: "Ask", copy: "Copy draft",
  placeholder: "For example: which quotes are still waiting for a reply? Draft a chaser for the oldest.",
};
export const REVIEW_FIELDS = ["description", "part_number", "material", "finish", "quantity", "due_date", "price"] as const;
export const FIELD_LABEL: Record<(typeof REVIEW_FIELDS)[number], string> = { description: "description", part_number: "part number", material: "material", finish: "finish", quantity: "quantity", due_date: "due date", price: "price" };
/** The roundup sections the page shows are the dashboard's own "Needs attention" rules; three real titles for the placeholder list. */
export const SAMPLE_SECTIONS = ["Jobs past their required date", "Purchase orders past their expected delivery", "Complete jobs not yet fully despatched or invoiced"];

/* ================================================================== */
/* 2. Logic (mirrors the real page and panels)                          */
/* ================================================================== */

export const canUseAi = (role: Role) => role === "admin" || role === "office";
/** components/ai-helper/use-ai-helper-status.ts anyFeatureOn. */
export const anyFeatureOn = (st: Status | null) => Boolean(st && (st.roundup_enabled || st.rfq_enabled || (st.assistant_available && st.assistant_enabled)));
export const offNotice = (canManage: boolean) => `${OFF_BASE}${canManage ? OFF_MANAGE : OFF_NO_MANAGE}`;
export const showsAssistant = (st: Status) => st.assistant_available && st.assistant_enabled;
export type RfqLine = { description: string; quantity: string };
/** rfq-panel.tsx approve(): the checks that run before anything is asked of the server. Returns the sentence shown, or null when the checks pass. */
export function approveBlock(customer: string, lines: readonly RfqLine[]): string | null {
  const missing = lines.findIndex((l) => !l.description.trim() || !/^\d+$/.test(l.quantity.trim()) || !(Number(l.quantity) > 0));
  if (!customer.trim()) return "Enter the customer before approving.";
  if (!lines.length) return "There are no lines to quote.";
  if (missing >= 0) return `Line ${missing + 1}: fill in the description and a whole-number quantity (or remove the line) before approving.`;
  return null;
}

/* ================================================================== */
/* 3. The page                                                         */
/* ================================================================== */

const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SERVER: Array<{ value: "on" | "off"; label: string }> = [{ value: "off", label: "Off (default)" }, { value: "on", label: "On" }];
const LOADS: Array<{ value: Load; label: string }> = [{ value: "loaded", label: "Read" }, { value: "loading", label: "Loading" }, { value: "error", label: "Could not be loaded" }];
const ASSISTANTS: Array<{ value: Assistant; label: string }> = [{ value: "unavailable", label: "Not offered" }, { value: "off", label: "Off" }, { value: "on", label: "On" }];

export default function AiHelperPreview() {
  return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>;
}

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [server, setServer] = useState(true);
  const [load, setLoad] = useState<Load>("loaded");
  const [roundup, setRoundup] = useState(true);
  const [rfq, setRfq] = useState(true);
  const [assistant, setAssistant] = useState<Assistant>("on");
  const [canManage, setCanManage] = useState(true);
  const [samples, setSamples] = useState(false);
  const status: Status = useMemo(() => ({ roundup_enabled: roundup, rfq_enabled: rfq, can_manage: canManage, assistant_available: assistant !== "unavailable", assistant_enabled: assistant === "on" }), [roundup, rfq, canManage, assistant]);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const resetAll = () => { setRole("admin"); setServer(true); setLoad("loaded"); setRoundup(true); setRfq(true); setAssistant("on"); setCanManage(true); setSamples(false); toast.clear(); };
  const denied = !canUseAi(role);
  const loaded = load !== "loading";

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="ai-preview" data-role={role}>
      <header className={s.head}>
        <div className={s.headText}>
          {denied ? null : <h1 className={s.title}>{PAGE_TITLE}</h1>}
          {denied ? null : <p className={s.subtitle}>{PAGE_SUBTITLE}</p>}
        </div>
        <div className={s.previewBar}>
          <span className={s.previewTag} title="Everything on this screen is fictional. Nothing is read from or saved to your account, and no AI is called.">Preview, sample data, nothing is saved</span>
          <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
            <div className={s.dock}>
              <p className={s.dockNote}>Not part of Tolra. No AI, model or server is called. States are simulated; result areas hold placeholder text only.</p>
              <p className={s.dockLabel}>Role</p>
              <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
              <p className={s.dockLabel}>AI section on this server</p>
              <SegmentedControl label="Server switch" value={server ? "on" : "off"} options={SERVER} size="sm" onChange={(v) => setServer(v === "on")} />
              <p className={s.dockLabel}>Company status read</p>
              <SegmentedControl label="Status read" value={load} options={LOADS} size="sm" onChange={setLoad} />
              <p className={s.dockLabel}>Features the company has on</p>
              <Switch label="Round-up" checked={roundup} onChange={setRoundup} />
              <Switch label="RFQ email to draft quote" checked={rfq} onChange={setRfq} />
              <p className={s.dockLabel}>Assistant</p>
              <SegmentedControl label="Assistant" value={assistant} options={ASSISTANTS} size="sm" onChange={setAssistant} />
              <Switch label="This person can manage AI (admin)" checked={canManage} onChange={setCanManage} />
              <Switch label="Show result areas (placeholders only)" checked={samples} onChange={setSamples} data-testid="samples" />
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
      ) : !loaded ? (
        <p className={s.plain} data-testid="loading">{LOADING}</p>
      ) : !server ? (
        <p className={s.statement} data-testid="ai-helper-unavailable">{UNAVAILABLE}</p>
      ) : load === "error" ? (
        <p className={s.statement} data-testid="ai-helper-error">{LOAD_ERROR}</p>
      ) : (
        <>
          {!anyFeatureOn(status) ? <p className={s.statement} data-testid="ai-helper-off">{offNotice(canManage)}</p> : null}
          <div className={s.statement} data-testid="ai-helper-manage-notice">
            {canManage ? (
              <p className={s.manage}>
                {MANAGE_ADMIN}{" "}
                <a href={AI_SETUP_HREF} className={s.link} data-testid="ai-helper-manage-link" onClick={(e) => { e.preventDefault(); preview("This opens Admin > Integrations."); }}>{MANAGE_LINK}</a>
              </p>
            ) : <p className={s.manage}>{MANAGE_OTHER}</p>}
          </div>
          <WhatItShows />
          {status.roundup_enabled ? <RoundupPanel samples={samples} preview={preview} /> : null}
          {status.rfq_enabled ? <RfqPanel samples={samples} preview={preview} /> : null}
          {showsAssistant(status) ? <AssistantPanel samples={samples} preview={preview} /> : null}
        </>
      )}
    </div>
  );
}

function WhatItShows() {
  return (
    <Panel title={WHAT_TITLE} headingLevel={2} data-testid="ai-what-it-shows">
      <p className={s.body}>{WHAT_INTRO}</p>
      <ul className={s.what}>
        {WHAT_ITEMS.map((i) => <li key={i.name}><strong>{i.name}</strong> {i.text}</li>)}
      </ul>
    </Panel>
  );
}

function Placeholder({ children = PLACEHOLDER_ANSWER, testId }: { children?: string; testId?: string }) {
  return <p className={s.placeholder} data-testid={testId}>{children}</p>;
}

function RoundupPanel({ samples, preview }: { samples: boolean; preview: (d: string) => void }) {
  const [period, setPeriod] = useState("daily");
  return (
    <Panel title={ROUNDUP.title} headingLevel={2} data-testid="ai-roundup-panel">
      <p className={s.body}>{ROUNDUP.text}</p>
      <div className={s.controls}>
        <Select aria-label={ROUNDUP.periodLabel} value={period} onChange={(e) => setPeriod(e.target.value)}>{ROUNDUP.periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
        <Button onClick={() => preview(`No ${period} round-up was made. No AI request was sent.`)}>{ROUNDUP.make}</Button>
      </div>
      {samples ? (
        <>
          <Placeholder testId="ai-roundup-summary" />
          <ul className={s.figures} aria-label="Round-up figures (placeholders)">
            {SAMPLE_SECTIONS.map((t) => (
              <li key={t} className={s.figure}>
                <span className={s.figureTitle}>{t}</span>
                <span className={s.figureCount}>Sample figure, not from your records</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}

function RfqPanel({ samples, preview }: { samples: boolean; preview: (d: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [customer, setCustomer] = useState("");
  const [lines, setLines] = useState<Array<RfqLine & { id: number }>>([{ id: 1, description: "", quantity: "" }]);
  const refuseFiles = (event: React.DragEvent | React.ClipboardEvent) => {
    const files = "dataTransfer" in event ? event.dataTransfer?.files : event.clipboardData?.files;
    if (files && files.length > 0) { event.preventDefault(); setError(ATTACHMENTS_REFUSED); }
  };
  const approve = () => {
    const block = approveBlock(customer, lines);
    if (block) { setError(block); return; }
    setError(null);
    preview("No draft quote was created. No server was asked.");
  };
  return (
    <Panel title={RFQ.title} headingLevel={2} data-testid="ai-rfq-panel">
      <p className={s.body}>{RFQ.text}</p>
      <Field label={RFQ.textLabel}>
        <Textarea rows={5} maxLength={RFQ_MAX_CHARS} value={text} onChange={(e) => setText(e.target.value)} onDrop={refuseFiles} onPaste={refuseFiles} />
      </Field>
      <div className={s.controls}>
        <Button disabled={!text.trim()} onClick={() => preview("The email was not read. No AI request was sent.")}>{RFQ.read}</Button>
        <span className={cx(s.count, tabularNumbers)}>{text.length.toLocaleString("en-GB")} / {RFQ_MAX_CHARS.toLocaleString("en-GB")} characters</span>
      </div>
      {error ? <Callout tone="warn" lead="" role="alert" data-testid="ai-rfq-error">{error}</Callout> : null}
      {samples ? (
        <section aria-label="Suggested draft" className={s.suggest} data-testid="ai-rfq-suggestion">
          <Placeholder>Sample answer, not generated. In the real page the AI would fill the customer and the lines from the email; here every field is left for you to type.</Placeholder>
          <Field label="Customer"><Input aria-label="Customer" value={customer} onChange={(e) => setCustomer(e.target.value)} /></Field>
          {lines.length === 0 ? <p className={s.review}>Needs human review: no items were found in this email.</p> : null}
          {lines.map((line, index) => (
            <div key={line.id} className={s.line} data-testid={`ai-rfq-line-${index + 1}`}>
              <div className={s.flags}>{REVIEW_FIELDS.map((f) => <span key={f} className={s.flag}>Needs human review: {FIELD_LABEL[f]}</span>)}</div>
              <div className={s.lineGrid}>
                <Input aria-label={`Line ${index + 1} description`} placeholder="Description" value={line.description} onChange={(e) => setLines((r) => r.map((x) => (x.id === line.id ? { ...x, description: e.target.value } : x)))} />
                <Input aria-label={`Line ${index + 1} part number`} placeholder="Part number" />
                <Input aria-label={`Line ${index + 1} material`} placeholder="Material" />
                <Input aria-label={`Line ${index + 1} finish`} placeholder="Finish" />
                <Input aria-label={`Line ${index + 1} due date`} type="date" />
                <Input aria-label={`Line ${index + 1} quantity`} inputMode="numeric" placeholder="Quantity" value={line.quantity} onChange={(e) => setLines((r) => r.map((x) => (x.id === line.id ? { ...x, quantity: e.target.value } : x)))} />
                <span className={s.linePrice} data-testid={`ai-rfq-line-${index + 1}-price`}>{RFQ.noPrice}</span>
                <Button variant="secondary" size="sm" onClick={() => setLines((r) => r.filter((x) => x.id !== line.id))}>Remove line</Button>
              </div>
            </div>
          ))}
          <div className={s.controls}>
            <Button onClick={approve}>{RFQ.approve}</Button>
            <Button variant="secondary" onClick={() => preview("The suggestion was not rejected or recorded.")}>{RFQ.reject}</Button>
          </div>
        </section>
      ) : null}
    </Panel>
  );
}

function AssistantPanel({ samples, preview }: { samples: boolean; preview: (d: string) => void }) {
  const [topic, setTopic] = useState("quotes");
  const [question, setQuestion] = useState("");
  return (
    <Panel headingLevel={2} label="Tooly" data-testid="ai-assistant-panel">
      <div className={s.tooly}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={TOOLY_POSES.wave} alt="Tooly" width={64} height={64} className={s.toolyFace} data-testid="tooly-face" data-pose="wave" />
        <div>
          <h2 className={s.toolyTitle}>{ASSISTANT.title}</h2>
          <p className={s.toolyTag}>{ASSISTANT.tag}</p>
        </div>
      </div>
      <p className={s.body}>{ASSISTANT.text}</p>
      <div className={s.askForm}>
        <Select aria-label="Ask about" value={topic} onChange={(e) => setTopic(e.target.value)}>{ASSISTANT.topics.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>
        <Textarea aria-label="Your question" maxLength={1000} placeholder={ASSISTANT.placeholder} value={question} onChange={(e) => setQuestion(e.target.value)} />
        <div className={s.controls}><Button disabled={!question.trim()} onClick={() => preview(`Nothing was asked about ${topic}. No AI request was sent.`)}>{ASSISTANT.ask}</Button></div>
      </div>
      {samples ? (
        <>
          <Placeholder testId="ai-assistant-answer" />
          <div className={s.draft} data-testid="ai-assistant-draft">
            <p className={s.draftHead}>Draft (E-mail): check it before you use it. Nothing has been sent.</p>
            <p className={s.draftLine}>Subject: Sample answer, not generated</p>
            <p className={s.draftLine}>Sample answer, not generated</p>
            <div className={s.controls}><Button variant="secondary" onClick={() => preview("Nothing was copied.")}>{ASSISTANT.copy}</Button></div>
          </div>
        </>
      ) : null}
    </Panel>
  );
}
