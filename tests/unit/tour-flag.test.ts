/**
 * The first-login admin tour's saved flag (lib/auth/tour-flag.ts): account copy plus browser copy, admin only, never throws.
 */
import { describe, expect, it } from "vitest";

import {
  TOUR_DONE_COPY_PREFIX, TOUR_DONE_META_KEY, type TourAuthClient, type TourStorage, canSeeAdminTour, isTourDone, markTourDone, readTourDoneCopy,
  tourDoneInMetadata,
} from "@/lib/auth/tour-flag";

function memoryStorage(initial: Record<string, string> = {}): TourStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const brokenStorage: TourStorage = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};

function client(result: { error: unknown } | Error) {
  const calls: Array<{ data: Record<string, unknown> }> = [];
  const value: TourAuthClient = {
    auth: {
      updateUser: async (attributes) => {
        calls.push(attributes);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return { value, calls };
}

describe("canSeeAdminTour", () => {
  it("is true only for admin", () => {
    expect(canSeeAdminTour("admin")).toBe(true);
    for (const role of ["office", "workshop", "viewer", "", null, undefined]) expect(canSeeAdminTour(role)).toBe(false);
  });
});

describe("tourDoneInMetadata", () => {
  it("needs exactly true under the key", () => {
    expect(tourDoneInMetadata({ [TOUR_DONE_META_KEY]: true })).toBe(true);
    for (const bad of [null, undefined, "x", 1, [], {}, { [TOUR_DONE_META_KEY]: "true" }, { [TOUR_DONE_META_KEY]: 1 }, { [TOUR_DONE_META_KEY]: false }]) {
      expect(tourDoneInMetadata(bad)).toBe(false);
    }
  });
});

describe("isTourDone", () => {
  it("is done when the account says so, or this browser does", () => {
    expect(isTourDone("u1", { [TOUR_DONE_META_KEY]: true }, memoryStorage())).toBe(true);
    expect(isTourDone("u1", {}, memoryStorage({ [TOUR_DONE_COPY_PREFIX + "u1"]: "1" }))).toBe(true);
  });
  it("is not done for a different person on the same browser", () => {
    expect(isTourDone("u2", {}, memoryStorage({ [TOUR_DONE_COPY_PREFIX + "u1"]: "1" }))).toBe(false);
  });
  it("is not done with no user id, and a blocked storage is not done", () => {
    expect(isTourDone(null, { [TOUR_DONE_META_KEY]: true }, memoryStorage())).toBe(false);
    expect(isTourDone("", {}, memoryStorage())).toBe(false);
    expect(isTourDone("u1", {}, brokenStorage)).toBe(false);
    expect(readTourDoneCopy("u1", null)).toBe(false);
  });
});

describe("markTourDone", () => {
  it("writes the browser copy and sends only the one key", async () => {
    const storage = memoryStorage();
    const { value, calls } = client({ error: null });
    expect(await markTourDone(value, "u1", storage)).toEqual({ saved: true });
    expect(storage.data.get(TOUR_DONE_COPY_PREFIX + "u1")).toBe("1");
    expect(calls).toEqual([{ data: { [TOUR_DONE_META_KEY]: true } }]);
  });
  it("keeps the browser copy when the account save is refused or throws, and never throws", async () => {
    for (const result of [{ error: new Error("no") }, new Error("network")]) {
      const storage = memoryStorage();
      const { value } = client(result);
      expect(await markTourDone(value, "u1", storage)).toEqual({ saved: false });
      expect(readTourDoneCopy("u1", storage)).toBe(true);
    }
  });
  it("does nothing for no user id, and works with no client or a blocked storage", async () => {
    const { value, calls } = client({ error: null });
    expect(await markTourDone(value, null, memoryStorage())).toEqual({ saved: false });
    expect(calls).toEqual([]);
    expect(await markTourDone(null, "u1", memoryStorage())).toEqual({ saved: false });
    expect(await markTourDone(value, "u1", brokenStorage)).toEqual({ saved: true });
  });
});
