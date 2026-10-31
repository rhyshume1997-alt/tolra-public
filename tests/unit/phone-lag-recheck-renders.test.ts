/**
 * Phone lag (fix 2b, 2d): an access recheck that finds nothing changed gives the user context no new value, so the ~38 pages and
 * components that call useUser() (the Job Board among them) do not re-render; and coming back to the app ("visibilitychange" and
 * "focus" together) runs one recheck, not two. The real UserProvider is rendered with React's reconciler (the one @react-pdf/renderer
 * ships; there is no DOM here) and a render counter, against a stubbed Supabase client.
 */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  hidden: ["email"] as string[],
  calls: [] as string[],
}));
vi.mock("@/lib/supabase", () => {
  const profile = { id: "u-1", email: "office@example.test", full_name: "Office Person", role: "office", secondary_role: null, organization_id: "org-1", organization: "Example Ltd", workshop_email: null, active: true };
  const chain = () => {
    const c = {
      select: () => c,
      eq: () => c,
      single: async () => { server.calls.push("user_profiles"); return { data: profile, error: null }; },
      maybeSingle: async () => { server.calls.push("user_profiles"); return { data: { active: true }, error: null }; },
    };
    return c;
  };
  const client = {
    auth: {
      getUser: async () => { server.calls.push("getUser"); return { data: { user: { id: "u-1" } }, error: null }; },
      getSession: async () => ({ data: { session: { user: { id: "u-1" } } }, error: null }),
      signOut: async () => ({ error: null }),
    },
    from: () => chain(),
    rpc: async (name: string) => {
      server.calls.push(name);
      if (name === "my_organizations") return { data: [], error: null };
      if (name === "my_session") return { data: { user_id: "u-1", organization_id: "org-1", organization_name: "Example Ltd", role: "office", secondary_role: null, hidden_sections: [...server.hidden] }, error: null };
      return { data: null, error: null };
    },
  };
  return { supabase: client, isSupabaseConfigured: true };
});

type Win = EventTarget & { localStorage: Storage; location: { assign: (url: string) => void } };
let win: Win;
let doc: EventTarget & { visibilityState: string; cookie: string };

beforeEach(() => {
  const store = new Map<string, string>();
  win = Object.assign(new EventTarget(), {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage,
    location: { assign: vi.fn() },
  });
  doc = Object.assign(new EventTarget(), { visibilityState: "visible", cookie: "" });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  server.hidden = ["email"];
  server.calls.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

async function mount() {
  // A real React reconciler (exported by react-pdf's build, not by its type definitions).
  type Reconciler = { createContainer: (root: object) => unknown; updateContainer: (element: unknown, root: unknown, parent: null, done: () => void) => void };
  const { createRenderer } = (await import("@react-pdf/renderer")) as unknown as { createRenderer: (options: object) => Reconciler };
  const { UserProvider, useUser } = await import("@/lib/use-user");
  const renders: { hiddenSections: string[]; profile: unknown; loading: boolean }[] = [];
  function Consumer() {
    const value = useUser();
    renders.push(value);
    return null;
  }
  const renderer = createRenderer({});
  const root = renderer.createContainer({ type: "ROOT", document: null });
  renderer.updateContainer(createElement(UserProvider, null, createElement(Consumer)), root, null, () => undefined);
  await settle();
  expect(renders.at(-1)).toMatchObject({ loading: false, hiddenSections: ["email"] });
  expect(renders.at(-1)?.profile).not.toBeNull();
  const unmount = async () => { renderer.updateContainer(null, root, null, () => undefined); await settle(); };
  return { renders, unmount };
}

const rechecks = () => server.calls.filter((name) => name === "my_session").length;

describe("an access recheck that changes nothing does not re-render useUser() consumers", () => {
  it("same answer: no render; changed page access: one render with the new sections", async () => {
    const { renders, unmount } = await mount();
    const before = renders.length;
    const asked = rechecks();
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(rechecks()).toBe(asked + 1); // the recheck ran and asked the server
    expect(renders.length - before).toBe(0);

    server.hidden = ["email", "rfq"];
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(rechecks()).toBe(asked + 2);
    expect(renders.length - before).toBe(1);
    expect(renders.at(-1)?.hiddenSections).toEqual(["email", "rfq"]);
    await unmount();
  });
});

describe("coming back to the app runs one recheck, not two", () => {
  it("visibilitychange then focus: one pass; a later focus on its own still asks", async () => {
    const { unmount } = await mount();
    const asked = rechecks();
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(rechecks()).toBe(asked + 1);
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(rechecks()).toBe(asked + 2);
    await unmount();
  });
});

describe("createReturnAsk", () => {
  it("pairs a visible and a focus within RETURN_PAIR_MS once; the same event twice, or a pair further apart, each ask", async () => {
    const { createReturnAsk, RETURN_PAIR_MS } = await import("@/lib/access-recheck");
    const ask = createReturnAsk();
    expect(ask("visible", 0)).toBe(true);
    expect(ask("focus", 50)).toBe(false); // the same return
    expect(ask("visible", 10_000)).toBe(true); // the next return asks again
    expect(ask("focus", 10_020)).toBe(false);
    expect(ask("focus", 11_000)).toBe(true); // focus twice (another window and back): both ask
    expect(ask("focus", 11_500)).toBe(true);
    expect(ask("visible", 11_500 + RETURN_PAIR_MS)).toBe(true); // too late to be the same return
  });
});
