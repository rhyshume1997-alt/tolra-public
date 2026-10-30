/**
 * Audit S4: the CI workflow's "Browser suite" step pasted the manual `specs` input straight into its shell script
 * (npx playwright test ${{ inputs.specs }}), so a crafted input ran as shell. Inputs now reach scripts only through the environment.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(path.resolve(__dirname, "../../.github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");

/** Each step's `run:` script: the line itself and every following line indented deeper than the `run:` key. */
function runBlocks(text: string): Array<{ name: string; lines: string[] }> {
  const blocks: Array<{ name: string; lines: string[] }> = [];
  const lines = text.split("\n");
  let name = "";
  for (let i = 0; i < lines.length; i += 1) {
    const step = /^\s*- name: (.*)$/.exec(lines[i]);
    if (step) name = step[1];
    const run = /^(\s*)(?:- )?run:(.*)$/.exec(lines[i]);
    if (!run) continue;
    const indent = run[1].length + (lines[i].trimStart().startsWith("- ") ? 2 : 0);
    const block = [run[2]];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || lines[i + 1].search(/\S/) > indent)) block.push(lines[++i]);
    blocks.push({ name, lines: block });
  }
  return blocks;
}

describe("ci.yml: workflow inputs never become shell text", () => {
  it("no run: script interpolates an input expression", () => {
    const blocks = runBlocks(workflow);
    expect(blocks.length).toBeGreaterThan(5);
    const offending = blocks.filter((b) => b.lines.some((line) => /\$\{\{\s*(inputs|github\.event\.inputs)\./.test(line))).map((b) => b.name);
    expect(offending).toEqual([]);
  });

  it("the Browser suite step takes the spec list from SPECS", () => {
    const step = workflow.slice(workflow.indexOf("- name: Browser suite\n"), workflow.indexOf("- name: Keep run evidence"));
    expect(step).toContain("SPECS: ${{ inputs.specs }}");
    expect(step).toContain('npx playwright test "${spec_files[@]}"');
  });

  // Runs the step's own script with bash (Linux and macOS; CI runs it on ubuntu), npx replaced by a function that prints its arguments.
  it.skipIf(process.platform === "win32")("a hostile list is split into plain words: no command runs, no glob expands, no option passes", () => {
    const block = runBlocks(workflow).find((b) => b.name === "Browser suite");
    if (!block) throw new Error("Browser suite step not found");
    const script = block.lines.slice(1).join("\n").replaceAll("${{ github.event_name }}", "workflow_dispatch");
    const run = (specs: string) => spawnSync("bash", ["-e", "-c", `npx() { printf '%s\\n' "$@"; }\nnpm() { echo npm "$@"; }\n${script}`], { env: { ...process.env, SPECS: specs }, encoding: "utf8" });

    const hostile = run('tests/e2e/a.spec.ts $(echo INJECTED) `echo INJECTED` b.spec.ts;echo INJECTED *');
    expect(hostile.status).toBe(0);
    expect(hostile.stdout.trim().split("\n")).toEqual(["playwright", "test", "tests/e2e/a.spec.ts", "$(echo", "INJECTED)", "`echo", "INJECTED`", "b.spec.ts;echo", "INJECTED", "*"]);

    const option = run("tests/e2e/a.spec.ts --config=/tmp/evil.ts");
    expect(option.status).toBe(1);
    expect(option.stdout).toBe("");

    expect(run("tests/e2e/a.spec.ts  tests/e2e/b.spec.ts").stdout.trim().split("\n")).toEqual(["playwright", "test", "tests/e2e/a.spec.ts", "tests/e2e/b.spec.ts"]);
    expect(run("").stdout.trim()).toBe("npm run test:e2e");
  });
});
