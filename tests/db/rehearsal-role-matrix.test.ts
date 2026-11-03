// REHEARSAL ONLY (branch claude/247-rehearsal, never merged). Observational: prints what each role gets from releases 145 (setup table) and 146 (Tolra AI).
// It asserts nothing about the outcome; the log line "ROLE-MATRIX ..." is the evidence. Needs 145 and 146 installed first.
import { afterAll, beforeAll, it } from "vitest";
import { ROLES, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, type SyntheticWorld } from "../support/fixtures";

let world: SyntheticWorld;
beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

const code = (e: { code?: string; message?: string } | null) => (e ? `${e.code ?? "error"}:${(e.message ?? "").slice(0, 60)}` : "ok");

it("role matrix on both releases (own company, and the other company's row)", async () => {
  const out: Record<string, string>[] = [];
  const own = world.tenants.alpha.id;
  const other = world.tenants.beta.id;
  for (const role of ROLES) {
    const c = await signedInClient(world.tenants.alpha.users[role]);
    const sel = await c.from("company_setup_progress").select("*").eq("organization_id", own);
    const write = await c.from("company_setup_progress").upsert({ organization_id: own, step: "company", completed: true });
    const writeOther = await c.from("company_setup_progress").upsert({ organization_id: other, step: "company", completed: true });
    const status = await c.rpc("ai_helper_status");
    const mode = await c.rpc("ai_helper_set_tolra_mode", { p_enabled: true });
    const caps = await c.rpc("ai_helper_tolra_caps");
    out.push({ role, setup_read_own: sel.error ? code(sel.error) : `ok(${sel.data?.length} rows)`, setup_write_own: code(write.error), setup_write_other_company: code(writeOther.error), ai_status: code(status.error), ai_set_tolra_mode: code(mode.error), ai_owner_caps: code(caps.error) });
  }
  console.log(`ROLE-MATRIX ${JSON.stringify(out)}`);
  console.log("ROLE-MATRIX support: not covered (needs the platform support-session flow; no fixture creates a support user)");
});
