import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Grok's pre-push nit: 101's header said "seven functions" while the file creates eight. The header, the release
// copy and the rollback must all name the same count as the functions the file actually creates and the rollback drops.
const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const migration = read("supabase/migrations/101_ai_helper.sql");
const release = read("supabase/release/101_ai_helper.release.sql");
const rollback = read("supabase/release/101_ai_helper.rollback.sql");

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const created = (sql: string) => [...sql.matchAll(/^CREATE OR REPLACE FUNCTION public\.(\w+)\(/gm)].map((m) => m[1]);
const dropped = (sql: string) => [...sql.matchAll(/^DROP FUNCTION IF EXISTS public\.(\w+)\(/gm)].map((m) => m[1]);
const header = (sql: string) => sql.split("\n").filter((l) => l.startsWith("--")).join("\n");

describe("101 header: the function count matches the file", () => {
  const names = created(migration);

  it("the migration creates eight functions: six the app calls and two internal helpers", () => {
    expect(names).toHaveLength(8);
    expect(names.filter((n) => n.startsWith("_"))).toEqual(["_ai_helper_audit", "_ai_helper_caller"]);
  });

  it("the migration, release and rollback headers all say eight, never seven", () => {
    const word = WORDS[names.length];
    for (const sql of [migration, release, rollback]) {
      const h = header(sql);
      expect(h).toMatch(new RegExp(`\\b${word} functions\\b`));
      expect(h).not.toMatch(/\bseven functions\b/);
    }
  });

  it("the header names both internal helpers, and the rollback drops every function the file creates", () => {
    for (const sql of [migration, release]) {
      expect(header(sql)).toMatch(/_ai_helper_audit and _ai_helper_caller/);
    }
    expect(dropped(rollback).sort()).toEqual([...names].sort());
  });
});
