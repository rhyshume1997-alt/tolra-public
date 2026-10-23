import { describe, expect, it } from "vitest";

import { ALERT_TEST_NETWORK_ERROR, describeAlertTest } from "@/lib/alert-test-message";

describe("describeAlertTest", () => {
  it("says sent and where to look", () => {
    expect(describeAlertTest(200, { sent: true, reason: "sent" })).toEqual({ tone: "success", text: "Sent. Check the inbox for ALERT_EMAIL_TO (and spam)." });
  });

  it.each([
    ["disabled", /ALERT_EMAIL_TO is not set/],
    ["not-production", /not the Production deployment/],
    ["rate-limited", /one test is allowed per hour/],
    ["no-provider", /RESEND_API_KEY/],
    ["no-sender", /EMAIL_FROM/],
    ["send-failed", /did not accept the message/],
  ])("explains %s", (reason, pattern) => {
    const outcome = describeAlertTest(200, { sent: false, reason });
    expect(outcome.tone).toBe("warning");
    expect(outcome.text).toMatch(/^Not sent:/);
    expect(outcome.text).toMatch(pattern);
  });

  it("adds the route hint after a known reason", () => {
    const outcome = describeAlertTest(200, { sent: false, reason: "disabled", hint: "Set ALERT_EMAIL_TO in the Production environment and redeploy." });
    expect(outcome.text).toMatch(/switched off\. .*redeploy\.$/);
  });

  it("shows an unknown reason with its hint", () => {
    expect(describeAlertTest(200, { sent: false, reason: "weird", hint: "Do a thing." })).toEqual({ tone: "warning", text: "Not sent: weird. Do a thing." });
    expect(describeAlertTest(200, { sent: false }).text).toBe("Not sent: unknown reason.");
  });

  it("does not treat object prototype keys as known reasons", () => {
    expect(describeAlertTest(200, { sent: false, reason: "constructor" }).text).toBe("Not sent: constructor.");
  });

  it("never echoes long or extra fields", () => {
    const outcome = describeAlertTest(200, { sent: false, reason: "x".repeat(500), secret: "sk_live_123", error: { stack: "boom" } });
    expect(outcome.text.length).toBeLessThan(120);
    expect(outcome.text).not.toMatch(/sk_live|boom/);
  });

  it("says admins only for 401 and 403", () => {
    expect(describeAlertTest(401, null)).toEqual({ tone: "error", text: "Not allowed: admins only." });
    expect(describeAlertTest(403, { error: "Forbidden" })).toEqual({ tone: "error", text: "Not allowed: admins only." });
  });

  it("handles other HTTP errors and unreadable bodies", () => {
    expect(describeAlertTest(500, { error: "x" }).tone).toBe("error");
    expect(describeAlertTest(500, null).text).toMatch(/500/);
    expect(describeAlertTest(200, null).tone).toBe("error");
  });

  it("has a plain network error", () => {
    expect(ALERT_TEST_NETWORK_ERROR.text).toMatch(/Could not reach the server/);
  });
});
