// @vitest-environment jsdom
/**
 * BOUNDARY (Settings, treated as Module 1 for this preview ONLY: docs/MODULES.md assigns the page to no module, owner to confirm; PREVIEW ONLY). Inputs: the exports of
 * components/settings/preview/SettingsPreview.tsx, the REAL pure lib functions it uses (bank-details, company-form, org-settings, email schedules and templates, costing rates, print-layout)
 * and the SOURCE of app/(dashboard)/settings/page.tsx and the cards it composes (read only) for rules and wording that live inline there. Output: pass/fail. Pins the preview's
 * validation order, wording, off-by-default switches, card order and role gate to the real page, and checks by rendering that nothing reports success and that the preview imports no
 * auth, session, storage or network code.
 * Must not change: never loosen these to make a change pass; if a real rule or sentence changes, this test is the alarm. No network, no Supabase. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import SettingsPreview, {
  JOB_REPORT_ROWS, ISO_LABEL, SALES_ORDERS_NOTE, SEED_COMPANY, SEED_COSTING, SEED_HIDDEN, archiveProblem, canUseSettings, chaseProblem, companyProblem, displayCounts, editorText,
  emailProblem, exportProblem, logoProblem, printLayoutStatus, resetPlan, COMPANY_NAME, NOT_SAVED,
} from "@/components/settings/preview/SettingsPreview";
import { EMPTY_COMPANY } from "@/lib/company-form";
import { NAV_TOGGLES, screensByGroup } from "@/lib/org-settings";
import { resolvePrintLayout } from "@/lib/print-layout";
import { ratesProblem } from "@/lib/costing/app-rates";
import { templateProblem } from "@/lib/email/templates/store";
import { salesOrdersEnabled } from "@/lib/sales-orders-switch";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE = read("app/(dashboard)/settings/page.tsx");
const MIDDLEWARE = read("middleware.ts");
const SRC = read("components/settings/preview/SettingsPreview.tsx");
const CSS = read("components/settings/preview/SettingsPreview.module.css");
const ROUTE = read("app/(dashboard)/settings/preview/page.tsx");
const CARDS = [
  "components/jobs/jobs-reports-settings-card.tsx", "components/iso/iso-switch-card.tsx", "components/costing/costing-rates-card.tsx", "components/costing/costing-rates-editor.tsx",
  "components/ai-helper/settings-card.tsx", "components/email-schedules/settings-card.tsx", "components/chase/settings-card.tsx", "components/email/email-templates-card.tsx",
  "components/print-layout-settings-card.tsx", "components/time/time-settings-card.tsx", "components/time/site-network-card.tsx", "components/time/clock-in-lock-card.tsx",
].map(read).join("\n");
const REAL = `${PAGE}\n${CARDS}`;
/** The text of a JSX sentence as a person reads it (entities decoded). */
const plain = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const REAL_PLAIN = plain(REAL);
const SRC_PLAIN = plain(SRC);

describe("role gate", () => {
  it("is admin only, as the real page and middleware", () => {
    expect(PAGE).toContain('<RoleGate allowed={["admin"]}>');
    expect(MIDDLEWARE).toContain('["/settings", ["admin"]]');
    expect(canUseSettings("admin")).toBe(true);
    for (const r of ["office", "workshop", "viewer"] as const) expect(canUseSettings(r)).toBe(false);
  });
});

describe("real validation, same order and words as the page", () => {
  it("every message and its order come from the real save()", () => {
    const order = ["Enter the company name as it should appear on documents.", "Enter at least one address line.", "must look like #1e3472.", "Enter your VAT number, or switch off VAT registered.", "Enter a valid company email address."];
    let last = -1;
    for (const m of order) { const i = PAGE.indexOf(m); expect(i, m).toBeGreaterThan(last); last = i; expect(SRC).toContain(m); }
    expect(PAGE.indexOf("workingHoursFromForm(form)")).toBeGreaterThan(PAGE.indexOf("Enter a valid company email address."));
    expect(PAGE.indexOf("validateBankDetails(form.bank)")).toBeGreaterThan(PAGE.indexOf("workingHoursFromForm(form)"));
  });
  it("companyProblem walks the same order", () => {
    expect(companyProblem(SEED_COMPANY)).toBeNull();
    expect(companyProblem({ ...SEED_COMPANY, documentName: " ", addressLines: "" })?.message).toMatch(/company name/);
    expect(companyProblem({ ...SEED_COMPANY, addressLines: " \n " })?.message).toBe("Enter at least one address line.");
    expect(companyProblem({ ...SEED_COMPANY, brandAccent: "blue" })?.message).toBe("Accent colour must look like #1e3472.");
    expect(companyProblem({ ...SEED_COMPANY, vatNumber: "" })?.message).toMatch(/VAT number/);
    expect(companyProblem({ ...SEED_COMPANY, vatNumber: "", vatRegistered: false })).toBeNull();
    expect(companyProblem({ ...SEED_COMPANY, email: "x" })?.message).toBe("Enter a valid company email address.");
    expect(companyProblem({ ...SEED_COMPANY, workDays: [] })?.message).toBe("Tick at least one working day.");
    expect(companyProblem({ ...SEED_COMPANY, bank: { ...SEED_COMPANY.bank, sortCode: "12" } })?.message).toBe("The sort code needs 6 digits, like 12-34-56.");
    expect(companyProblem({ ...SEED_COMPANY, bank: { ...SEED_COMPANY.bank, accountNumber: "1" } })?.fieldId).toBe("bank-accountNumber");
    expect(companyProblem(EMPTY_COMPANY)?.message).toMatch(/company name/);
  });
  it("logo, archive, export, e-mail and chase rules match the page and cards", () => {
    for (const m of ["Upload a PNG or JPG image.", "The logo must be 1 MB or smaller.", "Save the company details first, then upload the logo.", "Enter a whole number of months from 1 to 120.", "Choose a start date and an end date after it.", "Enter a valid email address.", "Enter a whole number of days for each step."]) {
      expect(REAL, m).toContain(m); expect(SRC, m).toContain(m);
    }
    expect(PAGE).toContain("const LOGO_MAX_BYTES = 1024 * 1024;");
    expect(logoProblem({ type: "image/gif", size: 1 }, true)).toBe("Upload a PNG or JPG image.");
    expect(logoProblem({ type: "image/png", size: 1024 * 1024 + 1 }, true)).toBe("The logo must be 1 MB or smaller.");
    expect(logoProblem({ type: "image/jpeg", size: 10 }, false)).toMatch(/Save the company details first/);
    expect(logoProblem({ type: "image/jpeg", size: 1024 * 1024 }, true)).toBeNull();
    for (const [v, bad] of [["0", true], ["121", true], ["1.5", true], ["", true], ["1", false], ["120", false]] as const) expect(archiveProblem(v) !== null, v).toBe(bad);
    expect(PAGE).toContain("value < 1 || value > 120");
    expect(exportProblem("", "2026-01-01")).not.toBeNull(); expect(exportProblem("2026-02-01", "2026-01-01")).not.toBeNull(); expect(exportProblem("2026-01-01", "2026-01-01")).toBeNull();
    expect(emailProblem("")).toBeNull(); expect(emailProblem("a@b")).not.toBeNull(); expect(emailProblem("a@b.example")).toBeNull();
    expect(chaseProblem([{ days: "-3" }, { days: "7" }])).toBeNull(); expect(chaseProblem([{ days: "1.5" }])).not.toBeNull(); expect(chaseProblem([{ days: "" }])).not.toBeNull();
  });
  it("sample costing rates and template drafts pass the real checks", () => {
    expect(ratesProblem(SEED_COSTING)).toBeNull();
    expect(editorText("quote", {}, {}).subject).toContain("{{document_number}}");
    expect(templateProblem({ subject: "", body: "x" })).toBe("Enter a subject.");
  });
});

describe("wording and defaults pinned to the real source", () => {
  const SNIPPETS = [
    "Company-wide settings for", "Only admins can change them.", "Company settings aren't available right now. Menu and column choices are saved in this browser only.",
    "These details print on every quote, invoice and delivery note.", "Company details haven't been set up yet.", "Off: no quote, invoice, sales order or PO gets VAT, and no VAT number is printed.",
    "PNG or JPG, up to 1 MB. Printed top right on quotes, invoices, purchase orders and delivery notes. Only this company can see it.",
    "Show your logo, colours and tagline on your own sign-in link.", "Dark: your brand colour as the page, the tagline as a large headline.",
    "Printed at the foot of new invoices. It starts filled with the standard wording", "Bank details (printed on invoices)", "Show credit notes in Balance due on invoice PDFs",
    "Your normal working hours, day by day.", "A finish of 00:00 means midnight.", "Load the Hours settings below to see planned paid hours.", "Hours settings not loaded",
    "Finished jobs, decided quotes, paid invoices, received purchase orders", "Accepting a quote creates its sales order.", "This setting isn't available yet.",
    "How Weekly hours works out paid time.", "Off: breaks are unpaid and deducted (JNR, confirmed Sun 18 Oct).", "Office can approve weekly hours too",
    "A phone can't tell Tolra which Wi-Fi it is on.", "Delete every kept clock-in address?", "Keep them", "Delete all addresses", "Save the site network first.", "Flag only: never refuses a clock in.",
    "Lock clock-in to the network this device is on now", "Unlocked: clock-in works from any network.", "Re-capture the clock-in network?", "Unlock clock-in?", "Everyone can then clock in from any network again.",
    "With this on, each job's worksheet has a", "All are off until you switch them on.", "Off until you switch it on. Draft documents and a self-check list for your own review.",
    "The layout the job worksheet and the workshop pack print in.", "One zip with the PDF of every issued invoice", "Switch AI on or off in Integrations.",
    "All prices are in pounds. Enter your own materials, machines and rates", "Overhead % is charged on machine and labour time", "Set when Tolra sends reminders and timesheets for you.",
    "Each reminder is drafted for the invoice's customer", "Choose when to chase an invoice.", "Chasers are drafts for approval.", "No chase steps. Add a step to start chasing.",
    "Turn off sections you do not use.", "Choose what each screen shows.", "Reset all to default", "(always shown)", "Pre-filled when you send a job sheet to the workshop.",
    "Email sending from your own domain isn't set up yet. Until it is, job emails are saved as drafts.", "Write each part in its own box.", "Preview (example details)", "Could not load payment chasing.",
    "The steps below are suggestions. Save them to start using them.", "Hours and job sheets need a database update.",
  ];
  it.each(SNIPPETS)("%s", (m) => {
    const needle = plain(m);
    const real = needle === "Hours and job sheets need a database update." ? plain(read("lib/time-features.ts")) : needle === "Hours settings not loaded" ? REAL_PLAIN : REAL_PLAIN + plain(read("lib/email/chase/steps.ts"));
    expect(real.includes(needle) || plain(read("components/chase/connected-settings.tsx")).includes(needle), `real: ${m}`).toBe(true);
    expect(SRC_PLAIN.includes(needle) || plain(read("lib/time-features.ts")).includes(needle), `preview: ${m}`).toBe(true);
  });
  it("the gating switches show the real off defaults", () => {
    expect(NAV_TOGGLES.find((i) => i.key === "sales-orders")).toBeTruthy();
    expect(salesOrdersEnabled([])).toBe(false);
    expect(SALES_ORDERS_NOTE).toBe("Off to start with. Accepted quotes still make their order and job in the background.");
    expect(PAGE).toContain(SALES_ORDERS_NOTE);
    expect(read("components/jobs/jobs-reports-settings-card.tsx")).toContain("All are off until you switch them on.");
    expect(JOB_REPORT_ROWS).toEqual(["Planned vs actual machine time on job worksheets", "NCR register", "Reports page"]);
    expect(ISO_LABEL).toBe("ISO 9001 draft templates");
    expect(read("components/iso/iso-switch-card.tsx")).toContain('const LABEL = "ISO 9001 draft templates";');
    expect(PAGE).toContain("customer_signoff_enabled");
    expect(PAGE).toContain("?.customer_signoff_enabled === true"); // off unless true
    expect(PAGE).toContain("auto_convert_sales_orders?: boolean } | null)?.auto_convert_sales_orders !== false"); // on unless false (real default)
    expect(read("lib/email/schedules/form.ts")).toContain("enabled: false"); // every schedule starts Off
    expect(read("components/ai-helper/settings-card.tsx")).toContain("if (!allowed || !status?.can_manage) return null;"); // hidden unless the server flag is on
    expect(SRC).toContain("ai: false");
    expect(SRC).toContain("brandedLogin: false");
    expect(SEED_COMPANY.brandedLogin).toBe(false);
    expect(printLayoutStatus(resolvePrintLayout({ stored: null, slug: "x" }))).toContain("Not chosen yet");
    expect(read("components/print-layout-settings-card.tsx")).toContain("Not chosen yet: your company prints the");
  });
  it("cards appear in the real page order", () => {
    const real = [...PAGE.matchAll(/<(CompanyDetailsCard|ArchiveSettingsCard|AutoConvertCard|TimeSettingsCard|SiteNetworkCard|ClockInLockCard|CustomerSignOffCard|JobsReportsSettingsCard|IsoSwitchCard|PrintLayoutCard|YearEndExportCard|AiHelperSettingsCard|CostingRatesCard|EmailSchedulesCard|WorkshopEmailCard|EmailTemplatesCard)\b/g)].map((m) => m[1]);
    const preview = [...SRC.matchAll(/<(CompanyDetails|ArchiveCard|AutoConvertCard|HoursCard|NetworkCard|ClockLockCard|SignOffCard|JobReportsCard|IsoCard|PrintLayoutCard|YearEndCard|AiCard|CostingCard|SchedulesCard|WorkshopEmailCard|TemplatesCard)\b/g)].map((m) => m[1]);
    const map: Record<string, string> = { CompanyDetails: "CompanyDetailsCard", ArchiveCard: "ArchiveSettingsCard", HoursCard: "TimeSettingsCard", NetworkCard: "SiteNetworkCard", ClockLockCard: "ClockInLockCard", SignOffCard: "CustomerSignOffCard", JobReportsCard: "JobsReportsSettingsCard", IsoCard: "IsoSwitchCard", YearEndCard: "YearEndExportCard", AiCard: "AiHelperSettingsCard", CostingCard: "CostingRatesCard", SchedulesCard: "EmailSchedulesCard", TemplatesCard: "EmailTemplatesCard" };
    expect(preview.map((n) => map[n] ?? n)).toEqual(real);
    // Menu Sections and Display sit between Email schedules and Workshop Email, as on the page
    expect(PAGE.indexOf("Menu Sections")).toBeGreaterThan(PAGE.indexOf("<EmailSchedulesCard"));
    expect(PAGE.indexOf("<WorkshopEmailCard")).toBeGreaterThan(PAGE.indexOf("Display</CardTitle>"));
    expect(SRC.indexOf("<MenuCard")).toBeGreaterThan(SRC.indexOf("<SchedulesCard")); expect(SRC.indexOf("<DisplayCard")).toBeGreaterThan(SRC.indexOf("<MenuCard")); expect(SRC.indexOf("<WorkshopEmailCard")).toBeGreaterThan(SRC.indexOf("<DisplayCard"));
  });
  it("the anchors other pages link to are kept", () => { for (const id of ["setup-company", "setup-breaks", "setup-email", "setup-costing", "workshop-network"]) { expect(REAL).toContain(`id="${id}"`); expect(SRC).toContain(`id="${id}"`); } });
});

describe("Display and Menu come from the real org-settings functions", () => {
  it("counts and reset plan", () => {
    const real = screensByGroup().flatMap((g) => g.screens);
    expect(displayCounts({}).map((c) => c.key)).toEqual(real.map((s) => s.key));
    expect(displayCounts({}).every((c) => c.shown === c.total && !c.canReset)).toBe(true);
    const quotes = displayCounts(SEED_HIDDEN).find((c) => c.key === "quotes")!;
    expect(quotes.shown).toBe(quotes.total - 2); expect(quotes.canReset).toBe(true);
    expect(resetPlan(SEED_HIDDEN)).toEqual(["quotes", "customers", "hours"]);
    expect(resetPlan({})).toEqual([]);
    expect(resetPlan(SEED_HIDDEN, ["quotes"])).toEqual(["quotes"]);
    for (const k of Object.keys(SEED_HIDDEN)) { const s = real.find((x) => x.key === k)!; for (const c of SEED_HIDDEN[k]) expect(s.columns.find((col) => col.key === c && !col.locked), `${k}.${c}`).toBeTruthy(); }
  });
});

describe("rendering", () => {
  let host: HTMLDivElement | null = null; let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => { act(() => root?.unmount()); host?.remove(); host = null; root = null; });
  const mount = () => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(createElement(SettingsPreview))); return host; };
  it("draws the title, every card and the preview label", () => {
    const h = mount();
    expect(h.querySelector("h1")?.textContent).toBe("Settings");
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    const titles = [...h.querySelectorAll("h2")].map((e) => e.textContent);
    expect(titles).toEqual(["Company details", "Archive", "Quote to job", "Hours", "Workshop network", "Clock-in network lock", "Customer sign-off", "Job reports", "ISO 9001 draft templates", "Print layout", "Year-end export", "Costing rates", "Email schedules", "Menu Sections", "Display", "Workshop Email Settings", "Email templates"]);
    expect(h.textContent).not.toContain(" AI"); // the AI card is hidden until the server flag is on
    expect(h.textContent).toContain(COMPANY_NAME);
  });
  it("switches that gate other modules are off and a click only answers with the preview toast", () => {
    const h = mount();
    const sw = (label: string) => [...h.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find((b) => b.closest("label")?.textContent?.includes(label))!;
    for (const l of ["Customer sign-off on jobs", "NCR register", "Reports page", "Planned vs actual", ISO_LABEL, "Sales Orders"]) expect(sw(l).getAttribute("aria-checked"), l).toBe("false");
    act(() => sw("Customer sign-off on jobs").click());
    expect(sw("Customer sign-off on jobs").getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("Preview only");
    expect(document.body.textContent).toContain(NOT_SAVED);
  });
  it("never says saved, connected or authorised", () => {
    const h = mount();
    expect(h.textContent).not.toMatch(/\b(saved successfully|connected|authorised|Connected)\b/);
    expect(h.textContent).not.toMatch(/Company details saved|Logo uploaded|Settings saved/);
  });
});

describe("boundary", () => {
  it("imports no auth, session, storage or network code and writes nothing", () => {
    const code = SRC.replace(/\/\*\*[\s\S]*?\*\//, "").replace(/\/\/.*$/gm, "");
    for (const bad of ["use-user", "supabase", "createClient", "fetch(", "localStorage", "sessionStorage", "XMLHttpRequest", "navigator.clipboard", "authenticator-code", "/api/", "next/navigation", "document.cookie", "FileReader", "FormData"]) expect(code, bad).not.toContain(bad);
    expect(SRC).not.toMatch(/from "@\/lib\/(supabase|use-user|audit|use-saving|supabase-business|friendly-error|year-end-export)/);
    expect(SRC).not.toMatch(/from "@\/components\/(jobs|iso|costing\/costing-rates-card|ai-helper|email-schedules|email\/|chase|time|print-layout)/);
  });
  it("states the ownership assumption and carries the boundary comments", () => {
    expect(SRC.slice(0, 2500)).toContain("OWNERSHIP ASSUMPTION, TO BE CONFIRMED BY THE OWNER");
    expect(ROUTE).toContain("OWNERSHIP ASSUMPTION, TO BE CONFIRMED BY THE OWNER");
    expect(ROUTE).toContain("robots: { index: false, follow: false }");
    expect(CSS.slice(0, 1200)).toContain("BOUNDARY");
    expect(CSS).not.toMatch(/backdrop-filter|blur\(/);
    expect(CSS.match(/gradient/g) ?? []).toHaveLength(1); // only the boundary comment's mention; the brand strip's gradient is inline, as on the real page
    expect(SRC.match(/linear-gradient/g)).toHaveLength(1);
  });
  it("uses fictional data only", () => {
    expect(SRC).not.toMatch(/@(gmail|outlook|yahoo|hotmail)\./);
    for (const m of SRC.matchAll(/[\w.+-]+@([\w-]+\.[\w.-]+)/g)) expect(m[1], m[0]).toMatch(/\.example$|yourcompany\.co\.uk$/);
  });
});
