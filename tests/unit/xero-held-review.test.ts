// @vitest-environment jsdom
// Held for review (release 149): the admin sees what was waiting before transfers were on, ticks each document and approves it with the
// recent-code prompt. Nothing is approved without a tick, a cancelled code approves nothing, an unreadable list says so.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

import { HELD_REVIEW_INTRO, XeroHeldReview } from "@/components/integrations/xero-held-review";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const requestCode = vi.fn();
async function render(node: ReturnType<typeof createElement>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(node));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | HTMLButtonElement | null;
function server(opts: { read?: number; held?: unknown[]; post?: Array<{ status: number; body: unknown }> } = {}) {
  let held = opts.held ?? [
    { id: A, doc_type: "invoice", doc_ref: "INV-1", action: "create", status: "pending", queued_at: "2026-10-01T10:00:00Z" },
    { id: B, doc_type: "credit_note", doc_ref: "CN-1", action: "create", status: "failed", queued_at: "2026-10-02T10:00:00Z" },
  ];
  const posts: unknown[] = [];
  const queue = [...(opts.post ?? [])];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== "/api/integrations/xero/held") return { ok: false, status: 404, json: async () => ({}) };
    if ((init?.method ?? "GET") === "GET") { const status = opts.read ?? 200; return { ok: status < 400, status, json: async () => ({ held }) }; }
    const body = JSON.parse(String(init?.body)) as { sends: string[] }; posts.push(body);
    const next = queue.shift() ?? { status: 200, body: { approved: body.sends.length, already: 0 } };
    if (next.status < 400) held = (held as Array<{ id: string }>).filter((h) => !body.sends.includes(h.id));
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  }));
  return { posts };
}
beforeEach(() => { requestCode.mockReset(); });

it("lists the held documents; Approve is disabled until one is ticked; only the ticked one is sent", async () => {
  const { posts } = server();
  const { host, done } = await render(createElement(XeroHeldReview, { requestCode }));
  expect(host.textContent).toContain(HELD_REVIEW_INTRO);
  expect(host.textContent).toContain("INV-1");
  expect(host.textContent).toContain("CN-1");
  expect((q(host, "xero-held-approve") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { (q(host, `xero-held-${A}`) as HTMLInputElement).click(); });
  await act(async () => { (q(host, "xero-held-approve") as HTMLButtonElement).click(); });
  await settle();
  expect(posts).toEqual([{ sends: [A] }]);
  expect(host.textContent).not.toContain("INV-1");
  expect(host.textContent).toContain("CN-1");
  expect(q(host, "xero-held-message")?.textContent).toContain("Approved");
  await done();
});
it("asks for a fresh code when the server wants one, sends the same request once more; a cancelled code approves nothing", async () => {
  const fresh = { status: 403, body: { code: "mfa_recent_required", error: "fresh code" } };
  const first = server({ post: [fresh] });
  requestCode.mockResolvedValueOnce(true);
  let r = await render(createElement(XeroHeldReview, { requestCode }));
  await act(async () => { (q(r.host, `xero-held-${B}`) as HTMLInputElement).click(); });
  await act(async () => { (q(r.host, "xero-held-approve") as HTMLButtonElement).click(); });
  await settle();
  expect(requestCode).toHaveBeenCalledTimes(1);
  expect(first.posts).toEqual([{ sends: [B] }, { sends: [B] }]);
  await r.done();
  const second = server({ post: [fresh] });
  requestCode.mockResolvedValueOnce(false);
  r = await render(createElement(XeroHeldReview, { requestCode }));
  await act(async () => { (q(r.host, `xero-held-${A}`) as HTMLInputElement).click(); });
  await act(async () => { (q(r.host, "xero-held-approve") as HTMLButtonElement).click(); });
  await settle();
  expect(second.posts).toEqual([{ sends: [A] }]);
  expect(q(r.host, "xero-held-message")?.textContent).toContain("Nothing was approved");
  expect(r.host.textContent).toContain("INV-1");
  await r.done();
});
it("nothing held: nothing shown; an unreadable list says so", async () => {
  server({ held: [] });
  let r = await render(createElement(XeroHeldReview, { requestCode }));
  expect(r.host.textContent).toBe("");
  await r.done();
  server({ read: 503 });
  r = await render(createElement(XeroHeldReview, { requestCode }));
  expect(q(r.host, "xero-held-error")?.textContent).toContain("Nothing held is sent");
  await r.done();
});
