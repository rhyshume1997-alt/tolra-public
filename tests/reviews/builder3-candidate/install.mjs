import { applyFile, connect, marker, phases, read, save, schema, sha256, verify } from './common.mjs';
const db = await connect();
const rows = [];
try {
  for (const phase of phases) {
    try {
      if (await marker(db, phase) !== 'applied') applyFile(phase.release);
      rows.push({ release: phase.number, status: 'PASS', verifyRows: await verify(db, phase), fileSha256: sha256(read(phase.release)), schemaSha256: (await schema(db)).sha256 });
    } catch (e) {
      await db.query('ROLLBACK');
      rows.push({ release: phase.number, status: 'FAIL', sqlstate: e.code, error: e.stderr?.toString() || e.message });
    }
  }
  await db.query("NOTIFY pgrst, 'reload schema'");
  save('install', { rows });
  console.log(rows);
  if (rows.some(r => r.status !== 'PASS')) process.exitCode = 1;
} finally { await db.end(); }
