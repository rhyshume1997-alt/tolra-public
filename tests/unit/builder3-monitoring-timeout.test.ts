/** Independent supplement to #448: real alert/cron code, fake provider/budget only; never a live delivery proof. */
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
      // Deliberately fails on base 9b63382e: claim() has no deadline before the send's 8-second timer starts.
      expect(h.xeroPass, "Xero sweep was still blocked by the alert-budget RPC after the platform lifetime").toHaveBeenCalledTimes(1);
    } finally {
      // Release the fake dependency after recording failure, so the test leaves no dangling request.
      release({ data: false, error: null });
      await response;
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
