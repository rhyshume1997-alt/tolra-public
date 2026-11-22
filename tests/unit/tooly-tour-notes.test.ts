/**
 * The tour notes (components/tooly/tour/tour-notes.ts): every step id in the admin, office and workshop tours has a note with both parts,
 * no note is left over for a step that does not exist, and the words follow the house rules (no em or en dashes, no empty text).
 * Must not change: this file proves; the notes themselves are written in tour-notes.ts.
 */
import { describe, expect, it } from "vitest";

import { OFFICE_TOUR_STEPS, WORKSHOP_TOUR_STEPS } from "@/components/tooly/tour/role-tour-steps";
import { TOUR_NOTES, tourNoteFor } from "@/components/tooly/tour/tour-notes";
import { ADMIN_TOUR_STEPS } from "@/components/tooly/tour/tour-steps";

const ids = new Set([...ADMIN_TOUR_STEPS, ...OFFICE_TOUR_STEPS, ...WORKSHOP_TOUR_STEPS].map((s) => s.id));

describe("tour notes", () => {
  it("has a note for every step id in the three tours", () => {
    for (const id of ids) expect(tourNoteFor(id), id).not.toBeNull();
  });
  it("has no note for a step that does not exist", () => {
    for (const id of Object.keys(TOUR_NOTES)) expect(ids.has(id), id).toBe(true);
  });
  it("gives both parts, in plain words", () => {
    for (const [id, note] of Object.entries(TOUR_NOTES)) {
      expect(note.happens.trim().length, id).toBeGreaterThan(20);
      expect(note.produced.trim().length, id).toBeGreaterThan(20);
      expect(`${note.happens} ${note.produced}`, id).not.toMatch(/[–—]/);
    }
  });
  it("returns null for an unknown id", () => {
    expect(tourNoteFor("nope")).toBeNull();
  });
});
