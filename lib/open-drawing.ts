/**
 * "Open drawing" on My jobs. It opens what the Job Board's Worksheet dialog lists as the job's drawings (listDrawings: the current revision
 * of each drawing, never one an upload replaced) through the dialog's own signed link (drawingUrl), so the two can never disagree about which
 * revision is current. A job with one drawing opens it at once; with several (different drawings, each at its current revision) the
 * operator picks, and each is named with its revision as the worksheet marks it ("Rev C (replaces A, B)").
 */
import { drawingUrl, listDrawings, type DrawingFile } from "@/lib/job-worksheet";

export type DrawingChoice = { file: DrawingFile; label: string };
export type DrawingPlan =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "one"; choice: DrawingChoice }
  | { kind: "many"; choices: DrawingChoice[] };

/** The worksheet's own marking: the file, "Rev C", and the revisions it replaced. */
export function drawingLabel(file: DrawingFile): string {
  const rev = file.revision ? `Rev ${file.revision}` : "no revision marked";
  const earlier = file.earlier?.length ? ` (replaces ${file.earlier.join(", ")})` : "";
  return `${file.name} · ${rev}${earlier}`;
}

/** What to do with the answer of listDrawings (null: Storage could not be reached). Files without a stored path (demo entries) are not drawings to open. */
export function planDrawings(drawings: DrawingFile[] | null): DrawingPlan {
  if (drawings === null) return { kind: "unavailable" };
  const choices = drawings.filter((file) => file.path).map((file) => ({ file, label: drawingLabel(file) }));
  if (choices.length === 0) return { kind: "none" };
  return choices.length === 1 ? { kind: "one", choice: choices[0] } : { kind: "many", choices };
}

export const planJobDrawings = async (jobId: string): Promise<DrawingPlan> => planDrawings(await listDrawings(jobId));

/** The signed link for a chosen drawing: the worksheet's drawingUrl, unchanged. */
export const drawingLink = (file: DrawingFile): Promise<string> => drawingUrl(file.path ?? "", file.name, file.bucket);

export const NO_DRAWING = "No drawing is attached to this job.";
export const DRAWING_UNAVAILABLE = "Couldn't open the drawing. Check your connection and try again.";
