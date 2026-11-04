import { describe, expect, it, vi } from "vitest";
import { approveDraft, resolveClaim, saveChaseSteps } from "@/lib/chase/ui-store";
import { FakeDb } from "../support/fake-db";

describe("chase screen connections", () => {
  it("preserves existing step IDs and scopes edits to the company", async () => {
    const saved = [{ id: "step", days: 7, tone: "firm" }];
    const db = { rpc: vi.fn().mockResolvedValue({ data: saved, error: null }) };
    const before = [{ id: "step", days: 7, tone: "friendly" as const }];
    expect(await saveChaseSteps(db as never, "a", before, [{ days: 7, tone: "firm" }])).toEqual(saved);
    expect(db.rpc).toHaveBeenCalledWith("save_chase_steps_atomic", { p_org: "a", p_expected: before, p_steps: [{ days: 7, tone: "firm" }] });
  });
  it("makes no writes for unchanged steps", async () => {
    const db = new FakeDb();
    await saveChaseSteps(db as never, "a", [{ id: "step", days: 7, tone: "friendly" }], [{ days: 7, tone: "friendly" }]);
    expect(db.log).toEqual([]);
  });
  it.each([
    [{ days: 0, tone: "friendly" }], [{ days: 366, tone: "firm" }], [{ days: 7, tone: "firm" }, { days: 7, tone: "friendly" }],
  ])("refuses invalid settings before writes: %j", async (...steps) => {
    const db = new FakeDb();
    await expect(saveChaseSteps(db as never, "a", [], steps as never)).rejects.toThrow();
    expect(db.log).toEqual([]);
  });
  it("does not claim a successful save when RLS or concurrent changes update no rows", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "40001" } }) };
    await expect(saveChaseSteps(db as never, "a", [{ id: "gone", days: 7, tone: "friendly" }], [{ days: 7, tone: "firm" }])).rejects.toThrow(/Reload/);
  });
  it("uses the approval route with the exact reviewed text", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "sent", recorded: true })));
    await expect(approveDraft("draft", { subject: "Reviewed", body: "Text" }, request)).resolves.toMatchObject({ status: "sent" });
    expect(request).toHaveBeenCalledWith("/api/chase/approve", expect.objectContaining({ method: "POST", body: JSON.stringify({ history_id: "draft", expected_subject: "Reviewed", expected_body: "Text" }) }));
  });
  it.each([409, 403, 500])("retains errors instead of treating HTTP %s as sent", async (status) => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "no_provider", error: "Sending is not set up." }), { status }));
    await expect(approveDraft("draft", { subject: "Reviewed", body: "Text" }, request)).rejects.toThrow("Sending is not set up.");
  });
  it("does not treat a successful response containing a draft as sent", async () => {
    await expect(approveDraft("draft", { subject: "Reviewed", body: "Text" }, vi.fn().mockResolvedValue(new Response('{"status":"drafted"}')))).rejects.toThrow();
  });
  it("clears a claim only through its scoped RPC, never by updating payments", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ error: null }) };
    await resolveClaim(db as never, "invoice", "not_received");
    expect(db.rpc).toHaveBeenCalledWith("resolve_payment_claim", { p_invoice: "invoice", p_outcome: "not_received" });
  });
  it("propagates claim failures so the banner remains", async () => {
    await expect(resolveClaim({ rpc: vi.fn().mockResolvedValue({ error: new Error("refused") }) } as never, "invoice", "confirmed")).rejects.toThrow("refused");
  });
});
