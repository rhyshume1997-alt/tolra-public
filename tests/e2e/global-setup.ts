/**
 * Browser suite setup (audit B1). Runs after Playwright has started the app server (see playwright.config.ts).
 *
 * 1. Refuses anything but the local disposable backend (tests/support/isolation.ts).
 * 2. Records the identities under test: app URL, backend, database, migrations, git SHA.
 * 3. Creates the two synthetic tenants and starts the mock e-mail provider.
 * 4. Proves the app server talks to that backend: its public branding for a synthetic slug must return the
 *    synthetic tenant's run-specific name. A server built or started against another backend fails here.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { FullConfig } from "@playwright/test";

import { allowInspectors, createSyntheticWorld, destroySyntheticWorld, leftoverRows, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";
import { startMockProviders } from "../support/mock-providers";
import { E2E_BLOCKED_LOG, E2E_MOCK_PORT, E2E_STATE_DIR, E2E_WORLD_FILE } from "./paths";

export default async function globalSetup(config: FullConfig) {
  const backend = isolatedBackend();
  const identity = await verifyBackendIdentity(backend);
  const baseURL = String(config.projects[0]?.use?.baseURL ?? "");

  mkdirSync(E2E_STATE_DIR, { recursive: true });
  writeFileSync(E2E_BLOCKED_LOG, "");
  // Sign-in limits are per IP/account over 15 minutes; start every run from a clean slate (disposable database).
  await withDb((db) => db.query("delete from public.auth_rate_limits"), backend);
  const mocks = await startMockProviders(E2E_MOCK_PORT);
  const world = await createSyntheticWorld();
  // Inspectors are chosen by an admin and off by default (migration 034); the alpha office and workshop users are ticked for the specs.
  await allowInspectors(world);

  const cleanup = async () => {
    await mocks.close();
    await destroySyntheticWorld(world.runId);
    const left = await leftoverRows(world.runId);
    if (Object.keys(left).length) throw new Error(`teardown left synthetic rows behind: ${JSON.stringify(left)}`);
  };

  try {
    const response = await fetch(new URL(`/api/branding?org=${world.tenants.alpha.slug}`, baseURL));
    const body = (await response.json().catch(() => null)) as { name?: string } | null;
    const name = body?.name;
    if (name !== world.tenants.alpha.name) {
      throw new Error(`the app at ${baseURL} is not using the isolated backend (branding for ${world.tenants.alpha.slug} returned ${JSON.stringify(body)}). Rebuild with the test backend's NEXT_PUBLIC_SUPABASE_URL.`);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  writeFileSync(E2E_WORLD_FILE, JSON.stringify(world, null, 2));
  writeFileSync(path.join(E2E_STATE_DIR, "identity.json"), JSON.stringify({ ...identity, appUrl: baseURL, mockProviders: `http://127.0.0.1:${E2E_MOCK_PORT}` }, null, 2));
  console.log(`[e2e] app ${baseURL} -> backend ${backend.apiUrl} (db ${identity.database.host}:${identity.database.port}, migrations ${identity.migrations.at(-1)}, sha ${identity.gitSha.slice(0, 8)}) run ${world.runId}`);

  return async () => {
    await cleanup();
    const { readFileSync } = await import("node:fs");
    const blocked = readFileSync(E2E_BLOCKED_LOG, "utf8").trim();
    if (blocked) throw new Error(`the app server tried to reach the outside network during the run:\n${blocked}`);
  };
}
