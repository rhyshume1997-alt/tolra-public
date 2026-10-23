import { describe, expect, it } from "vitest";

import { nextPhotoRetry, photoUrl, PHOTO_RETRY_DELAYS_MS } from "@/lib/job-photos";
import { storageTransient } from "@/lib/server/storage-transient";

describe("a job photo thumbnail that fails to load (go-live polish item 15)", () => {
  const photo = { id: "11111111-2222-4333-8444-555555555555", uploaded_at: "2026-10-14T09:00:00.123+00:00" };
  it("is asked for again with a fresh URL, twice, then shown as unavailable with Retry", () => {
    expect(photoUrl(photo)).toBe(`/api/job-photos/${photo.id}?v=${encodeURIComponent(photo.uploaded_at)}`);
    expect(photoUrl(photo, 1)).toBe(`${photoUrl(photo)}&r=1`);
    expect(photoUrl(photo, 2)).not.toBe(photoUrl(photo, 1));
    expect([1, 2, 3].map(nextPhotoRetry)).toEqual([PHOTO_RETRY_DELAYS_MS[0], PHOTO_RETRY_DELAYS_MS[1], null]);
    expect(nextPhotoRetry(0)).toBeNull();
  });
  it("the photo route answers a passing Storage fault with 503 (try again), an answer about the object with 404", () => {
    expect(storageTransient({ status: 502 })).toBe(true);
    expect(storageTransient({ status: 503 })).toBe(true);
    expect(storageTransient({ status: 429 })).toBe(true);
    expect(storageTransient({ name: "StorageUnknownError", message: "fetch failed" })).toBe(true);
    expect(storageTransient({ status: 400, statusCode: "404", message: "Object not found" })).toBe(false);
    expect(storageTransient({ status: 404 })).toBe(false);
    expect(storageTransient({ status: 403 })).toBe(false);
  });
});
