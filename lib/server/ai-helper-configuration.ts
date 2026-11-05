import "server-only";

import { encryptionKey } from "@/lib/integrations/crypto";

/** Readiness only. Never calls a provider, reads a saved key or changes a switch. */
export function aiHelperConfiguration(keySet: boolean, env: Record<string, string | undefined> = process.env) {
  let encryptionReady = false;
  try { encryptionKey(env); encryptionReady = true; } catch { /* no secret/error in status */ }
  const serverEnabled = env.AI_HELPER_ENABLED === "true";
  const provider = env.AI_HELPER_PROVIDER ?? "anthropic";
  const testOnly = provider === "mock";
  const backendReady = Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && encryptionReady);
  return {
    server_enabled: serverEnabled,
    provider_state: testOnly ? "mock_only" : provider !== "anthropic" ? "unsupported" : keySet ? "key_present" : "not_configured",
    configuration_ready: backendReady && keySet && (provider === "anthropic" || (testOnly && !env.VERCEL_ENV)),
    configuration_message: !serverEnabled ? "AI requests are off on this server. Admins can prepare company settings without making an AI call."
      : testOnly ? "Mock responses only. No live provider is connected."
      : provider !== "anthropic" ? "This AI provider is not supported. An operator must check the server configuration."
      : !backendReady ? "Server configuration is incomplete. An operator must check AI storage and encryption settings."
      : !keySet ? "Provider not configured: add this company's own Anthropic key. No request can run without credentials."
      : "Key present. Provider acceptance requires a separately authorised request; this is not a connection test.",
  };
}
