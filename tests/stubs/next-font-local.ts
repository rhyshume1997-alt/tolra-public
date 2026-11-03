/**
 * next/font/local for the unit tests. In the app, Next's compiler turns each font call into self-hosted files at build time; plain
 * Node (vitest) has no compiler, so the loader here returns the same shape with empty class names.
 */
type FontResult = { className: string; variable: string; style: { fontFamily: string } };
export default function localFont(): FontResult {
  return { className: "", variable: "", style: { fontFamily: "" } };
}
