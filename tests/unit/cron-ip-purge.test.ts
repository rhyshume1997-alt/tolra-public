import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const order = vi.fn();
const reportServerError = vi.fn(async (_input: { route: string; error: Error; source?: string }) => ({ sent: false, reason: "disabled" }));
let admin: { from: () => unknown; rpc: typeof rpc } | null;

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError }));

const SECRET = "test-only-cron-secret-0123456789";
const IP = "203.0.113.77";

const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/cron/ip-purge/route");
  return GET(new Request("https://example.test/api/cron/ip-purge", { headers }));
};
const withSecret = { authorization: `Bearer ${SECRET}` };

let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  order.mockResolvedValue({ data: [{ id: "org-a" }, { id: "org-b" }], error: null });
  admin = { from: () => ({ select: () => ({ order }) }), rpc };
  logs = [];
  for (const level of ["log", "error", "warn"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
});

describe("GET /api/cron/ip-purge: who may call it", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer wrong-secret-wrong-secret" }],
    ["a prefix of the secret", { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ["the secret without Bearer", { authorization: SECRET }],
    ["the secret in another header", { "x-cron-secret": SECRET }],
  ])("401 with %s, and nothing is read or deleted", async (_name, headers) => {
    const res = await call(headers);
    expect(res.status).toBe(401);
    expect(order).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
  });

  it.each([["unset", undefined], ["empty", ""], ["too short", "short"]])("401 for every call when CRON_SECRET is %s (never open by default)", async (_name, value) => {
    if (value === undefined) vi.stubEnv("CRON_SECRET", undefined as unknown as string);
    else vi.stubEnv("CRON_SECRET", value);
    for (const headers of [withSecret, { authorization: "Bearer " }, { authorization: `Bearer ${value ?? ""}` }, {}]) {
      expect((await call(headers)).status).toBe(401);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/ip-purge: the purge", () => {
  it("purges each company once with the batch size and returns counts only", async () => {
    rpc.mockResolvedValueOnce({ data: 3, error: null }).mockResolvedValueOnce({ data: 0, error: null });
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ companies: 2, removed: 3, capped: 0 });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "site_network_ip_purge", { p_org: "org-a", p_limit: 500 });
    expect(rpc).toHaveBeenNthCalledWith(2, "site_network_ip_purge", { p_org: "org-b", p_limit: 500 });
  });

  it("keeps going while a company still returns a full batch, and totals them", async () => {
    rpc.mockResolvedValueOnce({ data: 500, error: null }).mockResolvedValueOnce({ data: 120, error: null }).mockResolvedValueOnce({ data: 0, error: null });
    expect(await (await call(withSecret)).json()).toEqual({ companies: 2, removed: 620, capped: 0 });
    expect(rpc.mock.calls.map((c) => c[1].p_org)).toEqual(["org-a", "org-a", "org-b"]);
  });

  it("stops a company that never runs dry at the cap and says so; the next run carries on", async () => {
    rpc.mockResolvedValue({ data: 500, error: null });
    const body = await (await call(withSecret)).json();
    expect(body).toEqual({ companies: 2, removed: 2 * 40 * 500, capped: 2 });
    expect(rpc).toHaveBeenCalledTimes(80);
  });

  it("is safe to run twice: the second run finds nothing", async () => {
    rpc.mockResolvedValueOnce({ data: 7, error: null }).mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValue({ data: 0, error: null });
    expect(await (await call(withSecret)).json()).toEqual({ companies: 2, removed: 7, capped: 0 });
    expect(await (await call(withSecret)).json()).toEqual({ companies: 2, removed: 0, capped: 0 });
  });

  it("no companies: nothing to do", async () => {
    order.mockResolvedValue({ data: [], error: null });
    expect(await (await call(withSecret)).json()).toEqual({ companies: 0, removed: 0, capped: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/ip-purge: failures and what is never shown", () => {
  it("a database error: 500 with counts so far, an alert, and no address, secret or database text anywhere", async () => {
    rpc.mockResolvedValueOnce({ data: 4, error: null }).mockResolvedValueOnce({ data: null, error: { code: "42501", message: `permission denied for ${IP}` } });
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Purge failed", companies: 2, removed: 4 });
    expect(reportServerError).toHaveBeenCalledTimes(1);
    const everything = JSON.stringify([body, logs, reportServerError.mock.calls.map(([arg]) => arg.error.message)]);
    expect(everything).not.toContain(IP);
    expect(everything).not.toContain(SECRET);
    expect(everything).toContain("42501");
  });

  it("no service key configured: 500, alert, nothing deleted", async () => {
    admin = null;
    expect((await call(withSecret)).status).toBe(500);
    expect(reportServerError).toHaveBeenCalledTimes(1);
  });

  it("the company list failing: 500", async () => {
    order.mockResolvedValue({ data: null, error: { code: "08006", message: "down" } });
    expect((await call(withSecret)).status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an exception is a 500 too, naming only its type", async () => {
    rpc.mockRejectedValue(new TypeError(`fetch failed for ${IP}`));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(JSON.stringify([await res.json(), logs])).not.toContain(IP);
  });

  it("a successful run logs counts only", async () => {
    rpc.mockResolvedValue({ data: 0, error: null });
    await call(withSecret);
    expect(logs).toEqual(["[cron/ip-purge] companies=2 removed=0 capped=0"]);
  });
});

describe("vercel.json", () => {
  it("runs the purge route once a day (and the Overview's owed snapshot, tests/unit/cron-overview-snapshot.test.ts)", async () => {
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(config.crons).toEqual([
      { path: "/api/cron/ip-purge", schedule: expect.stringMatching(/^\d{1,2} \d{1,2} \* \* \*$/) },
      { path: "/api/cron/overview-snapshot", schedule: expect.stringMatching(/^\d{1,2} \d{1,2} \* \* \*$/) },
    ]);
  });
});
