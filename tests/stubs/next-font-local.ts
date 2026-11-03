/** Unit Node has no Next compiler. The production build uses the real loader and WOFF2 files. */
export default function localFont(options: { variable?: string }) {
  return { className: "", variable: options.variable ?? "", style: { fontFamily: "" } };
}
