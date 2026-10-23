import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let result: { data: unknown[] | null; error: unknown } = { data: [], error: null };

vi.mock("@/lib/supabase", () => {
  const query: Record<string, unknown> = {};
  for (const name of ["select", "in", "is", "order"]) query[name] = (...args: unknown[]) => { calls.push(`${name}:${JSON.stringify(args)}`); return query; };
  // One page of rows, then an empty page (what a real read does), so fetchAll stops.
  query.range = async (from: number) => (from === 0 ? result : { data: [], error: null });
  return { supabase: { from: (table: string) => { calls.push(`from:${table}`); return query; } } };
});

import { boardDescription, groupBoardFiles, jobBoardFiles, loadBoardJobFiles, MAX_DESCRIPTION_LENGTH } from "@/lib/job-board-files";

const SPEC = "Sales order SO-0002; customer delivery required 30/10/2026.\nQUO-0009:\n- CNC machining [BRKT-1 / DWG-7 rev B] x 5\n- Deburr and anodise x 5.5\n- CNC machining x 2";

describe("groupBoardFiles", () => {
  it("groups drawings and the customer PO by job, each name once, and ignores other kinds", () => {
    const map = groupBoardFiles([
      { job_id: "a", kind: "drawing", file_name: "DWG-7.pdf" },
      { job_id: "a", kind: "drawing", file_name: "DWG-7.pdf" },
      { job_id: "a", kind: "customer_po", file_name: "PO-123.pdf" },
      { job_id: "a", kind: "photo", file_name: "photo.jpg" },
      { job_id: "b", kind: "drawing", file_name: "  " },
      { job_id: "c", kind: "cert", file_name: "cert.pdf" },
      { job_id: null, kind: "drawing", file_name: "orphan.pdf" },
    ]);
    expect(map.get("a")).toEqual({ drawings: ["DWG-7.pdf"], attachments: ["PO-123.pdf"] });
    expect(map.get("b")).toEqual({ drawings: [], attachments: [] });
    expect(map.has("c")).toBe(false);
    expect(map.size).toBe(2);
  });
});

describe("jobBoardFiles", () => {
  it("merges the older jobs.drawings names with the job's files, without repeats", () => {
    const byJob = new Map([["a", { drawings: ["DWG-7.pdf", "NEW.pdf"], attachments: ["PO.pdf"] }]]);
    expect(jobBoardFiles({ id: "a", drawings: ["OLD.pdf", "DWG-7.pdf"] }, byJob)).toEqual({ drawings: ["OLD.pdf", "DWG-7.pdf", "NEW.pdf"], attachments: ["PO.pdf"] });
  });

  it("falls back to the job's own names when the files could not be read", () => {
    expect(jobBoardFiles({ id: "a", drawings: ["OLD.pdf"] }, null)).toEqual({ drawings: ["OLD.pdf"], attachments: [] });
    expect(jobBoardFiles({ id: "z", drawings: [] }, new Map())).toEqual({ drawings: [], attachments: [] });
  });
});

describe("loadBoardJobFiles", () => {
  beforeEach(() => { calls.length = 0; result = { data: [], error: null }; });

  it("reads only the current drawing and customer PO rows of job_files", async () => {
    result = { data: [{ id: "1", job_id: "a", kind: "drawing", file_name: "DWG-7.pdf" }], error: null };
    const map = await loadBoardJobFiles();
    expect(map?.get("a")).toEqual({ drawings: ["DWG-7.pdf"], attachments: [] });
    expect(calls).toContain("from:job_files");
    expect(calls).toContain('in:["kind",["drawing","customer_po"]]');
    expect(calls).toContain('is:["superseded_at",null]');
    expect(calls).toContain('is:["deleted_at",null]');
  });

  it("returns null when the read fails, so the board still shows", async () => {
    result = { data: null, error: new Error("denied") };
    expect(await loadBoardJobFiles()).toBeNull();
  });
});

describe("boardDescription", () => {
  it("replaces the 'Converted from' placeholder with the quote line descriptions, each once", () => {
    expect(boardDescription("Converted from SO-0002", SPEC)).toBe("CNC machining; Deburr and anodise");
  });

  it("keeps a description a person wrote, even with a specification", () => {
    expect(boardDescription("Titanium brackets", SPEC)).toBe("Titanium brackets");
    expect(boardDescription("Converted from SO-0002 - rush", SPEC)).toBe("Converted from SO-0002 - rush");
  });

  it("keeps the placeholder when the specification has no quote lines", () => {
    expect(boardDescription("Converted from SO-0002", "Sales order SO-0002.")).toBe("Converted from SO-0002");
    expect(boardDescription("Converted from SO-0002", "No specification recorded.")).toBe("Converted from SO-0002");
    expect(boardDescription("Converted from SO-0002", undefined)).toBe("Converted from SO-0002");
  });

  it("handles an empty description", () => {
    expect(boardDescription("", SPEC)).toBe("");
    expect(boardDescription(null, SPEC)).toBe("");
  });

  it("cuts a very long list at the length limit", () => {
    const spec = Array.from({ length: 60 }, (_, i) => `- Operation number ${i} on the part x 1`).join("\n");
    const text = boardDescription("Converted from SO-0009", spec);
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(text.endsWith("…")).toBe(true);
  });
});
