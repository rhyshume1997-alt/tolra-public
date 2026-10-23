/**
 * What the live Microsoft 365 suite needs before it may start, and the only tenant it may ever touch. Kept apart from
 * the suite so a normal unit run can test the refusals (tests/unit/m365-live-guards.test.ts) without any network.
 */

/** The test tenant. A real company's tenant also has an .onmicrosoft.com domain, so the suffix alone is not enough. */
export const TEST_TENANT_DOMAIN = "fixture-tolra.onmicrosoft.com";

export const REQUIRED = [
  "MS_TEST_TENANT_ID",
  "MS_TEST_CLIENT_ID",
  "MS_TEST_CLIENT_SECRET",
  "MS_TEST_MAILBOX",
  "MS_TEST_DENIED_MAILBOX",
  "MS_TEST_EXTERNAL_TO",
] as const;

export type LiveConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The one mailbox the app is allowed to use. */
  mailbox: string;
  /** A real mailbox in the test tenant (the tenant admin's) that the app must NOT be able to read or send from. */
  deniedMailbox: string;
  externalTo: string;
};

const domainOf = (address: string) => address.split("@")[1] ?? "";

/** The settings, or the reason the suite refuses to run (never includes a value of a secret). */
export function liveConfig(env: Record<string, string | undefined>): { ok: true; config: LiveConfig } | { ok: false; problem: string } {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length) return { ok: false, problem: `Refusing to run: set ${missing.join(", ")} (all of ${REQUIRED.join(", ")} are needed).` };
  const config: LiveConfig = {
    tenantId: env.MS_TEST_TENANT_ID!.trim(),
    clientId: env.MS_TEST_CLIENT_ID!.trim(),
    clientSecret: env.MS_TEST_CLIENT_SECRET!.trim(),
    mailbox: env.MS_TEST_MAILBOX!.trim().toLowerCase(),
    deniedMailbox: env.MS_TEST_DENIED_MAILBOX!.trim().toLowerCase(),
    externalTo: env.MS_TEST_EXTERNAL_TO!.trim().toLowerCase(),
  };
  for (const [name, address] of [["MS_TEST_MAILBOX", config.mailbox], ["MS_TEST_DENIED_MAILBOX", config.deniedMailbox]] as const) {
    if (domainOf(address) !== TEST_TENANT_DOMAIN) return { ok: false, problem: `Refusing to run: ${name} must be a test-tenant mailbox (@${TEST_TENANT_DOMAIN}).` };
  }
  if (config.mailbox === config.deniedMailbox) return { ok: false, problem: "Refusing to run: MS_TEST_DENIED_MAILBOX must be a different mailbox from MS_TEST_MAILBOX." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.externalTo)) return { ok: false, problem: "Refusing to run: MS_TEST_EXTERNAL_TO is not an e-mail address." };
  const denied = (env.MS_MAILBOX_DENY_DOMAINS || "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if ([config.mailbox, config.deniedMailbox, config.externalTo].some((address) => denied.includes(domainOf(address)))) {
    return { ok: false, problem: "Refusing to run: a test address is on MS_MAILBOX_DENY_DOMAINS." };
  }
  return { ok: true, config };
}
