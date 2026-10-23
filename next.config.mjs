const isProd = process.env.NODE_ENV === "production";

function supabaseOrigins() {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
    // Keep the configured scheme (local Supabase runs on http://localhost:54321).
    return { https: url.origin, wss: url.origin.replace(/^http/, "ws") };
  } catch {
    return { https: "https://*.supabase.co", wss: "wss://*.supabase.co" };
  }
}

const supabase = supabaseOrigins();

// Next injects inline bootstrap scripts and styles and this app doesn't use nonces, so 'unsafe-inline' is required.
// 'wasm-unsafe-eval' lets @react-pdf/renderer compile its layout engine (WebAssembly) without allowing JS eval.
// 'unsafe-eval' is only added for the dev server (React Refresh).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabase.https}`,
  "font-src 'self' data:",
  `connect-src 'self' ${supabase.https} ${supabase.wss}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  // Installable app: the service worker (/sw.js) and the per-company manifest are same-origin only.
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

// Stamped into the service worker so browsers notice each deploy (Vercel sets the commit SHA; local builds use the time).
const appVersion = (process.env.VERCEL_GIT_COMMIT_SHA || `local-${Date.now()}`).slice(0, 12);

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  // Browsers ask for /favicon.ico on their own: serve the company's icon there.
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/api/favicon" }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
