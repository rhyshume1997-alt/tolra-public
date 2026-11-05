import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadSafeupdate, safeupdateStatus } from "../support/safeupdate-session";

const refuse = () => Object.assign(new Error('access to library "safeupdate" is not allowed'), { code: "42501" });

describe("loadSafeupdate", () => {
  beforeEach(() => { safeupdateStatus.loaded = 0; safeupdateStatus.unavailable = 0; vi.spyOn(console, "log").mockImplementation(() => undefined); });

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

  it("when both are refused it carries on, counted and announced as running without the guard", async () => {
    const query = vi.fn(async () => { throw refuse(); });
    expect(await loadSafeupdate({ query })).toBe(false);
    expect(safeupdateStatus.unavailable).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("SAFEUPDATE-NOT-LOADABLE"));
  });

  it("never hides any other error", async () => {
    const query = vi.fn(async () => { throw Object.assign(new Error("connection lost"), { code: "08006" }); });
    await expect(loadSafeupdate({ query })).rejects.toThrow("connection lost");
    expect(safeupdateStatus).toEqual({ loaded: 0, unavailable: 0 });
  });
});
