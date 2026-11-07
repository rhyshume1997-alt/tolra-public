/**
 * The rehearsal fails LOUDLY when its disposable database is missing, and refuses any database that is not on this machine. It never skips and
 * never falls back to another database.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createRehearsalDb, RehearsalDatabaseMissing } from "./support/db";

const saved = { url: process.env.IMPORT_REHEARSAL_ADMIN_URL, tpl: process.env.IMPORT_REHEARSAL_TEMPLATE };
afterEach(() => {
  for (const [k, v] of [["IMPORT_REHEARSAL_ADMIN_URL", saved.url], ["IMPORT_REHEARSAL_TEMPLATE", saved.tpl]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("missing or unsafe database", () => {
  it("no server listening -> a RehearsalDatabaseMissing error that says how to start one", async () => {
    process.env.IMPORT_REHEARSAL_ADMIN_URL = "postgresql://postgres@127.0.0.1:1/postgres";
    await expect(createRehearsalDb("nodb")).rejects.toThrow(RehearsalDatabaseMissing);
    await expect(createRehearsalDb("nodb")).rejects.toThrow(/start-pg\.sh/);
  });

  it("server up but no template database -> RehearsalDatabaseMissing that says how to build it", async () => {
    process.env.IMPORT_REHEARSAL_TEMPLATE = "sliq_rehearsal_does_not_exist";
    await expect(createRehearsalDb("notpl")).rejects.toThrow(/template database sliq_rehearsal_does_not_exist does not exist/);
    await expect(createRehearsalDb("notpl")).rejects.toThrow(/build-template\.sh/);
  });

  it.each([
    "postgresql://postgres@db.example.com:5432/postgres",
    "postgresql://postgres:pw@db.qngvemzbdsvtydkbplpo.supabase.co:5432/postgres", // the production project ref and a hosted address
    "postgresql://postgres@10.0.0.5:5432/postgres",
  ])("%s -> refused before any connection is attempted", async (url) => {
    process.env.IMPORT_REHEARSAL_ADMIN_URL = url;
    await expect(createRehearsalDb("remote")).rejects.toThrow(/Isolated test backend required/);
  });
});
