/**
 * Codex UI-audit fixes 2: the New job dialog's prerequisites after an outage (#8) and who may Pause (#6).
 */
import { describe, expect, it, vi } from "vitest";

import { canPauseRole, PAUSE_ROLES } from "@/lib/job-actions";
import { onReconnect, prereqOutcome } from "@/lib/offline/reconnect";

const describeError = (error: unknown) => `failed: ${(error as { message?: string }).message}`;

describe("prereqOutcome (#8): reconnecting clears the offline mark", () => {
  it("a successful load clears offline and any error", () => {
    expect(prereqOutcome(null, true, describeError)).toEqual({ offline: false, loadError: null });
    // the browser may still report offline for a moment, but a load that worked means the server answered
    expect(prereqOutcome(null, false, describeError)).toEqual({ offline: false, loadError: null });
  });

  it("a network failure, or the browser being offline, is offline (no error text)", () => {
    expect(prereqOutcome(new TypeError("Failed to fetch"), true, describeError)).toEqual({ offline: true, loadError: null });
    expect(prereqOutcome({ message: "bad gateway", status: 502 }, true, describeError)).toEqual({ offline: true, loadError: null });
    expect(prereqOutcome({ message: "anything" }, false, describeError)).toEqual({ offline: true, loadError: null });
  });

  it("any other failure is an error, not offline", () => {
    expect(prereqOutcome({ message: "permission denied" }, true, describeError)).toEqual({ offline: false, loadError: "failed: permission denied" });
  });
});

describe("onReconnect (#8): the online event reloads", () => {
  it("calls reload on each online event until cleaned up", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const stop = onReconnect(target, reload);
    target.dispatchEvent(new Event("offline"));
    expect(reload).not.toHaveBeenCalled();
    target.dispatchEvent(new Event("online"));
    target.dispatchEvent(new Event("online"));
    expect(reload).toHaveBeenCalledTimes(2);
    stop();
    target.dispatchEvent(new Event("online"));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a window (server render)", () => {
    expect(() => onReconnect(undefined, vi.fn())()).not.toThrow();
  });
});

describe("canPauseRole (#6): the roles pause_machine_run accepts", () => {
  it("admin, office and workshop may pause; a viewer or no role may not", () => {
    expect(PAUSE_ROLES).toEqual(["admin", "office", "workshop"]);
    for (const role of ["admin", "office", "workshop"]) expect(canPauseRole(role)).toBe(true);
    for (const role of ["viewer", "", null, undefined, "platform"]) expect(canPauseRole(role)).toBe(false);
  });
});
