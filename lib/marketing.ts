/** Content and links for the public home page ("/"). Plain data, no server code, so tests can read it. */

export const SITE_URL = "https://tolra.co.uk";
export const SITE_TITLE = "Tolra: job management for small CNC & fabrication shops";
export const SITE_DESCRIPTION =
  "Quotes, purchase orders, job worksheets, machine schedule and invoices for small CNC and fabrication shops, in one place. Built by an engineer in Glasgow.";

/** The Google Calendar booking page behind every "Book a free 20-minute chat" button. */
export const BOOKING_URL = "https://calendar.google.com/calendar/appointments/AcZssZ35nSQ_2lobUifPsul__TiweHpPV1aRWuWbssQ=";

/**
 * Contact email and founder name are set per deployment (Vercel project env), never committed:
 *   NEXT_PUBLIC_CONTACT_EMAIL   the address shown in the footer (the footer line is left out when unset)
 *   NEXT_PUBLIC_FOUNDER_NAME    the name shown on the "Built by an engineer in Glasgow" line (left out when unset)
 * Both are read at build time (NEXT_PUBLIC_ values are inlined), so a change needs a redeploy.
 */
export const CONTACT_EMAIL = (process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "").trim();
export const FOUNDER_NAME = (process.env.NEXT_PUBLIC_FOUNDER_NAME ?? "").trim();

/** Where the founder's own page lives. */
export const FOUNDER_URL = "https://www.rhyshume.co.uk/tolra";

export const CTA_LABEL = "Book a free 20-minute chat";

/** The only proof the page makes. */
export const PROOF_LINE = "In pilot in two working shops, JNR Engineering and Marpet Fabrications.";

export const FLOW_STEPS = [
  { id: "enquiry", label: "Enquiry + drawing", caption: "An enquiry arrives with its drawing. It is logged against the customer, so nothing lives in an inbox or on a scrap of paper." },
  { id: "quote", label: "Quote", caption: "Price the job from materials, machine time and bought-in parts. The quote goes out on your branded template with your numbering, VAT and terms." },
  { id: "po", label: "PO", caption: "When the customer's purchase order comes back, it is attached to the quote and the order is confirmed." },
  { id: "worksheet", label: "Job worksheet", caption: "The accepted order becomes a job worksheet: the drawing, the materials, the operations and the machine times, ready for the workshop." },
  { id: "schedule", label: "Machine schedule", caption: "Jobs are booked onto machines. See which machines are free and when each job will finish." },
  { id: "signoff", label: "Sign-off", caption: "The operator signs the job off at the machine, and the office sees it as done." },
  { id: "invoice", label: "Invoice", caption: "A finished job turns into an invoice from the same numbers. A draft waits for your approval before anything is sent." },
] as const;

export const FEATURES = [
  { title: "Quotes, POs and invoices", detail: "Branded documents with your numbering, VAT and terms." },
  { title: "Job worksheets", detail: "Drawings, materials, machine times and sign-off in one place." },
  { title: "Machine schedule", detail: "See which machines are free and when each job will finish." },
  { title: "AI-drafted quotes and invoices", detail: "Drafts are prepared for you and wait for your approval. Nothing is sent until you say so." },
] as const;

/** Structured data for search engines. No offers, prices or ratings. */
export function jsonLd() {
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Tolra",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: `${SITE_URL}/`,
      description: SITE_DESCRIPTION,
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Tolra",
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/icons/icon-512.png`,
    },
  ];
}
