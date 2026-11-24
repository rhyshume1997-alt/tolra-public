// @vitest-environment jsdom
/**
 * BOUNDARY (Admin > Security, route /admin/compliance, PREVIEW ONLY; ownership assumed Module 1 by the coordinator, to be confirmed by the owner). Inputs: the exports of
 * components/admin/compliance/preview/CompliancePreview.tsx, the REAL pure functions it uses (describeAlertTest, auditActionLabel, recordTypeLabel) and the SOURCE of
 * app/(dashboard)/admin/compliance/page.tsx. Output: pass/fail. Pins wording, columns, search and role gate to the real page and checks by rendering that no e-mail is "sent", no
 * success tone is drawn for the alert test, no export or delete control exists and the preview imports no network, auth or database code. Must not change: never loosen these.
 * No network. Written with createElement (no JSX).
 */
import * as v2fs from "node:fs";
import * as v2path from "node:path";
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import CompliancePreview, { ALERTS_TEXT, AUDIT_TEXT, COLUMNS, CONTROLS, EMPTY_TEXT, ERROR_TEXT, NO_MATCH_TEXT, PAGE_TITLE, PENDING, SAMPLE_AUDIT, alertOutcomeFor, canUseCompliance, searchEntries, subtitleFor, type AlertSample } from "@/components/admin/compliance/preview/CompliancePreview";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const REAL = read("app/(dashboard)/admin/compliance/page.tsx");
const SRC = read("components/admin/compliance/preview/CompliancePreview.tsx");
const ROUTE = read("app/(dashboard)/admin/compliance/preview/page.tsx");

describe("pinned to the real page", () => {
  it("wording", () => {
    for (const w of [ALERTS_TEXT, AUDIT_TEXT, ERROR_TEXT, EMPTY_TEXT, NO_MATCH_TEXT, "Send test alert", "Refresh activity log", "Search audit entries...", `"${PENDING}"`.replace(/"/g, "")]) expect(REAL, w).toContain(w);
    for (const c of CONTROLS) { expect(REAL).toContain(c.title); expect(REAL).toContain(c.description); }
    for (const c of COLUMNS) expect(REAL, c).toContain(`<TableHead>${c}</TableHead>`);
    expect(REAL).toContain(`<h1 className="page-title">${PAGE_TITLE}</h1>`);
    expect(REAL).toContain("How {PRODUCT.name} protects your company&apos;s records.");
    expect(subtitleFor("Tolra")).toBe("How Tolra protects your company's records.");
    expect(REAL).toContain('allowed={["admin"]}');
    expect(REAL).toContain(".limit(25)");
  });
  it("the search rule is the real one", () => {
    expect(REAL).toContain("[entry.actor_email, entry.action, entry.entity_table, entry.entity_id, entry.hash]");
    expect(REAL).toContain(".some((value) => String(value).toLowerCase().includes(search))");
    expect(searchEntries(SAMPLE_AUDIT, "EXPORT").length).toBe(1);
    expect(searchEntries(SAMPLE_AUDIT, "  ").length).toBe(SAMPLE_AUDIT.length);
    expect(searchEntries(SAMPLE_AUDIT, "zzzz")).toEqual([]);
  });
  it("admin only", () => { expect(canUseCompliance("admin")).toBe(true); for (const r of ["office", "workshop", "viewer"] as const) expect(canUseCompliance(r)).toBe(false); });
});

describe("alert outcomes", () => {
  it("only real not-sent and error sentences, never the success", () => {
    for (const v of ["rate-limited", "disabled", "not-production", "no-provider", "unreachable", "server-error"] as AlertSample[]) {
      const o = alertOutcomeFor(v)!;
      expect(o.tone).not.toBe("success");
      expect(o.text).not.toMatch(/^Sent\./);
    }
    expect(alertOutcomeFor("none")).toBeNull();
    expect(alertOutcomeFor("rate-limited")!.text).toContain("Only one test is allowed per hour");
  });
});

describe("sample data", () => {
  it("addresses are reserved .example and no code looks like a key", () => {
    for (const e of SAMPLE_AUDIT) { if (e.actor_email) expect(e.actor_email.endsWith(".example")).toBe(true); if (e.hash) expect(e.hash).toMatch(/^[0-9a-f]{64}$/); }
  });
});

describe("safety", () => {
  it("imports no network, auth or database code", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of ["supabase", "fetch(", "localStorage", "use-user", "sonner", "XMLHttpRequest", "sendBeacon", "alert-test\"", "/api/"]) expect(code.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    expect(SRC).toContain("PREVIEW ONLY");
    expect(SRC).toContain("OWNERSHIP ASSUMPTION");
    expect(ROUTE).toContain("OWNERSHIP ASSUMPTION");
    expect(ROUTE).toContain("robots: { index: false, follow: false }");
  });
});

describe("rendering", () => {
  let host: HTMLDivElement;
  beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never; });
  afterEach(() => { host?.remove(); });
  const mount = async () => { host = document.createElement("div"); document.body.appendChild(host); await act(async () => { createRoot(host).render(createElement(CompliancePreview)); }); };
  it("Send test alert only toasts; no export or delete control exists", async () => {
    await mount();
    expect(host.querySelectorAll("tbody tr").length).toBe(SAMPLE_AUDIT.length);
    for (const b of host.querySelectorAll("button")) expect(b.textContent ?? "").not.toMatch(/export|delete|download|remove/i);
    await act(async () => { (host.querySelector('[data-testid="send-test-alert"]') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain("Preview only");
    expect(document.body.textContent).toContain("No e-mail was sent.");
    expect(host.querySelector('[data-testid="alert-outcome"]')?.textContent).toBe("");
  });
});

describe("v2 structure (owner approved items 4, 7, 10, 11): shared PreviewBar and PageHeader, v4 type scale, no local preview pill", () => {
  const SRC2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/admin/compliance/preview/CompliancePreview.tsx"), "utf8");
  const CSS2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/admin/compliance/preview/CompliancePreview.module.css"), "utf8");
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
