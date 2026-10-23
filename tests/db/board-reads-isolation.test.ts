/**
 * The browser reads the Job Board and the Customers page make with the person's own session stay inside the session's company.
 *
 *   - Job Board (lib/job-board-files.ts loadBoardJobFiles): job_files id, job_id, kind, file_name where kind is drawing or customer_po,
 *     not superseded, not deleted, with no job filter. Policies: "job_files rbac select" (034) plus the RESTRICTIVE photo (040) and
 *     customer PO (067) rules for viewers.
 *   - Customers page only (lib/customers.ts readDocumentCustomerNames; the pickers keep the saved list): id and customer of every row,
 *     page by page in id order, of rfqs, quotes,
 *     sales_orders and invoices. Policies: "<table> rbac select" (006, 034) and "<table> section access" (012).
 *
 * Who reads: a member of A only; a viewer of A; a member of A and B working in A (the session's company, 036); a member of both
 * with no company chosen; a platform owner's support session in A (read-only, aal2) and the same login at aal1; a login whose A
 * membership was switched off; and one switched off in A that still belongs to B. Nobody sees a row of a company their session is
 * not working in.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as company-access.test.ts, so it also runs on a plain
 * Postgres rebuild with Supabase stand-ins.
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

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `Board ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-board-${label}-${counter}`]);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string, extra: { active?: boolean; support?: boolean } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $2, $3, $4, true, false) on conflict (id) do nothing`, [p.id, p.email, role, org]);
  await db.query(
    `insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
     values ($1, $2, $3, $4, $5, case when $5 then now() + interval '2 hours' end, case when $5 then gen_random_uuid() end)`,
    [p.id, org, role, extra.active ?? true, extra.support ?? false]);
}

/** The company this person's sign-in session works in (as switch_organization writes it; a support pick carries its grant). */
async function choose(db: Client, p: Person, org: string) {
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query(
    `insert into security_audit.session_company (session_id, user_id, organization_id, grant_id)
     values ($1, $2, $3, (select support_grant from public.organization_members where user_id = $2 and organization_id = $3))`,
    [p.session, p.id, org]);
}

/** One company's rows: a job with a current drawing, a superseded drawing, the customer's PO, a cert and a photo; one row on each document table. */
async function seedCompany(db: Client, org: string, tag: string) {
  const job = (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, $3) returning id",
    [org, `J-${tag}-${run}`, `Cust ${tag} ${run}`])).rows[0].id;
  const poPath = `${org}/Q-${tag}-${run}/po.pdf`;
  const po = (await db.query<{ id: string }>(
    "insert into public.quote_attachments (organization_id, quote_ref, file_path, file_name, kind) values ($1, $2, $3, $4, 'customer_po') returning id",
    [org, `Q-${tag}-${run}`, poPath, `po-${tag}.pdf`])).rows[0].id;
  const photo = randomUUID();
  const dir = `${org}/${job}`;
  await db.query(
    `insert into public.job_files (id, organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, superseded_at, source_attachment_id,
                                   upload_state, byte_size, mime_type, uploaded_at) values
       (gen_random_uuid(), $1, $2, 'drawing', 'dwg', 'dwg.pdf', 'job-drawings', $3, null, null, null, null, null, null),
       (gen_random_uuid(), $1, $2, 'drawing', 'old', 'old.pdf', 'job-drawings', $4, now(), null, null, null, null, null),
       (gen_random_uuid(), $1, $2, 'customer_po', 'po', 'po.pdf', 'quote-attachments', $5, null, $6, null, null, null, null),
       (gen_random_uuid(), $1, $2, 'cert', 'cert', 'cert.pdf', 'job-drawings', $7, null, null, null, null, null, null),
       ($8, $1, $2, 'photo', 'ph', 'ph.jpg', 'job-photos', $9, null, null, 'uploaded', 10, 'image/jpeg', now())`,
    [org, job, `${dir}/dwg.pdf`, `${dir}/old.pdf`, poPath, po, `${dir}/cert.pdf`, photo, `${dir}/photos/${photo}.jpg`]);
  const customer = `Cust ${tag} ${run}`;
  await db.query("insert into public.rfqs (organization_id, customer) values ($1, $2)", [org, customer]);
  await db.query("insert into public.quotes (organization_id, quote_ref, customer) values ($1, $2, $3)", [org, `Q-${tag}-${run}`, customer]);
  await db.query("insert into public.sales_orders (organization_id, so_number, customer) values ($1, $2, $3)", [org, `SO-${tag}-${run}`, customer]);
  await db.query("insert into public.invoices (organization_id, customer) values ($1, $2)", [org, customer]);
}

type Seen = { boardA: number; boardB: number; namesA: number; namesB: number; boardKinds: string[] };

/** The two browser reads, exactly as the app sends them, as the signed-in `p`; counted per company. Read-only, rolled back. */
async function reads(p: Person, aal = "aal1"): Promise<Seen> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal, email: p.email, ...(p.session ? { session_id: p.session } : {}) }), p.id]);
      const board = (await db.query<{ organization_id: string; kind: string }>(
        `select f.id, f.job_id, f.kind, f.file_name, f.organization_id from public.job_files f
         where f.kind in ('drawing', 'customer_po') and f.superseded_at is null and f.deleted_at is null order by f.created_at, f.id`)).rows;
      const names: string[] = [];
      for (const table of ["rfqs", "quotes", "sales_orders", "invoices"]) {
        names.push(...(await db.query<{ customer: string }>(`select id, customer from public.${table} order by id`)).rows.map((r) => r.customer));
      }
      const mine = board.filter((r) => r.organization_id === W.A || r.organization_id === W.B);
      return {
        boardA: mine.filter((r) => r.organization_id === W.A).length,
        boardB: mine.filter((r) => r.organization_id === W.B).length,
        namesA: names.filter((n) => n === `Cust A ${run}`).length,
        namesB: names.filter((n) => n === `Cust B ${run}`).length,
        boardKinds: [...new Set(mine.map((r) => r.kind))].sort(),
      };
    } finally {
      await db.query("rollback");
    }
  });
}

const W = {
  A: "", B: "",
  aOffice: person("a-office"), aViewer: person("a-viewer"), dual: person("dual"), dualUnchosen: person("dual-unchosen"),
  support: person("support"), removed: person("removed"), removedInB: person("removed-in-b"), bAdmin: person("b-admin"),
};

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.B = await makeOrg(db, "b");
    await member(db, W.A, W.aOffice, "office");
    await member(db, W.A, W.aViewer, "viewer");
    await member(db, W.A, W.dual, "office");
    await member(db, W.B, W.dual, "admin");
    await member(db, W.A, W.dualUnchosen, "office");
    await member(db, W.B, W.dualUnchosen, "admin");
    await member(db, W.B, W.support, "office");
    await member(db, W.A, W.support, "admin", { support: true });
    await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [W.support.id]);
    await member(db, W.A, W.removed, "office", { active: false });
    await member(db, W.B, W.removedInB, "office");
    await member(db, W.A, W.removedInB, "admin", { active: false });
    await member(db, W.B, W.bAdmin, "admin");
    for (const p of [W.aOffice, W.aViewer, W.dual, W.support, W.removed, W.removedInB]) await choose(db, p, W.A);
    await choose(db, W.bAdmin, W.B);
    await seedCompany(db, W.A, "A");
    await seedCompany(db, W.B, "B");
  });
});

afterAll(async () => {
  await destroySyntheticWorld(run);
});

describe("Job Board files and document customer names stay in the session's company", () => {
  it("a member of A only sees A's current drawings and PO, and A's customer names; nothing of B", async () => {
    expect(await reads(W.aOffice)).toEqual({ boardA: 2, boardB: 0, namesA: 4, namesB: 0, boardKinds: ["customer_po", "drawing"] });
    // The same reads from B's side see B only: both companies' rows are there.
    expect(await reads(W.bAdmin)).toEqual({ boardA: 0, boardB: 2, namesA: 0, namesB: 4, boardKinds: ["customer_po", "drawing"] });
  });

  it("a viewer of A sees A's drawing only (no PO, 067) and no document names; nothing of B", async () => {
    expect(await reads(W.aViewer)).toEqual({ boardA: 1, boardB: 0, namesA: 0, namesB: 0, boardKinds: ["drawing"] });
  });

  it("a member of A and B working in A sees A only; with no company chosen, nothing", async () => {
    expect(await reads(W.dual)).toEqual({ boardA: 2, boardB: 0, namesA: 4, namesB: 0, boardKinds: ["customer_po", "drawing"] });
    expect(await reads(W.dualUnchosen)).toEqual({ boardA: 0, boardB: 0, namesA: 0, namesB: 0, boardKinds: [] });
  });

  it("a support session in A (read-only, aal2) sees A only, though the login also belongs to B; at aal1, nothing", async () => {
    expect(await reads(W.support, "aal2")).toEqual({ boardA: 2, boardB: 0, namesA: 4, namesB: 0, boardKinds: ["customer_po", "drawing"] });
    expect(await reads(W.support, "aal1")).toEqual({ boardA: 0, boardB: 0, namesA: 0, namesB: 0, boardKinds: [] });
  });

  it("a removed member of A sees nothing of A or B; one still in B falls back to B and sees nothing of A", async () => {
    expect(await reads(W.removed)).toEqual({ boardA: 0, boardB: 0, namesA: 0, namesB: 0, boardKinds: [] });
    expect(await reads(W.removedInB)).toEqual({ boardA: 0, boardB: 2, namesA: 0, namesB: 4, boardKinds: ["customer_po", "drawing"] });
  });
});
