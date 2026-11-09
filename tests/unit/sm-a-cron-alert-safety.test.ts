/**
 * The cron "missing migration" alert (lib/server/cron-skip.ts) must never make a cron worse: it never throws, it is bounded in time, it is off without
 * ALERT_EMAIL_TO, and repeated skips do not flood the owner. Uses the real error-alert module with a fake mail provider and a fake database budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

const sent: Array<{ payload: { to: string[]; subject: string; text: string } }> = [];
let sendImpl: () => Promise<{ error?: { name: string } | null }>;
let adminAvailable = true;
let claimImpl: () => Promise<{ data?: unknown; error?: { code: string } | null }>;

vi.mock("@/lib/resend", () => ({ resend: { emails: { send: async (payload: never) => { sent.push({ payload }); return sendImpl(); } } } }));
vi.mock("@/lib/server/supabase-admin", () => ({
  createSupabaseAdminClient: () => (adminAvailable ? { rpc: () => { const r = claimImpl(); return Object.assign(r, { abortSignal: () => r }); } } : null),
}));

import { alertIfMigrationSkip, alertMissingMigration, migrationSkipReason } from "@/lib/server/cron-skip";

const ENV = ["ALERT_EMAIL_TO", "EMAIL_FROM", "VERCEL_ENV"];
const saved: Record<string, string | undefined> = {};
const on = () => Object.assign(process.env, { ALERT_EMAIL_TO: "owner@example.test", EMAIL_FROM: "Tolra <alerts@example.test>", VERCEL_ENV: "production" });

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  sent.length = 0;
  adminAvailable = true;
  claimImpl = async () => ({ data: true, error: null });
  sendImpl = async () => ({ error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

describe("a cron alert cannot itself cause another failure", () => {
  it("missing ALERT_EMAIL_TO: resolves, sends nothing", async () => {
    await expect(alertMissingMigration("/api/cron/x", "job", "database update 133 not applied")).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("not production (VERCEL_ENV=preview): resolves, sends nothing", async () => {
    on(); process.env.VERCEL_ENV = "preview";
    await expect(alertMissingMigration("/api/cron/x", "job", "database update 133 not applied")).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("the mail provider throws: resolves", async () => {
    on(); sendImpl = async () => { throw new Error("provider down"); };
    await expect(alertMissingMigration("/api/cron/x", "job", "database update 116 not applied")).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("the mail provider answers with an error: resolves", async () => {
    on(); sendImpl = async () => ({ error: { name: "rate_limit_exceeded" } });
    await expect(alertMissingMigration("/api/cron/x", "job", "database update 116 not applied")).resolves.toBeUndefined();
  });

  it("the budget database throws or is unavailable: resolves and still sends at most once (in-memory budget)", async () => {
    on(); claimImpl = async () => { throw new Error("db down"); };
    await expect(alertMissingMigration("/api/cron/budget-throws", "job-a", "database update 108 not applied")).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    adminAvailable = false;
    await expect(alertMissingMigration("/api/cron/no-admin", "job-b", "database update 127 not applied")).resolves.toBeUndefined();
  });

  it("repeated skips of the same job do not flood: ten calls send one mail (memory budget)", async () => {
    on(); adminAvailable = false;
    for (let i = 0; i < 10; i++) await alertMissingMigration("/api/cron/flood", "flood-job", "database update 133 not applied");
    expect(sent).toHaveLength(1);
  });

  it("the database budget saying 'rate limited' is honoured: second call sends nothing", async () => {
    on(); let n = 0;
    claimImpl = async () => ({ data: n++ === 0, error: null });
    await alertMissingMigration("/api/cron/db-budget", "db-budget-job", "database update 133 not applied");
    await alertMissingMigration("/api/cron/db-budget", "db-budget-job", "database update 133 not applied");
    expect(sent).toHaveLength(1);
  });

  it("the alert text is fixed and carries no secret, id or request data", async () => {
    on(); adminAvailable = false;
    await alertMissingMigration("/api/cron/text", "text-job", "database update 116 not applied");
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.text).toMatch(/Cron skipped: text-job: database update 116 not applied/);
    process.env.CRON_SECRET = "s3cr3t-value-that-must-not-leak-1234567890";
    expect(sent[0].payload.text).not.toContain(process.env.CRON_SECRET);
    delete process.env.CRON_SECRET;
    expect(sent[0].payload.text).not.toMatch(/Bearer\s+\S+/i);
  });

  it("a stalled mail provider cannot hold the cron for long: the alert gives up within 3 seconds", async () => {
    on(); adminAvailable = false;
    vi.useFakeTimers();
    sendImpl = () => new Promise(() => undefined); // never answers
    let done = false;
    const p = alertMissingMigration("/api/cron/stall", "stall-job", "database update 133 not applied").then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3100);
    expect(done).toBe(true);
    await p;
  });

  it("alertIfMigrationSkip returns the pass result unchanged, whatever the alert does", async () => {
    on(); sendImpl = async () => { throw new Error("provider down"); };
    const result = { skipped: "database update 108 not applied" };
    await expect(alertIfMigrationSkip("/api/cron/same", "email", result)).resolves.toBe(result);
    const ok = { sent: 3 };
    await expect(alertIfMigrationSkip("/api/cron/same", "email", ok)).resolves.toBe(ok);
    expect(migrationSkipReason({ skipped: "not configured" })).toBeNull();
  });
});
