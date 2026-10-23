/**
 * Agreed session limits: office sessions end after 12 hours without use; the workshop tablet locks after 30 minutes.
 */
import { describe, expect, it } from "vitest";

import { OFFICE_IDLE_TIMEOUT_MS, TABLET_LOCK_IDLE_MS, activityDecision, expiredSignInRedirect, idleExceeded, idleLimitMs, idleMessage, mountDecision, reasonFor } from "@/lib/session-policy";

const MIN = 60 * 1000;
const now = Date.parse("2026-10-12T09:00:00Z");

describe("the limits", () => {
  it("are 12 hours for office and admin, 30 minutes for the workshop tablet", () => {
    expect(OFFICE_IDLE_TIMEOUT_MS).toBe(12 * 60 * MIN);
    expect(TABLET_LOCK_IDLE_MS).toBe(30 * MIN);
    expect(idleLimitMs("admin")).toBe(OFFICE_IDLE_TIMEOUT_MS);
    expect(idleLimitMs("office")).toBe(OFFICE_IDLE_TIMEOUT_MS);
    expect(idleLimitMs("workshop")).toBe(TABLET_LOCK_IDLE_MS);
    expect(idleLimitMs("viewer")).toBe(TABLET_LOCK_IDLE_MS);
    expect(idleLimitMs(null)).toBe(OFFICE_IDLE_TIMEOUT_MS);
  });

  it("an admin working as workshop on the tablet is held to the tablet limit", () => {
    expect(idleLimitMs("workshop")).toBe(TABLET_LOCK_IDLE_MS);
    expect(reasonFor("workshop")).toBe("locked");
    expect(reasonFor("admin")).toBe("expired");
  });
});

describe("idleExceeded", () => {
  it("is false up to the limit and true after it", () => {
    expect(idleExceeded(now - 29 * MIN, now, TABLET_LOCK_IDLE_MS)).toBe(false);
    expect(idleExceeded(now - 30 * MIN, now, TABLET_LOCK_IDLE_MS)).toBe(false);
    expect(idleExceeded(now - 30 * MIN - 1, now, TABLET_LOCK_IDLE_MS)).toBe(true);
    expect(idleExceeded(now - 11 * 60 * MIN, now, OFFICE_IDLE_TIMEOUT_MS)).toBe(false);
    expect(idleExceeded(now - 12 * 60 * MIN - 1, now, OFFICE_IDLE_TIMEOUT_MS)).toBe(true);
  });

  it("a stored time as text works; a missing or unreadable one is a first visit, not idle", () => {
    expect(idleExceeded(String(now - 2 * 60 * MIN), now, TABLET_LOCK_IDLE_MS)).toBe(true);
    for (const value of [null, undefined, "", "abc", "0", -5, Number.NaN]) expect(idleExceeded(value as never, now, TABLET_LOCK_IDLE_MS)).toBe(false);
  });

  it("a time in the future (clock moved) counts as now", () => {
    expect(idleExceeded(now + 5 * 60 * 60 * MIN, now, TABLET_LOCK_IDLE_MS)).toBe(false);
  });
});

describe("the sign-in page message", () => {
  it("says why, and that offline changes were kept", () => {
    expect(idleMessage("locked", 0)).toBe("This device was locked after 30 minutes without use. Enter your password to carry on.");
    expect(idleMessage("expired", 0)).toContain("12 hours without use");
    expect(idleMessage("locked", 1)).toContain("1 change you made offline is still saved on this device and will be sent when you sign in.");
    expect(idleMessage("locked", 3)).toContain("3 changes you made offline are still saved");
  });
});

describe("mountDecision: what the dashboard does when it opens again", () => {
  it("the tablet reopened after 31 minutes locks at once; after 29 it carries on", () => {
    expect(mountDecision(now - 31 * MIN, now, TABLET_LOCK_IDLE_MS)).toBe("lock");
    expect(mountDecision(now - 29 * MIN, now, TABLET_LOCK_IDLE_MS)).toBe("continue");
  });

  it("an office sign-in is held to 12 hours, not 30 minutes", () => {
    expect(mountDecision(now - 5 * 60 * MIN, now, OFFICE_IDLE_TIMEOUT_MS)).toBe("continue");
    expect(mountDecision(now - 13 * 60 * MIN, now, OFFICE_IDLE_TIMEOUT_MS)).toBe("lock");
  });

  it("a first visit (nothing stored) carries on", () => {
    expect(mountDecision(null, now, TABLET_LOCK_IDLE_MS)).toBe("continue");
  });
});

describe("activityDecision: a tap or key press checks the expiry before it records anything (regression)", () => {
  it("after the tablet's 30 minutes a tap locks; it does not record the tap and rescue the sign-in", () => {
    expect(activityDecision(now - 31 * MIN, now, TABLET_LOCK_IDLE_MS)).toBe("lock");
    expect(activityDecision(String(now - 31 * MIN), now, TABLET_LOCK_IDLE_MS)).toBe("lock");
  });

  it("inside the limit, or on a first visit, the activity is recorded", () => {
    expect(activityDecision(now - 29 * MIN, now, TABLET_LOCK_IDLE_MS)).toBe("record");
    expect(activityDecision(null, now, TABLET_LOCK_IDLE_MS)).toBe("record");
    expect(activityDecision(now - 11 * 60 * MIN, now, OFFICE_IDLE_TIMEOUT_MS)).toBe("record");
    expect(activityDecision(now - 13 * 60 * MIN, now, OFFICE_IDLE_TIMEOUT_MS)).toBe("lock");
  });
});

describe("a plain sign-in request right after an idle expiry", () => {
  const ago = (ms: number) => String(now - ms);
  const base = { hasAuthCookie: true, lastActive: undefined, notice: undefined, now };
  it("goes to the expired message when the middleware has just ended the sign-in (notice cookie)", () => {
    expect(expiredSignInRedirect({ ...base, hasAuthCookie: false, notice: "1" })).toBe(true);
  });
  it("goes to the expired message when the ending response has not reached the browser yet (auth cookies + stale last use)", () => {
    expect(expiredSignInRedirect({ ...base, lastActive: ago(13 * 60 * MIN) })).toBe(true);
  });
  it("is not triggered by an ordinary sign-out, a recent sign-in or a first visit", () => {
    expect(expiredSignInRedirect({ ...base, hasAuthCookie: false, lastActive: ago(13 * 60 * MIN) })).toBe(false);
    expect(expiredSignInRedirect({ ...base, lastActive: ago(11 * 60 * MIN) })).toBe(false);
    expect(expiredSignInRedirect(base)).toBe(false);
  });
});

describe("a session the server ended", () => {
  it("says so, and that offline changes are kept", () => {
    expect(idleMessage("ended", 0)).toBe("Your session ended. Sign in again to carry on.");
    expect(idleMessage("ended", 2)).toContain("2 changes you made offline are still saved on this device and will be sent when you sign in.");
  });
});
