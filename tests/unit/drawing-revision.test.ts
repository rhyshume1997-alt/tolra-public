/** The drawing revision on a job, only where the job needs it (migration 083): the notice and what a save would change. */
import { describe, expect, it } from "vitest";

import { DRAWING_REVISION_NEEDED, drawingRevisionChange, drawingRevisionNotice } from "@/lib/drawing-revision";

describe("drawing revision on the job", () => {
  it("says it is needed only when the job requires one, has none, and isn't Complete", () => {
    expect(drawingRevisionNotice({ required: true, revision: null, complete: false })).toBe(DRAWING_REVISION_NEEDED);
    expect(drawingRevisionNotice({ required: true, revision: "  ", complete: false })).toBe(DRAWING_REVISION_NEEDED);
    expect(drawingRevisionNotice({ required: false, revision: null, complete: false })).toBeNull();
    expect(drawingRevisionNotice({ required: true, revision: "C", complete: false })).toBeNull();
  });

  it("the first revision and switching it on need no reason; replacing one or switching it off does; a blank keeps it", () => {
    const empty = { required: false, revision: null, complete: false };
    expect(drawingRevisionChange(empty, { required: true, revision: "" })).toEqual({ changed: true, needsReason: false, problem: null });
    expect(drawingRevisionChange(empty, { required: false, revision: " B " })).toEqual({ changed: true, needsReason: false, problem: null });
    const set = { required: true, revision: "B", complete: false };
    expect(drawingRevisionChange(set, { required: true, revision: "C" })).toMatchObject({ changed: true, needsReason: true });
    expect(drawingRevisionChange(set, { required: false, revision: "B" })).toMatchObject({ changed: true, needsReason: true });
    expect(drawingRevisionChange(set, { required: true, revision: "" })).toMatchObject({ changed: false });
    expect(drawingRevisionChange(set, { required: true, revision: "X".repeat(21) }).problem).toMatch(/20 characters/);
    expect(drawingRevisionChange({ ...set, complete: true }, { required: true, revision: "D" }).problem).toMatch(/reopen/);
  });
});
