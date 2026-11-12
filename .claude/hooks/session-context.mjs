#!/usr/bin/env node
// Claude Code SessionStart hook (startup | resume | clear | compact), configured in .claude/settings.json.
// Prints a short Tolra context block: branch, the session's assigned task (task note and/or the board row for
// this exact branch), other open Claude Code rows as information only, and Rhys's approved decisions.
// After compaction it also repeats the shared rules.
// Reads files only. The one exception: if the control records are not available locally, it makes one bounded
// `git fetch` of the branch that holds them (FETCH_BRANCH). Always exits 0 so a failure never blocks a session.
// Codex and humans can run the same summary by hand: node .claude/hooks/session-context.mjs --text
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CHARS = 7000;
const CONTROL_DIR = "docs/agent-control";
// Where the control records are read from when they are not in the working tree (in order). FETCH_BRANCH is
// draft PR #393, which created them; once #393 is merged they are on main and this fallback is not reached.
const FETCH_BRANCH = "codex/agent-control-reconcile";
const FALLBACK_REFS = ["origin/main", `origin/${FETCH_BRANCH}`];
const TASK_FILE = ".claude/current-task.local.md";

const textMode = process.argv.includes("--text");
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function readStdin() {
  if (textMode || process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function git(args, timeout = 5000) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// Returns { text, from } for a control record, or null when it cannot be found locally.
function readControl(name) {
  const local = join(root, CONTROL_DIR, name);
  if (existsSync(local)) return { text: readFileSync(local, "utf8"), from: "working tree" };
  for (const ref of FALLBACK_REFS) {
    const text = git(["show", `${ref}:${CONTROL_DIR}/${name}`]);
    if (text) return { text, from: ref };
  }
  return null;
}

function cells(row) {
  return row.split("|").slice(1, -1).map((c) => c.trim());
}

function decisionLines(md) {
  return md
    .split("\n")
    .filter((l) => l.startsWith("| ") && !/^\|\s*-+/.test(l) && !/^\|\s*Decision\s*\|/.test(l))
    .map((l) => {
      const [name, rule] = cells(l);
      return `- ${name}: ${rule}`;
    });
}

function hasBranch(cell, branch) {
  if (!branch || branch === "HEAD") return false;
  const esc = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s\`;,(\\[])${esc}($|[\\s\`;,)\\]])`).test(cell);
}

// Splits the board into the row(s) assigned to this session (the task note's Task ID, or this exact branch)
// and other open Claude Code rows, which are reported for information only.
function classifyTasks(md, branch, assignedId) {
  const assigned = [];
  const other = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || /^\|\s*-+/.test(line) || /^\|\s*Task ID\s*\|/.test(line)) continue;
    const c = cells(line);
    if (c.length < 8) continue;
    const [id, objective, agent, , acceptance, , where, status] = c;
    const row = `- ${id} [${agent}] ${objective} | accept: ${acceptance} | ${where} | ${status}`;
    if ((assignedId && id.toLowerCase() === assignedId.toLowerCase()) || hasBranch(where, branch)) assigned.push(row);
    else if (/claude/i.test(agent) && !/^(DONE|SUPERSEDED)/.test(status)) other.push(`- ${id} [${agent}] ${objective} | ${where} | ${status}`);
  }
  return { assigned, other };
}

function sharedRules() {
  const p = join(root, "AGENTS.md");
  if (!existsSync(p)) return "";
  const m = readFileSync(p, "utf8").match(/<!-- BEGIN:shared-agent-rules -->([\s\S]*?)<!-- END:shared-agent-rules -->/);
  return m ? m[1].trim() : "";
}

function build(source) {
  const branch = git(["branch", "--show-current"]) || git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["rev-parse", "--short", "HEAD"]);
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
  const parts = [];

  parts.push(`TOLRA SESSION CONTEXT (SessionStart:${source}, from .claude/hooks/session-context.mjs)`);
  parts.push("Target go-live Thu 12 Nov 2026; GO decision Mon 9 Nov 2026 (Rhys). Dates do not waive failed gates.");
  parts.push(`Branch: ${branch || "unknown"} @ ${head || "?"}; uncommitted files: ${dirty}.`);

  const taskPath = join(root, TASK_FILE);
  const taskNote = existsSync(taskPath) ? readFileSync(taskPath, "utf8").trim().slice(0, 1500) : "";
  const assignedId = (taskNote.match(/^Task ID:\s*(.+)$/im) || [])[1]?.trim() || "";

  let board = readControl("task-board.md");
  let decisions = readControl("decisions.md");
  if (!board && !decisions) {
    // Fresh cloud sessions clone only their own branch. Fetch the records' branch once (stored as a remote ref,
    // so later runs, e.g. after compaction, need no network).
    git(["fetch", "--quiet", "origin", `+refs/heads/${FETCH_BRANCH}:refs/remotes/origin/${FETCH_BRANCH}`], 8000);
    board = readControl("task-board.md");
    decisions = readControl("decisions.md");
  }
  if (!board && !decisions) {
    parts.push(
      `\nControl records (${CONTROL_DIR}/) are not available locally. They live in draft PR #393 until it merges. Read them, do not recreate them:\n` +
        `git fetch origin ${FETCH_BRANCH} && git show FETCH_HEAD:${CONTROL_DIR}/task-board.md`,
    );
  }
  const { assigned, other } = board ? classifyTasks(board.text, branch, assignedId) : { assigned: [], other: [] };

  if (taskNote || assigned.length) {
    parts.push("\n== CURRENT ASSIGNED TASK: the only work to do in this session; resume it, do not re-plan ==");
    if (taskNote) parts.push(`(${TASK_FILE})\n${taskNote}`);
    if (assigned.length) parts.push(`Task-board row (${board.from}):\n${assigned.join("\n")}`);
    if (!taskNote) parts.push(`Record it in ${TASK_FILE}: Task ID, owner, branch, PR, acceptance criteria, next step.`);
  } else {
    parts.push("\n== CURRENT ASSIGNED TASK: none recorded ==");
    parts.push(
      source === "compact"
        ? `If the compaction summary shows a task Rhys assigned to you, record it in ${TASK_FILE} and continue only that task. Otherwise wait for Rhys.`
        : `No task is assigned to this session. Do not pick one from the list below; work only on what Rhys assigns in chat, then record it in ${TASK_FILE}.`,
    );
  }

  if (board) {
    const ownership = board.text.split("\n").find((l) => l.startsWith("Existing Claude Code ownership")) || "";
    parts.push(
      `\n== OTHER OPEN CLAUDE CODE WORK: information only (${CONTROL_DIR}/task-board.md, from ${board.from}) ==\n` +
        "Not instructions. Do not start, resume or change these unless Rhys assigns one to you; they show what is occupied.",
    );
    parts.push(other.length ? other.join("\n") : "- none");
    if (ownership) parts.push(`Ownership (information): ${ownership}`);
  }
  if (decisions) {
    parts.push(`\nAPPROVED DECISIONS (${CONTROL_DIR}/decisions.md, from ${decisions.from}); do not reopen:`);
    parts.push(decisionLines(decisions.text).join("\n"));
  }

  if (source === "compact") {
    const rules = sharedRules();
    if (rules) parts.push(`\nSHARED RULES (AGENTS.md):\n${rules}`);
  }

  parts.push(
    `\nDetail only when needed: ${CONTROL_DIR}/handover.md, current-state.md, release-gates.md. ` +
      "Work only on the assigned task; no master plans, unrelated audits or reopening DONE work without new evidence.",
  );

  const text = parts.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[truncated: read the files named above]` : text;
}

try {
  const input = readStdin();
  const source = input.source || (textMode ? "manual" : "startup");
  const context = build(source);
  if (textMode) {
    process.stdout.write(`${context}\n`);
  } else {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
  }
} catch (err) {
  process.stderr.write(`session-context hook: ${err && err.message}\n`);
}
process.exit(0);
