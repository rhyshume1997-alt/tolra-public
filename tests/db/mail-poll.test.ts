/**
 * /api/mail/poll against the real database and the real auth guard, with Microsoft mocked: one RFQ per message however
 * the polls overlap, paging with equal timestamps, and nothing sent to Microsoft for people who may not use the mailbox.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@supabase/ssr", async () => {
  const { session } = await import("../support/mail-session");
  return { createServerClient: () => session.client };
});

import { POST as poll } from "@/app/api/mail/poll/route";
import { resetTokenCache } from "@/lib/m365/graph";

import { isMicrosoft, microsoftUrls, post, session } from "../support/mail-session";
import { isolatedBackend } from "../support/isolation";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const realFetch = globalThis.fetch;
const GRAPH = "https://graph.microsoft.com/v1.0/users/mail%40fixture-tolra.onmicrosoft.com/mailFolders/inbox/messages";
const ENV_KEYS = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_MAILBOX", "MS_ORGANIZATION_ID", "MS_PAGE_SIZE", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};

type Msg = { id: string; receivedDateTime: string };
let inbox: Msg[] = [];
const snapshots = new Map<string, Msg[]>();
let graphPages = 0;

/** A small Graph inbox: $filter receivedDateTime ge, ascending, $top page size and @odata.nextLink paging. */
async function fakeFetch(input: string | URL | Request, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input);
  if (!isMicrosoft(url)) return realFetch(input, init);
  microsoftUrls.push(url);
  if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
  graphPages += 1;
  const u = new URL(url);
  let list: Msg[];
  let offset = 0;
  let snap = u.searchParams.get("snap");
  if (snap) {
    if (!snapshots.has(snap)) return new Response(JSON.stringify({ error: { code: "BadRequest" } }), { status: 400 });
    list = snapshots.get(snap)!;
    offset = Number(u.searchParams.get("offset"));
  } else {
    const since = /ge (\S+)$/.exec(u.searchParams.get("$filter") ?? "")![1];
    list = inbox.filter((m) => Date.parse(m.receivedDateTime) >= Date.parse(since)).sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));
    snap = `s${snapshots.size}`;
    snapshots.set(snap, list);
  }
  const top = Number(u.searchParams.get("$top") ?? process.env.MS_PAGE_SIZE);
  const page = list.slice(offset, offset + top);
  const next = offset + top < list.length ? `${GRAPH}?snap=${snap}&offset=${offset + top}&$top=${top}` : undefined;
  return new Response(JSON.stringify({
    value: page.map((m) => ({ ...m, subject: `POLL ${m.id}`, from: { emailAddress: { address: "buyer@example.test", name: "Buyer" } }, bodyPreview: "preview", body: { content: "text" }, internetMessageId: `<${m.id}@example.test>`, isRead: false, parentFolderId: "inbox" })),
    ...(next ? { "@odata.nextLink": next } : {}),
  }), { status: 200 });
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const backend = isolatedBackend();
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: backend.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: backend.anonKey,
    MS_TENANT_ID: "t",
    MS_CLIENT_ID: "c",
    MS_CLIENT_SECRET: "s",
    MS_MAILBOX: "mail@fixture-tolra.onmicrosoft.com",
    MS_ORGANIZATION_ID: world.tenants.alpha.id,
    MS_PAGE_SIZE: "3",
  });
  inbox = [];
  snapshots.clear();
  graphPages = 0;
  microsoftUrls.length = 0;
  resetTokenCache();
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

/**
 * Times within the first poll's 24 hour window, from one base minute fixed when the file loads. The base used to be worked out
 * from Date.now() at every call, so a test that crossed a minute boundary between building its inbox and checking the
 * checkpoint compared at(40) of one minute with at(40) of the next (CI: "expected ...420000 to be ...480000").
 */
const BASE_MINUTE = Math.floor((Date.now() - 3600_000) / 60_000) * 60_000;
const at = (minutes: number, seconds = 0) => new Date(BASE_MINUTE + minutes * 60_000 + seconds * 1000).toISOString().replace(".000Z", "Z");
const messages = (prefix: string, count: number, at: string) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, receivedDateTime: at }));
const rfqsFor = async (prefix: string) =>
  (await adminClient().from("rfqs").select("id, description").eq("organization_id", world.tenants.alpha.id).like("description", `POLL ${prefix}-%`)).data!;
const run = async (user = world.tenants.alpha.users.admin) => {
  session.client = await signedInClient(user);
  const res = await poll(post("/api/mail/poll", {}));
  return { status: res.status, body: await res.json() };
};

describe("the test's own clock", () => {
  it("at() names the same instant however long the run takes, also across a minute boundary (regression)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(BASE_MINUTE + 3600_000 + 59_000); // one second before the next minute
      const before = at(40);
      vi.setSystemTime(BASE_MINUTE + 3600_000 + 61_000); // the polls took a few seconds: the minute has turned
      expect({ before, after: at(40) }).toEqual({ before, after: before });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("polling", () => {
  it("a batch with one timestamp that is bigger than a page is read in full, and polling again adds nothing", async () => {
    const p = `a${world.runId}`;
    inbox = messages(p, 8, at(0));
    const first = await run();
    expect(first).toEqual({ status: 200, body: { read: 8, inserted: 8, duplicates: 0, more: false } });
    expect(graphPages).toBe(3); // 3 + 3 + 2
    const second = await run();
    expect(second.body).toEqual({ read: 8, inserted: 0, duplicates: 8, more: false });
    expect(await rfqsFor(p)).toHaveLength(8);
    // A later message is picked up from the checkpoint (the newest stored time).
    inbox.push({ id: `${p}-late`, receivedDateTime: at(5) });
    expect((await run()).body).toMatchObject({ inserted: 1, duplicates: 8 });
    expect(await rfqsFor(p)).toHaveLength(9);
  });

  it("two polls at the same time make exactly one RFQ per message", async () => {
    const p = `b${world.runId}`;
    inbox = messages(p, 7, at(10));
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    session.client = admin;
    const results = await Promise.all([poll(post("/api/mail/poll", {})), poll(post("/api/mail/poll", {})), poll(post("/api/mail/poll", {}))]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(bodies.reduce((n, b) => n + b.inserted, 0)).toBe(7);
    expect(bodies.reduce((n, b) => n + b.duplicates, 0)).toBe(14);
    const rfqs = await rfqsFor(p);
    expect(rfqs).toHaveLength(7);
    const stored = await adminClient().from("inbound_emails").select("id, rfq_id").eq("organization_id", world.tenants.alpha.id).like("graph_message_id", `${p}-%`);
    expect(stored.data).toHaveLength(7);
    expect(new Set(stored.data!.map((r) => r.rfq_id)).size).toBe(7);
  });

  it("stops at the page limit and says more, then carries on at the next poll", async () => {
    const p = `c${world.runId}`;
    process.env.MS_PAGE_SIZE = "1";
    inbox = Array.from({ length: 25 }, (_, i) => ({ id: `${p}-${String(i).padStart(2, "0")}`, receivedDateTime: at(20, i) }));
    const first = await run();
    expect(first.body).toEqual({ read: 20, inserted: 20, duplicates: 0, more: true });
    const second = await run();
    expect(second.body).toMatchObject({ inserted: 5, more: false });
    expect(await rfqsFor(p)).toHaveLength(25);
  });
});

describe("long runs of messages with one timestamp", () => {
  it("more messages than the page limit allows in one check are all picked up over successive checks, once each, and it ends", async () => {
    const p = `e${world.runId}`;
    process.env.MS_PAGE_SIZE = "1";
    inbox = messages(p, 45, at(40)); // 45 pages of one message, 20 pages per check
    const reads: number[] = [];
    let last = { more: true } as Record<string, unknown>;
    for (let i = 0; i < 10 && last.more; i += 1) {
      const r = await run();
      expect(r.status).toBe(200);
      reads.push(r.body.read);
      last = r.body;
    }
    expect(reads).toEqual([20, 20, 5]);
    expect(last.more).toBe(false);
    const rfqs = await rfqsFor(p);
    expect(rfqs).toHaveLength(45);
    const stored = await adminClient().from("inbound_emails").select("rfq_id").eq("organization_id", world.tenants.alpha.id).like("graph_message_id", `${p}-%`);
    expect(new Set(stored.data!.map((r) => r.rfq_id)).size).toBe(45);
    // Finished: the link is cleared and the checkpoint is the shared time.
    const state = await adminClient().from("mail_poll_state").select("next_link, checkpoint").eq("organization_id", world.tenants.alpha.id).single();
    expect(state.data!.next_link).toBeNull();
    expect(Date.parse(state.data!.checkpoint)).toBe(Date.parse(at(40)));
  });

  it("a stored paging link Microsoft no longer accepts is discarded and the check starts again from the checkpoint", async () => {
    const p = `f${world.runId}`;
    process.env.MS_PAGE_SIZE = "3";
    inbox = messages(p, 4, at(50));
    await withDb((db) => db.query("update public.mail_poll_state set next_link = $2 where organization_id = $1", [world.tenants.alpha.id, `${GRAPH}?snap=gone&offset=3&$top=3`]));
    const r = await run();
    expect(r).toEqual({ status: 200, body: { read: 4, inserted: 4, duplicates: 0, more: false } });
    const state = await adminClient().from("mail_poll_state").select("next_link").eq("organization_id", world.tenants.alpha.id).single();
    expect(state.data!.next_link).toBeNull();
    expect(await rfqsFor(p)).toHaveLength(4);
  });

  it("the database refuses a paging link that isn't Microsoft Graph's, and the API roles can't write the state", async () => {
    await expect(withDb((db) => db.query("update public.mail_poll_state set next_link = 'https://evil.example/x' where organization_id = $1", [world.tenants.alpha.id]))).rejects.toMatchObject({ code: "23514" });
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    expect((await admin.from("mail_poll_state").update({ next_link: null }).eq("organization_id", world.tenants.alpha.id).select()).data ?? []).toEqual([]);
    expect((await admin.from("mail_poll_state").insert({ organization_id: world.tenants.beta.id })).error).not.toBeNull();
    const office = await signedInClient(world.tenants.alpha.users.office);
    expect((await office.rpc("save_mail_poll_state", { p_next_link: null, p_checkpoint: null })).error).toMatchObject({ code: "42501" });
    expect((await office.from("mail_poll_state").select("*")).data).toEqual([]);
  });
});

describe("who may poll", () => {
  it("another company's admin and the mapped company's office, workshop and viewer get 403 and nothing reaches Microsoft", async () => {
    inbox = messages(`d${world.runId}`, 2, at(0));
    for (const user of [world.tenants.beta.users.admin, world.tenants.alpha.users.office, world.tenants.alpha.users.workshop, world.tenants.alpha.users.viewer]) {
      expect((await run(user)).status, user.role).toBe(403);
    }
    expect(microsoftUrls).toEqual([]);
    expect(await rfqsFor(`d${world.runId}`)).toHaveLength(0);
  });

  it("the mapped company's admin is let through", async () => {
    expect((await run()).status).toBe(200);
    expect(microsoftUrls.length).toBeGreaterThan(0);
  });
});
