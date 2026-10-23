import { PRODUCT } from "@/lib/product";

// The page the service worker shows when there's no connection (precached; self-contained: inline styles only).
// A route rather than a file in public/ so the product name comes from lib/product.ts.

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${PRODUCT.primary}">
<title>Offline · ${PRODUCT.name}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; }
  main { width: 100%; max-width: 380px; text-align: center; background: #fff; border: 1px solid #e2e8f0; border-radius: 24px;
    padding: 32px 24px; box-shadow: 0 20px 40px -24px rgba(15, 23, 42, .25); }
  .icon { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 16px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, ${PRODUCT.primary}, ${PRODUCT.accent}); color: #fff; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0 0 24px; color: #64748b; line-height: 1.5; font-size: 15px; }
  button { min-height: 48px; width: 100%; border: 0; border-radius: 12px; font: inherit; font-weight: 600; color: #fff;
    background: linear-gradient(135deg, ${PRODUCT.primary}, ${PRODUCT.accent}); cursor: pointer; }
</style>
</head>
<body>
<main>
  <div class="icon" aria-hidden="true">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M5 12.86a10 10 0 0 1 5.17-2.69"/><path d="M19 12.86a10 10 0 0 0-2-1.43"/><path d="M2 8.82a15 15 0 0 1 4.18-2.65"/><path d="M22 8.82a15 15 0 0 0-11.29-3.76"/><path d="m2 2 20 20"/></svg>
  </div>
  <h1>You're offline</h1>
  <p>${PRODUCT.name} needs a connection to load your jobs, quotes and invoices. Nothing you saved is lost; reconnect and try again.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>
`;

export function GET() {
  return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}
