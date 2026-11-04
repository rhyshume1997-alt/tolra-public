import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { prepareChaseBrowserProposal } from "../support/chase-browser-proposal";
const source = readFileSync("supabase/proposals/builder2_chase_settings_atomic.sql", "utf8");
const hash = createHash("md5").update(source.match(/AS \$\$([\s\S]*?)\$\$;/)![1].replace(/\s/g, "")).digest("hex");
const row = () => ({ oid: "12345", hash, invoker: true, pinned: true, allowed: true, anonymous: false });
let current: ReturnType<typeof row> | undefined;
let verified: boolean;
const verify = vi.fn(async () => { verified = true; });
const query = vi.fn(async (sql: string) => {
  expect(verified).toBe(true);
  if (sql.startsWith("SELECT")) return { rows: current ? [current] : [] };
  if (sql.includes("CREATE OR REPLACE FUNCTION")) current = row();
  if (sql.includes("DROP FUNCTION")) current = undefined;
  return { rows: [] };
});
beforeEach(() => { current = undefined; verified = false; verify.mockClear(); query.mockClear(); });
it("fails the identity guard before any SQL can run", async () => {
  await expect(prepareChaseBrowserProposal({ verify: async () => { throw new Error("unsafe backend"); }, query })).rejects.toThrow("unsafe backend");
  expect(query).not.toHaveBeenCalled();
});
it("installs only the exact missing proposal atomically and removes only its own verified definition", async () => {
  const cleanup = await prepareChaseBrowserProposal({ verify, query });
  expect(query.mock.calls.filter(([sql]) => sql.includes("CREATE OR REPLACE FUNCTION"))).toHaveLength(1);
  expect(query.mock.calls.find(([sql]) => sql.includes("CREATE OR REPLACE FUNCTION"))![0]).toContain(source);
  await cleanup(); expect(current).toBeUndefined(); expect(verify).toHaveBeenCalledTimes(2);
});
it("leaves a matching pre-existing function untouched", async () => {
  current = row(); const cleanup = await prepareChaseBrowserProposal({ verify, query }); await cleanup();
  expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true); expect(current).toEqual(row());
});
it("refuses a mismatched function instead of overwriting it", async () => {
  current = { ...row(), hash: "different" };
  await expect(prepareChaseBrowserProposal({ verify, query })).rejects.toThrow("refusing to replace");
  expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
});
it("does not remove a definition changed after installation", async () => {
  const cleanup = await prepareChaseBrowserProposal({ verify, query }); current = { ...row(), oid: "54321" };
  await expect(cleanup()).rejects.toThrow("refusing to remove"); expect(current.oid).toBe("54321");
});
