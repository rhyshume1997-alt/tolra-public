/**
 * Module K (worksheet builder), golden check: the Basic and JNR sheet print exactly as they did before the builder existed.
 * The snapshot file next to this test was written from main BEFORE any builder code was added (the layout picker, the print pages
 * and lib/print-layout were then changed), so a pass proves the HTML of Basic and JNR (single sheet and workshop pack), reached
 * through the same picker entry points the print pages use, is byte-for-byte what printed before. Never update this snapshot to
 * get a change through: a change to Basic or JNR output is its own task with Rhys's approval.
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

import { WorksheetInLayout, WorksheetPackInLayout } from "@/components/print-layout-picker";
import { FULL_SHEET, LEGACY_SHEET, PACK, PRINT_COMPANY, SIGN_OFFS, STALE_SHEET } from "@/tests/support/print-fixtures";

beforeEach(() => {
  h.customerOn = true;
  h.signOffs = SIGN_OFFS;
  h.company = PRINT_COMPANY;
});

const single = (layout: "basic" | "jnr", worksheet: typeof FULL_SHEET, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(WorksheetInLayout, { layout, worksheet, jobNo: worksheet.job_no, ...extra }));

describe("golden: Basic and JNR sheet output is unchanged", () => {
  it("Basic single sheet: signed, co-signed, customer sign-off, traceable", () => {
    expect(single("basic", FULL_SHEET, { drawings: ["DWG-42.pdf (Rev B)"], customerPos: ["PO-77.pdf"], traceable: true })).toMatchSnapshot();
  });
  it("Basic single sheet: stale sign-off, no company, customer sign-off off", () => {
    h.company = null;
    h.customerOn = false;
    expect(single("basic", STALE_SHEET)).toMatchSnapshot();
  });
  it("Basic single sheet: legacy typed box, sign-offs still loading", () => {
    h.signOffs = null;
    expect(single("basic", LEGACY_SHEET)).toMatchSnapshot();
  });
  it("Basic workshop pack", () => {
    expect(renderToStaticMarkup(createElement(WorksheetPackInLayout, { layout: "basic", sheets: PACK }))).toMatchSnapshot();
  });
  it("JNR single sheet: signed, co-signed, customer sign-off", () => {
    expect(single("jnr", FULL_SHEET, { drawings: ["DWG-42.pdf (Rev B)"], customerPos: ["PO-77.pdf"] })).toMatchSnapshot();
  });
  it("JNR single sheet: stale sign-off, no company, customer sign-off off", () => {
    h.company = null;
    h.customerOn = false;
    expect(single("jnr", STALE_SHEET)).toMatchSnapshot();
  });
  it("JNR single sheet: legacy typed box, sign-offs still loading", () => {
    h.signOffs = null;
    expect(single("jnr", LEGACY_SHEET)).toMatchSnapshot();
  });
  it("JNR workshop pack", () => {
    expect(renderToStaticMarkup(createElement(WorksheetPackInLayout, { layout: "jnr", sheets: PACK }))).toMatchSnapshot();
  });
});
