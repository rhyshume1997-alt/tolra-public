# DO NOT MERGE: preview hub

Branch `claude/preview-hub` is a throwaway build for a clickable "Tolra UI preview" site (Vercel preview, protection on). It merges every premium preview branch and then
strips the product routes. It must never be merged into `main`, `quoteflow-jnr` production or any other branch.

What this branch changes (on purpose, and only here):
- Deletes `middleware.ts`, `vercel.json`, `app/api/**`, `app/(dashboard)/**`, `app/portal/**` and the other product routes. No real auth, no Supabase client call.
- `app/<real sidebar path>/page.tsx` (for example `app/jobs`, `app/admin/users`, `app/portal`) renders each preview inside the real Sidebar/Topbar with a fake signed-in admin (`components/render-shell.tsx`; `lib/use-user.ts` exports the context for it).
- `next.config.mjs`: noindex (`X-Robots-Tag`) and CSP `connect-src 'self'` (no backend can be called).
- `app/preview-hub/page.tsx`: the index. `app/layout.tsx`, `app/page.tsx`, `app/robots.ts`, `app/not-found.tsx` are replaced.
- No real keys: the site needs no environment variables.
