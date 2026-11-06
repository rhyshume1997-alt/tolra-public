/**
 * sm-b (4): the password-change ticket (migration 137) as the app sees it. Read-only confirmation of the NOT_APPLIED path.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { issuePasswordChangeTicket, revokePasswordChangeTicket } from "@/lib/server/password-ticket";

const client = (result: { data?: unknown; error?: { code?: string } | null } | Error) => ({ rpc: vi.fn(async () => { if (result instanceof Error) throw result; return { data: result.data ?? null, error: result.error ?? null }; }) });

describe("sm-b: password ticket outcomes", () => {
  it("137 absent (PGRST202 or 42883): proceeds with NO ticket, so the old path still works", async () => {
    expect(await issuePasswordChangeTicket(client({ error: { code: "PGRST202" } }), "u", "own_change")).toEqual({ ok: true, ticket: null });
    expect(await issuePasswordChangeTicket(client({ error: { code: "42883" } }), "u", "admin_set")).toEqual({ ok: true, ticket: null });
  });
  it("any other error, an empty answer or a throw fails closed: nothing may be sent to Auth", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await issuePasswordChangeTicket(client({ error: { code: "42501" } }), "u", "own_change")).toEqual({ ok: false });
    expect(await issuePasswordChangeTicket(client({ data: "" }), "u", "own_change")).toEqual({ ok: false });
    expect(await issuePasswordChangeTicket(client(new Error("down")), "u", "own_change")).toEqual({ ok: false });
  });
  it("a ticket is passed through; revoke is skipped for a null ticket and never throws", async () => {
    expect(await issuePasswordChangeTicket(client({ data: "t1" }), "u", "own_change")).toEqual({ ok: true, ticket: "t1" });
    const c = client({ data: true });
    await revokePasswordChangeTicket(c, null);
    expect(c.rpc).not.toHaveBeenCalled();
    await expect(revokePasswordChangeTicket(client(new Error("x")), "t1")).resolves.toBeUndefined();
  });
});
