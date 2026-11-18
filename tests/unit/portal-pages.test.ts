/**
 * Portal customer pages (PR4): flag first, one generic refusal, tabs per permission, money via gbp, no prefetch, forms post to the PR3 routes,
 * the code page's GET makes no database call. lib/portal/server, the flag and next/headers are stood in for.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalSession } from "@/lib/portal/types";

const s = vi.hoisted(() => ({
  enabled: true, token: "tok" as string | undefined,
  resolve: vi.fn(), quotes: vi.fn(), jobs: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (s.token ? { value: s.token } : undefined) }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/portal/flag", () => ({ portalEnabled: () => s.enabled }));
vi.mock("@/lib/portal/server", () => ({ resolvePortalSession: s.resolve, listPortalQuotes: s.quotes, listPortalJobs: s.jobs }));

import PortalHome from "@/app/portal/page";
import Signin from "@/app/portal/signin/page";
import Sent from "@/app/portal/signin/sent/page";
import CodePage from "@/app/portal/code/[ref]/page";
import QuotesPage from "@/app/portal/quotes/page";
import JobsPage from "@/app/portal/jobs/page";
import { metadata } from "@/app/portal/layout";

const session = (permissions: PortalSession["permissions"]): PortalSession => ({ contactId: "c", displayName: "Sam", companyName: "Acme Ltd", customerName: "Bolt Co", permissions, idleExpiresAt: "x", absoluteExpiresAt: "y" });
const render = async (el: Promise<unknown> | unknown) => renderToStaticMarkup((await el) as never);
const REFUSAL = "This link or code didn&#x27;t work.";
const refused = { ok: false, reason: "refused", correlationId: "abc" };
const GOOD_REF = "A".repeat(22);

beforeEach(() => { vi.clearAllMocks(); s.enabled = true; s.token = "tok"; s.resolve.mockResolvedValue({ ok: true, data: session(["quotes", "jobs"]) }); });

describe("flag first", () => {
  it("404s every page with the flag off, before any cookie or database use", async () => {
    s.enabled = false;
    for (const run of [() => PortalHome(), () => Signin(), () => Sent(), () => CodePage({ params: Promise.resolve({ ref: GOOD_REF }) }), () => QuotesPage(), () => JobsPage()]) {
      await expect(Promise.resolve().then(run)).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.quotes).not.toHaveBeenCalled();
  });
  it("layout is noindex", () => { expect(metadata.robots).toMatchObject({ index: false, follow: false }); });
});

describe("generic refusal", () => {
  it.each([["no cookie", () => { s.token = undefined; }], ["session refused", () => { s.resolve.mockResolvedValue(refused); }]])("home, %s: one refusal and the sign-in form", async (_n, setup) => {
    setup();
    const out = await render(PortalHome());
    expect(out).toContain(REFUSAL);
    expect(out).toContain('action="/api/portal/signin/request"');
    expect(out).not.toContain("Sign out");
    expect(out).not.toContain("abc");
  });
  it("a refused list shows the same refusal", async () => {
    s.quotes.mockResolvedValue(refused);
    const out = await render(QuotesPage());
    expect(out).toContain(REFUSAL);
    expect(out).toContain('action="/api/portal/signin/request"');
  });
  it("the refusal text is identical for no cookie and a refused session", async () => {
    s.token = undefined; const a = await render(PortalHome());
    s.token = "t"; s.resolve.mockResolvedValue(refused); const b = await render(PortalHome());
    expect(a).toBe(b);
  });
});

describe("tabs per permission", () => {
  it("shows only the permitted tab, and signs out by POST", async () => {
    s.resolve.mockResolvedValue({ ok: true, data: session(["jobs"]) });
    const out = await render(PortalHome());
    expect(out).toContain('data-testid="portal-tab-jobs"');
    expect(out).not.toContain('data-testid="portal-tab-quotes"');
    expect(out).toContain('<form action="/api/portal/signout" method="post">');
  });
  it("404s a page whose permission is missing, without listing", async () => {
    s.resolve.mockResolvedValue({ ok: true, data: session(["jobs"]) });
    await expect(QuotesPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(s.quotes).not.toHaveBeenCalled();
    s.resolve.mockResolvedValue({ ok: true, data: session(["quotes"]) });
    await expect(JobsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(s.jobs).not.toHaveBeenCalled();
  });
});

describe("lists", () => {
  it("quotes: money through gbp, dates, status", async () => {
    s.quotes.mockResolvedValue({ ok: true, data: [{ quoteRef: "Q-1", status: "sent", sentAt: "2026-03-04T10:00:00Z", validUntil: null, customerPo: "PO9", totalValue: 1234.5 }, { quoteRef: "Q-2", status: "accepted", sentAt: null, validUntil: null, customerPo: null, totalValue: null }] });
    const out = await render(QuotesPage());
    expect(s.quotes).toHaveBeenCalledWith("tok");
    expect(out).toContain("£1,234.50");
    expect(out).toContain("4 Mar 2026");
    expect(out).toContain("Awaiting your answer");
    expect(out).toContain("Q-2");
  });
  it("jobs: the three stages", async () => {
    s.jobs.mockResolvedValue({ ok: true, data: [{ jobNo: "J1", customerPo: null, dueDate: "2026-05-01", stage: "in_progress" }] });
    const out = await render(JobsPage());
    expect(out).toContain("In progress");
    expect(out).toContain("1 May 2026");
  });
  it("empty lists say so", async () => {
    s.quotes.mockResolvedValue({ ok: true, data: [] });
    expect(await render(QuotesPage())).toContain("No quotes to show.");
  });
});

describe("sign-in pages and code page", () => {
  it("sign-in form posts to the request route and makes no database call", async () => {
    const out = await render(Signin());
    expect(out).toContain('action="/api/portal/signin/request"');
    expect(s.resolve).not.toHaveBeenCalled();
  });
  it("sent page uses the neutral wording", async () => {
    expect(await render(Sent())).toContain("If this address can use the portal, we&#x27;ve e-mailed a link and code. They work once, for 10 minutes.");
  });
  it("code page: GET makes no database call and reads no session; form posts ref and code to verify", async () => {
    const out = await render(CodePage({ params: Promise.resolve({ ref: GOOD_REF }) }));
    expect(out).toContain('action="/api/portal/signin/verify"');
    expect(out).toContain(`name="ref" value="${GOOD_REF}"`);
    expect(out).toContain('name="code"');
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.quotes).not.toHaveBeenCalled();
    expect(s.jobs).not.toHaveBeenCalled();
  });
  const SENTENCE = "We couldn&#x27;t verify your code. Please try again or request a new code.";
  const withC = (c: string | string[]) => render(CodePage({ params: Promise.resolve({ ref: GOOD_REF }), searchParams: Promise.resolve({ c }) }));
  it("code page: ?c= shows the fixed sentence and a link to request a new code", async () => {
    const out = await withC("abc123");
    expect(out).toContain(SENTENCE);
    expect(out).toContain('href="/portal/signin"');
    expect(out.indexOf(SENTENCE)).toBeLessThan(out.indexOf("<form"));
  });
  it("code page: output is identical for different ?c= values and never renders the id", async () => {
    const a = await withC("first-refusal-id-111");
    const b = await withC("second-refusal-id-222");
    expect(a).toBe(b);
    expect(a).not.toContain("refusal-id");
  });
  it("code page: without ?c= there is no message", async () => {
    const plain = await render(CodePage({ params: Promise.resolve({ ref: GOOD_REF }) }));
    const empty = await render(CodePage({ params: Promise.resolve({ ref: GOOD_REF }), searchParams: Promise.resolve({}) }));
    expect(plain).not.toContain("verify your code");
    expect(empty).toBe(plain);
  });
  it("code page: with ?c= still no database call", async () => {
    await withC("x");
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.quotes).not.toHaveBeenCalled();
    expect(s.jobs).not.toHaveBeenCalled();
  });
  it("code page: a malformed ref shows the generic refusal, never echoed", async () => {
    const out = await render(CodePage({ params: Promise.resolve({ ref: '"><script>' }) }));
    expect(out).toContain(REFUSAL);
    expect(out).not.toContain("<script>");
  });
  it("every <Link> in the portal pages and components has prefetch={false}", () => {
    const files = ["app/portal/page.tsx", "app/portal/signin/sent/page.tsx", "components/portal/portal-frame.tsx"];
    for (const f of files) {
      const src = readFileSync(path.resolve(__dirname, "../..", f), "utf8");
      const links = src.match(/<Link\b[^>]*>/g) ?? [];
      for (const l of links) expect(l, `${f}: ${l}`).toContain("prefetch={false}");
    }
  });
});
