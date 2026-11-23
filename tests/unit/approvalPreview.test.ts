// @vitest-environment jsdom
/**
 * BOUNDARY (Approval Queue, Module 4 by the coordinator's decision, PREVIEW ONLY). Inputs: the exports of components/approval/preview/ApprovalPreview.tsx and the SOURCE TEXT of
 * app/(dashboard)/approval/page.tsx, components/approval-recovery.tsx, components/chase/approval-card.tsx, components/reopen-approvals.tsx, lib/reopen-sign-off.ts, lib/org-settings.ts and
 * components/column-toggle.tsx (read as files, never run). Output: pass/fail. Pins the preview to today's Approval Queue: wording, the buttons and their order, who sees Resend, the settle and
 * reopen decisions, the confirm questions, the waiting count, the columns list and the role gate. Also checks that the sample holds only fictional ".example" addresses, that the preview imports nothing
 * that could read, write or send (and none of the chase, approval-recovery or reopen modules it reproduces), and that nothing reports success or changes the queue.
 * Must not change: never loosen these to make a change pass. No network, no Supabase, no mail. Written with createElement (no JSX) so it runs under the existing vitest.config.ts include pattern.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import ApprovalPreview, * as P from "@/components/approval/preview/ApprovalPreview";

const root = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(root, p), "utf8");
const PAGE = rd("app/(dashboard)/approval/page.tsx");
const RECOVERY = rd("components/approval-recovery.tsx");
const CHASE = rd("components/chase/approval-card.tsx");
const REOPEN = rd("components/reopen-approvals.tsx");
const REOPEN_LIB = rd("lib/reopen-sign-off.ts");
const ORG = rd("lib/org-settings.ts");
const COLTOG = rd("components/column-toggle.tsx");
const SRC = rd("components/approval/preview/ApprovalPreview.tsx");
const ROUTE = rd("app/(dashboard)/approval/preview/page.tsx");
const CSS = rd("components/approval/preview/ApprovalPreview.module.css");
const esc = (t: string) => t.replace(/'/g, "&apos;");

describe("approval preview: pinned to the real page's source text", () => {
  it("the header, the notices and the states are the real words", () => {
    expect(PAGE).toContain(`<h1 className="page-title">${P.PAGE_TITLE}</h1>`);
    expect(PAGE).toContain(P.PAGE_SUBTITLE);
    expect(PAGE).toContain(P.INFO);
    expect(PAGE).toContain('loading || error ? "" : ` ${approvals.length} draft${approvals.length === 1 ? "" : "s"} waiting.`');
    expect(PAGE).toContain("E-mail sending isn't set up for this company.");
    expect(PAGE).toContain("E-mail sending isn't set up, so this wasn't sent. Copy it or open it in your email client instead.");
    expect(PAGE).toContain(`"${P.LOAD_ERROR}"`);
    expect(PAGE).toContain(`<h3 className="mt-4 text-lg font-semibold text-slate-950">${P.NOTHING_WAITING}</h3>`);
    expect(PAGE).toContain(P.NOTHING_WAITING_TEXT);
    expect(PAGE).toContain(`<h2 className="text-xl font-semibold text-slate-950">${P.RECENT_TITLE}</h2>`);
    expect(PAGE).toContain(P.NOTHING_SENT);
    expect(PAGE).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(P.waitingText(1, false, false)).toBe(" 1 draft waiting.");
    expect(P.waitingText(6, false, false)).toBe(" 6 drafts waiting.");
    expect(P.waitingText(6, true, false)).toBe("");
    expect(P.waitingText(0, false, true)).toBe("");
    expect([P.canUseApproval("admin"), P.canUseApproval("office"), P.canUseApproval("workshop"), P.canUseApproval("viewer")]).toEqual([true, true, false, false]);
  });
  it("the card's buttons are the real ones in the real order, and Skip waits seven days", () => {
    const order = ["Copy to Clipboard", "Mark as Sent Manually", "Open in email app", "Edit", "Full preview"];
    let last = -1;
    for (const b of order) { const at = PAGE.indexOf(b, PAGE.indexOf("Copy to Clipboard") - 40); expect(at).toBeGreaterThan(last); last = at; }
    expect([...P.CARD_BUTTONS]).toEqual(order);
    expect(PAGE).toContain("const SKIP_DAYS = 7;");
    expect(P.SKIP_DAYS).toBe(7);
    expect(PAGE).toContain(">Skip</Button>");
  });
  it("the type labels and the tone rule are the real ones", () => {
    expect(PAGE).toContain('invoice: "INVOICE", quote: "QUOTE", sales_order: "SALES ORDER", purchase_order: "PURCHASE ORDER", delivery_note: "DELIVERY NOTE", rfq: "RFQ", job: "JOB", general: "GENERAL"');
    expect(PAGE).toContain('tone: type === "invoice" ? "amber" : "blue"');
    expect(PAGE).toContain("canApprove: String(row.related_to_id ?? \"\").startsWith(\"customer_statement:\") || (type === \"invoice\" && row.drafted_by === null)");
    for (const i of P.SEED_ITEMS) expect(i.tone).toBe(i.badge === "INVOICE" ? "amber" : "blue");
  });
  it("the preview box shows the first five lines, and the columns picker lists the real columns", () => {
    expect(PAGE).toContain('item.body.split("\\n").slice(0, 5)');
    expect(P.previewLines("1\n2\n3\n4\n5\n6")).toEqual(["1", "2", "3", "4", "5"]);
    expect(ORG).toContain('{ key: "approvals", label: "Approval Queue", columns: [{ key: "type", label: "Type" }, { key: "customer", label: "Recipient", locked: true }, { key: "detail", label: "Subject line", locked: true }, { key: "drafted", label: "Drafted date" }, { key: "to", label: "To address", locked: true }, { key: "subject", label: "Subject" }, { key: "preview", label: "Message preview" }] }');
    expect(P.COLUMN_LIST.filter((c) => c.locked).map((c) => c.key)).toEqual(["customer", "detail", "to"]);
    expect(COLTOG).toContain('return localOnly ? "Supabase unavailable: changes are saved in this browser only." : "Changes apply to everyone in this company.";');
    expect(COLTOG).toContain("Reset to default (show all columns)");
    expect(PAGE).toContain('isVisible("type")');
  });
  it("Send via Resend instead follows the real rule (offered AND failed before; on a card only when canApprove)", () => {
    expect(RECOVERY).toContain("if (!available || !failed) return null;");
    expect(RECOVERY).toContain("Send via Resend instead");
    expect(PAGE).toContain("item.canApprove ? <SendViaResendButton");
    expect(P.showsResend(true, true)).toBe(true);
    expect(P.showsResend(false, true)).toBe(false);
    expect(P.showsResend(true, false)).toBe(false);
    expect(P.cardShowsResend({ canApprove: false, failedBefore: true }, true)).toBe(false);
    expect(P.cardShowsResend({ canApprove: true, failedBefore: true }, true)).toBe(true);
    expect(P.RESEND_LABEL).toBe("Send via Resend instead");
  });
  it("the confirm questions are the real window.confirm texts", () => {
    expect(PAGE).toContain("`Send this exact reviewed message to ${item.to}?`");
    expect(PAGE).toContain("`Mark the email to ${item.customer} as sent? Only do this once you've actually sent it.`");
    expect(PAGE).toContain("`Skip this reminder? It won't show again for ${SKIP_DAYS} days.`");
    expect(RECOVERY).toContain("`Send this failed email through Resend instead?\\n\\nTo: ${recipient}\\nSubject: ${subject}\\n\\nThis is your own choice, it is recorded against your name, and it sends the message once.`");
    expect(PAGE).toContain("`Record that the email to ${item.to} WAS sent? Only do this after you have checked.`");
    expect(PAGE).toContain("`Record that the email to ${item.to} was NOT sent and return it to the queue? Only do this after you have checked.`");
    expect(REOPEN).toContain("`Reject the reopen of ${row.record_ref ?? \"this job\"}? Your decision is recorded; the job stays reopened and the work is not undone.`");
    expect(REOPEN).toContain("`Reject the reopen of ${row.record_ref ?? \"this job\"}? It is not reopened.`");
    expect(P.confirmSend("a@b.example")).toBe("Send this exact reviewed message to a@b.example?");
    expect(P.confirmMarkSent("Acme")).toBe("Mark the email to Acme as sent? Only do this once you've actually sent it.");
    expect(P.confirmSkip()).toBe("Skip this reminder? It won't show again for 7 days.");
    expect(P.confirmResend("a@b.example", "S")).toBe("Send this failed email through Resend instead?\n\nTo: a@b.example\nSubject: S\n\nThis is your own choice, it is recorded against your name, and it sends the message once.");
    expect(P.confirmHeld("a@b.example", "sent")).toContain("WAS sent?");
    expect(P.confirmHeld("a@b.example", "not_sent")).toContain("was NOT sent and return it to the queue?");
    expect(P.confirmReject("J-1", true)).toContain("stays reopened");
    expect(P.confirmReject(null, false)).toBe("Reject the reopen of this job? It is not reopened.");
  });
  it("the chase card's words and buttons are the real ones", () => {
    expect(CHASE).toContain("Payment reminder — {draft.customerName}");
    expect(CHASE).toContain("Invoice {draft.invoiceNumber} · To: {draft.to}");
    expect(CHASE).toContain("This is a draft. Check it before you approve and send it.");
    expect(CHASE).toContain("Enter a subject and a message before saving.");
    for (const b of ["Edit", "Approve and send", "Skip", "Pause chasing for this customer", "Save draft", "Cancel edit"]) expect(CHASE).toContain(`>${b}</Button>`);
    expect([...P.CHASE_BUTTONS]).toEqual(["Edit", "Approve and send", "Skip", "Pause chasing for this customer"]);
    expect(PAGE).toContain("<Button variant=\"outline\" onClick={() => void copyToClipboard(item)}>Copy draft</Button>");
    expect([...P.CHASE_MANUAL]).toEqual(["Copy draft", "Open in email app", "Mark as Sent Manually"]);
  });
  it("Needs checking and the reopen list are the real words, admin only for the decisions", () => {
    expect(RECOVERY).toContain(`<h2 className="text-xl font-semibold text-slate-950">${P.CHECKING.title}</h2>`);
    expect(RECOVERY).toContain(P.CHECKING.sending);
    expect(RECOVERY).toContain(P.CHECKING.unknown);
    expect(RECOVERY).toContain(esc(P.CHECKING.rest));
    expect(RECOVERY).toContain(P.CHECKING.sent);
    expect(RECOVERY).toContain(P.CHECKING.notSent);
    expect(RECOVERY).toContain(P.CHECKING.adminOnly);
    expect(RECOVERY).toContain("{isAdmin ? (");
    expect(REOPEN).toContain(P.REOPEN.title);
    expect(REOPEN).toContain(P.REOPEN.admin);
    expect(REOPEN).toContain(P.REOPEN.other);
    expect(REOPEN).toContain('const canDecide = activeRole === "admin";');
    expect(REOPEN).toContain("<span className=\"field-label\">Reason: </span>");
  });
  it("approvalLine is the real function's text", () => {
    expect(REOPEN_LIB).toContain('badge: "REOPENED, NO ADMIN WAS AVAILABLE", detail: `${ref} was reopened with the tick box. Approve to sign it off; rejecting records your decision but does not undo the reopen or the work done since.`, approveLabel: "Approve"');
    expect(REOPEN_LIB).toContain('badge: "WAITING FOR AN ADMIN", detail: `${ref} is not reopened yet. Approve to reopen it now; reject and it stays as it is.`, approveLabel: "Approve and reopen"');
    expect(P.approvalLine({ record_ref: "J-1", reopened_at: null })).toEqual({ badge: "WAITING FOR AN ADMIN", detail: "J-1 is not reopened yet. Approve to reopen it now; reject and it stays as it is.", approveLabel: "Approve and reopen" });
    expect(P.approvalLine({ record_ref: null, reopened_at: "2026-11-21T09:30:00Z" }).detail).toContain("The job was reopened with the tick box.");
  });
});

describe("approval preview: safety of the files and the sample", () => {
  it("imports nothing that could read, write or send, and none of the modules it reproduces", () => {
    const imports = [...SRC.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./ApprovalPreview.module.css", "@/components/ui/premium", "@/components/ui/premium", "@/lib/dates", "@/lib/product", "react"].sort());
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/supabase|fetch\(|XMLHttpRequest|navigator\.clipboard|window\.confirm|window\.location|mailto:|chase\/|approval-recovery|reopen-approvals|reopen-sign-off|localStorage|sessionStorage|\/api\//);
    expect(ROUTE.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/supabase|fetch\(|"use server"/);
  });
  it("every sample address is a reserved .example address and every body says it is sample text", () => {
    for (const i of [...P.SEED_ITEMS, ...P.SEED_HELD]) expect(i.to).toMatch(/^[a-z-]+@[a-z-]+\.example$/);
    for (const i of P.SEED_ITEMS) expect(i.body).toContain("This is sample text for the preview, not a real message.");
    expect(JSON.stringify([P.SEED_ITEMS, P.SEED_HELD, P.SEED_REOPEN, P.SEED_RECENT])).not.toMatch(/https?:|\b0\d{4}\s?\d{3}\s?\d{3}\b/);
    expect(P.SEED_ITEMS.filter((i) => i.chase)).toHaveLength(1);
  });
  it("the CSS has no gradient, blur or global selector, and each file carries a boundary comment naming the assumption", () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/gradient|backdrop-filter|blur\(/i);
    expect(css).not.toMatch(/^\s*(html|body|\*|:root)\b/m);
    for (const src of [SRC, ROUTE, CSS]) expect(src).toMatch(/BOUNDARY/);
    for (const src of [SRC, ROUTE]) expect(src).toMatch(/module 4/i);
  });
});

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let host: HTMLDivElement | null = null;
let rootEl: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => rootEl?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; rootEl = null; vi.restoreAllMocks(); vi.useRealTimers(); });
function mount() { host = document.createElement("div"); document.body.appendChild(host); rootEl = createRoot(host); act(() => rootEl!.render(createElement(ApprovalPreview))); return host; }
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
const dock = () => { const b = byText(document.body, "button", /Preview controls/); if (b?.getAttribute("aria-expanded") !== "true") click(b); };
const radio = (g: string, l: string) => { dock(); click(byText(document.body, `[role="radiogroup"][aria-label="${g}"] [role="radio"]`, l)); };
const pickScreen = (l: string) => { dock(); click(byText(document.body, '[role="group"][aria-label="Screen state"] button', l)); };
const sw = (label: string) => { dock(); click(byText(document.body, "label", new RegExp(label))?.querySelector('[role="switch"]')); };
const cards = (h: HTMLElement) => h.querySelectorAll("[data-approval]").length;
const inCard = (h: HTMLElement, id: string, text: string) => byText(h.querySelector(`[data-approval="${id}"]`)!, "button", text);

describe("approval preview: rendered behaviour", () => {
  it("labels itself, shows the title, the notice with the count, 6 drafts (one chase), and calls nothing", () => {
    const fetchSpy = vi.fn(() => { throw new Error("no network"); });
    vi.stubGlobal("fetch", fetchSpy);
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector("h1")?.textContent).toBe("Approval Queue");
    expect(h.querySelector('[data-testid="approval-info"]')?.textContent).toContain("6 drafts waiting.");
    expect(cards(h)).toBe(6);
    expect(h.querySelectorAll('[data-chase="true"]')).toHaveLength(1);
    expect(h.querySelector('[data-testid="needs-checking"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="reopen-list"]')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("a plain card has the five buttons and Skip; Resend only on the failed customer statement", () => {
    const h = mount();
    const labels = Array.from(h.querySelector('[data-approval="d1"]')!.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual([...P.CARD_BUTTONS, "Skip"]);
    expect(inCard(h, "d2", "Send via Resend instead")).toBeTruthy();
    expect(inCard(h, "d1", "Send via Resend instead")).toBeUndefined();
    sw("Resend offered");
    expect(inCard(h, "d2", "Send via Resend instead")).toBeUndefined();
  });
  it("Copy and Open in email app answer with the neutral toast and copy and open nothing", () => {
    const write = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    const h = mount();
    click(inCard(h, "d1", "Copy to Clipboard"));
    expect(document.body.textContent).toContain("Preview only");
    expect(document.body.textContent).toContain("was not copied. Nothing was saved.");
    click(inCard(h, "d1", "Open in email app"));
    expect(document.body.textContent).toContain("Your email app was not opened");
    expect(write).not.toHaveBeenCalled();
    expect(location.href).not.toMatch(/^mailto:/);
  });
  it("Mark as Sent Manually and Skip ask the real question first, then answer with the neutral toast, and the queue is unchanged", () => {
    const h = mount();
    click(inCard(h, "d1", "Mark as Sent Manually"));
    expect(document.querySelector('[data-testid="confirm-text"]')?.textContent).toBe("Mark the email to Halden Precision as sent? Only do this once you've actually sent it.");
    click(byText(document.body, "dialog button", "OK"));
    expect(document.body.textContent).toContain("Halden Precision was not marked as sent. Nothing was saved.");
    expect(document.body.textContent).not.toMatch(/Marked as sent manually|Sent\. You can check/);
    expect(cards(h)).toBe(6);
    click(inCard(h, "d4", "Skip"));
    expect(document.querySelector('[data-testid="confirm-text"]')?.textContent).toBe("Skip this reminder? It won't show again for 7 days.");
    click(byText(document.body, "dialog button", "Cancel"));
    expect(cards(h)).toBe(6);
  });
  it("Full preview shows Approve and send only for a draft that can be approved, and sending asks first and sends nothing", () => {
    const h = mount();
    click(inCard(h, "d4", "Full preview"));
    expect(byText(document.querySelector('[data-testid="dlg-full"]')!, "button", "Approve and send")).toBeUndefined();
    click(byText(document.body, "dialog button", "Close"));
    click(inCard(h, "d1", "Full preview"));
    click(byText(document.querySelector('[data-testid="dlg-full"]')!, "button", "Approve and send"));
    expect(document.querySelector('[data-testid="confirm-text"]')?.textContent).toBe("Send this exact reviewed message to accounts@halden-precision.example?");
    click(byText(document.body, "dialog button", "OK"));
    expect(document.body.textContent).toContain("Nothing was sent to accounts@halden-precision.example. Nothing was saved.");
    expect(document.body.textContent).not.toMatch(/Sent\. You can check|Sent to /);
  });
  it("Edit opens the real form and Save Draft saves nothing", () => {
    const h = mount();
    click(inCard(h, "d1", "Edit"));
    const dlg = document.querySelector('[data-testid="dlg-edit"]')!;
    expect(dlg.textContent).toContain("Edit Email");
    expect(dlg.textContent).toContain("Adjust the subject or message before sending.");
    click(byText(dlg, "button", "Save Draft"));
    expect(document.body.textContent).toContain("The draft was not updated. Nothing was saved.");
    expect(document.body.textContent).not.toContain("Draft updated");
  });
  it("the chase card edits locally, saves nothing, and Approve and send reports the real no-provider refusal only when sending is not set up", () => {
    const h = mount();
    click(inCard(h, "d3", "Approve and send"));
    expect(document.body.textContent).toContain("The reminder for Kestrel Components was not sent. Nothing was saved.");
    expect(h.querySelector('[data-testid="approval-no-provider"]')).toBeNull();
    radio("E-mail sending", "Not set up");
    click(inCard(h, "d3", "Approve and send"));
    expect(h.querySelector('[data-testid="approval-no-provider"]')?.textContent).toBe("E-mail sending isn't set up for this company.");
    expect(document.body.textContent).toContain(P.NO_PROVIDER_TOAST);
    click(inCard(h, "d3", "Edit"));
    const sub = h.querySelector<HTMLInputElement>('[data-approval="d3"] input')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(sub, ""); sub.dispatchEvent(new Event("input", { bubbles: true })); });
    click(inCard(h, "d3", "Save draft"));
    expect(h.querySelector('[data-approval="d3"] [role="alert"]')?.textContent).toBe("Enter a subject and a message before saving.");
  });
  it("Needs checking and the reopen decisions are admin only; office sees the real sentences", () => {
    const h = mount();
    expect(byText(h, "button", P.CHECKING.sent)).toBeTruthy();
    expect(byText(h, "button", "Approve and reopen")).toBeTruthy();
    click(byText(h, "button", "Reject"));
    expect(document.querySelector('[data-testid="confirm-text"]')?.textContent).toContain("Reject the reopen of J-0412? It is not reopened.");
    click(byText(document.body, "dialog button", "Cancel"));
    radio("Role", "Office");
    expect(byText(h, "button", P.CHECKING.sent)).toBeUndefined();
    expect(byText(h, "button", "Approve and reopen")).toBeUndefined();
    expect(h.textContent).toContain(P.CHECKING.adminOnly);
    expect(h.textContent).toContain(P.REOPEN.other);
  });
  it("the Columns picker hides a field on every card but never Recipient, Subject line or To address", () => {
    const h = mount();
    click(byText(h, "button", "Columns"));
    for (const k of ["customer", "detail", "to"]) expect(document.querySelector(`[data-testid="col-${k}"]`)?.textContent).toContain("Always shown");
    expect(h.querySelectorAll("[data-approval] dd").length).toBeGreaterThan(0);
    click(document.querySelector('[data-testid="col-type"] [role="switch"]') ?? document.querySelector('[data-testid="col-type"]'));
    expect(h.querySelector('[data-approval="d1"]')?.textContent).not.toContain("INVOICE");
  });
  it("loading, failed with Retry, and nothing waiting show the real sentences", () => {
    const h = mount();
    pickScreen("Loading");
    expect(h.textContent).toContain("Loading the approval queue");
    expect(h.querySelector('[data-testid="approval-info"]')?.textContent).not.toMatch(/waiting\.$/);
    pickScreen("Failed to load");
    expect(h.querySelector('[data-testid="load-error"]')?.textContent).toContain(P.LOAD_ERROR);
    expect(byText(h, "button", "Retry")).toBeTruthy();
    pickScreen("Nothing waiting");
    expect(h.textContent).toContain(P.NOTHING_WAITING_TEXT);
    expect(h.querySelector('[data-testid="approval-info"]')?.textContent).toContain("0 drafts waiting.");
  });
  it("Workshop and Viewer get Access Denied", () => {
    const h = mount();
    radio("Role", "Workshop");
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
    expect(cards(h)).toBe(0);
  });
});
