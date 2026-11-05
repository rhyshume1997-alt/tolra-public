import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "../support/fake-db";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ service: null as unknown, ready: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => h.service }));
vi.mock("@/lib/integrations/microsoft/client", () => ({ microsoftReady: h.ready, microsoftTokenSource: () => h.token }));
import { selectProvider } from "@/lib/email/send-company-email";
const env = { RESEND_API_KEY: "re_mock_only", EMAIL_FROM: "office@example.test" };
let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ integration_connections: [{ organization_id: "a", provider: "microsoft", status: "connected" }, { organization_id: "b", provider: "microsoft", status: "connected" }] });
  h.service = db; h.ready.mockReset().mockResolvedValue({}); h.token.mockReset().mockResolvedValue("fake-access-a");
});
describe("provider choice fails closed; never sends through a second provider", () => {
  it.each(["needs_reconnect", "error", "unknown"])("Microsoft %s refuses even with Resend configured", async (status) => {
    db.rows("integration_connections")[0].status = status;
    await expect(selectProvider("a", { env })).rejects.toThrow();
    expect(h.token).not.toHaveBeenCalled();
  });
  it("a connected company whose app credentials disappeared is refused", async () => {
    h.ready.mockResolvedValue(null);
    await expect(selectProvider("a", { env })).rejects.toThrow();
  });
  it("a refused or missing delegated token is not Resend permission", async () => {
    h.token.mockResolvedValue(null);
    await expect(selectProvider("a", { env })).rejects.toThrow();
  });
  it("a missing service client cannot establish that Microsoft is disconnected", async () => {
    h.service = null;
    await expect(selectProvider("a", { env })).rejects.toThrow();
  });
  it("database errors refuse provider selection", async () => {
    db.failing.integration_connections = { code: "08006", message: "Unavailable" };
    await expect(selectProvider("a", { env })).rejects.toThrow();
  });
  it("a company without a Microsoft connection may use configured Resend, without reading another company's token", async () => {
    expect(await selectProvider("c", { env })).toMatchObject({ name: "resend" });
    expect(h.token).not.toHaveBeenCalled();
  });
  it("explicitly disconnected Microsoft may use Resend", async () => {
    db.rows("integration_connections")[0].status = "disconnected";
    expect(await selectProvider("a", { env })).toMatchObject({ name: "resend" });
    expect(h.token).not.toHaveBeenCalled();
  });
  it("a connected company uses only its own token", async () => {
    expect(await selectProvider("a", { env })).toMatchObject({ name: "microsoft" });
    expect(h.token).toHaveBeenCalledTimes(1);
    expect(h.token).toHaveBeenCalledWith("a");
  });
});
