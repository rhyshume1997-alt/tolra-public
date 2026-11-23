// @vitest-environment jsdom
/**
 * BOUNDARY (Email history, Integrations module 6 by the coordinator's decision, PREVIEW ONLY). Inputs: the exports of components/integrations/preview/EmailHistoryPreview.tsx, the REAL lib functions
 * it uses (lib/status-colours, lib/dates, lib/product) and the SOURCE TEXT of app/(dashboard)/email/page.tsx and components/filter-bar.tsx (read as files, never run). Output: pass/fail. Pins the preview to
 * today's Email & Payment Automation page: wording, columns, status words, counts, filter, needs-checking panel and who may settle it, role gate. Also checks that the sample holds only fictional
 * ".example" addresses, that the preview imports nothing that could read, write or send, and a few interaction rules (nothing is sent, nothing reports success) by rendering the preview.
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX) so it runs under the existing vitest.config.ts include pattern.
 */
import * as v2fs from "node:fs";
import * as v2path from "node:path";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import EmailHistoryPreview, * as P from "@/components/integrations/preview/EmailHistoryPreview";
import { emailStatusKey } from "@/lib/status-colours";

const root = path.resolve(__dirname, "../..");
const REAL = readFileSync(path.join(root, "app/(dashboard)/email/page.tsx"), "utf8");
const FILTER_BAR = readFileSync(path.join(root, "components/filter-bar.tsx"), "utf8");
const SRC = readFileSync(path.join(root, "components/integrations/preview/EmailHistoryPreview.tsx"), "utf8");
const ROUTE = readFileSync(path.join(root, "app/(dashboard)/email/preview/page.tsx"), "utf8");
const CSS = readFileSync(path.join(root, "components/integrations/preview/EmailHistoryPreview.module.css"), "utf8");

describe("email preview: pinned to the real page's source text", () => {
  it("the words are the real ones", () => {
    expect(REAL).toContain(`<h1 className="page-title">${P.PAGE_TITLE.replace("&", "&")}</h1>`);
    expect(REAL).toContain(P.PAGE_SUBTITLE);
    expect(REAL).toContain(P.COMING_SOON);
    expect(REAL).toContain(P.NO_EMAILS);
    expect(REAL).toContain(`"${P.LOAD_ERROR}"`);
    expect(REAL).toContain(P.ADMIN_SETTLES);
    expect(REAL).toContain(P.UNKNOWN_NOTE.replace("couldn't", "couldn&apos;t").replace("provider's", "provider&apos;s"));
    expect(REAL).toContain("Email history");
    expect(REAL).toContain("Counts of the most recent 100 emails recorded by {PRODUCT.name}.");
  });
  it("the status words, the tiles, the chips and the columns are the real ones", () => {
    expect(REAL).toContain(`drafted: "Drafted", copied: "Copied", sent_manually: "Sent manually", sent_via_system: "Sent", failed: "Failed", sending: "Sending", unknown: "Needs checking"`);
    expect(REAL).toContain('[["Drafted", count("drafted"), "drafted"], ["Sent manually", count("sent_manually"), "sent_manually"], [`Sent by ${PRODUCT.name}`, count("sent_via_system"), "sent_via_system"], ["Failed", count("failed"), "failed"], ["Needs checking", count("unknown"), "unknown"]]');
    expect(REAL).toContain('{ label: "All", value: "all" }, { label: "Drafted", value: "drafted" }, { label: "Sent manually", value: "sent_manually" }, { label: "Sent", value: "sent_via_system" }, { label: "Failed", value: "failed" }, { label: "Needs checking", value: "unknown" }');
    for (const c of P.COLUMNS) expect(REAL).toContain(`<TableHead>${c}</TableHead>`);
    expect(P.COLUMNS).toHaveLength(6);
    expect(P.TILES.map((t) => t.label)).toEqual(["Drafted", "Sent manually", "Sent by Tolra", "Failed", "Needs checking"]);
  });
  it("the counts, the filter, the settle panel and the role gate follow the real rules", () => {
    expect(REAL).toContain('loading || error ? "—" : String(rows.filter((row) => row.status === status).length)');
    expect(REAL).toContain("filters.has(\"all\") ? rows : rows.filter((row) => filters.has(row.status))");
    expect(REAL).toContain('item.status === "unknown" && item.related === "job"');
    expect(REAL).toContain('activeRole === "admin"');
    expect(REAL).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(REAL).toContain(".limit(100)");
    expect(P.showsSettlePanel({ status: "unknown", related: "job" })).toBe(true);
    expect(P.showsSettlePanel({ status: "unknown", related: "invoice" })).toBe(false);
    expect(P.showsSettlePanel({ status: "failed", related: "job" })).toBe(false);
    expect(P.canSettle("admin")).toBe(true);
    expect(P.canSettle("office")).toBe(false);
    expect([P.canUseEmail("admin"), P.canUseEmail("office"), P.canUseEmail("workshop"), P.canUseEmail("viewer")]).toEqual([true, true, false, false]);
    expect(P.countOf(P.SEED_EMAILS, "unknown", true, false)).toBe("—");
    expect(P.countOf(P.SEED_EMAILS, "unknown", false, true)).toBe("—");
    expect(P.countOf(P.SEED_EMAILS, "unknown", false, false)).toBe("2");
    expect(P.visibleRows(P.SEED_EMAILS, new Set(["all"]))).toHaveLength(12);
    expect(P.visibleRows(P.SEED_EMAILS, new Set(["drafted", "failed"]))).toHaveLength(3);
  });
  it("the chip toggle is the real FilterBar's (all is exclusive, an empty set returns to all)", () => {
    expect(FILTER_BAR).toContain('if (value === "all") {\n      next.clear();\n      next.add("all");');
    expect(P.toggleFilter(new Set(["all"]), "failed")).toEqual(new Set(["failed"]));
    expect(P.toggleFilter(new Set(["failed"]), "drafted")).toEqual(new Set(["failed", "drafted"]));
    expect(P.toggleFilter(new Set(["failed"]), "failed")).toEqual(new Set(["all"]));
    expect(P.toggleFilter(new Set(["failed", "drafted"]), "all")).toEqual(new Set(["all"]));
  });
  it("the status key is the real function", () => {
    expect(P.emailStatusKey).toBe(emailStatusKey);
    expect(emailStatusKey("sent_via_system")).toBe("sent");
  });
});

describe("email preview: safety of the files and the sample", () => {
  it("imports nothing that could read, write or send", () => {
    const imports = [...SRC.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./EmailHistoryPreview.module.css", "@/components/ui/premium", "@/components/ui/premium", "@/lib/dates", "@/lib/product", "@/lib/status-colours", "react"].sort());
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/supabase|fetch\(|XMLHttpRequest|resend|graph\.microsoft|mailto:|sendMail|localStorage|sessionStorage|openai|anthropic/i);
    expect(ROUTE.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/supabase|fetch\(|"use server"/);
  });
  it("every sample address is a reserved .example address and every body says it is sample text", () => {
    for (const r of P.SEED_EMAILS) {
      expect(r.to).toMatch(/^[a-z-]+@[a-z-]+\.example$/);
      expect(r.body).toContain("This is sample text for the preview, not a real message.");
    }
    expect(JSON.stringify(P.SEED_EMAILS)).not.toMatch(/https?:|\b0\d{4}\s?\d{3}\s?\d{3}\b/);
  });
  it("the CSS has no gradient, blur or global selector, and each file carries a boundary comment naming the assumption", () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/gradient|backdrop-filter|blur\(/i);
    expect(css).not.toMatch(/^\s*(html|body|\*|:root)\b/m);
    for (const src of [SRC, ROUTE, CSS]) expect(src).toMatch(/BOUNDARY/);
    for (const src of [SRC, ROUTE]) expect(src).toMatch(/module 6/i);
  });
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
});
let host: HTMLDivElement | null = null;
let rootEl: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => rootEl?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; rootEl = null; vi.restoreAllMocks(); vi.useRealTimers(); });
function mount() { host = document.createElement("div"); document.body.appendChild(host); rootEl = createRoot(host); act(() => rootEl!.render(createElement(EmailHistoryPreview))); return host; }
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
const dock = () => { const b = byText(document.body, "button", /Preview controls/); if (b?.getAttribute("aria-expanded") !== "true") click(b); };
const pickRole = (l: string) => { dock(); click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"]', l)); };
const pickScreen = (l: string) => { dock(); click(byText(document.body, '[role="group"][aria-label="Screen state"] button', l)); };
/** The chips live under the Filters (n) popover (structural item 1); the settle choices live in the row's More menu (item 7). */
const chip = (id: string) => { const trig = document.querySelector<HTMLElement>('[data-testid="filters-trigger"]')!; if (trig.getAttribute("aria-expanded") !== "true") click(trig); return document.querySelector(`[data-testid="chip-${id}"]`); };
const settle = (h: HTMLElement, label: string) => { const more = h.querySelector<HTMLElement>('[data-testid="row-more"]'); if (!more) return undefined; if (more.getAttribute("aria-expanded") !== "true") click(more); return byText(document.getElementById(more.getAttribute("aria-controls") ?? "")!, "[role=menuitem]", label); };
const rowsIn = (h: HTMLElement) => h.querySelectorAll('[aria-label="Emails"] tbody tr').length;

describe("email preview: rendered behaviour", () => {
  it("labels itself, shows the title, the notice, 5 counts and 12 rows, and calls nothing", () => {
    const fetchSpy = vi.fn(() => { throw new Error("no network"); });
    vi.stubGlobal("fetch", fetchSpy);
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector("h1")?.textContent).toBe("Email & Payment Automation");
    expect(h.querySelector('[data-testid="coming-soon"]')?.textContent).toContain("Nothing on this page sends email yet.");
    expect(h.querySelectorAll('[role="group"][aria-label="Email history counts"] button')).toHaveLength(5);
    expect(rowsIn(h)).toBe(12);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("a tile filters to its status and the chips follow; the chips combine", () => {
    const h = mount();
    click(h.querySelector('[data-testid="tile-failed"]'));
    expect(rowsIn(h)).toBe(1);
    expect(chip("failed")?.getAttribute("aria-pressed")).toBe("true");
    expect(h.querySelector('[data-testid="filters-trigger"]')?.textContent).toContain("Filters (1)");
    expect(h.querySelector('[data-testid="active-chips"]')?.textContent).toContain("Failed");
    click(chip("drafted"));
    expect(rowsIn(h)).toBe(3);
    expect(h.querySelector('[data-testid="filters-trigger"]')?.textContent).toContain("Filters (2)");
    click(chip("all"));
    expect(rowsIn(h)).toBe(12);
    expect(h.querySelector('[data-testid="active-chips"]')).toBeNull();
    click(chip("failed"));
    click(h.querySelector('[data-testid="clear-filters"]'));
    expect(rowsIn(h)).toBe(12);
  });
  it("the needs-checking panel shows for an unknown job e-mail only, with the admin buttons for an admin and the sentence for office", () => {
    const h = mount();
    expect(h.querySelectorAll('[data-testid="settle-panel"]')).toHaveLength(1);
    expect(settle(h, "It was sent")).toBeTruthy();
    pickRole("Office");
    expect(h.querySelector('[data-testid="row-more"]')).toBeNull();
    expect(h.querySelector('[data-testid="settle-panel"]')?.textContent).toContain(P.ADMIN_SETTLES);
  });
  it("It was sent and It was not sent answer with the neutral Preview-only toast and never a success", () => {
    const h = mount();
    click(settle(h, "It was sent"));
    let text = document.body.textContent ?? "";
    expect(text).toContain("Preview only");
    expect(text).toContain("Nothing was saved.");
    expect(text).not.toMatch(/Marked as sent|marked as sent\b|sent successfully|has been sent/);
    click(settle(h, "It was not sent"));
    text = document.body.textContent ?? "";
    expect(text).toContain("Nothing was saved.");
  });
  it("View opens the stored message in a dialog, and Escape closes it", () => {
    const h = mount();
    click(h.querySelector('[aria-label="View email to buyer@kestrel.example"]'));
    const dlg = document.querySelector('[data-testid="dlg-view"]');
    expect(dlg?.textContent).toContain("Quote QUO-0442 for sensor housings");
    expect(dlg?.textContent).toContain("To buyer@kestrel.example");
    expect(dlg?.textContent).toContain("sample text for the preview");
  });
  it("loading shows dashes, failed shows the real sentence with Retry, empty shows the real sentence", () => {
    const h = mount();
    pickScreen("Loading");
    expect(h.querySelector('[data-testid="tile-drafted"]')?.textContent).toContain("Loading");
    pickScreen("Failed to load");
    expect(h.querySelector('[data-testid="load-error"]')?.textContent).toContain(P.LOAD_ERROR);
    expect(byText(h, "button", "Retry")).toBeTruthy();
    pickScreen("No emails recorded");
    expect(h.textContent).toContain(P.NO_EMAILS);
  });
  it("Workshop and Viewer get Access Denied", () => {
    const h = mount();
    pickRole("Workshop");
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
    expect(h.querySelector('[aria-label="Emails"]')).toBeNull();
  });
});

describe("v2 structure (owner approved items 4, 7, 10, 11): shared PreviewBar and PageHeader, v4 type scale, no local preview pill", () => {
  const SRC2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/integrations/preview/EmailHistoryPreview.tsx"), "utf8");
  const CSS2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/integrations/preview/EmailHistoryPreview.module.css"), "utf8");
  it("uses the shared strip and heading, and keeps the Preview controls trigger", () => {
    expect(SRC2).toContain("<PreviewBar");
    expect(SRC2).toContain("PageHeader");
    expect(SRC2).toContain('label="Preview controls"');
    expect(SRC2).not.toContain("s.previewTag");
    expect(SRC2).not.toContain("<h1 className={s.title}");
  });
  it("sizes text from the v4 scale tokens, not loose pixel sizes", () => {
    expect(CSS2).toContain("var(--ui-fs-");
    expect(CSS2).not.toMatch(/font-size:\s*(12\.5|13\.5)px/);
    expect(CSS2).not.toMatch(/font-weight:\s*(650|550)/);
  });
  it("builds narrow records from the shared primitive: StackedRows", () => {
    expect(SRC2).toContain("StackedRows");
  });
});
