// @vitest-environment jsdom
/**
 * BOUNDARY (Admin > Activity, PREVIEW ONLY; ownership assumed Module 1 by the coordinator, to be confirmed by the owner). Inputs: the exports of
 * components/admin/activity/preview/ActivityPreview.tsx, the REAL pure functions of lib/activity.ts and lib/people.ts, and the SOURCE of app/(dashboard)/admin/activity/page.tsx.
 * Output: pass/fail. Pins the preview's wording, filters and role gate to the real page and checks by rendering that nothing reports success, no name is an e-mail address and the
 * preview imports no network, auth or database code. Must not change: never loosen these to make a change pass. No network. Written with createElement (no JSX).
 */
import * as v2fs from "node:fs";
import * as v2path from "node:path";
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import ActivityPreview, { EMPTY_TEXT, ERROR_013, ERROR_GENERIC, MEMBERS, PAGE, PAGE_TITLE, SAMPLE_ENTRIES, SUBTITLE, applyFilters, canUseActivity, dayStart } from "@/components/admin/activity/preview/ActivityPreview";
import { actorLabel, describeEntry } from "@/lib/activity";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE_SRC = read("app/(dashboard)/admin/activity/page.tsx");
const SRC = read("components/admin/activity/preview/ActivityPreview.tsx");
const ROUTE = read("app/(dashboard)/admin/activity/preview/page.tsx");

describe("pinned to the real page", () => {
  it("wording", () => {
    for (const w of [SUBTITLE, EMPTY_TEXT, ERROR_013, ERROR_GENERIC, "Load more"]) expect(PAGE_SRC, w).toContain(w);
    expect(PAGE_SRC).toContain(`<h1 className="page-title">${PAGE_TITLE}</h1>`);
    expect(PAGE_SRC).toContain(`const PAGE = ${PAGE};`);
    for (const l of ["Person", "Record type", "From", "To", "Everyone", "All"]) expect(PAGE_SRC, l).toContain(l);
    expect(PAGE_SRC).toContain('allowed={["admin"]}');
  });
  it("dayStart is the real one", () => {
    expect(PAGE_SRC).toContain("return new Date(y, m - 1, d + plusDays).toISOString();");
    expect(dayStart("2026-11-23", 1)).toBe(new Date(2026, 10, 24).toISOString());
  });
  it("admin only", () => { expect(canUseActivity("admin")).toBe(true); for (const r of ["office", "workshop", "viewer"] as const) expect(canUseActivity(r)).toBe(false); });
});

describe("filters over the sample rows", () => {
  it("person, type and dates", () => {
    expect(applyFilters(SAMPLE_ENTRIES, { actor: "", table: "", from: "", to: "" }).length).toBe(SAMPLE_ENTRIES.length);
    expect(applyFilters(SAMPLE_ENTRIES, { actor: "u04", table: "", from: "", to: "" }).every((r) => r.actor_user_id === "u04")).toBe(true);
    expect(applyFilters(SAMPLE_ENTRIES, { actor: "", table: "invoices", from: "", to: "" }).length).toBe(3);
    expect(applyFilters(SAMPLE_ENTRIES, { actor: "", table: "", from: "2099-01-01", to: "" })).toEqual([]);
  });
  it("no sample name is an e-mail address and no sample carries one", () => {
    const json = JSON.stringify([SAMPLE_ENTRIES, MEMBERS]);
    expect(json).not.toMatch(/\S+@\S+\.\S+/);
    for (const e of SAMPLE_ENTRIES) expect(actorLabel(e, {})).not.toContain("@");
  });
  it("sentences come from the real describeEntry", () => {
    expect(describeEntry(SAMPLE_ENTRIES[0]).title).toBe("Status changed to Sent");
  });
});

describe("safety", () => {
  it("imports no network, auth or database code", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of ["supabase", "fetch(", "rpc(", "localStorage", "use-user", "sonner", "XMLHttpRequest", "sendBeacon", "org-settings"]) expect(code.toLowerCase(), bad).not.toContain(bad.toLowerCase());
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
  const mount = async () => { host = document.createElement("div"); document.body.appendChild(host); await act(async () => { createRoot(host).render(createElement(ActivityPreview)); }); };
  it("draws every sample entry, read only, with no edit or delete control", async () => {
    await mount();
    expect(host.querySelectorAll('[data-testid="activity-actor"]').length).toBe(SAMPLE_ENTRIES.length);
    expect(host.textContent).toContain("Status changed to Sent");
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
    for (const b of buttons) expect(b).not.toMatch(/delete|edit|remove/i);
    expect(host.textContent).not.toMatch(/\S+@\S+\.\S+/);
  });
});

describe("v2 structure (owner approved items 4, 7, 10, 11): shared PreviewBar and PageHeader, v4 type scale, no local preview pill", () => {
  const SRC2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/admin/activity/preview/ActivityPreview.tsx"), "utf8");
  const CSS2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/admin/activity/preview/ActivityPreview.module.css"), "utf8");
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
