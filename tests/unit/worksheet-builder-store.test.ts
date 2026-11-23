/**
 * Module K (worksheet builder): the reads and writes. Printing never fails because of the builder (unreadable means off), the Settings
 * card never edits from a failed read, a save changes only company_profile.worksheetBuilder and keeps layouts another admin saved
 * meanwhile, and a custom-value save writes only jobs.worksheet_custom (and says so plainly before release 170 is applied).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };
const h = vi.hoisted(() => ({ tables: {} as Record<string, Result | (() => Result)>, calls: [] as { table: string; op: string; args: unknown[] }[], throwOnFrom: false }));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    return {
      from: (table: string) => {
        if (h.throwOnFrom) throw new Error("network down");
        const read = () => { const r = h.tables[table]; return typeof r === "function" ? r() : r ?? { data: null, error: null }; };
        const write = (op: string) => (...args: unknown[]) => { h.calls.push({ table, op, args }); const r = h.tables[`${table}:${op}`]; return Promise.resolve((typeof r === "function" ? r() : r) ?? { data: null, error: null }); };
        const builder: Record<string, unknown> = {};
        for (const op of ["select", "eq"]) builder[op] = (...args: unknown[]) => { h.calls.push({ table, op, args }); return builder; };
        builder.maybeSingle = async () => read();
        builder.upsert = write("upsert");
        builder.update = (...args: unknown[]) => { h.calls.push({ table, op: "update", args }); return { eq: write("update.eq") }; };
        return builder;
      },
    };
  },
}));

import { saveCustomValues, CustomValuesUnavailableError } from "@/lib/worksheet-builder/custom-values";
import { archiveLayout, newLayout, setActiveLayout, upsertLayout } from "@/lib/worksheet-builder/layouts";
import { BUILDER_OFF, loadWorksheetBuilder, loadWorksheetBuilderStrict, updateWorksheetBuilderState } from "@/lib/worksheet-builder/store";
import { WORKSHEET_BUILDER_ON_MARKER } from "@/lib/worksheet-builder/switch";

const lay = (id: string, name = "Mine") => newLayout("basic", name, () => id);

beforeEach(() => { h.tables = {}; h.calls = []; h.throwOnFrom = false; });

describe("reading", () => {
  it("a read error or a thrown error is 'off' for printing, so Basic and JNR sheet print as before", async () => {
    h.tables.organization_settings = { data: null, error: { message: "boom" } };
    expect(await loadWorksheetBuilder()).toBe(BUILDER_OFF);
    h.throwOnFrom = true;
    expect(await loadWorksheetBuilder()).toBe(BUILDER_OFF);
  });
  it("but the Settings card is told when it cannot read, so it never edits from nothing", async () => {
    h.tables.organization_settings = { data: null, error: { message: "boom" } };
    await expect(loadWorksheetBuilderStrict()).rejects.toMatchObject({ message: "boom" });
  });
  it("reads the switch, the layouts and the customer sign-off switch from the company's own row", async () => {
    h.tables.organization_settings = { data: { organization_id: "o1", hidden_nav: [WORKSHEET_BUILDER_ON_MARKER], company_profile: { name: "x", worksheetBuilder: { layouts: [lay("a1")], activeId: "a1" } }, customer_signoff_enabled: true }, error: null };
    const config = await loadWorksheetBuilder();
    expect(config.enabled).toBe(true);
    expect(config.state.layouts.map((l) => l.id)).toEqual(["a1"]);
    expect(config.state.activeId).toBe("a1");
    expect(config.requirements.customerSignOff).toBe(true);
  });
  it("no row, or an old database without the column, is off", async () => {
    h.tables.organization_settings = { data: null, error: null };
    expect((await loadWorksheetBuilder()).enabled).toBe(false);
  });
});

describe("saving layouts", () => {
  it("changes only the worksheetBuilder key and leaves the rest of the company profile as it was", async () => {
    h.tables.organization_settings = { data: { company_profile: { name: "Acme", printLayout: "jnr", brandPrimary: "#112233" } }, error: null };
    const saved = await updateWorksheetBuilderState("o1", (state) => upsertLayout(state, lay("a1")));
    expect(saved.layouts.map((l) => l.id)).toEqual(["a1"]);
    const upsert = h.calls.find((c) => c.op === "upsert")!;
    const row = upsert.args[0] as { organization_id: string; company_profile: Record<string, unknown> };
    expect(row.organization_id).toBe("o1");
    expect(row.company_profile).toMatchObject({ name: "Acme", printLayout: "jnr", brandPrimary: "#112233" });
    expect(Object.keys(row.company_profile).sort()).toEqual(["brandPrimary", "name", "printLayout", "worksheetBuilder"]);
    expect(upsert.args[1]).toEqual({ onConflict: "organization_id" });
  });
  it("applies the change to the freshly read state, so a layout another admin saved meanwhile is kept", async () => {
    h.tables.organization_settings = { data: { company_profile: { worksheetBuilder: { layouts: [lay("other", "Other admin's")], activeId: "other" } } }, error: null };
    const saved = await updateWorksheetBuilderState("o1", (state) => upsertLayout(state, lay("mine")));
    expect(saved.layouts.map((l) => l.id)).toEqual(["other", "mine"]);
    expect(saved.activeId).toBe("other");
  });
  it("what is written has been through the storage parse (nothing invalid can be saved)", async () => {
    h.tables.organization_settings = { data: { company_profile: {} }, error: null };
    const bad = { ...lay("a1"), name: "<b>x</b>", blocks: [...lay("a1").blocks, { id: "z", kind: "nope" } as never] };
    const saved = await updateWorksheetBuilderState("o1", (state) => ({ ...state, layouts: [bad] }));
    expect(saved.layouts[0].name).toBe("bx/b");
    expect(saved.layouts[0].blocks.some((b) => b.id === "z")).toBe(false);
  });
  it("choosing and deleting layouts goes through the same single write", async () => {
    h.tables.organization_settings = { data: { company_profile: { worksheetBuilder: { layouts: [lay("a1")], activeId: null } } }, error: null };
    expect((await updateWorksheetBuilderState("o1", (s) => setActiveLayout(s, "a1"))).activeId).toBe("a1");
    h.tables.organization_settings = { data: { company_profile: { worksheetBuilder: { layouts: [lay("a1")], activeId: "a1" } } }, error: null };
    const after = await updateWorksheetBuilderState("o1", (s) => archiveLayout(s, "a1"));
    expect(after.activeId).toBeNull();
    expect(after.layouts[0].archived).toBe(true);
  });
  it("a failed read or write is an error, never a silent overwrite", async () => {
    h.tables.organization_settings = { data: null, error: { message: "read failed" } };
    await expect(updateWorksheetBuilderState("o1", (s) => s)).rejects.toMatchObject({ message: "read failed" });
    expect(h.calls.some((c) => c.op === "upsert")).toBe(false);
    h.tables.organization_settings = { data: { company_profile: {} }, error: null };
    h.tables["organization_settings:upsert"] = { data: null, error: { message: "denied" } };
    await expect(updateWorksheetBuilderState("o1", (s) => s)).rejects.toMatchObject({ message: "denied" });
  });
});

describe("saving a job's custom values", () => {
  it("writes only the worksheet_custom column of that job", async () => {
    await saveCustomValues("job-1", { ticks: { a: true }, texts: { t: "hello" } });
    const update = h.calls.find((c) => c.op === "update")!;
    expect(update.table).toBe("jobs");
    expect(update.args[0]).toEqual({ worksheet_custom: { v: 1, ticks: { a: true }, texts: { t: "hello" } } });
    expect(h.calls.find((c) => c.op === "update.eq")?.args).toEqual(["id", "job-1"]);
  });
  it("before release 170 the column is missing: a plain message, not a pretend save", async () => {
    h.tables["jobs:update.eq"] = { data: null, error: { code: "42703", message: 'column "worksheet_custom" of relation "jobs" does not exist' } };
    await expect(saveCustomValues("job-1", { ticks: {}, texts: {} })).rejects.toBeInstanceOf(CustomValuesUnavailableError);
    h.tables["jobs:update.eq"] = { data: null, error: { code: "42501", message: "signed off" } };
    await expect(saveCustomValues("job-1", { ticks: {}, texts: {} })).rejects.toMatchObject({ code: "42501" });
  });
});
