// Go-live smoke, SMOKE 2: the smoke company, made on the fresh disposable stack BEFORE the post-144 releases (as JNR exists before
// them), so release 147 holds it exactly as it will hold JNR. Made through the same service-role paths as the browser suite's
// synthetic world (tests/support/fixtures.ts createSyntheticWorld): Auth admin createUser, create_organization, add_member, Sales
// Orders switched on. Synthetic only: the slug starts "t-" (tests/support/isolation.ts SYNTHETIC_SLUG_PREFIX), every e-mail is
// @example.test, the passwords are random and live only in the evidence directory of this runner.
//
//   node scripts/golive-smoke/seed-company.mjs <out tenant.json>
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const out = process.argv[2];
if (!out) throw new Error("usage: seed-company.mjs <out tenant.json>");

const env = Object.fromEntries(readFileSync(".env.test.local", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
for (const key of ["TEST_SUPABASE_URL", "TEST_DATABASE_URL"]) {
  const host = new URL(env[key]).hostname;
  if (host !== "127.0.0.1") throw new Error(`Refusing: ${key} is ${host}, not the local disposable stack`);
}

const ROLES = ["admin", "office", "workshop", "viewer"];
const run = randomBytes(4).toString("hex");
const slug = `t-golive-${run}`;
const name = `Golive Smoke Engineering ${run}`;
// 14 characters, a letter and a digit (lib/password.ts rules), no look-alikes.
const LETTERS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const password = () => [LETTERS[randomInt(LETTERS.length)], String(2 + randomInt(8)), ...Array.from({ length: 12 }, () => (LETTERS + "23456789")[randomInt(LETTERS.length + 8)])].join("");

const admin = createClient(env.TEST_SUPABASE_URL, env.TEST_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new pg.Client({ connectionString: env.TEST_DATABASE_URL });
await db.connect();
try {
  const before = Number((await db.query("select count(*)::int n from public.organizations")).rows[0].n);
  const users = {};
  for (const role of ROLES) {
    const email = `${role}.golive.${run}@example.test`;
    const pw = password();
    const { data, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { full_name: `${role[0].toUpperCase()}${role.slice(1)} smoke` } });
    if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
    users[role] = { id: data.user.id, email, password: pw, role };
  }
  const profile = {
    documentName: name, addressLines: ["Unit 9, Smoke Estate", "Testtown", "TE9 9ST"], phone: "01000 000009", email: `office.golive.${run}@example.test`,
    vatRegistered: true, vatNumber: "GB 000 0000 00", defaultVatRate: 20, brandedLogin: false, loginTagline: `Synthetic go-live smoke ${run}.`,
  };
  const { data: orgId, error } = await admin.rpc("create_organization", { p_name: name, p_slug: slug, p_admin_email: users.admin.email, p_company_profile: profile });
  if (error || typeof orgId !== "string") throw new Error(`create_organization ${slug}: ${error?.message}`);
  for (const role of ROLES.filter((r) => r !== "admin")) {
    const { data, error: addError } = await admin.rpc("add_member", { p_org: orgId, p_email: users[role].email, p_role: role });
    if (addError || data !== "member") throw new Error(`add_member ${role}: ${addError?.message ?? data}`);
  }
  // As createSyntheticWorld: the admin is an authorised inspector (083) and Sales Orders is on (lib/sales-orders-switch).
  const { error: inspectError } = await admin.from("organization_members").update({ can_inspect: true }).eq("organization_id", orgId).eq("user_id", users.admin.id);
  if (inspectError) throw new Error(`inspector: ${inspectError.message}`);
  const on = await db.query("update public.organization_settings set hidden_nav = array_append(array_remove(array_remove(hidden_nav, 'sales-orders'), 'sales-orders:on'), 'sales-orders:on') where organization_id = $1", [orgId]);
  if (on.rowCount !== 1) throw new Error("no organization_settings row for the smoke company");
  const after = Number((await db.query("select count(*)::int n from public.organizations")).rows[0].n);
  writeFileSync(out, JSON.stringify({ id: orgId, slug, name, run, users }, null, 2), { mode: 0o600 });
  console.log(`smoke company ${slug} (${orgId}): ${ROLES.length} users (${ROLES.join(", ")}); companies ${before} -> ${after}`);
} finally {
  await db.end();
}
