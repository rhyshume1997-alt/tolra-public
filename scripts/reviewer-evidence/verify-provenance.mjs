// Offline evidence integrity gate. Profile "prod" means synthetic production-shaped data, never a production endpoint.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
function requireThat(ok, field) { if (!ok) throw new Error(`Invalid or missing provenance: ${field}`); }
export function verifyProvenance(manifests, expectedSha, baseDirectory) {
  requireThat(sha.test(expectedSha), "expected checkout SHA");
  requireThat(Array.isArray(manifests) && manifests.length > 0, "manifest population");
  const profiles = new Set(); const ids = new Set();
  for (const m of manifests) {
    requireThat(typeof m.artifact_id === "string" && m.artifact_id.trim() && !ids.has(m.artifact_id), "unique artifact ID");ids.add(m.artifact_id);
    requireThat(["prod", "realistic", "x100"].includes(m.profile), "profile");profiles.add(m.profile);
    requireThat(m.synthetic_only === true, "synthetic-only declaration");
    requireThat(m.checkout_sha === expectedSha && m.executed_sha === expectedSha, "exact executed/checkout SHA");
    requireThat(m.exit_code === 0, "actual command exit code");
    requireThat(typeof m.environment === "string" && m.environment.trim(), "environment identity");
    requireThat(digest.test(m.sql_sha256), "SQL hash");
    const start=Date.parse(m.start_utc),end=Date.parse(m.end_utc);
    requireThat(Number.isFinite(start) && Number.isFinite(end) && end>=start, "ordered run times");
    requireThat(Number.isInteger(m.total) && m.total>0 && m.passed===m.total && m.failed===0 && m.skipped===0 && m.todo===0, "nonempty complete results");
    requireThat(m.identity?.kind === "disposable" && typeof m.identity.nonce === "string" && m.identity.nonce.length >= 16 && digest.test(m.identity.image_digest) && typeof m.identity.container_id === "string" && m.identity.container_id.length===64, "disposable attestation");
    requireThat(typeof m.log_path === "string" && m.log_path.length>0 && digest.test(m.log_sha256), "log reference/hash");
    const bytes=readFileSync(resolve(baseDirectory,m.log_path));
    requireThat(createHash("sha256").update(bytes).digest("hex")===m.log_sha256, "retained log bytes");
  }
  requireThat(["prod","realistic","x100"].every(p=>profiles.has(p)), "all three profiles");
  return { verified_artifacts: manifests.length, profiles: [...profiles].sort(), checkout_sha: expectedSha };
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const file=resolve(process.argv[2]);
  console.log(JSON.stringify(verifyProvenance(JSON.parse(readFileSync(file,"utf8")),process.argv[3],dirname(file))));
}
