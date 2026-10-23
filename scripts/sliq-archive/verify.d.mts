/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const REPORT_FORMAT: string;
export function verifyArchive(opts: {
  archiveDir: string;
  manifestPath: string;
  expectedManifestSha256?: string;
  metadataPath?: string;
  docColumn?: string;
  fileColumn?: string;
  attachmentsDir?: string;
}): any;
export function renderText(report: any): string;
