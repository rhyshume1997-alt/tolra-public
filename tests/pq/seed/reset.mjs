/**
 * Removes exactly what the PQ seeder made, and nothing else. Marker-tagged on three independent axes, all of which must hold:
 *   organisation slug  ^t-<8 hex>-(jnr|practice)$        (the t- prefix is the repo's SYNTHETIC_SLUG_PREFIX)
 *   organisation name  ^Synthetic (JNR|Practice) PQ <same 8 hex>$
 *   auth user e-mail   ^(admin|office|workshop|viewer)<n>.(jnr|practice).<same 8 hex>@example.test$
 * Same method as destroySyntheticWorld (tests/support/fixtures.ts): replica mode in one transaction so rows go in any order, then
 * the auth users with triggers back on. Callers run verifyDisposableIdentity first (cli.mjs does).
 */
const SLUG_RE = /^t-([0-9a-f]{8})-(jnr|practice)$/;

export async function findPqRuns(db) {
  const { rows } = await db.query("select id, slug, name from public.organizations where slug ~ '^t-[0-9a-f]{8}-(jnr|practice)$' order by slug");
  const runs = new Map();
  for (const r of rows) {
    const m = SLUG_RE.exec(r.slug);
    const nameOk = new RegExp(`^Synthetic (JNR|Practice) PQ ${m[1]}$`).test(r.name);
    if (!nameOk) continue; // slug looks like ours but the name does not: leave it alone
    if (!runs.has(m[1])) runs.set(m[1], []);
    runs.get(m[1]).push(r.id);
  }
  return runs;
}

async function tenantTables(db) {
  const { rows } = await db.query(`
    select c.table_schema as schema, c.table_name as table
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.column_name = 'organization_id' and c.table_schema in ('public', 'security_audit')
    order by 1, 2`);
  return rows;
}

const USER_RE = "^(admin|office|workshop|viewer)[0-9]+\\.(jnr|practice)\\.([0-9a-f]{8})@example\\.test$";

/** Run ids with an organisation OR with a PQ-pattern user (a load that failed before its company was created leaves users only). */
async function allRuns(db) {
  const runs = await findPqRuns(db);
  const users = await db.query("select distinct substring(email from $1) as id from auth.users where email ~ $2", ["\\.([0-9a-f]{8})@example\\.test$", USER_RE]);
  for (const { id } of users.rows) if (!runs.has(id)) runs.set(id, []);
  return runs;
}

export async function resetPqData(db, { runId = null } = {}) {
  const runs = await allRuns(db);
  const removed = { runs: 0, organizations: 0, users: 0 };
  for (const [id, orgIds] of runs) {
    if (runId && id !== runId) continue;
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      for (const { schema, table } of await tenantTables(db)) await db.query(`delete from "${schema}"."${table}" where organization_id = any($1::uuid[])`, [orgIds]);
      removed.organizations += (await db.query("delete from public.organizations where id = any($1::uuid[])", [orgIds])).rowCount;
      await db.query("set local session_replication_role = origin");
      removed.users += (await db.query("delete from auth.users where email ~ $1", [`^(admin|office|workshop|viewer)[0-9]+\\.(jnr|practice)\\.${id}@example\\.test$`])).rowCount;
      await db.query("commit");
      removed.runs += 1;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  }
  return removed;
}

/** Rows still owned by PQ organisations / PQ-pattern users (empty object = clean). */
export async function pqLeftovers(db) {
  const left = {};
  const runs = await findPqRuns(db);
  const orgIds = [...runs.values()].flat();
  if (orgIds.length) {
    left["public.organizations"] = orgIds.length;
    for (const { schema, table } of await tenantTables(db)) {
      const { rows } = await db.query(`select count(*)::int as n from "${schema}"."${table}" where organization_id = any($1::uuid[])`, [orgIds]);
      if (rows[0].n) left[`${schema}.${table}`] = rows[0].n;
    }
  }
  const users = await db.query("select count(*)::int as n from auth.users where email ~ $1", [USER_RE]);
  if (users.rows[0].n) left["auth.users"] = users.rows[0].n;
  return left;
}
