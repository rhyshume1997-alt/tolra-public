/**
 * next/font/google for the unit tests. In the app, Next's compiler turns each font call into self-hosted files at build time; plain
 * Node (vitest) has no compiler, so the loaders here return the same shape with empty class names.
 */
type FontResult = { className: string; variable: string; style: { fontFamily: string } };
const loader = () => (): FontResult => ({ className: "", variable: "", style: { fontFamily: "" } });

export const Barlow_Condensed = loader();
export const IBM_Plex_Sans = loader();
export const IBM_Plex_Mono = loader();
