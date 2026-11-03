/** Test-only. All baseline files run first; only these release proofs prepare the reviewed phases. */
import { readFileSync } from "node:fs";
import path from "node:path";
const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const phases = [
  { marker: "post-144 marker 145 company_setup", file: "supabase/release/145_company_setup.release.sql" },
  { marker: "post-144 marker 146 tolra_provided_ai", file: "supabase/release/146_tolra_provided_ai.release.sql" },
];
export async function preparePost144Fixture(deps: {
  verify: () => Promise<unknown>;
  query: (sql: string) => Promise<{ rows: Array<{ check?: string; value?: string }> }>;
}) {
  await deps.verify();
  await deps.query("SELECT pg_advisory_lock(144145146)");
  try {
    for (const phase of phases) {
      const state = (await deps.query(read("supabase/verify/release_preflight.sql"))).rows.find(row => row.check === phase.marker);
      if (!state) throw new Error(`Missing release preflight marker: ${phase.marker}`);
      if (state.value === "applied") continue;
      // The one-time file refuses existing/mismatched objects. Never replace them to make a test pass.
      await deps.query(read(phase.file));
      const after = (await deps.query(read("supabase/verify/release_preflight.sql"))).rows.find(row => row.check === phase.marker);
      if (after?.value !== "applied") throw new Error(`Release fixture did not verify: ${phase.marker}`);
    }
    await deps.query("NOTIFY pgrst, 'reload schema'");
  } finally { await deps.query("SELECT pg_advisory_unlock(144145146)"); }
}
export async function preparePost144Backend() {
  const { verifyBackendIdentity, withDb, adminClient } = await import("./fixtures");
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await adminClient().from("company_setup_progress").select("organization_id").limit(0);
    if (!result.error) return;
    if (!["PGRST205", "42P01"].includes(result.error.code)) throw result.error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Post-144 schema cache did not reload");
}
