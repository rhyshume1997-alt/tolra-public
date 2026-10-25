/**
 * The app shell's "remember this company for the sign-in page" call (lib/branding.ts rememberBrand, from components/dashboard-shell).
 * Its answer must always be read to the end: a fetch whose body is never read is never finished in the browser, so every signed-in
 * page stayed busy on the network for as long as it was open (CI run 40182770805: networkidle never came on the pages that sent it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LAST_ORG_KEY, REMEMBERED_KEY, rememberBrand } from "@/lib/branding";

const ORG = "11111111-1111-4111-8111-111111111111";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
  };
}

let sessionStorage: ReturnType<typeof memoryStorage>;
let localStorage: ReturnType<typeof memoryStorage>;
let answers: Response[];
const fetchMock = vi.fn();

function answer(status: number) {
  // A streamed body, as the browser gets it: it counts as read only once something reads it.
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(status === 200 ? '{"ok":true}' : '{"error":"x"}')); controller.close(); } }), { status, headers: { "Content-Type": "application/json" } });
  answers.push(response);
  return response;
}

beforeEach(() => {
  sessionStorage = memoryStorage();
  localStorage = memoryStorage();
  answers = [];
  fetchMock.mockReset();
  vi.stubGlobal("window", { sessionStorage, localStorage });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rememberBrand (app shell, after sign-in and a company switch)", () => {
  it("reads the answer to the end, then records the company for this tab and drops the old browser-only record", async () => {
    localStorage.setItem(LAST_ORG_KEY, "acme");
    fetchMock.mockImplementation(async () => answer(200));
    await rememberBrand(ORG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/branding/remember", { method: "POST" });
    expect(answers[0].bodyUsed).toBe(true);
    expect(sessionStorage.getItem(REMEMBERED_KEY)).toBe(ORG);
    expect(localStorage.getItem(LAST_ORG_KEY)).toBeNull();
  });

  it("reads a refusal to the end too, and records nothing so the next page load asks again", async () => {
    localStorage.setItem(LAST_ORG_KEY, "acme");
    fetchMock.mockImplementation(async () => answer(500));
    await rememberBrand(ORG);
    expect(answers[0].bodyUsed).toBe(true);
    expect(sessionStorage.getItem(REMEMBERED_KEY)).toBeNull();
    expect(localStorage.getItem(LAST_ORG_KEY)).toBe("acme");
  });

  it("asks once per company per tab, and again after a company switch", async () => {
    fetchMock.mockImplementation(async () => answer(200));
    await rememberBrand(ORG);
    await rememberBrand(ORG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await rememberBrand("33333333-3333-4333-8333-333333333333");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(answers.every((response) => response.bodyUsed)).toBe(true);
  });

  it("never throws when the network or storage fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(rememberBrand(ORG)).resolves.toBeUndefined();
    vi.stubGlobal("window", { get sessionStorage() { throw new Error("blocked"); }, get localStorage() { throw new Error("blocked"); } });
    fetchMock.mockImplementation(async () => answer(200));
    await expect(rememberBrand(ORG)).resolves.toBeUndefined();
    expect(answers[0].bodyUsed).toBe(true);
  });
});
