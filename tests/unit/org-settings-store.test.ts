/**
 * The shared Columns / menu settings store (lib/org-settings): per-table merge saves, serialised toggles, a server refusal undone
 * (not shown as offline), the reset generation guard, the per-user-and-company local key, and locked columns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  };
  type Row = { hidden_nav: string[]; hidden_columns: Record<string, string[]> };
  type Err = { code?: string; message: string; hint?: string } | null;
  const db = {
    org: "org-a",
    user: "user-1",
    offline: false,
    row: null as Row | null,
    selectError: null as Err,
    upsertError: null as Err,
    upsertStatus: 201,
    upserts: [] as Array<Record<string, unknown>>,
    /** When set, the next select waits for it (a slow read). */
    selectGate: null as Promise<void> | null,
    /** Auth-server checks: getUser here, and getCurrentUserAndOrganization in the business mock. */
    userAsks: 0,
  };
  const fake = {
    auth: {
      getUser: async () => (db.userAsks += 1, db.offline ? { data: { user: null }, error: { message: "Failed to fetch" } } : { data: { user: { id: db.user } }, error: null }),
      getSession: async () => ({ data: { session: { user: { id: db.user } } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const gate = db.selectGate;
            db.selectGate = null;
            if (gate) await gate;
            if (db.selectError) return { data: null, error: db.selectError, status: 0 };
            return { data: db.row ? structuredClone(db.row) : null, error: null, status: 200 };
          },
        }),
      }),
      upsert: async (payload: Record<string, unknown>) => {
        db.upserts.push(structuredClone(payload));
        if (db.upsertError) return { error: db.upsertError, status: db.upsertStatus };
        const { organization_id: _org, updated_at: _at, ...rest } = payload;
        void _org; void _at;
        db.row = { hidden_nav: [], hidden_columns: {}, ...db.row, ...(rest as Partial<Row>) };
        return { error: null, status: 201 };
      },
    }),
  };
  return { store, db, fake };
});

vi.mock("@/lib/supabase", () => ({ supabase: h.fake }));
vi.mock("@/lib/supabase-business", () => ({
  getCurrentOrganizationId: async () => { h.db.userAsks += 1; if (h.db.offline) throw new Error("You must be signed in."); return h.db.org; },
  getCurrentUserAndOrganization: async () => { h.db.userAsks += 1; if (h.db.offline) throw new Error("You must be signed in."); return { userId: h.db.user, organizationId: h.db.org }; },
}));

import {
  cleanColumns, COLUMN_TABLES, getOrgSettingsSnapshot, isSettingsDenial, loadOrgSettings, orgSettingsStorageKey, resetOrgSettings,
  columnVisibility, resetColumns, saveOrgSettings, setColumnHidden, setNavHidden,
} from "@/lib/org-settings";

const keyFor = (org: string) => orgSettingsStorageKey(h.db.user, org)!;
const deferred = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };

beforeEach(() => {
  resetOrgSettings();
  h.store.clear();
  Object.assign(h.db, { org: "org-a", user: "user-1", offline: false, row: null, selectError: null, upsertError: null, upsertStatus: 201, upserts: [], selectGate: null, userAsks: 0 });
});
afterEach(() => { resetOrgSettings(); });

describe("save: per-table merge onto the row as it is now", () => {
  it("re-reads the row and changes only the toggled table; never sends hidden_nav for a column change", async () => {
    h.db.row = { hidden_nav: ["rfq"], hidden_columns: { quotes: ["date"] } };
    await loadOrgSettings(true);
    // Another admin changes other tables and the menu after this browser loaded.
    h.db.row = { hidden_nav: ["rfq", "email"], hidden_columns: { quotes: ["date", "valid"], suppliers: ["notes"], jobs: ["machine"] } };

    const result = await setColumnHidden("customers", "phone", true);

    expect(result).toEqual({ localOnly: false, denied: false });
    expect(h.db.upserts).toHaveLength(1);
    expect(h.db.upserts[0]).not.toHaveProperty("hidden_nav");
    expect(h.db.upserts[0].hidden_columns).toEqual({ quotes: ["date", "valid"], suppliers: ["notes"], jobs: ["machine"], customers: ["phone"] });
    expect(h.db.row!.hidden_nav).toEqual(["rfq", "email"]);
    // The cache now shows the other admin's choices too.
    expect(getOrgSettingsSnapshot().hiddenColumns.quotes).toEqual(["date", "valid"]);
  });

  it("a menu change sends only hidden_nav, merged onto the current menu", async () => {
    await loadOrgSettings(true);
    h.db.row = { hidden_nav: ["email"], hidden_columns: { quotes: ["date"] } };
    await setNavHidden("rfq", true);
    expect(h.db.upserts[0]).not.toHaveProperty("hidden_columns");
    expect(h.db.upserts[0].hidden_nav).toEqual(["email", "rfq"]);
  });

  it("the whole-set saveOrgSettings is turned into per-table deltas (a stale other table is not written back)", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: { quotes: ["date"] } };
    await loadOrgSettings(true);
    h.db.row = { hidden_nav: [], hidden_columns: { quotes: [] } };
    const cached = getOrgSettingsSnapshot().hiddenColumns;
    await saveOrgSettings({ hiddenColumns: { ...cached, customers: ["email"] } });
    expect(h.db.row!.hidden_columns).toEqual({ quotes: [], customers: ["email"] });
  });

  it("two quick toggles are saved one after the other, each on the row the previous one wrote", async () => {
    await loadOrgSettings(true);
    const slow = deferred();
    h.db.selectGate = slow.promise;
    const first = setColumnHidden("customers", "phone", true);
    const second = setColumnHidden("customers", "email", true);
    // Both show at once.
    expect(getOrgSettingsSnapshot().hiddenColumns.customers).toEqual(["phone", "email"]);
    await Promise.resolve();
    expect(h.db.upserts).toHaveLength(0);
    slow.release();
    await Promise.all([first, second]);
    expect(h.db.upserts.map((payload) => (payload.hidden_columns as Record<string, string[]>).customers)).toEqual([["phone"], ["phone", "email"]]);
    expect(h.db.row!.hidden_columns.customers).toEqual(["phone", "email"]);
  });
});

describe("reset one screen and defaults", () => {
  it("Reset to default on one screen removes only that screen's entry; hidden_nav and other screens are untouched", async () => {
    h.db.row = { hidden_nav: ["rfq"], hidden_columns: { customers: ["phone", "email"], suppliers: ["notes"], jobs: ["machine"] } };
    await loadOrgSettings(true);
    const result = await resetColumns("customers");
    expect(result).toEqual({ localOnly: false, denied: false });
    expect(h.db.upserts[0]).not.toHaveProperty("hidden_nav");
    expect(h.db.row).toEqual({ hidden_nav: ["rfq"], hidden_columns: { suppliers: ["notes"], jobs: ["machine"] } });
    expect(getOrgSettingsSnapshot().hiddenColumns).toEqual({ suppliers: ["notes"], jobs: ["machine"] });
  });

  it("a new screen with no stored entry shows every column", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: { customers: ["phone"] } };
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().hiddenColumns["new-screen"]).toBeUndefined();
    const visible = columnVisibility("new-screen", getOrgSettingsSnapshot().hiddenColumns["new-screen"]);
    expect(["a", "b", "anything"].every(visible)).toBe(true);
    const suppliers = columnVisibility("suppliers", undefined);
    expect(COLUMN_TABLES.find((table) => table.key === "suppliers")!.columns.every((column) => suppliers(column.key))).toBe(true);
  });
});

describe("save: a refusal is undone, not shown as offline", () => {
  it.each([
    [{ code: "42501", message: "new row violates row-level security policy for table \"organization_settings\"" }, 403, "You can't change this setting. Nothing was saved."],
    [{ code: "42501", message: "Support access is read-only. Ask for write access first.", hint: "support_read_only" }, 403, "You can't change this: support access is read-only. Nothing was saved."],
    [{ code: "P0001", message: "Only admins can change hidden menu items" }, 400, "You can't change this setting. Nothing was saved."],
  ])("%o -> denied, change reverted, nothing kept locally", async (error, status, message) => {
    h.db.row = { hidden_nav: [], hidden_columns: { customers: ["address"] } };
    await loadOrgSettings(true);
    h.db.upsertError = error;
    h.db.upsertStatus = status;
    const result = await setColumnHidden("customers", "phone", true);
    expect(result).toEqual({ localOnly: false, denied: true, message });
    expect(getOrgSettingsSnapshot().hiddenColumns.customers).toEqual(["address"]);
    expect(getOrgSettingsSnapshot().localOnly).toBe(false);
    expect(JSON.parse(h.store.get(keyFor("org-a"))!).hiddenColumns.customers).toEqual(["address"]);
  });

  it("a network failure keeps the change in this browser (localOnly)", async () => {
    await loadOrgSettings(true);
    h.db.upsertError = { code: "", message: "TypeError: Failed to fetch" };
    h.db.upsertStatus = 0;
    const result = await setColumnHidden("customers", "phone", true);
    expect(result).toEqual({ localOnly: true, denied: false });
    expect(getOrgSettingsSnapshot()).toMatchObject({ localOnly: true, hiddenColumns: { customers: ["phone"] } });
    expect(JSON.parse(h.store.get(keyFor("org-a"))!).hiddenColumns.customers).toEqual(["phone"]);
  });

  it("isSettingsDenial tells refusals from outages", () => {
    expect(isSettingsDenial({ status: 401, message: "x" })).toBe(true);
    expect(isSettingsDenial({ status: 403, message: "x" })).toBe(true);
    expect(isSettingsDenial({ code: "42501", message: "x" })).toBe(true);
    expect(isSettingsDenial({ code: "PGRST301", message: "JWT expired" })).toBe(true);
    expect(isSettingsDenial({ code: "", message: "TypeError: Failed to fetch", status: 0 })).toBe(false);
    expect(isSettingsDenial(new Error("Supabase is not configured."))).toBe(false);
    expect(isSettingsDenial({ code: "PGRST205", message: "Could not find the table" })).toBe(false);
  });
});

describe("reset: generation guard and the per-user-and-company key", () => {
  it("a fetch still in flight when the company switches does not write its result", async () => {
    h.db.row = { hidden_nav: ["rfq"], hidden_columns: { customers: ["phone"] } };
    const slow = deferred();
    h.db.selectGate = slow.promise;
    const loading = loadOrgSettings(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetOrgSettings();
    slow.release();
    await loading;
    expect(getOrgSettingsSnapshot()).toMatchObject({ loaded: false, hiddenNav: [], hiddenColumns: {} });
    expect(h.store.size).toBe(0);
  });

  it("a save in flight at reset drops its result", async () => {
    await loadOrgSettings(true);
    const slow = deferred();
    h.db.selectGate = slow.promise;
    const saving = setColumnHidden("customers", "phone", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetOrgSettings();
    slow.release();
    expect(await saving).toEqual({ localOnly: false, denied: false, dropped: true });
    expect(h.db.upserts).toHaveLength(0);
    expect(getOrgSettingsSnapshot().hiddenColumns).toEqual({});
  });

  it("a save queued in one company is dropped if the session is already in another (switch before reset)", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: {} };
    await loadOrgSettings(true);
    const slow = deferred();
    h.db.selectGate = slow.promise;
    const first = setColumnHidden("customers", "phone", true);
    const second = setColumnHidden("customers", "email", true);
    // switch_organization has answered: the server now resolves the new company, but resetOrgSettings has not run yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.db.org = "org-b";
    slow.release();
    // The first save had already read org-a's row; the second resolves org-b and is dropped.
    expect(await first).toEqual({ localOnly: false, denied: false });
    expect(await second).toEqual({ localOnly: false, denied: false, dropped: true });
    expect(h.db.upserts).toHaveLength(1);
    expect(getOrgSettingsSnapshot().hiddenColumns.customers).toEqual(["phone"]);
  });

  it("a dropped whole-set save reports dropped, so Settings announces nothing", async () => {
    await loadOrgSettings(true);
    h.db.org = "org-b";
    expect(await saveOrgSettings({ hiddenColumns: { customers: ["phone"] } })).toEqual({ localOnly: false, denied: false, dropped: true });
    expect(h.db.upserts).toHaveLength(0);
  });

  it("an offline cold reload finds this company's local copy through the remembered company id", async () => {
    h.db.row = { hidden_nav: ["rfq"], hidden_columns: { customers: ["phone"] } };
    await loadOrgSettings(true);
    // A new page load: module memory is gone (simulated by the generation-free path below), the device is offline.
    vi.resetModules();
    const fresh = await import("@/lib/org-settings");
    h.db.offline = true;
    await fresh.loadOrgSettings(true);
    expect(fresh.getOrgSettingsSnapshot()).toMatchObject({ loaded: true, localOnly: true, hiddenNav: ["rfq"], hiddenColumns: { customers: ["phone"] } });
  });

  it("reset forgets the remembered company, so an offline load after sign-out shows nothing cached", async () => {
    h.db.row = { hidden_nav: ["rfq"], hidden_columns: {} };
    await loadOrgSettings(true);
    resetOrgSettings();
    expect(h.store.size).toBe(0);
  });

  it("the key names the user and the company; another company's copy is never read", async () => {
    expect(orgSettingsStorageKey("user-1", "org-a")).not.toBe(orgSettingsStorageKey("user-1", "org-b"));
    expect(orgSettingsStorageKey("user-1", null)).toBeNull();
    h.store.set(keyFor("org-a"), JSON.stringify({ hiddenNav: ["rfq"], hiddenColumns: { customers: ["phone"] } }));
    h.db.org = "org-b";
    h.db.selectError = { code: "", message: "TypeError: Failed to fetch" };
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot()).toMatchObject({ loaded: true, localOnly: true, hiddenNav: [], hiddenColumns: {} });
  });

  it("reset removes this company's real key (and the old unkeyed / user-only keys), not other companies'", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: { customers: ["phone"] } };
    await loadOrgSettings(true);
    expect(h.store.has(keyFor("org-a"))).toBe(true);
    h.store.set(keyFor("org-b"), "{}");
    h.store.set("quoteflow-org-settings", "{}");
    h.store.set("quoteflow-org-settings:user-1", "{}");
    resetOrgSettings();
    expect([...h.store.keys()]).toEqual([keyFor("org-b")]);
  });
});

describe("locked columns", () => {
  it("every table's reference column is locked", () => {
    const locked = Object.fromEntries(COLUMN_TABLES.map((table) => [table.key, table.columns.filter((column) => column.locked).map((column) => column.label)]));
    expect(locked).toEqual({ jobs: ["Job No", "Due", "Actions"], quotes: ["Quote"], "sales-orders": ["SO Ref"], "purchase-orders": ["PO Ref"], invoices: ["Invoice"], "delivery-notes": ["DN Ref"], customers: ["Name"], suppliers: ["Name"] });
  });

  it("cleanColumns strips locked keys from a crafted row and keeps unknown tables and keys", () => {
    expect(cleanColumns({ customers: ["name", "phone", "phone", 7], quotes: ["ref"], jobs: ["machine"], invoices: "x" })).toEqual({ customers: ["phone"], quotes: [], jobs: ["machine"] });
  });

  it("a table with no locked column always keeps one column visible", () => {
    COLUMN_TABLES.push({ key: "test-table", label: "Test", columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }] });
    try {
      expect(cleanColumns({ "test-table": ["a", "b"] })).toEqual({ "test-table": ["b"] });
    } finally {
      COLUMN_TABLES.pop();
    }
  });

  it("hiding a locked column is refused without a save; a crafted row from the server cannot hide it", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: { customers: ["name"] } };
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().hiddenColumns.customers).toEqual([]);
    expect((await setColumnHidden("customers", "name", true)).denied).toBe(true);
    expect(h.db.upserts).toHaveLength(0);
  });
});

describe("load: one auth-server check names the user and the company", () => {
  it("online: the settings load asks the auth server once, files the copy under the user and company, and reads the row", async () => {
    h.db.row = { hidden_nav: ["quotes"], hidden_columns: {} };
    await loadOrgSettings(true);
    expect(h.db.userAsks).toBe(1);
    expect(getOrgSettingsSnapshot()).toMatchObject({ loaded: true, localOnly: false, hiddenNav: ["quotes"] });
    expect(h.store.has(keyFor("org-a"))).toBe(true);
  });
});
