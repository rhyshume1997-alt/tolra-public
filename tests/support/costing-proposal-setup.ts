import { readFileSync } from "node:fs";
import { verifyBackendIdentity, withDb } from "./fixtures";

type Environment = { CI?: string; COSTING_ATOMIC_THROWAWAY?: string };
type Setup = {
  verify: () => Promise<unknown>;
  exists: () => Promise<boolean>;
  install: () => Promise<unknown>;
  remove: () => Promise<unknown>;
};
const signature = "public.save_costing_settings_atomic(uuid,jsonb,jsonb)";
const database: Setup = {
  verify: verifyBackendIdentity,
  exists: () => withDb(async db => Boolean((await db.query("select to_regprocedure($1) as fn", [signature])).rows[0].fn)),
  install: () => withDb(db => db.query(readFileSync(new URL("../../supabase/proposals/builder2_costing_settings_atomic.sql", import.meta.url), "utf8"))),
  remove: () => withDb(db => db.query(`drop function ${signature}`)),
};

/** CI supplies a disposable stack, not an operator acknowledgement. Both paths must prove isolation before any DDL. */
export async function prepareCostingProposal(env: Environment = process.env, setup: Setup = database): Promise<() => Promise<void>> {
  const ci = env.CI === "true";
  if (!ci && env.COSTING_ATOMIC_THROWAWAY !== "yes") {
    throw new Error("Operator must explicitly set COSTING_ATOMIC_THROWAWAY=yes on the disposable local stack");
  }
  await setup.verify(); // Rejects non-loopback URLs, hosted keys, missing schema and non-synthetic tenants.
  if (await setup.exists()) return async () => {}; // Never replace or remove an operator's existing proposal.
  if (!ci) throw new Error("Proposal missing: follow the operator plan");
  await setup.install();
  return async () => {
    await setup.verify();
    await setup.remove(); // Only the function installed by this suite; migration 143 and its tables remain.
  };
}
