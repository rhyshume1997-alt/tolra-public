/** The browser tests' fault-injection clean-up retries only lock conflicts, and only a bounded number of times. */
import { describe, expect, it } from "vitest";

import { retryOnLockConflict } from "../support/lock-retry";

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe("retryOnLockConflict", () => {
  it("retries a deadlock or lock timeout, then succeeds", async () => {
    const codes = ["40P01", "55P03"];
    let calls = 0;
    const result = await retryOnLockConflict(async () => {
      calls++;
      if (codes.length) throw pgError(codes.shift()!);
      return "dropped";
    }, 5, 0);
    expect(result).toBe("dropped");
    expect(calls).toBe(3);
  });

  it("gives up after the attempt limit and throws the last lock error", async () => {
    let calls = 0;
    await expect(retryOnLockConflict(async () => { calls++; throw pgError("40P01"); }, 5, 0)).rejects.toMatchObject({ code: "40P01" });
    expect(calls).toBe(5);
  });

  it("doesn't retry any other error", async () => {
    for (const error of [pgError("42P01"), pgError("23505"), new Error("no code")]) {
      let calls = 0;
      await expect(retryOnLockConflict(async () => { calls++; throw error; }, 5, 0)).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });
});
