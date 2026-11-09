// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ role: "admin", org: "org", hidden: [] as string[], rpc: vi.fn(), payload: {} as Record<string, unknown>, error: null as null | { code: string; message: string } }));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: mock.rpc } }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: mock.role, profile: { organization_id: mock.org }, hiddenSections: mock.hidden }) }));
vi.mock("@/lib/demo", () => ({ DEMO_MODE: false }));
import { JobProfitabilityActuals } from "@/components/job-profitability-actuals";

let root: Root, host: HTMLDivElement;
const figures = { state: "complete", reasons: [], labour_us: 5_400_000_000, machine_us: 1_800_000_000, labour_pence: 3300, machine_pence: 2250, overhead_pence: 2775, supplier_pence: 0 };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mock.role = "admin"; mock.org = "org"; mock.hidden = []; mock.rpc.mockReset(); mock.error = null;
  mock.payload = { organizationId: "org", jobId: "job", configured: true, open: true, canConfigure: true, config: { enabled: false, revision: 0, approved_at: null },
    machineChoices: [{ id: "mill", name: "Mill 1" }], costingMachines: [{ id: "haas", name: "Haas VF2" }], links: [], declarations: null };
  mock.rpc.mockImplementation(async (name: string) => (name === "job_profitability_actual_inputs" ? { data: mock.payload, error: mock.error } : { data: null, error: null }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = async () => { await act(async () => root.render(createElement(JobProfitabilityActuals, { jobId: "job" }))); };
const button = (text: RegExp) => [...host.querySelectorAll("button")].find(b => text.test(b.textContent ?? ""))!;

it.each(["workshop", "viewer"])("never reads financial inputs for %s", async role => { mock.role = role; await mount(); expect(mock.rpc).not.toHaveBeenCalled(); expect(host.textContent).toBe(""); });
it("hidden for office while off; silent before 148 is installed", async () => {
  mock.role = "office"; mock.payload.canConfigure = false; await mount(); expect(host.textContent).toBe("");
  mock.role = "admin"; mock.error = { code: "PGRST202", message: "missing" }; await mount(); expect(host.textContent).toBe("");
});
it("admin, off: no rate fields (rates live in Settings > Costing rates), switch on with the revision, link machines to 143 costing machines", async () => {
  await mount();
  expect(host.textContent).toContain("Actual job costing (off)");
  expect(host.textContent).toContain("Settings > Costing rates");
  expect(host.querySelector('input[name="labour"], input[name^="rate-"], select[name="basis"]')).toBeNull();
  expect(host.textContent).not.toContain("Actual margin");
  await act(async () => button(/switch job costing on/).click());
  expect(mock.rpc).toHaveBeenCalledWith("set_job_costing_enabled", { p_organization: "org", p_revision: 0, p_enabled: true });
  (host.querySelector('select[name="link-mill"]') as HTMLSelectElement).value = "haas";
  await act(async () => button(/Save machine links/).closest("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })));
  expect(mock.rpc).toHaveBeenCalledWith("save_job_costing_machine_links", { p_organization: "org", p_links: [{ machine_id: "mill", costing_machine_id: "haas" }] });
});
it("not configured in 143: the switch cannot be turned on and 143's message is shown", async () => {
  mock.payload.configured = false; await mount();
  expect(host.textContent).toContain("Costing is not set up: enter your rates in Settings > Costing rates");
  expect(button(/switch job costing on/).disabled).toBe(true);
});
it("office, open job: figures labelled at today's rates; incomplete shows reasons and no money", async () => {
  mock.role = "office";
  Object.assign(mock.payload, { canConfigure: false, config: { enabled: true, revision: 1, approved_at: "2026-11-04" }, declarations: { labour_not_required: false, machines_not_required: false },
    live: figures, snapshot: null, invoices: [{ id: "i", status: "sent", subtotal: "200.00" }], credits: [], quoteLines: [] });
  await mount();
  expect(host.querySelector('[data-testid="actual-costing-basis"]')?.getAttribute("data-basis")).toBe("todays_rates");
  expect(host.textContent).toContain("today's rates");
  expect(host.textContent).toContain("£33.00");
  expect(host.textContent).not.toContain("Company job costing");
  mock.payload.live = { ...figures, state: "incomplete", reasons: ["A labour or machine timer on this job is still running"], labour_pence: null, machine_pence: null, overhead_pence: null, supplier_pence: null };
  await act(async () => root.render(createElement(JobProfitabilityActuals, { jobId: "job", key: "again" })));
  expect(host.textContent).toContain("Incomplete: A labour or machine timer on this job is still running");
  expect(host.textContent).not.toMatch(/£(?!200\.00)\d/);
});
it("closed job with a record: labelled as recorded, and the record can be re-worked from corrected times", async () => {
  mock.role = "office";
  Object.assign(mock.payload, { canConfigure: false, open: false, config: { enabled: true, revision: 1, approved_at: "2026-11-04" }, declarations: { labour_not_required: false, machines_not_required: false },
    live: null, snapshot: { ...figures, taken_on: "finished", taken_at: "2026-10-01T09:00:00Z", refreshed_at: null, rates_read_at: "2026-10-01T09:00:00Z" },
    invoices: [], credits: [], quoteLines: [] });
  await mount();
  expect(host.querySelector('[data-testid="actual-costing-basis"]')?.getAttribute("data-basis")).toBe("recorded");
  expect(host.textContent).toContain("Recorded when this job finished (2026-10-01)");
  await act(async () => button(/Re-work the record/).click());
  expect(mock.rpc).toHaveBeenCalledWith("refresh_job_cost_snapshot", { p_job: "job" });
});
