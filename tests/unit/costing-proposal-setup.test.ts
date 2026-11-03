import { describe, expect, it, vi } from "vitest";
import { prepareCostingProposal } from "../support/costing-proposal-setup";

function stand(exists = false) {
  return {
    verify: vi.fn().mockResolvedValue(undefined), exists: vi.fn().mockResolvedValue(exists),
    install: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined),
  };
}
describe("atomic costing test setup", () => {
  it("CI prepares the fixture only after isolation is verified, then removes only its own fixture", async () => {
    const setup = stand();
    const cleanup = await prepareCostingProposal({ CI: "true" }, setup);
    expect(setup.verify.mock.invocationCallOrder[0]).toBeLessThan(setup.exists.mock.invocationCallOrder[0]);
    expect(setup.exists.mock.invocationCallOrder[0]).toBeLessThan(setup.install.mock.invocationCallOrder[0]);
    expect(setup.install).toHaveBeenCalledTimes(1);
    await cleanup();
    expect(setup.verify).toHaveBeenCalledTimes(2);
    expect(setup.verify.mock.invocationCallOrder[1]).toBeLessThan(setup.remove.mock.invocationCallOrder[0]);
    expect(setup.remove).toHaveBeenCalledTimes(1);
  });
  it("does no database work without an operator acknowledgement outside CI", async () => {
    const setup = stand();
    await expect(prepareCostingProposal({}, setup)).rejects.toThrow("COSTING_ATOMIC_THROWAWAY=yes");
    expect(setup.verify).not.toHaveBeenCalled(); expect(setup.install).not.toHaveBeenCalled();
  });
  it.each([{ CI: "true" }, { COSTING_ATOMIC_THROWAWAY: "yes" }])("isolation failure blocks every read and write: %j", async env => {
    const setup = stand(); setup.verify.mockRejectedValue(new Error("Not disposable"));
    await expect(prepareCostingProposal(env, setup)).rejects.toThrow("Not disposable");
    expect(setup.exists).not.toHaveBeenCalled(); expect(setup.install).not.toHaveBeenCalled(); expect(setup.remove).not.toHaveBeenCalled();
  });
  it.each([{ CI: "true" }, { COSTING_ATOMIC_THROWAWAY: "yes" }])("preserves an existing proposal: %j", async env => {
    const setup = stand(true); const cleanup = await prepareCostingProposal(env, setup); await cleanup();
    expect(setup.verify).toHaveBeenCalledTimes(1);
    expect(setup.install).not.toHaveBeenCalled(); expect(setup.remove).not.toHaveBeenCalled();
  });
  it("an acknowledged manual run still requires the operator to install the proposal", async () => {
    const setup = stand();
    await expect(prepareCostingProposal({ COSTING_ATOMIC_THROWAWAY: "yes" }, setup)).rejects.toThrow("Proposal missing");
    expect(setup.install).not.toHaveBeenCalled();
  });
  it("does not clean up after a failed installation", async () => {
    const setup = stand(); setup.install.mockRejectedValue(new Error("DDL failed"));
    await expect(prepareCostingProposal({ CI: "true" }, setup)).rejects.toThrow("DDL failed");
    expect(setup.remove).not.toHaveBeenCalled();
  });
  it("rechecks isolation before cleanup", async () => {
    const setup = stand(); const cleanup = await prepareCostingProposal({ CI: "true" }, setup);
    setup.verify.mockRejectedValue(new Error("Not disposable"));
    await expect(cleanup()).rejects.toThrow("Not disposable"); expect(setup.remove).not.toHaveBeenCalled();
  });
});
