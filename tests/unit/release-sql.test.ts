/** Release SQL (independent review of 0604bf4): every migration in this release can be applied as one transaction. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { releaseSql, wrapProblems } from "../../scripts/release-sql.mjs";

const dir = path.resolve(__dirname, "../../supabase/migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

describe("release SQL wrapper", () => {
  it.each(files.filter((f) => f >= "014"))("%s wraps into one BEGIN ... COMMIT", (file) => {
    const text = releaseSql(readFileSync(path.join(dir, file), "utf8"), file);
    expect(text.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(text.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("refuses files that manage their own transaction or can't run inside one", () => {
    expect(() => releaseSql(readFileSync(path.join(dir, "006_production_hardening.sql"), "utf8"), "006")).toThrow(/transaction control/);
    expect(wrapProblems("CREATE INDEX CONCURRENTLY x ON t (a);")).toHaveLength(1);
    expect(wrapProblems("VACUUM t;\nCOMMIT;")).toHaveLength(2);
  });

  it("doesn't mistake a function body's BEGIN / END; for transaction control", () => {
    expect(wrapProblems("CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;")).toEqual([]);
  });
});

describe("prepared release text for quote versions (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const root = path.resolve(__dirname, "../..");
    // Found by name (068; 066 and 067 are allocated to other branches).
    const file = readdirSync(path.join(root, "supabase/migrations")).find((f) => f.endsWith("_quote_versions.sql"))!;
    const expected = releaseSql(readFileSync(path.join(root, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(root, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });

  it("has a rollback that is one transaction and stops when quotes were revised or partly accepted", () => {
    const root = path.resolve(__dirname, "../..");
    const rollback = readFileSync(path.join(root, "supabase/release/068_quote_versions.rollback.sql"), "utf8");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(rollback).toMatch(/068 rollback stopped/);
    expect(rollback).toMatch(/CREATE OR REPLACE FUNCTION public\.accept_quote\(p_quote uuid, p_customer_po text DEFAULT NULL::text, p_delivery_date date DEFAULT NULL::date\)/);
  });
});

describe("prepared release text for 030 (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = "030_vat_registration_totals.sql";
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release/030_vat_registration_totals.release.sql"), "utf8")).toBe(expected);
  });
});

describe("prepared release text for 031 (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = "031_inbound_mail.sql";
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release/031_inbound_mail.release.sql"), "utf8")).toBe(expected);
  });
});

describe("prepared release text for 032 (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = "032_invoice_payments.sql";
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release/032_invoice_payments.release.sql"), "utf8")).toBe(expected);
  });
});

describe("prepared release text for 033 (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = "033_prelaunch_hardening.sql";
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release/033_prelaunch_hardening.release.sql"), "utf8")).toBe(expected);
  });
});

describe("prepared release text for 034 (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = "034_workflow_day_one.sql";
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release/034_workflow_day_one.release.sql"), "utf8")).toBe(expected);
  });
});

describe("prepared release text for 035 (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = "035_who_did_what.sql";
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release/035_who_did_what.release.sql"), "utf8")).toBe(expected);
  });
});

describe("prepared release text for 036 (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = "036_two_level_access.sql";
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release/036_two_level_access.release.sql"), "utf8")).toBe(expected);
  });
});

describe("prepared release text for 037 (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = "037_rework.sql";
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release/037_rework.release.sql"), "utf8")).toBe(expected);
  });
});

describe("prepared release text for the booking day plan (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name, so renumbering the migration (numbers are given at merge time) needs no change here.
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_booking_day_plan.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for the job photos migration (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    const file = files.find((f) => /^\d{3}_job_photos\.sql$/.test(f));
    expect(file).toBeTruthy();
    // Not asserted as the newest file: 042 (internal jobs, numbered ahead at merge time) sits after it.
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file!), "utf8"), file!);
    expect(readFileSync(path.join(dir, "supabase/release", file!.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for internal jobs and machines (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name: the file keeps its number (042) while earlier-numbered migrations land before it.
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_internal_jobs_and_machines.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for sales-order machines (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name: the file keeps its number (043) while earlier-numbered migrations land before it.
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_sales_order_machines.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for machine runs (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name: the file keeps its number (044) while earlier-numbered migrations land before it.
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_machine_runs.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for job sign-off (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name: the file keeps its number (045) while earlier-numbered migrations land before it.
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_job_signoff.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for bench pause (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (046; time entries, earmarked for 046 earlier, move to 047).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_bench_pause.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for the paused-machine acknowledgement (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (049; 047/048 are R1/R2 reporting).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_paused_machine_ack.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for quote to job (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (058; 047 to 057 are allocated to other branches).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_quote_to_job.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for delivery note auto invoice (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (059).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_delivery_note_auto_invoice.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for auto-book at the next free slot (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (061).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_auto_book_next_free.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release texts for time and pay (supabase/release)", () => {
  // Found by name: 050 attendance, 051 job labour, 052 weekly review, 074 day flags, 075 site network and refused sync.
  for (const suffix of ["_attendance.sql", "_job_labour.sql", "_time_week_review.sql", "_time_day_flags.sql", "_site_network_and_sync_rejections.sql"]) {
    it(`${suffix}: exactly what release-sql.mjs produces from the migration file`, () => {
      const dir = path.resolve(__dirname, "../..");
      const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith(suffix))!;
      const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
      expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
    });
  }
});

describe("prepared release text for the data import (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (076).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_data_import.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for per-company access (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (066).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_company_access.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for the audit chain's index lookup (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (077).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_audit_hash_index_lookup.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for clock-in address retention and CRD credit note numbers (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (078).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_ip_retention_and_crd_numbers.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });
});

describe("prepared release text for the data import under pg-safeupdate (supabase/release)", () => {
  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const dir = path.resolve(__dirname, "../..");
    // Found by name (079).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_import_safeupdate.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });

  it("079's import_company_data_run is 076's but for WHERE TRUE on the eight UPDATEs without a WHERE of their own", () => {
    const dir = path.resolve(__dirname, "../..");
    const between = (text: string) => text.slice(text.indexOf("CREATE OR REPLACE FUNCTION public.import_company_data_run("),
      text.indexOf("\n", text.indexOf("REVOKE ALL ON FUNCTION public.import_company_data_run(")));
    const m076 = between(readFileSync(path.join(dir, "supabase/migrations/076_data_import.sql"), "utf8"));
    const m079 = between(readFileSync(path.join(dir, "supabase/migrations/079_import_safeupdate.sql"), "utf8"));
    expect(m079.split(" WHERE TRUE;").length - 1).toBe(8);
    expect(m079.replaceAll(" WHERE TRUE;", ";")).toBe(m076);
    // The rollback puts 076's back, byte for byte.
    expect(between(readFileSync(path.join(dir, "supabase/release/079_import_safeupdate.rollback.sql"), "utf8"))).toBe(m076);
  });
});

describe("prepared release text for the Activity log's record numbers and the converted job's description (supabase/release)", () => {
  const dir = path.resolve(__dirname, "../..");
  const between = (text: string, name: string) => text.slice(text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`),
    text.indexOf("\n", text.indexOf(`GRANT EXECUTE ON FUNCTION public.${name}(`)));
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    // Found by name (080).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_activity_labels_job_work.sql"))!;
    const expected = releaseSql(readFileSync(path.join(dir, "supabase/migrations", file), "utf8"), file);
    expect(readFileSync(path.join(dir, "supabase/release", file.replace(/\.sql$/, ".release.sql")), "utf8")).toBe(expected);
  });

  it("080's org_activity is 035's but for the record's table passed to activity_label; the rollback puts 035's back", () => {
    const m035 = between(read("supabase/migrations/035_who_did_what.sql"), "org_activity");
    const m080 = between(read("supabase/migrations/080_activity_labels_job_work.sql"), "org_activity");
    expect(m080.split("security_audit.activity_label(a.entity_table, coalesce(a.new_data, a.old_data))").length - 1).toBe(1);
    expect(m080.replace("security_audit.activity_label(a.entity_table, ", "security_audit.activity_label(")).toBe(m035);
    expect(between(read("supabase/release/080_activity_labels_job_work.rollback.sql"), "org_activity")).toBe(m035);
  });

  it("080's convert_sales_order is 068's but for the job's description; the rollback puts 068's back", () => {
    const m068 = between(read("supabase/migrations/068_quote_versions.sql"), "convert_sales_order");
    const m080 = between(read("supabase/migrations/080_activity_labels_job_work.sql"), "convert_sales_order");
    const work = m080.slice(m080.indexOf("\n  -- The job's description (080)"), m080.indexOf("  END IF;\n", m080.indexOf("-- The job's description (080)")) + "  END IF;\n".length);
    expect(work).toContain("NOT l.declined");
    const back = m080.replace(work, "").replace("  v_work    TEXT;\n", "")
      .replace("coalesce(v_work, 'Converted from ' || v_order.so_number), 'material',", "'Converted from ' || v_order.so_number, 'material',");
    expect(back).toBe(m068);
    expect(between(read("supabase/release/080_activity_labels_job_work.rollback.sql"), "convert_sales_order")).toBe(m068);
  });
});

describe("prepared release text for the job flow and its release (supabase/release, 081)", () => {
  const dir = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  /** A function's text from its CREATE to the end of the line that closes it (its GRANT, or its REVOKE when it has no grant). */
  const fn = (text: string, name: string, last: string) => {
    const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return text.slice(start, text.indexOf("\n", text.indexOf(`${last} ON FUNCTION public.${name}(`, start)));
  };
  const file = () => readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_job_flow_release.sql"))!;

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const name = file();
    const expected = releaseSql(read(`supabase/migrations/${name}`), name);
    expect(read(`supabase/release/${name.replace(/\.sql$/, ".release.sql")}`)).toBe(expected);
  });

  it("081's job_release_state is 037's but for the released line; the rollback puts 037's back", () => {
    const m037 = fn(read("supabase/migrations/037_rework.sql"), "job_release_state", "GRANT EXECUTE");
    const m081 = fn(read(`supabase/migrations/${file()}`), "job_release_state", "GRANT EXECUTE");
    const added = m081.slice(m081.indexOf("  -- 081 (ISO 9001 8.6)"), m081.indexOf("\n", m081.indexOf("public.job_early_release_active(p_job);")) + 1);
    expect(added).toContain("v_rel := (v_job.inspected_at IS NOT NULL AND v_live = 0) OR public.job_early_release_active(p_job);");
    expect(m081.replace(added, "  v_rel := (v_job.inspected_at IS NOT NULL AND v_live = 0) OR (v_live > 0 AND NOT v_whole);\n")).toBe(m037);
    expect(fn(read("supabase/release/081_job_flow_release.rollback.sql"), "job_release_state", "GRANT EXECUTE")).toBe(m037);
  });

  it("081's delivery_note_try_draft is 059's but for putting a note on its job's invoice; the rollback puts 059's back", () => {
    const m059 = fn(read("supabase/migrations/059_delivery_note_auto_invoice.sql"), "delivery_note_try_draft", "REVOKE ALL");
    const m081 = fn(read(`supabase/migrations/${file()}`), "delivery_note_try_draft", "REVOKE ALL");
    const step = m081.slice(m081.indexOf("    -- 081: the note's job already has its invoice"), m081.indexOf("      RETURN 'linked';\n    END IF;\n") + "      RETURN 'linked';\n    END IF;\n".length);
    expect(step).toContain("UPDATE public.delivery_notes SET invoice_id = v_job_inv WHERE id = p_note;");
    expect(m081.replace(step, "").replace("  v_job_inv UUID;\n", "")).toBe(m059);
    expect(fn(read("supabase/release/081_job_flow_release.rollback.sql"), "delivery_note_try_draft", "REVOKE ALL")).toBe(m059);
  });

  it("every UPDATE in 081's new functions names its own rows (pg-safeupdate)", () => {
    const text = read(`supabase/migrations/${file()}`);
    const updates = text.split("\n").filter((l) => /^\s*UPDATE public\./.test(l));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u, u).toMatch(/\bWHERE\b/);
  });
});

describe("prepared release text for traceability, records kept and supplier status (supabase/release)", () => {
  const dir = path.resolve(__dirname, "../..");
  // Found by name (082).
  const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_traceability_records_suppliers.sql"))!;
  const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const expected = releaseSql(read(`supabase/migrations/${file}`), file);
    expect(read(`supabase/release/${file.replace(/\.sql$/, ".release.sql")}`)).toBe(expected);
  });

  it("replaces no existing function, and its rollback is one transaction that drops exactly what it adds", () => {
    const migration = read(`supabase/migrations/${file}`);
    const created = [...migration.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(\)/g)].map((m) => m[1]).sort();
    expect(created).toEqual(["public.customers_in_use_guard", "public.job_inspections_traceability", "public.jobs_traceability", "public.purchase_orders_supplier_status",
      "public.suppliers_in_use_guard", "public.suppliers_status_guard"]);
    const rollback = read(`supabase/release/${file.replace(/\.sql$/, ".rollback.sql")}`);
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect([...rollback.matchAll(/DROP FUNCTION IF EXISTS (public\.\w+)\(\);/g)].map((m) => m[1]).sort()).toEqual(created);
    const added = [...migration.matchAll(/ALTER TABLE (public\.\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => `${m[1]}.${m[2]}`).sort();
    expect([...rollback.matchAll(/ALTER TABLE (public\.\w+) DROP COLUMN IF EXISTS (\w+);/g)].map((m) => `${m[1]}.${m[2]}`).sort()).toEqual(added);
  });
});

describe("prepared release text for the authorised inspectors list (supabase/release)", () => {
  const dir = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    // Found by name (083).
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_authorised_inspectors.sql"))!;
    const expected = releaseSql(read(path.join("supabase/migrations", file)), file);
    expect(read(path.join("supabase/release", file.replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("083's new functions are new; its rollback drops them and the drawing revision columns", () => {
    const file = readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_authorised_inspectors.sql"))!;
    const sql = read(path.join("supabase/migrations", file));
    const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1]).filter((name) => name !== "public.inspect_job").sort();
    expect(created).toEqual(["public.inspection_pass_authorised", "public.iso_083_record_immutable", "public.jobs_drawing_revision_guard",
      "public.organization_members_inspector_history", "public.set_authorised_inspector", "public.set_job_drawing_revision"]);
    // None of them existed before 083.
    for (const earlier of readdirSync(path.join(dir, "supabase/migrations")).filter((f) => f < file)) {
      const text = read(path.join("supabase/migrations", earlier));
      for (const name of created) expect(text.includes(`FUNCTION ${name}(`), `${name} in ${earlier}`).toBe(false);
    }
    const rollback = read("supabase/release/083_authorised_inspectors.rollback.sql");
    for (const name of created) expect(rollback).toContain(`DROP FUNCTION IF EXISTS ${name}(`);
    expect(rollback).toContain("DROP TABLE IF EXISTS public.inspector_authorisations;");
    for (const column of ["drawing_revision", "drawing_revision_required"]) expect(rollback).toContain(`ALTER TABLE public.jobs DROP COLUMN IF EXISTS ${column};`);
  });

  it("083's inspect_job is 081's but for the interim check (the list only, admins included); the rollback puts 081's back", () => {
    const fn = (text: string) => text.slice(text.indexOf("CREATE OR REPLACE FUNCTION public.inspect_job("),
      text.indexOf("\n", text.indexOf("GRANT EXECUTE ON FUNCTION public.inspect_job(")));
    const m081 = fn(read("supabase/migrations/081_job_flow_release.sql"));
    const m083 = fn(read("supabase/migrations/083_authorised_inspectors.sql"));
    const check081 = m081.slice(m081.indexOf("  IF NOT public.has_org_role(ARRAY['admin'])\n     AND NOT EXISTS"), m081.indexOf("  END IF;\n", m081.indexOf("An admin has to make you an inspector")) + "  END IF;\n".length);
    const check083 = m083.slice(m083.indexOf("  -- 083 (ISO 9001 7.2)"), m083.indexOf("  END IF;\n", m083.indexOf("HINT = 'not_authorised_inspector'")) + "  END IF;\n".length);
    expect(check081).toContain("An admin has to make you an inspector");
    expect(check083).not.toContain("has_org_role");
    expect(m083.replace(check083, check081)).toBe(m081);
    expect(fn(read("supabase/release/083_authorised_inspectors.rollback.sql"))).toBe(m081);
  });
});

describe("prepared release text for the integrations layer + Xero (supabase/release)", () => {
  const dir = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const file = () => readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_integrations_xero.sql"))!;

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    // Found by name (084).
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("084 replaces nothing: every function and table it creates is new; its rollback drops each of them and both triggers", () => {
    const sql = read(path.join("supabase/migrations", file()));
    const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1]).sort();
    expect(created).toHaveLength(20);
    expect(created.every((name) => name.startsWith("public.integration_"))).toBe(true);
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (public\.\w+) \(/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(["public.integration_connections", "public.integration_contacts", "public.integration_mappings", "public.integration_oauth_states",
      "public.integration_secrets", "public.integration_sends"]);
    for (const earlier of readdirSync(path.join(dir, "supabase/migrations")).filter((f) => f < file())) {
      const text = read(path.join("supabase/migrations", earlier));
      for (const name of [...created, ...tables]) expect(text.includes(`${name}(`) || text.includes(`${name} (`), `${name} in ${earlier}`).toBe(false);
    }
    // No ALTER of an existing table and no CREATE OR REPLACE of an existing function: only the two triggers touch existing tables.
    expect(sql).not.toMatch(/ALTER TABLE public\.(?!integration_)/);
    const rollback = read("supabase/release/084_integrations_xero.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect([...rollback.matchAll(/DROP FUNCTION IF EXISTS (public\.\w+)\(/g)].map((m) => m[1]).sort()).toEqual(created);
    expect([...rollback.matchAll(/DROP TABLE IF EXISTS (public\.\w+);/g)].map((m) => m[1]).sort()).toEqual(tables);
    for (const t of ["invoices", "credit_notes"]) expect(rollback).toContain(`DROP TRIGGER IF EXISTS zz_integration_enqueue ON public.${t};`);
  });

  it("the server-only functions are revoked from PUBLIC, anon and authenticated; the tokens' tables get no API grant at all", () => {
    const sql = read(path.join("supabase/migrations", file()));
    for (const fn of ["integration_document", "integration_unmapped", "integration_oauth_consume", "integration_store_connection", "integration_mark_needs_reconnect",
      "integration_token_lease", "integration_token_store", "integration_token_release", "integration_claim_next", "integration_record_result", "integration_contact_record"]) {
      expect(sql, fn).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;\\nGRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`));
    }
    expect(sql).not.toMatch(/GRANT [A-Z, ]+ ON [^;]*integration_(secrets|oauth_states)[^;]* TO (authenticated|anon)/);
  });
});

describe("prepared release text for data import PR2: credit notes, delivery notes, sent by / signed by (supabase/release)", () => {
  const dir = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  // Found by name (085).
  const file = () => readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_data_import_credit_delivery.sql"))!;
  const fn = (text: string, name: string) => {
    const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    return text.slice(start, text.indexOf("\n$$;\n", start) + "\n$$;".length);
  };
  const BLOCK = `  -- 085: the data import's own writes for the company it holds them for (an insert while quoteflow.data_import, a delete while
  -- quoteflow.data_import_undo; each set by the import alone, around its own statements, and cleared after).
  IF (TG_OP = 'INSERT' AND current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT)
     OR (TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
`;
  const SOURCES: [string, string][] = [
    ["credit_note_issue_lock", "034_workflow_day_one.sql"], ["credit_note_lines_issue_lock", "034_workflow_day_one.sql"],
    ["delivery_notes_link_guard", "037_rework.sql"], ["delivery_note_items_link_guard", "034_workflow_day_one.sql"],
    ["import_check_payload", "076_data_import.sql"], ["import_merge_stage", "076_data_import.sql"], ["import_plan", "076_data_import.sql"],
    ["import_part_payload", "076_data_import.sql"], ["import_company_data_run", "079_import_safeupdate.sql"], ["import_undo_part", "076_data_import.sql"],
  ];

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("each guard is its 034 / 037 body plus the one 085 block, and nothing else", () => {
    const m = read(path.join("supabase/migrations", file()));
    for (const [name, source] of SOURCES.slice(0, 4)) {
      const before = fn(read(path.join("supabase/migrations", source)), name);
      const after = fn(m, name);
      expect(after.split(BLOCK).length - 1, name).toBe(1);
      expect(after.replace(BLOCK, ""), name).toBe(before);
    }
  });

  it("the engine keeps every line of what it extends (079's import_company_data_run, 076's helpers) but for the listed ones", () => {
    const m = read(path.join("supabase/migrations", file()));
    // The only lines of the earlier bodies 085 rewrites (a list grown, a status accepted, a column added); everything else is kept, in order.
    const REWRITTEN = new Set([
      "  v_kinds CONSTANT TEXT[] := ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments'];",
      "         x.po_ref AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id",
      "               (cr.c ->> 'notes') AS notes, (cr.c ->> 'vat_enabled') AS vat_enabled_raw",
      "         NULL::TEXT AS status, FALSE AS payment_unverified, NULL::UUID AS job_id,",
      "               (cr.c ->> 'job_no') AS job_no, (cr.c ->> 'description') AS description",
      "    ('status', CASE WHEN c.status_given NOT IN ('issued', 'sent', 'partial', 'paid', 'void', 'cancelled', 'written_off')",
      "                    THEN 'Status must be issued, sent, partial, paid, void, cancelled or written off (drafts and credited invoices are not imported).' END),",
      "                  WHEN i.paid > 0 AND i.paid >= i.total THEN 'paid'",
      "                  WHEN i.status_given IN ('paid', 'partial') THEN 'sent'",
      "    payment_unverified = (i.status_given IN ('paid', 'partial') AND i.paid = 0 AND i.total > 0),",
      "              UNION ALL SELECT 'invoices', 'invoice_ref', ord, row_no, match_key FROM _imp_invoices) y",
      "               + (SELECT count(*) FROM _imp_invoices) + (SELECT count(*) FROM _imp_payments),",
      "    'lines', (SELECT count(*) FROM _imp_quote_lines) + (SELECT count(*) FROM _imp_invoice_lines),",
      "                  + 2 * (SELECT count(*) FROM _imp_invoices WHERE action = 'create') + v_ql + v_il);",
      "                                      notes, vat_enabled, created_at, updated_at)",
      "         c.notes, coalesce(c.vat_enabled, FALSE),",
      "                               quote_ref, customer_po, job_id, vat_enabled, amount_paid, paid_at, payment_unverified, created_at, updated_at)",
      "         c.quote_ref, c.customer_po, c.job_id, c.vat_enabled, c.paid,",
      "  WHERE k NOT IN ('file_name', 'file_sha256', 'customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments');",
      "        UNION ALL SELECT jsonb_array_elements(p_payload -> 'invoices') WHERE jsonb_typeof(p_payload -> 'invoices') = 'array') d;",
      "                       CROSS JOIN LATERAL unnest(ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments']) k(k)",
      "           CASE WHEN g.k IN ('quotes', 'invoices')",
      "                 (3, 1, 'sales_orders'), (3, 2, 'jobs'), (3, 3, 'purchase_orders'), (4, 1, 'invoices')) g(grp, korder, k)",
      "                                     'purchase_orders', 'invoices', 'invoice_line_items', 'invoice_payments'];",
      "  FOREACH v_t IN ARRAY ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'invoice_payments'] LOOP",
      "  FOREACH v_t IN ARRAY ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices'] LOOP",
      "  FOREACH v_t IN ARRAY ARRAY['invoice_payments', 'invoice_line_items', 'invoices', 'purchase_orders', 'job_values', 'jobs', 'sales_orders',",
    ]);
    const used = new Set<string>();
    for (const [name, source] of SOURCES.slice(4)) {
      const before = fn(read(path.join("supabase/migrations", source)), name).split("\n");
      const after = fn(m, name).split("\n");
      let j = 0;
      for (const line of before) {
        if (REWRITTEN.has(line)) { used.add(line); continue; }
        while (j < after.length && after[j] !== line) j++;
        expect(j < after.length, `${name}: "${line.trim()}" kept, in order`).toBe(true);
        j++;
      }
    }
    expect([...REWRITTEN].filter((l) => !used.has(l))).toEqual([]);
  });

  it("its rollback puts back every replaced body byte for byte and drops what 085 adds", () => {
    const rollback = read(path.join("supabase/release", file().replace(/\.sql$/, ".rollback.sql")));
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    for (const [name, source] of SOURCES) expect(fn(rollback, name), name).toBe(fn(read(path.join("supabase/migrations", source)), name));
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.import_people_guard();");
    const m = read(path.join("supabase/migrations", file()));
    const added = [...m.matchAll(/ALTER TABLE (public\.\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map((x) => `${x[1]}.${x[2]}`).sort();
    expect(added).toEqual(["public.delivery_notes.signed_by_user_id", "public.invoices.sent_by_name", "public.invoices.sent_by_user_id",
      "public.purchase_orders.sent_by_name", "public.purchase_orders.sent_by_user_id"]);
    expect([...rollback.matchAll(/ALTER TABLE (public\.\w+) DROP COLUMN IF EXISTS (\w+);/g)].map((x) => `${x[1]}.${x[2]}`).sort()).toEqual(added);
    // The kinds go back to 076's lists, and the rollback stops while anything would be lost.
    for (const t of ["import_mappings", "import_record_keys"]) {
      expect(rollback).toContain(`ALTER TABLE public.${t} ADD CONSTRAINT ${t}_kind_check CHECK (kind IN ('customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders',`);
    }
    expect(rollback).toMatch(/085 rollback stopped: % import keys or saved mappings are for credit notes or delivery notes/);
  });
});

describe("prepared release text for the converted sales order guard (supabase/release, 088)", () => {
  const dir = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const file = () => readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_converted_sales_order_guard.sql"))!;

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    // Found by name (088).
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("adds two trigger functions, a trigger on the four money / VAT columns and one on the job's link; replaces nothing; changes no policy, grant or column", () => {
    const sql = read(path.join("supabase/migrations", file()));
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.sales_orders_converted_money_guard", "public.jobs_converted_order_link_guard"]);
    for (const earlier of readdirSync(path.join(dir, "supabase/migrations")).filter((f) => f < file())) {
      expect(read(path.join("supabase/migrations", earlier)).includes("sales_orders_converted_money_guard"), earlier).toBe(false);
      expect(read(path.join("supabase/migrations", earlier)).includes("jobs_converted_order_link_guard"), earlier).toBe(false);
    }
    expect(sql).toContain("CREATE TRIGGER zz_converted_order_money BEFORE UPDATE OF total_value, vat_enabled, vat_pct, vat_exempt ON public.sales_orders");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.sales_orders_converted_money_guard() FROM PUBLIC, anon, authenticated;");
    expect(sql).toContain("CREATE TRIGGER zz_converted_order_link BEFORE UPDATE OF converted_from_sales_order_id ON public.jobs");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.jobs_converted_order_link_guard() FROM PUBLIC, anon, authenticated;");
    expect(sql).not.toMatch(/\b(ALTER TABLE|CREATE POLICY|DROP POLICY|GRANT [A-Z, ]+ ON|ALTER POLICY)\b/);
    expect(sql.split("USING ERRCODE = '42501', HINT = 'sales_order_converted'")).toHaveLength(3);
    // The guard and the self-check pin each body the file creates (md5 with every whitespace character removed).
    for (const fn of ["sales_orders_converted_money_guard", "jobs_converted_order_link_guard"]) {
      const body = sql.slice(sql.indexOf("AS $$", sql.indexOf(`FUNCTION public.${fn}()`)) + 5);
      const md5 = createHash("md5").update(body.slice(0, body.indexOf("$$;")).replace(/\s/g, "")).digest("hex");
      expect(sql.split(md5), fn).toHaveLength(3);
      expect(read("supabase/verify/converted_sales_order_088.sql"), fn).toContain(`body = '${md5}'`);
      expect(read("supabase/release/088_converted_sales_order_guard.rollback.sql"), fn).toContain(`'${md5}'`);
    }
  });

  it("its rollback drops exactly the two triggers and the two functions, as one transaction", () => {
    const rollback = read("supabase/release/088_converted_sales_order_guard.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect([...rollback.matchAll(/^DROP \w+ IF EXISTS [^;]+;$/gm)].map((m) => m[0])).toEqual([
      "DROP TRIGGER IF EXISTS zz_converted_order_money ON public.sales_orders;",
      "DROP FUNCTION IF EXISTS public.sales_orders_converted_money_guard();",
      "DROP TRIGGER IF EXISTS zz_converted_order_link ON public.jobs;",
      "DROP FUNCTION IF EXISTS public.jobs_converted_order_link_guard();",
    ]);
  });
});

describe("prepared release text for the invoice receipt guard (supabase/release, 089)", () => {
  const dir = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const file = () => readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_invoice_receipt_guard.sql"))!;

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    // Found by name (089).
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("adds one trigger function and one trigger on invoices' status and five receipt columns; replaces nothing; changes no policy, grant or column", () => {
    const sql = read(path.join("supabase/migrations", file()));
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.invoice_receipts_guard"]);
    for (const earlier of readdirSync(path.join(dir, "supabase/migrations")).filter((f) => f < file())) {
      expect(read(path.join("supabase/migrations", earlier)).includes("invoice_receipts_guard"), earlier).toBe(false);
    }
    expect(sql).toContain("CREATE TRIGGER zz_invoice_receipts BEFORE INSERT OR UPDATE OF status, amount_paid, paid_at, credited_amount, refunded_amount, payment_unverified ON public.invoices");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.invoice_receipts_guard() FROM PUBLIC, anon, authenticated;");
    expect(sql).not.toMatch(/\b(ALTER TABLE|CREATE POLICY|DROP POLICY|GRANT [A-Z, ]+ ON|ALTER POLICY)\b/);
    expect(sql).toContain("USING ERRCODE = '42501', HINT = 'invoice_receipts_direct'");
    expect(sql).toContain("USING ERRCODE = '22023', HINT = 'invoice_receipts_mismatch'");
    // The payment and credit steps' own writes pass exactly as 076's lock lets them (the transaction-local setting names the invoice).
    expect(sql).toContain("IF current_setting('quoteflow.invoice_payment', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT THEN");
    // The guard and the self-check pin the body the file creates (md5 with every whitespace character removed).
    const body = sql.slice(sql.indexOf("AS $$", sql.indexOf("FUNCTION public.invoice_receipts_guard()")) + 5);
    const md5 = createHash("md5").update(body.slice(0, body.indexOf("$$;")).replace(/\s/g, "")).digest("hex");
    expect(sql.split(md5)).toHaveLength(3);
    expect(read("supabase/verify/invoice_receipt_guard_089.sql")).toContain(`body = '${md5}'`);
    expect(read("supabase/release/089_invoice_receipt_guard.rollback.sql")).toContain(`'${md5}'`);
  });

  it("its rollback drops exactly the trigger and the function, as one transaction", () => {
    const rollback = read("supabase/release/089_invoice_receipt_guard.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect([...rollback.matchAll(/^DROP \w+ IF EXISTS [^;]+;$/gm)].map((m) => m[0])).toEqual([
      "DROP TRIGGER IF EXISTS zz_invoice_receipts ON public.invoices;",
      "DROP FUNCTION IF EXISTS public.invoice_receipts_guard();",
    ]);
  });
});

describe("prepared release text for a clock action in its own company (supabase/release, 090)", () => {
  const dir = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const file = () => readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_attendance_expected_company.sql"))!;

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("adds one function beside 050's (not an overload, not a replacement); changes no table, policy or other grant", () => {
    const sql = read(path.join("supabase/migrations", file()));
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.record_attendance_event_in_company"]);
    for (const earlier of readdirSync(path.join(dir, "supabase/migrations")).filter((f) => f < file())) {
      expect(read(path.join("supabase/migrations", earlier)).includes("record_attendance_event_in_company"), earlier).toBe(false);
    }
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.record_attendance_event_in_company(UUID, TEXT, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon;");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.record_attendance_event_in_company(UUID, TEXT, TIMESTAMPTZ, TEXT, UUID) TO authenticated;");
    expect(sql).not.toMatch(/\b(ALTER TABLE|CREATE TABLE|CREATE POLICY|DROP POLICY|ALTER POLICY|CREATE TRIGGER|DROP FUNCTION)\b/);
    expect(sql).toContain("USING ERRCODE = '42501', HINT = 'wrong_company'");
    // The guard, the self-check, the verify script and the rollback pin the body the file creates (md5, every whitespace character removed).
    const body = sql.slice(sql.indexOf("AS $$", sql.indexOf("FUNCTION public.record_attendance_event_in_company(")) + 5);
    const md5 = createHash("md5").update(body.slice(0, body.indexOf("$$;")).replace(/\s/g, "")).digest("hex");
    expect(sql.split(md5)).toHaveLength(3);
    expect(read("supabase/verify/attendance_expected_company_090.sql")).toContain(`body = '${md5}'`);
    expect(read("supabase/release/090_attendance_expected_company.rollback.sql")).toContain(`'${md5}'`);
    expect(read("supabase/verify/release_preflight.sql")).toContain(`'${md5}'`);
  });

  it("its rollback drops exactly that function, as one transaction", () => {
    const rollback = read("supabase/release/090_attendance_expected_company.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect([...rollback.matchAll(/^DROP \w+ IF EXISTS [^;]+;$/gm)].map((m) => m[0])).toEqual([
      "DROP FUNCTION IF EXISTS public.record_attendance_event_in_company(UUID, TEXT, TIMESTAMPTZ, TEXT, UUID);",
    ]);
  });
});

describe("prepared release text for the invoice issue guard (supabase/release, 091)", () => {
  const dir = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const file = () => readdirSync(path.join(dir, "supabase/migrations")).find((f) => f.endsWith("_invoice_issue_guard.sql"))!;
  const body = (sql: string, fn: string) => {
    const start = sql.indexOf("AS $$", sql.indexOf(`FUNCTION ${fn}`)) + 5;
    return sql.slice(start, sql.indexOf("$$;", start));
  };
  const md5 = (text: string) => createHash("md5").update(text.replace(/\s/g, "")).digest("hex");

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    // Found by name (091).
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("replaces issue_invoice with 034's body plus the issue setting, adds one trigger function and one trigger; changes no policy, grant or column", () => {
    const sql = read(path.join("supabase/migrations", file()));
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.issue_invoice", "public.invoice_issue_guard"]);
    for (const earlier of readdirSync(path.join(dir, "supabase/migrations")).filter((f) => f < file())) {
      expect(read(path.join("supabase/migrations", earlier)).includes("invoice_issue_guard"), earlier).toBe(false);
    }
    // issue_invoice: 034's text exactly, with only the two set_config lines around its UPDATE added.
    const issue034 = body(read("supabase/migrations/034_workflow_day_one.sql"), "public.issue_invoice(p_invoice UUID)");
    const issue091 = body(sql, "public.issue_invoice(p_invoice UUID)");
    const added = ["  PERFORM set_config('quoteflow.invoice_issue', p_invoice::TEXT, TRUE);\n", "  PERFORM set_config('quoteflow.invoice_issue', '', TRUE);\n"];
    for (const line of added) expect(issue091.split(line)).toHaveLength(2);
    expect(added.reduce((text, line) => text.replace(line, ""), issue091)).toBe(issue034);
    expect(sql).toContain("CREATE TRIGGER zz_invoice_via_issue BEFORE UPDATE OF status, invoice_ref, issued_at, issued_by ON public.invoices");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.invoice_issue_guard() FROM PUBLIC, anon, authenticated;");
    // issue_invoice keeps 034's grants, restated as 034 states them.
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.issue_invoice(UUID) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.issue_invoice(UUID) TO authenticated;");
    expect(sql.replace("GRANT EXECUTE ON FUNCTION public.issue_invoice(UUID) TO authenticated;", "")).not.toMatch(/\b(ALTER TABLE|CREATE POLICY|DROP POLICY|GRANT [A-Z, ]+ ON|ALTER POLICY)\b/);
    expect(sql).toContain("USING ERRCODE = '42501', HINT = 'invoice_issue_direct'");
    // issue_invoice's own write passes: the transaction-local setting names the invoice.
    expect(sql).toContain("IF current_setting('quoteflow.invoice_issue', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT THEN");
    // The guard and the self-check pin both bodies (md5 with every whitespace character removed); the guard also accepts 034's.
    const guard = md5(body(sql, "public.invoice_issue_guard()"));
    expect(sql.split(guard)).toHaveLength(3);
    expect(sql.split(md5(issue091))).toHaveLength(3);
    expect(sql.split(md5(issue034))).toHaveLength(2);
    expect(read("supabase/verify/invoice_issue_guard_091.sql")).toContain(`body = '${guard}'`);
    expect(read("supabase/verify/invoice_issue_guard_091.sql")).toContain(`body = '${md5(issue091)}'`);
    expect(read("supabase/release/091_invoice_issue_guard.rollback.sql")).toContain(`'${guard}'`);
  });

  it("its rollback drops exactly the trigger and the function and puts back 034's issue_invoice, as one transaction", () => {
    const rollback = read("supabase/release/091_invoice_issue_guard.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect([...rollback.matchAll(/^DROP \w+ IF EXISTS [^;]+;$/gm)].map((m) => m[0])).toEqual([
      "DROP TRIGGER IF EXISTS zz_invoice_via_issue ON public.invoices;",
      "DROP FUNCTION IF EXISTS public.invoice_issue_guard();",
    ]);
    const m034 = read("supabase/migrations/034_workflow_day_one.sql");
    const start = m034.indexOf("CREATE OR REPLACE FUNCTION public.issue_invoice(p_invoice UUID)");
    const grant = "GRANT EXECUTE ON FUNCTION public.issue_invoice(UUID) TO authenticated;";
    expect(rollback).toContain(m034.slice(start, m034.indexOf(grant, start) + grant.length));
    expect([...rollback.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.issue_invoice"]);
    expect(rollback).toContain(`'${md5(body(m034, "public.issue_invoice(p_invoice UUID)"))}'`);
  });
});

describe("prepared release text for an admin's release ending the job time (supabase/release, 092)", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const file = () => readdirSync(path.join(root, "supabase/migrations")).find((f) => f.endsWith("_release_ends_session.sql"))!;
  const body = (sql: string, fn: string) => {
    const start = sql.indexOf("AS $$", sql.indexOf(`FUNCTION ${fn}`)) + 5;
    return sql.slice(start, sql.indexOf("$$;", start));
  };
  const md5 = (text: string) => createHash("md5").update(text.replace(/\s/g, "")).digest("hex");
  const m044 = () => read("supabase/migrations/044_machine_runs.sql");
  const m051 = () => read("supabase/migrations/051_job_labour.sql");
  const LC = "public.labour_close(p_user UUID";
  const MRL = "public.machine_runs_labour()";
  const RM = "public.release_machine(p_machine UUID, p_reason TEXT)";

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("replaces three bodies with the earlier text plus exactly the listed changes; adds one column and one check; no policy or table grant", () => {
    const sql = read(path.join("supabase/migrations", file()));
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.labour_close", "public.machine_runs_labour", "public.release_machine"]);
    // labour_close: 051's text plus the one end_reason line.
    const lcAdd = "      end_reason = CASE WHEN p_end_source = 'admin_released' THEN nullif(btrim(coalesce(current_setting('quoteflow.release_reason', TRUE), '')), '') END,\n";
    expect(body(sql, LC).split(lcAdd)).toHaveLength(2);
    expect(body(sql, LC).replace(lcAdd, "")).toBe(body(m051(), LC));
    // machine_runs_labour: 051's text with exactly these replacements (admin_released ends labour as a Pause does).
    const swaps: [string, string][] = [
      ["NEW.end_reason NOT IN ('paused', 'finished', 'override') THEN", "NEW.end_reason NOT IN ('paused', 'finished', 'override', 'admin_released') THEN"],
      ["-- Nothing runs on the job any more (Pause on the whole job, or Finish)", "-- Nothing runs on the job any more (Pause on the whole job, Finish, or an admin's release)"],
      ["v_all := NEW.end_reason IN ('paused', 'finished')", "v_all := NEW.end_reason IN ('paused', 'finished', 'admin_released')"],
      ["CASE WHEN NEW.end_reason = 'finished' THEN 'machine_finish' ELSE 'machine_pause' END", "CASE NEW.end_reason WHEN 'finished' THEN 'machine_finish' WHEN 'admin_released' THEN 'admin_released' ELSE 'machine_pause' END"],
      ["CASE NEW.end_reason WHEN 'finished' THEN 'machine_finish' WHEN 'override' THEN 'machine_override' ELSE 'machine_pause' END", "CASE NEW.end_reason WHEN 'finished' THEN 'machine_finish' WHEN 'override' THEN 'machine_override' WHEN 'admin_released' THEN 'admin_released' ELSE 'machine_pause' END"],
    ];
    expect(swaps.reduce((text, [from, to]) => { expect(text.split(from)).toHaveLength(2); return text.replace(from, to); }, body(m051(), MRL))).toBe(body(sql, MRL));
    // release_machine: 044's text plus the two set_config lines around its one machine_run_end call.
    const added = ["  PERFORM set_config('quoteflow.release_reason', v_reason, TRUE);\n", "  PERFORM set_config('quoteflow.release_reason', '', TRUE);\n"];
    for (const line of added) expect(body(sql, RM).split(line)).toHaveLength(2);
    expect(added.reduce((text, line) => text.replace(line, ""), body(sql, RM))).toBe(body(m044(), RM));
    // Grants as 044 / 051 state them; the trigger restated as 051 creates it.
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.labour_close(UUID, UUID, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.machine_runs_labour() FROM PUBLIC, anon, authenticated;");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.release_machine(UUID, TEXT) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.release_machine(UUID, TEXT) TO authenticated;");
    expect(sql).toContain("CREATE TRIGGER zz_machine_runs_labour AFTER INSERT OR UPDATE OF ended_at ON public.machine_runs\n  FOR EACH ROW EXECUTE FUNCTION public.machine_runs_labour();");
    expect(sql.replace("GRANT EXECUTE ON FUNCTION public.release_machine(UUID, TEXT) TO authenticated;", "")).not.toMatch(/\b(CREATE POLICY|DROP POLICY|ALTER POLICY|GRANT [A-Z, ]+ ON)\b/);
    expect([...sql.matchAll(/^ALTER TABLE ([^\n;]+)/gm)].map((m) => m[1])).toEqual([
      "public.operator_sessions ADD COLUMN IF NOT EXISTS end_reason TEXT",
      "public.operator_sessions DROP CONSTRAINT IF EXISTS operator_sessions_end_reason",
      "public.operator_sessions ADD CONSTRAINT operator_sessions_end_reason",
      "public.operator_sessions DROP CONSTRAINT IF EXISTS operator_sessions_end_source_check",
      "public.operator_sessions ADD CONSTRAINT operator_sessions_end_source_check",
    ]);
    // The end_source list is 051's plus 'admin_released'.
    const list051 = "('sheet', 'machine_pause', 'machine_finish', 'machine_override', 'job_finish', 'pending_stop', 'correction')";
    expect(m051()).toContain(`end_source          TEXT CHECK (end_source IN ${list051})`);
    expect(sql).toContain(`CHECK (end_source IN ${list051.slice(0, -1)}, 'admin_released'))`);
    // The guard and the self-check pin the bodies (md5 with every whitespace character removed); the guard also accepts the earlier ones.
    for (const [fn, earlier] of [[LC, m051()], [MRL, m051()], [RM, m044()]] as const) {
      expect(sql.split(md5(body(sql, fn))).length, `${fn} 092 md5`).toBe(3);
      expect(sql.split(md5(body(earlier, fn))).length, `${fn} earlier md5`).toBe(2);
      expect(read("supabase/verify/release_ends_session_092.sql")).toContain(`body = '${md5(body(sql, fn))}'`);
    }
  });

  it("its rollback puts back 051's and 044's bodies exactly, drops the column and the check, and stops over released sessions", () => {
    const rollback = read("supabase/release/092_release_ends_session.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    for (const [start, end, src] of [
      ["CREATE OR REPLACE FUNCTION public.labour_close(", "REVOKE ALL ON FUNCTION public.labour_close(UUID, UUID, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;", m051()],
      ["CREATE OR REPLACE FUNCTION public.machine_runs_labour()", "REVOKE ALL ON FUNCTION public.machine_runs_labour() FROM PUBLIC, anon, authenticated;", m051()],
      ["CREATE OR REPLACE FUNCTION public.release_machine(", "GRANT EXECUTE ON FUNCTION public.release_machine(UUID, TEXT) TO authenticated;", m044()],
    ] as const) {
      const i = src.indexOf(start);
      expect(rollback).toContain(src.slice(i, src.indexOf(end, i) + end.length));
    }
    expect([...rollback.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.labour_close", "public.machine_runs_labour", "public.release_machine"]);
    expect(rollback).toContain("CHECK (end_source IN ('sheet', 'machine_pause', 'machine_finish', 'machine_override', 'job_finish', 'pending_stop', 'correction'));");
    expect(rollback).toContain("ALTER TABLE public.operator_sessions DROP CONSTRAINT IF EXISTS operator_sessions_end_reason;");
    expect(rollback).toContain("ALTER TABLE public.operator_sessions DROP COLUMN IF EXISTS end_reason;");
    expect(rollback).toContain("s.end_source = 'admin_released' OR s.end_reason IS NOT NULL");
    for (const [fn, src] of [[LC, m051()], [MRL, m051()], [RM, m044()]] as const) expect(rollback).toContain(`'${md5(body(src, fn))}'`);
  });
});

describe("prepared release text for protecting the platform owner's login (supabase/release, 093)", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const file = () => readdirSync(path.join(root, "supabase/migrations")).find((f) => f.endsWith("_protect_platform_owner_login.sql"))!;
  const body = (sql: string, fn: string) => {
    const start = sql.indexOf("AS $$", sql.indexOf(`FUNCTION ${fn}`)) + 5;
    return sql.slice(start, sql.indexOf("$$;", start));
  };
  const md5 = (text: string) => createHash("md5").update(text.replace(/\s/g, "")).digest("hex");
  const m066 = () => read("supabase/migrations/066_company_access.sql");
  const SCA = "public.admin_set_company_access(";
  const ALP = "public.admin_login_is_protected(p_user UUID)";
  const SMA = "public.set_member_access(";

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("replaces admin_set_company_access with 066's text plus exactly the protected_login refusal, adds one signed-in function, and nothing else", () => {
    const sql = read(path.join("supabase/migrations", file()));
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.admin_login_is_protected", "public.admin_set_company_access", "public.set_member_access"]);
    const anchor = "    RAISE EXCEPTION 'A support membership can''t be changed here' USING ERRCODE = '42501', HINT = 'support_membership';\n  END IF;\n";
    const from = body(sql, SCA).indexOf(anchor) + anchor.length;
    const added = body(sql, SCA).slice(from, body(sql, SCA).indexOf("  IF NOT v_exists THEN", from));
    expect(added).toContain("HINT = 'protected_login'");
    expect(added).toContain("IF p_user <> v_uid");
    expect(added).toContain("EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p_user)");
    expect(added).toContain("EXISTS (SELECT 1 FROM public.organization_members s WHERE s.user_id = p_user AND s.support)");
    expect(body(sql, SCA).split(added)).toHaveLength(2);
    expect(body(sql, SCA).replace(added, "")).toBe(body(m066(), SCA));
    // set_member_access: 066's text plus exactly one block after its support-membership check; only a switch-off passes it.
    const smaAnchor = "    RAISE EXCEPTION 'A support membership can only be switched off' USING ERRCODE = '42501';\n  END IF;\n";
    const smaFrom = body(sql, SMA).indexOf(smaAnchor) + smaAnchor.length;
    const smaAdded = body(sql, SMA).slice(smaFrom, body(sql, SMA).indexOf("\n  v_role   := coalesce(p_role, m.role);", smaFrom));
    expect(smaAdded).toContain("HINT = 'protected_login'");
    expect(smaAdded).toContain("IF p_user <> v_uid");
    expect(smaAdded).toContain("OR p_active IS DISTINCT FROM FALSE)");
    expect(smaAdded).toContain("EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p_user)");
    expect(smaAdded).toContain("EXISTS (SELECT 1 FROM public.organization_members s WHERE s.user_id = p_user AND s.support)");
    expect(body(sql, SMA).split(smaAdded)).toHaveLength(2);
    expect(body(sql, SMA).replace(smaAdded, "")).toBe(body(m066(), SMA));
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[]) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[]) TO authenticated;");
    expect(sql.split(md5(body(sql, SMA))).length).toBe(3);
    expect(sql.split(md5(body(m066(), SMA))).length).toBe(2);
    // Grants as 066 states them; the new function signed-in only; no table, policy or row change.
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.admin_set_company_access(UUID, UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.admin_set_company_access(UUID, UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) TO authenticated;");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.admin_login_is_protected(UUID) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.admin_login_is_protected(UUID) TO authenticated;");
    const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    expect(outside).not.toMatch(/^\s*(ALTER TABLE|CREATE TABLE|CREATE POLICY|DROP POLICY|ALTER POLICY|CREATE TRIGGER|UPDATE |INSERT INTO|DELETE FROM)/m);
    expect(sql.replace(/GRANT EXECUTE ON FUNCTION public\.\w+\([^)]*\) TO authenticated;/g, "")).not.toMatch(/\bGRANT [A-Z, ]+ ON\b/);
    // The guard and the self-check pin both bodies (md5 with every whitespace character removed); the guard also accepts 066's.
    expect(sql.split(md5(body(sql, SCA))).length).toBe(3);
    expect(sql.split(md5(body(sql, ALP))).length).toBe(3);
    expect(sql.split(md5(body(m066(), SCA))).length).toBe(2);
    const verify = read("supabase/verify/protect_platform_owner_login_093.sql");
    expect(verify).toContain(`body = '${md5(body(sql, SCA))}'`);
    expect(verify).toContain(`body = '${md5(body(sql, ALP))}'`);
    expect(verify).toContain(`body = '${md5(body(sql, SMA))}'`);
  });

  it("the app's refusal text for protected_login is the one the routes use", () => {
    expect(read("lib/company-access.ts")).toContain('case "protected_login": return PROTECTED_LOGIN;');
  });

  it("its rollback puts back 066's admin_set_company_access and set_member_access exactly (with grants and comment) and drops the new function", () => {
    const rollback = read("supabase/release/093_protect_platform_owner_login.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    const src = m066();
    const start = src.indexOf("CREATE OR REPLACE FUNCTION public.admin_set_company_access(");
    const endMark = "keeps one company per login, audits in p_org''s log (066).';";
    expect(rollback).toContain(src.slice(start, src.indexOf(endMark, start) + endMark.length));
    const smaStart = src.indexOf("CREATE OR REPLACE FUNCTION public.set_member_access(");
    const smaEnd = "GRANT EXECUTE ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[]) TO authenticated;";
    expect(rollback).toContain(src.slice(smaStart, src.indexOf(smaEnd, smaStart) + smaEnd.length));
    expect(rollback).toContain(`'${md5(body(src, SMA))}'`);
    expect(rollback).toContain(`'${md5(body(read(path.join("supabase/migrations", file())), SMA))}'`);
    expect([...rollback.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1])).toEqual(["public.admin_set_company_access", "public.set_member_access"]);
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.admin_login_is_protected(UUID);");
    expect(rollback).toContain(`'${md5(body(src, SCA))}'`);
    expect(rollback).toContain(`'${md5(body(read(path.join("supabase/migrations", file())), SCA))}'`);
  });
});

describe("prepared release text for the Activity page's one row per change (supabase/release, 094)", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const file = () => readdirSync(path.join(root, "supabase/migrations")).find((f) => f.endsWith("_activity_one_row_per_change.sql"))!;
  const body = (sql: string, fn: string) => {
    const start = sql.indexOf("AS $$", sql.indexOf(`FUNCTION ${fn}`)) + 5;
    return sql.slice(start, sql.indexOf("$$;", start));
  };
  const md5 = (text: string) => createHash("md5").update(text.replace(/\s/g, "")).digest("hex");
  const m080 = () => read("supabase/migrations/080_activity_labels_job_work.sql");
  const ORG = "public.org_activity(";
  const definition = (sql: string) => {
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.org_activity(");
    const end = "GRANT EXECUTE ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO authenticated;";
    return sql.slice(start, sql.indexOf(end, start) + end.length);
  };

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("replaces only org_activity: 080's definition plus exactly the variable and the two read-time filters; no table, row or grant change", () => {
    const sql = read(path.join("supabase/migrations", file()));
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION ([\w.]+)\(/g)].map((m) => m[1])).toEqual(["public.org_activity"]);
    const added = [
      "  v_row_audited TEXT[];\n",
      "  -- 094: the tables whose every row change the database records itself (security_audit.log_row_change).\n  v_row_audited := ARRAY(SELECT DISTINCT c.relname::TEXT FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid\n                         WHERE c.relnamespace = 'public'::regnamespace AND t.tgfoid = 'security_audit.log_row_change()'::regprocedure);\n",
    ];
    let def = definition(sql);
    for (const part of added) {
      expect(def.split(part)).toHaveLength(2);
      def = def.replace(part, "");
    }
    const filters = def.slice(def.indexOf("    -- 094 (a)"), def.indexOf("  ORDER BY a.created_at DESC, a.id DESC"));
    expect(filters).toContain("a.entity_table = ANY (v_row_audited)");
    expect(filters).toContain("n.hash = a.previous_hash");
    expect(filters).toContain("n.action IN ('ISSUE', 'MARK_PAID', 'RESEND', 'CONFIRM', 'REOPEN')");
    expect(filters).toContain("n.entity_table = a.entity_table AND n.entity_id = a.entity_id");
    expect(filters).toContain("n.actor_user_id IS NOT DISTINCT FROM a.actor_user_id");
    expect(def.replace(filters, "")).toBe(definition(m080()));
    const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    expect(outside).not.toMatch(/^\s*(ALTER TABLE|CREATE TABLE|CREATE POLICY|DROP POLICY|ALTER POLICY|CREATE TRIGGER|DROP TRIGGER|UPDATE |INSERT INTO|DELETE FROM)/m);
    expect(sql.replace(/GRANT EXECUTE ON FUNCTION public\.org_activity\([^)]*\) TO authenticated;/g, "")).not.toMatch(/\bGRANT [A-Z, ]+ ON\b/);
    // The guard accepts 080's and 094's body, the self-check pins 094's (md5 with every whitespace character removed).
    expect(md5(body(m080(), ORG))).toBe("ae7e2416ce0a54b0d8ccb721aeb2d245");
    expect(sql.split(md5(body(sql, ORG))).length).toBe(4);
    expect(sql.split(md5(body(m080(), ORG))).length).toBe(2);
    const verify = read("supabase/verify/activity_one_row_per_change_094.sql");
    expect(verify).toContain(`body = '${md5(body(sql, ORG))}'`);
    expect(read("supabase/verify/release_preflight.sql").split(md5(body(sql, ORG))).length).toBe(4);
  });

  it("its rollback puts back 080's org_activity exactly (with its grants), guarded by 094's and 080's bodies", () => {
    const rollback = read("supabase/release/094_activity_one_row_per_change.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(rollback).toContain(definition(m080()));
    expect([...rollback.matchAll(/CREATE OR REPLACE FUNCTION ([\w.]+)\(/g)].map((m) => m[1])).toEqual(["public.org_activity"]);
    expect(rollback).toContain(`'${md5(body(read(path.join("supabase/migrations", file())), ORG))}'`);
    expect(rollback).toContain(`'${md5(body(m080(), ORG))}'`);
  });
});

describe("prepared release text for the finance check's audit events (supabase/release, 095)", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const file = () => readdirSync(path.join(root, "supabase/migrations")).find((f) => f.endsWith("_ai_finance_check_audit_events.sql"))!;
  const md5 = (text: string) => createHash("md5").update(text.replace(/\s/g, "")).digest("hex");
  const AEA = "CREATE OR REPLACE FUNCTION public.audit_event_allowed(";
  const WA = "CREATE OR REPLACE FUNCTION public.write_audit(";
  const definition = (sql: string, head: string) => {
    const start = sql.indexOf(head);
    const end = head === WA ? "GRANT EXECUTE ON FUNCTION public.write_audit(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT) TO authenticated;" : "$function$;";
    return sql.slice(start, sql.indexOf(end, start) + end.length);
  };
  const body = (def: string) => {
    const start = def.indexOf("AS $function$") + "AS $function$".length;
    return def.slice(start, def.indexOf("$function$;", start));
  };
  const m076 = () => definition(read("supabase/migrations/076_data_import.sql"), AEA);
  const m035 = () => definition(read("supabase/migrations/035_who_did_what.sql"), WA);
  const AI = "'ai_finance_check_requested', 'ai_finance_check_completed', 'ai_suggestion_accepted', 'ai_suggestion_rejected'";

  it("is exactly what release-sql.mjs produces from the migration file", () => {
    const expected = releaseSql(read(path.join("supabase/migrations", file())), file());
    expect(read(path.join("supabase/release", file().replace(/\.sql$/, ".release.sql")))).toBe(expected);
  });

  it("replaces only audit_event_allowed (076's plus the four names on three tables) and write_audit (035's plus their metadata rule)", () => {
    const sql = read(path.join("supabase/migrations", file()));
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION ([\w.]+)\(/g)].map((m) => m[1])).toEqual(["public.audit_event_allowed", "public.write_audit"]);
    // The allow-list: exactly one added block, before 076's final RETURN FALSE.
    const allow = `  -- 095: Tolra AI agent 1, the pre-issue finance check (suggest only; lib/ai/finance-check/audit.ts). Its four events, on the three
  -- documents it checks only, for the roles that may run it (admin and office). write_audit (095) holds their metadata to the app's shape.
  IF p_action IN (${AI}) THEN
    RETURN p_table IN ('invoices', 'purchase_orders', 'credit_notes') AND public.has_org_role(ARRAY['admin', 'office']);
  END IF;
`;
    const aea = definition(sql, AEA);
    expect(aea.split(allow)).toHaveLength(2);
    expect(aea.replace(allow, "")).toBe(m076());
    // write_audit: exactly one added block (from its 095 comment to its END IF), before the size caps; only for the four names.
    const wa = definition(sql, WA);
    const start = wa.indexOf("  -- 095: the finance-check events");
    const end = wa.indexOf("  -- Size caps (rows are append-only forever");
    expect(start).toBeGreaterThan(0);
    const added = wa.slice(start, end);
    expect(added).toContain(`IF btrim(p_action) IN (${AI})\n     AND (CASE`);
    expect(added.trimEnd().endsWith("RAISE EXCEPTION 'You can''t record that event.' USING ERRCODE = '42501';\n  END IF;")).toBe(true);
    expect(wa.replace(added, "")).toBe(m035());
    // The codes are check.ts's SUGGESTION_CODES, in both places.
    const check = read("lib/ai/finance-check/check.ts");
    const codes = [...check.slice(check.indexOf("export const SUGGESTION_CODES"), check.indexOf("] as const;", check.indexOf("export const SUGGESTION_CODES"))).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(codes).toHaveLength(8);
    expect(added.split(`ARRAY[${codes.map((c) => `'${c}'`).join(", ")}]`)).toHaveLength(3);
    // No table, row, trigger, policy or grant change (write_audit's own REVOKE / GRANT come with 035's definition).
    const outside = sql.replace(/\$(function)?\$[\s\S]*?\$(function)?\$/g, "$$$$");
    expect(outside).not.toMatch(/^\s*(ALTER TABLE|CREATE TABLE|CREATE POLICY|DROP POLICY|ALTER POLICY|CREATE TRIGGER|DROP TRIGGER|UPDATE |INSERT INTO|DELETE FROM|DROP FUNCTION)/m);
    expect(sql.replace(/REVOKE ALL ON FUNCTION public\.write_audit\([^)]*\) FROM PUBLIC, anon;|GRANT EXECUTE ON FUNCTION public\.write_audit\([^)]*\) TO authenticated;/g, "")).not.toMatch(/\b(GRANT|REVOKE) [A-Z, ]+ ON\b/);
    // The guard accepts the old and new bodies, the self-check pins the new (md5 with every whitespace character removed).
    expect(md5(body(m076()))).toBe("35078684fa2379d7708c06fa7994dcf3");
    expect(md5(body(m035()))).toBe("959f759894cd9dbefbf8d25768530197");
    expect(md5(body(aea))).toBe("7e8d396511ddb056daa61953bfccd12b");
    expect(md5(body(wa))).toBe("a6531bb5559ae9936387729bb91071a0");
    for (const h of ["7e8d396511ddb056daa61953bfccd12b", "a6531bb5559ae9936387729bb91071a0"]) expect(sql.split(h).length).toBe(4);
    for (const h of ["35078684fa2379d7708c06fa7994dcf3", "959f759894cd9dbefbf8d25768530197"]) expect(sql.split(h).length).toBe(3);
    const verify = read("supabase/verify/ai_finance_check_audit_events_095.sql");
    expect(verify).toContain("body = '7e8d396511ddb056daa61953bfccd12b'");
    expect(verify).toContain("body = 'a6531bb5559ae9936387729bb91071a0'");
    const preflight = read("supabase/verify/release_preflight.sql");
    for (const h of ["7e8d396511ddb056daa61953bfccd12b", "a6531bb5559ae9936387729bb91071a0"]) expect(preflight.split(h).length).toBe(3);
  });

  it("its rollback puts back 076's audit_event_allowed and 035's write_audit exactly (with its grants), guarded by both bodies", () => {
    const rollback = read("supabase/release/095_ai_finance_check_audit_events.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(rollback).toContain(m076());
    expect(rollback).toContain(m035());
    expect([...rollback.matchAll(/CREATE OR REPLACE FUNCTION ([\w.]+)\(/g)].map((m) => m[1])).toEqual(["public.audit_event_allowed", "public.write_audit"]);
    for (const h of ["7e8d396511ddb056daa61953bfccd12b", "a6531bb5559ae9936387729bb91071a0", "35078684fa2379d7708c06fa7994dcf3", "959f759894cd9dbefbf8d25768530197"]) {
      expect(rollback).toContain(`'${h}'`);
    }
  });
});
