/** Module J: which design a document prints with (lib/document-templates/document-template-settings). Off by default; issued documents never change. */
import { describe, expect, it } from "vitest";

import {
  brandColourOn, currentDesignId, DEFAULT_DESIGN_ID, parseDocumentTemplates, resolveDesignId, setDesignChoice, withBrandColour, withStoredDocumentTemplates, withTemplatesEnabled,
} from "@/lib/document-templates/document-template-settings";

const T1 = new Date("2026-12-01T09:00:00Z");
const T2 = new Date("2027-02-01T09:00:00Z");

describe("defaults", () => {
  it("nothing stored, unreadable or off is classic for every type", () => {
    for (const stored of [undefined, null, "x", [], {}, { enabled: false, quote: [{ design: "modern", from: "2026-01-01" }] }]) {
      const settings = parseDocumentTemplates(stored);
      expect(settings.enabled).toBe(false);
      expect(resolveDesignId(settings, "quote")).toBe(DEFAULT_DESIGN_ID);
    }
    expect(resolveDesignId(null, "invoice")).toBe("classic");
  });
  it("on with no choice for a type is classic", () => {
    expect(resolveDesignId(withTemplatesEnabled(null, true), "invoice")).toBe("classic");
  });
  it("drops unreadable entries instead of throwing", () => {
    const s = parseDocumentTemplates({ enabled: true, quote: [{ design: "Bad Id!", from: "2026-01-01" }, { design: "modern", from: "nonsense" }, null, { design: "modern", from: "2026-01-01" }], bogus: 1 });
    expect(s.quote).toEqual([{ design: "modern", from: "2026-01-01" }]);
  });
});

describe("choices are per company and per document type", () => {
  it("choosing for one type leaves the others alone", () => {
    const s = withTemplatesEnabled(setDesignChoice(null, "quote", "modern", T1), true);
    expect(currentDesignId(s, "quote")).toBe("modern");
    expect(currentDesignId(s, "invoice")).toBe("classic");
    expect(currentDesignId(s, "purchase_order")).toBe("classic");
    expect(currentDesignId(s, "delivery_note")).toBe("classic");
  });
  it("choosing what is already in force changes nothing; bad input is refused", () => {
    const s = setDesignChoice(null, "quote", "modern", T1);
    expect(setDesignChoice(s, "quote", "modern", T2)).toEqual(s);
    expect(() => setDesignChoice(s, "quote", "No Good", T2)).toThrow();
    expect(() => setDesignChoice(s, "worksheet" as never, "modern", T2)).toThrow();
  });
  it("switching the feature off keeps the choices", () => {
    const s = withTemplatesEnabled(withTemplatesEnabled(setDesignChoice(null, "quote", "modern", T1), true), false);
    expect(s.quote).toHaveLength(1);
    expect(resolveDesignId(s, "quote")).toBe("classic");
  });
});

describe("issued documents keep the design they were issued with", () => {
  const s = withTemplatesEnabled(setDesignChoice(setDesignChoice(null, "invoice", "modern", T1), "invoice", "minimal", T2), true);
  it("before the first choice: classic; between: modern; after the second: minimal", () => {
    expect(resolveDesignId(s, "invoice", "2026-11-30")).toBe("classic");
    expect(resolveDesignId(s, "invoice", "2026-12-15")).toBe("modern");
    expect(resolveDesignId(s, "invoice", "2027-02-01T10:00:00Z")).toBe("minimal");
  });
  it("a document not issued yet gets the design in force now", () => {
    expect(resolveDesignId(s, "invoice")).toBe("minimal");
    expect(resolveDesignId(s, "invoice", null)).toBe("minimal");
  });
  it("a later choice never changes what an earlier date resolves to", () => {
    const before = resolveDesignId(s, "invoice", "2026-12-15");
    const later = setDesignChoice(s, "invoice", "classic", new Date("2027-06-01T00:00:00Z"));
    expect(resolveDesignId(later, "invoice", "2026-12-15")).toBe(before);
    expect(resolveDesignId(later, "invoice", "2027-02-15")).toBe("minimal");
  });
  it("a clock that moves back never dates a choice before an earlier one", () => {
    const back = setDesignChoice(s, "invoice", "classic", new Date("2026-01-01T00:00:00Z"));
    expect(back.invoice?.at(-1)?.from).toBe("2027-02-01T09:00:00.000Z");
  });
});

describe("saving Company details keeps the stored choices", () => {
  it("the stored value wins, and none stored adds none", () => {
    const stored = { documentTemplates: { enabled: true, quote: [{ design: "modern", from: "2026-12-01T09:00:00.000Z" }] } };
    expect(withStoredDocumentTemplates({ name: "x", documentTemplates: { enabled: false } }, stored)).toEqual({ name: "x", documentTemplates: stored.documentTemplates });
    expect(withStoredDocumentTemplates({ name: "x", documentTemplates: { enabled: true } }, {})).toEqual({ name: "x" });
  });
});

describe("brand colours are a per-company on/off setting, off by default", () => {
  it("off when nothing is stored, when unreadable, and for any value but true", () => {
    for (const stored of [undefined, {}, { enabled: true }, { enabled: true, colour: "yes" }, { enabled: true, colour: false }]) expect(brandColourOn(parseDocumentTemplates(stored))).toBe(false);
    expect(brandColourOn(null)).toBe(false);
  });
  it("on only when stored true; switching it on or off keeps the designs chosen and the on/off switch", () => {
    const base = withTemplatesEnabled(setDesignChoice(null, "quote", "modern", T1), true);
    const on = withBrandColour(base, true);
    expect(brandColourOn(on)).toBe(true);
    expect(on.quote).toEqual(base.quote);
    expect(on.enabled).toBe(true);
    const off = withBrandColour(on, false);
    expect(brandColourOn(off)).toBe(false);
    expect(off).toEqual(base);
    expect(brandColourOn(parseDocumentTemplates(JSON.parse(JSON.stringify(on))))).toBe(true);
  });
});
