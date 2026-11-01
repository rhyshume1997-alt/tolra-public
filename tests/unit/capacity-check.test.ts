/**
 * Capacity alerts (scripts/capacity-check.mjs) and the health answer the outage check reads.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateCapacity, summaryLines } from "../../scripts/capacity-check.mjs";
import { GET as health } from "@/app/api/health/route";

vi.mock("server-only", () => ({}));

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
  const ORIGIN = "http://127.0.0.1:1";
  // Routes by URL: the auth service's health endpoint, and the one table-free database function the probe calls through PostgREST.
  const stack = (auth: () => Response | Promise<Response>, rpc: () => Response | Promise<Response>) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("/auth/v1/health")) return auth();
      if (url.includes("/rest/v1/rpc/booking_day_plan_ok")) return rpc();
      throw new Error(`unexpected request ${url}`);
    }));
    return calls;
  };
  const up = () => new Response("{}", { status: 200 });
  const rpcUp = () => new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
  const rpcDown = () => new Response(JSON.stringify({ message: "connection to database failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
  const unhealthy = async () => {
    const response = await health();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, database: false });
  };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGIN;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY; });

  it("200 when the auth service and a database query both answer; says nothing else", async () => {
    const calls = stack(up, rpcUp);
    const response = await health();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, database: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // No table is read: the only database call is the constant-answer function.
    expect(calls.filter((url) => url.includes("/rest/v1/"))).toEqual([`${ORIGIN}/rest/v1/rpc/booking_day_plan_ok`]);
  });

  it("503 when the auth service is down but the database answers", async () => {
    stack(() => new Response("", { status: 502 }), rpcUp);
    await unhealthy();
    stack(() => { throw new TypeError("fetch failed"); }, rpcUp);
    await unhealthy();
  });

  it("503 when the auth service is up but a database query fails", async () => {
    stack(up, rpcDown);
    await unhealthy();
    stack(up, () => { throw new TypeError("fetch failed"); });
    await unhealthy();
    stack(up, () => new Response("", { status: 503 })); // PostgREST behind the gateway is unreachable
    await unhealthy();
  });

  it("503 when both are down", async () => {
    stack(() => new Response("", { status: 502 }), rpcDown);
    await unhealthy();
  });

  it("503 when the database does not answer within the timeout", async () => {
    // AbortSignal.timeout is native (not faked): shorten the probe's 5 s so the test stays quick, and assert it asked for 5 s.
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeouts: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { timeouts.push(ms); return real(50); });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/health")) return Promise.resolve(up());
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError"))));
    }));
    const response = await health();
    expect(timeouts).toEqual([5000, 5000]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, database: false });
  });

  it("503 when it isn't configured (no URL, anon key or service key)", async () => {
    stack(up, rpcUp);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await unhealthy();
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await unhealthy();
  });
});
