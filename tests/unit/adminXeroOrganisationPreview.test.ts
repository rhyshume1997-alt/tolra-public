// @vitest-environment jsdom
/**
 * BOUNDARY (Admin > Integrations > confirm the Xero organisation, PREVIEW ONLY; route ownership assumed Module 6 by the coordinator, to be confirmed by the owner). Inputs: the exports of
 * components/integrations/preview/XeroOrganisationPreview.tsx, the real connectOutcomeMessage and the SOURCE of app/(dashboard)/admin/integrations/xero-organisation/page.tsx. Output:
 * pass/fail. Pins the sentences and the "none selected, nothing connects" rule to the real page, and checks by rendering that connecting is never drawn as done, only toasts, and the
 * preview imports no network, OAuth or database code and holds no real tenant id, token or CSRF value. Must not change: never loosen these. No network. Written with createElement (no JSX).
 */
import * as v2fs from "node:fs";
import * as v2path from "node:path";
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import XeroOrganisationPreview, * as P from "@/components/integrations/preview/XeroOrganisationPreview";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const REAL = read("app/(dashboard)/admin/integrations/xero-organisation/page.tsx");
const SRC = read("components/integrations/preview/XeroOrganisationPreview.tsx");
const ROUTE = read("app/(dashboard)/admin/integrations/xero-organisation/preview/page.tsx");

describe("pinned to the real page", () => {
  it("wording and rules", () => {
    for (const w of [P.ONE_TEXT, P.SEVERAL_TEXT, P.NOTHING_TEXT, P.BACK_NOTE, P.UNNAMED, "Connect this organisation", "Back to Integrations", P.PAGE_TITLE]) expect(REAL, w).toContain(w);
    expect(REAL).toContain('allowed={["admin"]}');
    expect(REAL).toContain("const [chosen, setChosen] = useState<string | null>(null);");
    expect(REAL).toContain("disabled={!chosen || busy}");
    expect(P.sentenceFor(P.ONE_ORG)).toBe(P.ONE_TEXT);
    expect(P.sentenceFor(P.SEVERAL_ORGS)).toBe(P.SEVERAL_TEXT);
    expect(P.sentenceFor(null)).toBe(P.SEVERAL_TEXT);
    expect(P.FAILED_TEXT).toBe("Connecting to Xero didn't work. Nothing changed. Try again.");
  });
  it("admin only", () => { expect(P.canUseXeroOrganisation("admin")).toBe(true); for (const r of ["office", "workshop", "viewer"] as const) expect(P.canUseXeroOrganisation(r)).toBe(false); });
});

describe("safety", () => {
  it("no network, OAuth, token or real id; success is not drawn", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of ["supabase", "fetch(", "localStorage", "use-user", "sonner", "XMLHttpRequest", "window.location", "/api/", "csrf", "post-with-code", "xero=connected", "success", "connected successfully"]) expect(code.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const o of [...P.ONE_ORG, ...P.SEVERAL_ORGS]) expect(o.tenantId).toMatch(/^sample-org-\d$/);
    expect(SRC).toContain("PREVIEW ONLY");
    expect(SRC).toContain("OWNERSHIP ASSUMPTION");
    expect(ROUTE).toContain("OWNERSHIP ASSUMPTION");
    expect(ROUTE).toContain("robots: { index: false, follow: false }");
  });
});

describe("rendering", () => {
  let host: HTMLDivElement;
  beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(() => { host?.remove(); });
  it("none is selected, the button waits, and connecting only toasts", async () => {
    host = document.createElement("div"); document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(XeroOrganisationPreview)); });
    const radios = [...host.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.length).toBe(3);
    expect(radios.every((r) => !r.checked)).toBe(true);
    const btn = host.querySelector('[data-testid="connect-organisation"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => { radios[1].click(); });
    expect(btn.disabled).toBe(false);
    await act(async () => { btn.click(); });
    expect(document.body.textContent).toContain("Preview only");
    expect(document.body.textContent).toContain("Nothing was connected.");
    expect(document.body.textContent).not.toMatch(/All connected/);
  });
});

describe("v2 structure (owner approved items 4, 7, 10, 11): shared PreviewBar and PageHeader, v4 type scale, no local preview pill", () => {
  const SRC2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/integrations/preview/XeroOrganisationPreview.tsx"), "utf8");
  const CSS2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/integrations/preview/XeroOrganisationPreview.module.css"), "utf8");
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
});
