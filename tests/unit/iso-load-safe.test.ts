// The ISO page must never stay on "Loading ISO templates": a failed or silent load settles with the fallback (every clause "not evidenced", reads listed as unread).
import { describe, expect, it, vi } from "vitest";
import { failedIsoEvidence, loadIsoEvidenceSafe, settleWithin } from "@/lib/iso/load-iso-evidence-safe";
import { isoTemplatesEnabled, canSeeIso, ISO_TEMPLATES_ON_MARKER } from "@/lib/iso/iso-switch";
import { readFileSync } from "node:fs";

describe("ISO load never hangs", () => {
  it("a rejecting load settles with the fallback", async () => {
    const r = await loadIsoEvidenceSafe(() => Promise.reject(new Error("boom")), 50);
    expect(r.unread).toEqual(["all records"]);
    expect(r.ncrRows).toBeNull();
  });
  it("a load that never answers settles after the limit", async () => {
    vi.useFakeTimers();
    const p = loadIsoEvidenceSafe(() => new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await p).unread).toEqual(["all records"]);
    vi.useRealTimers();
  });
  it("a good load is returned unchanged", async () => {
    const good = { ...failedIsoEvidence(), unread: [] as string[] };
    expect(await loadIsoEvidenceSafe(() => Promise.resolve(good), 50)).toBe(good);
    expect(await settleWithin(Promise.resolve(3), 50, 0)).toBe(3);
  });
});

describe("ISO sidebar link", () => {
  const sidebar = readFileSync("components/sidebar.tsx", "utf8");
  it("is an admin-only item shown only while the ISO switch is on", () => {
    expect(sidebar).toContain('{ href: "/admin/iso", label: "ISO templates", roles: ["admin"] }');
    expect(sidebar).toContain('item.href !== "/admin/iso" || (canSeeIso(activeRole) && isoTemplatesEnabled(orgSettings.hiddenNav))');
  });
  it("the switch rule", () => {
    expect(isoTemplatesEnabled([ISO_TEMPLATES_ON_MARKER])).toBe(true);
    expect(isoTemplatesEnabled([])).toBe(false);
    expect(canSeeIso("admin")).toBe(true);
    expect(canSeeIso("office")).toBe(false);
  });
  it("the page retries and uses the safe loader", () => {
    const view = readFileSync("components/iso/iso-pack-view.tsx", "utf8");
    expect(view).toContain("loadIsoEvidenceSafe()");
    expect(view).toContain("Try reading again");
  });
  it("the result is keyed by company and attempt, and every export is guarded", () => {
    const view = readFileSync("components/iso/iso-pack-view.tsx", "utf8");
    expect(view).toContain("result.orgId === orgId && result.attempt === attempt");
    expect(view).toContain("[loaded, on, available, orgId, attempt]");
    expect(view).toContain("isoReadIsComplete(orgId, before, after, company, evidence)");
    expect(view.match(/if \(!canExport \|\| latestRequest\.current !== requestKey\) return;/g)).toHaveLength(3);
    expect(view.match(/disabled=\{!canExport\}/g)).toHaveLength(4);
    expect(view).toContain('data-testid="iso-incomplete"');
  });
});

describe("ISO company name", () => {
  const view = readFileSync("components/iso/iso-pack-view.tsx", "utf8");
  it("takes the name only from this company's confirmed read (no shared-cache fallback), and shows it in the header", () => {
    expect(view).not.toContain("useCompanyProfile()");
    expect(view).toContain("const company = current?.company ?? null;");
    expect(view).toContain("company?.name || company?.documentName || TO_COMPLETE");
  });
});
