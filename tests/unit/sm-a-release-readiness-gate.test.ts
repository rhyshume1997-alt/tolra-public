import { describe, expect, it } from "vitest";

import { INVOICE_STATUS_ALLOWLIST, REQUIRED_MARKERS, VERIFY_RELEASES, assertDatabaseUrlAllowed, assertSelectOnly, decide, formatReport, parseArgs, splitSections } from "../../scripts/release-readiness-gate.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const markerRows = () => REQUIRED_MARKERS.map((m: { n: string }) => ({
  check: Number(m.n) >= 145 ? `post-144 marker ${m.n} thing` : `marker ${m.n} thing`,
  value: "applied",
  expected: "x",
}));
const green = (): Any => ({
  preflight: { status: "ok", rows: markerRows() },
  verify: Object.fromEntries(VERIFY_RELEASES.map((n: string) => [n, { status: "ok", sets: [[{ check_name: "a", ok: true }, { check_name: "b", ok: true }]] }])),
  dln: { status: "ok", rows: [{ org_found: 1, counter_set: 1, hold_released: 0, counter_undone: 0, jnr_pending: 0, other_held_count: 1, other_held: "acme" }] },
  mfa: { status: "ok", rows: [{ company: "jnr", flag_on: true, admins: 2, with_factor: 2 }] },
  vercel: { crons: [{ path: "/api/cron/daily", schedule: "0 5 * * *" }, { path: "/api/cron/nightly", schedule: "0 22 * * *" }] },
  xero_hold: { status: "ok", rows: [{ companies: 3, hold_rows: 3, held: 0, held_companies: "" }] },
  xero_sends: { status: "ok", rows: [{ needs_check: 0, sending: 0 }] },
  ai_control: { status: "ok", rows: [{ rows: 1, enabled_rows: 0 }] },
  ai_flagged: { status: "ok", rows: [] },
  invoice_statuses: { status: "ok", rows: [{ status: "draft" }, { status: "paid" }, { status: "voided" }] },
  email_ledger: { status: "ok", rows: [{ reserve_present: true, complete_present: true }] },
});
const opts = { jnrSlug: "jnr", cronSecretLength: "32", alertEmailSet: "yes" };
const verdict = (c: Any, o: Any = opts) => decide(c, o);

describe("release readiness gate: decisions", () => {
  it("all green is GO, with one OVERALL line and one row per check", () => {
    const r = verdict(green());
    expect(r.overall).toBe("GO");
    expect(r.checks).toHaveLength(9);
    const report = formatReport(r);
    expect(report.match(/^OVERALL: /gm)).toHaveLength(1);
    expect(report).toContain("OVERALL: GO");
  });

  it("152 (SliQ import route) is required: GO with it, NO GO without its marker or its verify file, every other row unchanged", () => {
    expect(REQUIRED_MARKERS.map((m: { n: string }) => m.n)).toContain("152");
    expect(VERIFY_RELEASES).toContain("152");
    const base = verdict(green());
    expect(base.overall).toBe("GO");
    const noMarker = green();
    noMarker.preflight.rows.find((r: Any) => r.check.startsWith("post-144 marker 152")).value = "not applied";
    const m = verdict(noMarker);
    expect(m.overall).toBe("NO GO");
    expect(m.checks.find((c: Any) => c.id === "1a").detail).toContain("152 not applied");
    expect(m.checks.filter((c: Any) => c.id !== "1a")).toEqual(base.checks.filter((c: Any) => c.id !== "1a"));
    const noVerify = green();
    delete noVerify.verify["152"];
    const v = verdict(noVerify);
    expect(v.overall).toBe("NO GO");
    expect(v.checks.find((c: Any) => c.id === "1b").detail).toContain("152 missing");
    expect(v.checks.filter((c: Any) => c.id !== "1b")).toEqual(base.checks.filter((c: Any) => c.id !== "1b"));
  });

  it("other held companies are reported but are not NO GO unless the flag is given", () => {
    expect(verdict(green()).checks.find((c: Any) => c.id === "2").detail).toContain("acme");
    expect(verdict(green(), { ...opts, failOnOtherHeld: true }).overall).toBe("NO GO");
  });

  const failing: Array<[string, (c: Any) => void, Any?]> = [
    ["a marker reads 'not applied'", (c) => { c.preflight.rows[5].value = "not applied"; }],
    ["a marker reads 'other'", (c) => { c.preflight.rows[0].value = "other"; }],
    ["a required marker row is missing", (c) => { c.preflight.rows.pop(); }],
    ["preflight unreadable", (c) => { c.preflight = { status: "error", message: "boom" }; }],
    ["preflight skipped", (c) => { delete c.preflight; }],
    ["a verify file returns false", (c) => { c.verify["149"].sets[0][1].ok = false; }],
    ["a verify file returns null", (c) => { c.verify["143"].sets[0][0].ok = null; }],
    ["a verify file is missing", (c) => { c.verify["151"] = { status: "missing" }; }],
    ["a verify file errors", (c) => { c.verify["146"] = { status: "error", message: "relation missing" }; }],
    ["a verify file returns no rows", (c) => { c.verify["148"].sets = [[]]; }],
    ["all verify results absent", (c) => { delete c.verify; }],
    ["neither DLN_COUNTER_SET nor DLN_HOLD_RELEASED", (c) => { c.dln.rows[0].counter_set = 0; }],
    ["both DLN actions exist", (c) => { c.dln.rows[0].hold_released = 1; }],
    ["JNR still pending numbering", (c) => { c.dln.rows[0].jnr_pending = 1; }],
    ["JNR company not found", (c) => { c.dln.rows[0].org_found = 0; }],
    ["dln unreadable", (c) => { c.dln = { status: "error" }; }],
    ["an admin has no factor while the flag is on", (c) => { c.mfa.rows[0].with_factor = 1; }],
    ["mfa unreadable", (c) => { c.mfa = { status: "error" }; }],
    ["mfa returns no companies", (c) => { c.mfa.rows = []; }],
    ["vercel.json has an extra cron", (c) => { c.vercel.crons.push({ path: "/api/cron/mail-poll" }); }],
    ["vercel.json has one cron", (c) => { c.vercel.crons.pop(); }],
    ["vercel.json unreadable", (c) => { c.vercel = null; }],
    ["a Xero hold is on", (c) => { c.xero_hold.rows[0].held = 1; }],
    ["a Xero hold row is missing for a company", (c) => { c.xero_hold.rows[0].hold_rows = 2; }],
    ["a Xero send needs checking", (c) => { c.xero_sends.rows[0].needs_check = 1; }],
    ["a Xero send is stuck sending", (c) => { c.xero_sends.rows[0].sending = 2; }],
    ["xero unreadable", (c) => { c.xero_hold = { status: "error" }; }],
    ["the Tolra AI switch is on", (c) => { c.ai_control.rows[0].enabled_rows = 1; }],
    ["the Tolra AI control row is missing", (c) => { c.ai_control.rows[0].rows = 0; }],
    ["ai unreadable", (c) => { c.ai_flagged = { status: "skipped" }; }],
    ["an unexpected invoice status", (c) => { c.invoice_statuses.rows.push({ status: "paid " }); }],
    ["a null invoice status", (c) => { c.invoice_statuses.rows.push({ status: "(null)" }); }],
    ["invoice statuses unreadable", (c) => { c.invoice_statuses = undefined; }],
    ["e-mail ledger (106) missing", (c) => { c.email_ledger.rows = [{ reserve_present: false, complete_present: true }]; }],
    ["e-mail ledger unreadable", (c) => { c.email_ledger = undefined; }],
  ];
  it.each(failing)("NO GO when %s", (_name, mutate) => {
    const c = green();
    mutate(c);
    const r = verdict(c);
    expect(r.overall).toBe("NO GO");
    expect(r.checks.filter((k: Any) => !k.pass)).toHaveLength(1);
    expect(formatReport(r)).toContain("OVERALL: NO GO");
  });

  it.each<[string, Any]>([
    ["no --jnr-slug", { ...opts, jnrSlug: undefined }],
    ["no --cron-secret-length", { ...opts, cronSecretLength: undefined }],
    ["a short CRON_SECRET", { ...opts, cronSecretLength: "8" }],
    ["a non-numeric CRON_SECRET length", { ...opts, cronSecretLength: "abc" }],
    ["no --alert-email-set", { ...opts, alertEmailSet: undefined }],
    ["--alert-email-set no", { ...opts, alertEmailSet: "no" }],
    ["--alert-email-set maybe", { ...opts, alertEmailSet: "maybe" }],
  ])("NO GO with %s", (_name, o) => {
    expect(verdict(green(), o).overall).toBe("NO GO");
  });

  it("--expect-mfa: NO GO when the flag is off, GO when on", () => {
    expect(verdict(green(), { ...opts, expectMfa: true }).overall).toBe("GO");
    const c = green();
    c.mfa.rows[0].flag_on = false;
    expect(verdict(c).overall).toBe("GO");
    expect(verdict(c, { ...opts, expectMfa: true }).overall).toBe("NO GO");
  });

  it("an unknown or empty input is NO GO, never a throw", () => {
    expect(decide(undefined, {}).overall).toBe("NO GO");
    expect(decide({}, opts).overall).toBe("NO GO");
    expect(decide({ preflight: "junk", verify: 5, mfa: { status: "ok", rows: [null] } } as Any, opts).overall).toBe("NO GO");
  });

  it("the invoice allowlist is 073's plus voided and canceled", () => {
    expect([...INVOICE_STATUS_ALLOWLIST].sort()).toEqual(["canceled", "cancelled", "credited", "draft", "issued", "paid", "partial", "sent", "void", "voided", "written_off"]);
  });
});

describe("release readiness gate: it can only read", () => {
  it.each([
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a = 1",
    "DELETE FROM t",
    "DROP TABLE t",
    "TRUNCATE t",
    "CREATE TABLE t (a int)",
    "ALTER TABLE t ADD a int",
    "GRANT ALL ON t TO x",
    "SELECT 1; DELETE FROM t",
    "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
    "SELECT * INTO new_t FROM t",
    "SELECT * FROM t FOR UPDATE",
    "SELECT set_config('a.b', 'c', false)",
    "SELECT nextval('s')",
    "SET ROLE postgres",
    "BEGIN",
    "COMMIT",
    "DO $$ BEGIN PERFORM 1; END $$",
    "SELECT query_to_xml($q$DELETE FROM t$q$, false, true, '')",
    "",
  ])("refuses %j", (sql) => {
    expect(() => assertSelectOnly(sql)).toThrow(/Refused/);
  });

  it("accepts SELECTs, including comments, quoted words and a dollar-quoted inner SELECT", () => {
    expect(() => assertSelectOnly("-- delete everything\nSELECT 'update; drop' AS a, updated_at FROM t /* insert */")).not.toThrow();
    expect(() => assertSelectOnly("WITH a AS (SELECT 1) SELECT * FROM a;")).not.toThrow();
    expect(() => assertSelectOnly("SELECT query_to_xml($q$SELECT 1$q$, false, true, '')")).not.toThrow();
  });

  it("the shipped gate SQL and verify files are all SELECT-only", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const gate = splitSections(readFileSync("supabase/verify/release_readiness_gate.sql", "utf8"));
    expect(Object.keys(gate).sort()).toEqual(["ai_control", "ai_flagged", "dln", "email_ledger", "invoice_statuses", "mfa", "xero_hold", "xero_sends"]);
    for (const s of Object.values(gate) as Array<{ sql: string }>) expect(() => assertSelectOnly(s.sql)).not.toThrow();
    for (const n of VERIFY_RELEASES) {
      const f = readdirSync("supabase/verify").find((x) => x.endsWith(`_${n}.sql`));
      expect(f, `verify file ${n}`).toBeTruthy();
      expect(() => assertSelectOnly(readFileSync(`supabase/verify/${f}`, "utf8"))).not.toThrow();
    }
    expect(() => assertSelectOnly(readFileSync("supabase/verify/release_preflight.sql", "utf8"))).not.toThrow();
  });
});

describe("release readiness gate: which database it will touch", () => {
  it.each(["postgres://u@127.0.0.1:55591/d", "postgresql://u:p@localhost/d", "postgres://u@[::1]:5432/d", "postgres://u@127.0.0.9/d"])("allows loopback %s", (url) => {
    expect(assertDatabaseUrlAllowed(url)).toBe("loopback");
  });
  it.each(["postgres://u:p@db.abcdefgh.supabase.co:5432/postgres", "postgres://u@10.0.0.5/d", "postgres://u@127.0.0.1.evil.example/d", "not a url", ""])("refuses %j without the flag", (url) => {
    expect(() => assertDatabaseUrlAllowed(url)).toThrow(/Refused/);
  });
  it("allows a non-loopback URL only with --production-readonly, but never an empty one", () => {
    expect(assertDatabaseUrlAllowed("postgres://u@db.example.com/d", { productionReadonly: true })).toBe("production-readonly");
    expect(() => assertDatabaseUrlAllowed("", { productionReadonly: true })).toThrow(/Refused/);
  });
  it("parses the flags and rejects unknown ones", () => {
    expect(parseArgs(["--jnr-slug", "jnr", "--production-readonly", "--expect-mfa", "--cron-secret-length", "32", "--alert-email-set", "yes"])).toMatchObject({ jnrSlug: "jnr", productionReadonly: true, expectMfa: true, cronSecretLength: "32", alertEmailSet: "yes" });
    expect(() => parseArgs(["--write"])).toThrow(/Unknown/);
    expect(() => parseArgs(["--jnr-slug"])).toThrow(/needs a value/);
  });
});
