import { afterEach, describe, expect, it, vi } from "vitest";

import { postIntegrationWithCode } from "@/lib/integrations/post-with-code";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RECENT = { error: "enter a fresh code", code: "mfa_recent_required" };
afterEach(() => vi.unstubAllGlobals());

describe("postIntegrationWithCode", () => {
  it("fresh: one request, no prompt", async () => {
    const f = vi.fn(async () => json(200, { url: "u" })); vi.stubGlobal("fetch", f);
    const ask = vi.fn(async () => true);
    expect(await postIntegrationWithCode("/p", ask)).toEqual({ ok: true, body: { url: "u" } });
    expect(f).toHaveBeenCalledTimes(1); expect(ask).not.toHaveBeenCalled();
  });
  it("mfa_recent_required: asks for a code once, then sends the same request once more", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(403, RECENT)).mockResolvedValueOnce(json(200, { status: "disconnected" })); vi.stubGlobal("fetch", f);
    const ask = vi.fn(async () => true);
    expect(await postIntegrationWithCode("/p", ask)).toEqual({ ok: true, body: { status: "disconnected" } });
    expect(ask).toHaveBeenCalledTimes(1); expect(f).toHaveBeenCalledTimes(2);
  });
  it("cancelled prompt: nothing more is sent", async () => {
    const f = vi.fn(async () => json(403, RECENT)); vi.stubGlobal("fetch", f);
    const r = await postIntegrationWithCode("/p", async () => false);
    expect(r.ok).toBe(false); expect(f).toHaveBeenCalledTimes(1);
  });
  it("still refused after the code: that refusal is final (no loop)", async () => {
    const f = vi.fn(async () => json(403, RECENT)); vi.stubGlobal("fetch", f);
    const ask = vi.fn(async () => true);
    const r = await postIntegrationWithCode("/p", ask);
    expect(r).toEqual({ ok: false, error: "enter a fresh code" });
    expect(ask).toHaveBeenCalledTimes(1); expect(f).toHaveBeenCalledTimes(2);
  });
  it("other errors are final at once and show the server's words", async () => {
    const f = vi.fn(async () => json(409, { error: "This company is not connected." })); vi.stubGlobal("fetch", f);
    expect(await postIntegrationWithCode("/p", async () => true)).toEqual({ ok: false, error: "This company is not connected." });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
