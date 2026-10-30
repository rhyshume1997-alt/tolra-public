/**
 * Migration 105 (S5-A1): an issued invoice is written off, and a write-off reversed, only through write_off_invoice / reverse_write_off.
 * The client calls (what is sent, the reason rules, the plain-English refusals and the "Available after database update 105" fallback),
 * when the actions are offered, the history labels, and the release files (release text, the three bodies' md5s in the migration's
 * own checks, the verify file, the preflight marker and the rollback). The database behaviour is proved by tests/db/invoice-write-off-105
 * (CI) and tests/scripts/invoice-write-off-105.sql (psql on a disposable copy).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { describeEntry, type ActivityEntry } from "@/lib/activity";
import {
  WRITE_OFF_NEEDS_UPDATE, type WriteOffClient, isWrittenOff, reverseWriteOff, writeOffInvoice, writeOffOffered, writeOffReasonProblem, writeOffRefusalMessage,
} from "@/lib/invoice-write-off";
import { releaseSql } from "../../scripts/release-sql.mjs";

type Call = { fn: string; args: { p_invoice_id: string; p_reason: string } };
function client(result: { data?: unknown; error: { code?: string; message?: string; hint?: string } | null } | Error) {
  const calls: Call[] = [];
  const c: WriteOffClient = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ data: result.data ?? null, error: result.error });
    },
  };
  return { c, calls };
}

const ID = "11111111-2222-3333-4444-555555555555";
const REASON = "  Customer has gone into liquidation  ";

describe("writeOffInvoice / reverseWriteOff (the client calls)", () => {
  it("calls write_off_invoice with the invoice id and the trimmed reason", async () => {
    const { c, calls } = client({ data: { status: "written_off" }, error: null });
    expect(await writeOffInvoice(c, ID, REASON)).toEqual({ ok: true });
    expect(calls).toEqual([{ fn: "write_off_invoice", args: { p_invoice_id: ID, p_reason: "Customer has gone into liquidation" } }]);
  });

  it("calls reverse_write_off for a reversal", async () => {
    const { c, calls } = client({ data: { status: "issued" }, error: null });
    expect(await reverseWriteOff(c, ID, "Customer paid after all")).toEqual({ ok: true });
    expect(calls).toEqual([{ fn: "reverse_write_off", args: { p_invoice_id: ID, p_reason: "Customer paid after all" } }]);
  });

  it("a reason under 10 characters (after trimming) or over 500 is refused before anything is sent", async () => {
    for (const reason of ["", "   ", "too short", "        x        ", "x".repeat(501)]) {
      const { c, calls } = client({ error: null });
      const result = await writeOffInvoice(c, ID, reason);
      expect(result).toEqual({ ok: false, error: "Give the reason the invoice is being written off (10 to 500 characters)." });
      expect(calls).toHaveLength(0);
    }
    const { c, calls } = client({ error: null });
    expect(await reverseWriteOff(c, ID, "short")).toEqual({ ok: false, error: "Give the reason the write-off is being reversed (10 to 500 characters)." });
    expect(calls).toHaveLength(0);
    expect(writeOffReasonProblem("exactly 10")).toBeNull();
    expect(writeOffReasonProblem("x".repeat(500))).toBeNull();
  });

  it("before 105 is applied (function missing, any code): 'Available after database update 105'", async () => {
    for (const error of [
      { code: "PGRST202", message: "Could not find the function public.write_off_invoice(p_invoice_id, p_reason) in the schema cache" },
      { code: "42883", message: "function public.write_off_invoice(uuid, text) does not exist" },
      { message: "Could not find the function public.reverse_write_off in the schema cache" },
    ]) {
      const w = client({ error });
      expect(await writeOffInvoice(w.c, ID, REASON)).toEqual({ ok: false, error: WRITE_OFF_NEEDS_UPDATE });
      const r = client({ error });
      expect(await reverseWriteOff(r.c, ID, REASON)).toEqual({ ok: false, error: WRITE_OFF_NEEDS_UPDATE });
    }
    expect(WRITE_OFF_NEEDS_UPDATE).toContain("Available after database update 105");
  });

  it("maps each database refusal (by its hint) to plain English", async () => {
    const cases: Array<[string, string]> = [
      ["invoice_already_written_off", "This invoice has already been written off."],
      ["invoice_draft", "A draft invoice isn't owed yet, so there is nothing to write off: delete the draft instead."],
      ["invoice_void", "This invoice is void, so there is nothing to write off."],
      ["invoice_payments_unconfirmed", "This invoice has imported payments still to be confirmed, so it can't be written off yet."],
      ["invoice_nothing_owed", "This invoice has nothing left to pay, so there is nothing to write off."],
      ["invoice_not_written_off", "This invoice hasn't been written off, so there is nothing to reverse."],
      ["write_off_reason_required", "Give the reason the invoice is being written off (10 to 500 characters)."],
      ["mfa_required", "Confirm your authenticator code first (second step of sign-in)."],
    ];
    for (const [hint, message] of cases) {
      const { c } = client({ error: { code: hint === "mfa_required" ? "42501" : "22023", message: "raw database text", hint } });
      expect(await writeOffInvoice(c, ID, REASON)).toEqual({ ok: false, error: message });
    }
    expect(writeOffRefusalMessage({ code: "22023", hint: "write_off_reason_required" }, "reverse")).toBe("Give the reason the write-off is being reversed (10 to 500 characters).");
  });

  it("not found, not authorised, an unknown failure and a thrown error", async () => {
    expect(writeOffRefusalMessage({ code: "P0002", message: "Invoice not found" })).toBe("That invoice wasn't found. Reload the page and try again.");
    expect(writeOffRefusalMessage({ code: "42501", message: "not authorised" })).toBe("Only admin and office staff can write off invoices.");
    expect(writeOffRefusalMessage({ code: "42501", message: "not authorised" }, "reverse")).toBe("Only admin and office staff can reverse a write-off.");
    // A raw Postgres message is never shown.
    expect(writeOffRefusalMessage({ code: "XX000", message: "relation public.invoices violates something" })).not.toContain("relation");
    const { c } = client(new Error("Failed to fetch"));
    const thrown = await writeOffInvoice(c, ID, REASON);
    expect(thrown.ok).toBe(false);
  });
});

describe("when Write off and Reverse write-off are offered", () => {
  const inv = (over: Partial<Parameters<typeof writeOffOffered>[0]>) => ({ rawStatus: "issued", amount: 120, amountPaid: 0, credited: 0, refunded: 0, paymentUnverified: false, ...over });

  it("issued, sent and part paid with something left to pay", () => {
    expect(writeOffOffered(inv({}))).toBe(true);
    expect(writeOffOffered(inv({ rawStatus: "sent" }))).toBe(true);
    expect(writeOffOffered(inv({ rawStatus: "partial", amountPaid: 20 }))).toBe(true);
  });

  it("not for drafts, void, paid, credited in full, written off, or imported payments to confirm", () => {
    for (const rawStatus of ["draft", "void", "cancelled", "paid", "credited", "written_off"]) expect(writeOffOffered(inv({ rawStatus }))).toBe(false);
    expect(writeOffOffered(inv({ amountPaid: 120 }))).toBe(false);
    expect(writeOffOffered(inv({ credited: 120 }))).toBe(false);
    expect(writeOffOffered(inv({ paymentUnverified: true }))).toBe(false);
  });

  it("Reverse write-off only on a written-off invoice", () => {
    expect(isWrittenOff("written_off")).toBe(true);
    expect(isWrittenOff(" Written_Off ")).toBe(true);
    for (const s of ["issued", "sent", "partial", "void", null, undefined]) expect(isWrittenOff(s)).toBe(false);
  });
});

describe("history labels", () => {
  const entry = (action: string): ActivityEntry => ({
    id: action, created_at: "2026-10-30T07:00:00Z", actor_name: "Alice", actor_email: "a@x", action, entity_table: "invoices", entity_id: ID,
    changes: null, snapshot: null, metadata: { source: "write_audit", reason: "Customer has gone into liquidation", invoice_ref: "INV-1" },
  });
  it("names both events and shows the reason", () => {
    expect(describeEntry(entry("WRITE_OFF_INVOICE"))).toEqual({ title: "Invoice written off", details: ["Reason: Customer has gone into liquidation"] });
    expect(describeEntry(entry("REVERSE_WRITE_OFF"))).toEqual({ title: "Write-off reversed", details: ["Reason: Customer has gone into liquidation"] });
  });
});

describe("prepared release files for 105 (supabase/release, verify, preflight)", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const FILE = "105_invoice_write_off.sql";
  const sql = () => read(`supabase/migrations/${FILE}`);
  const md5 = (text: string) => createHash("md5").update(text.replace(/\s/g, "")).digest("hex");
  const body = (name: string) => {
    const s = sql();
    const start = s.indexOf("AS $$", s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)) + "AS $$".length;
    return s.slice(start, s.indexOf("$$;", start));
  };
  const BODIES: Array<[string, string]> = [
    ["invoices_write_off_guard", "6ec5e742ef64fe23121c8099c42d2200"],
    ["write_off_invoice", "c7449f4564711533d43a1aa252eddfdf"],
    ["reverse_write_off", "4750ac042335694164b634edca559f23"],
  ];

  it("the release text is exactly what release-sql.mjs produces from the migration file", () => {
    expect(read(`supabase/release/${FILE.replace(/\.sql$/, ".release.sql")}`)).toBe(releaseSql(sql(), FILE));
  });

  it("creates only its three functions and one trigger: no table, row, policy or other grant", () => {
    expect([...sql().matchAll(/CREATE OR REPLACE FUNCTION ([\w.]+)\(/g)].map((m) => m[1])).toEqual(BODIES.map(([n]) => `public.${n}`));
    const outside = sql().replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    expect(outside.match(/^CREATE TRIGGER .*$/gm)).toEqual(["CREATE TRIGGER invoices_write_off_guard BEFORE UPDATE OF status ON public.invoices"]);
    expect(outside).not.toMatch(/^\s*(CREATE TABLE|ALTER TABLE|CREATE POLICY|DROP POLICY|ALTER POLICY|UPDATE |INSERT INTO|DELETE FROM|DROP FUNCTION)/m);
    expect(outside.match(/^(GRANT|REVOKE) .*$/gm)).toEqual([
      "REVOKE ALL ON FUNCTION public.invoices_write_off_guard() FROM PUBLIC, anon, authenticated;",
      "REVOKE ALL ON FUNCTION public.write_off_invoice(UUID, TEXT) FROM PUBLIC, anon;",
      "GRANT EXECUTE ON FUNCTION public.write_off_invoice(UUID, TEXT) TO authenticated;",
      "REVOKE ALL ON FUNCTION public.reverse_write_off(UUID, TEXT) FROM PUBLIC, anon;",
      "GRANT EXECUTE ON FUNCTION public.reverse_write_off(UUID, TEXT) TO authenticated;",
    ]);
  });

  it("the md5s in the migration's guard and self-check, the verify file, the preflight marker and the rollback are the bodies'", () => {
    const verify = read("supabase/verify/invoice_write_off_105.sql");
    const preflight = read("supabase/verify/release_preflight.sql");
    const rollback = read("supabase/release/105_invoice_write_off.rollback.sql");
    expect(preflight).toContain("('105 invoice write-off'");
    for (const [name, hash] of BODIES) {
      expect(md5(body(name)), name).toBe(hash);
      expect(sql().split(`'${hash}'`).length - 1, `${name} in the guard and the self-check`).toBe(2);
      expect(verify).toContain(`'${hash}'`);
      expect(rollback).toContain(`'${hash}'`);
      if (name !== "invoices_write_off_guard") expect(preflight).toContain(`'${hash}'`);
    }
  });

  it("both steps start with the second-step check and take the invoice lock in the caller's company", () => {
    for (const name of ["write_off_invoice", "reverse_write_off"]) {
      const b = body(name);
      expect(b.indexOf("PERFORM public.assert_privileged_aal();")).toBeGreaterThan(-1);
      expect(b.indexOf("PERFORM public.assert_privileged_aal();")).toBeLessThan(b.indexOf("has_org_role(ARRAY['admin', 'office'])"));
      expect(b).toContain("WHERE i.id = p_invoice_id AND i.organization_id = v_org FOR UPDATE");
      expect(b).toContain("set_config('quoteflow.invoice_write_off', p_invoice_id::TEXT, TRUE)");
    }
  });

  it("the rollback is one transaction that drops exactly what 105 made", () => {
    const rollback = read("supabase/release/105_invoice_write_off.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(rollback.match(/^DROP .*$/gm)).toEqual([
      "DROP TRIGGER IF EXISTS invoices_write_off_guard ON public.invoices;",
      "DROP FUNCTION IF EXISTS public.invoices_write_off_guard();",
      "DROP FUNCTION IF EXISTS public.write_off_invoice(UUID, TEXT);",
      "DROP FUNCTION IF EXISTS public.reverse_write_off(UUID, TEXT);",
    ]);
  });
});
