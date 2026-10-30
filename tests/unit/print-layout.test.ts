/**
 * P1 print pack (D30-4): the per-company print layout. The JNR sheet for JNR's organisation, Basic for every other company, an
 * admin's saved choice over either, the JNR sheet when the setting can't be read; saving changes only company_profile.printLayout;
 * Company details keeps the choice; and the print pages render the layout chosen (company setting, or the per-print override).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };
const h = vi.hoisted(() => {
  process.env.TZ = "UTC";
  return {
    customerOn: true as boolean | null, signOffs: null as unknown, company: null as unknown,
    tables: {} as Record<string, Result | (() => Result)>,
    calls: [] as { table: string; op: string; args: unknown[] }[],
    pageLayout: null as unknown, seedState: undefined as unknown, seeded: true,
  };
});

/** A tiny stand-in for the supabase-js query builder: every chain on a table resolves to that table's result. */
function fakeClient() {
  const chain = (table: string): Record<string, unknown> => {
    const result = () => { const r = h.tables[table]; return typeof r === "function" ? r() : r ?? { data: null, error: null }; };
    const builder: Record<string, unknown> = {};
    for (const op of ["select", "eq", "in"]) builder[op] = (...args: unknown[]) => { h.calls.push({ table, op, args }); return builder; };
    builder.maybeSingle = async () => result();
    builder.upsert = async (...args: unknown[]) => { h.calls.push({ table, op: "upsert", args }); const r = h.tables[`${table}:upsert`]; return (typeof r === "function" ? r() : r) ?? { data: null, error: null }; };
    return builder;
  };
  return { from: (table: string) => chain(table) };
}

vi.mock("@/lib/supabase", () => ({ get supabase() { return fakeClient(); } }));
vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => createElement("img", { src: props.src, alt: props.alt, className: props.className }) }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "job-1" }), useSearchParams: () => new URLSearchParams("ids=job-1,job-2,job-3") }));
vi.mock("@/components/signature-pad", () => ({ SignatureImage: ({ path, className }: { path: string; className?: string }) => createElement("img", { "data-signature": path, className }) }));
vi.mock("@/lib/company", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/company")>()), useCompanyProfile: () => ({ profile: h.company, loading: false }) }));
vi.mock("@/lib/job-signoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/job-signoff")>()),
  usePrintedSignOffs: () => h.signOffs,
  useCustomerSignOffSetting: () => h.customerOn,
}));
vi.mock("@/lib/print-layout", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/print-layout")>()), useCompanyPrintLayout: () => h.pageLayout }));
// Server rendering runs no effects, so the page's first loaded-data state (null) is seeded with the fixture worksheet / pack.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) => {
    if (!h.seeded && initial === null) { h.seeded = true; return actual.useState(h.seedState); }
    return actual.useState(initial);
  }) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

import { BasicWorksheetPackPrint, BasicWorksheetPrint } from "@/components/job-worksheet-basic-print";
import { JobWorksheetPackPrint } from "@/components/job-worksheet-pack-print";
import { JobWorksheetPrint } from "@/components/job-worksheet-print";
import { WorksheetInLayout, WorksheetPackInLayout } from "@/components/print-layout-picker";
import { printLayoutStatus } from "@/components/print-layout-settings-card";
import { parseCompanyProfile, saveCompanyProfile } from "@/lib/company";
import { type CompanyPrintLayout, type PrintLayout, JNR_ORG_SLUG, chosenPrintLayout, defaultPrintLayout, loadCompanyPrintLayout, resolvePrintLayout, saveCompanyPrintLayout, withStoredPrintLayout } from "@/lib/print-layout";
import JobSheetPrintPage from "@/app/(dashboard)/jobs/[id]/print/page";
import WorkshopPackPage from "@/app/(dashboard)/jobs/print/page";
import { FULL_SHEET, LEGACY_SHEET, PACK, PRINT_COMPANY, SIGN_OFFS, STALE_SHEET } from "@/tests/support/print-fixtures";

beforeEach(() => {
  h.customerOn = true;
  h.signOffs = SIGN_OFFS;
  h.company = PRINT_COMPANY;
  h.tables = {};
  h.calls = [];
  h.pageLayout = null;
  h.seeded = true;
});

const JNR_WORDING = [/WORKSHEET/, /Material Cert/i, /Heat/i, /Machine/i, /Program/i, /Part Checklist/i, /Black Ink/i, /EXCESS MATERIAL/, /Dimension Report/i, /Quote #/, /Overrun/i, /Comments for Improvement/i, /JNR/];

describe("the company's layout", () => {
  it("defaults to the JNR sheet for JNR's organisation and to Basic for every other company", () => {
    expect(defaultPrintLayout(JNR_ORG_SLUG)).toBe("jnr");
    expect(defaultPrintLayout("marpet")).toBe("basic");
    expect(defaultPrintLayout("acme-fabrication")).toBe("basic");
    expect(defaultPrintLayout("jnr-engineering-2")).toBe("basic");
  });

  it("a saved choice wins over the default either way; anything else stored is ignored", () => {
    expect(resolvePrintLayout({ stored: "basic", slug: JNR_ORG_SLUG })).toEqual({ layout: "basic", saved: "basic", source: "saved" });
    expect(resolvePrintLayout({ stored: "jnr", slug: "marpet" })).toEqual({ layout: "jnr", saved: "jnr", source: "saved" });
    expect(resolvePrintLayout({ stored: "fancy", slug: "marpet" })).toEqual({ layout: "basic", saved: null, source: "default" });
    expect(resolvePrintLayout({ stored: undefined, slug: JNR_ORG_SLUG })).toEqual({ layout: "jnr", saved: null, source: "default" });
  });

  it("falls back to the JNR sheet (what printed before) when the setting can't be read", () => {
    expect(resolvePrintLayout(null)).toEqual({ layout: "jnr", saved: null, source: "fallback" });
    expect(resolvePrintLayout({ stored: null, slug: null })).toEqual({ layout: "jnr", saved: null, source: "fallback" });
  });

  it("the per-print override wins over the company's layout", () => {
    const basic: CompanyPrintLayout = { layout: "basic", saved: null, source: "default" };
    expect(chosenPrintLayout(basic, null)).toBe("basic");
    expect(chosenPrintLayout(basic, "jnr")).toBe("jnr");
    expect(chosenPrintLayout({ layout: "jnr", saved: "jnr", source: "saved" }, "basic")).toBe("basic");
    expect(chosenPrintLayout(null, null)).toBeNull();
  });

  it("Settings says where the layout came from", () => {
    expect(printLayoutStatus({ layout: "basic", saved: null, source: "default" })).toMatch(/Not chosen yet.*Basic.*default/);
    expect(printLayoutStatus({ layout: "jnr", saved: "jnr", source: "saved" })).toBe("Your company prints the JNR sheet layout.");
    expect(printLayoutStatus({ layout: "jnr", saved: null, source: "fallback" })).toMatch(/couldn't be read/);
  });
});

describe("reading the setting", () => {
  it("a saved choice is read from company_profile.printLayout", async () => {
    h.tables.organization_settings = { data: { organization_id: "org-m", company_profile: { name: "Marpet", printLayout: "jnr" } }, error: null };
    h.tables.organizations = { data: { slug: "marpet" }, error: null };
    expect(await loadCompanyPrintLayout()).toEqual({ layout: "jnr", saved: "jnr", source: "saved" });
  });

  it("never chosen: JNR's organisation gets the JNR sheet, Marpet gets Basic (its own row, by id)", async () => {
    h.tables.organization_settings = { data: { organization_id: "org-j", company_profile: { name: "JNR Engineering Ltd" } }, error: null };
    h.tables.organizations = { data: { slug: JNR_ORG_SLUG }, error: null };
    expect(await loadCompanyPrintLayout()).toEqual({ layout: "jnr", saved: null, source: "default" });
    expect(h.calls).toContainEqual({ table: "organizations", op: "eq", args: ["id", "org-j"] });
    h.tables.organization_settings = { data: { organization_id: "org-m", company_profile: { name: "Marpet" } }, error: null };
    h.tables.organizations = { data: { slug: "marpet" }, error: null };
    expect(await loadCompanyPrintLayout()).toEqual({ layout: "basic", saved: null, source: "default" });
  });

  it("an unreadable setting or company prints the JNR sheet", async () => {
    h.tables.organization_settings = { data: null, error: { message: "network down" } };
    expect(await loadCompanyPrintLayout()).toEqual({ layout: "jnr", saved: null, source: "fallback" });
    h.tables.organization_settings = { data: { organization_id: "org-m", company_profile: {} }, error: null };
    h.tables.organizations = { data: null, error: { message: "permission denied" } };
    expect(await loadCompanyPrintLayout()).toEqual({ layout: "jnr", saved: null, source: "fallback" });
    h.tables.organization_settings = () => { throw new Error("offline"); };
    expect(await loadCompanyPrintLayout()).toEqual({ layout: "jnr", saved: null, source: "fallback" });
  });
});

describe("saving the setting", () => {
  it("writes back the profile with only printLayout changed", async () => {
    const profile = { name: "Marpet", documentName: "Marpet", addressLines: ["1 Road"], vatNumber: "GB1", bankDetails: { sortCode: "12-34-56" } };
    h.tables.organization_settings = { data: { company_profile: profile }, error: null };
    await saveCompanyPrintLayout("jnr", "org-m");
    const upsert = h.calls.find((call) => call.op === "upsert");
    expect(upsert?.args[0]).toMatchObject({ organization_id: "org-m", company_profile: { ...profile, printLayout: "jnr" } });
    expect(Object.keys((upsert?.args[0] as { company_profile: object }).company_profile).sort()).toEqual([...Object.keys(profile), "printLayout"].sort());
    expect(upsert?.args[1]).toEqual({ onConflict: "organization_id" });
    expect(h.calls).toContainEqual({ table: "organization_settings", op: "eq", args: ["organization_id", "org-m"] });
  });

  it("a refusal (not an admin) is passed on and an unknown layout is never written", async () => {
    h.tables.organization_settings = { data: { company_profile: {} }, error: null };
    h.tables["organization_settings:upsert"] = { data: null, error: { code: "P0001", message: "Only admins can change the company profile" } };
    await expect(saveCompanyPrintLayout("basic", "org-m")).rejects.toMatchObject({ message: "Only admins can change the company profile" });
    h.calls = [];
    await expect(saveCompanyPrintLayout("fancy" as never, "org-m")).rejects.toThrow("Unknown print layout.");
    expect(h.calls.find((call) => call.op === "upsert")).toBeUndefined();
  });

  it("a layout saved while Company details is still incomplete survives a later Company details save (P1-4)", async () => {
    // The row holds only the layout choice: the rest of the profile is not set up, so it parses to null.
    const incomplete = { name: "Marpet", printLayout: "jnr" };
    expect(parseCompanyProfile(incomplete)).toBeNull();
    h.tables.organization_settings = { data: { organization_id: "org-m", company_profile: incomplete }, error: null };
    const details = { ...PRINT_COMPANY, name: "Marpet", documentName: "Marpet Ltd", logoSrc: undefined, logoUrl: undefined };
    delete (details as { printLayout?: unknown }).printLayout;
    await saveCompanyProfile("org-m", details);
    const upsert = h.calls.find((call) => call.op === "upsert");
    expect(upsert?.args[0]).toMatchObject({ organization_id: "org-m", company_profile: { documentName: "Marpet Ltd", printLayout: "jnr" } });
    expect(h.calls).toContainEqual({ table: "organization_settings", op: "eq", args: ["organization_id", "org-m"] });
  });

  it("the stored choice wins over a stale one in the profile being saved; none stored and none given saves none", () => {
    expect(withStoredPrintLayout({ a: 1, printLayout: "jnr" as const }, { printLayout: "basic" })).toEqual({ a: 1, printLayout: "basic" });
    expect(withStoredPrintLayout({ a: 1, printLayout: "jnr" as const }, {})).toEqual({ a: 1, printLayout: "jnr" });
    const bare: { a: number; printLayout?: PrintLayout } = { a: 1 };
    expect(withStoredPrintLayout(bare, { printLayout: "fancy" })).toEqual({ a: 1 });
    expect(withStoredPrintLayout(bare, null)).toEqual({ a: 1 });
  });

  it("Company details keeps the choice: the profile carries a valid printLayout and drops anything else", () => {
    const base = { documentName: "Marpet", addressLines: ["1 Road"], vatNumber: "GB1" };
    expect(parseCompanyProfile({ ...base, printLayout: "jnr" })?.printLayout).toBe("jnr");
    expect(parseCompanyProfile({ ...base, printLayout: "basic" })?.printLayout).toBe("basic");
    expect(parseCompanyProfile({ ...base, printLayout: "fancy" })).not.toHaveProperty("printLayout");
    expect(parseCompanyProfile(base)).not.toHaveProperty("printLayout");
  });
});

describe("Basic layout", () => {
  const single = (ws = FULL_SHEET, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(BasicWorksheetPrint, { worksheet: ws, jobNo: ws.job_no, ...extra }));
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");

  it("single job sheet: snapshot", () => {
    expect(single(FULL_SHEET, { drawings: ["DWG-42.pdf (Rev B)"], customerPos: ["PO-77.pdf"] })).toMatchSnapshot();
  });

  it("workshop pack: snapshot", () => {
    expect(renderToStaticMarkup(createElement(BasicWorksheetPackPrint, { sheets: PACK }))).toMatchSnapshot();
  });

  it("prints the same job data, an operations and notes area and sign-off boxes, with no JNR fields or wording", () => {
    const html = single(FULL_SHEET, { drawings: ["DWG-42.pdf (Rev B)"] });
    const words = text(html);
    for (const value of ["Acme Fabrication Ltd", "JOB SHEET", "J-0101", "Bracket Co", "PO-77", "01/10/2026", "15/10/2026", "DWG-42", "20", "Machine 20 brackets", "Operations", "Notes", "Checked by", "Signed off", "Rita Hale", "Customer sign-off"]) expect(words).toContain(value);
    for (const pattern of JNR_WORDING.filter((p) => p.source !== "Machine")) expect(words).not.toMatch(pattern);
    // The JNR-only values never print on the Basic sheet.
    for (const value of ["MC-9", "H-123", "DR-5", "QUO-0101", "Haas VF-2", "O1001", "6082-T6", "MetalCo", "Tool broke", "Use a softer jaw"]) expect(words).not.toContain(value);
    const pack = text(renderToStaticMarkup(createElement(BasicWorksheetPackPrint, { sheets: PACK })));
    for (const pattern of JNR_WORDING.filter((p) => p.source !== "Machine")) expect(pack).not.toMatch(pattern); // "Machine 20 brackets" is the job's own description
    for (const value of ["JOB SHEETS", "J-0101", "J-0102", "J-0103", "Bracket Co", "Plate Ltd", "Shaft plc", "Operations / notes"]) expect(pack).toContain(value);
  });

  it("prints the recorded sign-off with the same wording and markers as the JNR sheet, and never claims one it couldn't read", () => {
    expect(single()).toMatch(/data-signoff="signed">RH Rita Hale \(signed 16\/10\/2026, revision 3, sha256 a{12}\)/);
    expect(single()).toContain('data-signoff-cosign="inspector">Inspector co-signature: IK Ian King (signed 16/10/2026)');
    expect(single()).toContain('data-customer-signoff-print="signed"');
    expect(single(STALE_SHEET)).toMatch(/data-signoff="unsigned"><strong>NOT SIGNED OFF \(revision 1 was signed; edited since\)/);
    h.signOffs = new Map([...SIGN_OFFS, ["J-0103", { status: "none" }]]);
    expect(single(LEGACY_SHEET)).toMatch(/data-signoff="legacy"><span[^>]*>Signed off \(earlier typed record\): Old Name, 01\/09\/2026, 12:00, no signature or hash/);
    h.signOffs = null;
    expect(single()).toContain('data-signoff="loading"');
    expect(single()).not.toContain('data-signoff="signed"');
    h.signOffs = new Map([["J-0101", { status: "none" }]]);
    h.customerOn = false;
    const none = single();
    expect(none).toContain('data-signoff="unsigned"><strong>Not signed off</strong>');
    expect(none).not.toContain("data-customer-signoff-print");
    h.customerOn = true;
    expect(single()).toContain('data-customer-signoff-print="blank"');
    h.signOffs = SIGN_OFFS;
    const pack = renderToStaticMarkup(createElement(BasicWorksheetPackPrint, { sheets: PACK }));
    expect(pack.match(/data-signoff="signed"/g)).toHaveLength(1);
    expect(pack).toMatch(/Signed 16\/10\/2026 \(rev 3, sha256 a{12}\)/);
    expect(pack).toMatch(/data-signoff="unsigned"><strong>NOT SIGNED OFF<span[^>]*>\(revision 1 was signed; edited since\)/);
    expect(pack.match(/data-signoff="legacy"/g)).toHaveLength(1);
  });

  it("prints no company placeholder text when company details are missing", () => {
    h.company = null;
    expect(text(single())).not.toMatch(/Company details not set/);
  });
});

describe("the print pages pick the layout", () => {
  function page(which: "single" | "pack", layout: CompanyPrintLayout | null) {
    h.pageLayout = layout;
    h.seeded = false;
    h.seedState = which === "single" ? FULL_SHEET : PACK;
    return renderToStaticMarkup(createElement(which === "single" ? JobSheetPrintPage : WorkshopPackPage));
  }
  const jnr = (html: string) => html.includes("(SINGLE PART) WORKSHEET") || html.includes("(MULTI PART) WORKSHEET");
  const basic = (html: string) => html.includes('data-print-layout="basic"');

  it("a company on the default prints its default: JNR's organisation the JNR sheet, Marpet the Basic sheet", async () => {
    for (const which of ["single", "pack"] as const) {
      h.tables.organization_settings = { data: { organization_id: "org-j", company_profile: {} }, error: null };
      h.tables.organizations = { data: { slug: JNR_ORG_SLUG }, error: null };
      const jnrHtml = page(which, await loadCompanyPrintLayout());
      expect(jnr(jnrHtml) && !basic(jnrHtml)).toBe(true);
      h.tables.organizations = { data: { slug: "marpet" }, error: null };
      const marpetHtml = page(which, await loadCompanyPrintLayout());
      expect(basic(marpetHtml) && !jnr(marpetHtml)).toBe(true);
    }
  });

  it("a saved choice prints that layout, the fallback prints the JNR sheet, and nothing prints until the layout is known", () => {
    expect(basic(page("single", { layout: "basic", saved: "basic", source: "saved" }))).toBe(true);
    expect(jnr(page("pack", { layout: "jnr", saved: null, source: "fallback" }))).toBe(true);
    const loading = page("single", null);
    expect(jnr(loading) || basic(loading)).toBe(false);
    expect(loading).toContain("Loading worksheet...");
  });

  it("the page offers the per-print override, naming the company's layout", () => {
    const html = page("pack", { layout: "basic", saved: null, source: "default" });
    expect(html).toContain('aria-label="Print layout"');
    expect(html).toMatch(/<option value="" selected="">Company setting \(Basic\)<\/option><option value="basic">Basic<\/option><option value="jnr">JNR sheet<\/option>/);
  });

  it("the override renders the other layout (the JNR sheet byte-for-byte as without the switch)", () => {
    const props = { worksheet: FULL_SHEET, jobNo: FULL_SHEET.job_no, drawings: ["DWG-42.pdf (Rev B)"], customerPos: ["PO-77.pdf"] };
    expect(basic(renderToStaticMarkup(createElement(WorksheetInLayout, { layout: "basic", ...props })))).toBe(true);
    expect(renderToStaticMarkup(createElement(WorksheetInLayout, { layout: "jnr", ...props }))).toBe(renderToStaticMarkup(createElement(JobWorksheetPrint, props)));
    expect(renderToStaticMarkup(createElement(WorksheetPackInLayout, { layout: "jnr", sheets: PACK }))).toBe(renderToStaticMarkup(createElement(JobWorksheetPackPrint, { sheets: PACK })));
    expect(jnr(renderToStaticMarkup(createElement(WorksheetPackInLayout, { layout: "jnr", sheets: PACK })))).toBe(true);
    expect(basic(renderToStaticMarkup(createElement(WorksheetPackInLayout, { layout: "basic", sheets: PACK })))).toBe(true);
  });
});
