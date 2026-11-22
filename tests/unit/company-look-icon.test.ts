/**
 * Company look (module 12): the company icon is a real square PNG at each size, in both the normal and the maskable art.
 */
import { describe, expect, it, vi } from "vitest";

import { pngSize } from "@/lib/png";

vi.mock("server-only", () => ({}));

// 1x1 red PNG.
const LOGO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("companyIconResponse", () => {
  it.each([[32, false], [180, false], [192, false], [512, false], [512, true]])("renders a %ipx PNG (maskable: %s)", async (size, maskable) => {
    const { companyIconResponse } = await import("@/lib/company-look/company-icon");
    const response = companyIconResponse({ primary: "#112233", logo: { bytes: LOGO, type: "image/png" }, size, maskable, headers: { "Cache-Control": "private, max-age=60", Vary: "Cookie" } });
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(pngSize(Buffer.from(await response.arrayBuffer()))).toEqual({ width: size, height: size });
  });
});
