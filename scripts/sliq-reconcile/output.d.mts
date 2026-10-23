/* eslint-disable @typescript-eslint/no-explicit-any */
export class OutputError extends Error {}
export const MARKER_NAME: string;
export const MARKER_FORMAT: string;
export const GENERATED_NAMES: Set<string>;
export function sha256(data: string | Uint8Array): string;
export function inspectOutDir(dir: string, allowOther: boolean): { removable: string[] };
export function writeReport(outDir: string, files: Record<string, string>, allowOther: boolean): void;
