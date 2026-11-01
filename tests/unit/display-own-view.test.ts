/**
 * G5 display plan option A: a person's own view on this device (lib/org-settings deviceColumns). Workshop and viewer pickers write
 * it; it never reaches the server; it is keyed by user and company; a screen without one follows the company setting; locked
 * columns are never hidden; reset goes back to the company view. Admin and office pickers keep changing the company setting.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

const role = vi.hoisted(() => ({ company: false, loading: false }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ hasAnyRole: (roles: string[]) => role.company && roles.includes("admin"), loading: role.loading }) }));

import {
  clearDeviceColumns, deviceViewStorageKey, effectiveHidden, getOrgSettingsSnapshot, loadOrgSettings, orgSettingsStorageKey,
  resetDeviceColumns, resetOrgSettings, setColumnHidden, setDeviceColumnHidden,
} from "@/lib/org-settings";
import { COMPANY_DISPLAY_ROLES, ColumnToggle, columnScopeText, resetLabel } from "@/components/column-toggle";

const ownKey = () => deviceViewStorageKey(h.db.user, h.db.org)!;
const stored = () => JSON.parse(h.store.get(ownKey()) ?? "null");
const shown = (table: string) => effectiveHidden(getOrgSettingsSnapshot(), table);

beforeEach(() => {
  resetOrgSettings();
  h.store.clear();
  Object.assign(h.db, { org: "org-a", user: "user-1", offline: false, row: null, selectError: null, upsertError: null, upsertStatus: 201, upserts: [], selectGate: null, userAsks: 0 });
  Object.assign(role, { company: false, loading: false });
});
afterEach(() => { resetOrgSettings(); });

describe("own view on this device: defaults", () => {
  it("with no own view every screen follows the company setting (today's behaviour)", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: { quotes: ["date"] } };
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().deviceColumns).toEqual({});
    expect(shown("quotes")).toEqual(["date"]);
    expect(shown("jobs")).toBeUndefined();
  });

  it("the key names the user and the company, and is null when either is unknown", () => {
    expect(deviceViewStorageKey("u", "o")).toBe("quoteflow-display-override:u:o");
    expect(deviceViewStorageKey(null, "o")).toBeNull();
    expect(deviceViewStorageKey("u", null)).toBeNull();
    expect(deviceViewStorageKey("u", "o")).not.toBe(orgSettingsStorageKey("u", "o"));
  });
});

describe("own view on this device: changes", () => {
  it("the first change starts from what the company shows, stays in this browser and never writes to the server", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: { quotes: ["date"] } };
    await loadOrgSettings(true);
    const result = await setDeviceColumnHidden("quotes", "value", true);
    expect(result).toEqual({ localOnly: true, denied: false });
    expect(shown("quotes")).toEqual(["date", "value"]);
    expect(getOrgSettingsSnapshot().hiddenColumns.quotes).toEqual(["date"]);
    expect(h.db.upserts).toHaveLength(0);
    expect(h.db.row!.hidden_columns).toEqual({ quotes: ["date"] });
    expect(stored()).toEqual({ quotes: ["date", "value"] });
  });

  it("showing a column the company hid changes only this person's view", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: { quotes: ["date"] } };
    await loadOrgSettings(true);
    await setDeviceColumnHidden("quotes", "date", false);
    expect(shown("quotes")).toEqual([]);
    expect(getOrgSettingsSnapshot().hiddenColumns.quotes).toEqual(["date"]);
    expect(h.db.upserts).toHaveLength(0);
  });

  it("a locked column cannot be hidden, and a screen always keeps one column", async () => {
    await loadOrgSettings(true);
    expect((await setDeviceColumnHidden("quotes", "ref", true)).denied).toBe(true);
    expect(getOrgSettingsSnapshot().deviceColumns).toEqual({});
    for (const key of ["days", "breaks", "jobs", "unallocated", "ticks"]) await setDeviceColumnHidden("hours", key, true);
    expect(shown("hours")).toEqual(["days", "breaks", "jobs", "unallocated", "ticks"]);
    expect(shown("hours")).not.toContain("clocked");
  });

  it("reset drops the own view of that screen only: it follows the company again", async () => {
    h.db.row = { hidden_nav: [], hidden_columns: { quotes: ["date"] } };
    await loadOrgSettings(true);
    await setDeviceColumnHidden("quotes", "value", true);
    await setDeviceColumnHidden("jobs", "machine", true);
    await resetDeviceColumns("quotes");
    expect(shown("quotes")).toEqual(["date"]);
    expect(shown("jobs")).toEqual(["machine"]);
    expect(stored()).toEqual({ jobs: ["machine"] });
    await resetDeviceColumns("jobs");
    expect(h.store.has(ownKey())).toBe(false);
  });

  it("an own view of a screen wins over later company changes to that screen; other screens still follow the company", async () => {
    await loadOrgSettings(true);
    await setDeviceColumnHidden("quotes", "value", true);
    role.company = true;
    await setColumnHidden("quotes", "date", true);
    await setColumnHidden("customers", "phone", true);
    expect(shown("quotes")).toEqual(["value"]);
    expect(shown("customers")).toEqual(["phone"]);
  });

  it("clearDeviceColumns (an admin or office picker) drops every own view in this company", async () => {
    await loadOrgSettings(true);
    await setDeviceColumnHidden("quotes", "value", true);
    clearDeviceColumns();
    expect(getOrgSettingsSnapshot().deviceColumns).toEqual({});
    expect(h.store.has(ownKey())).toBe(false);
  });

  it("is refused, and nothing is stored, when the user or company is not known yet", async () => {
    const result = await setDeviceColumnHidden("quotes", "value", true);
    expect(result.denied).toBe(true);
    expect(h.store.size).toBe(0);
  });
});

describe("own view on this device: reload, sign-out, other people", () => {
  it("survives a reload and a sign-out for the same person and company (read online and offline)", async () => {
    await loadOrgSettings(true);
    await setDeviceColumnHidden("jobs", "machine", true);
    resetOrgSettings();
    expect(getOrgSettingsSnapshot().deviceColumns).toEqual({});
    await loadOrgSettings(true);
    expect(shown("jobs")).toEqual(["machine"]);
    resetOrgSettings();
    // Offline cold reload: the company pointer is cleared on sign-out, so seed it as an online load would.
    await loadOrgSettings(true);
    h.db.offline = true;
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().localOnly).toBe(true);
    expect(shown("jobs")).toEqual(["machine"]);
  });

  it("never applies to another person or to this person's other company", async () => {
    await loadOrgSettings(true);
    await setDeviceColumnHidden("jobs", "machine", true);
    resetOrgSettings();
    h.db.user = "user-2";
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().deviceColumns).toEqual({});
    resetOrgSettings();
    h.db.user = "user-1";
    h.db.org = "org-b";
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().deviceColumns).toEqual({});
  });

  it("a damaged stored copy is ignored, and stored locked or duplicate keys are cleaned", async () => {
    h.store.set(deviceViewStorageKey("user-1", "org-a")!, "{not json");
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().deviceColumns).toEqual({});
    resetOrgSettings();
    h.store.set(deviceViewStorageKey("user-1", "org-a")!, JSON.stringify({ quotes: ["ref", "date", "date"], jobs: "x" }));
    await loadOrgSettings(true);
    expect(getOrgSettingsSnapshot().deviceColumns).toEqual({ quotes: ["date"] });
  });
});

describe("the Columns picker", () => {
  it("admin and office change the company setting; everyone else their own view", () => {
    expect([...COMPANY_DISPLAY_ROLES]).toEqual(["admin", "office"]);
    expect(columnScopeText(false)).toBe("Changes apply to everyone in this company.");
    expect(columnScopeText(true)).toMatch(/browser only/);
    expect(columnScopeText(false, true)).toMatch(/own view on this device only/);
    expect(resetLabel(false)).toBe("Reset to default (show all columns)");
    expect(resetLabel(true)).toBe("Reset to the company view");
  });

  it("shows the Columns button for workshop and viewer too (it was admin and office only), and nothing while the user loads", () => {
    role.company = false;
    expect(renderToStaticMarkup(createElement(ColumnToggle, { tableKey: "jobs" }))).toContain("Columns");
    role.company = true;
    expect(renderToStaticMarkup(createElement(ColumnToggle, { tableKey: "jobs" }))).toContain("Columns");
    role.loading = true;
    expect(renderToStaticMarkup(createElement(ColumnToggle, { tableKey: "jobs" }))).toBe("");
    role.loading = false;
    expect(renderToStaticMarkup(createElement(ColumnToggle, { tableKey: "no-such-screen" }))).toBe("");
  });
});
