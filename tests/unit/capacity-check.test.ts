/**
 * Capacity alerts (scripts/capacity-check.mjs) and the health answer the outage check reads.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateCapacity, summaryLines } from "../../scripts/capacity-check.mjs";
import { GET as health } from "@/app/api/health/route";

const MB = 1024 * 1024;
const script = path.resolve(__dirname, "../../scripts/capacity-check.mjs");

describe("evaluateCapacity", () => {
  it("quiet below 80%, alerts at 80% and over, per figure", () => {
    const ok = evaluateCapacity({ dbBytes: 399 * MB, storageBytes: 100 * MB });
    expect(ok.alert).toBe(false);
    expect(ok.figures.map((f: { percent: number }) => f.percent)).toEqual([79.8, 9.8]);

    const db = evaluateCapacity({ dbBytes: 400 * MB, storageBytes: 0 });
    expect(db.alert).toBe(true);
    expect(db.figures[0]).toMatchObject({ name: "database", over: true, percent: 80 });

    const files = evaluateCapacity({ dbBytes: 0, storageBytes: 900 * MB });
    expect(files.alert).toBe(true);
    expect(files.figures[1]).toMatchObject({ name: "storage", over: true });
  });

  it("uses the plan's limits and threshold it is given (Pro), and treats a zero limit as full", () => {
    expect(evaluateCapacity({ dbBytes: 450 * MB, storageBytes: 0, dbLimitMb: 8192 }).alert).toBe(false);
    expect(evaluateCapacity({ dbBytes: 450 * MB, storageBytes: 0, dbLimitMb: 500, threshold: 95 }).alert).toBe(false);
    expect(evaluateCapacity({ dbBytes: 1, storageBytes: 0, dbLimitMb: 0 }).alert).toBe(true);
  });

  it("the summary says each figure in MB and marks the ones over", () => {
    const lines = summaryLines(evaluateCapacity({ dbBytes: 450 * MB, storageBytes: 10 * MB }));
    expect(lines).toEqual(["database: 450 MB of 500 MB (90%) - OVER 80%", "storage: 10 MB of 1024 MB (1%)"]);
  });
});

describe("the script", () => {
  const run = (env: Record<string, string>, args: string[] = []) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });

  it("exit 0 when there is room, 1 when over (the workflow opens the issue), 2 when it could not measure", () => {
    expect(run({ DRY_RUN_DB_BYTES: String(100 * MB) }, ["--dry-run"]).status).toBe(0);
    const over = run({ DRY_RUN_DB_BYTES: String(450 * MB) }, ["--dry-run"]);
    expect(over.status).toBe(1);
    expect(over.stdout).toContain("database: 450 MB of 500 MB (90%) - OVER 80%");
    const missing = run({});
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("CAPACITY_DB_URL is not set");
  });
});

describe("GET /api/health", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; });

  it("200 when the database's auth service answers; says nothing else", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const response = await health();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, database: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("503 when it doesn't answer, or isn't configured", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await health()).status).toBe(503);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    expect((await health()).status).toBe(503);
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect((await health()).status).toBe(503);
  });
});
