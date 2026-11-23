// The owner issues inbox's server flag. Inputs: the server environment. Outputs: a boolean. Must not change: OFF unless OWNER_ISSUES_ENABLED
// is exactly "true" (not NEXT_PUBLIC_, so it never reaches the browser); the owner page and routes check it before any work. This is separate
// from the company marker 'issues:on' (lib/issues/issues.ts), which only decides whether a company's people see the Raise an issue button.
export function ownerIssuesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OWNER_ISSUES_ENABLED === "true";
}
