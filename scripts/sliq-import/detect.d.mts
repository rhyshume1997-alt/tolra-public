/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const ENCODINGS: string[];
export function detectEncoding(bytes: Uint8Array): string;
export function decodeBytes(bytes: Uint8Array, encoding: string): string;
export function detectDateFormat(values: any[]): { format: string | null; ambiguous: boolean; examples: string[]; conflict: string | null };
