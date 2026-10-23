/**
 * Job e-mail outcomes (migration 033): a definite refusal by the provider is "failed" (retry allowed); a network error, a
 * timeout or a server error is "unknown" (no automatic retry, an admin settles it). Real route handlers, fake Supabase client
 * and provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

type Who = { role: string; org: string };
let who: Who;
let rpcResults: Record<string, { data?: unknown; error?: { code: string; message: string; hint?: string } | null }>;
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const sends: Array<{ payload: Record<string, unknown>; options: Record<string, unknown> }> = [];
let providerAnswer: () => Promise<{ data?: unknown; error?: { name: string; statusCode: number | null; message: string } | null }>;

const ORG = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const JOB = "7b0f4a3c-1d2e-4c5b-8f6a-123456789abc";
const HISTORY = "11111111-4f50-4a6b-8c7d-9e0f1a2b3c4d";

const chain = (result: unknown) => {
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" || prop === "single" ? () => Promise.resolve({ data: result, error: null }) : () => c) });
  return c;
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => (table === "user_profiles"
      ? chain({ id: "user-1", email: "a@example.test", full_name: "A", role: who.role, secondary_role: null, organization_id: who.org, active: true, must_change_password: false })
      : chain(table === "jobs" ? { id: JOB, organization_id: who.org, customer_email: "buyer@example.test" } : null)),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "current_user_organization_id") return { data: who.org, error: null };
      if (name === "has_org_role") return { data: (args.allowed_roles as string[]).includes(who.role), error: null };
      return { error: null, data: null, ...rpcResults[name] };
    },
  }),
}));

vi.mock("@/lib/resend", () => ({
  resend: { emails: { send: async (payload: Record<string, unknown>, options: Record<string, unknown>) => { sends.push({ payload, options }); return providerAnswer(); } } },
}));

import { POST as sendJob } from "@/app/api/send-job/route";
import { POST as resolveJob } from "@/app/api/send-job/resolve/route";
import { classifyProviderError, sendWithOutcome } from "@/lib/send-outcome";

const post = (url: string, body: unknown) => new Request(`https://app.test${url}`, { method: "POST", body: JSON.stringify(body) });
const request = { job_id: JOB, recipient_email: "buyer@example.test", subject: "Job sheet", body: "Synthetic.", idempotency_key: "key-12345678" };
const completed = () => rpcCalls.filter((c) => c.name === "complete_job_email").map((c) => c.args.p_outcome);

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.EMAIL_FROM = "Test <notifications@example.test>";
  who = { role: "office", org: ORG };
  rpcResults = { reserve_job_email: { data: { history_id: HISTORY, replay: false, status: "sending" } } };
  rpcCalls.length = 0;
  sends.length = 0;
  providerAnswer = async () => ({ data: { id: "x" }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("classifying the provider's answer", () => {
  it("accepted, definite refusals, and everything else unknown", () => {
    expect(classifyProviderError(null)).toBe("accepted");
    expect(classifyProviderError({ name: "validation_error", statusCode: 422 })).toBe("failed");
    expect(classifyProviderError({ name: "invalid_api_key", statusCode: 401 })).toBe("failed");
    expect(classifyProviderError({ name: "rate_limit_exceeded", statusCode: 429 })).toBe("failed");
    // Not proof of a refusal:
    expect(classifyProviderError({ name: "application_error", statusCode: null })).toBe("unknown"); // no network
    expect(classifyProviderError({ name: "application_error", statusCode: 500 })).toBe("unknown");
    expect(classifyProviderError({ name: "internal_server_error", statusCode: 503 })).toBe("unknown");
    expect(classifyProviderError({ name: "concurrent_idempotent_requests", statusCode: 409 })).toBe("unknown");
    expect(classifyProviderError({ name: "application_error", statusCode: 408 })).toBe("unknown");
    expect(classifyProviderError({ name: "application_error", statusCode: 404 })).toBe("unknown"); // a proxy's page, no Resend body
    expect(classifyProviderError({})).toBe("unknown");
  });

  it("a thrown error or a slow provider is unknown, and the timer is cleaned up", async () => {
    expect((await sendWithOutcome(async () => { throw new Error("socket hang up"); })).outcome).toBe("unknown");
    vi.useFakeTimers();
    const slow = sendWithOutcome(() => new Promise(() => undefined), 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await slow).toEqual({ outcome: "unknown", detail: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("POST /api/send-job", () => {
  it("accepted: sent, outcome recorded as accepted", async () => {
    const response = await sendJob(post("/api/send-job", request));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "sent" });
    expect(completed()).toEqual(["accepted"]);
    expect(sends).toHaveLength(1);
    expect(sends[0].options).toEqual({ idempotencyKey: "job-email/key-12345678" });
  });

  it("a rejection by the provider (a 4xx with its own error): failed, retry allowed", async () => {
    providerAnswer = async () => ({ data: null, error: { name: "validation_error", statusCode: 422, message: "Invalid `to` field" } });
    const response = await sendJob(post("/api/send-job", request));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: "failed" });
    expect(completed()).toEqual(["failed"]);
    // The database allows the same key again after a failure: the route sends again (reservation says replay: false).
    rpcResults.reserve_job_email = { data: { history_id: HISTORY, replay: false, status: "sending" } };
    providerAnswer = async () => ({ data: { id: "x" }, error: null });
    expect(await (await sendJob(post("/api/send-job", request))).json()).toEqual({ status: "sent" });
    expect(sends).toHaveLength(2);
  });

  it("a timeout is unknown, not failed", async () => {
    vi.useFakeTimers();
    providerAnswer = () => new Promise(() => undefined);
    const pending = sendJob(post("/api/send-job", request));
    await vi.advanceTimersByTimeAsync(16_000);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: "unknown" });
    expect(completed()).toEqual(["unknown"]);
  });

  it.each([
    ["a network error", async () => ({ data: null, error: { name: "application_error", statusCode: null, message: "Unable to fetch data." } })],
    ["a server error", async () => ({ data: null, error: { name: "application_error", statusCode: 500, message: "Internal server error." } })],
    ["an exception", async () => { throw new Error("ECONNRESET"); }],
  ])("%s is unknown", async (_name, answer) => {
    providerAnswer = answer;
    const response = await sendJob(post("/api/send-job", request));
    expect(await response.json()).toMatchObject({ status: "unknown" });
    expect(completed()).toEqual(["unknown"]);
  });

  it("no blind retry: the same request after an unknown outcome is not sent again", async () => {
    rpcResults.reserve_job_email = { data: { history_id: HISTORY, replay: true, status: "unknown" } };
    const response = await sendJob(post("/api/send-job", request));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "unknown" });
    expect(sends).toHaveLength(0);
    expect(completed()).toEqual([]);
  });

  it("a sent one replays as sent without a second send", async () => {
    rpcResults.reserve_job_email = { data: { history_id: HISTORY, replay: true, status: "sent_via_system" } };
    expect(await (await sendJob(post("/api/send-job", request))).json()).toEqual({ status: "sent" });
    expect(sends).toHaveLength(0);
  });

  it("if the outcome can't be written, the answer is still given and nothing is retried", async () => {
    providerAnswer = async () => ({ data: null, error: { name: "application_error", statusCode: null, message: "Unable to fetch data." } });
    rpcResults.complete_job_email = { error: { code: "XX000", message: "db down" } };
    const response = await sendJob(post("/api/send-job", request));
    expect(await response.json()).toMatchObject({ status: "unknown" });
    expect(sends).toHaveLength(1);
  });
});

describe("POST /api/send-job/resolve (admin settles an unknown send)", () => {
  it("an admin settles it as sent or not sent, and the decision is audited", async () => {
    who = { role: "admin", org: ORG };
    rpcResults.resolve_job_email = { data: HISTORY };
    const response = await resolveJob(post("/api/send-job/resolve", { historyId: HISTORY, as: "failed" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "failed" });
    expect(rpcCalls.find((c) => c.name === "resolve_job_email")?.args).toEqual({ p_history: HISTORY, p_as: "failed" });
    expect(rpcCalls.find((c) => c.name === "write_audit")?.args).toMatchObject({ p_entity_table: "email_history", p_entity_id: HISTORY, p_new: { outcome: "failed", resolved_by_admin: true } });
  });

  it("office can't, and nothing is called", async () => {
    const response = await resolveJob(post("/api/send-job/resolve", { historyId: HISTORY, as: "sent" }));
    expect(response.status).toBe(403);
    expect(rpcCalls.find((c) => c.name === "resolve_job_email")).toBeUndefined();
  });

  it("answers the database's refusals: not found, not unknown, and the second-step requirement", async () => {
    who = { role: "admin", org: ORG };
    rpcResults.resolve_job_email = { error: { code: "P0002", message: "Send not found" } };
    expect((await resolveJob(post("/api/send-job/resolve", { historyId: HISTORY, as: "sent" }))).status).toBe(404);
    rpcResults.resolve_job_email = { error: { code: "PT409", message: "Only an unknown outcome can be resolved" } };
    expect((await resolveJob(post("/api/send-job/resolve", { historyId: HISTORY, as: "sent" }))).status).toBe(409);
    rpcResults.resolve_job_email = { error: { code: "42501", message: "Confirm", hint: "mfa_required" } };
    const mfa = await resolveJob(post("/api/send-job/resolve", { historyId: HISTORY, as: "sent" }));
    expect(mfa.status).toBe(403);
    expect(await mfa.json()).toMatchObject({ code: "mfa_required" });
  });

  it("rejects a malformed request", async () => {
    who = { role: "admin", org: ORG };
    expect((await resolveJob(post("/api/send-job/resolve", { historyId: "nope", as: "sent" }))).status).toBe(400);
    expect((await resolveJob(post("/api/send-job/resolve", { historyId: HISTORY, as: "maybe" }))).status).toBe(400);
  });
});
