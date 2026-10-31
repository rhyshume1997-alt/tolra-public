/**
 * "Open drawing" on My jobs opens the job's current drawing revision exactly as the Job Board's Worksheet dialog marks it: it asks
 * the dialog's own listDrawings (the current revision of each drawing, never one an upload replaced) and signs the link with the
 * dialog's own drawingUrl. The Supabase client here is a stand-in with one job's files in it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  files: [] as Array<Record<string, unknown>>,
  stored: [] as Array<{ id: string | null; name: string }>,
  signed: [] as Array<{ bucket: string; path: string; ttl: number; options: unknown }>,
  user: true,
  storageDown: false,
}));

vi.mock("@/lib/supabase", () => {
  const query = () => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) builder[method] = () => builder;
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: state.files, error: null });
    return builder;
  };
  return {
    supabase: {
      auth: { getUser: async () => ({ data: { user: state.user ? { id: "u1" } : null } }) },
      rpc: async () => ({ data: "org1", error: null }),
      from: () => query(),
      storage: {
        from: (bucket: string) => ({
          list: async () => (state.storageDown ? { data: null, error: new Error("down") } : { data: state.stored, error: null }),
          createSignedUrl: async (path: string, ttl: number, options: unknown) => { state.signed.push({ bucket, path, ttl, options }); return { data: { signedUrl: `https://files.test/${path}?token=t` }, error: null }; },
        }),
      },
    },
  };
});

import { drawingLabel, drawingLink, planDrawings, planJobDrawings } from "@/lib/open-drawing";

const row = (over: Record<string, unknown>) => ({ id: "f", ref: "bracket", revision: null, file_name: "bracket.pdf", storage_bucket: "job-drawings", storage_path: "org1/j1/1-bracket.pdf", superseded_at: null, created_at: "2026-10-01T09:00:00Z", ...over });

beforeEach(() => {
  state.files = [];
  state.stored = [];
  state.signed = [];
  state.user = true;
  state.storageDown = false;
});

describe("which drawing opens", () => {
  it("the current revision: a drawing an upload replaced is never offered, and the label says what it replaced", async () => {
    state.files = [
      row({ id: "a", revision: "A", file_name: "bracket-a.pdf", storage_path: "org1/j1/1-bracket-a.pdf", superseded_at: "2026-10-05T09:00:00Z" }),
      row({ id: "b", revision: "B", file_name: "bracket-b.pdf", storage_path: "org1/j1/2-bracket-b.pdf", superseded_at: "2026-10-09T09:00:00Z", created_at: "2026-10-05T09:00:00Z" }),
      row({ id: "c", revision: "C", file_name: "bracket-c.pdf", storage_path: "org1/j1/3-bracket-c.pdf", created_at: "2026-10-09T09:00:00Z" }),
    ];
    const plan = await planJobDrawings("j1");
    expect(plan.kind).toBe("one");
    if (plan.kind !== "one") return;
    expect(plan.choice.file).toMatchObject({ id: "c", name: "bracket-c.pdf", revision: "C", path: "org1/j1/3-bracket-c.pdf", bucket: "job-drawings" });
    expect(plan.choice.label).toBe("bracket-c.pdf · Rev C (replaces A, B)");
    // The link is the worksheet's own: five minutes, downloaded under the file's name, for that file only.
    expect(await drawingLink(plan.choice.file)).toBe("https://files.test/org1/j1/3-bracket-c.pdf?token=t");
    expect(state.signed).toEqual([{ bucket: "job-drawings", path: "org1/j1/3-bracket-c.pdf", ttl: 300, options: { download: "bracket-c.pdf" } }]);
  });

  it("several different drawings are each offered at their own current revision, named as the worksheet marks them", async () => {
    state.files = [
      row({ id: "x", ref: "bracket", revision: "C", file_name: "bracket.pdf", storage_path: "org1/j1/3-bracket.pdf" }),
      row({ id: "y", ref: "cover", revision: null, file_name: "cover.pdf", storage_path: "org1/j1/4-cover.pdf", created_at: "2026-10-02T09:00:00Z" }),
    ];
    const plan = await planJobDrawings("j1");
    expect(plan.kind).toBe("many");
    if (plan.kind !== "many") return;
    expect(plan.choices.map((c) => c.label)).toEqual(["bracket.pdf · Rev C", "cover.pdf · no revision marked"]);
  });

  it("a drawing uploaded before the worksheet kept records still opens (it is in the folder with no row)", async () => {
    state.stored = [{ id: "s1", name: "1700000000000-old.pdf" }, { id: null, name: "photos" }];
    const plan = await planJobDrawings("j1");
    expect(plan.kind).toBe("one");
    if (plan.kind === "one") expect(plan.choice.file).toMatchObject({ name: "old.pdf", path: "org1/j1/1700000000000-old.pdf", bucket: "job-drawings" });
  });

  it("no drawing says so; Storage out of reach says to check the connection; nothing is signed either way", async () => {
    expect(await planJobDrawings("j1")).toEqual({ kind: "none" });
    state.storageDown = true;
    expect(await planJobDrawings("j1")).toEqual({ kind: "unavailable" });
    state.storageDown = false;
    state.user = false;
    expect(await planJobDrawings("j1")).toEqual({ kind: "unavailable" });
    expect(state.signed).toEqual([]);
  });

  it("planDrawings alone: null is unavailable, demo entries without a stored file are not drawings", () => {
    expect(planDrawings(null)).toEqual({ kind: "unavailable" });
    expect(planDrawings([{ name: "demo.pdf" }])).toEqual({ kind: "none" });
    expect(drawingLabel({ name: "a.pdf", revision: "B", earlier: [] })).toBe("a.pdf · Rev B");
  });
});
