#!/usr/bin/env node
/**
 * Capacity check (docs/MONITORING.md): how full are the database and the file storage against the plan's limits?
 * READ ONLY: one read-only transaction with two SELECTs (database size, total size of stored files). Prints a line per
 * figure and exits 1 when either is at or over the threshold (default 80%), which the scheduled workflow turns into an
 * issue. Never prints data.
 *
 *   CAPACITY_DB_URL=postgresql://readonly:...@host:5432/postgres node scripts/capacity-check.mjs
 *
 *   DB_LIMIT_MB          database limit of the plan (default 500: Supabase Free; Pro includes 8192)
 *   STORAGE_LIMIT_MB     file storage limit (default 1024: Supabase Free; Pro includes 102400)
 *   CAPACITY_THRESHOLD   percent that raises the alert (default 80)
 *   --dry-run            use only the limits and the sizes in DRY_RUN_DB_BYTES / DRY_RUN_STORAGE_BYTES, no database
 */
import { fileURLToPath } from "node:url";

const MB = 1024 * 1024;

/** Pure: percentages and which figures are over the threshold. */
export function evaluateCapacity({ dbBytes, storageBytes, dbLimitMb = 500, storageLimitMb = 1024, threshold = 80 }) {
  const figure = (name, bytes, limitMb) => {
    const percent = limitMb > 0 ? (bytes / (limitMb * MB)) * 100 : 100;
    return { name, usedMb: Math.round((bytes / MB) * 10) / 10, limitMb, percent: Math.round(percent * 10) / 10, over: percent >= threshold };
  };
  const figures = [figure("database", dbBytes, dbLimitMb), figure("storage", storageBytes, storageLimitMb)];
  return { figures, alert: figures.some((f) => f.over), threshold };
}

export function summaryLines(result) {
  return result.figures.map((f) => `${f.name}: ${f.usedMb} MB of ${f.limitMb} MB (${f.percent}%)${f.over ? ` - OVER ${result.threshold}%` : ""}`);
}

const number = (value, fallback) => (value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : fallback);

async function sizes(url) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const db = await client.query("SELECT pg_database_size(current_database())::bigint AS bytes");
    // Stored files (drawings, attachments, logos): the size recorded by Storage for each object.
    const files = await client.query("SELECT coalesce(sum((metadata ->> 'size')::bigint), 0)::bigint AS bytes FROM storage.objects");
    await client.query("ROLLBACK");
    return { dbBytes: Number(db.rows[0].bytes), storageBytes: Number(files.rows[0].bytes) };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const limits = { dbLimitMb: number(env.DB_LIMIT_MB, 500), storageLimitMb: number(env.STORAGE_LIMIT_MB, 1024), threshold: number(env.CAPACITY_THRESHOLD, 80) };
  try {
    const measured = process.argv.includes("--dry-run")
      ? { dbBytes: number(env.DRY_RUN_DB_BYTES, 0), storageBytes: number(env.DRY_RUN_STORAGE_BYTES, 0) }
      : await sizes(env.CAPACITY_DB_URL || (() => { throw new Error("CAPACITY_DB_URL is not set"); })());
    const result = evaluateCapacity({ ...measured, ...limits });
    for (const line of summaryLines(result)) console.log(line);
    process.exit(result.alert ? 1 : 0);
  } catch (err) {
    // Could not measure: also a failure (the workflow reports it), but a different exit code from "over the limit".
    console.error(`capacity check could not run: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exit(2);
  }
}
