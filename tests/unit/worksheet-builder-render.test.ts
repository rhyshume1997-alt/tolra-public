/**
 * Module K (worksheet builder): what a company's own layout prints (react-dom/server). Locked blocks always print, a recorded customer
 * sign-off always prints, sign-offs print exactly what is recorded, custom fields come from the job's own custom values and never from its
 * checklist, the company logo and brand colour are used, a worksheet signed off earlier reprints on the layout it was signed on, and the
 * picker lists custom layouts only when there are some (with none its markup is what it was before).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => { process.env.TZ = "UTC"; return { customerOn: true as boolean | null, signOffs: null as unknown, company: null as unknown }; });

vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => createElement("img", { src: props.src, alt: props.alt, className: props.className }) }));
vi.mock("@/components/signature-pad", () => ({ SignatureImage: ({ path, className }: { path: string; className?: string }) => createElement("img", { "data-signature": path, className }) }));
vi.mock("@/lib/company", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/company")>()), useCompanyProfile: () => ({ profile: h.company, loading: false }) }));
vi.mock("@/lib/job-signoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/job-signoff")>()),
  usePrintedSignOffs: () => h.signOffs,
  useCustomerSignOffSetting: () => h.customerOn,
}));

import { PrintLayoutPicker, WorksheetInLayout } from "@/components/print-layout-picker";
import { CustomWorksheetPrint, WorksheetSheet, printedBlocks, signedAtOf, type SheetData } from "@/components/worksheet-builder/custom-worksheet-sheet";
import { customFieldsOf } from "@/components/worksheet-builder/job-custom-fields";
import { type WorksheetLayout, addBlock, commitLayoutEdit, newLayout, removeBlock, updateBlock } from "@/lib/worksheet-builder/layouts";
import { SAMPLE_DRAWINGS, SAMPLE_WORKSHEET } from "@/lib/worksheet-builder/sample";
import { EMPTY_CUSTOM_VALUES } from "@/lib/worksheet-builder/custom-values";
import { FULL_SHEET, LEGACY_SHEET, PRINT_COMPANY, SIGN_OFFS, STALE_SHEET } from "@/tests/support/print-fixtures";

beforeEach(() => { h.customerOn = true; h.signOffs = SIGN_OFFS; h.company = PRINT_COMPANY; });

const fixed = (id: string) => () => id;
const mk = (base: "basic" | "jnr" | "blank" = "basic"): WorksheetLayout => newLayout(base, "Workshop sheet", fixed("lay1"));
const REQ = { customerSignOff: false };
const data = (over: Partial<SheetData> = {}): SheetData => ({ worksheet: FULL_SHEET, jobNo: FULL_SHEET.job_no, drawings: ["DWG-42.pdf (Rev B)"], customerPos: ["PO-77.pdf"], traceable: true, custom: EMPTY_CUSTOM_VALUES, inspection: null, ...over });
const render = (layout: WorksheetLayout, d: SheetData = data(), env: Partial<Parameters<typeof WorksheetSheet>[0]["env"]> = {}) =>
  renderToStaticMarkup(createElement(WorksheetSheet, { layout, data: d, env: { company: PRINT_COMPANY, signOff: SIGN_OFFS.get(d.worksheet.job_no) ?? null, customerOn: false, requirements: REQ, ...env } }));

describe("a custom layout prints its blocks", () => {
  it("started from Basic: the job's details, description, operations, traceability and sign-off boxes", () => {
    const html = render(mk("basic"));
    expect(html).toContain('data-print-layout="custom"');
    for (const text of ["JOB SHEET", "J-0101", "Bracket Co", "PO-77", "01/10/2026", "15/10/2026", "Machine 20 brackets", "DWG-42.pdf (Rev B)", "PO-77.pdf", "MC-9", "H-123", "Operations and notes", "Checked by"]) expect(html).toContain(text);
    expect(html).not.toContain("Part checklist");
    expect(html).not.toContain("Haas VF-2");
  });
  it("started from JNR sheet: machines and times, the part checklist ticked from the job, and the JNR notice as free text", () => {
    const html = render(mk("jnr"));
    expect(html).toContain("Haas VF-2");
    expect(html).toContain("Prog: O1001");
    expect(html).toContain("4 hr");
    expect(html).toMatch(/Sizes Checked/);
    expect(html).toContain("ALL PARTS MUST BE CHECKED AND MARKED");
    expect((html.match(/✓/g) ?? []).length).toBe(2); // sizes_checked and parts_counted
  });
  it("renamed block and field labels are printed; the data read is unchanged", () => {
    let l = updateBlock(mk("basic"), "jobDetails", { label: "About the job", fieldLabels: { customer: "Client" } });
    l = updateBlock(l, "header", { label: "WORKSHOP TRAVELLER" });
    const html = render(l);
    expect(html).toContain("About the job");
    expect(html).toContain("WORKSHOP TRAVELLER");
    expect(html).toContain(">Client<");
    expect(html).toContain("Bracket Co");
  });
  it("hidden blocks do not print; blocks print in the saved order", () => {
    const l = updateBlock(mk("jnr"), "machines", { visible: false });
    expect(render(l)).not.toContain("Haas VF-2");
    const order = render(mk("basic"));
    expect(order.indexOf("Machine 20 brackets")).toBeLessThan(order.indexOf("Operations and notes"));
  });
  it("sample data previews without a job (no sign-off, nothing recorded)", () => {
    const html = render(mk("jnr"), data({ worksheet: SAMPLE_WORKSHEET, jobNo: "J-0000", drawings: SAMPLE_DRAWINGS, customerPos: [] }), { signOff: null, company: null });
    expect(html).toContain("Sample Customer Ltd");
    expect(html).toContain('data-signoff="loading"');
  });
});

describe("blocks that cannot be removed always print", () => {
  const stripped = (): WorksheetLayout => {
    let l = mk("basic");
    l = removeBlock(removeBlock(removeBlock(l, "internalSignOff"), "inspection"), "materialTrace");
    return removeBlock(l, "customerSignOff");
  };
  it("a layout saved without them still prints internal sign-off, traceability and inspection", () => {
    const html = render(stripped());
    expect(html).toContain('data-worksheet-block="internalSignOff"');
    expect(html).toContain('data-worksheet-block="inspection"');
    expect(html).toContain('data-traceability=""');
    expect(html).toContain("MC-9");
    expect(html).not.toContain('data-worksheet-block="customerSignOff"');
  });
  it("customer sign-off is added as soon as the company's switch is on (the layout may have been saved before)", () => {
    expect(render(stripped(), data(), { customerOn: true })).toContain('data-worksheet-block="customerSignOff"');
    expect(render(stripped(), data(), { requirements: { customerSignOff: true } })).toContain('data-customer-signoff-print="signed"');
  });
  it("a recorded customer sign-off prints even if the layout hides it and the switch is now off", () => {
    const hidden = updateBlock(mk("basic"), "customerSignOff", { visible: false });
    const html = render(hidden, data(), { customerOn: false });
    expect(html).toContain('data-customer-signoff-print="signed"');
    expect(html).toContain("Jane Smith");
    expect(render(hidden, data({ worksheet: STALE_SHEET, jobNo: STALE_SHEET.job_no }), { customerOn: false })).not.toContain('data-worksheet-block="customerSignOff"');
  });
  it("a traceable job always prints the numbers, even in a layout that prints them only on traceable jobs; a plain job omits the block", () => {
    const l = mk("basic");
    expect(render(l, data({ worksheet: STALE_SHEET, jobNo: STALE_SHEET.job_no, traceable: false }))).not.toContain('data-traceability=""');
    expect(render(l, data({ worksheet: STALE_SHEET, jobNo: STALE_SHEET.job_no, traceable: true }))).toContain('data-traceability=""');
    expect(render(l, data({ worksheet: FULL_SHEET, traceable: false }))).toContain("H-123");
  });
  it("printedBlocks keeps order and drops only hidden, non-required blocks", () => {
    const blocks = printedBlocks(updateBlock(mk("jnr"), "machines", { visible: false }), { requirements: REQ, customerOn: false, signOff: null });
    expect(blocks.some((b) => b.kind === "machines")).toBe(false);
    expect(blocks.some((b) => b.kind === "internalSignOff")).toBe(true);
  });
});

describe("sign-offs print exactly what is recorded", () => {
  it("signed with a co-signature: the same wording and markers as the Basic sheet", () => {
    const html = render(mk("basic"));
    expect(html).toContain('data-signoff="signed"');
    expect(html).toContain("RH Rita Hale (signed 16/10/2026, revision 3, sha256 aaaaaaaaaaaa)");
    expect(html).toContain('data-signoff-cosign="inspector"');
    expect(html).toContain("Inspector co-signature: IK Ian King");
  });
  it("a sign-off on an older revision is never printed as signed", () => {
    const html = render(mk("basic"), data({ worksheet: STALE_SHEET, jobNo: STALE_SHEET.job_no }));
    expect(html).toContain('data-signoff="unsigned"');
    expect(html).toContain("NOT SIGNED OFF (revision 1 was signed; edited since)");
  });
  it("the old typed box prints as the old record; loading prints blank", () => {
    h.signOffs = new Map([[LEGACY_SHEET.job_no, { status: "none" as const }]]);
    const legacy = render(mk("basic"), data({ worksheet: LEGACY_SHEET, jobNo: LEGACY_SHEET.job_no }), { signOff: { status: "none" } });
    expect(legacy).toContain('data-signoff="legacy"');
    expect(render(mk("basic"), data(), { signOff: null })).toContain('data-signoff="loading"');
  });
  it("the inspection block prints the recorded result, inspector and date, and never an e-mail address as the name", () => {
    const html = render(mk("basic"), data({ inspection: { result: "pass", inspector: "Ian King", inspectedAt: "2026-10-17T12:00:00Z" } }));
    expect(html).toContain('data-inspection="pass"');
    expect(html).toContain("Ian King");
    expect(html).toContain("17/10/2026");
    expect(html).toContain("Passed");
    expect(render(mk("basic"))).toContain('data-inspection="blank"');
  });
});

describe("custom fields are per job and never read the job's checklist", () => {
  it("custom tick boxes, custom text fields and extra checklist items print the job's custom values", () => {
    let l = addBlock(mk("jnr"), "customTick", fixed("tick111111"));
    l = updateBlock(l, "customTick-tick11", { label: "First off approved" });
    l = addBlock(l, "customText", fixed("text222222"));
    l = updateBlock(l, "customText-text22", { label: "Batch no." });
    l = updateBlock(l, "checklist", { items: [{ key: "sizes_checked", label: "Sizes" }, { key: "c-extra01", label: "Burrs checked" }] });
    const custom = { ticks: { "customTick-tick11": true, "c-extra01": true }, texts: { "customText-text22": "B-778" } };
    const html = render(l, data({ custom }));
    expect(html).toContain("First off approved");
    expect(html).toContain("Batch no.");
    expect(html).toContain("B-778");
    expect(html).toContain("Burrs checked");
    // sizes_checked is ticked by the job's own checklist (standard key), c-extra01 and the custom tick by custom values.
    expect((html.match(/✓/g) ?? []).length).toBe(3);
    const blank = render(l, data());
    expect(blank).not.toContain("B-778");
    expect((blank.match(/✓/g) ?? []).length).toBe(1);
  });
  it("a custom key can never tick a standard checklist item, and the job's checklist is never altered", () => {
    const ws = structuredClone(FULL_SHEET);
    const before = JSON.stringify(ws);
    render(updateBlock(mk("jnr"), "checklist", { items: [{ key: "threads_check", label: "Threads" }] }), data({ worksheet: ws, custom: { ticks: { threads_check: true }, texts: {} } }));
    expect(JSON.stringify(ws)).toBe(before);
    const html = render(updateBlock(mk("jnr"), "checklist", { items: [{ key: "threads_check", label: "Threads" }] }), data({ custom: { ticks: { threads_check: true }, texts: {} } }));
    expect((html.match(/✓/g) ?? []).length).toBe(0);
  });
  it("the job form lists only visible custom fields and non-standard checklist items", () => {
    let l = addBlock(mk("jnr"), "customTick", fixed("tick111111"));
    l = addBlock(l, "customText", fixed("text222222"));
    l = updateBlock(l, "checklist", { items: [{ key: "sizes_checked", label: "Sizes" }, { key: "c-extra01", label: "Burrs" }] });
    expect(customFieldsOf(l).map((f) => f.key)).toEqual(["c-extra01", "customTick-tick11", "customText-text22"]);
    expect(customFieldsOf(updateBlock(l, "customTick-tick11", { visible: false })).map((f) => f.key)).toEqual(["c-extra01", "customText-text22"]);
    expect(customFieldsOf(undefined)).toEqual([]);
    expect(customFieldsOf(mk("basic"))).toEqual([]);
  });
});

describe("logo and brand colour come from the company profile", () => {
  it("prints the logo and the brand colour on headings and rules", () => {
    const html = render(mk("basic"), data(), { company: { ...PRINT_COMPANY, brandPrimary: "#1E3472" } });
    expect(html).toContain('alt="Acme Fabrication logo"');
    expect(html).toContain("Acme Fabrication Ltd");
    expect(html).toContain("#1e3472");
  });
  it("with no brand colour, or an unreadable one, headings are black; with no company only the sheet prints", () => {
    expect([...render(mk("basic")).matchAll(/(?:border-)?color:(#[0-9a-f]{6})/gi)].every((m) => m[1] === "#000000")).toBe(true);
    expect(render(mk("basic"), data(), { company: { ...PRINT_COMPANY, brandPrimary: "#ffffff" } })).not.toMatch(/color:#ffffff/i);
    expect(render(mk("basic"), data(), { company: null })).toContain("J-0101");
  });
});

describe("a worksheet signed off earlier reprints on the layout it was signed on", () => {
  it("edits to the layout after the sign-off do not change that worksheet's reprint, but a later job gets the new layout", () => {
    const v1 = commitLayoutEdit(undefined, mk("basic"), new Date("2026-01-01T00:00:00.000Z"));
    const v2 = commitLayoutEdit(v1, updateBlock(v1, "description", { label: "Brief" }), new Date("2026-11-01T00:00:00.000Z"));
    // FULL_SHEET was signed on 2026-10-16, before the edit.
    expect(render(v2)).toContain(">Description<");
    expect(render(v2)).not.toContain(">Brief<");
    // STALE_SHEET (J-0102) was also signed on 2026-10-16 (on an earlier revision: still a worksheet that was signed).
    expect(render(v2, data({ worksheet: STALE_SHEET, jobNo: STALE_SHEET.job_no }))).toContain(">Description<");
    // A job nobody has signed uses the current layout.
    expect(render(v2, data({ worksheet: LEGACY_SHEET.job_no ? { ...LEGACY_SHEET, signed_off_by: "", signed_off_at: "" } : LEGACY_SHEET, jobNo: "J-0103" }), { signOff: { status: "none" } })).toContain(">Brief<");
  });
  it("signedAtOf reads the newest record, or the old typed box", () => {
    expect(signedAtOf(FULL_SHEET, SIGN_OFFS.get("J-0101")!)).toBe("2026-10-16T12:00:00Z");
    expect(signedAtOf(LEGACY_SHEET, { status: "none" })).toBe("2026-09-01T12:00:00Z");
    expect(signedAtOf(STALE_SHEET, { status: "none" })).toBeNull();
    expect(signedAtOf(STALE_SHEET, null)).toBeNull();
  });
});

describe("the print page entry points", () => {
  it("WorksheetInLayout prints a custom layout when given one and Basic or JNR sheet otherwise", () => {
    const custom = { layout: mk("basic"), requirements: REQ, jobId: "job-1" };
    const props = { worksheet: FULL_SHEET, jobNo: "J-0101" };
    expect(renderToStaticMarkup(createElement(WorksheetInLayout, { layout: "basic", custom, ...props }))).toContain('data-print-layout="custom"');
    expect(renderToStaticMarkup(createElement(WorksheetInLayout, { layout: "basic", ...props }))).toContain('data-print-layout="basic"');
    expect(renderToStaticMarkup(createElement(WorksheetInLayout, { layout: "jnr", ...props }))).not.toContain("data-print-layout");
    expect(renderToStaticMarkup(createElement(CustomWorksheetPrint, { layout: mk("jnr"), requirements: REQ, ...props }))).toContain('data-print-layout="custom"');
  });
  it("the picker lists custom layouts after Basic and JNR sheet, and nothing extra when there are none", () => {
    const company = { layout: "basic" as const, saved: null, source: "default" as const };
    const plain = renderToStaticMarkup(createElement(PrintLayoutPicker, { company, value: null, onChange: () => {} }));
    expect(plain).toBe(renderToStaticMarkup(createElement(PrintLayoutPicker, { company, value: null, onChange: () => {}, customLayouts: [] })));
    expect(plain).toContain("Company setting (Basic)");
    expect((plain.match(/<option/g) ?? []).length).toBe(3);
    const withCustom = renderToStaticMarkup(createElement(PrintLayoutPicker, { company, value: "custom:lay1", onChange: () => {}, customLayouts: [{ id: "lay1", name: "Workshop sheet" }], companyLabel: "Company setting (Workshop sheet)" }));
    expect(withCustom.indexOf("JNR sheet")).toBeLessThan(withCustom.indexOf("Workshop sheet</option>"));
    expect(withCustom).toContain('value="custom:lay1"');
    expect(withCustom).toContain("Company setting (Workshop sheet)");
  });
});
