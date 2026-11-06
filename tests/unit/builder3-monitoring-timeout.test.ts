/** Independent supplement to #448: real alert/cron code, fake provider/budget only; never a live delivery proof. */
import { setImmediate as realImmediate, setTimeout as realSleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn(), send: vi.fn(), emailPass: vi.fn(), xeroPass: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/resend", () => ({ resend: { emails: { send: h.send } } }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/email/schedules/pass", () => ({ runEmailSchedulesPass: h.emailPass }));
vi.mock("@/lib/integrations/xero-pass", () => ({ runXeroSweepPass: h.xeroPass }));

const SECRET = "synthetic-monitoring-cron-secret-only";
const request = () => new Request("http://localhost/api/cron/daily", { headers: { authorization: `Bearer ${SECRET}` } });
const passResult = { companies: 0, sent: 0, failed: 0, needsCheck: 0, errors: 0 };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers({ now: Date.now() });
  vi.stubEnv("ALERT_EMAIL_TO", "owner@example.test");
  vi.stubEnv("EMAIL_FROM", "Synthetic Alerts <alerts@example.test>");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network allowed in monitoring tests"); }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.rpc.mockResolvedValue({ data: true, error: null });
  h.send.mockResolvedValue({ data: { id: "synthetic-only" }, error: null });
  h.emailPass.mockRejectedValue(new Error("synthetic provider failure token=DO-NOT-LEAK"));
  h.xeroPass.mockResolvedValue(passResult);
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("monitoring failure deadlines without live providers", () => {
  it("a stalled alert provider returns send-failed at eight seconds without throwing or leaking the message", async () => {
    let started = 0;
    h.send.mockImplementation(() => { started = Date.now(); return new Promise(() => {}); });
    const { reportServerError } = await import("@/lib/server/error-alert");
    let settled = false;
    const result = reportServerError({ route: "GET /synthetic-timeout", error: new Error("provider key=DO-NOT-LEAK customer@example.test") }).then(r => { settled = true; return r; });
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(7999 - (Date.now() - started));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ sent: false, reason: "send-failed" });
    expect(JSON.stringify(h.send.mock.calls)).not.toContain("DO-NOT-LEAK");
    expect(JSON.stringify(h.send.mock.calls)).not.toContain("customer@example.test");
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("daily cron still runs the Xero pass after the alert provider times out", async () => {
    h.send.mockImplementation(() => new Promise(() => {}));
    const { GET } = await import("@/app/api/cron/daily/route");
    const response = GET(request());
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(h.xeroPass).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.xeroPass).toHaveBeenCalledTimes(1);
    const r = await response;
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ emailSchedules: { error: "e-mail schedules failed" }, xeroSweep: passResult });
    expect(JSON.stringify(h.send.mock.calls)).not.toContain("DO-NOT-LEAK");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a stalled alert-budget database RPC must not block Xero for the daily route's whole 60-second lifetime", async () => {
    let release: (value: { data: boolean; error: null }) => void = () => {};
    h.rpc.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { GET, maxDuration } = await import("@/app/api/cron/daily/route");
    expect(maxDuration).toBe(60);
    const response = GET(request());
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledWith("claim_error_alert", expect.any(Object)));
    await vi.advanceTimersByTimeAsync(maxDuration * 1000);
    try {
      // Failed on base 9b63382e (claim() had no deadline); passes now that the budget claim is bounded.
      expect(h.xeroPass, "Xero sweep was still blocked by the alert-budget RPC after the platform lifetime").toHaveBeenCalledTimes(1);
    } finally {
      // Release the fake dependency after recording failure, so the test leaves no dangling request.
      release({ data: false, error: null });
      await response;
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("alert budget claim: one bounded, abortable lookup with the in-memory budget as fallback", () => {
  const hang = () => new Promise(() => {});
  const word = (i: number) => `boom ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`; // fingerprints collapse digits
  const logged = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => c.join(" "));
  /** Waits until the claim's rpc has started, so its deadline timer exists before the fake clock moves. */
  const started = async (n = 1) => { for (let i = 0; i < 5000 && h.rpc.mock.calls.length < n; i++) await realSleep(1); expect(h.rpc).toHaveBeenCalledTimes(n); }; // not vi.waitFor: under fake timers it advances the clock
  const report = async (m: string) => (await import("@/lib/server/error-alert")).reportServerError({ route: "GET /synthetic", error: new Error(m) });

  it("falls back at the 3 s deadline (not before), logs once, and leaves no timers", async () => {
    h.rpc.mockImplementation(hang);
    const { BUDGET_DEADLINE_MS } = await import("@/lib/server/error-alert");
    expect(BUDGET_DEADLINE_MS).toBe(3000);
    let result: unknown;
    const pending = report("stalled budget").then(r => { result = r; });
    await started();
    await vi.advanceTimersByTimeAsync(BUDGET_DEADLINE_MS - 1);
    expect(result).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toEqual({ sent: true, reason: "sent" });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(logged().filter(l => l.includes("budget lookup timed out"))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late resolution or rejection after the deadline is ignored: no unhandled rejection, no extra log", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let reject: (e: Error) => void = () => {};
      h.rpc.mockImplementationOnce(() => new Promise((_, rej) => { reject = rej; }));
      const first = report("late reject one");
      await started(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await first).reason).toBe("sent");
      reject(Object.assign(new Error("secret-late-text"), { name: "LateError" }));
      let resolve: (v: unknown) => void = () => {};
      h.rpc.mockImplementationOnce(() => new Promise(res => { resolve = res; }));
      const second = report("late resolve two");
      await started(2);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await second).reason).toBe("sent");
      resolve({ data: false, error: { code: "XX" } });
      await vi.advanceTimersByTimeAsync(10);
      await realImmediate();
      expect(unhandled).toEqual([]);
      expect(logged().join("\n")).not.toMatch(/LateError|secret-late-text|XX/);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });

  it("the fallback enforces one alert per fingerprint per hour and 20 per day", async () => {
    h.rpc.mockImplementation(hang);
    let n = 0;
    const run = async (m: string) => { const p = report(m); await started(++n); await vi.advanceTimersByTimeAsync(3000); return (await p).reason; };
    expect(await run("same error")).toBe("sent");
    expect(await run("same error")).toBe("rate-limited");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(await run("same error")).toBe("sent"); // an hour later, same fingerprint is allowed again (2 sent so far)
    for (let i = 0; i < 18; i++) expect(await run(word(i))).toBe("sent"); // 20 sent in all
    expect(await run(word(30))).toBe("rate-limited");
    expect(h.send).toHaveBeenCalledTimes(20);
  });

  it("logs the error code or name only, and keeps redaction exactly as before", async () => {
    h.rpc.mockRejectedValue(Object.assign(new Error("db text token=DO-NOT-LEAK"), { name: "PgError" }));
    const r = await report("failure token=abc123secret for customer@example.test");
    expect(r.reason).toBe("sent");
    expect(logged()).toContain("[error-alert] budget check failed PgError");
    expect(logged().join("\n")).not.toMatch(/DO-NOT-LEAK|abc123secret|customer@example/);
    const body = JSON.stringify(h.send.mock.calls);
    expect(body).not.toMatch(/abc123secret|customer@example\.test/);
  });

  it("passes an abort signal when the client supports it, aborts it at the deadline, and leaves the happy path alone", async () => {
    const signals: AbortSignal[] = [];
    h.rpc.mockImplementation(() => { const p: Promise<unknown> & { abortSignal?: (s: AbortSignal) => unknown } = hang(); p.abortSignal = (s) => { signals.push(s); return p; }; return p; });
    const pending = report("abortable");
    await started();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).reason).toBe("sent");
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);

    h.rpc.mockReset(); signals.length = 0;
    h.rpc.mockImplementation(() => { const p: Promise<unknown> & { abortSignal?: (s: AbortSignal) => unknown } = Promise.resolve({ data: true, error: null }); p.abortSignal = (s) => { signals.push(s); return p; }; return p; });
    expect((await report("healthy path")).reason).toBe("sent");
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("claim_error_alert", { p_fingerprint: expect.any(String) });
    expect(signals[0].aborted).toBe(false);
  });

  it("the daily cron still runs Xero after an email-pass throw while the budget RPC hangs, and the caller sees its own error", async () => {
    h.rpc.mockImplementation(hang);
    const { GET } = await import("@/app/api/cron/daily/route");
    const response = GET(request());
    await started();
    expect(h.xeroPass).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.xeroPass).toHaveBeenCalledTimes(1);
    const r = await response;
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ emailSchedules: { error: "e-mail schedules failed" }, xeroSweep: passResult });
    expect(JSON.stringify(h.send.mock.calls)).not.toContain("DO-NOT-LEAK");
  });
});
