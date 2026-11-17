/**
 * BOUNDARY (Integrations module, AI-1): the shared adapter contract (lib/ai-helper/provider.ts, ADAPTER CONTRACT) as table-driven checks.
 *
 * Inputs: a harness that builds one adapter on a stand-in transport (an SDK stand-in, or a fake fetch through fetchHarness). Outputs:
 * aiProviderContractChecks (plain async checks, so a test can also prove a broken adapter fails one) and runAiProviderContract (registers
 * them with vitest). No network: every transport is a stand-in. A harness may exempt a case only with its reason, which is shown as a
 * skipped test. Must not change without review: a case may be added or tightened, never dropped or loosened.
 */
import { describe, expect, it, vi } from "vitest";

import { type AiCompletionRequest, type AiHelperProvider, AiProviderError, type AiUsage } from "@/lib/ai-helper/provider";

export type ContractUsage = AiUsage;
/** What the stand-in transport answers with. */
export type AnswerScenario =
  | { kind: "ok"; json: unknown; usage: ContractUsage; model: string }
  | { kind: "refusal"; usage: ContractUsage }
  | { kind: "truncated"; usage: ContractUsage }
  | { kind: "malformed"; usage: ContractUsage }
  | { kind: "missing_usage"; json: unknown; model: string };
export type ContractScenario = AnswerScenario | { kind: "status"; status: number; body: string } | { kind: "timeout" } | { kind: "network" } | { kind: "non_json_200" };

export type ContractRequestInfo = { model: string; system: string; userMessages: string[]; hasTools: boolean; outputBound: number | undefined; schema: unknown };
/** What the stand-in transport saw. */
export type ContractRecord = {
  calls: number;
  /** The key as presented to the provider (auth header / client key). */
  credential: string | null;
  /** Everything sent except the credential, serialised (URL, other headers, body). */
  sentOutsideAuth: string;
  request: ContractRequestInfo | null;
  /** The URL requested; null for an SDK transport. */
  url: string | null;
  /** The timeout handed to the transport, when it can be seen; null when it cannot (fetch: checked by timeout_covers_body_read). */
  timeoutMs: number | null;
};

export type ContractCase =
  | "happy_path" | "exact_url" | "refusal" | "truncated" | "malformed" | "missing_usage" | `status_${number}` | "status_unlisted" | "non_json_200" | "timeout" | "network"
  | "key_never_leaked" | "redirect_not_followed" | "body_over_cap" | "timeout_covers_body_read";

export type AiProviderHarness = {
  name: string;
  id: AiHelperProvider["id"];
  /** A model this adapter is allowed to call. */
  model: string;
  /** The exact URL the adapter must call; null for an SDK transport (then exact_url must be exempted with its reason). */
  expectedUrl: string | null;
  build: (scenario: ContractScenario) => { provider: AiHelperProvider; record: () => ContractRecord };
  /** fetch adapters only: the transport cases (redirect, body cap, body-read timeout). */
  fetchAdapter?: { make: (fetchFn: typeof fetch) => AiHelperProvider; okBody: (s: Extract<AnswerScenario, { kind: "ok" }>) => unknown };
  exemptions?: Partial<Record<ContractCase, string>>;
};

export const CONTRACT_KEY = "sk-contract-test-not-a-real-key-7Hq2";
export const BODY_CAP_BYTES = 256 * 1024;
/** 401/403 auth; 429 rate; 400/404/413 rejected before work; 5xx may have been billed. */
export const STATUS_TABLE: { status: number; detail: "auth" | "rate" | undefined; rejectedBeforeWork: boolean }[] = [
  { status: 400, detail: undefined, rejectedBeforeWork: true },
  { status: 401, detail: "auth", rejectedBeforeWork: true },
  { status: 403, detail: "auth", rejectedBeforeWork: true },
  { status: 404, detail: undefined, rejectedBeforeWork: true },
  { status: 413, detail: undefined, rejectedBeforeWork: true },
  { status: 429, detail: "rate", rejectedBeforeWork: true },
  { status: 500, detail: undefined, rejectedBeforeWork: false },
  { status: 502, detail: undefined, rejectedBeforeWork: false },
  { status: 503, detail: undefined, rejectedBeforeWork: false },
];
/** Statuses the table does not list (418 is none of the above): never "rejected before work" (it may have been billed), no detail. */
export const UNLISTED_STATUSES = [418, 500, 502];

export function contractRequest(model: string, timeoutMs = 1000): AiCompletionRequest {
  return {
    model,
    system: "contract-system-prompt-Zx81: answer as JSON",
    data: JSON.stringify({ rfq_email: "contract-data-Qm40: 25 x Bracket" }),
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    maxOutputTokens: 777,
    effort: "low",
    timeoutMs,
    apiKey: CONTRACT_KEY,
  };
}

const USAGE: ContractUsage = { inputTokens: 1234, outputTokens: 56 };
const errorBody = (req: AiCompletionRequest) => `provider-error-body-9Kd3 echo ${req.apiKey} ${req.system} ${req.data}`;

/** server.ts:140-141: an error the caller settles at the full reservation (never at 0). */
const settlesAtFullReservation = (e: AiProviderError) => e.kind === "unavailable" && !e.rejectedBeforeWork;

async function failure(run: Promise<unknown>): Promise<AiProviderError> {
  const outcome = await run.then(() => null, (e: unknown) => e);
  expect(outcome, "expected an AiProviderError").toBeInstanceOf(AiProviderError);
  return outcome as AiProviderError;
}

/** The key, the prompt, the data and the provider's error body appear in no thrown error and no console output. */
function expectNoLeak(err: unknown, req: AiCompletionRequest, consoleCalls: unknown[][]) {
  const e = err as Error;
  const texts = [String(err), e?.message ?? "", e?.stack ?? "", JSON.stringify(err), JSON.stringify(consoleCalls)];
  for (const secret of [req.apiKey, req.system, "contract-data-Qm40", "provider-error-body-9Kd3"]) for (const t of texts) expect(t).not.toContain(secret);
}

async function withConsoleSpy<T>(run: (calls: unknown[][]) => Promise<T>): Promise<T> {
  const calls: unknown[][] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { calls.push(args); }));
  try {
    return await run(calls);
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

/** Builds, runs one request, and checks the invariants every call has: one request, the key only as the credential, a fixed URL. */
async function call(h: AiProviderHarness, scenario: ContractScenario, req = contractRequest(h.model)) {
  const { provider, record } = h.build(scenario);
  expect(provider.id).toBe(h.id);
  const result = await provider.complete(req).then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }));
  const r = record();
  expect(r.calls, "exactly one request, no retry").toBe(1);
  expect(r.credential).toBe(req.apiKey);
  expect(r.sentOutsideAuth).not.toContain(req.apiKey);
  if (!h.exemptions?.exact_url) expect(r.url).toBe(h.expectedUrl);
  return { ...result, record: r, req };
}

export type ContractCheck = { name: ContractCase; title: string; run: () => Promise<void> };

export function aiProviderContractChecks(h: AiProviderHarness): ContractCheck[] {
  const checks: ContractCheck[] = [
    { name: "happy_path", title: "happy path: one request, model/system/data as the one user message, no tools, output bound, schema, usage incl. cached", run: async () => {
      const json = { ok: true };
      const { value, error, record, req } = await call(h, { kind: "ok", json, usage: USAGE, model: h.model });
      expect(error).toBeNull();
      expect(value).toEqual({ json, usage: USAGE, model: h.model });
      expect(record.request).toEqual({ model: req.model, system: req.system, userMessages: [req.data], hasTools: false, outputBound: req.maxOutputTokens, schema: req.schema });
      if (record.timeoutMs !== null) expect(record.timeoutMs).toBe(req.timeoutMs);
    } },
    { name: "exact_url", title: "exact, fixed URL", run: async () => {
      expect(h.expectedUrl).toMatch(/^https:\/\//);
      const { record } = await call(h, { kind: "ok", json: { ok: true }, usage: USAGE, model: h.model });
      expect(record.url).toBe(h.expectedUrl);
    } },
    { name: "refusal", title: "refusal -> refused, with usage", run: async () => {
      const e = await failure(call(h, { kind: "refusal", usage: USAGE }).then((r) => { if (r.error) throw r.error; return r.value; }));
      expect(e).toMatchObject({ kind: "refused", usage: USAGE });
    } },
    { name: "truncated", title: "cut short -> invalid, with usage", run: async () => {
      const e = await failure(call(h, { kind: "truncated", usage: USAGE }).then((r) => { if (r.error) throw r.error; return r.value; }));
      expect(e).toMatchObject({ kind: "invalid", usage: USAGE });
    } },
    { name: "malformed", title: "answer text that is not JSON -> invalid, with usage", run: async () => {
      const e = await failure(call(h, { kind: "malformed", usage: USAGE }).then((r) => { if (r.error) throw r.error; return r.value; }));
      expect(e).toMatchObject({ kind: "invalid", usage: USAGE });
    } },
    { name: "missing_usage", title: "no usage reported -> an error the caller settles at the full reservation (never 0)", run: async () => {
      const e = await failure(call(h, { kind: "missing_usage", json: { ok: true }, model: h.model }).then((r) => { if (r.error) throw r.error; return r.value; }));
      expect(settlesAtFullReservation(e)).toBe(true);
    } },
    ...STATUS_TABLE.map((row): ContractCheck => ({ name: `status_${row.status}`, title: `HTTP ${row.status} -> unavailable, detail ${row.detail ?? "none"}, rejectedBeforeWork ${row.rejectedBeforeWork}`, run: async () => {
      const req = contractRequest(h.model);
      const e = await failure(call(h, { kind: "status", status: row.status, body: errorBody(req) }, req).then((r) => { if (r.error) throw r.error; return r.value; }));
      expect({ kind: e.kind, detail: e.detail, rejectedBeforeWork: e.rejectedBeforeWork }).toEqual({ kind: "unavailable", detail: row.detail, rejectedBeforeWork: row.rejectedBeforeWork });
    } })),
    { name: "status_unlisted", title: `an unlisted HTTP status (${UNLISTED_STATUSES.join(", ")}) -> unavailable, not rejected (may have been billed)`, run: async () => {
      for (const status of UNLISTED_STATUSES) {
        const req = contractRequest(h.model);
        const e = await failure(call(h, { kind: "status", status, body: errorBody(req) }, req).then((r) => { if (r.error) throw r.error; return r.value; }));
        expect({ status, kind: e.kind, rejectedBeforeWork: e.rejectedBeforeWork }, `status ${status}`).toEqual({ status, kind: "unavailable", rejectedBeforeWork: false });
        expect(settlesAtFullReservation(e), `status ${status}`).toBe(true);
      }
    } },
    { name: "non_json_200", title: "a 200 response whose body is not JSON -> unavailable, not rejected (may have been billed)", run: async () => {
      const e = await failure(call(h, { kind: "non_json_200" }).then((r) => { if (r.error) throw r.error; return r.value; }));
      expect({ kind: e.kind, rejectedBeforeWork: e.rejectedBeforeWork }).toEqual({ kind: "unavailable", rejectedBeforeWork: false });
      expect(settlesAtFullReservation(e)).toBe(true);
    } },
    { name: "timeout", title: "timeout -> unavailable, not rejected (may have been billed)", run: async () => {
      const e = await failure(call(h, { kind: "timeout" }).then((r) => { if (r.error) throw r.error; return r.value; }));
      expect(settlesAtFullReservation(e)).toBe(true);
    } },
    { name: "network", title: "network failure -> unavailable, not rejected", run: async () => {
      const e = await failure(call(h, { kind: "network" }).then((r) => { if (r.error) throw r.error; return r.value; }));
      expect(settlesAtFullReservation(e)).toBe(true);
    } },
    { name: "key_never_leaked", title: "the key, prompt, data and provider error body never appear in a thrown error or the console", run: async () => {
      const req = contractRequest(h.model);
      const scenarios: ContractScenario[] = [...STATUS_TABLE.map((row) => ({ kind: "status" as const, status: row.status, body: errorBody(req) })), { kind: "timeout" }, { kind: "network" }, { kind: "refusal", usage: USAGE }, { kind: "truncated", usage: USAGE }, { kind: "malformed", usage: USAGE }];
      for (const scenario of scenarios) {
        await withConsoleSpy(async (calls) => {
          const { error } = await call(h, scenario, req);
          expect(error, scenario.kind).toBeInstanceOf(AiProviderError);
          expectNoLeak(error, req, calls);
        });
      }
    } },
  ];
  const f = h.fetchAdapter;
  if (f) checks.push(
    { name: "redirect_not_followed", title: "redirects are never followed (redirect: \"error\")", run: async () => {
      const seen: RequestInit[] = [];
      const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(init ?? {});
        if (init?.redirect === "error") throw new TypeError("fetch failed: redirect mode is set to error");
        return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/steal" } });
      }) as typeof fetch;
      const e = await failure(f.make(fetchFn).complete(contractRequest(h.model)));
      expect(seen.length).toBe(1);
      expect(seen[0].redirect).toBe("error");
      expect(settlesAtFullReservation(e)).toBe(true);
    } },
    { name: "body_over_cap", title: `a response body over ${BODY_CAP_BYTES} bytes -> unavailable, not rejected (settles at the full reservation)`, run: async () => {
      const big = f.okBody({ kind: "ok", json: { ok: true, pad: "x".repeat(BODY_CAP_BYTES + 1024) }, usage: USAGE, model: h.model });
      const bytes = new TextEncoder().encode(JSON.stringify(big));
      let calls = 0;
      // Streamed, no content-length: the adapter must count what it reads.
      const fetchFn = (async () => { calls += 1; return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 16_384) c.enqueue(bytes.subarray(i, i + 16_384)); c.close(); } }), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
      const e = await failure(f.make(fetchFn).complete(contractRequest(h.model)));
      expect(calls).toBe(1);
      expect(settlesAtFullReservation(e)).toBe(true);
    } },
    { name: "timeout_covers_body_read", title: "the timeout covers reading the body (a stalled body ends as unavailable, not rejected)", run: async () => {
      let signal: AbortSignal | null | undefined;
      const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({ start(c) {
          c.enqueue(new TextEncoder().encode("{\"partial\":"));
          signal?.addEventListener("abort", () => c.error(signal?.reason ?? new DOMException("aborted", "AbortError")));
        } });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const hung = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the body read was not bounded by req.timeoutMs")), 2000));
      const e = await failure(Promise.race([f.make(fetchFn).complete(contractRequest(h.model, 50)), hung]));
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(settlesAtFullReservation(e)).toBe(true);
    } },
  );
  return checks;
}

/** Registers every check with vitest; an exempted case shows as skipped with its reason. */
export function runAiProviderContract(h: AiProviderHarness): void {
  describe(`adapter contract: ${h.name}`, () => {
    for (const check of aiProviderContractChecks(h)) {
      const reason = h.exemptions?.[check.name];
      it.skipIf(Boolean(reason))(reason ? `${check.title} [EXEMPT: ${reason}]` : check.title, check.run);
    }
  });
}

/** What a fetch adapter's spec gives fetchHarness: its URL, its auth header, its answer encoding and its request decoding. */
export type FetchAdapterSpec = {
  name: string;
  id: AiProviderHarness["id"];
  model: string;
  url: string;
  /** The header that carries the key, lower case (e.g. "authorization"). */
  authHeader: string;
  /** The key as the header carries it (e.g. `Bearer ${key}`). */
  credentialFromHeader: (value: string) => string;
  make: (fetchFn: typeof fetch) => AiHelperProvider;
  /** The 200 response body for an answer scenario. */
  encode: (s: AnswerScenario) => unknown;
  /** The provider-specific request body, read back into the contract's terms. */
  readRequest: (body: unknown) => ContractRequestInfo;
  exemptions?: AiProviderHarness["exemptions"];
};

/** A harness for a fetch adapter: one fake fetch per scenario, recording what was sent. */
export function fetchHarness(spec: FetchAdapterSpec): AiProviderHarness {
  return {
    name: spec.name, id: spec.id, model: spec.model, expectedUrl: spec.url, exemptions: spec.exemptions,
    fetchAdapter: { make: spec.make, okBody: (s) => spec.encode(s) },
    build(scenario) {
      let calls = 0;
      let url: string | null = null;
      let credential: string | null = null;
      let sentOutsideAuth = "";
      let request: ContractRequestInfo | null = null;
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers);
        const auth = headers.get(spec.authHeader);
        credential = auth === null ? null : spec.credentialFromHeader(auth);
        headers.delete(spec.authHeader);
        const raw = typeof init?.body === "string" ? init.body : "";
        sentOutsideAuth = JSON.stringify({ url, headers: [...headers.entries()], body: raw });
        request = spec.readRequest(raw ? JSON.parse(raw) : null);
        if (scenario.kind === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        if (scenario.kind === "network") throw new TypeError("fetch failed");
        if (scenario.kind === "non_json_200") return new Response("<html>502 gateway page, not JSON</html>", { status: 200, headers: { "content-type": "text/html" } });
        if (scenario.kind === "status") return new Response(scenario.body, { status: scenario.status, headers: { "content-type": "text/plain" } });
        return new Response(JSON.stringify(spec.encode(scenario)), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      return { provider: spec.make(fetchFn), record: () => ({ calls, credential, sentOutsideAuth, request, url, timeoutMs: null }) };
    },
  };
}
