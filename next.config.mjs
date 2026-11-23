// DO NOT MERGE: preview hub. Scratch-only config for the throwaway UI preview site.
// Inputs: none. Output: noindex headers (X-Robots-Tag), a CSP that allows ONLY same-origin connections (so the site cannot call any backend).
// Must never be merged or used for the product. The preview screens live at the real sidebar paths (app/jobs, app/quotes, ...) so links and the active menu item match.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // Whatever the Vercel project holds, the browser bundle is built with NO Supabase URL or key, so no client can ever be created (lib/supabase.ts isSupabaseConfigured is false).
  env: { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "", NEXT_PUBLIC_DEMO_MODE: "" },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
