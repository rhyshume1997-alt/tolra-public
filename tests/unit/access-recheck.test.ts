/**
 * The open app asks the server again who the person is and what they may do (audit of PR H, finding 3). These are the decisions;
 * tests/e2e/access-recheck.spec.ts proves the page acts on them while it stays open.
 */
import { describe, expect, it } from "vitest";

import { ACCESS_RECHECK_EVERY_MS, decideAccess, msUntilOfflineExpiry } from "@/lib/access-recheck";
import { OFFLINE_IDENTITY_MAX_AGE_MS, offlineIdentityExpired } from "@/lib/offline/identity-age";

const current = { role: "office", secondary_role: null, organization_id: "org-1" } as const;
const member = (patch: Partial<{ active: boolean; role: "admin" | "office" | "workshop" | "viewer"; secondary_role: "admin" | "office" | "workshop" | "viewer" | null }> = {}) =>
  ({ active: true, role: "office" as const, secondary_role: null, ...patch });
const facts = (patch: Record<string, unknown> = {}) =>
  ({ signedIn: true, profile: { active: true, organization_id: "org-1" }, membership: member(), ...patch }) as Parameters<typeof decideAccess>[1];

describe("decideAccess", () => {
  it("nothing changed: keep", () => {
    expect(decideAccess(current, facts())).toEqual({ kind: "keep" });
  });
  it("membership removed or switched off: access ends", () => {
    expect(decideAccess(current, facts({ membership: null }))).toEqual({ kind: "end", reason: "removed" });
    expect(decideAccess(current, facts({ membership: member({ active: false }) }))).toEqual({ kind: "end", reason: "removed" });
  });
  it("account switched off or gone: access ends", () => {
    expect(decideAccess(current, facts({ profile: { active: false, organization_id: "org-1" } }))).toEqual({ kind: "end", reason: "disabled" });
    expect(decideAccess(current, facts({ profile: null }))).toEqual({ kind: "end", reason: "disabled" });
  });
  it("session ended: access ends", () => {
    expect(decideAccess(current, facts({ signedIn: false }))).toEqual({ kind: "end", reason: "signed-out" });
  });
  it("moved to another company: access to this one ends", () => {
    expect(decideAccess(current, facts({ profile: { active: true, organization_id: "org-2" } }))).toEqual({ kind: "end", reason: "moved" });
  });
  it("a new role or second role is applied, not ignored", () => {
    expect(decideAccess(current, facts({ membership: member({ role: "viewer" }) }))).toEqual({ kind: "update", role: "viewer", secondary_role: null });
    expect(decideAccess(current, facts({ membership: member({ secondary_role: "workshop" }) }))).toEqual({ kind: "update", role: "office", secondary_role: "workshop" });
  });
  it("is asked every 10 minutes", () => {
    expect(ACCESS_RECHECK_EVERY_MS).toBe(10 * 60 * 1000);
  });
});

describe("msUntilOfflineExpiry (the timer that locks an open page)", () => {
  const now = Date.parse("2026-10-12T09:00:00Z");
  it("fires just after the limit, and when it fires the identity counts as expired", () => {
    const confirmed = new Date(now).toISOString();
    const wait = msUntilOfflineExpiry(confirmed, now);
    expect(wait).toBe(OFFLINE_IDENTITY_MAX_AGE_MS + 1);
    expect(offlineIdentityExpired(confirmed, now + wait - 1)).toBe(false);
    expect(offlineIdentityExpired(confirmed, now + wait)).toBe(true);
  });
  it("counts down from the last confirmation, not from now", () => {
    const confirmed = new Date(now - 11 * 3600_000).toISOString();
    expect(msUntilOfflineExpiry(confirmed, now)).toBe(3600_000 + 1);
  });
  it("an old, missing or unreadable time fires at once", () => {
    expect(msUntilOfflineExpiry(new Date(now - 13 * 3600_000).toISOString(), now)).toBe(0);
    expect(msUntilOfflineExpiry(null, now)).toBe(0);
    expect(msUntilOfflineExpiry("nonsense", now)).toBe(0);
  });
});
