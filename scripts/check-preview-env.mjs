#!/usr/bin/env node
/**
 * Preview isolation check (release validation). Reads the Preview environment of the Vercel project, pulled with
 *   vercel env pull --environment=preview --git-branch=<preview branch> .env.preview.check
 * and refuses it unless the preview can only reach the separate TEST Supabase project and can't send real e-mail:
 *
 *   node scripts/check-preview-env.mjs .env.preview.check --test-ref <test project ref> --protected-ref <prod ref> [--protected-ref <legacy ref>]
 *     [--production-env <pulled production env file>]
 *
 * Prints PASS, FAIL or MANUAL per check. MANUAL = the file can't prove it (an opaque sb_ key carries no project ref):
 * isolation is NOT proven until someone records evidence for that line (the key shown in the test project's API
 * settings). Exit 0 = all PASS; 1 = any FAIL; 3 = no FAIL but MANUAL lines remain. Reads the file only; contacts nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return env;
}

/** The project ref inside a legacy Supabase JWT key ("ref" claim), or null for opaque sb_ keys. */
function keyRef(key) {
  const parts = String(key || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).ref ?? null;
  } catch {
    return null;
  }
}

function urlRef(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : null;
  } catch {
    return null;
  }
}

/**
 * [{ status: "pass" | "fail" | "manual", ok, check, detail }] for an environment, the expected test ref and the refs that must never appear.
 * productionEnv (optional, parsed): to prove the Preview's integrations key (migration 084, Xero) is not Production's, and that
 * Production sets NEXT_PUBLIC_SITE_URL (password reset e-mails are refused there without it).
 * @param {Record<string, string>} env
 * @param {string | undefined} testRef
 * @param {string[]} protectedRefs
 * @param {Record<string, string> | null} [productionEnv]
 */
export function previewChecks(env, testRef, protectedRefs, productionEnv = null) {
  const results = [];
  const add = (ok, check, detail) => results.push({ status: ok ? "pass" : "fail", ok, check, detail });
  const manual = (check, detail) => results.push({ status: "manual", ok: false, check, detail });
  const ref = urlRef(env.NEXT_PUBLIC_SUPABASE_URL);
  add(Boolean(testRef) && ref === testRef, "NEXT_PUBLIC_SUPABASE_URL is the test project", `ref ${ref ?? "unknown"}, expected ${testRef || "(no --test-ref given)"}`);
  const everything = Object.values(env).join("\n");
  const leaked = protectedRefs.filter((p) => p && everything.includes(p));
  add(protectedRefs.length > 0 && leaked.length === 0, "no protected (production/legacy) project ref anywhere in the preview environment", leaked.length ? `found ${leaked.join(", ")}` : `${protectedRefs.length} refs checked`);
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const kRef = keyRef(env[name]);
    if (!env[name]) add(false, `${name} is set`, "missing");
    else if (kRef === null) manual(`${name} belongs to the test project`, "opaque key: ownership can't be read from it. Compare it with the key shown in the TEST project's Settings > API and record that check");
    else add(kRef === testRef, `${name} belongs to the test project`, `ref ${kRef}`);
  }
  add(!env.RESEND_API_KEY, "RESEND_API_KEY is not set (job e-mails are saved as drafts, nothing is sent)", env.RESEND_API_KEY ? "set: remove it from the Preview environment" : "unset");
  const domains = (env.EMAIL_RECIPIENT_DOMAINS || "").split(",").map((d) => d.trim()).filter(Boolean);
  add(domains.every((d) => /(^|\.|@)(example\.(test|com|org|net)|test|invalid)$/i.test(d)), "EMAIL_RECIPIENT_DOMAINS allows only reserved test domains (or is empty)", domains.join(", ") || "empty");
  add(!env.COSTING_ENGINE_URL && !env.COSTING_ENGINE_TOKEN, "costing engine is not configured", env.COSTING_ENGINE_URL ? "set: remove it from the Preview environment" : "unset");
  let siteHost = "";
  try { siteHost = env.NEXT_PUBLIC_SITE_URL ? new URL(env.NEXT_PUBLIC_SITE_URL).hostname : ""; } catch { siteHost = "invalid"; }
  add(!siteHost || siteHost.endsWith(".vercel.app"), "NEXT_PUBLIC_SITE_URL is unset or a vercel.app preview address (auth e-mail links never point at the live site)", env.NEXT_PUBLIC_SITE_URL || "unset");
  add(env.NEXT_PUBLIC_DEMO_MODE !== "true", "demo mode is off (the preview shows only the test project's data)", env.NEXT_PUBLIC_DEMO_MODE || "unset");
  // 084 (Xero): the Preview must never hold Production's token encryption key (Lot B §2.5). Only checked when the Preview sets one.
  if (env.INTEGRATIONS_ENCRYPTION_KEY) {
    if (!productionEnv) manual("INTEGRATIONS_ENCRYPTION_KEY is not Production's", "pass --production-env <file> to compare, or compare the two values by hand and record it");
    else add(env.INTEGRATIONS_ENCRYPTION_KEY !== productionEnv.INTEGRATIONS_ENCRYPTION_KEY, "INTEGRATIONS_ENCRYPTION_KEY is not Production's", env.INTEGRATIONS_ENCRYPTION_KEY === productionEnv.INTEGRATIONS_ENCRYPTION_KEY ? "the same value: set a different key in Preview" : "different");
  }
  // S1/C8: in Production the reset e-mail's link comes only from NEXT_PUBLIC_SITE_URL (lib/auth-links.ts); unset, no reset e-mail is sent.
  if (productionEnv) {
    let prodSite = false;
    try { prodSite = Boolean(productionEnv.NEXT_PUBLIC_SITE_URL && new URL(productionEnv.NEXT_PUBLIC_SITE_URL).hostname); } catch { prodSite = false; }
    add(prodSite, "Production NEXT_PUBLIC_SITE_URL is set (auth e-mail links come only from it)", productionEnv.NEXT_PUBLIC_SITE_URL || "unset");
  }
  return results;
}

function argValues(args, flag) {
  return args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node scripts/check-preview-env.mjs <env file> --test-ref <ref> --protected-ref <ref> [--protected-ref <ref>]");
    process.exit(2);
  }
  const productionFile = argValues(rest, "--production-env")[0];
  const results = previewChecks(parseEnv(readFileSync(file, "utf8")), argValues(rest, "--test-ref")[0], argValues(rest, "--protected-ref"),
    productionFile ? parseEnv(readFileSync(productionFile, "utf8")) : null);
  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(6)} ${r.check}  (${r.detail})`);
  const failed = results.filter((r) => r.status === "fail").length;
  const manualLeft = results.filter((r) => r.status === "manual").length;
  if (failed) console.log(`\n${failed} check(s) failed: fix the Preview environment before deploying.`);
  else if (manualLeft) console.log(`\nNo failures, but ${manualLeft} check(s) need manual verification. Isolation is NOT proven until that evidence is recorded.`);
  else console.log("\nAll checks passed.");
  process.exit(failed ? 1 : manualLeft ? 3 : 0);
}
