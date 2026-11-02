import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runOverviewSnapshot = vi.fn();
const runIpPurge = vi.fn();
const runAiHelperPurge = vi.fn();
vi.mock("@/app/api/cron/overview-snapshot/route", () => ({ GET: runOverviewSnapshot }));
vi.mock("@/app/api/cron/ip-purge/route", () => ({ GET: runIpPurge }));
vi.mock("@/app/api/cron/ai-helper-purge/route", () => ({ GET: runAiHelperPurge }));

const SECRET = "test-only-cron-secret-0123456789";
const json = (body: unknown, status = 200) => Response.json(body, { status });

const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/cron/nightly/route");
  return GET(new Request("https://example.test/api/cron/nightly", { headers }));
};
const withSecret = { authorization: `Bearer ${SECRET}` };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  runOverviewSnapshot.mockResolvedValue(json({ companies: 3 }));
  runIpPurge.mockResolvedValue(json({ companies: 3, removed: 2 }));
  runAiHelperPurge.mockResolvedValue(json({ removed: 4, capped: false }));
});

describe("GET /api/cron/nightly", () => {
  it("401 without the secret, and neither job runs", async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ authorization: "Bearer wrong-secret-wrong-secret" })).status).toBe(401);
    expect(runOverviewSnapshot).not.toHaveBeenCalled();
    expect(runIpPurge).not.toHaveBeenCalled();
    expect(runAiHelperPurge).not.toHaveBeenCalled();
  });

  it("runs the snapshot then the purge with the same request, and returns both results", async () => {
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overviewSnapshot: { companies: 3 }, ipPurge: { companies: 3, removed: 2 }, aiHelperPurge: { removed: 4, capped: false } });
    expect(runOverviewSnapshot).toHaveBeenCalledTimes(1);
    expect(runIpPurge).toHaveBeenCalledTimes(1);
    expect(runOverviewSnapshot.mock.invocationCallOrder[0]).toBeLessThan(runIpPurge.mock.invocationCallOrder[0]);
    expect(runOverviewSnapshot.mock.calls[0][0]).toBe(runIpPurge.mock.calls[0][0]);
    // Third: the AI helper retention purge (133), same request.
    expect(runAiHelperPurge).toHaveBeenCalledTimes(1);
    expect(runIpPurge.mock.invocationCallOrder[0]).toBeLessThan(runAiHelperPurge.mock.invocationCallOrder[0]);
    expect(runAiHelperPurge.mock.calls[0][0]).toBe(runIpPurge.mock.calls[0][0]);
  });

  it("500 when the AI helper purge fails, after the other two have run", async () => {
    runAiHelperPurge.mockResolvedValue(json({ error: "Purge failed", removed: 0 }, 500));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ overviewSnapshot: { companies: 3 }, ipPurge: { companies: 3, removed: 2 }, aiHelperPurge: { error: "Purge failed", removed: 0 } });
    expect(runOverviewSnapshot).toHaveBeenCalledTimes(1);
    expect(runIpPurge).toHaveBeenCalledTimes(1);
  });

  it("500 when the snapshot answers 500, and the purge still runs", async () => {
    runOverviewSnapshot.mockResolvedValue(json({ error: "Snapshot failed" }, 500));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ overviewSnapshot: { error: "Snapshot failed" }, ipPurge: { companies: 3, removed: 2 }, aiHelperPurge: { removed: 4, capped: false } });
    expect(runIpPurge).toHaveBeenCalledTimes(1);
  });

  it("500 when the purge throws, after the snapshot has run", async () => {
    runIpPurge.mockRejectedValue(new Error("boom"));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ overviewSnapshot: { companies: 3 }, ipPurge: { error: "ip purge failed" }, aiHelperPurge: { removed: 4, capped: false } });
    expect(runOverviewSnapshot).toHaveBeenCalledTimes(1);
  });

  it("500 when the snapshot throws, and the purge still runs", async () => {
    runOverviewSnapshot.mockRejectedValue(new Error("boom"));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(runIpPurge).toHaveBeenCalledTimes(1);
  });

  it("200 when a job reports it was skipped (migration not applied)", async () => {
    runOverviewSnapshot.mockResolvedValue(json({ skipped: "not configured" }));
    expect((await call(withSecret)).status).toBe(200);
  });
});
