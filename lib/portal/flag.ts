/**
 * BOUNDARY: lib/portal/flag.ts. Input: an env object (default process.env). Output: whether the PLATFORM switch is on.
 * True only for exactly "true" (not "1", "TRUE", " true"). Unset is OFF. The company switch (release 153) is enforced by the database.
 * Must not read any other variable or have side effects.
 */
export function portalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CUSTOMER_PORTAL_ENABLED === "true";
}
