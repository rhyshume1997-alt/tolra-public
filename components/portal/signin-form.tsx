/**
 * BOUNDARY: components/portal/signin-form.tsx (server component). No inputs. Output: the e-mail form that posts to
 * /api/portal/signin/request. Says nothing about whether an address is known. Must not post anywhere else.
 */
export function SigninForm() {
  return (
    <form method="post" action="/api/portal/signin/request" className="space-y-3" data-testid="portal-signin-form">
      <label className="block text-sm font-medium" htmlFor="portal-email">E-mail address</label>
      <input id="portal-email" name="email" type="email" autoComplete="email" required maxLength={254} className="w-full rounded border border-slate-300 px-3 py-2" />
      <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-white">Send me a link and code</button>
    </form>
  );
}
