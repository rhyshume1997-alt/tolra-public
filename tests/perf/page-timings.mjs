#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { performance } from 'node:perf_hooks';

const help = `Usage: node tests/perf/page-timings.mjs --base-url http://localhost:3001
  --storage-state /private/test-session.json  Authenticated disposable-test session
  --test-origin https://test.example.test   Required for a non-loopback TEST server
  --executable-path /usr/bin/chromium       Optional installed Chromium
  --timeout-ms 30000                       Timeout per navigation/readiness step
Never use production. Prepare the approved test app/backend and fake data first.`;
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i] === '--help') { console.log(help); process.exit(0); }
  const key = process.argv[i];
  if (!['--base-url', '--storage-state', '--test-origin', '--executable-path', '--timeout-ms'].includes(key) || !process.argv[i + 1]) {
    throw new Error(help);
  }
  args.set(key, process.argv[i + 1]);
}
const base = new URL(args.get('--base-url') ?? 'http://localhost:3001');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
  throw new Error('Use a plain http(s) origin without credentials, path, query or fragment.');
}
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
if (!loopback && args.get('--test-origin') !== base.origin) {
  throw new Error('Remote targets require --test-origin matching the separately verified TEST origin. Never name production.');
}
const timeout = Number(args.get('--timeout-ms') ?? 30000);
if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid timeout.');
const routes = [
  ['Dashboard', '/dashboard', 'Dashboard'],
  ['Jobs', '/jobs', 'Job Board'],
  ['Timesheets', '/time', 'Weekly hours'],
  ['Customers', '/customers', 'Customers'],
];
const browser = await chromium.launch({ headless: true, executablePath: args.get('--executable-path') });
const contextOptions = {
  storageState: args.get('--storage-state'), serviceWorkers: 'block',
  viewport: { width: 1440, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/London',
};
const results = [];
let failed = false;

async function measure(page, path, heading) {
  const started = performance.now();
  const response = await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded', timeout });
  if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? 'no response'}`);
  await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor({ timeout });
  // Includes a fixed 500 ms quiet window; also wait for React loaders/skeletons to disappear.
  await page.waitForLoadState('networkidle', { timeout });
  await page.waitForFunction(() => {
    const visible = (node) => node.getClientRects().length > 0;
    const root = document.querySelector('main') ?? document.body;
    return ![...root.querySelectorAll('[data-slot="skeleton"], .animate-pulse, [aria-busy="true"]')].some(visible)
      && ![...root.querySelectorAll('p, span, div')].some((node) =>
        visible(node) && !node.children.length && /^Loading(?:[.…]|$)/i.test(node.textContent.trim()));
  }, undefined, { timeout });
  const current = new URL(page.url());
  if (current.origin !== base.origin || current.pathname !== path) throw new Error('Redirected away from requested page (check test login/role).');
  const text = await page.locator('main').count() ? await page.locator('main').innerText() : await page.locator('body').innerText();
  if (/couldn['’]t (?:load|be loaded)|supabase is not configured|needs? a database update|something went wrong|application error|failed to fetch/i.test(text)) {
    throw new Error('Page shows a loading/configuration error; refusing a misleading timing.');
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return performance.now() - started;
}

try {
  for (const [name, path, heading] of routes) {
    for (const mode of ['cold', 'warm']) {
      const samples = [];
      let warmContext;
      try {
        let warmPage;
        if (mode === 'warm') {
          warmContext = await browser.newContext(contextOptions);
          warmPage = await warmContext.newPage();
          await measure(warmPage, path, heading); // untimed priming load
        }
        for (let run = 1; run <= 5; run++) {
          let coldContext;
          try {
            coldContext = mode === 'cold' ? await browser.newContext(contextOptions) : undefined;
            const page = coldContext ? await coldContext.newPage() : warmPage;
            samples.push(await measure(page, path, heading));
          } finally { await coldContext?.close(); }
        }
        const sorted = [...samples].sort((a, b) => a - b);
        results.push({ page: name, mode, runs: 5, 'median ms': Math.round(sorted[2]), 'slowest ms': Math.round(sorted[4]), 'samples ms': samples.map(Math.round).join(', ') });
      } catch (error) {
        failed = true;
        results.push({ page: name, mode, runs: samples.length, 'median ms': 'FAIL', 'slowest ms': 'FAIL', 'samples ms': samples.map(Math.round).join(', ') });
        console.error(`${name} ${mode}: ${error.message.split('\n')[0]}`);
      } finally { await warmContext?.close(); }
    }
  }
} finally { await browser.close(); }
console.log(`TEST origin ${base.origin} | ${new Date().toISOString()} | Chromium | 1440x900 | 5 runs per cell`);
console.log('Navigation -> heading + quiet network + no loaders + two frames (includes 500 ms quiet window).');
console.table(results);
if (failed) process.exitCode = 1;
