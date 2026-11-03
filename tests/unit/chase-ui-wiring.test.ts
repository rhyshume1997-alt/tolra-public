import { describe, expect, it, vi } from "vitest";
import { approveDraft, resolveClaim, saveChaseSteps } from "@/lib/chase/ui-store";
import { FakeDb } from "../support/fake-db";

const reviewed = { subject: "Reviewed invoice subject", body: "Hello\n\nExactly this approved message.\n" };

describe("chase screen connections", () => {
  it("preserves existing step IDs and scopes edits to the company", async () => {
    const db = new FakeDb({ chase_steps: [{ id: "step", organization_id: "a", offset_days: 7, tone: "friendly" }, { id: "foreign", organization_id: "b", offset_days: 7, tone: "friendly" }] });
    await saveChaseSteps(db as never, "a", [{ id: "step", days: 7, tone: "friendly" }], [{ days: 7, tone: "firm" }]);
    expect(db.tables.chase_steps).toEqual([{ id: "step", organization_id: "a", offset_days: 7, tone: "firm" }, { id: "foreign", organization_id: "b", offset_days: 7, tone: "friendly" }]);
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
    const db = new FakeDb({ chase_steps: [] });
    await expect(saveChaseSteps(db as never, "a", [{ id: "gone", days: 7, tone: "friendly" }], [{ days: 7, tone: "firm" }])).rejects.toThrow(/Reload/);
  });
  it("passes the exact reviewed subject and body to the approval route", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "sent", recorded: true })));
    await expect(approveDraft("draft", reviewed, request)).resolves.toMatchObject({ status: "sent" });
    expect(request).toHaveBeenCalledWith("/api/chase/approve", expect.objectContaining({ method: "POST", body: JSON.stringify({ history_id: "draft", subject: reviewed.subject, body: reviewed.body }) }));
  });
  it.each([409, 403, 500])("retains errors instead of treating HTTP %s as sent", async (status) => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "no_provider", error: "Sending is not set up." }), { status }));
    await expect(approveDraft("draft", reviewed, request)).rejects.toThrow("Sending is not set up.");
  });
  it("does not treat a successful response containing a draft as sent", async () => {
    await expect(approveDraft("draft", reviewed, vi.fn().mockResolvedValue(new Response('{"status":"drafted"}')))).rejects.toThrow();
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
