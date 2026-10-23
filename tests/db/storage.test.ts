/**
 * Storage buckets (pre-go-live hardening, migration 033). Every bucket: two companies can't read, list, write or delete
 * each other's objects; each role gets exactly what its policy says; anonymous requests get nothing; and a token whose
 * session was signed out or revoked stops working at once (017 left Storage out of that check until 033).
 *
 * Uses the real Storage API of the local stack, as the browser does.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { ROLES, type Role, type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

type Access = { read: Role[]; write: Role[] };
/** From the policies in 006 (quote-attachments, job-drawings) and 008 (org-logos). */
const BUCKETS: Record<string, Access> = {
  "quote-attachments": { read: ["admin", "office"], write: ["admin", "office"] },
  "job-drawings": { read: ["admin", "office", "workshop", "viewer"], write: ["admin", "office", "workshop"] },
  "org-logos": { read: ["admin", "office", "workshop", "viewer"], write: ["admin"] },
};

/**
 * 040's job-photos bucket is not in BUCKETS: the browser roles may only upload the object a reservation of their own names (no
 * read, list, replace or delete for anyone), JPEG only, 2 MiB at most. tests/db/job-photos.test.ts proves all of that.
 */
const PHOTO_BUCKETS = ["job-photos"];
/**
 * 067's document-attachments bucket (files on delivery notes and purchase orders) is not in BUCKETS either: its rules depend on the
 * folder (delivery-notes: admin, office, workshop; purchase-orders: admin and office) and on the parent existing, so
 * tests/db/document-attachments.test.ts proves them. Three permissive rules (read, upload, delete once the row has gone) and one
 * restrictive one (not deleted while listed).
 */
const DOCUMENT_BUCKETS = ["document-attachments"];

// 1x1 PNG: every bucket in BUCKETS accepts image/png.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const OPTIONS = { contentType: "image/png" };

let world: SyntheticWorld;
const service = () => adminClient();
const orgOf = (tenant: "alpha" | "beta") => world.tenants[tenant].id;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const bucket of Object.keys(BUCKETS)) {
    for (const tenant of ["alpha", "beta"] as const) {
      const up = await service().storage.from(bucket).upload(`${orgOf(tenant)}/seed.png`, PNG, OPTIONS);
      if (up.error) throw new Error(`seed ${bucket}: ${up.error.message}`);
      for (const role of ROLES) {
        const own = await service().storage.from(bucket).upload(`${orgOf(tenant)}/del-${role}.png`, PNG, OPTIONS);
        if (own.error) throw new Error(`seed ${bucket}: ${own.error.message}`);
      }
    }
  }
});

afterAll(async () => {
  if (!world) return;
  for (const bucket of Object.keys(BUCKETS)) {
    for (const tenant of ["alpha", "beta"] as const) {
      const listed = await service().storage.from(bucket).list(orgOf(tenant), { limit: 200 });
      const names = (listed.data ?? []).map((o) => `${orgOf(tenant)}/${o.name}`);
      if (names.length) await service().storage.from(bucket).remove(names);
    }
  }
  await destroySyntheticWorld(world.runId);
});

const as = (tenant: "alpha" | "beta", role: Role) => signedInClient(world.tenants[tenant].users[role]);
const names = async (client: SupabaseClient, bucket: string, org: string) => ((await client.storage.from(bucket).list(org, { limit: 200 })).data ?? []).map((o) => o.name);
const exists = async (bucket: string, tenant: "alpha" | "beta", name: string) => (await names(service(), bucket, orgOf(tenant))).includes(name);

describe("which buckets exist", () => {
  it("the buckets this test covers are exactly the ones the migrations create", async () => {
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    const fromMigrations = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      for (const match of readFileSync(path.join(dir, file), "utf8").matchAll(/INSERT INTO storage\.buckets[^;]*?VALUES\s*\(\s*'([^']+)'/gi)) fromMigrations.add(match[1]);
    }
    const inDatabase = await withDb(async (db) => (await db.query("select id from storage.buckets order by id")).rows.map((r) => r.id as string));
    expect([...fromMigrations].sort()).toEqual([...Object.keys(BUCKETS), ...PHOTO_BUCKETS, ...DOCUMENT_BUCKETS].sort());
    expect(inDatabase).toEqual([...Object.keys(BUCKETS), ...PHOTO_BUCKETS, ...DOCUMENT_BUCKETS].sort());
    // All private, and every one has the session check (033) and its per-bucket policies.
    expect(await withDb(async (db) => (await db.query("select count(*)::int as n from storage.buckets where public")).rows[0].n)).toBe(0);
    for (const bucket of [...Object.keys(BUCKETS), ...PHOTO_BUCKETS, ...DOCUMENT_BUCKETS]) {
      const n = await withDb(async (db) => (await db.query("select count(*)::int as n from pg_policies where schemaname = 'storage' and tablename = 'objects' and (qual like $1 or with_check like $1)", [`%${bucket}%`])).rows[0].n);
      // 034 adds two restrictive rules to the job-drawings and quote-attachments buckets (attached files are not overwritten or deleted),
      // and quote-attachments one more: the read of the files a job of the same company refers to (tests/db/job-files.test.ts).
      // 040's job-photos: one permissive rule (upload the reserved object) and four restrictive ones (only that; no read, move or
      // overwrite, delete), proven in tests/db/job-photos.test.ts.
      const expected = bucket === "quote-attachments" ? 7 : bucket === "job-drawings" ? 6 : bucket === "job-photos" ? 5 : 4;
      expect({ bucket, policies: n }).toEqual({ bucket, policies: expected });
    }
  });
});

describe.each(Object.entries(BUCKETS))("bucket %s", (bucket, access) => {
  it("each role reads, lists, writes, replaces and deletes in its own company exactly as the policy says", async () => {
    const alpha = orgOf("alpha");
    for (const role of ROLES) {
      const client = await as("alpha", role);
      const store = client.storage.from(bucket);
      const canRead = access.read.includes(role);
      const canWrite = access.write.includes(role);

      const download = await store.download(`${alpha}/seed.png`);
      expect({ role, read: !download.error }).toEqual({ role, read: canRead });
      expect({ role, listed: (await names(client, bucket, alpha)).includes("seed.png") }).toEqual({ role, listed: canRead });

      const fresh = await store.upload(`${alpha}/new-${role}.png`, PNG, OPTIONS);
      expect({ role, wrote: !fresh.error }).toEqual({ role, wrote: canWrite });
      const replace = await store.upload(`${alpha}/seed.png`, PNG, { ...OPTIONS, upsert: true });
      expect({ role, replaced: !replace.error }).toEqual({ role, replaced: canWrite });

      const removed = await store.remove([`${alpha}/del-${role}.png`]);
      expect({ role, deleted: (removed.data ?? []).length }).toEqual({ role, deleted: canWrite ? 1 : 0 });
      expect(await exists(bucket, "alpha", `del-${role}.png`)).toBe(!canWrite);

      // A path outside any company folder, and one with a fake folder, are refused too.
      expect((await store.upload(`loose-${role}.png`, PNG, OPTIONS)).error).not.toBeNull();
      expect((await store.upload(`${alpha}-x/${role}.png`, PNG, OPTIONS)).error).not.toBeNull();
    }
  });

  it("no role can read, list, write, replace or delete the other company's objects", async () => {
    const beta = orgOf("beta");
    const before = await names(service(), bucket, beta);
    const seedBytes = Buffer.from(await (await service().storage.from(bucket).download(`${beta}/seed.png`)).data!.arrayBuffer());
    for (const role of ROLES) {
      const client = await as("alpha", role);
      const store = client.storage.from(bucket);
      expect({ role, read: !(await store.download(`${beta}/seed.png`)).error }).toEqual({ role, read: false });
      expect({ role, listed: await names(client, bucket, beta) }).toEqual({ role, listed: [] });
      expect({ role, wrote: !(await store.upload(`${beta}/x-${role}.png`, PNG, OPTIONS)).error }).toEqual({ role, wrote: false });
      expect({ role, replaced: !(await store.upload(`${beta}/seed.png`, Buffer.from("tampered"), { ...OPTIONS, upsert: true })).error }).toEqual({ role, replaced: false });
      expect({ role, moved: !(await store.move(`${beta}/seed.png`, `${orgOf("alpha")}/stolen-${role}.png`)).error }).toEqual({ role, moved: false });
      expect({ role, copied: !(await store.copy(`${beta}/seed.png`, `${orgOf("alpha")}/copy-${role}.png`)).error }).toEqual({ role, copied: false });
      expect({ role, deleted: ((await store.remove([`${beta}/seed.png`, `${beta}/del-${role}.png`])).data ?? []).length }).toEqual({ role, deleted: 0 });
      expect({ role, signed: !(await store.createSignedUrl(`${beta}/seed.png`, 60)).error }).toEqual({ role, signed: false });
    }
    expect(await names(service(), bucket, beta)).toEqual(before);
    const after = Buffer.from(await (await service().storage.from(bucket).download(`${beta}/seed.png`)).data!.arrayBuffer());
    expect(after.equals(seedBytes)).toBe(true);
    expect(await exists(bucket, "alpha", "stolen-admin.png")).toBe(false);
    expect(await exists(bucket, "alpha", "copy-admin.png")).toBe(false);
  });

  it("anonymous requests read, list, write and delete nothing, and there is no public URL", async () => {
    const { apiUrl, anonKey } = isolatedBackend();
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const alpha = orgOf("alpha");
    const store = anon.storage.from(bucket);
    expect((await store.download(`${alpha}/seed.png`)).error).not.toBeNull();
    expect(await names(anon, bucket, alpha)).toEqual([]);
    expect((await store.upload(`${alpha}/anon.png`, PNG, OPTIONS)).error).not.toBeNull();
    expect((await store.upload(`${alpha}/seed.png`, PNG, { ...OPTIONS, upsert: true })).error).not.toBeNull();
    expect(((await store.remove([`${alpha}/seed.png`])).data ?? []).length).toBe(0);
    expect((await store.createSignedUrl(`${alpha}/seed.png`, 60)).error).not.toBeNull();
    const publicUrl = await fetch(`${apiUrl}/storage/v1/object/public/${bucket}/${alpha}/seed.png`);
    expect(publicUrl.ok).toBe(false);
    expect(await exists(bucket, "alpha", "seed.png")).toBe(true);
    expect(await exists(bucket, "alpha", "anon.png")).toBe(false);
  });
});

describe("a signed-out or revoked token stops reaching Storage at once (033)", () => {
  /** A client that only carries a copy of the access token, as an attacker (or a stale tab) would. */
  const holding = (token: string) => {
    const { apiUrl, anonKey } = isolatedBackend();
    return createClient(apiUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  };

  async function allRefused(token: string, bucket: string) {
    const stale = holding(token);
    const alpha = orgOf("alpha");
    const store = stale.storage.from(bucket);
    expect({ bucket, read: !(await store.download(`${alpha}/seed.png`)).error }).toEqual({ bucket, read: false });
    expect({ bucket, listed: await names(stale, bucket, alpha) }).toEqual({ bucket, listed: [] });
    expect({ bucket, wrote: !(await store.upload(`${alpha}/late.png`, PNG, OPTIONS)).error }).toEqual({ bucket, wrote: false });
    expect({ bucket, deleted: ((await store.remove([`${alpha}/seed.png`])).data ?? []).length }).toEqual({ bucket, deleted: 0 });
    expect(await exists(bucket, "alpha", "seed.png")).toBe(true);
    expect(await exists(bucket, "alpha", "late.png")).toBe(false);
  }

  it("after signing out", async () => {
    const client = await as("alpha", "admin");
    const token = (await client.auth.getSession()).data.session!.access_token;
    // Control: the token works while the session is alive, in every bucket.
    for (const bucket of Object.keys(BUCKETS)) expect((await holding(token).storage.from(bucket).download(`${orgOf("alpha")}/seed.png`)).error).toBeNull();
    expect((await client.auth.signOut()).error).toBeNull();
    for (const bucket of Object.keys(BUCKETS)) await allRefused(token, bucket);
  });

  it("after the session is revoked (password change, admin sign-out)", async () => {
    const client = await as("alpha", "admin");
    const session = (await client.auth.getSession()).data.session!;
    const sessionId = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()).session_id as string;
    for (const bucket of Object.keys(BUCKETS)) expect((await holding(session.access_token).storage.from(bucket).download(`${orgOf("alpha")}/seed.png`)).error).toBeNull();
    await withDb((db) => db.query("delete from auth.sessions where id = $1", [sessionId]));
    for (const bucket of Object.keys(BUCKETS)) await allRefused(session.access_token, bucket);
  });

  it("another person's live session is not affected", async () => {
    const office = await as("alpha", "office");
    expect((await office.storage.from("job-drawings").download(`${orgOf("alpha")}/seed.png`)).error).toBeNull();
  });
});
