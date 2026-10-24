/** Why "Add machine" in the job's machines dialog is disabled (null when it can add one), and whether to offer the Machines link. */
export type AddMachineReason = {
  code: "loading" | "load_failed" | "none" | "at_max" | "on_every_machine";
  reason: string;
  /** Admin or office with no machines set up: link to /schedule#machines. Everyone else is only told. */
  link: boolean;
};

export function addMachineReason(input: {
  /** The job's machines have loaded (machinesSaveReady). */
  ready: boolean;
  loading: boolean;
  loadFailed: boolean;
  /** Active machines. */
  machineCount: number;
  rowCount: number;
  max: number;
  role: string | null | undefined;
}): AddMachineReason | null {
  if (input.loading) return { code: "loading", reason: "Loading machines...", link: false };
  if (input.loadFailed) return { code: "load_failed", reason: "Couldn't load the machines. Retry above.", link: false };
  if (!input.ready) return { code: "loading", reason: "Loading machines...", link: false };
  if (input.machineCount === 0) return { code: "none", reason: "No machines set up yet.", link: input.role === "admin" || input.role === "office" };
  if (input.rowCount >= input.max) return { code: "at_max", reason: `A job can have at most ${input.max} machines.`, link: false };
  if (input.rowCount >= input.machineCount) return { code: "on_every_machine", reason: "This job is already on every machine.", link: false };
  return null;
}
