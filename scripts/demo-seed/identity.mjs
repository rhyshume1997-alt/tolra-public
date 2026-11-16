/** Read-only identity proof. A loopback URL alone is never evidence of a disposable database. */
import { DEMO_NAME, DEMO_SLUG } from './plan.mjs';
export async function assertDisposableIdentity(db, nonce) {
  if (typeof nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce))
    throw new Error('Refusing: DEMO_DISPOSABLE_ID from the disposable marker step is required.');
  const marker = await db.query("SELECT to_regclass('demo_seed_guard.identity') AS marker");
  if (!marker.rows[0]?.marker) throw new Error('Refusing: disposable database identity marker is missing.');
  const proof = await db.query(`SELECT current_user = 'postgres' AS owner,
    database_name = current_database() AS database_matches,
    disposable_id = $1::uuid AS nonce_matches, expires_at > clock_timestamp() AS fresh
    FROM demo_seed_guard.identity WHERE singleton`, [nonce]);
  const row = proof.rows[0];
  if (proof.rows.length !== 1 || !row.owner || !row.database_matches || !row.nonce_matches || !row.fresh)
    throw new Error('Refusing: disposable identity is expired, mismatched or not owned by postgres.');
  const companies = await db.query(`SELECT count(*)::int AS foreign_companies FROM public.organizations
    WHERE slug IS DISTINCT FROM $1 OR name IS DISTINCT FROM $2`, [DEMO_SLUG, DEMO_NAME]);
  if (companies.rows[0]?.foreign_companies !== 0)
    throw new Error('Refusing: database holds a company other than Tolra Demo.');
}
