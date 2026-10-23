#!/usr/bin/env node
/**
 * Audit SEC12: the browser bundle must not carry the test-only commercial fixture content (part numbers, document
 * references, prices) or the seed SQL. Scans every emitted file under .next/static (what anyone can download) for
 * recognisable markers. Run after `next build`: `node scripts/check-bundle.mjs [buildDir]`.
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

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

let scanned = 0;
const hits = [];
try {
  for (const path of files(root)) {
    if (!/\.(js|css|json|html|txt|map)$/.test(path)) continue;
    scanned += 1;
    const text = readFileSync(path, "utf8");
    for (const marker of MARKERS) if (text.includes(marker)) hits.push(`${path}: ${marker}`);
  }
} catch (err) {
  console.error(`[check-bundle] can't read ${root}: ${err instanceof Error ? err.message : err}. Build first.`);
  process.exit(2);
}
if (scanned === 0) {
  console.error(`[check-bundle] no files in ${root}. Build first.`);
  process.exit(2);
}
if (hits.length) {
  console.error(`[check-bundle] test-only fixture content found in the public bundle:\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log(`[check-bundle] ${scanned} public files scanned; no test-only fixture content.`);
