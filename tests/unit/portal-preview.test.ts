// @vitest-environment jsdom
/**
 * BOUNDARY (Customer portal, Module 10, PREVIEW ONLY). Inputs: the exports of components/portal/preview/PortalPreview.tsx, and the SOURCE of the real portal pages, components
 * and lib/portal files whose wording it mirrors (lib/portal/types.ts and refusal.ts are server-only, so their words are pinned here). Output: pass/fail. Pins the preview's wording,
 * status words, tabs-per-permission rule and the one generic refusal to the real portal, and checks by rendering that nothing reports success, no e-mail address or secret appears,
 * and the preview imports no auth, session, cookie, token, database or network code.
 * Must not change: never loosen these to make a change pass; if the real portal changes, this test is the alarm. No network, no Supabase. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import PortalPreview, {
  COPY, JOB_COLUMNS, JOB_STAGE, JOB_TONE, PREVIEW_ANSWERS, QUOTE_COLUMNS, QUOTE_STATUS, QUOTE_TONE, SCREEN_LABEL, SIGNED_IN, SIGNED_OUT, TABS,
  effectiveScreen, homeLine, homeSummary, isSignedIn, monogram, orDash, sampleFor, tabsFor, titleFor, welcome,
} from "@/components/portal/preview/PortalPreview";
import { portalEnabled } from "@/lib/portal/flag";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/&apos;/g, "'");
const SIGNIN = read("app/portal/signin/page.tsx");
const SENT = read("app/portal/signin/sent/page.tsx");
const CODE = read("app/portal/code/[ref]/page.tsx");
const HOME = read("app/portal/page.tsx");
const REFUSAL = read("lib/portal/refusal.ts");
const FORM = read("components/portal/signin-form.tsx");
const FRAME = read("components/portal/portal-frame.tsx");
const QTABLE = read("components/portal/quotes-table.tsx");
const JTABLE = read("components/portal/jobs-table.tsx");
const TYPES = read("lib/portal/types.ts");
const NOTFOUND = read("app/not-found.tsx");
const SRC_FULL = read("components/portal/preview/PortalPreview.tsx");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SRC = stripComments(SRC_FULL);
const CSS = read("components/portal/preview/PortalPreview.module.css");
const ROUTE = read("app/portal/preview/page.tsx");

const mounted: Array<() => void> = [];
afterEach(() => { while (mounted.length) mounted.pop()!(); document.body.innerHTML = ""; });
function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(PortalPreview)));
  mounted.push(() => act(() => root.unmount()));
  return host;
}
function choose(host: HTMLElement, selector: string, value: string) {
  const toggle = host.querySelector<HTMLButtonElement>("[data-testid=dock-toggle]")!;
  if (!host.querySelector(selector)) act(() => toggle.click());
  const sel = host.querySelector<HTMLSelectElement>(selector)!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(sel, value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const screens = (host: HTMLElement, v: string) => choose(host, "[data-testid=dock-screen]", v);

describe("portal preview: the real source still says what the preview mirrors", () => {
  it("sign-in, sent and code pages", () => {
    for (const t of [COPY.signinTitle, COPY.signinIntro]) expect(SIGNIN).toContain(t);
    for (const t of [COPY.sentTitle, COPY.sentText, COPY.backLabel]) expect(SENT).toContain(t);
    for (const t of [COPY.codeTitle, COPY.codeLabel, COPY.codeRefused, COPY.newCodeLabel, COPY.codeSubmit]) expect(CODE).toContain(t);
    expect(CODE).toContain('pattern="[0-9]{8}"');
    expect(CODE).toContain('maxLength={8}');
    expect(CODE).toContain('autoComplete="one-time-code"');
  });
  it("sign-in form: label, button, native checks", () => {
    expect(FORM).toContain(COPY.emailLabel);
    expect(FORM).toContain(COPY.sendLabel);
    expect(FORM).toContain('type="email"');
    expect(FORM).toContain("maxLength={254}");
  });
  it("the one generic refusal", () => {
    expect(REFUSAL).toContain(`PORTAL_REFUSAL_TITLE = "${COPY.refusalTitle}"`);
    expect(REFUSAL).toContain(`PORTAL_REFUSAL_MESSAGE = "${COPY.refusalMessage}"`);
  });
  it("home, tabs and sign out", () => {
    expect(HOME).toContain("Welcome, ${session.displayName}");
    expect(HOME).toContain("{session.customerName} at {session.companyName}. " + COPY.homeText);
    expect(FRAME).toContain(">Sign out<");
    expect(FRAME).toContain(">Home<");
    for (const t of TABS) expect(FRAME).toContain(`{ permission: "${t.permission}", href: "/portal/${t.screen}", label: "${t.label}" }`);
    expect(FRAME).toContain("signedIn.permissions.includes(tab.permission)");
    expect(TYPES).toContain('z.enum(["quotes", "jobs"])');
  });
  it("quote and job words, columns and empty text", () => {
    for (const [k, v] of Object.entries(QUOTE_STATUS)) expect(QTABLE).toContain(`${k}: "${v}"`);
    for (const [k, v] of Object.entries(JOB_STAGE)) expect(JTABLE).toContain(`${k}: "${v}"`);
    for (const c of QUOTE_COLUMNS) expect(QTABLE).toContain(`<th>${c}</th>`.replace("<th>Total</th>", '<th className="text-right">Total</th>'));
    for (const c of JOB_COLUMNS) expect(JTABLE).toContain(`<th>${c}</th>`);
    expect(QTABLE).toContain(COPY.quotesEmpty);
    expect(JTABLE).toContain(COPY.jobsEmpty);
    expect(TYPES).toContain('z.enum(["sent", "accepted", "rejected"])');
    expect(TYPES).toContain('z.enum(["not_started", "in_progress", "complete"])');
  });
  it("404 wording (and the real 404 links into the staff app: the preview leaves that link out)", () => {
    expect(NOTFOUND).toContain(COPY.notFoundTitle);
    expect(NOTFOUND).toContain(COPY.notFoundText);
    expect(NOTFOUND).toContain('href="/dashboard"');
    expect(SRC).not.toContain("/dashboard");
  });
});

describe("portal preview: pure rules", () => {
  it("every status and stage has a word and a tone", () => {
    expect(Object.keys(QUOTE_TONE).sort()).toEqual(Object.keys(QUOTE_STATUS).sort());
    expect(Object.keys(JOB_TONE).sort()).toEqual(Object.keys(JOB_STAGE).sort());
  });
  it("tabs per permission; a page without its permission is the 404", () => {
    expect(tabsFor("both")).toEqual(["quotes", "jobs"]);
    expect(tabsFor("jobs")).toEqual(["jobs"]);
    expect(effectiveScreen("quotes", ["jobs"])).toBe("off");
    expect(effectiveScreen("quotes-empty", ["jobs"])).toBe("off");
    expect(effectiveScreen("jobs", ["quotes"])).toBe("off");
    expect(effectiveScreen("jobs", ["quotes", "jobs"])).toBe("jobs");
    expect(effectiveScreen("home", ["jobs"])).toBe("home");
    expect(effectiveScreen("signin", [])).toBe("signin");
  });
  it("titles and screen lists", () => {
    const d = sampleFor("typical").session;
    expect(titleFor("home", d)).toBe(welcome(d.displayName));
    expect(titleFor("code-refused", d)).toBe(COPY.codeTitle);
    expect(titleFor("refused", d)).toBe(COPY.refusalTitle);
    expect(homeLine(d)).toBe(`${d.customerName} at ${d.companyName}.`);
    expect(new Set([...SIGNED_OUT, ...SIGNED_IN, "off"]).size).toBe(Object.keys(SCREEN_LABEL).length);
    expect(SIGNED_IN.every(isSignedIn)).toBe(true);
    expect(SIGNED_OUT.some(isSignedIn)).toBe(false);
    expect(orDash(null)).toBe("-");
    expect(orDash("")).toBe("-");
    expect(orDash("PO1")).toBe("PO1");
  });
  it("sample data is fictional and carries no e-mail address", () => {
    const blob = JSON.stringify([sampleFor("typical"), sampleFor("long")]);
    expect(blob).not.toMatch(/@/);
    expect(blob).not.toMatch(/sends|token|contactId|password/i);
  });
  it("the neutral answers never claim anything happened", () => {
    for (const a of Object.values(PREVIEW_ANSWERS)) {
      expect(a.title).toBe("Preview only");
      expect(a.detail).toMatch(/^Nothing was /);
      expect(`${a.title} ${a.detail}`).not.toMatch(/saved to|sent to|success|done|verified|check your e-mail/i);
    }
  });
  it("flag: the preview route is a 404 unless the platform flag is exactly 'true'", () => {
    expect(ROUTE).toContain("if (!portalEnabled()) notFound();");
    expect(portalEnabled({})).toBe(false);
    expect(portalEnabled({ CUSTOMER_PORTAL_ENABLED: "TRUE" })).toBe(false);
    expect(portalEnabled({ CUSTOMER_PORTAL_ENABLED: "true" })).toBe(true);
  });
});

describe("portal preview: rendering", () => {
  it("opens on the sign-in screen with the real words, the preview label, and inputs with no name", () => {
    const host = mount();
    expect(host.textContent).toContain("Preview only");
    expect(host.querySelector("h1")!.textContent).toBe(COPY.signinTitle);
    expect(host.textContent).toContain(COPY.signinIntro);
    const form = host.querySelector("form")!;
    expect(form.getAttribute("action")).toBeNull();
    expect(form.querySelectorAll("input[name], [name=ref]").length).toBe(0);
    expect(host.querySelector("input[type=email]")!.getAttribute("autocomplete")).toBe("email");
  });
  it("every screen draws, one h1 each, and never shows the sends list, an e-mail address, an id or a token", () => {
    const host = mount();
    for (const v of Object.keys(SCREEN_LABEL)) {
      screens(host, v);
      expect(host.querySelectorAll("h1").length).toBe(1);
      expect(host.textContent).not.toMatch(/@|sends|token|contact_id|correlation/i);
    }
  });
  it("the code screen is one 8 digit field; the refused code screen adds only the one sentence and the new-code link", () => {
    const host = mount();
    screens(host, "code-refused");
    const input = host.querySelector<HTMLInputElement>("input[inputmode=numeric]")!;
    expect(input.getAttribute("pattern")).toBe("[0-9]{8}");
    expect(input.maxLength).toBe(8);
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(host.querySelector("[data-testid=portal-code-refused]")!.textContent).toBe(COPY.codeRefused + COPY.newCodeLabel);
  });
  it("the one refusal screen is identical wording whatever the data", () => {
    const host = mount();
    screens(host, "refused");
    const a = host.querySelector("[data-testid=portal-refusal]")!.textContent;
    choose(host, "[data-testid=dock-sample]", "long");
    expect(host.querySelector("[data-testid=portal-refusal]")!.textContent).toBe(a);
    expect(a).toBe(COPY.refusalMessage);
  });
  it("signed in: quotes show the real status words and gbp totals; jobs the stage words", () => {
    const host = mount();
    screens(host, "quotes");
    const q = host.textContent!;
    for (const w of Object.values(QUOTE_STATUS)) expect(q).toContain(w);
    expect(q).toContain("£1,234.50");
    screens(host, "jobs");
    const j = host.textContent!;
    for (const w of Object.values(JOB_STAGE)) expect(j).toContain(w);
  });
  it("tabs follow the permission and the 404 replaces a page the contact may not see", () => {
    const host = mount();
    screens(host, "quotes");
    choose(host, "[data-testid=dock-tabs]", "jobs");
    expect(host.querySelector("[data-testid=portal-tab-quotes]")).toBeNull();
    expect(host.querySelector("[data-testid=portal-tab-jobs]")).toBeNull();
    expect(host.querySelector("h1")!.textContent).toBe(COPY.notFoundTitle);
    screens(host, "home");
    expect(host.querySelector("[data-testid=portal-tab-quotes]")).toBeNull();
    expect(host.querySelector("[data-testid=portal-tab-jobs]")).not.toBeNull();
  });
  it("empty states use the real words", () => {
    const host = mount();
    screens(host, "quotes-empty");
    expect(host.querySelector("[data-testid=portal-quotes-empty]")!.textContent).toBe(COPY.quotesEmpty);
    screens(host, "jobs-empty");
    expect(host.querySelector("[data-testid=portal-jobs-empty]")!.textContent).toBe(COPY.jobsEmpty);
  });
  it("actions: submit and sign out only show the neutral toast; the form is cleared; nothing is sent", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const host = mount();
    const email = host.querySelector<HTMLInputElement>("input[type=email]")!;
    email.value = "person@fictional.example";
    act(() => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(email.value).toBe("");
    expect(document.body.textContent).toContain("Nothing was sent.");
    expect(document.body.textContent).not.toContain("person@fictional.example");
    screens(host, "home");
    act(() => host.querySelector<HTMLButtonElement>("[data-testid=portal-signout]")!.click());
    expect(document.body.textContent).toContain("Nothing was changed.");
    expect(host.querySelector("[data-testid=portal-preview]")!.getAttribute("data-screen")).toBe("home");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("portal preview: no auth, session, network or secret code", () => {
  const FORBIDDEN = [
    "next/headers", "cookies(", "document.cookie", "localStorage", "sessionStorage", "fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "supabase", "@supabase", "lib/portal/server",
    "lib/portal/crypto", "lib/portal/cookie", "lib/portal/mail", "lib/portal/limits", "lib/portal/staff", "lib/server", "server-only", "resend", "console.", "useRouter", "redirect(",
    "/api/", "action=", "method=", "window.location", "location.", "history.", "dangerouslySetInnerHTML", "process.env",
  ];
  it("component and page import and call none of it", () => {
    for (const bad of FORBIDDEN) expect(SRC, bad).not.toContain(bad);
    for (const bad of FORBIDDEN.filter((b) => b !== "process.env")) expect(stripComments(ROUTE), bad).not.toContain(bad);
  });
  it("lib/portal is imported as types only, apart from nothing", () => {
    const libImports = SRC.match(/^import .*from "@\/lib\/portal\/[^"]+";$/gm) ?? [];
    expect(libImports.length).toBe(1);
    expect(libImports[0]).toMatch(/^import type /);
    const routeLib = ROUTE.match(/^import .*from "@\/lib\/[^"]+";$/gm) ?? [];
    expect(routeLib).toEqual(['import { portalEnabled } from "@/lib/portal/flag";']);
  });
  it("css has no gradient, blur or global selector", () => {
    const body = CSS.replace(/\/\*[\s\S]*?\*\//, "");
    expect(body).not.toMatch(/gradient|backdrop-filter|blur\(|:root|:global|^body|^html/m);
  });
});

describe("portal preview v2 (owner approved item 5, 10, 11): branded header, Home summary that only counts what the portal already shows", () => {
  it("the monogram is the first letters of the shop's first two words", () => {
    expect(monogram("Fernhill Engineering Ltd")).toBe("FE");
    expect(monogram("")).toBe("");
  });
  it("Home counts only rows the Quotes and Jobs screens list, with their own status and stage words, and respects the tabs rule", () => {
    const d = sampleFor("typical");
    const all = homeSummary(d, ["quotes", "jobs"]);
    expect(all.quotesToLookAt).toBe(d.quotes.filter((q) => QUOTE_STATUS[q.status] === "Awaiting your answer").length);
    expect(all.jobsInProgress).toBe(d.jobs.filter((j) => JOB_STAGE[j.stage] === "In progress").length);
    expect(all.quotesTotal).toBe(d.quotes.length);
    expect(all.latestQuotes).toEqual(d.quotes.slice(0, 3));
    expect(all.latestJobs).toEqual(d.jobs.slice(0, 3));
    const jobsOnly = homeSummary(d, ["jobs"]);
    expect(jobsOnly.quotesTotal).toBe(0);
    expect(jobsOnly.latestQuotes).toEqual([]);
    expect(homeSummary(d, []).jobsInProgress).toBe(0);
  });
  it("renders the shop name with a monogram, two tiles that link to the existing screens, and the latest lists; no e-mail, sends, id or token", () => {
    const host = mount();
    screens(host, "home");
    expect(host.querySelector("[data-testid=portal-brand]")!.textContent).toContain("Fernhill Engineering Ltd");
    expect(host.querySelector("[data-testid=portal-brand]")!.textContent).toContain("FE");
    expect(host.querySelector("[data-testid=portal-tile-quotes]")!.textContent).toContain("Quotes to look at");
    expect(host.querySelector("[data-testid=portal-tile-jobs]")!.textContent).toContain("Jobs in progress");
    expect(host.querySelector("[data-testid=portal-latest-quotes]")).not.toBeNull();
    expect(host.querySelector("[data-testid=portal-latest-jobs]")).not.toBeNull();
    expect(host.textContent).not.toMatch(/@|sends|token|contact_id|correlation/i);
    act(() => host.querySelector<HTMLElement>("[data-testid=portal-tile-quotes]")!.click());
    expect(host.querySelector("[data-testid=portal-preview]")!.getAttribute("data-screen")).toBe("quotes");
  });
  it("a contact without the Quotes permission gets no quotes tile and no latest quotes", () => {
    const host = mount();
    screens(host, "home");
    choose(host, "[data-testid=dock-tabs]", "jobs");
    expect(host.querySelector("[data-testid=portal-tile-quotes]")).toBeNull();
    expect(host.querySelector("[data-testid=portal-latest-quotes]")).toBeNull();
    expect(host.querySelector("[data-testid=portal-tile-jobs]")).not.toBeNull();
  });
  it("uses the shared strip, heading and phone records", () => {
    expect(SRC).toContain("<PreviewBar");
    expect(SRC).toContain("<PageHeader");
    expect(SRC).toContain("<StackedRows");
    expect(SRC).not.toContain("previewTag");
  });
});
