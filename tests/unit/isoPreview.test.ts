// @vitest-environment jsdom
/**
 * BOUNDARY (ISO templates, Module 9, PREVIEW ONLY). Inputs: the exports of components/iso/preview/IsoPreview.tsx, the REAL pure lib/iso functions, the real reminder
 * (lib/iso/ncr-review-reminder.ts, compared by behaviour) and the SOURCE of components/iso/iso-pack-view.tsx and iso-switch-card.tsx. Output: pass/fail. Pins the preview's wording,
 * columns, role gate, reminder rule and status colours to the real page, and checks by rendering that no action reports success, no controlled wording is added, and the preview
 * imports no network, auth or PDF code. Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX).
 */
import * as v2fs from "node:fs";
import * as v2path from "node:path";
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import IsoPreview, {
  DAYS_LABEL, DISCLAIMER, NCR_UNREAD, NOT_AVAILABLE_NOTE, PACK_HINT, PAGE_TITLE, PREVIEW_TODAY, REMINDER_NOTE, SAMPLE_NCRS, STATUS_TONE, SWITCH_LABEL, SWITCH_TEXT,
  canUseIso, noOverdueText, overdueNcrs, reviewDays, subtitleFor, unreadNote, viewFor,
} from "@/components/iso/preview/IsoPreview";
import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { buildGapChecklist, GAP_STATUSES } from "@/lib/iso/gap-checklist";
import { ISO_OFF_NOTICE } from "@/lib/iso/iso-switch";
import { overdueNcrs as realOverdue, reviewDays as realReviewDays } from "@/lib/iso/ncr-review-reminder";
import type { NcrRow } from "@/lib/jobs/ncr-register";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const VIEW = read("components/iso/preview/../iso-pack-view.tsx");
const CARD = read("components/iso/iso-switch-card.tsx");
const SRC = read("components/iso/preview/IsoPreview.tsx");
const ROUTE = read("app/(dashboard)/admin/iso/preview/page.tsx");
const BANNED = ["certified", "compliant", "accredited", "approved by", "iso certified", "certification ready", "readiness"];

describe("wording pinned to the real page", () => {
  it("every string the preview repeats appears in the real source", () => {
    for (const w of [SWITCH_TEXT, NOT_AVAILABLE_NOTE, PACK_HINT, REMINDER_NOTE, NCR_UNREAD, "Gap checklist", "NCR review reminder", "Download pack (zip)", "Download checklist (PDF)", "Download checklist (CSV)"]) {
      expect(VIEW + CARD, w).toContain(w);
    }
    expect(CARD).toContain(`const LABEL = "${SWITCH_LABEL}"`);
    expect(VIEW).toContain("Remind after (days open, this visit only)");
    expect(DAYS_LABEL).toBe("Remind after (days open, this visit only)");
    expect(VIEW).toContain(`<h1 className="page-title">${PAGE_TITLE}</h1>`);
    expect(VIEW).toContain("Template and self-check aid. Needs company review. Not certification evidence.");
    expect(DISCLAIMER).toBe("Template and self-check aid. Needs company review. Not certification evidence.");
    expect(VIEW).toContain("Branded draft templates and a self-check list for {companyName}.");
    expect(subtitleFor("X Ltd")).toBe("Branded draft templates and a self-check list for X Ltd. Template and self-check aid. Needs company review. Not certification evidence.");
    expect(VIEW).toContain("Some records could not be read ({data.unread.join(\", \")}). Those clauses show as not evidenced.");
    expect(unreadNote(["a", "b"])).toBe("Some records could not be read (a, b). Those clauses show as not evidenced.");
    expect(VIEW).toContain("No confirmed NCR has been open for more than {days} days.");
    expect(noOverdueText(7)).toBe("No confirmed NCR has been open for more than 7 days.");
    expect(VIEW).toContain("{ISO_OFF_NOTICE}");
  });
  it("the real column names are kept", () => {
    for (const c of ["Document", "Clause", "Requirement", "Status", "Basis", "Record", "Raised", "Days open", "Reason"]) expect(VIEW, c).toContain(`<TableHead>${c}</TableHead>`);
    for (const c of ["Document", "Clause", "Requirement", "Status", "Basis", "Record", "Raised", "Days open", "Reason"]) expect(SRC, c).toContain(`>${c}</th>`);
  });
  it("controlled document wording is never written here", () => {
    for (const w of BANNED) expect(SRC.toLowerCase(), w).not.toContain(w);
    for (const d of ISO_DOCUMENTS) for (const sec of d.sections) for (const line of sec.lines) expect(SRC).not.toContain(line);
    expect(SRC).toContain('from "@/lib/iso/document-list"');
  });
});

describe("rules", () => {
  it("admin only", () => { expect(canUseIso("admin")).toBe(true); for (const r of ["office", "workshop", "viewer"] as const) expect(canUseIso(r)).toBe(false); });
  it("off by default notice is the real one", () => { expect(ISO_OFF_NOTICE).toBe("ISO templates are switched off for your company."); expect(viewFor("off").on).toBe(false); });
  it("the reminder mirror behaves as the real function", () => {
    for (const v of ["", " ", "0", "-3", "2.5", "abc", "7", "30", "3650", "3651", null, undefined, 5]) expect(reviewDays(v as never)).toBe(realReviewDays(v as never));
    const rows = SAMPLE_NCRS as unknown as NcrRow[];
    for (const d of [1, 7, 14, 27, 28, 30]) {
      const mine = overdueNcrs(SAMPLE_NCRS, PREVIEW_TODAY, d).map((o) => [o.row.key, o.daysOpen]);
      const real = realOverdue(rows, PREVIEW_TODAY, d).map((o) => [o.row.key, o.daysOpen]);
      expect(mine).toEqual(real);
    }
    expect(overdueNcrs(SAMPLE_NCRS, PREVIEW_TODAY, 7).map((o) => o.row.key)).toEqual(["rework:r1", "rework:r2"]);
  });
  it("the reminder source still holds the rules mirrored here", () => {
    const real = read("lib/iso/ncr-review-reminder.ts");
    for (const frag of ['r.recordClass === "Confirmed NCR" && r.open && !r.notLinked && Boolean(r.raisedDate)', "Number.isInteger(n) && n >= 1 && n <= 3650", "export const REVIEW_DAYS_DEFAULT = 7"]) {
      expect(real, frag).toContain(frag);
      expect(SRC, frag).toContain(frag);
    }
  });
  it("the gap list comes from the real builder and Records present never uses a success colour", () => {
    const rows = buildGapChecklist(viewFor("ready").evidence);
    expect(rows.map((r) => r.status)).toContain("Met");
    expect(rows.map((r) => r.status)).toContain("Major");
    expect(Object.keys(STATUS_TONE).sort()).toEqual([...GAP_STATUSES].sort());
    expect(Object.values(STATUS_TONE)).not.toContain("ok");
    const unreadRows = buildGapChecklist(viewFor("all-unread").evidence);
    expect(unreadRows.every((r) => r.status === "Not evidenced by Tolra")).toBe(true);
  });
});

describe("safety", () => {
  it("imports no network, auth, PDF or storage code and is labelled preview", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of ["supabase", "fetch(", "@react-pdf", "fflate", "sonner", "localStorage", "use-user", "org-settings", "XMLHttpRequest", "sendBeacon"]) expect(code.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    expect(SRC).toContain("PREVIEW ONLY");
    expect(ROUTE).toContain("robots: { index: false, follow: false }");
    expect(/\b[\w.-]+@(?!.*\.example)[\w.-]+\.\w+/.test(SRC.replace(/@\/|@vitest|@react/g, ""))).toBe(false);
  });
});

describe("rendering", () => {
  let host: HTMLDivElement;
  beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never; });
  afterEach(() => { host?.remove(); });
  const mount = async () => { host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); await act(async () => { root.render(createElement(IsoPreview)); }); return root; };
  it("draws the nine documents, the checklist and the overdue NCRs; downloads only toast", async () => {
    await mount();
    expect(host.querySelectorAll('[data-testid^="doc-"]').length).toBe(ISO_DOCUMENTS.length);
    expect(host.querySelector('[data-testid="gap-panel"]')).toBeTruthy();
    expect(host.textContent).toContain("J-0412 Rework 2026-10-26");
    const btn = host.querySelector('[data-testid="download-pack"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Preview only");
    expect(text).toContain("Nothing was saved.");
    expect(text.toLowerCase()).not.toMatch(/\bsaved successfully|downloaded successfully|connected\b/);
  });
  it("the switch answers with the toast and does not flip", async () => {
    await mount();
    const sw = host.querySelector('[data-testid="iso-switch"]') as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => { sw.click(); });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Preview only");
  });
});

describe("v2 structure (owner approved items 4, 7, 10, 11): shared PreviewBar and PageHeader, v4 type scale, no local preview pill", () => {
  const SRC2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/iso/preview/IsoPreview.tsx"), "utf8");
  const CSS2 = v2fs.readFileSync(v2path.join(process.cwd(), "components/iso/preview/IsoPreview.module.css"), "utf8");
  it("uses the shared strip and heading, and keeps the Preview controls trigger", () => {
    expect(SRC2).toContain("<PreviewBar");
    expect(SRC2).toContain("PageHeader");
    expect(SRC2).toContain('label="Preview controls"');
    expect(SRC2).not.toContain("s.previewTag");
    expect(SRC2).not.toContain("<h1 className={s.title}");
  });
  it("sizes text from the v4 scale tokens, not loose pixel sizes", () => {
    expect(CSS2).toContain("var(--ui-fs-");
    expect(CSS2).not.toMatch(/font-size:\s*(12\.5|13\.5)px/);
    expect(CSS2).not.toMatch(/font-weight:\s*(650|550)/);
  });
  it("builds narrow records from the shared primitive: StackedRows", () => {
    expect(SRC2).toContain("StackedRows");
  });
});
