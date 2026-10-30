/**
 * E4c: two open tabs share one browser (localStorage, session) but each holds its own module state. After tab A switched company or
 * saved the company details, tab B kept the old company's profile until a full reload, so a form or printed document made there
 * carried the old company. These tests run two tabs (each its own module instances) over one fake localStorage whose writes reach the
 * OTHER tab as storage events (never the writer), as browsers do.
 * Not covered here: UserProvider itself (vitest runs in node, no jsdom / React renderer); its wiring is a few lines in lib/use-user.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { key: string | null; newValue: string | null }) => void;
type Tab = {
  name: string;
  listeners: Set<Listener>;
  company: typeof import("@/lib/company");
  sync: typeof import("@/lib/company-sync");
  access: typeof import("@/lib/offline/access");
};

const db = vi.hoisted(() => ({ settings: null as unknown, session: null as unknown }));
let local: Map<string, string>;
let tabs: Tab[];
let writer: Tab | null;

const profileOf = (name: string) => ({
  key: "org", name, documentName: name, addressLines: ["1 Test Road"], phone: "01234 000000", email: "office@example.test", vatNumber: "GB000000000", vatRegistered: true,
});

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table !== "organization_settings") throw new Error(`unexpected table ${table}`);
      return {
        // saveCompanyProfile (P1, #52, now on main) reads the stored row with .eq() before it saves; the load reads it without.
        select: () => { const q = { eq: () => q, maybeSingle: async () => ({ data: db.settings, error: null }) }; return q; },
        upsert: async (row: { organization_id: string; company_profile: unknown }) => { db.settings = { organization_id: row.organization_id, company_profile: row.company_profile }; return { error: null }; },
      };
    },
    rpc: async (name: string) => ({ data: name === "my_session" ? db.session : null, error: null }),
  };
}

async function openTab(name: string): Promise<Tab> {
  vi.resetModules();
  vi.doMock("@/lib/supabase", () => ({ supabase: fakeSupabase(), isSupabaseConfigured: true }));
  const tab: Tab = { name, listeners: new Set(), company: await import("@/lib/company"), sync: await import("@/lib/company-sync"), access: await import("@/lib/offline/access") };
  tabs.push(tab);
  return tab;
}
/** Runs `fn` as code of this tab: its localStorage writes go to every other tab. */
async function inTab<T>(tab: Tab, fn: () => Promise<T> | T): Promise<T> {
  writer = tab;
  try { return await fn(); } finally { writer = null; }
}
/** The tab's own storage listener, exactly as lib/use-user.ts installs it. */
function listen(tab: Tab, userId: string | null, onSignal: (signal: string) => void) {
  const target = {
    addEventListener: (_: "storage", fn: Listener) => void tab.listeners.add(fn),
    removeEventListener: (_: "storage", fn: Listener) => void tab.listeners.delete(fn),
  };
  return tab.sync.listenForTabSignals(target as never, { userId: () => userId, skip: () => false, onSignal });
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  local = new Map();
  tabs = [];
  writer = null;
  db.settings = { organization_id: "org-a", company_profile: profileOf("Alpha Engineering") };
  db.session = { user_id: "u1", organization_id: "org-a", role: "office" };
  const notify = (key: string, newValue: string | null, oldValue: string | null) => {
    if (newValue === oldValue) return;
    for (const tab of tabs) if (tab !== writer) for (const fn of tab.listeners) fn({ key, newValue });
  };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => { const old = local.get(k) ?? null; local.set(k, v); notify(k, v, old); },
      removeItem: (k: string) => { const old = local.get(k) ?? null; local.delete(k); notify(k, null, old); },
    },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("@/lib/supabase"); vi.resetModules(); });

describe("company settings saved in another tab", () => {
  it("the second tab reloads its company profile without a page reload", async () => {
    const a = await openTab("A");
    const b = await openTab("B");
    await inTab(a, () => a.company.loadCompanyProfile());
    await inTab(b, () => b.company.loadCompanyProfile());
    expect(b.company.getCompanyProfile().name).toBe("Alpha Engineering");
    const stop = listen(b, "u1", (signal) => { if (signal === "refresh-company") void b.company.loadCompanyProfile(true); });

    await inTab(a, () => a.company.saveCompanyProfile("org-a", profileOf("Alpha Engineering (Midlands)") as never));
    await flush();

    expect(a.company.getCompanyProfile().name).toBe("Alpha Engineering (Midlands)");
    expect(b.company.getCompanyProfile().name).toBe("Alpha Engineering (Midlands)");
    stop();
  });

  it("the writing tab does not signal itself", async () => {
    const a = await openTab("A");
    const seen: string[] = [];
    listen(a, "u1", (signal) => seen.push(signal));
    await inTab(a, () => a.company.saveCompanyProfile("org-a", profileOf("Alpha Two") as never));
    expect(seen).toEqual([]);
  });
});

describe("company switched in another tab", () => {
  it("tab A's switch tells tab B to check now; B finds the session in another company and must follow it", async () => {
    const a = await openTab("A");
    const b = await openTab("B");
    const asked: string[] = [];
    listen(b, "u1", (signal) => asked.push(signal));

    // What switchOrganization does once switch_organization succeeded.
    db.session = { user_id: "u1", organization_id: "org-b", role: "office" };
    await inTab(a, () => a.access.signalAccessRecheck());
    expect(asked).toEqual(["recheck"]);

    // B's recheck reads my_session (lib/use-user.ts): another company, with a role there.
    const answer = (await fakeSupabase().rpc("my_session")).data as { organization_id: string | null; role: string | null };
    expect(b.sync.companyChangedElsewhere("org-a", answer)).toBe(true);
    // B resets its company copy as the picker does: the old company's profile is gone and is read again for the new session.
    await inTab(b, () => b.company.loadCompanyProfile());
    db.settings = { organization_id: "org-b", company_profile: profileOf("Beta Fabrication") };
    b.company.resetCompanyProfile();
    expect(() => b.company.getCompanyProfile()).toThrow();
    expect((await b.company.loadCompanyProfile())?.name).toBe("Beta Fabrication");
  });

  it("is not a move when the company is the same, the person has no role there, or nothing is known", async () => {
    const { companyChangedElsewhere } = (await openTab("A")).sync;
    expect(companyChangedElsewhere("org-a", { organization_id: "org-a", role: "office" })).toBe(false);
    expect(companyChangedElsewhere("org-a", { organization_id: "org-b", role: null })).toBe(false); // removed: the access rules decide
    expect(companyChangedElsewhere("org-a", { organization_id: null, role: null })).toBe(false);
    expect(companyChangedElsewhere(null, { organization_id: "org-b", role: "office" })).toBe(false);
  });
});

describe("removed from this tab's company while the server falls back to another one", () => {
  it("removed from X with one other active company Y: not a switch to follow; access ends (moved) and the device copy is suspended", async () => {
    const a = await openTab("A");
    const { decideAccess } = await import("@/lib/access-recheck");
    const { suspendOfflineAccess } = await import("@/lib/offline/scope");
    // 036 _session_membership: the chosen company X is no longer usable, so the session falls back to the only other one, Y.
    const now = { organization_id: "org-y", role: "office" };
    const stillActive = [{ organization_id: "org-y" }]; // my_organizations: X is gone
    expect(a.sync.companyChangedElsewhere("org-x", now)).toBe(true);
    expect(a.sync.followsCompanySwitch("org-x", now, stillActive)).toBe(false);
    // What use-user then does: decideAccess says end/"moved", endAccess suspends this person's offline access on the device.
    expect(decideAccess({ role: "office", secondary_role: null, organization_id: "org-x" }, { signedIn: true, profile: { active: true, organization_id: "org-y" }, membership: null })).toEqual({ kind: "end", reason: "moved" });
    expect(a.access.offlineAccessBlocked("u-removed")).toBe(false);
    suspendOfflineAccess("u-removed");
    expect(a.access.offlineAccessBlocked("u-removed")).toBe(true);
  });

  it("a real switch (X still among the active companies) is followed", async () => {
    const a = await openTab("A");
    const both = [{ organization_id: "org-x" }, { organization_id: "org-y" }];
    expect(a.sync.followsCompanySwitch("org-x", { organization_id: "org-y", role: "office" }, both)).toBe(true);
    expect(a.sync.followsCompanySwitch("org-x", { organization_id: "org-x", role: "office" }, both)).toBe(false);
    expect(a.sync.followsCompanySwitch("org-x", { organization_id: "org-y", role: "office" }, [])).toBe(false);
  });
});

describe("sign-out in another tab", () => {
  it("tab A signing out asks tab B to check at once, and a tab with no signed-in person ignores signals", async () => {
    const a = await openTab("A");
    const b = await openTab("B");
    const c = await openTab("C");
    const asked: string[] = [];
    listen(b, "u1", (signal) => asked.push(`B:${signal}`));
    listen(c, null, (signal) => asked.push(`C:${signal}`));
    await inTab(a, () => a.access.signalAccessRecheck());
    expect(asked).toEqual(["B:recheck"]);
  });

  it("another tab's access-ended mark for this person locks this tab; one for somebody else does not", async () => {
    const a = await openTab("A");
    const b = await openTab("B");
    const asked: string[] = [];
    listen(b, "u1", (signal) => asked.push(signal));
    await inTab(a, () => { window.localStorage.setItem(`${a.access.OFFLINE_ACCESS_PREFIX}other-user`, "1"); window.localStorage.setItem(`${a.access.OFFLINE_ACCESS_PREFIX}u1`, "1"); });
    expect(asked).toEqual(["end"]);
  });
});
