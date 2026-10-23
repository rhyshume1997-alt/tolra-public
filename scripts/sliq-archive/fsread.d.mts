/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export function unsafePathReason(p: any): string | null;
export function foldKey(p: string): string;
export function show(s: any): string;
export function byCodePoint(a: string, b: string): number;
export function walkArchive(root: string): { files: { path: string; size: number }[]; problems: { path: string; problem: string }[] };
export function hashFile(abs: string): { size: number; sha256: string };
export function sha256Bytes(bytes: Uint8Array): string;
export function isInside(parent: string, child: string): boolean;
export function realish(p: string): string;
export function overlaps(a: string, b: string): boolean;
