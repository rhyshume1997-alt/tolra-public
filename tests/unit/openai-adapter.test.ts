/** OpenAI adapter (AI-2): mock fetch only, no network. URL, headers, body, mapping, errors, key never leaked. */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AiProviderError, type AiCompletionRequest } from "@/lib/ai-helper/provider";
import { OPENAI_MODEL_ALLOWLIST, openaiProvider, type OpenAiModelSpec } from "@/lib/ai-helper/providers/openai";

const KEY = "sk-test-SECRET-KEY-123";
const req: AiCompletionRequest = {
  model: "gpt-4.1-mini",
  system: "SYSTEM PROMPT",
  data: '{"text":"hello"}',
  schema: { type: "object" },
  maxOutputTokens: 500,
  effort: "low",
  timeoutMs: 5000,
  apiKey: KEY,
};

const ok = (over: Record<string, unknown> = {}, finish = "stop", content: unknown = '{"a":1}') =>
  new Response(JSON.stringify({ model: "gpt-4.1-mini-2025", choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7 }, ...over }), { status: 200 });
// Test-only allow-list: the real constant is empty until Rhys/PM confirm models from OpenAI's docs. Names here are placeholders.
const ALLOW: Record<string, OpenAiModelSpec> = {
  "gpt-4.1-mini": { outputLimitParam: "max_completion_tokens", structured: "json_schema" },
  "legacy-test": { outputLimitParam: "max_tokens", structured: "json_object" },
};
const ZERO = { inputTokens: 0, outputTokens: 0 };
const run = (fn: () => Promise<Response>) => {
  const f = vi.fn(fn);
  return { f, p: openaiProvider(f as never, ALLOW) };
};
/** A no-usage failure must settle in full: unavailable, not rejected, no usage. */
const expectFullReservation = (e: AiProviderError) => {
  expect(e).toBeInstanceOf(AiProviderError);
  expect(e.kind).toBe("unavailable");
  expect(e.rejectedBeforeWork).toBe(false);
  expect(e.usage).toEqual(ZERO);
};
const fail = async (p: ReturnType<typeof openaiProvider>, over: Partial<AiCompletionRequest> = {}): Promise<AiProviderError> => {
  try {
    await p.complete({ ...req, ...over });
  } catch (e) {
    return e as AiProviderError;
  }
  throw new Error("did not throw");
};

describe("openai adapter", () => {
  it("id is openai", () => expect(openaiProvider().id).toBe("openai"));

  it("the shipped allow-list is empty (no model confirmed yet)", () => expect(Object.keys(OPENAI_MODEL_ALLOWLIST)).toEqual([]));

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
    expect(out).toEqual({ json: { a: 1 }, usage: { inputTokens: 11, outputTokens: 7 }, model: "gpt-4.1-mini-2025" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "gpt-4.1-mini",
      stream: false,
      max_completion_tokens: 500,
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: '{"text":"hello"}' },
      ],
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } },
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

  it("completion_tokens is the output (it already includes reasoning tokens)", async () => {
    const out = await run(async () => ok({ usage: { prompt_tokens: 11, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } } })).p.complete(req);
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 40 });
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
    expectFullReservation(await fail(openaiProvider(f as never, ALLOW), { timeoutMs: 30 }));
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
    for (const model of ["o3-mini", "gpt-5", "gpt-4.1", "unknown", "constructor", "__proto__"]) {
      const f = vi.fn();
      for (const provider of [openaiProvider(f as never, ALLOW), openaiProvider(f as never)]) {
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
    const e = await fail(openaiProvider(f as never));
    expect([e.kind, e.rejectedBeforeWork]).toEqual(["unavailable", true]);
    expect(f).not.toHaveBeenCalled();
  });
});
