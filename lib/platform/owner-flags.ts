/**
 * BOUNDARY: lib/platform/owner-flags.ts. Input: an env object (default process.env). Output: whether each owner-only platform screen is on.
 * True only for exactly "true" (not "1", "TRUE", " true"). Unset is OFF, so a deploy of this code changes nothing until Rhys sets a flag.
 * PLATFORM_ROADMAP_ENABLED switches the Roadmap screen and its route; PLATFORM_ROLLOUTS_ENABLED switches the Rollouts screen and its route.
 * Must not read any other variable or have side effects. The database (release 167) and the platform-owner check are enforced separately.
 */
export function roadmapEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PLATFORM_ROADMAP_ENABLED === "true";
}

export function rolloutsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PLATFORM_ROLLOUTS_ENABLED === "true";
}
