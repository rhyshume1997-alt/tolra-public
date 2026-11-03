/** Disposable-browser fixture only. Never imported by application code; the caller must prove backend identity first. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
const proposal = readFileSync(path.resolve(__dirname, "../../supabase/proposals/builder2_chase_settings_atomic.sql"), "utf8");
const signature = "public.save_chase_steps_atomic(uuid,jsonb,jsonb)";
const body = proposal.match(/AS \$\$([\s\S]*?)\$\$;/)?.[1];
if (!body) throw new Error("Reviewed chase proposal body is missing.");
const expected = createHash("md5").update(body.replace(/\s/g, "")).digest("hex");
type Row = { oid: string; hash: string; invoker: boolean; pinned: boolean; allowed: boolean; anonymous: boolean };
const inspect = `SELECT oid::text AS oid,md5(regexp_replace(prosrc,'\\s','','g')) AS hash,NOT prosecdef AS invoker,
 proconfig=ARRAY['search_path=pg_catalog, public'] AS pinned,
 has_function_privilege('authenticated',oid,'EXECUTE') AS allowed,has_function_privilege('anon',oid,'EXECUTE') AS anonymous
 FROM pg_proc WHERE oid=to_regprocedure($1)`;
export async function prepareChaseBrowserProposal(deps: {
  verify: () => Promise<unknown>;
  query: (sql: string, args?: unknown[]) => Promise<{ rows: Row[] }>;
}) {
  await deps.verify(); // no read or write before the existing loopback/project identity guard
  const read = async () => (await deps.query(inspect, [signature])).rows[0];
  const valid = (row: Row) => row.hash === expected && row.invoker && row.pinned && row.allowed && !row.anonymous && /^\d+$/.test(row.oid);
  const existing = await read();
  if (existing) {
    if (!valid(existing)) throw new Error("Existing chase atomic save differs from the reviewed proposal; refusing to replace it.");
    return async () => undefined;
  }
  // One statement batch/connection: failure before COMMIT leaves no partial definition.
  await deps.query(`BEGIN;\n${proposal}\nNOTIFY pgrst, 'reload schema';\nCOMMIT;`);
  const created = await read();
  if (!created || !valid(created)) throw new Error("Could not verify the browser-only chase save fixture.");
  return async () => {
    await deps.verify();
    const current = await read();
    if (!current || current.oid !== created.oid || !valid(current)) throw new Error("Chase fixture changed; refusing to remove another definition.");
    await deps.query(`BEGIN; DROP FUNCTION public.save_chase_steps_atomic(uuid,jsonb,jsonb); NOTIFY pgrst, 'reload schema'; COMMIT;`);
  };
}
