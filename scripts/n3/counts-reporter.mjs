// Emit counts and fixed check IDs only: never errors, source, paths or stack traces.
import { mkdirSync, writeFileSync } from "node:fs";
export default class CountsReporter {
  onFinished(files = [], errors = []) {
    const checks = [];
    const visit = task => {
      if (task.type === "test") checks.push({ id: /^N3-\d{2}/.exec(task.name)?.[0] ?? "UNKNOWN", status: task.result?.state ?? "skip" });
      for (const child of task.tasks ?? []) visit(child);
    };
    files.forEach(visit);
    const count = status => checks.filter(c => c.status === status).length;
    const result = { total: checks.length, passed: count("pass"), failed: count("fail"), skipped: count("skip"), todo: count("todo"),
      suiteErrors: errors.length + files.filter(f => f.result?.state === "fail").length, checks };
    mkdirSync("work/n3", { recursive: true });
    writeFileSync("work/n3/results.json", JSON.stringify(result));
  }
}
