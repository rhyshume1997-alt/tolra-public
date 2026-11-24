// @vitest-environment jsdom
/**
 * BOUNDARY (Approval Queue). Inputs: the live route app/(dashboard)/approval/page.tsx, with the company switch ON or OFF and a mocked Supabase client.
 * Output: pass/fail. Pins (1) both views render every sentence of APPROVAL_GUIDANCE and (2) a failed reload keeps the loaded drafts visible beside the error and Retry,
 * and a successful Retry replaces them with the fresh result. Must not change: never weaken these to make a change pass. No network, no real Supabase.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hiddenNav: ["ui-approval-v2:on"] as string[],
  drafts: { data: [] as unknown[], error: null as unknown },
}));

const draft = (id: string, name: string) => ({ id, to_email: `${id}@x.example`, to_name: name, subject: `Subject ${id}`, body: "Body", related_to_type: "general", related_to_id: id, drafted_by: "u", drafted_at: "2026-01-01T00:00:00Z", skipped_until: null });

// A chainable, awaitable query: every method returns the same builder; awaiting it yields the result chosen by the selected columns.
vi.mock("@/lib/supabase", () => {
  const make = (columns: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "or", "in", "order", "limit", "select"]) b[m] = () => b;
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
      const result = columns.startsWith("id, to_email, to_name, subject, body") ? state.drafts : { data: [], error: null };
      return Promise.resolve(result).then(ok, bad);
    };
    return b;
  };
  return { supabase: { rpc: async () => ({ data: [], error: null }), from: () => ({ select: (columns: string) => make(columns), update: () => make("") }) } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/lib/use-user", () => ({
  useUser: () => ({ profile: { organization_id: "alpha" }, user: { id: "user" }, activeRole: "admin", loading: false, hasAnyRole: (r: string[]) => r.includes("admin"), hasRole: (r: string) => r === "admin" }),
  useMaybeUser: () => ({ profile: { organization_id: "alpha" }, user: { id: "user" } }),
}));
vi.mock("@/lib/org-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/org-settings")>(),
  useOrgSettings: () => ({ loaded: true, localOnly: false, hiddenNav: state.hiddenNav }),
  useConfirmedCompanyNavigation: () => ({ organizationId: "alpha", userId: "user", hiddenNav: state.hiddenNav }),
}));

import Screen from "@/app/(dashboard)/approval/page";
import { APPROVAL_GUIDANCE } from "@/lib/approval-guidance";

const sentences = APPROVAL_GUIDANCE.split(/(?<=\.)\s+/);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  state.hiddenNav = ["ui-approval-v2:on"];
  state.drafts = { data: [], error: null };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ resend: false, admin: false }) })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("approval guidance", () => {
  it("is several sentences, so the per-sentence checks below are meaningful", () => {
    expect(sentences.length).toBe(4);
  });
  for (const [label, nav] of [["ON", ["ui-approval-v2:on"]], ["OFF", []]] as const) {
    it(`renders every sentence of APPROVAL_GUIDANCE with the switch ${label}`, () => {
      state.hiddenNav = [...nav];
      const html = renderToStaticMarkup(createElement(Screen));
      expect(html.includes('data-testid="approval-v2"')).toBe(label === "ON");
      expect(html).toContain(APPROVAL_GUIDANCE);
      for (const sentence of sentences) expect(html).toContain(sentence);
    });
  }
});

describe("approval redesign reload", () => {
  let root: Root;
  let host: HTMLElement;
  const mount = async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(createElement(Screen)); });
    await flush();
  };
  afterEach(() => { act(() => root.unmount()); });
  const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  const click = async (el: Element | undefined) => { expect(el).toBeDefined(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };

  it("keeps both loaded drafts visible with the error and Retry when a reload fails, and a good Retry replaces them", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/email/approve")
      ? { ok: false, json: async () => ({ error: "Could not send this draft." }) }
      : { ok: true, json: async () => ({ resend: false, admin: false }) }));
    window.confirm = () => true;
    state.drafts = { data: [{ ...draft("a1", "Alpha Customer"), related_to_id: "customer_statement:1" }, draft("b2", "Bravo Customer")], error: null };
    await mount();
    expect(host.querySelector('[data-testid="approval-v2"]')).not.toBeNull();
    expect(host.textContent).toContain("Alpha Customer");
    expect(host.textContent).toContain("Bravo Customer");
    expect(button("Retry", host)).toBeUndefined();

    // A real reload: a refused Approve and send reloads the queue without removing the draft. Make that reload fail.
    state.drafts = { data: [], error: { message: "boom", code: "XX000" } };
    await click(button("Full preview", host));
    await click(button("Approve and send"));
    expect(host.textContent).toContain("Couldn’t load the approval queue");
    expect(button("Retry", host)).toBeDefined();
    expect(host.textContent).toContain("Alpha Customer");
    expect(host.textContent).toContain("Bravo Customer");
    expect(host.textContent).not.toContain("Nothing waiting");

    // A successful Retry replaces the old drafts with the fresh result and clears the error.
    state.drafts = { data: [draft("c3", "Charlie Customer")], error: null };
    await click(button("Retry", host));
    expect(host.textContent).toContain("Charlie Customer");
    expect(host.textContent).not.toContain("Alpha Customer");
    expect(host.textContent).not.toContain("Bravo Customer");
    expect(host.textContent).not.toContain("Couldn’t load the approval queue");
    expect(button("Retry", host)).toBeUndefined();
  });
});
