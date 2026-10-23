import { describe, expect, it } from "vitest";

import { clientIp } from "@/lib/server/auth";

const request = (headers: Record<string, string>) => new Request("http://localhost/api/auth/signin", { headers });

describe("client IP for rate limiting (audit SEC10)", () => {
  it("prefers the platform's x-real-ip", () => {
    expect(clientIp(request({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1, 203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("ignores client-supplied first hops of x-forwarded-for", () => {
    const a = clientIp(request({ "x-forwarded-for": "1.1.1.1, 198.51.100.9" }));
    const b = clientIp(request({ "x-forwarded-for": "2.2.2.2, 198.51.100.9" }));
    expect(a).toBe("198.51.100.9");
    expect(b).toBe(a);
  });

  it("returns null without any forwarding header", () => {
    expect(clientIp(request({}))).toBeNull();
  });
});
