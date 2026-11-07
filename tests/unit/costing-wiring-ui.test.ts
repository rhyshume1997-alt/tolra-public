// @vitest-environment jsdom
/**
 * The two wirings, with the real components and stand-ins for the database (no network):
 *   Settings > Costing rates (CostingRatesPanel): admin/office only, blank ("No costing rates entered yet"), partly set up (says what is missing),
 *   configured, save sends ONE save_costing_settings_atomic call with the snapshot read at load, stale conflict (40001), fresh authenticator code
 *   asked once and the same save sent once more (cancel sends nothing), permission / invalid / 143-not-applied / network errors, load errors.
 *   Quote builder (QuotePricePanelView): admin/office only, blank and partly set up show no figures, configured prices from the company's rates,
 *   "Add as quote line" hands over plain values, "Add cost to internal notes", Enter doesn't submit the quote form, load error, 143 not applied.
 */
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: "admin" }) }));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/supabase-business", () => ({ getCurrentOrganizationId: async () => "org-1" }));
vi.mock("@/components/authenticator-code-dialog", () => ({ useCodePrompt: () => ({ requestCode: async () => true, codeDialog: null }) }));

import { CostingRatesPanel } from "@/components/costing/costing-rates-card";
import { QuotePricePanelView, PriceThisPart } from "@/components/costing/price-this-part";
import { blankCostingRates, type CostingRates } from "@/components/costing/types";
import { EMPTY_SNAPSHOT, saveRates, type LoadedRates, type RatesSnapshot } from "@/lib/costing/app-rates";
import { MFA_RECENT_CODE } from "@/lib/mfa-policy";
import { CONFIGURED } from "./costing-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const text = () => host.textContent ?? "";
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T | null;
const byLabel = (label: string) => q<HTMLInputElement>(`[aria-label="${label}"]`)!;
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
async function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const click = async (el: HTMLElement | undefined) => { await act(async () => { el!.click(); }); };
const flush = () => act(async () => { await Promise.resolve(); });

const okLoad = (rates: CostingRates, snapshot: RatesSnapshot = EMPTY_SNAPSHOT): (() => Promise<LoadedRates>) => async () => ({ status: "ok", rates, snapshot });
const SNAP: RatesSnapshot = {
  materials: [{ id: CONFIGURED.materials[0].id, name: "Steel bar", price_pence: 400, price_unit: "kg", scrap_pct: 5 }],
  machines: [{ id: CONFIGURED.machines[0].id, name: "Mill", hourly_rate_pence: 6500, labour_rate_pence: null }],
  defaults: { labour_rate_pence: 2500, programming_rate_pence: 4000, overhead_pct: 150, default_margin_pct: 20 },
};
const OK = { ok: true, status: 200, body: { kind: "saved", message: "Costing rates saved." } } as const;

async function drawRates(props: Partial<Parameters<typeof CostingRatesPanel>[0]> = {}) {
  const full = { role: "admin", load: okLoad(CONFIGURED, SNAP), save: vi.fn(async () => OK), requestCode: vi.fn(async () => true), ...props } as Parameters<typeof CostingRatesPanel>[0];
  await act(async () => root.render(createElement(CostingRatesPanel, full)));
  await flush();
  return full;
}

describe("Settings > Costing rates", () => {
  it.each(["workshop", "viewer", "customer"])("is not shown to %s (and loads nothing)", async (role) => {
    const load = vi.fn(okLoad(CONFIGURED, SNAP));
    await drawRates({ role, load });
    expect(text()).toBe("");
    expect(load).not.toHaveBeenCalled();
  });
  it.each(["admin", "office"])("is shown to %s", async (role) => {
    await drawRates({ role });
    expect(text()).toContain("Costing rates");
    expect(byLabel("Margin %").value).toBe("20");
  });
  it("blank company: says 'No costing rates entered yet', every box empty, nothing filled in", async () => {
    await drawRates({ load: okLoad(blankCostingRates) });
    expect(text()).toContain("No costing rates entered yet");
    for (const label of ["Labour £ per hour", "Programming £ per hour", "Overhead %", "Margin %"]) expect(byLabel(label).value).toBe("");
    expect(host.querySelectorAll('[aria-label^="Material name"]').length + host.querySelectorAll('[aria-label^="Machine name"]').length).toBe(0);
  });
  it("a new material and machine start blank (no default price, scrap or rate)", async () => {
    await drawRates({ load: okLoad(blankCostingRates) });
    await click(button("Add material"));
    await click(button("Add machine"));
    for (const el of host.querySelectorAll<HTMLInputElement>('input[type="number"]')) expect(el.value).toBe("");
  });
  it("partly set up: says what is still to enter", async () => {
    await drawRates({ load: okLoad({ ...CONFIGURED, machines: [], defaults: { ...CONFIGURED.defaults, marginPct: null } }, SNAP) });
    expect(text()).not.toContain("No costing rates entered yet");
    expect(text()).toContain("Still to enter: a machine, the margin %.");
  });
  it("fully set up: no warning", async () => {
    await drawRates();
    expect(text()).not.toMatch(/No costing rates|Still to enter/);
  });
  it("saving sends one atomic save with the snapshot read at load and the changed value", async () => {
    const props = await drawRates();
    await type(byLabel("Margin %"), "25");
    await click(button("Save costing rates"));
    expect(props.save).toHaveBeenCalledTimes(1);
    const [expected, rates] = (props.save as ReturnType<typeof vi.fn>).mock.calls[0] as [RatesSnapshot, CostingRates];
    expect(expected).toEqual(SNAP);
    expect(rates.defaults.marginPct).toBe(25);
    expect(text()).toContain("Costing rates saved.");
  });
  it("after a save the rates are read again (the snapshot moves on)", async () => {
    const load = vi.fn(okLoad(CONFIGURED, SNAP));
    await drawRates({ load });
    await click(button("Save costing rates"));
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("a value the database would refuse is stopped first, nothing is sent", async () => {
    const props = await drawRates();
    await type(byLabel("Overhead %"), "15");
    await click(button("Save costing rates"));
    expect(props.save).not.toHaveBeenCalled();
    expect(text()).toMatch(/Enter the overhead %/);
  });
  it("blank company can't be saved until every company rate is entered", async () => {
    const props = await drawRates({ load: okLoad(blankCostingRates) });
    await click(button("Save costing rates"));
    expect(props.save).not.toHaveBeenCalled();
    expect(text()).toMatch(/labour rate/);
  });
  it("stale conflict: says nothing was saved, offers Reload, and Reload shows the other person's rates", async () => {
    const theirs = { ...CONFIGURED, defaults: { ...CONFIGURED.defaults, marginPct: 40 } };
    const load = vi.fn<() => Promise<LoadedRates>>()
      .mockResolvedValueOnce({ status: "ok", rates: CONFIGURED, snapshot: SNAP })
      .mockResolvedValueOnce({ status: "ok", rates: theirs, snapshot: SNAP });
    const save = vi.fn(async () => ({ ok: false, status: 409, body: { kind: "stale", message: "Someone else changed the costing rates since you opened this page. Nothing was saved. Reload to see their changes, then make yours again." } }));
    await drawRates({ load, save: save as never });
    await type(byLabel("Margin %"), "25");
    await click(button("Save costing rates"));
    expect(text()).toContain("Someone else changed the costing rates");
    expect(byLabel("Margin %").value).toBe("25"); // my edit is kept until I choose to reload
    await click(button("Reload costing rates"));
    expect(byLabel("Margin %").value).toBe("40");
    expect(text()).not.toContain("Someone else changed");
  });
  it("a fresh authenticator code is asked for once and the same save is sent once more", async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403, body: { kind: "mfa", code: MFA_RECENT_CODE, message: "code" } })
      .mockResolvedValueOnce(OK);
    const requestCode = vi.fn(async () => true);
    await drawRates({ save: save as never, requestCode });
    await click(button("Save costing rates"));
    expect(requestCode).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
    expect(text()).toContain("Costing rates saved.");
  });
  it("cancelling the code prompt sends nothing more and says so", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, status: 403, body: { kind: "mfa", code: MFA_RECENT_CODE, message: "code" } });
    await drawRates({ save: save as never, requestCode: async () => false });
    await click(button("Save costing rates"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(text()).toContain("no authenticator code was entered");
  });
  it.each([
    ["permission", "You don't have permission to change costing rates. Ask an admin or office user."],
    ["invalid", "One of the rates isn't allowed."],
    ["not_applied", "Not available until database update 143 is applied."],
    ["error", "Couldn't save the costing rates. Nothing was changed."],
  ])("a %s refusal is shown in words, not codes", async (kind, message) => {
    const save = vi.fn(async () => ({ ok: false, status: 400, body: { kind, message } }));
    await drawRates({ save: save as never });
    await click(button("Save costing rates"));
    expect(text()).toContain(message);
    expect(q('[role="alert"]')).not.toBeNull();
  });
  it("143 not applied: the card says so and has no editor", async () => {
    await drawRates({ load: async () => ({ status: "not_applied" }) });
    expect(text()).toContain("Not available until database update 143 is applied.");
    expect(button("Save costing rates")).toBeUndefined();
  });
  it("a load error says so and offers Try again", async () => {
    const load = vi.fn<() => Promise<LoadedRates>>().mockResolvedValueOnce({ status: "error", message: "Couldn't load the costing rates. Try again." }).mockResolvedValueOnce({ status: "ok", rates: CONFIGURED, snapshot: SNAP });
    await drawRates({ load });
    expect(text()).toContain("Couldn't load the costing rates.");
    await click(button("Try again"));
    expect(text()).toContain("Add material");
  });
});

describe("saveRates against the database function", () => {
  const fake = (error: unknown) => { const rpc = vi.fn(async () => ({ error })); return { client: { rpc } as never, rpc }; };
  it("calls save_costing_settings_atomic(p_org, p_expected, p_value) once, in whole pence", async () => {
    const { client, rpc } = fake(null);
    const answer = await saveRates(client, "org-1", SNAP, CONFIGURED);
    expect(answer.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("save_costing_settings_atomic", { p_org: "org-1", p_expected: SNAP, p_value: SNAP });
  });
  it.each([
    [{ code: "40001", message: "Settings changed; reload" }, 409, "stale"],
    [{ code: "42501", message: "Confirm your authenticator code first (second step of sign-in).", hint: "mfa_required" }, 403, "mfa"],
    [{ code: "42501", message: "Not permitted" }, 400, "permission"],
    [{ code: "22023", message: "Invalid settings" }, 400, "invalid"],
    [{ code: "23514", message: "violates check" }, 400, "invalid"],
    [{ code: "PGRST202", message: "Could not find the function" }, 400, "not_applied"],
    [{ code: "XX000", message: "boom costing_materials" }, 400, "error"],
  ])("maps %j", async (error, status, kind) => {
    const answer = await saveRates(fake(error).client, "org-1", SNAP, CONFIGURED);
    expect([answer.ok, answer.status, answer.body?.kind]).toEqual([false, status, kind]);
    expect(answer.body?.message).not.toMatch(/costing_materials|violates|PGRST/); // no table names or codes shown
    if (kind === "mfa") expect(answer.body?.code).toBe(MFA_RECENT_CODE);
  });
  it("a thrown network error is a plain failure", async () => {
    const client = { rpc: async () => { throw new Error("offline"); } } as never;
    const answer = await saveRates(client, "org-1", SNAP, CONFIGURED);
    expect(answer.ok).toBe(false);
    expect(answer.body?.message).toContain("Check your connection");
  });
  it("an invalid draft never reaches the database", async () => {
    const { client, rpc } = fake(null);
    const answer = await saveRates(client, "org-1", SNAP, blankCostingRates);
    expect(answer.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

async function drawQuote(props: Partial<Parameters<typeof QuotePricePanelView>[0]> = {}) {
  const full = { role: "office", load: okLoad(CONFIGURED, SNAP), onAdd: vi.fn(), onCostNote: vi.fn(), ...props } as Parameters<typeof QuotePricePanelView>[0];
  await act(async () => root.render(createElement(QuotePricePanelView, full)));
  await flush();
  return full;
}
async function describePart() {
  await type(byLabel("Part description"), "Bush 40mm");
  await type(byLabel("Part quantity"), "10");
  await type(byLabel("Material weight kg per part"), "0.5");
  await type(byLabel("Setup hours for batch"), "1");
  await type(byLabel("Cycle hours per part"), "0.2");
  await type(byLabel("Programming hours for batch"), "2");
}
const noMoney = () => expect(text()).not.toMatch(/£\d/);

describe("Quote builder: Price this part", () => {
  it.each(["workshop", "viewer", "customer"])("is not shown to %s (and loads nothing)", async (role) => {
    const load = vi.fn(okLoad(CONFIGURED, SNAP));
    await drawQuote({ role, load });
    expect(text()).toBe("");
    expect(load).not.toHaveBeenCalled();
  });
  it.each(["admin", "office"])("is shown to %s", async (role) => {
    await drawQuote({ role });
    expect(text()).toContain("Price this part");
  });
  it("blank company: 'Costing is not set up: enter your rates in Settings > Costing rates', no inputs, no figures", async () => {
    await drawQuote({ load: okLoad(blankCostingRates) });
    expect(text()).toContain("Costing is not set up: enter your rates in Settings > Costing rates");
    expect(text()).not.toContain("Still to enter");
    expect(host.querySelectorAll("input").length).toBe(0);
    expect(button("Add as quote line")).toBeUndefined();
    noMoney();
  });
  it("partly set up: same message plus what is missing, still no figures", async () => {
    await drawQuote({ load: okLoad({ ...CONFIGURED, machines: [], defaults: { ...CONFIGURED.defaults, programmingPerHour: null } }, SNAP) });
    expect(text()).toContain("Costing is not set up: enter your rates in Settings > Costing rates");
    expect(text()).toContain("Still to enter: a machine, the programming rate.");
    expect(button("Add as quote line")).toBeUndefined();
    noMoney();
  });
  it("configured but nothing typed yet: no figures, says what to enter", async () => {
    await drawQuote();
    expect(text()).toContain("Enter the material weight per part, the cycle time per part to see the price.");
    noMoney();
    expect(button("Add as quote line")!.disabled).toBe(true);
  });
  it("configured: prices from the company's rates (the worked example)", async () => {
    await drawQuote();
    await describePart();
    const breakdown = q('[aria-label="Cost breakdown"]')!.textContent!;
    for (const line of ["Material: £2.10", "Machine: £19.50", "Labour: £7.50", "Programming: £8.00", "Overhead: £13.50", "Cost per part: £50.60", "Price per part: £60.72", "Total quote: £607.20"]) expect(breakdown).toContain(line);
  });
  it("Add as quote line hands over plain values; later rate changes can't reach it", async () => {
    const props = await drawQuote();
    await describePart();
    await click(button("Add as quote line"));
    expect(props.onAdd).toHaveBeenCalledTimes(1);
    const line = (props.onAdd as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(line).toEqual({ description: "Bush 40mm", qty: 10, unit: 60.72, source: "costing_calculator" });
    const kept = structuredClone(line);
    // The rates change: the panel (re-read) prices differently, the line already handed over does not.
    const dearer = { ...CONFIGURED, defaults: { ...CONFIGURED.defaults, marginPct: 50 } };
    await act(async () => root.render(createElement(PriceThisPart, { rates: dearer, onAdd: vi.fn() })));
    expect(line).toEqual(kept);
  });
  it("Add cost to internal notes sends the breakdown as text", async () => {
    const props = await drawQuote();
    await describePart();
    await click(button("Add cost to internal notes"));
    expect((props.onCostNote as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/^Costing \d{4}-\d\d-\d\d: Bush 40mm x10\. Material £2\.10.*Cost per part £50\.60, price per part £60\.72 \(margin 20%\)\.$/);
  });
  it("the buttons stay off until the part has a description", async () => {
    await drawQuote();
    await type(byLabel("Part quantity"), "10");
    await type(byLabel("Material weight kg per part"), "0.5");
    await type(byLabel("Cycle hours per part"), "0.2");
    expect(button("Add as quote line")!.disabled).toBe(true);
    await type(byLabel("Part description"), "Bush");
    expect(button("Add as quote line")!.disabled).toBe(false);
  });
  it("picking another machine or material re-prices", async () => {
    const two: CostingRates = { ...CONFIGURED, machines: [...CONFIGURED.machines, { id: "44444444-4444-4444-8444-444444444444", name: "Lathe", hourlyRate: 45, labourPerHour: null }] };
    await drawQuote({ load: okLoad(two, SNAP) });
    await describePart();
    await type(byLabel("Part machine"), "44444444-4444-4444-8444-444444444444");
    expect(q('[aria-label="Cost breakdown"]')!.textContent).toContain("Machine: £13.50");
  });
  it("a material priced each asks for pieces per part", async () => {
    await drawQuote({ load: okLoad({ ...CONFIGURED, materials: [{ ...CONFIGURED.materials[0], unit: "each", price: 3, scrapPct: 0 }] }, SNAP) });
    expect(byLabel("Pieces per part")).not.toBeNull();
    expect(q('[aria-label="Material weight kg per part"]')).toBeNull();
  });
  it("Enter in a box does not submit the quote form around it", async () => {
    const submitted = vi.fn((e: Event) => e.preventDefault());
    await act(async () => root.render(createElement("form", { onSubmit: submitted as never }, createElement(QuotePricePanelView, { role: "admin", load: okLoad(CONFIGURED, SNAP), onAdd: vi.fn() }))));
    await flush();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    byLabel("Part quantity").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it("a load error says so and shows no figures", async () => {
    await drawQuote({ load: async () => ({ status: "error", message: "x" }) });
    expect(text()).toContain("Couldn't load your costing rates.");
    noMoney();
  });
  it("143 not applied: the panel stays out of the way", async () => {
    await drawQuote({ load: async () => ({ status: "not_applied" }) });
    expect(text()).toBe("");
  });
});
