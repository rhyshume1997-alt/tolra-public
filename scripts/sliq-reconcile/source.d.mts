/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const EXTRA_KINDS: Record<string, any>;
export function resolveMappingFile(idOrPath: string): string;
export function loadSource(folder: string, opts?: any): Promise<any>;
