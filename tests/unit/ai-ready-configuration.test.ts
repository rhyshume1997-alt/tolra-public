import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { aiHelperConfiguration } from "@/lib/server/ai-helper-configuration";
import { AiCustomisedCard } from "@/components/ai-helper/customised-card";

const configured = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  INTEGRATIONS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };

describe("AI readiness without activating or contacting a provider", () => {
  it("stays server-off while showing whether this company has a key", () => {
    expect(aiHelperConfiguration(false, {})).toMatchObject({ server_enabled: false, provider_state: "not_configured", configuration_ready: false });
    expect(aiHelperConfiguration(true, configured)).toMatchObject({ server_enabled: false, provider_state: "key_present", configuration_ready: true });
    expect(aiHelperConfiguration(true, configured).configuration_message).toMatch(/requests are off/);
  });

  it("distinguishes missing key, missing server configuration, present key and an unsupported provider", () => {
    const on = { ...configured, AI_HELPER_ENABLED: "true" };
    expect(aiHelperConfiguration(false, on).configuration_message).toMatch(/Provider not configured/);
    expect(aiHelperConfiguration(true, { ...on, INTEGRATIONS_ENCRYPTION_KEY: "wrong" })).toMatchObject({ configuration_ready: false });
    expect(aiHelperConfiguration(true, on).configuration_message).toMatch(/not a connection test/);
    expect(aiHelperConfiguration(true, { ...on, AI_HELPER_PROVIDER: "unknown" })).toMatchObject({ provider_state: "unsupported", configuration_ready: false });
    expect(JSON.stringify(aiHelperConfiguration(true, on))).not.toContain(configured.SUPABASE_SERVICE_ROLE_KEY);
    expect(JSON.stringify(aiHelperConfiguration(true, on))).not.toContain(configured.INTEGRATIONS_ENCRYPTION_KEY);
  });

  it("marks mocks explicitly, and never makes deployed mocks ready", () => {
    expect(aiHelperConfiguration(true, { ...configured, AI_HELPER_ENABLED: "true", AI_HELPER_PROVIDER: "mock" })).toMatchObject({ provider_state: "mock_only", configuration_ready: true });
    expect(aiHelperConfiguration(true, { ...configured, AI_HELPER_PROVIDER: "mock", VERCEL_ENV: "production" })).toMatchObject({ provider_state: "mock_only", configuration_ready: false });
  });

  it("shows the 1000p company cap, spend, reservations, off/configuration status and admin controls", () => {
    const html = renderToStaticMarkup(createElement(AiCustomisedCard, { status: {
      roundup_enabled: false, rfq_enabled: false, monthly_cap_pence: 1000, key_set: false, key_last4: null,
      month_spent_pence: 135, month_reserved_pence: 20, can_manage: true, ...aiHelperConfiguration(false, {}),
    }, onStatus: () => {} }));
    for (const text of ["Provider not configured", "requests are off", "£10.00", "£1.35", "£0.20", "Save monthly limit", "Save key"]) expect(html).toContain(text);
  });
});
