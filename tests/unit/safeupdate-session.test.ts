import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadSafeupdate, safeupdateStatus } from "../support/safeupdate-session";

const refuse = () => Object.assign(new Error('access to library "safeupdate" is not allowed'), { code: "42501" });
const missing = () => Object.assign(new Error("could not access file"), { code: "58P01" });

describe("loadSafeupdate", () => {
  const evidenceFile = path.join(mkdtempSync(path.join(os.tmpdir(), "safeupdate-")), "sessions.log");
  beforeEach(() => { process.env.SAFEUPDATE_EVIDENCE_FILE = evidenceFile; safeupdateStatus.loaded = 0; safeupdateStatus.unavailable = 0; vi.spyOn(console, "log").mockImplementation(() => undefined); });

  it("loads the plain name where the user may", async () => {
    const query = vi.fn(async () => undefined);
    expect(await loadSafeupdate({ query })).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("load 'safeupdate'");
    expect(safeupdateStatus).toEqual({ loaded: 1, unavailable: 0 });
  });

  it("falls back to the plugins path when the plain name is refused", async () => {
    const query = vi.fn(async (text: string) => { if (text === "load 'safeupdate'") throw refuse(); });
    expect(await loadSafeupdate({ query })).toBe(true);
    expect(query).toHaveBeenLastCalledWith("load '$libdir/plugins/safeupdate'");
    expect(safeupdateStatus.loaded).toBe(1);
  });

  it("42501 for the plain name then 58P01 for the plugins path: carries on, counted and announced as running without the guard", async () => {
    const query = vi.fn(async (text: string) => { throw text === "load 'safeupdate'" ? refuse() : missing(); });
    expect(await loadSafeupdate({ query })).toBe(false);
    expect(safeupdateStatus.unavailable).toBe(1);
    expect(readFileSync(evidenceFile, "utf8")).toBe("refused\n"); // one line per affected session, summed by CI
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("SAFEUPDATE-NOT-LOADABLE"));
  });

  it("any other pair of errors is thrown: 58P01 first, or 42501 twice, or another code on the second attempt", async () => {
    await expect(loadSafeupdate({ query: vi.fn(async () => { throw missing(); }) })).rejects.toMatchObject({ code: "58P01" });
    await expect(loadSafeupdate({ query: vi.fn(async () => { throw refuse(); }) })).rejects.toMatchObject({ code: "42501" });
    await expect(loadSafeupdate({ query: vi.fn(async (text: string) => { throw text === "load 'safeupdate'" ? refuse() : Object.assign(new Error("x"), { code: "XX000" }); }) })).rejects.toMatchObject({ code: "XX000" });
    expect(safeupdateStatus.unavailable).toBe(0);
  });

  it("never hides any other error", async () => {
    const query = vi.fn(async () => { throw Object.assign(new Error("connection lost"), { code: "08006" }); });
    await expect(loadSafeupdate({ query })).rejects.toThrow("connection lost");
    expect(safeupdateStatus).toEqual({ loaded: 0, unavailable: 0 });
  });
});
