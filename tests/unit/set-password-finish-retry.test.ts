// @vitest-environment jsdom
// Models the account setup UI after a saved password and a failed finish request.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetPasswordPage from "@/app/auth/set-password/page";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: {} } }),
      getUser: async () => ({ data: { user: { id: "test-user", email: "test@example.test" } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentAuthenticationMethods: [] } }) },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { must_change_password: true } }) }) }) }),
  },
}));

let host: HTMLDivElement;
let root: Root;
const fetch = vi.fn<typeof globalThis.fetch>();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetch);
  fetch.mockReset();
  router.replace.mockClear();
  router.refresh.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(SetPasswordPage)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function button(label: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === label);
}

async function enterPartialSetup() {
  const password = "LocalOnlyTest123";
  host.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((field) => { field.value = password; });
  fetch.mockResolvedValueOnce(Response.json({ error: "Password saved. Finish set-up.", partial: true }, { status: 503 }));
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(button("Finish set-up")).toBeDefined();
}

describe("finish password setup recovery", () => {
  it.each(["network failure", "gateway failure"])("retains the finish action after a %s", async (failure) => {
    await enterPartialSetup();
    if (failure === "network failure") fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    else fetch.mockResolvedValueOnce(new Response("Gateway error", { status: 502 }));

    await act(async () => { button("Finish set-up")!.click(); });
    expect(host.textContent).toContain("Couldn't finish setting up your account. Try again.");
    expect(button("Finish set-up")).toBeDefined();
    expect(button("Save password and continue")).toBeUndefined();

    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch.mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => { button("Finish set-up")!.click(); });
    const requestBodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requestBodies.slice(1)).toEqual([{ finish: true }, { finish: true }]);
    expect(router.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("returns to password entry when the server explicitly requires it", async () => {
    await enterPartialSetup();
    fetch.mockResolvedValueOnce(Response.json({ error: "Choose your new password below." }, { status: 409 }));
    await act(async () => { button("Finish set-up")!.click(); });
    expect(host.textContent).toContain("Choose your new password below.");
    expect(button("Save password and continue")).toBeDefined();
    expect(button("Finish set-up")).toBeUndefined();
  });
});
