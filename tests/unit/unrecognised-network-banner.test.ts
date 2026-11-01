/**
 * The "unrecognised network" banner (lib/site-network.ts, components/time/unrecognised-network-banner.tsx): the 7-day read of
 * off-site checked clock actions, the dismissal per batch (a later clock action shows it again), the wording, and that the banner
 * only reads: it never saves a network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { loadUnrecognisedClockActions, unrecognisedBannerText, unrecognisedBatch } from "@/lib/site-network";

const ROOT = path.resolve(__dirname, "../..");
const rows = [
  { event_id: "c", checked_at: "2026-10-30T09:00:00Z" },
  { event_id: "b", checked_at: "2026-10-29T09:00:00Z" },
  { event_id: "a", checked_at: "2026-10-28T09:00:00Z" },
];

describe("unrecognisedBatch", () => {
  it("nothing to show when there are no clock actions", () => expect(unrecognisedBatch([], null)).toBeNull());
  it("counts every action when none is dismissed, with the newest time", () => expect(unrecognisedBatch(rows, null)).toEqual({ count: 3, latest: "2026-10-30T09:00:00Z" }));
  it("dismissed up to the newest: hidden", () => expect(unrecognisedBatch(rows, "2026-10-30T09:00:00Z")).toBeNull());
  it("a later clock action after a dismissal is a new batch, counting only the new ones", () => {
    const later = [{ event_id: "d", checked_at: "2026-10-31T07:00:00Z" }, ...rows];
    expect(unrecognisedBatch(later, "2026-10-30T09:00:00Z")).toEqual({ count: 1, latest: "2026-10-31T07:00:00Z" });
  });
  it("a dismissal part way keeps the newer ones", () => expect(unrecognisedBatch(rows, "2026-10-28T09:00:00Z")?.count).toBe(2));
});

describe("unrecognisedBannerText", () => {
  it("says what happened, what to do, and uses the button's name", () => {
    expect(unrecognisedBannerText(3)).toBe(
      "3 clock-ins came from a network Tolra doesn't recognise. If the workshop's internet address changed, stand on the workshop Wi-Fi and click Use this network.",
    );
    expect(unrecognisedBannerText(1)).toMatch(/^1 clock-in came from/);
  });
});

describe("loadUnrecognisedClockActions", () => {
  it("asks for off_site checks of the last 7 days, newest first, and throws on a read error", async () => {
    const calls: [string, ...unknown[]][] = [];
    const chain = (result: unknown) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "order", "limit"]) c[m] = (...a: unknown[]) => { calls.push([m, ...a]); return c; };
      c.then = (ok: (r: unknown) => unknown) => Promise.resolve(result).then(ok);
      return c;
    };
    const ok = { from: (t: string) => { calls.push(["from", t]); return chain({ data: rows, error: null }); } } as unknown as SupabaseClient;
    expect(await loadUnrecognisedClockActions(ok, new Date("2026-10-31T12:00:00Z"))).toEqual(rows);
    expect(calls).toContainEqual(["from", "attendance_event_networks"]);
    expect(calls).toContainEqual(["eq", "status", "off_site"]);
    expect(calls).toContainEqual(["gte", "checked_at", "2026-10-24T12:00:00.000Z"]);
    const bad = { from: () => chain({ data: null, error: { code: "42501", message: "no" } }) } as unknown as SupabaseClient;
    await expect(loadUnrecognisedClockActions(bad)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the banner component", () => {
  const src = readFileSync(path.join(ROOT, "components/time/unrecognised-network-banner.tsx"), "utf8");
  it("is admin only, links to Settings > Workshop network, is dismissible, and only reads", () => {
    expect(src).toContain('activeRole === "admin"');
    expect(src).toContain('href="/settings#workshop-network"');
    expect(src).toContain("unrecognised-network-dismiss");
    expect(src).not.toMatch(/addSiteNetwork|removeSiteNetwork|\.rpc\(|\.insert\(|\.update\(/);
  });
  it("is on the dashboard and both Time pages, and the Settings card is the link target", () => {
    for (const f of ["app/(dashboard)/dashboard/page.tsx", "app/(dashboard)/time/page.tsx", "app/(dashboard)/time/week/page.tsx"]) {
      expect(readFileSync(path.join(ROOT, f), "utf8"), f).toContain("<UnrecognisedNetworkBanner />");
    }
    expect(readFileSync(path.join(ROOT, "components/time/site-network-card.tsx"), "utf8")).toContain('id="workshop-network"');
  });
});
