#!/usr/bin/env node
/**
 * Audit SEC12: the browser bundle must not carry the test-only commercial fixture content (part numbers, document
 * references, prices) or the seed SQL. Scans every emitted file under .next/static (what anyone can download) for
 * recognisable markers. Run after `next build`: `node scripts/check-bundle.mjs [buildDir]`.
 *
 * Audit S3: it must not carry a server secret either. Fails on
 *  - a read of a server-only variable (`process.env.SUPABASE_SERVICE_ROLE_KEY`, `env["CRON_SECRET"]`, any `AI_*`...): Next
 *    inlines only NEXT_PUBLIC_* into browser code, so such a read means server code was bundled for the browser;
 *  - the VALUE of any of the named secrets (or an AI_*KEY / SECRET / TOKEN / PASS variable) that is set in the build's
 *    environment (8 characters or more);
 *  - a JWT whose payload says `"role":"service_role"` (the Supabase service-role key, whatever it is called).
 * The bare NAME in text is allowed: a client message may say "RESEND_API_KEY is not set" (lib/alert-test-message.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(process.argv[2] || ".next", "static");
const MARKERS = [
  // fixture part numbers and descriptions
  "PN-100", "PN-101", "PN-102", "PN-103", "PN-104", "PN-105", "PN-106",
  "Turned bush, EN8", "Milled bracket, 6082-T6", "Milled housing, 6082-T6", "Threaded stud, A4-80", "Bead blast and anodise",
  // fixture document references and customers' order numbers
  "QUO-0101", "QUO-0102", "INV-0101", "INV-0102", "DLN-0101", "DLN-0102", "J-0101", "J-0102", "PO-TEST-1", "PO-TEST-2",
  // fixture totals and distinctive prices
  "3617.71", "723.55", "4341.26", "1989.82", "397.96", "2387.78", "42.49", "310.4",
  // the seed and import SQL
  "jnr_test_data", "import_legacy_tenant",
];

// Server-only variables (lib/server, app/api, scripts): never public. Any AI_* variable is treated the same.
const SECRET_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "INTEGRATIONS_ENCRYPTION_KEY", "XERO_CLIENT_SECRET", "CRON_SECRET",
  "BACKUP_PASSPHRASE", "COSTING_ENGINE_TOKEN", "MS_CLIENT_SECRET",
];
const isSecretName = (name) => SECRET_NAMES.includes(name) || /^AI_[A-Z0-9_]+$/.test(name);
const ENV_READ = /\benv(?:\.|\[\s*["'`])([A-Z][A-Z0-9_]*)/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]*/g;
// Values: the named secrets, and an AI_* variable only when its name says it holds one (AI_HELPER_PROVIDER=anthropic is a
// setting, and that word may well appear in the bundle).
const holdsSecret = (name) => SECRET_NAMES.includes(name) || (/^AI_/.test(name) && /KEY|SECRET|TOKEN|PASS/.test(name));
const secretValues = Object.entries(process.env)
  .filter(([name, value]) => holdsSecret(name) && typeof value === "string" && value.trim().length >= 8)
  .map(([name, value]) => [name, value.trim()]);

function jwtRole(payload) {
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role;
  } catch {
    return undefined;
  }
}

/** Every secret finding in one file's text (never the value itself: a CI log must not print the secret it caught). */
function secretHits(text) {
  const found = [];
  for (const match of text.matchAll(ENV_READ)) if (isSecretName(match[1])) found.push(`reads server-only variable ${match[1]}`);
  for (const [name, value] of secretValues) if (text.includes(value)) found.push(`value of ${name}`);
  for (const match of text.matchAll(JWT)) if (jwtRole(match[1]) === "service_role") found.push("a service_role JWT");
  return [...new Set(found)];
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

let scanned = 0;
const hits = [];
const secrets = [];
try {
  for (const path of files(root)) {
    if (!/\.(js|css|json|html|txt|map)$/.test(path)) continue;
    scanned += 1;
    const text = readFileSync(path, "utf8");
    for (const marker of MARKERS) if (text.includes(marker)) hits.push(`${path}: ${marker}`);
    for (const hit of secretHits(text)) secrets.push(`${path}: ${hit}`);
  }
} catch (err) {
  console.error(`[check-bundle] can't read ${root}: ${err instanceof Error ? err.message : err}. Build first.`);
  process.exit(2);
}
if (scanned === 0) {
  console.error(`[check-bundle] no files in ${root}. Build first.`);
  process.exit(2);
}
if (hits.length) console.error(`[check-bundle] test-only fixture content found in the public bundle:\n  ${hits.join("\n  ")}`);
if (secrets.length) console.error(`[check-bundle] server secret found in the public bundle:\n  ${secrets.join("\n  ")}`);
if (hits.length || secrets.length) process.exit(1);
console.log(`[check-bundle] ${scanned} public files scanned; no test-only fixture content, no server secret (${secretValues.length} secret values from this environment checked).`);
