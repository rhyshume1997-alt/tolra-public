import { describe, expect, it, vi } from "vitest";

import { RELOAD_GUARD_MS, isChunkLoadError, reloadOnceForChunkError } from "@/lib/chunk-reload";

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe("chunk load errors after a deploy", () => {
  it("recognises webpack and dynamic-import chunk failures, nothing else", () => {
    const chunk = Object.assign(new Error("Loading chunk 9305 failed.\n(error: https://x/_next/static/chunks/app/(dashboard)/layout-abc.js)"), { name: "ChunkLoadError" });
    expect(isChunkLoadError(chunk)).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk app-pages-internals failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk 123 failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js"))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it("reloads once, then not again inside the guard window (no loop), then again after it", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const error = Object.assign(new Error("Loading chunk 1 failed."), { name: "ChunkLoadError" });
    expect(reloadOnceForChunkError(error, 1_000, storage, reload)).toBe(true);
    expect(reloadOnceForChunkError(error, 2_000, storage, reload)).toBe(false);
    expect(reloadOnceForChunkError(error, 1_000 + RELOAD_GUARD_MS - 1, storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnceForChunkError(error, 1_000 + RELOAD_GUARD_MS, storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads for other errors, or without storage for the guard", () => {
    const reload = vi.fn();
    expect(reloadOnceForChunkError(new Error("boom"), 1, memoryStorage(), reload)).toBe(false);
    expect(reloadOnceForChunkError(Object.assign(new Error("x"), { name: "ChunkLoadError" }), 1, null, reload)).toBe(false);
    const failing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(reloadOnceForChunkError(Object.assign(new Error("x"), { name: "ChunkLoadError" }), 1, failing, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
