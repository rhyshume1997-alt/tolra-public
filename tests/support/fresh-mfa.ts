/** A fake supabase.auth for route tests: the session passed the second step (aal2) with an authenticator code entered just now. */
export const freshMfaAuth = () => ({
  mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", currentAuthenticationMethods: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] }, error: null }) },
});
