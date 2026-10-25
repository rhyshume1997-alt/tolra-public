/**
 * Migration 094: the Activity page (public.org_activity) shows one row per change. Read time only: every audit row stays stored.
 *
 *   (a) the app's own CREATE / UPDATE / DELETE note (write_audit) on a table the database already records row by row
 *       (security_audit.log_row_change) is not listed; on a table it doesn't (email_history) it is still the only record and is listed;
 *   (b) the row change of an UPDATE its own stamp trigger named (035 actor_stamp: ISSUE, RESEND, ...) is not listed; the named event is;
 *   any other row change is listed once; another company's rows are never listed; "Load more" (created_at, id) pages as before.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), so it runs on the local stack and on a plain Postgres rebuild
 * with Supabase stand-ins.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

type Row = { id: string; created_at: Date; action: string; entity_table: string; entity_id: string; record_table: string; record_id: string;
  changes: Record<string, unknown> | null; metadata: Record<string, unknown> | null };

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `094 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-094-${label}-${counter}`]);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

/** One API request: its own transaction, as role authenticated with the person's claims (as PostgREST runs it). */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

const writeAudit = (db: Client, action: string, table: string, id: string, oldData: unknown = null, newData: unknown = null) =>
  db.query("select public.write_audit($1, $2, $3, $4, $5, '{}'::jsonb, null, null)", [action, table, id, oldData, newData]);

const activity = (p: Person, args: { before?: Date | null; beforeId?: string | null; limit?: number } = {}) =>
  as(p, async (db) => (await db.query<Row>("select * from public.org_activity(null, null, null, null, $1, $2, $3)",
    [args.before ?? null, args.beforeId ?? null, args.limit ?? 500])).rows);

const stored = (entityIds: string[]) => withDb(async (db) => (await db.query<{ action: string; entity_table: string; source: string }>(
  "select action, entity_table, metadata ->> 'source' as source from security_audit.audit_log where entity_id = any($1) order by created_at, id", [entityIds])).rows);

const W = { A: "", B: "", adminA: person("admin-a"), officeA: person("office-a"), adminB: person("admin-b"), customer: "", invoice: "", customerB: "" };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.B = await makeOrg(db, "b");
    await member(db, W.A, W.adminA, "admin");
    await member(db, W.A, W.officeA, "office");
    await member(db, W.B, W.adminB, "admin");
  });
  // Office staff in A: a customer and a draft invoice with one line (the page's save), then the page's own CREATE note.
  await as(W.officeA, async (db) => {
    W.customer = (await db.query<{ id: string }>("insert into public.customers (organization_id, name) values ($1, $2) returning id", [W.A, `Acme ${run}`])).rows[0].id;
    W.invoice = (await db.query<{ id: string }>(
      "insert into public.invoices (organization_id, customer, status, subtotal, vat, total) values ($1, $2, 'draft', 100, 20, 120) returning id", [W.A, `Acme ${run}`])).rows[0].id;
    await db.query(
      "insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, 0, 'Flange', 1, 100, 20, false)",
      [W.A, W.invoice]);
  });
  await as(W.officeA, (db) => writeAudit(db, "CREATE", "invoices", W.invoice));
  // Issue it (one request: issue_invoice; the stamp trigger names it ISSUE, the row trigger records the UPDATE).
  await as(W.officeA, (db) => db.query("select public.issue_invoice($1)", [W.invoice]));
  // A real edit of the customer, with the page's own UPDATE note after it (customers/page.tsx).
  await as(W.officeA, async (db) => {
    await db.query("update public.customers set phone = '0123 456' where id = $1", [W.customer]);
  });
  await as(W.officeA, (db) => writeAudit(db, "UPDATE", "customers", W.customer, { phone: null }, { phone: "0123 456" }));
  // An admin renames a person (app/api/admin/users/route.ts: the update as the admin, then its UPDATE note on user_profiles).
  await as(W.adminA, (db) => db.query("update public.user_profiles set full_name = 'Olive Office' where id = $1", [W.officeA.id]));
  await as(W.adminA, (db) => writeAudit(db, "UPDATE", "user_profiles", W.officeA.id, { full_name: "x" }, { full_name: "Olive Office" }));
  // The invoice is e-mailed (first sent_date: a plain row change), then sent again (the stamp trigger's RESEND).
  await as(W.officeA, (db) => db.query("update public.invoices set sent_date = now() - interval '1 hour' where id = $1", [W.invoice]));
  await as(W.officeA, (db) => db.query("update public.invoices set sent_date = now() where id = $1", [W.invoice]));
  // An admin settles an unknown send outcome (mail/resolve): email_history has no row trigger, so this note is its only record.
  await as(W.adminA, (db) => writeAudit(db, "UPDATE", "email_history", W.invoice, { outcome: "unknown" }, { outcome: "failed" }));
  // Company B: its own customer and edit, with the app's notes.
  await as(W.adminB, async (db) => {
    W.customerB = (await db.query<{ id: string }>("insert into public.customers (organization_id, name) values ($1, $2) returning id", [W.B, `Beta ${run}`])).rows[0].id;
  });
  await as(W.adminB, (db) => writeAudit(db, "CREATE", "customers", W.customerB));
});

afterAll(async () => {
  await destroySyntheticWorld(run);
});

const summary = (rows: Row[]) => rows.slice().reverse().map((r) => `${r.action} ${r.entity_table}`);

describe("org_activity: one row per change (094)", () => {
  it("issuing an invoice shows its creation and Issued once each, never 'Status changed to issued' or the app's CREATE beside them", async () => {
    const rows = (await activity(W.adminA)).filter((r) => r.record_table === "invoices" && r.record_id === W.invoice);
    expect(summary(rows)).toEqual([
      "INSERT invoices", "INSERT invoice_line_items", "ISSUE invoices",
      "UPDATE invoices", // the first e-mail: sent_date set (a plain row change, listed once)
      "RESEND invoices",
    ]);
    expect(rows.find((r) => r.action === "ISSUE")?.metadata).toMatchObject({ invoice_ref: expect.stringMatching(/^INV-/) });
    expect(rows.filter((r) => r.action === "UPDATE").map((r) => Object.keys(r.changes ?? {}))).toEqual([["sent_date"]]);
    // Nothing was removed from the audit log: the app's CREATE and both stamped row changes are still stored.
    expect((await stored([W.invoice])).filter((r) => r.entity_table === "invoices").map((r) => `${r.action} ${r.source}`)).toEqual([
      "INSERT database_trigger", "CREATE write_audit", "ISSUE write_audit", "UPDATE database_trigger",
      "UPDATE database_trigger", "RESEND write_audit", "UPDATE database_trigger",
    ]);
  });

  it("a real field change shows once, as the database's row change with what changed; the app's own note of it is hidden", async () => {
    const rows = await activity(W.adminA);
    const customer = rows.filter((r) => r.entity_table === "customers" && r.entity_id === W.customer);
    expect(summary(customer)).toEqual(["INSERT customers", "UPDATE customers"]);
    expect(customer[0].changes).toEqual({ phone: { from: null, to: "0123 456" } });
    const profile = rows.filter((r) => r.entity_table === "user_profiles" && r.entity_id === W.officeA.id);
    expect(summary(profile)).toEqual(["INSERT user_profiles", "UPDATE user_profiles"]);
    expect(Object.keys(profile[0].changes ?? {})).toEqual(["full_name"]);
    expect(rows.some((r) => r.action === "CREATE")).toBe(false);
    expect((await stored([W.customer, W.officeA.id])).filter((r) => r.source === "write_audit").map((r) => `${r.action} ${r.entity_table}`))
      .toEqual(["UPDATE customers", "UPDATE user_profiles"]);
  });

  it("named events still show, and an app note on a table without row changes (email_history) is still listed", async () => {
    const rows = await activity(W.adminA);
    expect(rows.filter((r) => r.entity_id === W.invoice && ["ISSUE", "RESEND"].includes(r.action)).map((r) => r.action)).toEqual(["RESEND", "ISSUE"]);
    expect(rows.filter((r) => r.entity_table === "email_history").map((r) => r.action)).toEqual(["UPDATE"]);
  });

  it("another company's rows are never listed, either way round", async () => {
    const a = await activity(W.adminA);
    const b = await activity(W.adminB);
    expect(a.some((r) => r.entity_id === W.customerB || r.entity_id === W.adminB.id)).toBe(false);
    expect(b.some((r) => [W.customer, W.invoice, W.adminA.id, W.officeA.id].includes(r.entity_id))).toBe(false);
    expect(summary(b.filter((r) => r.entity_table === "customers"))).toEqual(["INSERT customers"]);
    // Office staff still can't read the log at all.
    await expect(activity(W.officeA)).rejects.toMatchObject({ code: "42501" });
  });

  it("'Load more' pages exactly as before: page after page of 2 gives the whole list once, in order", async () => {
    const all = await activity(W.adminA);
    expect(all.length).toBeGreaterThan(6);
    const paged: Row[] = [];
    for (let page = await activity(W.adminA, { limit: 2 }); page.length; ) {
      paged.push(...page);
      const last = page[page.length - 1];
      page = await activity(W.adminA, { before: last.created_at, beforeId: last.id, limit: 2 });
    }
    expect(paged.map((r) => r.id)).toEqual(all.map((r) => r.id));
  });
});

/** Every audit row as stored: how many, and an md5 over each row's id and chain hash (any write, change or removal moves it). */
const auditFingerprint = () => withDb(async (db) => (await db.query<{ n: string; h: string }>(
  "select count(*)::text as n, md5(coalesce(string_agg(id::text || ':' || coalesce(hash, ''), ',' order by id), '')) as h from security_audit.audit_log")).rows[0]);

/**
 * One change, made the way the app makes it (`steps`, each its own request): the Activity entries it adds for `entityId`, how many audit
 * rows it stored, and proof that reading the Activity log wrote, changed and removed no audit row.
 */
async function once(steps: (() => Promise<unknown>)[], entityId: string) {
  const before = new Set((await activity(W.adminA)).map((r) => r.id));
  const storedBefore = (await stored([entityId])).length;
  for (const step of steps) await step();
  const audit = await auditFingerprint();
  const added = (await activity(W.adminA)).filter((r) => !before.has(r.id) && (r.entity_id === entityId || r.record_id === entityId));
  await activity(W.adminA, { limit: 3 });
  expect(await auditFingerprint(), "org_activity wrote, changed or removed no audit row").toEqual(audit);
  return { added, storedRows: (await stored([entityId])).length - storedBefore };
}

describe("exactly one Activity entry per change (094)", () => {
  it("issuing an invoice: the Issued entry only (its row change and nothing else listed)", async () => {
    const invoice = await as(W.officeA, async (db) => {
      const id = (await db.query<{ id: string }>(
        "insert into public.invoices (organization_id, customer, status, subtotal, vat, total) values ($1, $2, 'draft', 50, 10, 60) returning id", [W.A, `Acme ${run}`])).rows[0].id;
      await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, 0, 'Bush', 1, 50, 20, false)", [W.A, id]);
      return id;
    });
    const { added, storedRows } = await once([() => as(W.officeA, (db) => db.query("select public.issue_invoice($1)", [invoice]))], invoice);
    expect(added.map((r) => r.action)).toEqual(["ISSUE"]);
    expect(storedRows).toBe(2); // ISSUE and the row change: both kept
  });

  it("updating a customer: one entry, the row change with what changed (the page's own UPDATE note hidden)", async () => {
    const customer = await as(W.officeA, async (db) => (await db.query<{ id: string }>(
      "insert into public.customers (organization_id, name) values ($1, $2) returning id", [W.A, `Once Co ${run}`])).rows[0].id);
    const { added, storedRows } = await once([
      () => as(W.officeA, (db) => db.query("update public.customers set email = 'accounts@once.example.test' where id = $1", [customer])),
      () => as(W.officeA, (db) => writeAudit(db, "UPDATE", "customers", customer, { email: null }, { email: "accounts@once.example.test" })),
    ], customer);
    expect(added.map((r) => `${r.action} ${Object.keys(r.changes ?? {}).join(",")}`)).toEqual(["UPDATE email"]);
    expect(storedRows).toBe(2);
  });

  it("renaming a user (the admin route: the update as the admin, then its write_audit UPDATE on user_profiles): one entry", async () => {
    const { added, storedRows } = await once([
      () => as(W.adminA, (db) => db.query("update public.user_profiles set full_name = 'Olive O. Office' where id = $1", [W.officeA.id])),
      () => as(W.adminA, (db) => writeAudit(db, "UPDATE", "user_profiles", W.officeA.id, { full_name: "Olive Office" }, { full_name: "Olive O. Office" })),
    ], W.officeA.id);
    expect(added.map((r) => `${r.action} ${Object.keys(r.changes ?? {}).join(",")}`)).toEqual(["UPDATE full_name"]);
    expect(storedRows).toBe(2);
  });

  it("changing a status: a sales order confirmed (the stamp trigger's CONFIRM) is one entry, Confirmed", async () => {
    const order = await as(W.officeA, async (db) => (await db.query<{ id: string }>(
      "insert into public.sales_orders (organization_id, so_number, customer, status) values ($1, $2, $3, 'open') returning id", [W.A, `SO-${run}`, `Acme ${run}`])).rows[0].id);
    const { added, storedRows } = await once([() => as(W.officeA, (db) => db.query("update public.sales_orders set status = 'confirmed' where id = $1", [order]))], order);
    expect(added.map((r) => r.action)).toEqual(["CONFIRM"]);
    expect(storedRows).toBe(2);
  });

  it("changing a status with no named event (a draft quote sent, as the Quotes page does): one entry, the row change", async () => {
    const quote = await as(W.officeA, async (db) => (await db.query<{ id: string }>(
      "insert into public.quotes (organization_id, quote_ref, customer, status, total_value) values ($1, $2, $3, 'draft', 0) returning id", [W.A, `QUO-${run}`, `Acme ${run}`])).rows[0].id);
    const { added, storedRows } = await once([() => as(W.officeA, (db) => db.query("update public.quotes set status = 'sent', sent_at = now() where id = $1", [quote]))], quote);
    expect(added.map((r) => `${r.action} ${(r.changes?.status as { to?: string } | undefined)?.to}`)).toEqual(["UPDATE sent"]);
    expect(storedRows).toBe(1);
  });
});
