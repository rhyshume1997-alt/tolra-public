/** xAI adapter (AI-3): mock fetch only, no network. URL, headers, body, mapping, errors, key never leaked. */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AiProviderError, type AiCompletionRequest } from "@/lib/ai-helper/provider";
import { XAI_MODEL_ALLOWLIST, xaiProvider, type XaiModelSpec } from "@/lib/ai-helper/providers/xai";
import type { UsdGbpRate } from "@/lib/ai-helper/fx";
import { MAX_REQUEST_PENCE_GBP, MODEL_PRICES_GBP, type ModelPrice, actualPenceGbp, estimatePenceGbp } from "@/lib/ai-helper/pricing-gbp";

const KEY = "sk-test-SECRET-KEY-123";
const req: AiCompletionRequest = {
  model: "grok-test-mini",
  system: "SYSTEM PROMPT",
  data: '{"text":"hello"}',
  schema: { type: "object" },
  maxOutputTokens: 500,
  effort: "low",
  timeoutMs: 5000,
  apiKey: KEY,
};

const ok = (over: Record<string, unknown> = {}, finish = "stop", content: unknown = '{"a":1}') =>
  new Response(JSON.stringify({ model: "grok-test-mini-2025", choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7 }, ...over }), { status: 200 });
// Test-only allow-list: the real constant is empty until Rhys/PM confirm models from xAI's docs. Names here are placeholders.
const ALLOW: Record<string, XaiModelSpec> = {
  "grok-test-mini": { outputLimitParam: "max_completion_tokens", structured: "json_schema" },
  "legacy-test": { outputLimitParam: "max_tokens", structured: "json_object" },
};
const ZERO = { inputTokens: 0, outputTokens: 0 };
const run = (fn: () => Promise<Response>) => {
  const f = vi.fn(fn);
  return { f, p: xaiProvider(f as never, ALLOW) };
};
/** A no-usage failure must settle in full: unavailable, not rejected, no usage. */
const expectFullReservation = (e: AiProviderError) => {
  expect(e).toBeInstanceOf(AiProviderError);
  expect(e.kind).toBe("unavailable");
  expect(e.rejectedBeforeWork).toBe(false);
  expect(e.usage).toEqual(ZERO);
};
const fail = async (p: ReturnType<typeof xaiProvider>, over: Partial<AiCompletionRequest> = {}): Promise<AiProviderError> => {
  try {
    await p.complete({ ...req, ...over });
  } catch (e) {
    return e as AiProviderError;
  }
  throw new Error("did not throw");
};

describe("xai adapter", () => {
  it("id is xai", () => expect(xaiProvider().id).toBe("xai"));

  it("the shipped allow-list is empty (no model confirmed yet)", () => expect(Object.keys(XAI_MODEL_ALLOWLIST)).toEqual([]));

  it("allow-list entry controls the output-limit parameter and structured mode", async () => {
    const { f, p } = run(async () => ok());
    await p.complete({ ...req, model: "legacy-test" });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.max_tokens).toBe(500);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("success: exact URL, method, headers, body; json and usage returned", async () => {
    const { f, p } = run(async () => ok());
    const out = await p.complete(req);
    expect(out).toEqual({ json: { a: 1 }, usage: { inputTokens: 11, outputTokens: 7 }, model: "grok-test-mini-2025" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "grok-test-mini",
      stream: false,
      max_completion_tokens: 500,
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: '{"text":"hello"}' },
      ],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: { type: "object" } } },
    });
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it.each([
    [400, undefined, true],
    [401, "auth", true],
    [403, "auth", true],
    [404, undefined, true],
    [413, undefined, true],
    [429, "rate", true],
    [500, undefined, false],
    [503, undefined, false],
  ])("status %i maps to unavailable, detail %s, rejectedBeforeWork %s, one fetch", async (status, detail, rejected) => {
    const { f, p } = run(async () => new Response(`{"error":{"message":"PROVIDER BODY ${KEY}"}}`, { status }));
    const e = await fail(p);
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.kind).toBe("unavailable");
    expect(e.detail).toBe(detail);
    expect(e.rejectedBeforeWork).toBe(rejected);
    expect(e.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("401: the key, prompt and provider body are not in the error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { p } = run(async () => new Response(`{"error":{"message":"bad key ${KEY}"}}`, { status: 401 }));
    const e = await fail(p);
    for (const s of [e.message, String(e), JSON.stringify(e)]) {
      expect(s).not.toContain(KEY);
      expect(s).not.toContain("SYSTEM PROMPT");
      expect(s).not.toContain("bad key");
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("network error and timeout: unavailable, not rejected, key not in error", async () => {
    for (const err of [new TypeError(`fetch failed ${KEY}`), new DOMException("timed out", "TimeoutError")]) {
      const { f, p } = run(async () => {
        throw err;
      });
      const e = await fail(p);
      expectFullReservation(e);
      expect(e.detail).toBeUndefined();
      expect(e.message).not.toContain(KEY);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("truncated (length) is invalid, with usage, not rejected", async () => {
    const e = await fail(run(async () => ok({}, "length", '{"a":')).p);
    expect(e.kind).toBe("invalid");
    expect(e.rejectedBeforeWork).toBe(false);
    expect(e.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("a message.refusal on a normal stop is refused, with usage", async () => {
    const e = await fail(run(async () => ok({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] })).p);
    expect(e.kind).toBe("refused");
    expect(e.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("content_filter is refused, with usage", async () => {
    const e = await fail(run(async () => ok({}, "content_filter", null)).p);
    expect(e.kind).toBe("refused");
    expect(e.rejectedBeforeWork).toBe(false);
    expect(e.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("unknown finish reason, missing choices, non-string content are invalid WITH real usage", async () => {
    for (const r of [run(async () => ok({}, "tool_calls")), run(async () => ok({ choices: [] })), run(async () => ok({}, "stop", null))]) {
      const e = await fail(r.p);
      expect(e.kind).toBe("invalid");
      expect(e.rejectedBeforeWork).toBe(false);
      expect(e.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    }
  });

  it("malformed answer JSON is invalid with usage; unparseable envelope is unavailable, full reservation", async () => {
    const e = await fail(run(async () => ok({}, "stop", "not json")).p);
    expect(e.kind).toBe("invalid");
    expect(e.rejectedBeforeWork).toBe(false);
    expect(e.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expectFullReservation(await fail(run(async () => new Response("<html>", { status: 200 })).p));
  });

  it("no body and empty body are unavailable, full reservation", async () => {
    expectFullReservation(await fail(run(async () => new Response(null, { status: 200 })).p));
    expectFullReservation(await fail(run(async () => new Response("", { status: 200 })).p));
  });

  it("body over 256 KB is unavailable, full reservation", async () => {
    expectFullReservation(await fail(run(async () => new Response("x".repeat(256 * 1024 + 1), { status: 200 })).p));
  });

  it("missing or partial usage is never 0: always unavailable, not rejected, whatever the finish reason", async () => {
    expectFullReservation(await fail(run(async () => ok({ usage: undefined })).p));
    expectFullReservation(await fail(run(async () => ok({ usage: { prompt_tokens: 5 } })).p));
    for (const finish of ["stop", "length", "content_filter"]) {
      expectFullReservation(await fail(run(async () => ok({ usage: { completion_tokens: 3 } }, finish)).p));
    }
  });

  it("output is never under-counted: max(completion, total - prompt) when total is present, else completion + reasoning", async () => {
    const usage = async (u: Record<string, unknown>) => (await run(async () => ok({ usage: u })).p.complete(req)).usage;
    expect(await usage({ prompt_tokens: 11, completion_tokens: 40 })).toEqual({ inputTokens: 11, outputTokens: 40 });
    expect(await usage({ prompt_tokens: 11, completion_tokens: 10, total_tokens: 61 })).toEqual({ inputTokens: 11, outputTokens: 50 });
    expect(await usage({ prompt_tokens: 11, completion_tokens: 40, total_tokens: 20 })).toEqual({ inputTokens: 11, outputTokens: 40 });
    expect(await usage({ prompt_tokens: 11, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 30 } })).toEqual({ inputTokens: 11, outputTokens: 40 });
  });

  it("body over the byte cap (counted in bytes, while streaming) is unavailable, full reservation", async () => {
    expectFullReservation(await fail(run(async () => new Response("é".repeat(140 * 1024), { status: 200 })).p));
  });

  it("a non-200 response body is cancelled", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    await fail(run(async () => new Response(stream, { status: 500 })).p);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("the timeout covers reading the body", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(stream, { status: 200 });
    });
    expectFullReservation(await fail(xaiProvider(f as never, ALLOW), { timeoutMs: 30 }));
  });

  it("never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await run(async () => ok()).p.complete(req);
    await fail(run(async () => new Response("x", { status: 500 })).p);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });

  it("a model not on the allow-list makes zero fetch calls (rejectedBeforeWork, unavailable)", async () => {
    for (const model of ["grok-3", "grok-4", "grok-unknown", "unknown", "constructor", "__proto__"]) {
      const f = vi.fn();
      for (const provider of [xaiProvider(f as never, ALLOW), xaiProvider(f as never)]) {
        const e = await fail(provider, { model });
        expect(e).toBeInstanceOf(AiProviderError);
        expect(e.kind).toBe("unavailable");
        expect(e.rejectedBeforeWork).toBe(true);
        expect(e.usage).toEqual(ZERO);
      }
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("the default (empty) allow-list refuses even a normal model with no fetch", async () => {
    const f = vi.fn();
    const e = await fail(xaiProvider(f as never));
    expect([e.kind, e.rejectedBeforeWork]).toEqual(["unavailable", true]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("xai adapter: guards the PM ruling asks to see explicitly (13 Nov)", () => {
  const consoleSpies = () => (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

  it("no credential in any log or thrown message, on success and on every failure path", async () => {
    const spies = consoleSpies();
    const seen: string[] = [];
    const record = (e: unknown) => {
      const x = e as Error;
      seen.push(String(x?.message), String(e), JSON.stringify(e));
    };
    const bodies: Array<() => Promise<Response>> = [
      async () => ok(),
      async () => new Response(`{"error":"${KEY}"}`, { status: 401 }),
      async () => new Response(`${KEY}`, { status: 500 }),
      async () => ok({}, "stop", `not json ${KEY}`),
      async () => ok({}, "stop", null),
      async () => {
        throw new TypeError(`connect failed ${KEY}`);
      },
    ];
    for (const b of bodies) {
      try {
        await run(b).p.complete(req);
      } catch (e) {
        record(e);
      }
    }
    try {
      await xaiProvider(vi.fn() as never, ALLOW).complete({ ...req, model: "not-allowed" });
    } catch (e) {
      record(e);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).not.toContain(KEY);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
      spy.mockRestore();
    }
  });

  it("provider disabled: an empty allow-list refuses every model before any fetch, and the global fetch is never used", async () => {
    const globalFetch = vi.fn(async () => ok());
    vi.stubGlobal("fetch", globalFetch);
    try {
      const injected = vi.fn(async () => ok());
      for (const provider of [xaiProvider(injected as never, {}), xaiProvider(injected as never)]) {
        const e = await fail(provider);
        expect([e.kind, e.rejectedBeforeWork]).toEqual(["unavailable", true]);
        expect(e.usage).toEqual(ZERO);
      }
      expect(injected).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
      // An enabled model with an injected fetch uses only the injected one.
      await run(async () => ok()).p.complete(req);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("request mapping is exact: POST, fixed URL, Bearer authorization, model, token cap, system then user message", async () => {
    const { f, p } = run(async () => ok());
    await p.complete({ ...req, maxOutputTokens: 123, apiKey: "sk-dummy-other" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect([url, init.method]).toEqual(["https://api.x.ai/v1/chat/completions", "POST"]);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-dummy-other");
    expect([body.model, body.max_completion_tokens, body.messages.map((m: { role: string }) => m.role)]).toEqual(["grok-test-mini", 123, ["system", "user"]]);
  });

  describe("integer GBP pence through the AI-1 pricing path (a test-only xAI price row, removed afterwards)", () => {
    const MODEL = "grok-pricing-test";
    const NOW = new Date("2026-11-12T12:00:00Z");
    const RATES: readonly UsdGbpRate[] = [{ microGbpPerUsd: BigInt(800_000), source: "test stand-in", effectiveAt: "2026-11-12T00:00:00Z" }];
    const table = MODEL_PRICES_GBP as Record<string, ModelPrice>;
    const addRow = () => {
      table[MODEL] = { provider: "xai", inputMicroUsdPerMTok: BigInt(2_500_000), outputMicroUsdPerMTok: BigInt(10_000_000), source: "test stand-in", asOf: "2026-11-12" };
    };
    const dropRow = () => {
      delete table[MODEL];
    };

    it("shipped table has no xAI price: estimate throws, actual is charged the maximum, so nothing is cheap by accident", () => {
      dropRow();
      expect(() => estimatePenceGbp(MODEL, 100, 100, "xai", NOW, RATES)).toThrow(/No usable price/);
      expect(actualPenceGbp(MODEL, { inputTokens: 1, outputTokens: 1 }, "xai", NOW, RATES)).toBe(MAX_REQUEST_PENCE_GBP);
    });

    it("integer pence, rounded up: exactly 200p at 1M input tokens (USD 2.50 x 0.80), 201p at one token more", () => {
      addRow();
      try {
        const exact = actualPenceGbp(MODEL, { inputTokens: 1_000_000, outputTokens: 0 }, "xai", NOW, RATES);
        const over = actualPenceGbp(MODEL, { inputTokens: 1_000_001, outputTokens: 0 }, "xai", NOW, RATES);
        const est = estimatePenceGbp(MODEL, 1000, 500, "xai", NOW, RATES);
        expect([exact, over]).toEqual([200, 201]);
        for (const n of [exact, over, est]) expect(Number.isInteger(n)).toBe(true);
        expect(est).toBeGreaterThanOrEqual(1);
        expect(actualPenceGbp(MODEL, { inputTokens: 1, outputTokens: 1 }, "xai", NOW, RATES)).toBe(1);
      } finally {
        dropRow();
      }
    });

    it("missing, stale or not-yet-effective exchange rate fails closed (estimate throws, actual is the maximum)", () => {
      addRow();
      try {
        for (const rates of [[], [{ ...RATES[0], effectiveAt: "2026-11-10T00:00:00Z" }], [{ ...RATES[0], effectiveAt: "2026-11-13T00:00:00Z" }]] as UsdGbpRate[][]) {
          expect(() => estimatePenceGbp(MODEL, 100, 100, "xai", NOW, rates)).toThrow(/No usable USD to GBP rate/);
          expect(actualPenceGbp(MODEL, { inputTokens: 1, outputTokens: 1 }, "xai", NOW, rates)).toBe(MAX_REQUEST_PENCE_GBP);
        }
        // The shipped rate table is empty: with no injected rates, an xAI request cannot be priced at all.
        expect(() => estimatePenceGbp(MODEL, 100, 100, "xai", NOW)).toThrow(/No usable USD to GBP rate/);
      } finally {
        dropRow();
      }
    });

    it("a stale price (over 90 days) and a provider mismatch fail closed", () => {
      addRow();
      try {
        expect(() => estimatePenceGbp(MODEL, 100, 100, "xai", new Date("2027-03-01T00:00:00Z"), [{ ...RATES[0], effectiveAt: "2027-03-01T00:00:00Z" }])).toThrow(/stale/);
        expect(() => estimatePenceGbp(MODEL, 100, 100, "anthropic", NOW, RATES)).toThrow(/provider_mismatch/);
      } finally {
        dropRow();
      }
    });
  });
});
