import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { startNowTicker, useNow } from "@/lib/use-now";

describe("startNowTicker", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T08:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("ticks with the current time each interval, and stops when told", () => {
    const seen: number[] = [];
    const stop = startNowTicker((now) => seen.push(now.getTime()), 60_000);
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual([new Date("2026-10-21T08:01:00Z").getTime(), new Date("2026-10-21T08:02:00Z").getTime()]);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(seen).toHaveLength(2);
  });

  it("catches up at once when the tab becomes visible again, and unhooks on stop", () => {
    const listeners = new Map<string, () => void>();
    const doc = {
      visibilityState: "hidden" as DocumentVisibilityState,
      addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); },
      removeEventListener: (type: string) => { listeners.delete(type); },
    };
    const seen: Date[] = [];
    const stop = startNowTicker((now) => seen.push(now), 60_000, doc as unknown as Document);
    vi.setSystemTime(new Date("2026-10-21T09:00:00Z"));
    listeners.get("visibilitychange")!();
    expect(seen).toHaveLength(0);
    doc.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(seen.map((d) => d.toISOString())).toEqual(["2026-10-21T09:00:00.000Z"]);
    stop();
    expect(listeners.size).toBe(0);
  });

  it("useNow renders the current time first", () => {
    const Probe = () => createElement("span", null, useNow().toISOString());
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>2026-10-21T08:00:00.000Z</span>");
  });
});
