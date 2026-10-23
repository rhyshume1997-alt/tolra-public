import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DESK_QUERY, DRAWER_MAX_WIDTH, connectionState, effectiveViewMode, roleLabel, shellStatusSummary } from "@/lib/shell-status";

describe("connection state shown in the shell", () => {
  it("is online when nothing is wrong", () => {
    expect(connectionState({ offline: false, pending: 0 })).toEqual({ kind: "online", label: "Online", tone: "good" });
  });
  it("says how many changes are waiting, online or not", () => {
    expect(connectionState({ offline: false, pending: 2 })).toEqual({ kind: "pending", label: "2 to sync", tone: "warn" });
    expect(connectionState({ offline: true, pending: 0 })).toEqual({ kind: "offline", label: "Offline", tone: "warn" });
    expect(connectionState({ offline: true, pending: 1 })).toEqual({ kind: "offline", label: "Offline, 1 to sync", tone: "warn" });
  });
  it("never reuses the banner's sentences (other checks look for those by text)", () => {
    for (const status of [{ offline: true, pending: 0 }, { offline: true, pending: 3 }, { offline: false, pending: 3 }]) {
      const { label } = connectionState(status);
      expect(label).not.toMatch(/last synced|waiting to sync/);
    }
  });
});

describe("who is working", () => {
  it("names the view, the company and the connection in one sentence", () => {
    const connection = connectionState({ offline: false, pending: 0 });
    expect(shellStatusSummary({ role: "admin", company: "Hargreaves Ltd", connection })).toBe("Admin view, Hargreaves Ltd, Online");
    expect(shellStatusSummary({ role: "workshop", company: "  ", connection: connectionState({ offline: true, pending: 2 }) })).toBe("Workshop view, Offline, 2 to sync");
    expect(roleLabel(null)).toBe("Loading");
  });
});

describe("drawer and dense tables share one breakpoint", () => {
  it("drawer through 1024px inclusive: the fixed-sidebar breakpoint starts at 1025px in the stylesheet and the media query", () => {
    expect(DRAWER_MAX_WIDTH).toBe(1024);
    expect(DESK_QUERY).toBe("(min-width: 1025px)");
    const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
    expect(css).toMatch(new RegExp(`--breakpoint-desk:\\s*${DRAWER_MAX_WIDTH + 1}px`));
    // The tablet card rules end exactly where the desk breakpoint starts.
    expect(css).toContain(`(min-width: 768px) and (max-width: ${DRAWER_MAX_WIDTH}px)`);
  });
});

describe("dense tables only on wide screens", () => {
  it("shows a chosen table as cards up to 1024px, and keeps the choice for wide screens", () => {
    expect(effectiveViewMode("table", false)).toBe("cards");
    expect(effectiveViewMode("table", true)).toBe("table");
  });
  it("leaves cards and the compact list alone at every width", () => {
    for (const wide of [true, false]) {
      expect(effectiveViewMode("cards", wide)).toBe("cards");
      expect(effectiveViewMode("list", wide)).toBe("list");
    }
  });
});
