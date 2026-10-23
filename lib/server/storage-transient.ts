/**
 * Whether a Storage error is a passing fault worth trying again (the gateway or Storage itself failing, rate limiting, or no answer at
 * all), as opposed to an answer about the object (not there, refused). storage-js gives a StorageApiError with the HTTP status for an
 * answer, and a StorageUnknownError (no status) when the request itself failed.
 */
export function storageTransient(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status ?? NaN);
  if (!Number.isFinite(status)) return true;
  return status >= 500 || status === 429;
}
