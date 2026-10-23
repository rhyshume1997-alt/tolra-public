import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enqueue, pendingEntries } from "@/lib/offline/outbox";
import { loadOfflineIdentity, loadOfflineSnapshot, queueOffline, saveOfflineIdentity, saveOfflineSnapshot, setOfflineScope } from "@/lib/offline/scope";
import { isSupportSession, loadSnapshot, memoryBackend, offlineBackend, saveSnapshot, setOfflineBackend } from "@/lib/offline/store";
import { companyStepRoute, offlineCopyAllowed, parseSessionInfo, supportBanner, type SessionInfo } from "@/lib/session-info";

const scope = { userId: "owner", orgId: "org-1" };
const base: SessionInfo = {
  user_id: "owner", organization_id: "org-1", organization_name: "Gamma Ltd", role: "admin", secondary_role: null, hidden_sections: [],
  support: false, read_only: false, support_expires_at: null, elevated_until: null, platform_admin: false, organization_count: 1, needs_choice: false,
};
const support: SessionInfo = { ...base, support: true, read_only: true, platform_admin: true, organization_count: 0, support_expires_at: "2026-10-12T13:30:00Z" };

beforeEach(() => setOfflineBackend(memoryBackend()));
afterEach(() => { setOfflineBackend(null); setOfflineScope(null); });

describe("the offline store in a support session", () => {
  it("saves nothing: no snapshot, no identity, no queued change", async () => {
    setOfflineScope(scope, { support: !offlineCopyAllowed(support) });
    expect(isSupportSession()).toBe(true);
    await saveOfflineSnapshot("jobs", [{ id: "1" }]);
    await saveSnapshot(scope, "schedule", [{ id: "2" }]);
    await saveOfflineIdentity("owner", { profile: {}, organizations: [], hiddenSections: [] });
    expect(await queueOffline({ kind: "start", jobId: "j1", jobNo: "J-1", at: "2026-10-12T08:00:00Z" })).toBe(false);
    await expect(enqueue(scope, { kind: "start", jobId: "j1", jobNo: "J-1", at: "2026-10-12T08:00:00Z" })).rejects.toThrow(/Support access/);
    expect(await offlineBackend()!.keys()).toEqual([]);
    expect(await loadOfflineSnapshot("jobs")).toBeNull();
    expect(await loadOfflineIdentity("owner")).toBeNull();
    expect(await pendingEntries(scope)).toEqual([]);
  });

  it("an ordinary session still saves, and leaving support lifts the rule", async () => {
    setOfflineScope(scope, { support: false });
    await saveOfflineSnapshot("jobs", [{ id: "1" }]);
    expect((await loadSnapshot<unknown[]>(scope, "jobs"))?.data).toEqual([{ id: "1" }]);
    expect(await queueOffline({ kind: "start", jobId: "j1", jobNo: "J-1", at: "2026-10-12T08:00:00Z" })).toBe(true);
    setOfflineScope(scope, { support: true });
    await saveOfflineSnapshot("other", [1]);
    expect(await loadSnapshot(scope, "other")).toBeNull();
    setOfflineScope(scope);
    expect(isSupportSession()).toBe(false);
    await saveOfflineSnapshot("other", [1]);
    expect((await loadSnapshot(scope, "other"))?.data).toEqual([1]);
  });
});

describe("session info", () => {
  it("reads the database's answer and rejects anything else", () => {
    expect(parseSessionInfo(null)).toBeNull();
    expect(parseSessionInfo({})).toBeNull();
    expect(parseSessionInfo({ user_id: "u", organization_id: "o", support: true, read_only: true, hidden_sections: ["quotes", 3] })).toMatchObject({ support: true, read_only: true, hidden_sections: ["quotes"], platform_admin: false });
    expect(offlineCopyAllowed(support)).toBe(false);
    expect(offlineCopyAllowed(base)).toBe(true);
    expect(offlineCopyAllowed(null)).toBe(true);
  });

  it("the banner names the company, the access and the expiry in UK time", () => {
    expect(supportBanner(base)).toBeNull();
    expect(supportBanner(support)).toBe("Support access to Gamma Ltd, read-only, expires 14:30");
    expect(supportBanner({ ...support, read_only: false, elevated_until: "2026-10-12T12:45:00Z" })).toBe("Support access to Gamma Ltd, write access until 13:45, expires 14:30");
  });

  it("routes: owner to the platform list, several companies to the picker, one company straight in", () => {
    const none = { ...base, organization_id: null, role: null };
    expect(companyStepRoute({ ...none, platform_admin: true, needs_choice: true }, "/dashboard")).toBe("/platform");
    expect(companyStepRoute({ ...none, platform_admin: true, needs_choice: true }, "/platform")).toBeNull();
    expect(companyStepRoute({ ...none, organization_count: 2, needs_choice: true }, "/jobs")).toBe("/choose-company");
    expect(companyStepRoute({ ...none, organization_count: 2, needs_choice: true }, "/choose-company")).toBeNull();
    expect(companyStepRoute(base, "/dashboard")).toBeNull();
    expect(companyStepRoute(base, "/platform")).toBe("/dashboard");
    expect(companyStepRoute({ ...base, platform_admin: true }, "/platform")).toBeNull();
    expect(companyStepRoute(null, "/dashboard")).toBeNull();
  });
});
