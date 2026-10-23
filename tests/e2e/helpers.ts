import { existsSync, readFileSync } from "node:fs";

import { expect, type Locator, type Page } from "@playwright/test";

import type { Role, SyntheticUser, SyntheticWorld } from "../support/fixtures";
import { E2E_WORLD_FILE } from "./paths";

let loaded: SyntheticWorld | null = null;

/**
 * The synthetic tenants global setup created for this run. Read on first use inside a test, never at import, so
 * listing the suite needs no backend.
 */
export function world(): SyntheticWorld {
  return new Proxy({} as SyntheticWorld, {
    get(_target, key) {
      if (!loaded) {
        if (!existsSync(E2E_WORLD_FILE)) {
          // Most often a spec read the world at import (module scope). `npm run test:e2e:list` (CI's collection step) runs
          // with no world file, so build run-specific values inside tests or hooks, not at the top of a spec file.
          throw new Error(`${E2E_WORLD_FILE} not found: the synthetic world exists only after global setup. Don't read world() at module scope in a spec; read it inside a test or hook.`);
        }
        loaded = JSON.parse(readFileSync(E2E_WORLD_FILE, "utf8")) as SyntheticWorld;
      }
      return loaded[key as keyof SyntheticWorld];
    },
  });
}

const VIEW_BUTTON: Record<Role, string> = { admin: "Continue as Admin", office: "Continue as Office", workshop: "Continue as Workshop", viewer: "" };

let ipCounter = 0;

/**
 * Each browser session gets its own client address (the platform's x-real-ip header), as separate staff devices
 * would. Without it the whole suite signs in from one address and hits the per-address sign-in limit.
 */
export async function asSeparateDevice(page: Page) {
  ipCounter += 1;
  const n = (process.pid % 200) * 1000 + ipCounter;
  await page.setExtraHTTPHeaders({ "x-real-ip": `10.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}` });
}

/** Signs in through the real sign-in form and lands on the dashboard. */
export async function signIn(page: Page, user: SyntheticUser) {
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(select-role|dashboard)/, { timeout: 45_000 });
  if (page.url().includes("/select-role")) {
    await page.getByRole("button", { name: VIEW_BUTTON[user.role] }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  }
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Fault injection on the disposable database: makes writes that set user_profiles.must_change_password to `value`
 * fail for one person (by id or e-mail). Returns the undo. Never used outside the isolated backend.
 */
export async function failFlagWrites(who: { id?: string; email?: string }, value: boolean) {
  const { withDb } = await import("../support/fixtures");
  const name = `e2e_fail_flag_${Math.random().toString(16).slice(2, 10)}`;
  const condition = who.id ? `NEW.id = '${who.id.replace(/[^0-9a-f-]/g, "")}'::uuid` : `lower(NEW.email) = '${(who.email ?? "").toLowerCase().replace(/[^a-z0-9.@_+-]/g, "")}'`;
  await withDb(async (db) => {
    await db.query(`create function public.${name}() returns trigger language plpgsql as $$
      begin
        if ${condition} and NEW.must_change_password = ${value ? "true" : "false"} then
          raise exception 'injected failure (e2e)';
        end if;
        return NEW;
      end $$`);
    await db.query(`create trigger ${name} before insert or update on public.user_profiles for each row execute function public.${name}()`);
  });
  // The undo can race the app's own clean-up of the write it just failed (DROP TRIGGER needs an exclusive lock on
  // user_profiles), which Postgres may resolve as a deadlock: drop both in one transaction and retry a few times.
  return async () => {
    const { retryOnLockConflict } = await import("../support/lock-retry");
    await retryOnLockConflict(() => withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local lock_timeout = '5s'");
        await db.query(`drop trigger if exists ${name} on public.user_profiles`);
        await db.query(`drop function if exists public.${name}()`);
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw error;
      }
    }));
  };
}

/** Signs in through the form and expects the forced "Choose your password" page. */
export async function signInToSetup(page: Page, email: string, password: string) {
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/auth\/set-password/, { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
}

/** Fills the "Choose your password" form. */
export async function choosePassword(page: Page, password: string) {
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Save password and continue" }).click();
}

/**
 * A quote's Send asks first (go-live polish 19e): "Send QUO-0005 to buyer@example.test?". Answers yes; returns the question asked.
 */
export async function confirmSend(page: Page): Promise<string> {
  const ask = page.getByRole("dialog", { name: /^Send .+\?$/ });
  await expect(ask).toBeVisible();
  const question = (await ask.getByRole("heading").first().textContent()) ?? "";
  await ask.getByRole("button", { name: "Yes, send" }).click();
  await expect(ask).toBeHidden();
  return question;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Job Board's Play/Pause control of one job (049): "Start J-1", "Resume J-1", "Start timer J-1" or "Pause J-1...". */
export const playControl = (scope: Locator, jobNo: string) => scope.getByRole("button", { name: new RegExp(`^(Start|Resume|Start timer|Pause) ${escapeRe(jobNo)}(,|$)`) });
export const pauseControl = (scope: Locator, jobNo: string) => scope.getByRole("button", { name: new RegExp(`^Pause ${escapeRe(jobNo)}(,|$)`) });

/**
 * A single job's Pause or Finish asks first ("Pause J-1?" / "Finish J-1?" with Cancel and "Pause job" / "Finish job"); nothing is sent until
 * the confirm. These press the control, wait for that dialog and confirm it (`tap` for a touch screen, `twice` to prove one confirm = one request).
 */
async function confirmed(page: Page, kind: "Pause" | "Finish", control: Locator, how: { tap?: boolean; twice?: boolean } = {}) {
  if (how.tap) await control.tap(); else await control.click();
  const dialog = page.getByRole("dialog", { name: new RegExp(`^${kind} .+\\?$`) });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: `${kind} job`, exact: true });
  if (how.twice) await confirm.dblclick(); else if (how.tap) await confirm.tap(); else await confirm.click();
  await expect(dialog).toBeHidden();
}
export const confirmPause = (page: Page, control: Locator, how?: { tap?: boolean; twice?: boolean }) => confirmed(page, "Pause", control, how);
export const confirmFinish = (page: Page, control: Locator, how?: { tap?: boolean; twice?: boolean }) => confirmed(page, "Finish", control, how);

/**
 * Ticks what Play starts on in the job's Machine column (049, plan R2.4): "No machine (bench)" (the deliberate bench choice) or the named
 * machines. The picker is a popover on a desk and a bottom sheet on a phone; either closes with Escape.
 */
export async function pickMachines(page: Page, scope: Locator, jobNo: string, choice: { bench: true } | { machines: string[] }) {
  await scope.getByRole("button", { name: new RegExp(`^Choose where ${escapeRe(jobNo)} runs`) }).click();
  const picker = page.locator(`[data-testid="machine-picker"]:visible`);
  if ("bench" in choice) await picker.getByLabel("No machine (bench)").check();
  else for (const machine of choice.machines) await picker.getByLabel(`Start on ${machine}`).check();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
}

/** Play on the board: optionally tick the bench or machines first, then press the job's Play. */
export async function playJob(page: Page, scope: Locator, jobNo: string, choice?: { bench: true } | { machines: string[] }) {
  if (choice) await pickMachines(page, scope, jobNo, choice);
  await playControl(scope, jobNo).click();
}
