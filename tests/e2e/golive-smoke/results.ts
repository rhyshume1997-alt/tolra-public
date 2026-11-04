/**
 * The go-live smoke's results file: one labelled line per step, "SMOKE <n> <name>: PASS|FAIL [hh:mm:ssZ] (<seconds>s) <detail>", plus
 * "KNOWN GAP <name>: ..." (behaviour the candidate does not have, named, never pretended) and "FINDING <name>: ..." (a real defect seen
 * on the way). scripts/golive-smoke/gate.mjs reads it against scripts/golive-smoke/steps.mjs.
 *
 * The file lives in work/golive-smoke (GOLIVE_SMOKE_DIR), not test-results/: Playwright empties test-results/ when it starts.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const SMOKE_DIR = process.env.GOLIVE_SMOKE_DIR ?? path.resolve(__dirname, "../../../work/golive-smoke");
export const RESULTS_FILE = process.env.GOLIVE_SMOKE_RESULTS ?? path.join(SMOKE_DIR, "results.txt");
export const TENANT_FILE = path.join(SMOKE_DIR, "tenant.json");

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 600);
const clock = () => new Date().toISOString().slice(11, 19) + "Z";

function write(line: string) {
  mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  appendFileSync(RESULTS_FILE, `${line}\n`);
  console.log(line);
}

export const knownGap = (name: string, detail: string) => write(`KNOWN GAP ${name}: ${oneLine(detail)}`);
export const finding = (name: string, detail: string) => write(`FINDING ${name}: ${oneLine(detail)}`);

/**
 * Runs the steps in order. A step whose dependency failed is not run and is reported FAIL ("not run: needs step N"), so the results
 * file always names every step the walk reached. `rethrow` (the Vitest file: one test per step) rethrows a failure after writing it.
 */
export function stepRunner(options: { rethrow?: boolean } = {}) {
  const failed = new Set<number>();
  const ran = new Set<number>();
  async function step(n: number, name: string, needs: number[], fn: () => Promise<string>): Promise<boolean> {
    ran.add(n);
    const blocked = needs.filter((d) => failed.has(d) || !ran.has(d));
    if (blocked.length) {
      failed.add(n);
      write(`SMOKE ${n} ${name}: FAIL [${clock()}] (0.0s) not run: needs step ${blocked.join(", ")}, which failed or did not run`);
      if (options.rethrow) throw new Error(`SMOKE ${n} ${name}: not run, needs ${blocked.join(", ")}`);
      return false;
    }
    const started = Date.now();
    const at = clock();
    try {
      const detail = await fn();
      write(`SMOKE ${n} ${name}: PASS [${at}] (${((Date.now() - started) / 1000).toFixed(1)}s) ${oneLine(detail)}`);
      return true;
    } catch (error) {
      failed.add(n);
      const message = error instanceof Error ? error.message.split("\n").filter(Boolean).slice(0, 4).join(" | ") : String(error);
      write(`SMOKE ${n} ${name}: FAIL [${at}] (${((Date.now() - started) / 1000).toFixed(1)}s) ${oneLine(message)}`);
      if (options.rethrow) throw error;
      return false;
    }
  }
  return { step, failed: () => [...failed].sort((a, b) => a - b) };
}
