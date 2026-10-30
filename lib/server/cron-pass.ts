/** A cron pass that failed for a reason worth reporting (the message is a short, safe reason: never a name, address or token). */
export class PassFailure extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PassFailure";
  }
}

/** The reason to log and report for any error thrown by a pass. */
export const passFailureReason = (err: unknown) => (err instanceof PassFailure ? err.message : `threw ${err instanceof Error ? err.name : "unknown"}`);
