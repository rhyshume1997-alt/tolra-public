// @vitest-environment jsdom
/**
 * BOUNDARY (RFQ module 3, PREVIEW ONLY). Inputs: the exports of components/rfq/preview/RfqPreview.tsx, the REAL lib functions it uses or mirrors (lib/rfq-stage,
 * lib/rfq-display, lib/inbox-auto-check, lib/email/templates/defaults, lib/validation/schemas, lib/dates, lib/money) and the SOURCE TEXT of
 * app/(dashboard)/rfq/page.tsx (read as a file, never run). Output: pass/fail. Pins the preview to today's RFQ Control Centre: the stage and the figures of every sample
 * RFQ, the list filter, which main button a card shows, who sees Reply / Forward / Check inbox, the clarification texts, the form's choices and the form checks.
 * Also checks that the sample holds no live record, that the preview imports nothing that could read or write, and a few interaction rules (nothing reports
 * success, role gate, Columns) by rendering the preview.
 * v3 (owner-approved structure): also pins the Filters popover with its count and removable chips, the one-primary-plus-More row split (View, Reply and Forward live in More, and stay role gated),
 * the title tooltip that replaced the generic sentence, the plausible sample company and drama-range phone numbers, and that there is no selection bar here (the real page has no selection or export).
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX) so it is a .test.ts file and runs under the
 * existing vitest.config.ts include pattern.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import RfqPreview, * as P from "@/components/rfq/preview/RfqPreview";
import { fmtDate as realFmtDate } from "@/lib/dates";
import { renderTemplate } from "@/lib/email/templates/defaults";
import { rfqEmptyHint } from "@/lib/empty-hints";
import { runsInboxCheck } from "@/lib/inbox-auto-check";
import { gbp } from "@/lib/money";
import { RFQ_CARD_FIELDS, rfqCardFields, rfqPickerColumns } from "@/lib/rfq-display";
import * as real from "@/lib/rfq-stage";
import { customerName, emailSchema, moneyAmount, requiredText } from "@/lib/validation/schemas";

const root = path.resolve(__dirname, "../..");
const PAGE = readFileSync(path.join(root, "app/(dashboard)/rfq/page.tsx"), "utf8");
const PREVIEW_SRC = readFileSync(path.join(root, "components/rfq/preview/RfqPreview.tsx"), "utf8");
const CSS_SRC = readFileSync(path.join(root, "components/rfq/preview/RfqPreview.module.css"), "utf8");
const linked = real.linkedQuotes(P.SEED_QUOTES);
const stageOf = (r: (typeof P.SEED_RFQS)[number]) => real.rfqStage(r, linked.get(r.id));
const names = (rows: Array<{ customer: string; id: string }>) => rows.map((r) => r.id);

describe("rfq preview: stage and figures are the real functions, and the sample covers every stage", () => {
  it("uses lib/rfq-stage itself (the same functions, not copies)", () => {
    expect(P.rfqStage).toBe(real.rfqStage);
    expect(P.rfqFigures).toBe(real.rfqFigures);
    expect(P.linkedQuotes).toBe(real.linkedQuotes);
    expect(P.rfqStageLabel).toBe(real.rfqStageLabel);
    expect(P.rfqSpec).toBe(real.rfqSpec);
    expect(P.rfqCardFields).toBe(rfqCardFields);
  });
  it("14 sample RFQs: 7 outstanding (4 new, 2 clarification, 1 ready), 5 quoted, 1 won, 1 lost", () => {
    expect(P.SEED_RFQS).toHaveLength(14);
    const f = real.rfqFigures(P.SEED_RFQS, linked);
    expect(f).toEqual({ outstanding: 7, new: 4, clarification: 2, ready: 1, quoted: 5, won: 1, lost: 1 });
  });
  it("the best quote speaks for an RFQ: a sent quote beats a newer draft, accepted and rejected map to Won and Lost", () => {
    expect(linked.get("r01")).toMatchObject({ ref: "QUO-0391", status: "sent" });
    expect(stageOf(P.SEED_RFQS.find((r) => r.id === "r06")!)).toBe("won");
    expect(stageOf(P.SEED_RFQS.find((r) => r.id === "r05")!)).toBe("lost");
    expect(real.rfqStageLabel("quoted", linked.get("r12"))).toBe("Quoted, draft");
    expect(real.rfqStageLabel("quoted", linked.get("r08"))).toBe("Quoted, awaiting reply");
    // r04 has the intake status quoted but no quote row: still Quoted
    expect(stageOf(P.SEED_RFQS.find((r) => r.id === "r04")!)).toBe("quoted");
  });
  it("the sample covers the cases the page branches on: no e-mail address, no quantity or material, a very long name, a linked and a suggested e-mail", () => {
    expect(P.SEED_RFQS.some((r) => !r.email)).toBe(true);
    expect(P.SEED_RFQS.some((r) => real.rfqSpec(r.quantity, r.material).quantity === null && !real.rfqSpec(r.quantity, r.material).material)).toBe(true);
    expect(Math.max(...P.SEED_RFQS.map((r) => r.customer.length))).toBeGreaterThan(60);
    expect(P.SEED_EMAILS.map((e) => e.linkStatus).sort()).toEqual(["manual", "suggested", "suggested"]);
  });
  it("tile and chip counts are an em dash while loading or failed, never a stale number", () => {
    expect(P.tileCount(true, false, 4)).toBe("—");
    expect(P.tileCount(false, true, 4)).toBe("—");
    expect(P.tileCount(false, false, 4)).toBe("4");
    expect(PAGE).toContain('const count = (status: "new" | "clarification" | "ready") => (loading || error ? "\\u2014" : String(figures[status]));');
  });
});

describe("rfq preview: the list filter, the card buttons and the role gates mirror the page source", () => {
  it("the visible rows follow the page's filter expression", () => {
    expect(PAGE).toContain('(listFilter ? stageOf(rfq) === "outstanding" && rfq.status === "clarification" : (stage === "all" || stageOf(rfq) === stage) && matchesStatusFilter(filters, stageOf(rfq), rfq.status))');
    const all = (f: Partial<P.Filters>) => names(P.visibleRfqs(P.SEED_RFQS, linked, { ...P.DEFAULT_FILTERS, ...f }));
    expect(all({})).toHaveLength(7);
    expect(all({ stage: "all" })).toHaveLength(14);
    expect(all({ stage: "quoted" })).toHaveLength(5);
    expect(all({ statuses: new Set(["clarification"]) })).toEqual(["r10", "r09"]);
    // the status chips filter outstanding RFQs only: a quoted RFQ is never hidden by them
    expect(all({ stage: "all", statuses: new Set(["clarification"]) })).toHaveLength(2 + 7);
    expect(all({ listFilter: "clarification" })).toEqual(["r10", "r09"]);
    expect(all({ listFilter: "clarification", stage: "won" })).toEqual(["r10", "r09"]);
  });
  it("Show defaults to Outstanding with the page's order of stages, newest first", () => {
    expect(PAGE).toContain('const [stage, setStage] = useState<RfqStage | "all">("outstanding");');
    expect(PAGE).toContain('(["outstanding", "quoted", "won", "lost", "all"] as const)');
    expect(P.STAGES).toEqual(["outstanding", "quoted", "won", "lost"]);
    expect(P.newestFirst(P.SEED_RFQS)[0].id).toBe("r14");
  });
  it("Clarify only while outstanding and awaiting clarification; else Open QUO-x when a quote exists; else Quote", () => {
    expect(PAGE).toContain('rfq.status === "clarification" && stageOf(rfq) === "outstanding" ? <Button className="bg-amber-500 text-white hover:bg-amber-600" onClick={() => openClarify(rfq)}>Clarify</Button> : linked.get(rfq.id) ?');
    const main = (id: string) => P.cardMain(P.SEED_RFQS.find((r) => r.id === id)!, stageOf(P.SEED_RFQS.find((r) => r.id === id)!), linked.get(id));
    expect(main("r10")).toEqual({ kind: "clarify" });
    expect(main("r12")).toEqual({ kind: "open", ref: "QUO-0438", quoteId: "q38" });
    expect(main("r13")).toEqual({ kind: "quote" });
  });
  it("the status badge shows only while outstanding; otherwise the card says Quoted", () => {
    expect(PAGE).toContain('statusMeta[showsStatusBadge(stageOf(rfq)) ? rfq.status : "quoted"]');
    expect(P.shownStatus({ status: "ready" }, "outstanding")).toBe("ready");
    expect(P.shownStatus({ status: "ready" }, "won")).toBe("quoted");
  });
  it("Reply and Forward: admin only and only for an RFQ made from an e-mail", () => {
    expect(PAGE).toContain('profile?.role === "admin" && inboundByRfq.has(rfq.id)');
    expect(P.canReplyForward("admin", true)).toBe(true);
    expect(P.canReplyForward("office", true)).toBe(false);
    expect(P.canReplyForward("admin", false)).toBe(false);
  });
  it("Check inbox: hidden until the server says how the inbox is read; delegated for admin and office, the app mailbox for admins only", () => {
    expect(PAGE).toContain('{mailCheck ? <Button variant="outline" disabled={checking}');
    expect(PAGE).toContain("if (!holdsAdmin) return;");
    for (const role of ["admin", "office", "workshop", "viewer"] as const) {
      expect(P.showsCheckInbox(role, "delegated"), role).toBe(runsInboxCheck({ role }));
      expect(P.showsCheckInbox(role, "none"), role).toBe(false);
      expect(P.showsCheckInbox(role, "legacy"), role).toBe(role === "admin");
    }
  });
  it("only admin and office may open the screen (RoleGate allowed)", () => {
    expect(PAGE).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(["admin", "office", "workshop", "viewer"].map((r) => P.canUseRfq(r as P.Role))).toEqual([true, true, false, false]);
  });
});

describe("rfq preview: words, choices and checks are today's", () => {
  it("the three tiles, the status chips, the title and the empty hint", () => {
    expect(PAGE).toContain('[["New RFQs", count("new"), "new"], ["Waiting for details", count("clarification"), "clarification"], ["Ready to Quote", count("ready"), "ready"]]');
    expect(P.TILES.map((t) => [t.label, t.status])).toEqual([["New RFQs", "new"], ["Waiting for details", "clarification"], ["Ready to Quote", "ready"]]);
    expect(PAGE).toContain('options={[{ label: "All", value: "all" }, { label: "New", value: "new" }, { label: "Clarification", value: "clarification" }, { label: "Ready", value: "ready" }]}');
    expect(P.STATUS_CHIPS.map((c) => [c.label, c.value])).toEqual([["All", "all"], ["New", "new"], ["Clarification", "clarification"], ["Ready", "ready"]]);
    expect(PAGE).toContain("RFQ Control Centre");
    expect(PAGE).toContain("RFQ means request for quote: a customer asking us for a price.");
    expect(PAGE).toContain('label="RFQs awaiting clarification"');
    expect(P.LIST_FILTER_LABEL).toBe("RFQs awaiting clarification");
    expect(P.EMPTY_HINT).toBe(rfqEmptyHint());
    expect(PAGE).toContain("No RFQs match this filter");
    expect(PAGE).toContain("Try a different filter.");
  });
  it("the Columns picker lists the real card fields; Customer and Actions are always shown", () => {
    expect(RFQ_CARD_FIELDS.filter((f) => f.locked).map((f) => f.key)).toEqual(["customer", "actions"]);
    expect(rfqPickerColumns().map((c) => c.key)).toEqual(["status", "stage", "description", "value", "received"]);
    expect(rfqCardFields(["value", "customer"]).map((f) => f.key)).toEqual(["customer", "status", "stage", "description", "received", "actions"]);
  });
  it("Material choices and the intake status choices of the New RFQ form", () => {
    expect(PAGE).toContain('<option value="">Choose material</option><option>Titanium Grade 5</option><option>Aluminium 6082</option><option>Stainless Steel 304</option><option>Stainless Steel 316</option><option>Mild Steel</option><option>Brass C360</option><option>Other</option>');
    expect(P.MATERIALS).toEqual(["Titanium Grade 5", "Aluminium 6082", "Stainless Steel 304", "Stainless Steel 316", "Mild Steel", "Brass C360", "Other"]);
    expect(PAGE).toContain('<option value="new">New</option><option value="clarification">Clarification</option><option value="ready">Ready</option>');
    expect(PAGE).toContain("Create New RFQ");
    expect(PAGE).toContain("Enter what the customer needs and how far the request has got.");
    expect(PAGE).toContain("Save RFQ");
  });
  it("the three quick texts are the page's TEMPLATES, character for character", () => {
    for (const [name, t] of Object.entries(P.TEMPLATES)) {
      expect(PAGE, name).toContain(`"${name}": {`);
      expect(PAGE, name).toContain(`subject: ${JSON.stringify(t.subject)},`);
      const raw = JSON.stringify(t.body("${company}")).slice(1, -1);
      expect(PAGE, name).toContain("`" + raw + "`");
    }
    expect(Object.keys(P.TEMPLATES)).toEqual(["Material spec", "Missing drawings", "Quantity confirm"]);
  });
  it("the Clarify sheet opens with the real default clarification e-mail", () => {
    const e = renderTemplate("rfq_clarify", { company_name: P.COMPANY_NAME, customer_name: "Pemberton Packaging" }, null);
    expect(P.clarifyDefault(P.COMPANY_NAME, "Pemberton Packaging")).toEqual({ subject: e.subject, text: e.text });
    expect(PAGE).toContain('renderTemplate("rfq_clarify", { company_name: signOffName, customer_name: rfq.customer }, clarifyOverride)');
    expect(PAGE).toContain('toast.error("This RFQ has no email address. Add one before sending.");');
    expect(P.NO_EMAIL_MESSAGE).toBe("This RFQ has no email address. Add one before sending.");
    expect(PAGE).toContain("This opens your email app with the message ready to send. Once you&apos;ve sent it, log it here.");
  });
  it("Reply and Forward sheet words and enable rule", () => {
    expect(PAGE).toContain('mailing?.mode === "forward" ? "Forward email" : "Reply to email"');
    expect(PAGE).toContain("Sent from the connected Microsoft 365 mailbox.");
    expect(PAGE).toContain('disabled={saving || (mailing?.mode === "reply" ? !mailComment.trim() : !mailTo.trim())}');
  });
  it("a Clarify that gets logged moves the RFQ only while it is outstanding and not already there (real shouldMarkClarification)", () => {
    const r = (id: string) => P.SEED_RFQS.find((x) => x.id === id)!;
    expect(real.shouldMarkClarification(r("r14"), linked.get("r14"))).toBe(true);
    expect(real.shouldMarkClarification(r("r10"), linked.get("r10"))).toBe(false);
    expect(real.shouldMarkClarification(r("r12"), linked.get("r12"))).toBe(false);
  });
  it("the form checks say what the app's own validators say", () => {
    const msg = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }, v: unknown) => schema.safeParse(v).error?.issues[0]?.message;
    const bad = P.formErrors({ ...P.EMPTY_FORM, email: "nope", quantity: "-1", value: "-5" });
    expect(bad.customer).toBe(msg(customerName, ""));
    expect(bad.description).toBe(msg(requiredText, ""));
    expect(bad.email).toBe(msg(emailSchema, "nope"));
    expect(bad.value).toBe(msg(moneyAmount("Value"), -5));
    expect(P.formErrors({ ...P.EMPTY_FORM, customer: "A", description: "B", value: "1.234" }).value).toBe(msg(moneyAmount("Value"), 1.234));
    expect(P.formErrors({ ...P.EMPTY_FORM, customer: "A", description: "B", value: "12.5", quantity: "3", email: "a@b.example" })).toEqual({});
    expect(P.formSummary(bad).map((x) => x.key)).toEqual(["customer", "email", "description", "quantity", "value"]);
    expect(P.formSummary(bad)[1].message).toBe("Email: Enter a valid email address");
  });
  it("dates and money read as the real page prints them", () => {
    expect(P.fmtDate("2026-11-21")).toBe(realFmtDate("2026-11-21"));
    expect(P.fmtDate("2026-11-21")).toBe("21/11/2026");
    expect(P.money(5400)).toBe(gbp(5400, 0));
    expect(PAGE).toContain("gbp(rfq.value, 0)");
  });
});

describe("rfq preview: it is only a picture", () => {
  it("every sample address is on a reserved .example domain and no sample is a live record", () => {
    const text = JSON.stringify([P.SEED_RFQS, P.SEED_EMAILS]);
    const addresses = text.match(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/g) ?? [];
    expect(addresses.length).toBeGreaterThan(10);
    for (const a of addresses) expect(a.endsWith(".example"), a).toBe(true);
    expect(text).not.toMatch(/https?:\/\//);
  });
  it("imports nothing that can read, write, send or navigate", () => {
    const imports = PREVIEW_SRC.match(/from "[^"]+"/g) ?? [];
    expect([...new Set(imports)].sort()).toEqual([
      'from "@/components/ui/premium"', 'from "@/lib/dates"', 'from "@/lib/empty-hints"', 'from "@/lib/money"', 'from "@/lib/rfq-display"', 'from "@/lib/rfq-stage"', 'from "./RfqPreview.module.css"', 'from "react"',
    ].sort());
    expect(PREVIEW_SRC).not.toMatch(/supabase|fetch\(|XMLHttpRequest|window\.location|mailto:|navigator\.|sendBeacon|next\/navigation|next\/link/);
  });
  it("no gradient, blur or glass, and the sheet colours come from the shared tokens", () => {
    expect(CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/gradient|backdrop-filter|blur\(/);
  });
});

/* ---------------- rendered behaviour ---------------- */

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement | null = null;
let rootEl: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => rootEl?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; rootEl = null; vi.restoreAllMocks(); });
function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  rootEl = createRoot(host);
  act(() => rootEl!.render(createElement(RfqPreview)));
  return host;
}
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
const pickRole = (label: string) => { click(byText(document.body, "button", /Preview controls/)); click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"]', label)); };

describe("rfq preview: rendered behaviour", () => {
  it("labels itself, opens on Outstanding with 7 RFQs and the three tiles, and calls nothing", () => {
    const fetchSpy = vi.fn(() => { throw new Error("no network in the preview"); });
    vi.stubGlobal("fetch", fetchSpy);
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelectorAll("li[data-rfq]")).toHaveLength(7);
    expect(Array.from(h.querySelectorAll('[role="group"][aria-label="RFQ figures"] button')).map((b) => b.querySelector("span:nth-of-type(2)")?.textContent)).toEqual(["4", "2", "1"]);
    expect(byText(h, '[role="radiogroup"][aria-label="Show"] [role="radio"]', "Outstanding (7)")?.getAttribute("aria-checked")).toBe("true");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("a tile filters to its status, and Show: All lists all 14", () => {
    const h = mount();
    click(h.querySelector('[data-testid="tile-clarification"]'));
    expect(h.querySelectorAll("li[data-rfq]")).toHaveLength(2);
    expect(h.querySelector('[data-testid="tile-clarification"]')?.getAttribute("aria-pressed")).toBe("true");
    click(h.querySelector('[data-testid="filters-trigger"]'));
    click(document.querySelector('[data-testid="chip-all"]'));
    click(h.querySelector('[data-testid="show-all"]'));
    expect(h.querySelectorAll("li[data-rfq]")).toHaveLength(14);
  });
  it("the card buttons follow the rules: Clarify, Quote and Open QUO-x, and Reply and Forward for an admin only", () => {
    const h = mount();
    expect(h.querySelector('li[data-rfq="Pemberton Packaging"] [data-action="Clarify"]')).not.toBeNull();
    expect(h.querySelector('li[data-rfq="Kestrel Components"] [data-action="Quote"]')).not.toBeNull();
    click(h.querySelector('li[data-rfq="Halden Precision"] [data-testid="row-more"]'));
    expect(Array.from(document.querySelectorAll('[role="menu"][aria-label="More actions for Halden Precision"] [role="menuitem"]')).map((e) => e.textContent)).toEqual(["View", "Reply", "Forward"]);
    click(byText(document.body, '[role="menuitem"]', "Reply"));
    expect(document.querySelector('[data-testid="dlg-mail"]')?.textContent).toContain("Reply to email");
    click(byText(document.body, "dialog button", "Cancel"));
    click(h.querySelector('[data-testid="show-quoted"]'));
    expect(h.querySelector('li[data-rfq="Marlow Hydraulics"] [data-action="Open"]')?.textContent).toBe("Open QUO-0438");
    pickRole("Office");
    click(h.querySelector('[data-testid="show-outstanding"]'));
    click(h.querySelector('li[data-rfq="Halden Precision"] [data-testid="row-more"]'));
    expect(Array.from(document.querySelectorAll('[role="menu"][aria-label="More actions for Halden Precision"] [role="menuitem"]')).map((e) => e.textContent)).toEqual(["View"]);
    expect(h.querySelector('[data-testid="check-inbox"]')).not.toBeNull();
  });
  it("Quote, Open, Link and Check inbox answer with the neutral Preview-only toast and never a success", () => {
    vi.useFakeTimers();
    const h = mount();
    click(h.querySelector('li[data-rfq="Kestrel Components"] [data-action="Quote"]'));
    let text = document.body.textContent ?? "";
    expect(text).toContain("Preview only");
    expect(text).toContain("Nothing was saved.");
    expect(text).not.toMatch(/saved successfully|has been sent|sent successfully|RFQ saved/i);
    click(byText(h, "button", /Link to QUO-0426/));
    expect(document.body.textContent).toContain("This e-mail would be linked to QUO-0426. Nothing was saved.");
    click(h.querySelector('[data-testid="check-inbox"]'));
    expect(h.querySelector('[data-testid="check-inbox"]')?.textContent).toBe("Checking…");
    act(() => { vi.advanceTimersByTime(1000); });
    text = document.body.textContent ?? "";
    expect(text).toContain("The inbox was not read. No request was made.");
    vi.useRealTimers();
  });
  it("Clarify with no e-mail address says so, and logging it only ever answers with the Preview-only toast", () => {
    const h = mount();
    click(h.querySelector('li[data-rfq="Pemberton Packaging"] [data-action="Clarify"]'));
    expect(document.querySelector('[data-testid="dlg-clarify"]')?.textContent).toContain("Clarification Email");
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="dlg-clarify"] textarea')?.value).toContain("Best regards,\nFernhill Engineering Ltd");
    click(document.querySelector('[data-testid="open-mail"]'));
    expect(document.querySelector('[data-testid="dlg-clarify"] [role="alert"]')?.textContent).toBe("This RFQ has no email address. Add one before sending.");
    expect(document.querySelector('[data-testid="sent-it"]')).toBeNull();
  });
  it("Clarify with an address shows the step after the mail app, and the answer is a toast", () => {
    const h = mount();
    click(h.querySelector('li[data-rfq="Brightwell Valves"] [data-action="Clarify"]'));
    click(document.querySelector('[data-testid="open-mail"]'));
    expect(document.querySelector('[data-testid="sheet-status"]')?.textContent).toContain("Your e-mail app is not opened here");
    click(document.querySelector('[data-testid="sent-it"]'));
    expect(document.querySelector('[data-testid="dlg-clarify"]')).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).toContain("would be logged as sent manually");
    expect(text).toContain("Nothing was saved.");
  });
  it("the New RFQ form shows an error summary and an error by each field, and saves nothing", () => {
    const h = mount();
    click(h.querySelector('[data-testid="new-rfq"]'));
    click(byText(document.body, "dialog button", "Save RFQ"));
    expect(document.querySelector('[data-testid="error-summary"]')?.textContent).toContain("There are 2 problems with this RFQ");
    expect(document.querySelectorAll('dialog [aria-invalid="true"]')).toHaveLength(2);
    expect(document.querySelector('dialog [name="customer"]')?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Preview only");
  });
  it("Workshop and Viewer get Access Denied, as the real page's role gate", () => {
    const h = mount();
    pickRole("Workshop");
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
    expect(h.querySelector('[role="group"][aria-label="RFQ figures"]')).toBeNull();
    expect(h.querySelector('[data-testid="new-rfq"]')).toBeNull();
  });
  it("Columns hide a field on every card but never Customer or Actions", () => {
    const h = mount();
    click(h.querySelector('[data-testid="columns-trigger"]'));
    expect(document.querySelector('[data-testid="col-customer"]')?.textContent).toContain("Always shown");
    expect(document.querySelector('[data-testid="col-actions"]')?.textContent).toContain("Always shown");
    click(document.querySelector('[data-testid="col-value"]'));
    expect(h.querySelector("[data-rfq-field=value]")).toBeNull();
    expect(h.querySelector("[data-rfq-field=customer]")).not.toBeNull();
    expect(h.querySelector("[data-rfq-field=actions]")).not.toBeNull();
  });
});

/* ---------------- v3 structure (owner-approved items 1, 4, 7, 9, 10, 11) ---------------- */

describe("rfq preview v3: pure structure rules", () => {
  it("Filters (n) counts only the status chips; Show is not a chip; Clear filters shows only off the default", () => {
    expect(P.activeChips(P.DEFAULT_FILTERS)).toEqual([]);
    expect(P.popoverFilterCount({ ...P.DEFAULT_FILTERS, statuses: new Set(["new", "ready"]) })).toBe(2);
    expect(P.activeChips({ ...P.DEFAULT_FILTERS, statuses: new Set(["ready", "clarification"]) }).map((c) => c.label)).toEqual(["Status: Clarification", "Status: Ready"]);
    expect(P.popoverFilterCount({ ...P.DEFAULT_FILTERS, stage: "won" })).toBe(0);
    expect(P.isFiltered(P.DEFAULT_FILTERS)).toBe(false);
    expect(P.isFiltered({ ...P.DEFAULT_FILTERS, stage: "all" })).toBe(true);
    expect(P.isFiltered({ ...P.DEFAULT_FILTERS, statuses: new Set(["new"]) })).toBe(true);
    expect(P.isFiltered({ ...P.DEFAULT_FILTERS, listFilter: "clarification" })).toBe(true);
    expect([...P.toggleStatusIn(new Set(["all"]), "new")]).toEqual(["new"]);
    expect([...P.toggleStatusIn(new Set(["new"]), "new")]).toEqual(["all"]);
  });
  it("one primary (the card's main button) and More holds View, then Reply and Forward only for an admin on an e-mailed RFQ", () => {
    expect(P.rfqRowPlan("admin", true).more).toEqual(["view", "reply", "forward"]);
    expect(P.rfqRowPlan("admin", false).more).toEqual(["view"]);
    expect(P.rfqRowPlan("office", true).more).toEqual(["view"]);
  });
  it("the generic sentence is kept as the title tooltip; the sample company and phone numbers are plausible and on the Ofcom drama range", () => {
    expect(P.RFQ_INTRO).toBe("RFQ means request for quote: a customer asking us for a price.");
    expect(P.COMPANY_NAME).toBe("Fernhill Engineering Ltd");
    for (const r of P.SEED_RFQS) if (r.phone) expect(r.phone, r.customer).toMatch(/^0141 496 0\d{3}$/);
    expect(JSON.stringify(P.SEED_RFQS) + P.COMPANY_NAME).not.toMatch(/placeholder|testfield|mockridge|sampleford|dummerby|exampleton|Example Engineering/i);
  });
});

describe("rfq preview v3: rendered structure", () => {
  it("one PreviewBar, the title tooltip, no bulk bar and no export (the real page has neither)", () => {
    const h = mount();
    expect(h.querySelector('[data-testid="preview-bar"]')?.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector('[data-testid="rfq-title"]')?.getAttribute("title")).toBe(P.RFQ_INTRO);
    expect(h.querySelectorAll("h1")).toHaveLength(1);
    expect(h.querySelector("[data-selection]")).toBeNull();
    expect(h.querySelector('[data-testid="export-trigger"]')).toBeNull();
  });
  it("the filter toolbar is one row with a Filters popover, a count, removable chips and one Clear filters", () => {
    const h = mount();
    const trigger = h.querySelector<HTMLElement>('[data-testid="filters-trigger"]')!;
    expect(trigger.textContent?.trim()).toBe("Filters");
    expect(h.querySelector('[data-testid="clear-filters"]')).toBeNull();
    expect(h.querySelector('[data-testid="chip-new"]')).toBeNull();
    click(trigger);
    expect(Array.from(document.querySelectorAll('[role="dialog"][aria-label="Filters"] [aria-pressed]')).map((b) => b.textContent)).toEqual(["All", "New", "Clarification", "Ready"]);
    click(document.querySelector('[data-testid="chip-new"]'));
    expect(trigger.textContent?.trim()).toBe("Filters (1)");
    expect(h.querySelectorAll("li[data-rfq]")).toHaveLength(4);
    expect(h.querySelector('[data-testid="active-chips"] button')?.getAttribute("aria-label")).toBe("Remove filter Status: New");
    click(h.querySelector('[data-chip="new"]'));
    expect(trigger.textContent?.trim()).toBe("Filters");
    expect(h.querySelectorAll("li[data-rfq]")).toHaveLength(7);
    click(h.querySelector('[data-testid="show-won"]'));
    expect(h.querySelector('[data-testid="clear-filters"]')).not.toBeNull();
    click(h.querySelector('[data-testid="clear-filters"]'));
    expect(h.querySelectorAll("li[data-rfq]")).toHaveLength(7);
  });
  it("every row has exactly one primary action and a More menu naming its customer", () => {
    const h = mount();
    const rows = Array.from(h.querySelectorAll("li[data-rfq]"));
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r.querySelectorAll('[data-testid="row-primary"]')).toHaveLength(1);
      expect(r.querySelectorAll('[data-testid="row-more"]')).toHaveLength(1);
      expect(r.querySelector('[data-testid="row-more"]')?.getAttribute("aria-label")).toBe(`More actions for ${r.getAttribute("data-rfq")}`);
    }
    click(h.querySelector('li[data-rfq="Kestrel Components"] [data-testid="row-more"]'));
    click(byText(document.body, '[role="menuitem"]', "View"));
    expect(document.querySelector('[data-testid="dlg-view"]')?.textContent).toContain("Kestrel Components");
  });
  it("a Show count is an em dash while the list loads, never a stale number", () => {
    const h = mount();
    click(byText(document.body, "button", /Preview controls/));
    click(byText(document.body, '[role="dialog"][aria-label="Preview controls"] [aria-pressed]', "Loading"));
    expect(h.querySelector('[data-testid="show-outstanding"]')?.textContent).toMatch(/\(—\)$/);
  });
});
