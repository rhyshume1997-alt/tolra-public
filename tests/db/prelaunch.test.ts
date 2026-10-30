/**
 * Pre-go-live hardening (migration 033): new invoices, quotes and purchase orders can only be created as drafts by an
 * API user (so nobody can insert a finished record and skip the issue step); the importer and the service role still can;
 * the invoice tax point is set on the draft and locked at issue; the optional admin MFA rule at database level.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Role, type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, ROLES, setRequireAdminMfaForTest, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const clients = new Map<Role, SupabaseClient>();
let seq = 0;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ROLES) clients.set(role, await signedInClient(world.tenants.alpha.users[role]));
  // A new purchase order names a supplier on the Suppliers list (082).
  const listed = await adminClient().from("suppliers").insert({ organization_id: world.tenants.alpha.id, name: "Steel Ltd" });
  if (listed.error) throw new Error(`suppliers: ${listed.error.message}`);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const org = () => world.tenants.alpha.id;
const count = async (table: string) => (await adminClient().from(table).select("id", { count: "exact", head: true }).eq("organization_id", org())).count ?? 0;

type Maker = (extra: Record<string, unknown>) => Record<string, unknown>;
const MAKERS: Record<"invoices" | "quotes" | "purchase_orders", { make: Maker; writers: Role[]; hostile: Array<[string, Record<string, unknown>]> }> = {
  invoices: {
    make: (extra) => { seq += 1; return { organization_id: org(), customer: `Direct ${seq}`, ...extra }; },
    writers: ["admin", "office"],
    hostile: [
      ["issued with a number", { status: "issued", invoice_ref: "INV-9001" }],
      ["a number on a draft", { status: "draft", invoice_ref: "INV-9002" }],
      ["status sent", { status: "sent" }],
      ["status paid", { status: "paid", amount_paid: 120 }],
      ["a part payment on a draft", { amount_paid: 5 }],
      ["a paid date", { paid_at: "2026-10-01T00:00:00Z" }],
      ["a sent date", { sent_date: "2026-10-01T00:00:00Z" }],
    ],
  },
  quotes: {
    make: (extra) => { seq += 1; return { organization_id: org(), quote_ref: `QUO-D${seq}`, customer: `Direct ${seq}`, ...extra }; },
    writers: ["admin", "office"],
    hostile: [
      ["status sent", { status: "sent" }],
      ["status accepted", { status: "accepted" }],
      ["a sent date", { sent_at: "2026-10-01T00:00:00Z" }],
      ["an accepted date", { accepted_at: "2026-10-01T00:00:00Z" }],
      ["a rejected date", { rejected_at: "2026-10-01T00:00:00Z" }],
    ],
  },
  purchase_orders: {
    make: (extra) => { seq += 1; return { organization_id: org(), po_ref: `PO-D${seq}`, po_number: `PO-D${seq}`, supplier: "Steel Ltd", total_value: 10, ...extra }; },
    writers: ["admin", "office"],
    hostile: [
      ["status sent (the column default before 033)", { status: "sent" }],
      ["status issued", { status: "issued" }],
      ["status received", { status: "received" }],
      ["a sent date", { sent_at: "2026-10-01T00:00:00Z" }],
      ["a received date", { received_at: "2026-10-01T00:00:00Z" }],
    ],
  },
};

describe.each(Object.entries(MAKERS))("%s are created as drafts only", (table, spec) => {
  it("every role: a finished record is refused and nothing is stored; a draft is accepted only where the role may write", async () => {
    const before = await count(table);
    for (const role of ROLES) {
      const client = clients.get(role)!;
      for (const [name, fields] of spec.hostile) {
        const { error } = await client.from(table).insert(spec.make(fields));
        expect({ role, name, refused: error !== null }).toEqual({ role, name, refused: true });
        if (spec.writers.includes(role)) expect({ role, name, code: error?.code }).toEqual({ role, name, code: "42501" });
      }
    }
    expect(await count(table)).toBe(before);

    for (const role of ROLES) {
      const status = table === "purchase_orders" ? { status: "draft" } : {};
      const { error } = await clients.get(role)!.from(table).insert(spec.make(status));
      // The database's reason is in the result, so a refusal says why (not just "saved: false").
      const allowed = spec.writers.includes(role);
      expect({ role, saved: error === null, reason: allowed ? (error ? `${error.code} ${error.message}` : null) : undefined })
        .toEqual({ role, saved: allowed, reason: allowed ? null : undefined });
    }
    expect(await count(table)).toBe(before + spec.writers.length);
  });

  it("a draft with nothing set but zeros and nulls is accepted", async () => {
    const extra = table === "invoices" ? { status: "draft", amount_paid: 0, invoice_ref: null, paid_at: null } : table === "quotes" ? { status: "draft", sent_at: null } : { status: "draft", sent_at: null, received_at: null };
    expect((await clients.get("admin")!.from(table).insert(spec.make(extra))).error).toBeNull();
  });

  it("the service role and the database owner (the importer's rights) can still create finished records", async () => {
    const finished = () => (table === "invoices" ? { status: "issued", invoice_ref: `INV-IMP-${randomUUID().slice(0, 8)}`, amount_paid: 0 } : { status: "sent" });
    expect((await adminClient().from(table).insert(spec.make(finished()))).error).toBeNull();
    await withDb(async (db) => {
      const row = spec.make(finished());
      const columns = Object.keys(row);
      await db.query(`insert into public.${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
    });
  });
});

describe("the read-only verify script for 033 (supabase/verify/prelaunch_033.sql)", () => {
  it("runs in a READ ONLY transaction, and every check answers as expected on a database built from the migrations", async () => {
    const text = (await import("node:fs")).readFileSync((await import("node:path")).resolve(__dirname, "../../supabase/verify/prelaunch_033.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Check 10 counts reservations other tests in this file leave 'sending'; the rest are fixed facts about the schema.
    for (const row of rows.filter((r) => r.n !== 10)) expect({ n: row.n, value: row.value }).toEqual({ n: row.n, value: row.expected });
  });
});

describe("033 section 8: the second-step check is injected into CRLF function bodies too", () => {
  // Production's 031/032 functions were pasted into the SQL editor and stored with CRLF line endings; pg_get_functiondef
  // returns "\nBEGIN\r\n" for them. The injection block is taken from the migration file itself, so this tests the real text.
  const migration = readFileSync(path.resolve(__dirname, "../../supabase/migrations/033_prelaunch_hardening.sql"), "utf8");
  const start = migration.indexOf("-- ---- 8. The second-step check");
  const doStart = migration.indexOf("DO $do$", start);
  const block = migration.slice(doStart, migration.indexOf("$do$;", doStart) + "$do$;".length);
  const FN = "public.save_mail_poll_state(text,timestamptz)";
  const countCalls = (def: string) => def.split("PERFORM public.assert_privileged_aal();").length - 1;

  it("anchors on BEGIN with CRLF, keeps the body's line endings, adds the call exactly once, and a second run changes nothing", async () => {
    expect(block.startsWith("DO $do$")).toBe(true);
    await withDb(async (db) => {
      await db.query("begin");
      try {
        const def = async () => (await db.query<{ d: string }>("select pg_get_functiondef(to_regprocedure($1)) as d", [FN])).rows[0].d;
        // Re-create the function without the check and with CRLF line endings, as the SQL editor stored it.
        const crlf = (await def()).replace("  PERFORM public.assert_privileged_aal();\n", "").replace(/\n/g, "\r\n");
        expect(countCalls(crlf)).toBe(0);
        expect(crlf).toContain("\r\nBEGIN\r\n");
        await db.query(crlf);
        const before = await def();
        expect(before).toContain("\r\nBEGIN\r\n");
        expect(countCalls(before)).toBe(0);

        await db.query(block);
        const after = await def();
        expect(countCalls(after)).toBe(1);
        expect(after).toContain("\r\nBEGIN\r\n  PERFORM public.assert_privileged_aal();\r\n");
        // The body (not the header, which Postgres does not store) keeps its own line ending: no bare LF was introduced.
        expect(after.slice(after.indexOf("$function$"), after.lastIndexOf("$function$")).replace(/\r\n/g, "")).not.toContain("\n");

        await db.query(block);
        expect(await def()).toBe(after);
      } finally {
        await db.query("rollback");
      }
    });
  });
});

describe("error alert budget (claim_error_alert)", () => {
  const claim = (fp: string) => adminClient().rpc("claim_error_alert", { p_fingerprint: fp });
  const fp = (n: number) => n.toString(16).padStart(12, "0");

  it("one per fingerprint per hour, 20 a day in all, and only the service role can ask", async () => {
    await withDb((db) => db.query("delete from security_audit.error_alerts"));
    expect((await claim(fp(1))).data).toBe(true);
    expect((await claim(fp(1))).data).toBe(false);
    await withDb((db) => db.query("update security_audit.error_alerts set claimed_at = now() - interval '61 minutes'"));
    expect((await claim(fp(1))).data).toBe(true);
    // 19 more different ones fill the day (the older row from an hour ago still counts), then no more.
    for (let i = 2; i <= 19; i += 1) expect((await claim(fp(i))).data).toBe(true);
    expect((await claim(fp(100))).data).toBe(false);
    // Parallel claims for one new fingerprint: only one wins (after freeing room).
    await withDb((db) => db.query("delete from security_audit.error_alerts where id in (select id from security_audit.error_alerts order by id limit 5)"));
    const racing = await Promise.all(Array.from({ length: 6 }, () => claim(fp(200))));
    expect(racing.filter((r) => r.data === true)).toHaveLength(1);
    // Old rows go after two days.
    await withDb((db) => db.query("update security_audit.error_alerts set claimed_at = now() - interval '3 days'"));
    expect((await claim(fp(300))).data).toBe(true);
    expect((await withDb((db) => db.query("select count(*)::int as n from security_audit.error_alerts"))).rows[0].n).toBe(1);
    // Nobody else: not a signed-in user, not anonymous. A bad fingerprint is refused.
    expect((await clients.get("admin")!.rpc("claim_error_alert", { p_fingerprint: fp(1) })).error).not.toBeNull();
    expect((await claim("not-a-hash")).error).toMatchObject({ code: "22023" });
    // The table holds a fingerprint and a time, nothing else.
    expect((await withDb((db) => db.query("select column_name from information_schema.columns where table_schema = 'security_audit' and table_name = 'error_alerts' order by 1"))).rows.map((r) => r.column_name)).toEqual(["claimed_at", "fingerprint", "id"]);
  });
});

describe("browser error alert budget (claim_browser_error_alert, 115)", () => {
  const person = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const company = (n: number) => `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`;
  const fp = (n: number) => n.toString(16).padStart(12, "0");
  const browser = (f: number, u: number, c: number | null) => adminClient().rpc("claim_browser_error_alert", { p_fingerprint: fp(f), p_user_id: person(u), p_company_id: c === null ? null : company(c) });
  const server = (f: number) => adminClient().rpc("claim_error_alert", { p_fingerprint: fp(f) });
  const clear = () => withDb((db) => db.query("delete from security_audit.browser_error_alerts; delete from security_audit.error_alerts"));

  it("5 a day per person, 10 per company, 20 in all, once per fingerprint per hour; resets the next day; only the service role can ask", async () => {
    await clear();
    for (let i = 1; i <= 5; i += 1) expect((await browser(i, 1, 1)).data).toBe(true);
    expect((await browser(6, 1, 1)).data).toBe(false);
    expect((await browser(1, 2, 1)).data).toBe(false); // same error within the hour, whoever posts it
    for (let i = 7; i <= 11; i += 1) expect((await browser(i, 2, 1)).data).toBe(true);
    expect((await browser(12, 3, 1)).data).toBe(false); // company 1 has had 10
    expect((await browser(13, 4, 2)).data).toBe(true); // another company
    await withDb((db) => db.query("update security_audit.browser_error_alerts set claimed_at = now() - interval '25 hours'"));
    expect((await browser(14, 1, 1)).data).toBe(true); // next day
    // Browser claims never use the server's 20, and the server's 20 never stops a browser claim.
    await clear();
    for (let u = 1; u <= 4; u += 1) for (let i = 1; i <= 5; i += 1) expect((await browser(u * 10 + i, u, u)).data).toBe(true);
    expect((await browser(99, 5, 5)).data).toBe(false);
    for (let i = 1; i <= 20; i += 1) expect((await server(500 + i)).data).toBe(true);
    expect((await server(600)).data).toBe(false);
    await clear();
    expect((await browser(1, 1, 1)).data).toBe(true);
    // Nobody else can ask; bad input is refused.
    expect((await clients.get("admin")!.rpc("claim_browser_error_alert", { p_fingerprint: fp(1), p_user_id: person(1), p_company_id: null })).error).not.toBeNull();
    expect((await adminClient().rpc("claim_browser_error_alert", { p_fingerprint: "not-a-hash", p_user_id: person(1), p_company_id: null })).error).toMatchObject({ code: "22023" });
    expect((await withDb((db) => db.query("select column_name from information_schema.columns where table_schema = 'security_audit' and table_name = 'browser_error_alerts' order by 1"))).rows.map((r) => r.column_name)).toEqual(["claimed_at", "company_id", "fingerprint", "id", "user_id"]);
    await clear();
  });
});

describe("payments of another company never reach the year-end export's input", () => {
  it("a second company's payments (and invoices) are invisible to the first company's admin, whichever way they ask", async () => {
    const betaAdmin = await signedInClient(world.tenants.beta.users.admin);
    const created = await betaAdmin.rpc("create_with_lines", {
      p_parent: "invoices",
      p_header: { customer: "Beta Only Ltd", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0 },
      p_child: "invoice_line_items", p_fk: "invoice_id",
      p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
    });
    expect(created.error).toBeNull();
    await betaAdmin.rpc("issue_invoice", { p_invoice: created.data });
    expect((await betaAdmin.rpc("record_invoice_payment", { p_invoice: created.data, p_amount: 120, p_paid_on: "2026-10-11", p_method: "BACS", p_reference: "BETA-REF", p_request_id: randomUUID() })).error).toBeNull();

    const alphaAdmin = clients.get("admin")!;
    const payments = await alphaAdmin.from("invoice_payments").select("*");
    expect(payments.error).toBeNull();
    expect(JSON.stringify(payments.data)).not.toContain("BETA-REF");
    expect((payments.data ?? []).every((row) => row.organization_id === org())).toBe(true);
    expect((await alphaAdmin.from("invoice_payments").select("id").eq("invoice_id", created.data as string)).data).toEqual([]);
    expect((await alphaAdmin.from("invoices").select("id").eq("customer", "Beta Only Ltd")).data).toEqual([]);
  });
});

describe("invoice tax point", () => {
  const draft = async (extra: Record<string, unknown> = {}) => {
    const admin = clients.get("admin")!;
    const { data, error } = await admin.rpc("create_with_lines", {
      p_parent: "invoices",
      p_header: { customer: "Tax Point Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, invoice_date: "2026-10-10", ...extra },
      p_child: "invoice_line_items", p_fk: "invoice_id",
      p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
    });
    if (error) throw new Error(error.message);
    return data as string;
  };
  const taxPoint = async (id: string) => (await adminClient().from("invoices").select("tax_point").eq("id", id).single()).data?.tax_point;

  it("is optional, set on the draft, editable until issue, and fixed afterwards", async () => {
    const admin = clients.get("admin")!;
    expect(await taxPoint(await draft())).toBeNull();
    const id = await draft({ tax_point: "2026-10-03" });
    expect(await taxPoint(id)).toBe("2026-10-03");
    expect((await admin.from("invoices").update({ tax_point: "2026-10-05" }).eq("id", id)).error).toBeNull();
    expect((await admin.from("invoices").update({ tax_point: null }).eq("id", id)).error).toBeNull();
    expect((await admin.from("invoices").update({ tax_point: "2026-10-06" }).eq("id", id)).error).toBeNull();
    expect((await admin.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
    expect(await taxPoint(id)).toBe("2026-10-06");
    for (const value of ["2026-10-07", null]) {
      const { error } = await admin.from("invoices").update({ tax_point: value }).eq("id", id);
      expect({ value, code: error?.code }).toEqual({ value, code: "42501" });
    }
    expect(await taxPoint(id)).toBe("2026-10-06");
    // Payments still go through the lock.
    expect((await admin.rpc("record_invoice_payment", { p_invoice: id, p_amount: 20, p_paid_on: "2026-10-11", p_method: "BACS", p_reference: null, p_request_id: randomUUID() })).error).toBeNull();
    expect(await taxPoint(id)).toBe("2026-10-06");
  });
});

describe("optional admin MFA at database level (organizations.require_admin_mfa)", () => {
  /** Runs `sql` as the signed-in user with a token carrying the given assurance level (a real token can't be forged, so the claims are set the way PostgREST does). */
  async function asUser(userId: string, aal: "aal1" | "aal2", sql: string, params: unknown[] = []) {
    return withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal })]);
        return await db.query(sql, params);
      } finally {
        await db.query("rollback");
      }
    });
  }
  const setFlag = (value: boolean) => setRequireAdminMfaForTest(org(), value);
  const adminId = () => world.tenants.alpha.users.admin.id;
  const update = "update public.organization_settings set hidden_nav = hidden_nav where organization_id = $1";

  afterAll(() => setFlag(false));

  it("is off by default: an admin at aal1 changes settings", async () => {
    expect((await withDb((db) => db.query("select require_admin_mfa from public.organizations where id = $1", [org()]))).rows[0].require_admin_mfa).toBe(false);
    await expect(asUser(adminId(), "aal1", update, [org()])).resolves.toBeDefined();
    expect((await asUser(adminId(), "aal1", "select public.mfa_ok() as ok")).rows[0].ok).toBe(true);
  });

  it("when on: admin without aal2 is refused; with aal2 allowed; other roles and the service role are unaffected", async () => {
    await setFlag(true);
    await expect(asUser(adminId(), "aal1", update, [org()])).rejects.toMatchObject({ code: "42501" });
    expect((await asUser(adminId(), "aal1", "select public.mfa_ok() as ok")).rows[0].ok).toBe(false);
    await expect(asUser(adminId(), "aal2", update, [org()])).resolves.toBeDefined();
    expect((await asUser(adminId(), "aal2", "select public.mfa_ok() as ok")).rows[0].ok).toBe(true);
    // Not an admin: the rule doesn't apply to them (they have their own limits).
    expect((await asUser(world.tenants.alpha.users.office.id, "aal1", "select public.mfa_ok() as ok")).rows[0].ok).toBe(true);
    // The owner / service role (no company) pass.
    expect((await adminClient().from("organization_settings").update({ hidden_nav: [] }).eq("organization_id", org())).error).toBeNull();
    // The other company is not affected by this company's setting.
    expect((await asUser(world.tenants.beta.users.admin.id, "aal1", "select public.mfa_ok() as ok")).rows[0].ok).toBe(true);
  });

  it("when on: reversing a payment and settling an unknown e-mail need aal2", async () => {
    await setFlag(false);
    const admin = clients.get("admin")!;
    const { data: id } = await admin.rpc("create_with_lines", {
      p_parent: "invoices",
      p_header: { customer: "Mfa Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0 },
      p_child: "invoice_line_items", p_fk: "invoice_id",
      p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
    });
    await admin.rpc("issue_invoice", { p_invoice: id });
    await admin.rpc("record_invoice_payment", { p_invoice: id, p_amount: 30, p_paid_on: "2026-10-11", p_method: "BACS", p_reference: null, p_request_id: randomUUID() });
    const paymentId = (await adminClient().from("invoice_payments").select("id").eq("invoice_id", id).single()).data!.id as string;
    const { data: job } = await adminClient().from("jobs").insert({ organization_id: org(), job_no: `J-MFA-${world.runId}`, customer: "Mfa Co" }).select("id").single();
    const reserved = await admin.rpc("reserve_job_email", { p_job: job!.id, p_recipient: "buyer@example.test", p_subject: "S", p_body: "B", p_key: randomUUID(), p_mode: "sending" });
    await admin.rpc("complete_job_email", { p_history: reserved.data.history_id, p_outcome: "unknown" });

    await setFlag(true);
    const reverse = "select public.reverse_invoice_payment($1, 'Entered in error')";
    await expect(asUser(adminId(), "aal1", reverse, [paymentId])).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(adminId(), "aal1", "select public.resolve_job_email($1, 'failed')", [reserved.data.history_id])).rejects.toMatchObject({ code: "42501", hint: "mfa_required" });
    // Recording a payment is held to it too since the audit of PR H (every privileged operation: tests/db/privileged-aal.test.ts), and aal2 can do both.
    await expect(asUser(adminId(), "aal1", "select public.record_invoice_payment($1, 10, '2026-10-11', 'BACS', null, gen_random_uuid())", [id])).rejects.toMatchObject({ code: "42501", hint: "mfa_required" });
    await expect(asUser(adminId(), "aal2", "select public.resolve_job_email($1, 'failed')", [reserved.data.history_id])).resolves.toBeDefined();
    await expect(asUser(adminId(), "aal2", reverse, [paymentId])).resolves.toBeDefined();
  });
});
