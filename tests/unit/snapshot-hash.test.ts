import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, snapshotSha256, verifySnapshot } from "@/lib/snapshot-hash";
import { formatSignedOn, initialsFrom, kindLabel, openCosignRoles, recordSha256, signOffStatus, signOffsByRevision, todayInLondon, type JobSignOff } from "@/lib/job-signoff";

import { CANONICAL_FIXTURES } from "../support/canonical-fixtures";

describe("canonicalJson (M4, migration 045)", () => {
  it("sorts keys by code point, keeps array order, no spaces", () => {
    expect(canonicalJson({ b: "1", a: ["z", "y"], c: { y: true, x: null } })).toBe('{"a":["z","y"],"b":"1","c":{"x":null,"y":true}}');
    // U+FF61 sorts before U+1F600 by code point (JavaScript's default sort would put the emoji first).
    expect(canonicalJson({ "😀": "e", "\uff61": "h" })).toBe('{"\uff61":"h","😀":"e"}');
    expect(canonicalJson({ B: "", a: "", "": "" })).toBe('{"":"","B":"","a":""}');
  });

  it("escapes strings exactly as JSON.stringify does", () => {
    for (const s of ["\"\\/", "\u0001\b\f\n\r\t\u001f\u007f", "é中😀\u2028"]) expect(canonicalJson(s)).toBe(JSON.stringify(s));
  });

  it("is the same text whatever order the keys were built in", () => {
    expect(canonicalJson({ a: "1", b: { d: "2", c: "3" } })).toBe(canonicalJson({ b: { c: "3", d: "2" }, a: "1" }));
  });

  it("refuses numbers and anything that isn't JSON text, booleans or null", () => {
    expect(() => canonicalJson({ qty: 2 })).toThrow(/numbers/);
    expect(() => canonicalJson({ x: undefined })).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
  });

  it("handles every fixture the SQL equivalence test uses", () => {
    for (const value of Object.values(CANONICAL_FIXTURES)) expect(() => canonicalJson(value)).not.toThrow();
  });
});

describe("sha256Hex / verifySnapshot", () => {
  it("is the lower-case hex SHA-256 of the UTF-8 bytes", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const text = canonicalJson(CANONICAL_FIXTURES.unicode);
    expect(await sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("verifies an untouched snapshot and rejects any change", async () => {
    const snapshot = { job_no: "J-1", checklist: { parts_clean: true }, drawing_no: "D-1" };
    const hash = await snapshotSha256(snapshot);
    expect(await verifySnapshot(snapshot, hash)).toBe(true);
    expect(await verifySnapshot({ ...snapshot, drawing_no: "D-2" }, hash)).toBe(false);
    expect(await verifySnapshot({ ...snapshot, qty: 1 }, hash)).toBe(false);
  });
});

const row = (worksheet_version: number, created_at: string, initials = "AB", kind: JobSignOff["kind"] = "primary"): JobSignOff => ({
  id: `${worksheet_version}-${created_at}`, job_id: "job", worksheet_version, snapshot: {}, snapshot_sha256: "a".repeat(64), record_sha256: "b".repeat(64),
  initials, signer_name: "A B", signed_on: "2026-10-13", signature_kind: "typed", signature_data: "A B", signed_by: "u", kind, created_at,
});

describe("sign-off state per revision", () => {
  it("signed for the current revision, stale after an edit, none without a sign-off", () => {
    const rows = [row(1, "2026-10-13T10:00:00Z", "AB"), row(1, "2026-10-13T11:00:00Z", "CD", "inspector"), row(0, "2026-10-12T09:00:00Z")];
    expect(signOffStatus(rows, 1)).toMatchObject({ status: "signed", latest: { initials: "AB", kind: "primary" }, cosigns: [{ initials: "CD", kind: "inspector" }] });
    expect(openCosignRoles(signOffStatus(rows, 1))).toEqual([]);
    expect(signOffStatus(rows, 2)).toMatchObject({ status: "stale", latest: { worksheet_version: 1, initials: "AB" }, currentVersion: 2 });
    expect(signOffStatus([], 0)).toEqual({ status: "none" });
    expect(signOffsByRevision(rows).map((g) => [g.version, g.rows.length])).toEqual([[1, 2], [0, 1]]);
  });

  it("only the primary makes a revision signed; the inspector role is open until it co-signs", () => {
    const primary = row(0, "2026-10-12T09:00:00Z");
    expect(signOffStatus([primary], 0)).toMatchObject({ status: "signed", cosigns: [] });
    expect(openCosignRoles(signOffStatus([primary], 0))).toEqual(["inspector"]);
    expect(signOffStatus([row(0, "2026-10-12T10:00:00Z", "CD", "inspector")], 0)).toEqual({ status: "none" });
    expect(openCosignRoles({ status: "none" })).toEqual([]);
    expect(kindLabel("primary")).toBe("Signed off");
    expect(kindLabel("inspector")).toBe("Inspector");
  });

  it("initials, the UK date and its display", () => {
    expect(initialsFrom("Rita Hale")).toBe("RH");
    expect(initialsFrom("Zoë Ann-Marie Smith-Jones")).toBe("ZAMS");
    expect(todayInLondon(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
    expect(todayInLondon(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
    expect(formatSignedOn("2026-10-13")).toBe("13 Oct 2026");
  });

  it("the record hash covers the signature fields", async () => {
    const base = { snapshot_sha256: "a".repeat(64), initials: "AB", signer_name: "A B", signed_on: "2026-10-13", signature_kind: "typed" as const, signature_data: "A B", worksheet_version: 1, job_id: "j", kind: "primary" as const };
    expect(await recordSha256(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(await recordSha256({ ...base, signature_data: "A C" })).not.toBe(await recordSha256(base));
    // The kind is in the hash input: the same signature as a co-signature is a different record.
    expect(await recordSha256({ ...base, kind: "inspector" })).not.toBe(await recordSha256(base));
    expect(await recordSha256(base)).toBe(await sha256Hex(canonicalJson({
      snapshot_sha256: "a".repeat(64), initials: "AB", signer_name: "A B", signed_on: "2026-10-13", signature_kind: "typed", signature_data: "A B", worksheet_version: "1", job_id: "j", kind: "primary" })));
  });
});
