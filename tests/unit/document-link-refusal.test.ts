/** tests/unit/document-link-refusal.test.ts. lib/customers/document-link-refusal.ts: which database refusals are security events, and the five-field log line. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DocumentLinkErrorCode } from "@/lib/customers/document-links";
import { logLinkRefusal, securityRefusalCategory } from "@/lib/customers/document-link-refusal";

afterEach(() => vi.restoreAllMocks());

describe("security refusal categories", () => {
  it("maps only role, authenticator and other-company refusals", () => {
    expect(securityRefusalCategory("admin_required")).toBe("role");
    expect(securityRefusalCategory("admin_or_office_required")).toBe("role");
    expect(securityRefusalCategory("mfa_required")).toBe("mfa");
    expect(securityRefusalCategory("mfa_recent_required")).toBe("mfa_recent");
    expect(securityRefusalCategory("link_other_company")).toBe("other_company");
  });
  it("validation and business refusals are not security events", () => {
    const rest: DocumentLinkErrorCode[] = ["reason_required", "invalid_kind", "document_not_found", "customer_not_found", "internal_job", "customer_mismatch",
      "identity_not_confirmed", "names_match", "no_customer_text", "already_linked", "not_linked", "invalid_batch", "not_pending", "link_not_found",
      "link_stale", "link_immutable", "invalid_enabled", "unknown"];
    for (const code of rest) expect(securityRefusalCategory(code)).toBeNull();
  });
});

describe("logLinkRefusal", () => {
  it("writes one warn line with exactly the five fields", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logLinkRefusal({ organizationId: "org-1", actorId: "user-1", action: "link", category: "role", now: new Date("2026-11-12T10:00:00Z") });
    expect(warn).toHaveBeenCalledTimes(1);
    const [prefix, json] = warn.mock.calls[0] as [string, string];
    expect(prefix).toBe("[customers] link refused:");
    expect(JSON.parse(json)).toEqual({ organization_id: "org-1", actor_id: "user-1", action: "link", at: "2026-11-12T10:00:00.000Z", category: "role" });
  });
  it("ignores any extra property handed to it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logLinkRefusal({ organizationId: "o", actorId: "u", action: "verify", category: "mfa", reason: "secret", code: "123456" } as never);
    expect(Object.keys(JSON.parse(warn.mock.calls[0][1] as string)).sort()).toEqual(["action", "actor_id", "at", "category", "organization_id"]);
  });
});
