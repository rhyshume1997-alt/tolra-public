import { describe, expect, it } from "vitest";

import { IsolationError } from "../support/isolation";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

describe("backend identity check", () => {
  it("records the disposable backend it runs against", async () => {
    const identity = await verifyBackendIdentity();
    expect(identity.database.host).toBe("127.0.0.1");
    expect(identity.migrations.length).toBeGreaterThan(0);
    expect(identity.gitSha).toMatch(/^[0-9a-f]{40}$|^unknown$/);
  });

  it("refuses a database that holds a real-looking (non-synthetic) organisation", async () => {
    const id = await withDb(async (db) => (await db.query<{ id: string }>("insert into public.organizations (name, slug) values ('Real Co', 'real-co') returning id")).rows[0].id);
    try {
      await expect(verifyBackendIdentity()).rejects.toThrow(IsolationError);
      await expect(verifyBackendIdentity()).rejects.toThrow(/real-co/);
    } finally {
      await withDb((db) => db.query("delete from public.organizations where id = $1", [id]));
    }
    await expect(verifyBackendIdentity()).resolves.toBeTruthy();
  });
});
