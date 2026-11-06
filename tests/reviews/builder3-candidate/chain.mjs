import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { applyFile, connect, marker, phases, read, save, schema, sha256, verify } from './common.mjs';

const profile = process.argv[2];
assert.ok(['empty', 'populated'].includes(profile));
let db = await connect();
const rows = [];
const firstHashes = {};
const manifest = phases.map(p => ({ number: p.number, files: Object.fromEntries([p.release, p.verify, p.rollback].map(f => [f, sha256(read(f))])) }));
let legacyColumns = {};
let legacy = {};
const emit = () => save(`chain-${profile}`, { profile, rows, fileHashes: manifest, firstHashes, totals: { passed: rows.filter(r => r.status === 'PASS').length, failed: rows.filter(r => r.status === 'FAIL').length, skipped: 0 } });
async function check(name, fn) {
  try { rows.push({ name, status: 'PASS', ...await fn() }); }
  catch (e) {
    await db?.query('ROLLBACK').catch(() => {});
    rows.push({ name, status: 'FAIL', sqlstate: e.code, error: e.stderr?.toString() || e.stack || e.message });
  }
  console.log(rows.at(-1)); emit();
}
async function seed() {
  assert.equal((await db.query('SELECT count(*)::int n FROM public.organizations')).rows[0].n, 0);
  if (profile === 'populated') {
    for (const label of ['A', 'B']) {
      const id = randomUUID();
      await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `FAKE Builder3 ${label}`, `t-b3-chain-${id}`]);
      await db.query('INSERT INTO public.customers(organization_id,name,email) VALUES($1,$2,$3)', [id, `FAKE customer ${label}`, `fake-${label}@example.test`]);
      const job = (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,description,stage) VALUES($1,$2,$3,'FAKE legacy bracket','machining') RETURNING id", [id, `J-FAKE-${label}`, `FAKE customer ${label}`])).rows[0].id;
      await db.query("INSERT INTO public.invoices(organization_id,invoice_ref,customer,job_id,subtotal,vat,total,status) VALUES($1,$2,$3,$4,125.00,25.00,150.00,'draft')", [id, `INV-FAKE-${label}`, `FAKE customer ${label}`, job]);
      await db.query("INSERT INTO public.delivery_notes(organization_id,dn_number,customer,job_ref,status) VALUES($1,$2,$3,$4,'awaiting')", [id, `DLN-FAKE-${label}`, `FAKE customer ${label}`, `J-FAKE-${label}`]);
    }
  }
  legacyColumns = {};
  for (const table of ['organizations', 'customers', 'jobs', 'invoices', 'delivery_notes']) {
    legacyColumns[table] = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map(r => r.column_name);
  }
  legacy = await fingerprint();
  return { organizations: profile === 'empty' ? 0 : 2, preservedTables: Object.keys(legacyColumns) };
}
async function fingerprint() {
  const out = {};
  for (const [table, columns] of Object.entries(legacyColumns)) {
    const json = (await db.query(`SELECT (SELECT jsonb_object_agg(k,v) FROM jsonb_each(to_jsonb(t)) e(k,v) WHERE k=ANY($1)) j FROM public.${table} t ORDER BY id`, [columns])).rows;
    out[table] = { count: json.length, sha256: sha256(JSON.stringify(json)) };
  }
  return out;
}
try {
  await check('baseline: empty disposable database with numbered migrations through 144 only', async () => {
    assert.equal((await db.query('SELECT count(*)::int n FROM public.organizations')).rows[0].n, 0);
    for (const p of phases) assert.equal(await marker(db, p), 'not applied');
    return { schemaSha256: (await schema(db)).sha256 };
  });
  await check('seed clearly synthetic legacy rows before any 145..151 installation', seed);
  for (const p of phases) await check(`install ${p.number}: verification, marker, schema hash and legacy row preservation`, async () => {
    applyFile(p.release);
    const verifyRows = await verify(db, p);
    assert.deepEqual(await fingerprint(), legacy);
    const catalogue = await schema(db);
    firstHashes[p.number] = catalogue.sha256;
    save(`schema-${profile}-${p.number}`, catalogue);
    return { verifyRows, schemaSha256: catalogue.sha256 };
  });
  for (const p of phases) await check(`duplicate ${p.number} installation refuses without schema or legacy-row changes`, async () => {
    const before = (await schema(db)).sha256;
    let error;
    try { await db.query(read(p.release)); } catch (e) { error = e; await db.query('ROLLBACK'); }
    assert.ok(error, 'Duplicate installation unexpectedly succeeded');
    assert.equal((await schema(db)).sha256, before);
    assert.deepEqual(await fingerprint(), legacy);
    return { refusalSqlstate: error.code, refusal: error.message };
  });
  for (const p of [...phases].reverse()) {
    if (p.number === 147 && profile === 'populated') await check('147 populated rollback refuses while its pre-existing companies are held, without changes', async () => {
      const before = (await schema(db)).sha256;
      let error;
      try { await db.query(read(p.rollback)); } catch (e) { error = e; await db.query('ROLLBACK'); }
      assert.equal(error?.code, 'P0001');
      assert.match(error.message, /^147 rollback refused: a company is still held/);
      assert.equal((await schema(db)).sha256, before);
      assert.deepEqual(await fingerprint(), legacy);
      // Disposable eligibility transition only: this is the row deletion performed by the reviewed cutover counter scripts.
      await db.query('DELETE FROM public.dln_numbering_pending');
      return { refusalSqlstate: error.code, refusal: error.message, eligibility: 'FAKE companies only: holds explicitly cleared before eligible rollback' };
    });
    await check(`eligible rollback ${p.number}: marker removed and legacy rows preserved`, async () => {
      applyFile(p.rollback);
      assert.equal(await marker(db, p), 'not applied');
      assert.deepEqual(await fingerprint(), legacy);
      return { schemaSha256: (await schema(db)).sha256 };
    });
  }
  await check('146 cannot be reinstalled after rollback, even with 145 restored', async () => {
    applyFile(phases.find(p => p.number === 145).release);
    const before = (await schema(db)).sha256;
    let error;
    try { await db.query(read(phases.find(p => p.number === 146).release)); } catch (e) { error = e; await db.query('ROLLBACK'); }
    assert.ok(error, '146 reinstall was accepted without resetting the disposable database');
    assert.equal(error.code, '42701');
    assert.match(error.message, /column "key_source".*already exists/i);
    assert.equal((await schema(db)).sha256, before);
    return { refusalSqlstate: error.code, refusal: error.message };
  });
  await check('reset the disposable backend before any full reinstall; never erase the 146 sentinel in place', async () => {
    await db.end(); db = null;
    execFileSync('scripts/test-backend.sh', ['reset'], { stdio: 'inherit' });
    db = await connect();
    return seed();
  });
  for (const p of phases) await check(`reinstall ${p.number} after full reset: verify, preserve data, compare complete schema hash`, async () => {
    applyFile(p.release);
    const verifyRows = await verify(db, p);
    assert.deepEqual(await fingerprint(), legacy);
    const actual = (await schema(db)).sha256;
    assert.equal(actual, firstHashes[p.number], `${p.number}: schema differs after full reset and reinstall`);
    return { verifyRows, schemaSha256: actual };
  });
  if (rows.some(r => r.status !== 'PASS')) process.exitCode = 1;
} finally { emit(); await db?.end(); }
