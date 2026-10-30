/** Checks on a document PDF uploaded for a one-click e-mail (app/api/email/send: the PDF is built in the browser). */

export const MAX_PDF_BYTES = 5 * 1024 * 1024;

/** Letters and digits only, lower case: "Q-1042" and "quote-Q-1042.pdf" compare as "q1042" within "quoteq1042pdf". */
const squash = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The file name carries one of the document's own numbers. */
export function fileNameMatches(filename: string, numbers: unknown[]): boolean {
  const name = squash(filename);
  return numbers.map(squash).some((number) => number.length >= 2 && name.includes(number));
}
