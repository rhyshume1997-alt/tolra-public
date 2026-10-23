/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export function runManifest(args: any, log: (line: string) => void): number;
export function runVerify(args: any, log: (line: string) => void): number;
export function main(argv: string[], log?: (line: string) => void): number;
export function safeOutDir(archiveDir: string, out: string | undefined): string;
export function writeOutputs(archiveDir: string, outDir: string, files: Record<string, string>, opts: { overwrite: boolean; existsMessage: string }): void;
