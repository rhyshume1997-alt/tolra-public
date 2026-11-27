// The tour keeps its step across the full page load the Settings CSP boundary causes (tab-only sessionStorage; bad values read as nothing).
import { describe, expect, it } from "vitest";
import { consumeBoundaryReload, markBoundaryReload } from "@/lib/full-document-load";
import { readTourResume, writeTourResume } from "@/components/tooly/tour/tour-resume";

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

const yes = () => true;

describe("tour resume", () => {
  it("round-trips the step and replay flag, and clears", () => {
    const s = memory();
    expect(readTourResume(s, yes)).toBeNull();
    writeTourResume({ index: 16, replay: true }, s);
    expect(readTourResume(s, yes)).toEqual({ index: 16, replay: true });
    writeTourResume(null, s);
    expect(readTourResume(s, yes)).toBeNull();
  });
  it("a bad value reads as nothing saved, and a broken store never throws", () => {
    const s = memory();
    s.setItem("tooly-tour-resume", "{nope");
    expect(readTourResume(s, yes)).toBeNull();
    s.setItem("tooly-tour-resume", JSON.stringify({ index: -1 }));
    expect(readTourResume(s, yes)).toBeNull();
    expect(() => writeTourResume({ index: 1, replay: false }, { setItem() { throw new Error("full"); }, removeItem() {} })).not.toThrow();
  });
});

describe("only a boundary reload resumes", () => {
  it("an ordinary visit starts at step 1", () => {
    const s = memory();
    writeTourResume({ index: 5, replay: false }, s);
    expect(readTourResume(s, () => false)).toBeNull();
  });
  it("the reload mark is consumed once", () => {
    const s = memory();
    expect(consumeBoundaryReload(s)).toBe(false);
    markBoundaryReload(s);
    expect(consumeBoundaryReload(s)).toBe(true);
    expect(consumeBoundaryReload(s)).toBe(false);
  });
});
