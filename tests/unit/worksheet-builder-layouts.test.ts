/**
 * Module K (worksheet builder): the pure rules. Seeds, what storage may hold, locked blocks, the off-by-default switch, the print choice,
 * revisions (a worksheet signed off earlier reprints as it was signed), per-job custom values, and that Company details keeps the layouts.
 */
import { describe, expect, it } from "vitest";

import { BLOCK_KINDS, PALETTE, blockHeading, fieldLabel, BLOCK_FIELDS } from "@/lib/worksheet-builder/blocks";
import { brandInk } from "@/lib/worksheet-builder/brand";
import { EMPTY_CUSTOM_VALUES, canEditCustomValues, parseCustomValues, toStoredCustomValues } from "@/lib/worksheet-builder/custom-values";
import {
  MAX_HISTORY, addBlock, archiveLayout, basicBlocks, blankBlocks, commitLayoutEdit, customChoice, customChoiceId, jnrBlocks, layoutAsOf, liveLayouts, moveBlock,
  newLayout, packFallback, parseLayout, parseWorksheetBuilder, removeBlock, setActiveLayout, startingBlocks, updateBlock, upsertLayout, type WorksheetLayout,
} from "@/lib/worksheet-builder/layouts";
import { packLayoutOf, parsePrintOverride, resolvePrintChoice } from "@/lib/worksheet-builder/print-choice";
import { STRICT_REQUIREMENTS, isLockedBlock, lockedBlockProblems, lockedKinds, withRequiredBlocks } from "@/lib/worksheet-builder/requirements";
import { builderConfigFromRow, BUILDER_OFF } from "@/lib/worksheet-builder/store";
import { WORKSHEET_BUILDER_ON_MARKER, applyHiddenNavChange, canDesignWorksheets, worksheetBuilderEnabled, worksheetBuilderSwitchChange } from "@/lib/worksheet-builder/switch";
import { withStoredPrintLayout } from "@/lib/print-layout";

const fixedId = (id: string) => () => id;
const layout = (base: "basic" | "jnr" | "blank" = "basic", id = "lay1"): WorksheetLayout => newLayout(base, "Workshop sheet", fixedId(id));

describe("switch: off by default", () => {
  it("is off with no marker, on only with the exact marker", () => {
    expect(worksheetBuilderEnabled(undefined)).toBe(false);
    expect(worksheetBuilderEnabled([])).toBe(false);
    expect(worksheetBuilderEnabled(["reports:on", "worksheet-builder"])).toBe(false);
    expect(worksheetBuilderEnabled(["x", WORKSHEET_BUILDER_ON_MARKER])).toBe(true);
    expect(WORKSHEET_BUILDER_ON_MARKER).toBe("worksheet-builder:on");
  });
  it("changes only its own marker and keeps every other hidden_nav entry in order", () => {
    expect(applyHiddenNavChange(["a", "reports:on", "b"], worksheetBuilderSwitchChange(true))).toEqual(["a", "reports:on", "b", WORKSHEET_BUILDER_ON_MARKER]);
    expect(applyHiddenNavChange(["a", WORKSHEET_BUILDER_ON_MARKER, "b"], worksheetBuilderSwitchChange(false))).toEqual(["a", "b"]);
    expect(applyHiddenNavChange(["a", WORKSHEET_BUILDER_ON_MARKER], worksheetBuilderSwitchChange(true))).toEqual(["a", WORKSHEET_BUILDER_ON_MARKER]);
  });
  it("only an admin designs worksheets", () => {
    expect(["admin", "office", "workshop", "viewer", null, undefined].map(canDesignWorksheets)).toEqual([true, false, false, false, false, false]);
  });
  it("a company that never used it, or whose settings cannot be read, is off", () => {
    expect(builderConfigFromRow(null)).toBe(BUILDER_OFF);
    expect(builderConfigFromRow({ hidden_nav: [], company_profile: {} }).enabled).toBe(false);
    const on = builderConfigFromRow({ hidden_nav: [WORKSHEET_BUILDER_ON_MARKER], company_profile: { worksheetBuilder: { layouts: [layout()], activeId: "lay1" } }, customer_signoff_enabled: true });
    expect(on.enabled).toBe(true);
    expect(on.state.activeId).toBe("lay1");
    expect(on.requirements.customerSignOff).toBe(true);
    expect(builderConfigFromRow({ hidden_nav: [WORKSHEET_BUILDER_ON_MARKER], company_profile: {}, customer_signoff_enabled: false }).requirements.customerSignOff).toBe(false);
  });
});

describe("starting points", () => {
  it("Basic, JNR sheet and blank each start from a valid list of palette blocks", () => {
    for (const base of ["basic", "jnr", "blank"] as const) {
      const blocks = startingBlocks(base);
      expect(blocks.length).toBeGreaterThan(3);
      expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
      for (const block of blocks) expect(BLOCK_KINDS).toContain(block.kind);
      // Seeds survive the storage parse unchanged.
      expect(parseLayout({ id: "x1", name: "n", base, blocks })?.blocks).toEqual(blocks);
    }
  });
  it("Basic has the Basic content and hides machines and checklist; JNR shows machines and the part checklist with the six standard items", () => {
    const basic = basicBlocks();
    expect(basic.find((b) => b.kind === "header")?.label).toBe("JOB SHEET");
    expect(basic.find((b) => b.kind === "machines")?.visible).toBe(false);
    expect(basic.find((b) => b.kind === "materialTrace")?.traceableOnly).toBe(true);
    const jnr = jnrBlocks();
    expect(jnr.find((b) => b.kind === "machines")?.visible).toBe(true);
    expect(jnr.find((b) => b.kind === "checklist")?.items?.map((i) => i.key)).toEqual(["sizes_checked", "threads_check", "parts_deburred", "parts_marked", "parts_clean", "parts_counted"]);
    expect(jnr.find((b) => b.kind === "materialTrace")?.traceableOnly).toBe(false);
  });
  it("blank is the header plus the required blocks only", () => {
    expect(blankBlocks().map((b) => b.kind)).toEqual(["header", "materialTrace", "internalSignOff", "customerSignOff", "inspection"]);
  });
  it("a new layout gets the given name (trimmed, limited) or a default, and records what it started from", () => {
    expect(newLayout("jnr", "  Mine  ", fixedId("a1")).name).toBe("Mine");
    expect(newLayout("blank", "   ", fixedId("a1")).name).toBe("My worksheet");
    expect(newLayout("jnr", "x".repeat(200), fixedId("a1")).name).toHaveLength(40);
    expect(newLayout("jnr", "n", fixedId("a1")).base).toBe("jnr");
  });
});

describe("editing", () => {
  it("adds, hides, reorders, renames and removes blocks", () => {
    let l = layout("blank");
    l = addBlock(l, "description");
    expect(l.blocks.at(-1)?.kind).toBe("description");
    l = moveBlock(l, "description", -1);
    expect(l.blocks.map((b) => b.kind).slice(-2)).toEqual(["description", "inspection"]);
    expect(moveBlock(l, l.blocks[0].id, -1)).toBe(l);
    l = updateBlock(l, "description", { label: "What to make", visible: false });
    expect(blockHeading(l.blocks.find((b) => b.kind === "description")!)).toBe("What to make");
    l = removeBlock(l, "description");
    expect(l.blocks.some((b) => b.kind === "description")).toBe(false);
  });
  it("a single-use block added again is shown rather than duplicated; custom blocks can repeat with their own ids", () => {
    let l = layout("basic");
    l = updateBlock(l, "machines", { visible: false });
    l = addBlock(l, "machines");
    expect(l.blocks.filter((b) => b.kind === "machines")).toHaveLength(1);
    expect(l.blocks.find((b) => b.kind === "machines")?.visible).toBe(true);
    let n = 0;
    l = addBlock(addBlock(l, "customTick", () => `abc${++n}def`), "customTick", () => `abc${++n}def`);
    const ticks = l.blocks.filter((b) => b.kind === "customTick");
    expect(ticks).toHaveLength(2);
    expect(new Set(ticks.map((t) => t.id)).size).toBe(2);
  });
  it("renaming never changes a block's id or kind (so per-job values keep matching)", () => {
    const l = updateBlock(addBlock(layout("blank"), "customText", fixedId("zzzzzz")), "customText-zzzzzz", { label: "Batch", id: "hacked", kind: "header" } as never);
    const block = l.blocks.find((b) => b.id === "customText-zzzzzz");
    expect(block?.kind).toBe("customText");
    expect(block?.label).toBe("Batch");
  });
  it("renamed field labels change the label only", () => {
    const block = updateBlock(layout("basic"), "jobDetails", { fieldLabels: { customer: "Client" } }).blocks.find((b) => b.kind === "jobDetails")!;
    const fields = BLOCK_FIELDS.jobDetails!;
    expect(fieldLabel(block, fields[0])).toBe("Client");
    expect(fieldLabel(block, fields[1])).toBe(fields[1].label);
  });
});

describe("what storage may hold", () => {
  it("keeps only known kinds, strips markup and control characters, limits lengths and drops duplicates", () => {
    const parsed = parseLayout({
      id: "ok_1", name: "<b>Name</b>\u0000", base: "weird",
      blocks: [
        { id: "header", kind: "header", label: "<script>alert(1)</script>Title", visible: true },
        { id: "evil", kind: "scriptBlock", label: "x" },
        { id: "header", kind: "header", label: "dup id" },
        { id: "header2", kind: "header", label: "second header" },
        { id: "ft", kind: "freeText", label: "Note", text: "t".repeat(5000) },
        { id: "bad id!", kind: "description" },
        { id: "ck", kind: "checklist", items: [{ key: "sizes_checked", label: "Sizes" }, { key: "sizes_checked", label: "dup" }, { key: "bad key!", label: "x" }, { key: "k2", label: "" }, ...Array.from({ length: 40 }, (_, i) => ({ key: `i${i}`, label: `Item ${i}` }))] },
        "nonsense", null,
      ],
    })!;
    expect(parsed.name).toBe("bName/b");
    expect(parsed.base).toBe("blank");
    expect(parsed.blocks.map((b) => b.id)).toEqual(["header", "ft", "ck"]);
    expect(parsed.blocks[0].label).toBe("scriptalert(1)/scriptTitle");
    expect(parsed.blocks[0].label).not.toMatch(/[<>]/);
    expect(parsed.blocks[1].text).toHaveLength(1000);
    expect(parsed.blocks[2].items).toHaveLength(20);
    expect(parsed.blocks[2].items?.[0]).toEqual({ key: "sizes_checked", label: "Sizes" });
  });
  it("rejects a layout without a valid id and tolerates garbage state", () => {
    expect(parseLayout({ name: "x", blocks: [] })).toBeNull();
    expect(parseLayout({ id: "bad id", blocks: [] })).toBeNull();
    for (const bad of [null, undefined, 5, "x", [], { layouts: "no" }]) expect(parseWorksheetBuilder(bad)).toEqual({ layouts: [], activeId: null });
  });
  it("caps visible layouts at 10, keeps archived ones, and ignores an active id that is missing or archived", () => {
    const many = Array.from({ length: 14 }, (_, i) => layout("blank", `l${i}`));
    expect(liveLayouts(parseWorksheetBuilder({ layouts: many, activeId: "l3" }))).toHaveLength(10);
    const archived = parseWorksheetBuilder({ layouts: [{ ...layout("basic", "a1"), archived: true }, layout("basic", "a2")], activeId: "a1" });
    expect(archived.layouts).toHaveLength(2);
    expect(archived.activeId).toBeNull();
    expect(parseWorksheetBuilder({ layouts: [layout("basic", "a2")], activeId: "nope" }).activeId).toBeNull();
    expect(parseWorksheetBuilder({ layouts: [layout("basic", "a2")], activeId: "a2" }).activeId).toBe("a2");
  });
});

describe("blocks that cannot be removed", () => {
  it("internal sign-off, traceability and inspection are always locked; customer sign-off only while its switch is on", () => {
    expect([...lockedKinds({ customerSignOff: false })].sort()).toEqual(["inspection", "internalSignOff", "materialTrace"]);
    expect([...lockedKinds({ customerSignOff: true })].sort()).toEqual(["customerSignOff", "inspection", "internalSignOff", "materialTrace"]);
    expect(isLockedBlock({ kind: "customerSignOff" }, { customerSignOff: false })).toBe(false);
    expect(isLockedBlock({ kind: "customerSignOff" }, { customerSignOff: true })).toBe(true);
  });
  it("a layout that hides or lacks a locked block is refused with plain words, and repaired when printed", () => {
    let l = layout("basic");
    l = updateBlock(updateBlock(l, "inspection", { visible: false }), "internalSignOff", { visible: false });
    l = removeBlock(l, "materialTrace");
    const problems = lockedBlockProblems(l, { customerSignOff: false });
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/Inspection block cannot be hidden/), expect.stringMatching(/Internal sign-off block cannot be hidden/), expect.stringMatching(/Material cert and heat \/ cast block cannot be removed/)]));
    const fixed = withRequiredBlocks(l, { customerSignOff: false });
    expect(lockedBlockProblems(fixed, { customerSignOff: false })).toEqual([]);
    expect(fixed.blocks.find((b) => b.kind === "materialTrace")?.visible).toBe(true);
  });
  it("customer sign-off is required only when the company switch is on", () => {
    const blank = layout("blank");
    expect(blank.blocks.find((b) => b.kind === "customerSignOff")?.visible).toBe(false);
    expect(lockedBlockProblems(blank, { customerSignOff: false })).toEqual([]);
    expect(lockedBlockProblems(blank, { customerSignOff: true })).toHaveLength(1);
    expect(withRequiredBlocks(blank, { customerSignOff: true }).blocks.find((b) => b.kind === "customerSignOff")?.visible).toBe(true);
  });
  it("when the requirements cannot be read the strictest applies", () => {
    expect(STRICT_REQUIREMENTS.customerSignOff).toBe(true);
    expect(BUILDER_OFF.requirements).toEqual(STRICT_REQUIREMENTS);
  });
  it("a locked block can still be moved and renamed", () => {
    const l = updateBlock(moveBlock(layout("basic"), "inspection", -1), "inspection", { label: "Final check" });
    expect(lockedBlockProblems(l, { customerSignOff: true })).toEqual([]);
  });
});

describe("saving and revisions", () => {
  const t = (iso: string) => new Date(iso);
  it("upsert keeps every other layout; an edit keeps the version it replaces", () => {
    const a = layout("basic", "a1");
    const b = layout("jnr", "b1");
    let state = upsertLayout(upsertLayout({ layouts: [], activeId: null }, a, t("2026-02-01T10:00:00.000Z")), b, t("2026-02-01T11:00:00.000Z"));
    expect(state.layouts.map((l) => l.id)).toEqual(["a1", "b1"]);
    const edited = updateBlock(a, "description", { label: "Job brief" });
    state = upsertLayout(state, edited, t("2026-03-01T09:00:00.000Z"));
    expect(state.layouts.find((l) => l.id === "b1")).toEqual(upsertLayout({ layouts: [], activeId: null }, b, t("2026-02-01T11:00:00.000Z")).layouts[0]);
    const saved = state.layouts.find((l) => l.id === "a1")!;
    expect(saved.history).toHaveLength(1);
    expect(saved.history?.[0].replacedAt).toBe("2026-03-01T09:00:00.000Z");
    expect(saved.history?.[0].blocks.find((x) => x.kind === "description")?.label).toBe("Description");
  });
  it("saving with no change adds no revision; history is capped", () => {
    const a = commitLayoutEdit(undefined, layout("basic", "a1"), t("2026-02-01T10:00:00.000Z"));
    expect(commitLayoutEdit(a, a, t("2026-02-02T10:00:00.000Z")).history).toEqual([]);
    let current = a;
    for (let i = 0; i < MAX_HISTORY + 5; i++) current = commitLayoutEdit(current, updateBlock(current, "description", { label: `v${i}` }), t(`2026-03-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`));
    expect(current.history).toHaveLength(MAX_HISTORY);
  });
  it("a worksheet signed off earlier reprints on the layout as it stood when signed; unsigned jobs and the preview use the current one", () => {
    const a = commitLayoutEdit(undefined, layout("basic", "a1"), t("2026-01-01T00:00:00.000Z"));
    const v2 = commitLayoutEdit(a, updateBlock(a, "description", { label: "Brief v2" }), t("2026-02-01T00:00:00.000Z"));
    const v3 = commitLayoutEdit(v2, updateBlock(v2, "description", { label: "Brief v3" }), t("2026-03-01T00:00:00.000Z"));
    const label = (l: WorksheetLayout) => l.blocks.find((b) => b.kind === "description")?.label;
    expect(label(layoutAsOf(v3, "2026-01-15T00:00:00.000Z"))).toBe("Description");
    expect(label(layoutAsOf(v3, "2026-02-15T00:00:00.000Z"))).toBe("Brief v2");
    expect(label(layoutAsOf(v3, "2026-03-15T00:00:00.000Z"))).toBe("Brief v3");
    expect(label(layoutAsOf(v3, null))).toBe("Brief v3");
    expect(label(layoutAsOf(v3, "not a date"))).toBe("Brief v3");
  });
  it("revisions survive the storage parse", () => {
    const a = commitLayoutEdit(undefined, layout("basic", "a1"), t("2026-01-01T00:00:00.000Z"));
    const v2 = commitLayoutEdit(a, updateBlock(a, "description", { label: "Brief v2" }), t("2026-02-01T00:00:00.000Z"));
    expect(parseWorksheetBuilder({ layouts: [v2], activeId: "a1" }).layouts[0]).toEqual(v2);
  });
  it("delete archives (the layout is kept, no longer offered, and no longer the company's)", () => {
    const state = setActiveLayout({ layouts: [layout("basic", "a1"), layout("jnr", "b1")], activeId: null }, "a1");
    expect(state.activeId).toBe("a1");
    const after = archiveLayout(state, "a1");
    expect(after.activeId).toBeNull();
    expect(after.layouts).toHaveLength(2);
    expect(liveLayouts(after).map((l) => l.id)).toEqual(["b1"]);
    expect(setActiveLayout(after, "a1").activeId).toBeNull();
    expect(setActiveLayout(state, null).activeId).toBeNull();
  });
});

describe("which sheet prints", () => {
  const company = { layout: "basic" as const, saved: "basic" as const, source: "saved" as const };
  const state = { layouts: [layout("jnr", "a1"), { ...layout("basic", "b1"), archived: true }], activeId: "a1" };
  const on = { enabled: true, state };
  it("builder off, still loading or unreadable: exactly the company's Basic or JNR choice, whatever the override", () => {
    for (const builder of [null, { enabled: false, state }, BUILDER_OFF]) {
      expect(resolvePrintChoice({ company, override: null, builder })).toEqual({ kind: "legacy", layout: "basic" });
      expect(resolvePrintChoice({ company, override: "jnr", builder })).toEqual({ kind: "legacy", layout: "jnr" });
      expect(resolvePrintChoice({ company, override: customChoice("a1"), builder })).toEqual({ kind: "legacy", layout: "basic" });
    }
    expect(resolvePrintChoice({ company: null, override: null, builder: null })).toBeNull();
  });
  it("builder on: the company's own layout by default, the person's pick on the print page, and Basic or JNR sheet always available", () => {
    expect(resolvePrintChoice({ company, override: null, builder: on })).toMatchObject({ kind: "custom", layout: { id: "a1" } });
    expect(resolvePrintChoice({ company, override: "basic", builder: on })).toEqual({ kind: "legacy", layout: "basic" });
    expect(resolvePrintChoice({ company, override: "jnr", builder: on })).toEqual({ kind: "legacy", layout: "jnr" });
    expect(resolvePrintChoice({ company, override: customChoice("a1"), builder: on })).toMatchObject({ kind: "custom" });
  });
  it("a layout that is deleted or missing is ignored, never an error", () => {
    expect(resolvePrintChoice({ company, override: customChoice("b1"), builder: on })).toEqual({ kind: "legacy", layout: "basic" });
    expect(resolvePrintChoice({ company, override: customChoice("gone"), builder: on })).toEqual({ kind: "legacy", layout: "basic" });
    expect(resolvePrintChoice({ company, override: null, builder: { enabled: true, state: { ...state, activeId: null } } })).toEqual({ kind: "legacy", layout: "basic" });
  });
  it("the picker value is only ever a known layout or a custom id", () => {
    expect([parsePrintOverride("basic"), parsePrintOverride("jnr"), parsePrintOverride("custom:x1"), parsePrintOverride("other"), parsePrintOverride(""), parsePrintOverride(3)]).toEqual(["basic", "jnr", "custom:x1", null, null, null]);
    expect(customChoiceId("custom:abc")).toBe("abc");
    expect(customChoiceId("basic")).toBeNull();
  });
  it("the workshop pack, which is a table, prints the base of a custom layout (blank counts as Basic)", () => {
    expect(packLayoutOf({ kind: "custom", layout: layout("jnr") })).toBe("jnr");
    expect(packLayoutOf({ kind: "custom", layout: layout("blank") })).toBe("basic");
    expect(packLayoutOf({ kind: "legacy", layout: "jnr" })).toBe("jnr");
    expect(packFallback({ base: "basic" })).toBe("basic");
  });
});

describe("Company details keeps the layouts", () => {
  it("saving Company details leaves the stored builder state alone, and still keeps the stored print layout", () => {
    const builder = { layouts: [layout("basic", "a1")], activeId: "a1" };
    const out = withStoredPrintLayout({ name: "Acme" } as { name: string; printLayout?: "basic" | "jnr" }, { printLayout: "jnr", worksheetBuilder: builder, junk: 1 }) as Record<string, unknown>;
    expect(out).toEqual({ name: "Acme", printLayout: "jnr", worksheetBuilder: builder });
  });
  it("with no builder state stored the result is exactly what it was before module K", () => {
    expect(withStoredPrintLayout({ name: "Acme" } as { name: string; printLayout?: "basic" | "jnr" }, { printLayout: "basic" })).toEqual({ name: "Acme", printLayout: "basic" });
    expect(withStoredPrintLayout({ name: "Acme" } as { name: string; printLayout?: "basic" | "jnr" }, null)).toEqual({ name: "Acme" });
  });
});

describe("brand colour", () => {
  it("uses a valid readable colour, black for none, invalid or too light", () => {
    expect(brandInk("#1E3472")).toBe("#1e3472");
    expect(brandInk("")).toBe("#000000");
    expect(brandInk(undefined)).toBe("#000000");
    expect(brandInk("red")).toBe("#000000");
    expect(brandInk("#fff")).toBe("#000000");
    expect(brandInk("#ffffff")).toBe("#000000");
    expect(brandInk("#ffee00")).toBe("#000000");
    expect(brandInk("url(javascript:1)")).toBe("#000000");
  });
});

describe("per-job custom values", () => {
  it("parse only valid keys and types, limit text, and tolerate garbage", () => {
    expect(parseCustomValues(null)).toBe(EMPTY_CUSTOM_VALUES);
    expect(parseCustomValues({})).toEqual({ ticks: {}, texts: {} });
    const parsed = parseCustomValues({ v: 1, ticks: { a: true, "bad key": true, b: "yes", c: false }, texts: { t: "x".repeat(900), "bad!": "no", n: 4 } });
    expect(parsed.ticks).toEqual({ a: true, c: false });
    expect(Object.keys(parsed.texts)).toEqual(["t"]);
    expect(parsed.texts.t).toHaveLength(500);
  });
  it("store only what was filled in, and nothing for a job nobody filled in", () => {
    expect(toStoredCustomValues(EMPTY_CUSTOM_VALUES)).toEqual({});
    expect(toStoredCustomValues({ ticks: { a: true, b: false }, texts: { t: "  ", u: "hello" } })).toEqual({ v: 1, ticks: { a: true }, texts: { u: "hello" } });
  });
  it("cannot be edited once signed off, or by someone who cannot edit the worksheet", () => {
    expect(canEditCustomValues({ canEditWorksheet: true, signedOff: false })).toBe(true);
    expect(canEditCustomValues({ canEditWorksheet: true, signedOff: true })).toBe(false);
    expect(canEditCustomValues({ canEditWorksheet: false, signedOff: false })).toBe(false);
  });
});

describe("palette", () => {
  it("has every spec block, each with a title, and only the three custom ones repeat", () => {
    expect(BLOCK_KINDS).toHaveLength(15);
    expect(BLOCK_KINDS.filter((k) => PALETTE[k].repeatable)).toEqual(["freeText", "customTick", "customText"]);
  });
});
