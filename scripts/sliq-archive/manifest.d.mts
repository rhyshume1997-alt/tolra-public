/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const MANIFEST_FORMAT: string;
export const MAP_FORMAT: string;
export class ArchiveError extends Error {}
export const DIR_TYPES: Record<string, string>;
export function checkExportedAt(value: any): string;
export function parseMap(json: any): any;
export function classify(archivePath: string, map?: any): { recordType: string; exportedAt?: string };
export function buildManifest(opts: { archiveDir: string; exportedAt: string; map?: any }): any;
export function manifestCsv(manifest: any): string;
