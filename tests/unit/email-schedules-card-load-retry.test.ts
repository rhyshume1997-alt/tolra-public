// @vitest-environment jsdom
/**
 * Settings > Email schedules card: a single refused request while the card loads must not leave it on an error only a reload clears.
 * Found in CI (tests/e2e/email-schedules.spec.ts:114): one 502 from the gateway among the Settings page's parallel requests left
 * "Couldn't load the e-mail schedules" for good. Inputs: the card with its two data calls faked. Proves: a transient failure (a thrown
 * company lookup, a 5xx on the schedules read) is asked again and the card becomes ready; a failure that keeps happening ends in the
 * same error as before after three tries; a missing table, a database refusal and a company switched in another tab are shown at once,
 * without asking again. Must not change: this file proves; the card's wording and what it saves are covered elsewhere.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = { org: vi.fn(), read: vi.fn() };
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => ({ select: () => ({ eq: (...args: unknown[]) => calls.read(...args) }) }) },
}));
vi.mock("@/lib/supabase-business", () => ({ getCurrentOrganizationId: () => calls.org() }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: "admin" }) }));
vi.mock("@/components/chase/connected-settings", () => ({ ConnectedChaseSettings: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { EmailSchedulesCard } from "@/components/email-schedules/settings-card";
import { CompanyChangedError } from "@/lib/page-company";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  calls.org.mockReset().mockResolvedValue("org-1");
  calls.read.mockReset().mockResolvedValue({ data: [], error: null, status: 200 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

async function mountAndSettle() {
  await act(async () => { root.render(createElement(EmailSchedulesCard)); });
  // Let every retry wait (400 ms then 1500 ms) and the promises behind it run.
  for (let i = 0; i < 6; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
}
const ready = () => host.querySelector('[data-testid="email-schedule-invoice_reminder"]') !== null;
const loadError = () => host.textContent?.includes("Couldn't load the e-mail schedules") ?? false;

describe("Email schedules card: loading", () => {
  it("loads at once when nothing fails", async () => {
    await mountAndSettle();
    expect(ready()).toBe(true);
    expect(calls.org).toHaveBeenCalledTimes(1);
  });
  it("asks again after a failed company lookup (a refused request) and becomes ready", async () => {
    calls.org.mockRejectedValueOnce(new Error("User profile organization was not found."));
    await mountAndSettle();
    expect(ready()).toBe(true);
    expect(loadError()).toBe(false);
    expect(calls.org).toHaveBeenCalledTimes(2);
  });
  it("asks again after a 5xx on the schedules read and becomes ready", async () => {
    calls.read.mockResolvedValueOnce({ data: null, error: { code: "", message: "bad gateway" }, status: 502 });
    await mountAndSettle();
    expect(ready()).toBe(true);
    expect(calls.read).toHaveBeenCalledTimes(2);
  });
  it("a failure that keeps happening ends in the load error after three tries, and no card is shown", async () => {
    calls.org.mockRejectedValue(new Error("down"));
    await mountAndSettle();
    expect(ready()).toBe(false);
    expect(loadError()).toBe(true);
    expect(calls.org).toHaveBeenCalledTimes(3);
  });
  it("a missing table is shown as not available at once, without asking again", async () => {
    calls.read.mockResolvedValue({ data: null, error: { code: "PGRST205", message: "no table" }, status: 404 });
    await mountAndSettle();
    expect(ready()).toBe(false);
    expect(host.textContent).not.toContain("Couldn't load the e-mail schedules");
    expect(calls.read).toHaveBeenCalledTimes(1);
  });
  it("a database refusal (a 4xx) is shown at once, without asking again", async () => {
    calls.read.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" }, status: 403 });
    await mountAndSettle();
    expect(loadError()).toBe(true);
    expect(calls.read).toHaveBeenCalledTimes(1);
  });
  it("a company switched in another tab is shown at once, without asking again", async () => {
    calls.org.mockRejectedValue(new CompanyChangedError());
    await mountAndSettle();
    expect(loadError()).toBe(true);
    expect(calls.org).toHaveBeenCalledTimes(1);
  });
});
