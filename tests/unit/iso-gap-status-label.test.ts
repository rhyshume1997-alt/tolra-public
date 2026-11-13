import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildGapChecklist, EMPTY_EVIDENCE, GAP_CSV_COLUMNS, GAP_STATUSES, GAP_STATUS_LABELS, gapStatusLabel, type GapEvidence, type GapStatus } from "@/lib/iso/gap-checklist";

// Duplicated from tests/unit/iso-wording.test.ts (not exported there), plus the extra words for this label change.
const BANNED = ["certified", "compliant", "accredited", "approved by", "iso certified", "certification ready", "readiness", "compliance", "certified"];
const FULL: GapEvidence = {
  inspectors: { current: 3, withReason: 3 }, changeHistoryPresent: true,
  drawingRevision: { flagged: 4, finished: 4, finishedMissing: 0, truncated: false },
  suppliers: { total: 5, approved: 4, conditional: 1, blocked: 0, truncated: false },
  traceability: { flagged: 4, finished: 2, finishedMissing: 0, truncated: false },
};
const statusCol = GAP_CSV_COLUMNS.find((c) => c.header === "Status")!;
const csvStatuses = (e: GapEvidence) => buildGapChecklist(e).map((r) => String(statusCol.value(r)));

describe("gap status label", () => {
  it("Met rows still compute as Met and display as Records present", () => {
    const met = buildGapChecklist(FULL).filter((r) => r.status === "Met");
    expect(met.length).toBeGreaterThan(0);
    for (const r of met) expect(gapStatusLabel(r.status)).toBe("Records present");
  });
  it("CSV Status column says Records present, never bare Met", () => {
    const s = csvStatuses(FULL);
    expect(s).toContain("Records present");
    expect(s).not.toContain("Met");
  });
  it("Minor, Major and Not evidenced by Tolra labels are unchanged", () => {
    expect(gapStatusLabel("Minor")).toBe("Minor");
    expect(gapStatusLabel("Major")).toBe("Major");
    expect(gapStatusLabel("Not evidenced by Tolra")).toBe("Not evidenced by Tolra");
  });
  it("every status uses the same styling (font-medium / styles.status)", () => {
    const view = readFileSync("components/iso/iso-pack-view.tsx", "utf8");
    const pdf = readFileSync("components/iso/gap-checklist-pdf.tsx", "utf8");
    expect(view).toContain('<TableCell className="font-medium">{gapStatusLabel(r.status)}</TableCell>');
    expect(pdf).toContain("<Text style={styles.status}>{gapStatusLabel(r.status)}</Text>");
    expect(view).not.toMatch(/\{r\.status\}/);
    expect(pdf).not.toMatch(/\{r\.status\}/);
  });
  it("labels and CSV contain no certification claims", () => {
    const text = [...Object.values(GAP_STATUS_LABELS), ...csvStatuses(FULL), ...csvStatuses(EMPTY_EVIDENCE)].join("\n").toLowerCase();
    for (const w of BANNED) expect(text).not.toContain(w);
    expect(text).not.toMatch(/\bmet\b/);
  });
  it("GAP_STATUSES identifiers are unchanged", () => {
    expect([...GAP_STATUSES]).toEqual(["Met", "Minor", "Major", "Not evidenced by Tolra"]);
    expect(Object.keys(GAP_STATUS_LABELS).sort()).toEqual([...GAP_STATUSES].sort() as GapStatus[]);
  });
});
