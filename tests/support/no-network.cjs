/**
 * Outbound network guard for the app server under test (audit B1). Loaded with
 * NODE_OPTIONS="--require ./tests/support/no-network.cjs".
 *
 * Every TCP connection in Node goes through net.Socket#connect (fetch/undici, http, https, tls, pg). Connections to
 * this machine pass; anything else fails immediately with E2E_NETWORK_BLOCKED and is appended to
 * $E2E_BLOCKED_LOG, which the browser suite's teardown requires to be empty. So no test can reach a real e-mail
 * provider, costing service or hosted database, even by mistake.
 */
"use strict";
const fs = require("node:fs");
const net = require("node:net");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::ffff:127.0.0.1"]);
const logFile = process.env.E2E_BLOCKED_LOG;

function targetOf(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (first.path) return { local: true, label: `unix:${first.path}` };
    const host = first.host ?? first.hostname ?? "localhost";
    return { local: LOOPBACK.has(host), label: `${host}:${first.port}` };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { local: true, label: `unix:${first}` };
  const host = typeof args[1] === "string" ? args[1] : "localhost";
  return { local: LOOPBACK.has(host), label: `${host}:${first}` };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = targetOf(args);
  if (target.local) return connect.apply(this, args);
  const message = `E2E_NETWORK_BLOCKED outbound connection to ${target.label}`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
    } catch {}
  }
  const error = Object.assign(new Error(message), { code: "E2E_NETWORK_BLOCKED" });
  process.nextTick(() => this.destroy(error));
  return this;
};
