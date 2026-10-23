/** The live suite refuses to start anywhere but the test tenant (tests/live/guards.ts); nothing here touches a network. */
import { describe, expect, it } from "vitest";

import { liveConfig, REQUIRED, TEST_TENANT_DOMAIN } from "../live/guards";

const good = {
  MS_TEST_TENANT_ID: "t",
  MS_TEST_CLIENT_ID: "c",
  MS_TEST_CLIENT_SECRET: "s3cret",
  MS_TEST_MAILBOX: `Tolra.Test@${TEST_TENANT_DOMAIN}`,
  MS_TEST_DENIED_MAILBOX: `admin@${TEST_TENANT_DOMAIN}`,
  MS_TEST_EXTERNAL_TO: "someone@example.test",
};

describe("live suite guards", () => {
  it("accepts a complete test tenant setup", () => {
    const r = liveConfig(good);
    expect(r.ok && r.config.mailbox).toBe(`tolra.test@${TEST_TENANT_DOMAIN}`);
  });

  it("needs all six values", () => {
    expect(REQUIRED).toHaveLength(6);
    for (const key of REQUIRED) {
      const r = liveConfig({ ...good, [key]: "" });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.problem).toContain(key);
    }
  });

  it("refuses any mailbox outside the test tenant, including another .onmicrosoft.com tenant, for both mailboxes", () => {
    for (const key of ["MS_TEST_MAILBOX", "MS_TEST_DENIED_MAILBOX"]) {
      for (const mailbox of ["boss@jnr.example", "boss@fixture-prod.onmicrosoft.com", `x@sub.${TEST_TENANT_DOMAIN}`]) {
        const r = liveConfig({ ...good, [key]: mailbox });
        expect(r.ok, `${key} ${mailbox}`).toBe(false);
        expect(!r.ok && r.problem).toMatch(/test-tenant mailbox/);
      }
    }
  });

  it("the denied mailbox must be a different mailbox", () => {
    expect(liveConfig({ ...good, MS_TEST_DENIED_MAILBOX: good.MS_TEST_MAILBOX }).ok).toBe(false);
  });

  it("refuses a denied domain for any address, and never repeats a secret", () => {
    expect(liveConfig({ ...good, MS_MAILBOX_DENY_DOMAINS: TEST_TENANT_DOMAIN }).ok).toBe(false);
    expect(liveConfig({ ...good, MS_MAILBOX_DENY_DOMAINS: "example.test" }).ok).toBe(false);
    for (const r of [liveConfig({ ...good, MS_TEST_EXTERNAL_TO: "nope" }), liveConfig({ ...good, MS_TEST_MAILBOX: "x@jnr.example" })]) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("s3cret");
    }
  });

  it("is not part of the unit or database runs", async () => {
    const unit = (await import("../../vitest.config")).default;
    const db = (await import("../../vitest.db.config")).default;
    const live = (await import("../../vitest.live.config")).default;
    expect(unit.test?.include).toEqual(["tests/unit/**/*.test.ts"]);
    expect(db.test?.include).toEqual(["tests/db/**/*.test.ts"]);
    expect(live.test?.include).toEqual(["tests/live/**/*.live.test.ts"]);
  });
});
