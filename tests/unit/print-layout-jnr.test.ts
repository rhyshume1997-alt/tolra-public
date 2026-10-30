/**
 * P1 print pack, JNR layout unchanged (D30-4): the JNR single worksheet and the JNR workshop pack rendered (react-dom/server) for
 * fixed fixture jobs. The snapshot was written from main (1eebc8f) BEFORE the Basic layout and the layout choice were added, so a
 * pass proves the JNR sheet's HTML is byte-for-byte what JNR print today.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Dates print in the machine's time zone (formatDateTimeGB): pinned so the snapshot is the same on any machine.
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

import { JobWorksheetPackPrint } from "@/components/job-worksheet-pack-print";
import { JobWorksheetPrint } from "@/components/job-worksheet-print";
import { FULL_SHEET, LEGACY_SHEET, PACK, PRINT_COMPANY, SIGN_OFFS, STALE_SHEET } from "@/tests/support/print-fixtures";

beforeEach(() => {
  h.customerOn = true;
  h.signOffs = SIGN_OFFS;
  h.company = PRINT_COMPANY;
});

describe("JNR layout (unchanged from main)", () => {
  it("single worksheet: signed job with co-signature and customer sign-off", () => {
    expect(renderToStaticMarkup(createElement(JobWorksheetPrint, { worksheet: FULL_SHEET, jobNo: FULL_SHEET.job_no, drawings: ["DWG-42.pdf (Rev B)"], customerPos: ["PO-77.pdf"] }))).toMatchSnapshot();
  });
  it("single worksheet: stale sign-off, no company profile, customer sign-off off", () => {
    h.company = null;
    h.customerOn = false;
    expect(renderToStaticMarkup(createElement(JobWorksheetPrint, { worksheet: STALE_SHEET, jobNo: STALE_SHEET.job_no }))).toMatchSnapshot();
  });
  it("single worksheet: legacy typed box, sign-offs still loading", () => {
    h.signOffs = null;
    expect(renderToStaticMarkup(createElement(JobWorksheetPrint, { worksheet: LEGACY_SHEET, jobNo: LEGACY_SHEET.job_no }))).toMatchSnapshot();
  });
  it("workshop pack: three jobs", () => {
    expect(renderToStaticMarkup(createElement(JobWorksheetPackPrint, { sheets: PACK }))).toMatchSnapshot();
  });
});
