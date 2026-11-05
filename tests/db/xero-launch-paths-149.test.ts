/**
 * Release 149, every real send path, with a STUBBED Xero transport (adapted from the W-X proof): the daily sweep, the after-issue route, the manual
 * Send now route and the batch route (the real route modules, the real engine, the real SQL) all refuse to send for a company whose transfer switch
 * is OFF, with credentials present, a connected and mapped company, queued documents, and a company connected long ago. Xero is not contacted at
 * all (not even to refresh a token). Turning ON one company lets only that company send, on every path. Switched OFF in the middle of a send:
 * nothing is written to Xero afterwards, the route answers 200 (not 500) and the row is put back to pending, never left in 'sending'.
 * Rolled back while this app code is live: nothing sends and the sweep reports skipped instead of throwing.
 * Xero is a stub (global fetch intercepted; only loopback, api.xero.com, identity.xero.com allowed); the database is the disposable one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const st = vi.hoisted(() => ({ org: "", userId: "", role: "admin", support: false }));
vi.mock("@/lib/server/auth", async () => {
  const { NextResponse } = await import("next/server");
  const { pgSupabase } = await import("./x149-support");
  return {
    sameOrigin: () => true,
    forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    isErrorResponse: (v: unknown) => v instanceof NextResponse,
    jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
    readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
    requireProfile: async (roles?: string[]) => (roles && !roles.includes(st.role)
      ? NextResponse.json({ error: "Forbidden" }, { status: 403 })
      : { supabase: pgSupabase(process.env.TEST_DATABASE_URL!, { kind: "user", id: st.userId }), user: { id: st.userId }, profile: { organization_id: st.org, role: st.role }, session: st.support ? { support: true } : null }),
  };
});
vi.mock("@/lib/server/supabase-admin", async () => {
  const { pgSupabase } = await import("./x149-support");
  return { createSupabaseAdminClient: () => pgSupabase(process.env.TEST_DATABASE_URL!, { kind: "service" }) };
});

import { destroySyntheticWorld, newRunId, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { type Co, connect, credentials, disconnect, issuedInvoice, mapAll, needsReconnect, newCompany, owner, post, putsByTenant, sendRows, setOld } from "./x149-harness";
import { createXeroStub, pgSupabase } from "./x149-support";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const runId = newRunId();
const URL_ = process.env.TEST_DATABASE_URL!;
const realFetch = globalThis.fetch;
const xero = createXeroStub(realFetch);
const NAMES = ["a-mapped", "g-mapped", "b-unmapped", "c-reconnect", "d-disconnected", "e-previous", "h-held-to-end"] as const;
type N = (typeof NAMES)[number];
const cos = {} as Record<N, Co>;
let routes: { afterIssue: (r: Request) => Promise<Response>; send: (r: Request) => Promise<Response>; batch: (r: Request) => Promise<Response>; sweep: () => Promise<unknown> };
const asCo = (co: Co, role = "admin") => { st.org = co.id; st.userId = co.admin.id; st.role = role; };
const tenant = (n: N) => cos[n].tenant;

const counts = async (n: N) => (await sendRows(cos[n])).reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
const hold = async (n: N) => (await owner<{ t: boolean }>("select enabled as t from public.xero_transfer_hold where organization_id = $1", [cos[n].id]))[0]?.t;
/** The admin's own switch call, as PostgREST would run it (aal1 claims: the company does not require the second step here). */
const setTransfers = (n: N, on: boolean) => pgSupabase(URL_, { kind: "user", id: cos[n].admin.id }).rpc("integration_xero_set_transfers", { p_enabled: on });
const puts = () => putsByTenant(xero);
const putCount = (n: N) => (puts()[tenant(n)] ?? []).length;
const pendingDoc = async (n: N) => (await owner<{ doc_id: string }>("select doc_id from public.integration_sends where organization_id=$1 and status='pending' order by created_at limit 1", [cos[n].id]))[0]?.doc_id;
const run = async (sql: string) => withDb(async (db) => { await db.query(sql); });

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  vi.stubGlobal("fetch", xero.stub);
  for (const n of NAMES) { cos[n] = await newCompany(runId, n); cos[n].tenant = `tenant-${n}-${runId}`; }
  credentials(true, (k, v) => vi.stubEnv(k, v as never));
  for (const n of NAMES) await connect(cos[n]);
  for (const n of ["a-mapped", "g-mapped", "c-reconnect", "d-disconnected", "e-previous", "h-held-to-end"] as N[]) await mapAll(cos[n]);
  await setOld(cos["e-previous"]);
  for (const n of ["a-mapped", "g-mapped", "b-unmapped", "c-reconnect", "e-previous"] as N[]) for (let i = 0; i < 6; i += 1) await issuedInvoice(cos[n], runId);
  for (let i = 0; i < 3; i += 1) await issuedInvoice(cos["h-held-to-end"], runId);
  await issuedInvoice(cos["d-disconnected"], runId);
  await needsReconnect(cos["c-reconnect"]);
  await disconnect(cos["d-disconnected"]);
  const afterIssue = await import("@/app/api/integrations/xero/after-issue/route");
  const send = await import("@/app/api/integrations/xero/send/route");
  const batch = await import("@/app/api/integrations/xero/batch/route");
  const pass = await import("@/lib/integrations/xero-pass");
  routes = { afterIssue: afterIssue.POST, send: send.POST, batch: batch.POST, sweep: () => pass.runXeroSweepPass() };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}, 240_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await withDb(async (db) => {
    if ((await db.query("select to_regclass('public.xero_transfer_hold') as t")).rows[0].t === null) await db.query(read("supabase/release/149_xero_launch_hold.release.sql"));
  }).catch(() => undefined);
  await destroySyntheticWorld(runId);
}, 120_000);

describe("OFF by default for every company, however it was connected", () => {
  it("every company has a hold row and it is OFF: connected, mapped, previously connected, needs reconnect, disconnected", async () => {
    for (const n of NAMES) expect(await hold(n), n).toBe(false);
    expect((await owner<{ n: number }>("select count(*)::int as n from public.xero_transfer_hold where enabled and organization_id = any($1)", [NAMES.map((n) => cos[n].id)]))[0].n).toBe(0);
  });
});

describe("hold OFF everywhere (the default), credentials present: no path sends and Xero is not contacted at all", () => {
  it("sweep, after-issue, manual send and batch, for every company state", async () => {
    const before = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await counts(n)])));
    xero.reset();
    const sweep = await routes.sweep();
    const ai: Record<string, unknown> = {}, sd: Record<string, unknown> = {}, bt: Record<string, { http: number; body: unknown }> = {};
    for (const n of NAMES) {
      const first = await pendingDoc(n);
      asCo(cos[n], "office");
      ai[n] = first ? await (await routes.afterIssue(post({ doc_type: "invoice", doc_id: first }))).json() : "no pending row";
      asCo(cos[n]);
      sd[n] = await (await routes.send(post({}))).json();
      const r = await routes.batch(post({ action: "send", mode: "unsent", items: [{ doc_type: "invoice", doc_id: first ?? "00000000-0000-4000-8000-000000000000" }], include_before_connection: true }));
      bt[n] = { http: r.status, body: await r.json() };
    }
    const after = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await counts(n)])));
    expect(sweep).toMatchObject({ companies: 0, sent: 0 });
    expect(xero.calls.length).toBe(0); // not even the token refresh at identity.xero.com
    expect(xero.identity().length).toBe(0);
    expect(after).toEqual(before);
    for (const n of ["a-mapped", "g-mapped", "e-previous"] as N[]) {
      expect(ai[n]).toMatchObject({ sent: 0, blocked: "launch_hold" });
      expect(sd[n]).toMatchObject({ sent: 0, blocked: "launch_hold" });
      expect(JSON.stringify(bt[n].body)).not.toMatch(/"outcome":"sent"/);
    }
  });

  it("a document issued while held is queued (nothing is dropped) and still not sent", async () => {
    const before = (await sendRows(cos["a-mapped"])).length;
    const inv = await issuedInvoice(cos["a-mapped"], runId);
    expect((await sendRows(cos["a-mapped"])).length).toBe(before + 1);
    xero.reset();
    asCo(cos["a-mapped"]);
    expect(await (await routes.send(post({}))).json()).toMatchObject({ sent: 0, blocked: "launch_hold" });
    expect((await sendRows(cos["a-mapped"])).find((r) => r.doc_ref === inv.ref)?.status).toBe("pending");
    expect(xero.calls.length).toBe(0);
  });

  it("a code bypass cannot send: the database claim itself answers launch_hold, retry is refused, the gate is not callable by browsers", async () => {
    const claim = await pgSupabase(URL_, { kind: "service" }).rpc("integration_claim_next", { p_org: cos["g-mapped"].id, p_provider: "xero", p_lease_seconds: 120 });
    expect((claim.data as { blocked: string }).blocked).toBe("launch_hold");
    const failed = (await owner<{ id: string }>("update public.integration_sends set status='failed' where id = (select id from public.integration_sends where organization_id=$1 and status='pending' limit 1) returning id", [cos["g-mapped"].id]))[0];
    const r = await pgSupabase(URL_, { kind: "user", id: cos["g-mapped"].admin.id }).rpc("integration_retry_send", { p_send: failed.id });
    expect(r.error?.hint).toBe("xero_launch_hold");
    await owner("update public.integration_sends set status='pending' where id=$1", [failed.id]);
    const priv = await owner<{ anon: boolean; auth: boolean; svc: boolean }>(
      "select has_function_privilege('anon','public.integration_xero_transfer_enabled(uuid)','EXECUTE') as anon, has_function_privilege('authenticated','public.integration_xero_transfer_enabled(uuid)','EXECUTE') as auth, has_function_privilege('service_role','public.integration_xero_transfer_enabled(uuid)','EXECUTE') as svc");
    expect(priv[0]).toEqual({ anon: false, auth: false, svc: true });
  });

  it("the route refuses a support session; only an admin of the company turns it on, and not for a company that is not connected", async () => {
    await owner("update public.organization_members set role='office' where organization_id=$1 and user_id=$2", [cos["g-mapped"].id, cos["g-mapped"].admin.id]);
    const office = await setTransfers("g-mapped", true);
    await owner("update public.organization_members set role='admin' where organization_id=$1 and user_id=$2", [cos["g-mapped"].id, cos["g-mapped"].admin.id]);
    expect(office.error).not.toBeNull();
    expect(await hold("g-mapped")).toBe(false);
    const c = await setTransfers("c-reconnect", true), d = await setTransfers("d-disconnected", true), b = await setTransfers("b-unmapped", true);
    expect([c.error?.code, d.error?.code, b.error?.code]).toEqual(["55000", "55000", "55000"]);
    expect(b.error?.hint).toBe("not_mapped");
    // the launch route itself
    const launch = await import("@/app/api/integrations/xero/launch/route");
    st.support = true; asCo(cos["g-mapped"]);
    expect((await launch.POST(post({ enabled: true }))).status).toBe(403);
    expect((await launch.GET()).status).toBe(403);
    st.support = false;
    expect(await hold("g-mapped")).toBe(false);
  });
});

describe("turning the switch ON for ONE company (A): only A sends, on every path", () => {
  it("A on, the rest off", async () => {
    expect((await setTransfers("a-mapped", true)).error).toBeNull();
    expect(await hold("a-mapped")).toBe(true);
    for (const n of NAMES.filter((x) => x !== "a-mapped")) expect(await hold(n), n).toBe(false);
  });

  it("after-issue: A's own document goes; another company's pending document does not", async () => {
    const mine = await issuedInvoice(cos["a-mapped"], runId);
    const gDoc = (await pendingDoc("g-mapped"))!;
    xero.reset();
    asCo(cos["a-mapped"], "office");
    const a = await (await routes.afterIssue(post({ doc_type: "invoice", doc_id: mine.id }))).json();
    asCo(cos["g-mapped"], "office");
    const g = await (await routes.afterIssue(post({ doc_type: "invoice", doc_id: gDoc }))).json();
    expect(a).toMatchObject({ sent: 1 });
    expect(g).toMatchObject({ sent: 0, blocked: "launch_hold" });
    expect(Object.keys(puts())).toEqual([tenant("a-mapped")]);
  });

  it("batch: A's document is sent; G's is refused (nothing sent)", async () => {
    const mine = await issuedInvoice(cos["a-mapped"], runId);
    const gDoc = (await pendingDoc("g-mapped"))!;
    xero.reset();
    asCo(cos["a-mapped"]);
    await routes.batch(post({ action: "send", mode: "unsent", items: [{ doc_type: "invoice", doc_id: mine.id }], include_before_connection: true }));
    asCo(cos["g-mapped"]);
    await routes.batch(post({ action: "send", mode: "unsent", items: [{ doc_type: "invoice", doc_id: gDoc }], include_before_connection: true }));
    expect(putCount("a-mapped")).toBe(1);
    expect(putCount("g-mapped")).toBe(0);
  });

  it("manual send: A's whole queue goes; G, E, B, C, D, H send nothing", async () => {
    xero.reset();
    for (const n of NAMES) { asCo(cos[n]); await routes.send(post({})); }
    expect(putCount("a-mapped")).toBeGreaterThan(0);
    for (const n of NAMES.filter((x) => x !== "a-mapped")) expect(putCount(n), n).toBe(0);
    expect(Object.keys(puts())).toEqual([tenant("a-mapped")]);
  });

  it("sweep: only A is considered; only A's tenant is refreshed or written to", async () => {
    await issuedInvoice(cos["a-mapped"], runId);
    const gBefore = await counts("g-mapped"), eBefore = await counts("e-previous");
    xero.reset();
    const sweep = await routes.sweep();
    expect(sweep).toMatchObject({ companies: 1, renewed: 1, sent: 1 });
    expect(Object.keys(puts())).toEqual([tenant("a-mapped")]);
    expect(xero.identity().length).toBe(1);
    expect(await counts("g-mapped")).toEqual(gBefore);
    expect(await counts("e-previous")).toEqual(eBefore);
  });

  it("turning A back OFF stops every path at once", async () => {
    expect((await setTransfers("a-mapped", false)).error).toBeNull();
    const inv = await issuedInvoice(cos["a-mapped"], runId);
    xero.reset();
    const sweep = await routes.sweep();
    asCo(cos["a-mapped"]);
    const sd = await (await routes.send(post({}))).json();
    expect(sweep).toMatchObject({ companies: 0 });
    expect(sd).toMatchObject({ blocked: "launch_hold" });
    expect(xero.calls.length).toBe(0);
    expect((await sendRows(cos["a-mapped"])).find((r) => r.doc_ref === inv.ref)?.status).toBe("pending");
  });
});

describe("a previously connected organisation, and a reconnect, start OFF", () => {
  it("E (connected long ago, mapped, with history) does not send; once ON, a fresh consent to the SAME organisation puts it back OFF, and so does needs_reconnect", async () => {
    xero.reset();
    asCo(cos["e-previous"]);
    expect(await (await routes.send(post({}))).json()).toMatchObject({ sent: 0, blocked: "launch_hold" });
    expect(putCount("e-previous")).toBe(0);
    expect((await setTransfers("e-previous", true)).error).toBeNull();
    expect(await hold("e-previous")).toBe(true);
    await connect(cos["e-previous"]);
    expect(await hold("e-previous")).toBe(false);
    asCo(cos["e-previous"]);
    expect(await (await routes.send(post({}))).json()).toMatchObject({ sent: 0, blocked: "launch_hold" });
    expect((await setTransfers("e-previous", true)).error).toBeNull();
    await needsReconnect(cos["e-previous"]);
    expect(await hold("e-previous")).toBe(false);
  });
});

describe("switched OFF in the middle of a send", () => {
  it("off after the contact lookup: no contact is created, no invoice written, the route answers 200 (not 500) and the row is back to pending, not stranded in 'sending'", async () => {
    expect((await setTransfers("g-mapped", true)).error).toBeNull();
    asCo(cos["g-mapped"]);
    await routes.send(post({})); // drain G's old queue first
    const inv = await issuedInvoice(cos["g-mapped"], runId, [{ unit_price: 50 }], "Brand New Customer Ltd");
    xero.reset();
    xero.hook.onCall = async (c) => {
      if (c.method === "GET" && c.path.startsWith("/api.xro/2.0/Contacts")) await owner("update public.xero_transfer_hold set enabled=false where organization_id=$1", [cos["g-mapped"].id]);
    };
    asCo(cos["g-mapped"]);
    const r = await routes.send(post({}));
    xero.hook.onCall = null;
    const body = await r.json();
    const rows = (await sendRows(cos["g-mapped"])).filter((x) => x.doc_ref === inv.ref);
    expect(r.status).toBe(200);
    expect(body).toMatchObject({ sent: 0, blocked: "launch_hold" });
    expect(xero.writes()).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", external_id: null });
    expect((await owner<{ n: number }>("select count(*)::int as n from public.integration_sends where organization_id=$1 and status='sending'", [cos["g-mapped"].id]))[0].n).toBe(0);
    // Turned on again: the same document goes out exactly once (a repeat attempt reads Xero first).
    expect((await setTransfers("g-mapped", true)).error).toBeNull();
    await owner("update public.integration_sends set next_attempt_at = now() where organization_id=$1", [cos["g-mapped"].id]);
    xero.reset();
    asCo(cos["g-mapped"]);
    await routes.send(post({}));
    expect(putCount("g-mapped")).toBe(1);
    expect((await sendRows(cos["g-mapped"])).find((x) => x.doc_ref === inv.ref)?.status).toBe("sent");
    expect((await setTransfers("g-mapped", false)).error).toBeNull();
  });

  it("off while the invoice write is already in flight: that call cannot be recalled, its real result is recorded (sent), the route answers 200", async () => {
    expect((await setTransfers("g-mapped", true)).error).toBeNull();
    const inv = await issuedInvoice(cos["g-mapped"], runId, [{ unit_price: 70 }]);
    xero.reset();
    xero.hook.onCall = async (c) => {
      if (c.method === "PUT" && c.path.startsWith("/api.xro/2.0/Invoices")) await owner("update public.xero_transfer_hold set enabled=false where organization_id=$1", [cos["g-mapped"].id]);
    };
    asCo(cos["g-mapped"]);
    const r = await routes.send(post({}));
    xero.hook.onCall = null;
    expect(r.status).toBe(200);
    expect((await sendRows(cos["g-mapped"])).find((x) => x.doc_ref === inv.ref)).toMatchObject({ status: "sent" });
    expect(putCount("g-mapped")).toBe(1);
    expect(await hold("g-mapped")).toBe(false);
    expect((await owner<{ n: number }>("select count(*)::int as n from public.integration_sends where organization_id=$1 and status='sending'", [cos["g-mapped"].id]))[0].n).toBe(0);
  });
});

describe("rollback of 149 while this app code is live", () => {
  it("nothing sends (the app fails closed), the sweep reports skipped instead of throwing, Xero is not contacted; reinstalling restores the switch, all OFF", async () => {
    expect((await setTransfers("a-mapped", true)).error).toBeNull();
    try {
      await run(`SET tolra.x149_accept_old_sending = 'yes'; ${read("supabase/release/149_xero_launch_hold.rollback.sql")}`);
      xero.reset();
      const sweep = await routes.sweep();
      asCo(cos["a-mapped"]);
      const sd = await (await routes.send(post({}))).json();
      asCo(cos["a-mapped"], "office");
      const doc = await pendingDoc("a-mapped");
      const ai = doc ? await (await routes.afterIssue(post({ doc_type: "invoice", doc_id: doc }))).json() : null;
      expect(sweep).toMatchObject({ skipped: expect.stringContaining("not in the database") });
      expect(sd).toMatchObject({ sent: 0, blocked: "launch_hold" });
      expect(ai).toMatchObject({ sent: 0, blocked: "launch_hold" });
      expect(xero.calls.length).toBe(0);
    } finally {
      await run(read("supabase/release/149_xero_launch_hold.release.sql"));
    }
    for (const n of NAMES) expect(await hold(n), n).toBe(false);
    xero.reset();
    expect(await routes.sweep()).toMatchObject({ companies: 0 });
    expect(xero.calls.length).toBe(0);
  });
});
