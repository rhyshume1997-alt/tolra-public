import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PRELOAD = path.resolve(__dirname, "../support/no-network.cjs");

function run(script: string) {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "no-network-")), "blocked.log");
  const result = spawnSync(process.execPath, ["--require", PRELOAD, "-e", script], {
    env: { ...process.env, E2E_BLOCKED_LOG: log, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 20_000,
  });
  let blocked = "";
  try {
    blocked = readFileSync(log, "utf8");
  } catch {}
  return { stdout: result.stdout.trim(), blocked };
}

describe("outbound network guard for the server under test", () => {
  it("blocks connections to other hosts and logs them", () => {
    const { stdout, blocked } = run(`fetch("https://api.resend.com/emails").then(() => console.log("reached"), (e) => console.log("failed", e.cause?.code ?? e.code))`);
    expect(stdout).toBe("failed E2E_NETWORK_BLOCKED");
    expect(blocked).toContain("api.resend.com:443");
  });

  it("allows this machine", () => {
    const { stdout, blocked } = run(`
      const server = require("node:http").createServer((q, r) => r.end("local ok")).listen(0, "127.0.0.1", async () => {
        const res = await fetch("http://127.0.0.1:" + server.address().port);
        console.log(await res.text());
        server.close();
      });`);
    expect(stdout).toBe("local ok");
    expect(blocked).toBe("");
  });
});
