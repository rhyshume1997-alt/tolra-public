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

/** Hero. */
export const HERO_SUBHEAD = "Every enquiry, quote, job and invoice in one place, so nothing gets lost between the office and the shop floor.";
export const SEE_HOW_LABEL = "See how it works";

/** "Sound familiar?": the problems a small shop lives with. Plain descriptions, no numbers. */
export const PAIN_TITLE = "Sound familiar?";
export const PAIN_CARDS = [
  { title: "Quotes stuck in an inbox", detail: "An enquiry comes in, gets buried under everything else, and the customer ends up chasing you for an answer." },
  { title: "The schedule on a whiteboard", detail: "Which machine is free, and when, lives on a whiteboard or in someone's head." },
  { title: "Finished jobs never invoiced", detail: "The work goes out of the door, the paperwork lags behind, and a job slips through without an invoice." },
  { title: "Drawings on paper", detail: "The latest revision is a printout somewhere on the shop floor, and nobody is quite sure it is the right one." },
] as const;

/** Trust strip. Each item is something the code on main does today (checked 2 Nov); "Built in Glasgow" is stated by the founder. */
export const TRUST_ITEMS = ["Admin two-step sign-in", "No tracking cookies on this page", "Built in Glasgow"] as const;

export const FLOW_STEPS = [
  { id: "enquiry", label: "Enquiry", caption: "Log the enquiry against the customer, with the request and your notes, so it does not sit in an inbox or on a scrap of paper." },
  { id: "quote", label: "Quote", caption: "Price the job from material, machine time and labour, then send a quote with your logo, your numbering, VAT and terms." },
  { id: "po", label: "PO", caption: "When the customer's purchase order comes back, upload it against the quote and record its number. Accepting the quote makes the sales order." },
  { id: "worksheet", label: "Job worksheet", caption: "The job gets a worksheet with its drawings, material details and the machine for each operation, ready for the workshop." },
  { id: "schedule", label: "Machine schedule", caption: "Book jobs onto machines and see when each machine is next free." },
  { id: "signoff", label: "Sign-off", caption: "The operator signs the worksheet off. A finished job shows as waiting for inspection, and as Complete once it passes." },
  { id: "invoice", label: "Invoice", caption: "When a delivery note goes out, a draft invoice can be made from it. You check the draft before it is issued, and customer emails wait for your approval before they are sent." },
] as const;

export const FEATURES = [
  { title: "Quotes, purchase orders and invoices", detail: "Documents with your logo, your numbering, VAT and terms." },
  { title: "Job worksheets", detail: "Drawings, material details, machines and operator sign-off in one place." },
  { title: "Machine schedule", detail: "Book jobs onto machines and see when each machine is free." },
  { title: "Optional AI helper", detail: "It can draft a quote from an enquiry email for you to check. It is off until your admin switches it on, and nothing is sent until you approve it." },
] as const;

export const WHO_TITLE = "Who it's for";
export const WHO_TEXT = "Small CNC, machining and fabrication shops that are owner-run, with the office and the shop floor in the same building.";

export const START_TITLE = "How getting started works";
export const START_STEPS = [
  { title: "A 20-minute chat", detail: "You tell me how your shop runs today, and I'll show you whether Tolra fits." },
  { title: "Set up your templates, machines and customers", detail: "Your quote and invoice templates, your machines and your customers, set up the way your shop works." },
  { title: "Run live jobs alongside your current system", detail: "Start with real jobs while your existing way of working carries on." },
] as const;

/** FAQ. Answers are plain text (they also go into the FAQPage structured data, so only what is shown is described). */
export const FAQ_TITLE = "Questions";
export const FAQ = [
  {
    question: "How is it secured?",
    answer:
      "Each company's data is kept apart from every other company's by row-level security in the database itself, not only in the screens. People see and do only what their role allows (admin, office, workshop or viewer), and those roles are checked on the server as well as in the app. Admins can protect their sign-in with a second step from an authenticator app, and anyone newly made an admin is asked to set it up.",
  },
  { question: "Where is my data hosted?", answer: "In the UK. The database, sign-ins and stored files are in London, and the app runs on servers in London." },
  {
    question: "Is there a phone app?",
    answer: "Tolra is a web app, so there is nothing to find in an app store. Open it in your phone's browser and add it to your home screen, and it opens full screen like an app, with the Tolra icon.",
  },
  {
    question: "Can I export my data?",
    answer:
      "Yes. Customers, suppliers, quotes, sales orders, purchase orders, jobs and invoices each download as a CSV or Excel file. A year-end export gives you one zip with the PDF of every issued invoice, sent quote, purchase order and delivery note for the period, plus spreadsheets of the totals and payments.",
  },
  { question: "Does it work with Xero or Sage?", answer: "Xero is coming at launch. Sage isn't supported yet." },
  { question: "What does it cost?", answer: "I'll talk it through with you on the call." },
] as const;

/** Closing section. */
export const CLOSE_TITLE = "Tell me how your shop runs and I'll show you whether Tolra fits.";
/** The one-line privacy note in the footer, next to the Privacy link. */
export const PRIVACY_NOTE = "Privacy: I only use the details you send me to reply to your enquiry, and this page sets no tracking cookies.";

export const CLOSE_CALL_LINE = "On the call you tell me how quotes, jobs and invoices move through your shop today, and I'll show you whether Tolra fits it.";

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
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: FAQ.map((item) => ({ "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } })),
    },
  ];
}

/** Icons for the public pages ("/" and "/privacy"); the app's pages keep the icon links from app/layout.tsx. */
export const MARKETING_ICONS = {
  icon: [
    { url: "/icons/favicon.ico", sizes: "16x16 32x32 48x48" },
    { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
    { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
  ],
  apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
};

/** The privacy page ("/privacy"). All first person singular. */
export const PRIVACY_PATH = "/privacy";
export const PRIVACY_LABEL = "Privacy";
export const PRIVACY_TITLE = "Privacy at Tolra";
export const PRIVACY_DESCRIPTION = "What I collect through this site, how Tolra handles a company's records, where everything is stored in the UK, the services I use and how long I keep it.";
export const PRIVACY_UPDATED = "Last updated: 2 November 2026.";

/** Who runs the site. Reads naturally with or without a name; never leaves a gap. */
export function privacyWhoIAm(name: string = FOUNDER_NAME): string {
  return name
    ? `This site and Tolra are run by ${name}, trading as Tolra, who is the controller for the details you send through this site.`
    : "This site and Tolra are run by Tolra, which is the controller for the details you send through this site.";
}

/** The rights paragraph's contact sentence: a mailto link when an email is set, the booking link when not. */
export function privacyContact(email: string = CONTACT_EMAIL): { before: string; linkText: string; href: string; after: string } {
  return email
    ? { before: "To ask, email me at ", linkText: email, href: `mailto:${email}`, after: "." }
    : { before: "To ask, use ", linkText: "the booking link", href: BOOKING_URL, after: " and tell me what you need." };
}

export const PRIVACY_SECTIONS = [
  { id: "who", title: "Who I am" },
  {
    id: "collects",
    title: "What this site collects",
    paragraphs: [
      "Only what you send me (your name, email address, company and message) and the details you give when you book a call through the booking link, which is handled by Google Calendar.",
      "This site sets no tracking cookies and runs no analytics.",
    ],
  },
  {
    id: "app",
    title: "Using Tolra (the app)",
    paragraphs: [
      "Each company that uses Tolra decides what goes into its account (customers, suppliers, quotes, jobs, invoices and its staff's sign-in details) and is the controller of those records. I process them only to run Tolra for that company.",
    ],
  },
  {
    id: "stored",
    title: "Where it's stored",
    paragraphs: ["In the UK. The database, sign-ins and stored files are with Supabase in London, and the app runs on Vercel's servers in London."],
  },
  {
    id: "services",
    title: "Services I use",
    paragraphs: ["I use these services to run this site and Tolra."],
    list: [
      "Supabase: database, sign-in and stored files (London).",
      "Vercel: runs the website and app (London servers).",
      "Resend: sends the app's emails. It is a US company, so the content of those emails passes through it.",
      "Google Calendar: call bookings.",
    ],
  },
  {
    id: "keep",
    title: "How long I keep it",
    paragraphs: [
      "I keep website enquiries and booking details only as long as I need them to reply to you and to keep reasonable business records. Ask me and I'll delete them.",
      "A company that stops using Tolra can ask me for an export of its data and for its data to be deleted, and I'll do both promptly. Financial records a company must keep by law are its own to export and keep.",
    ],
  },
  {
    id: "rights",
    title: "Your rights and contact",
    paragraphs: [
      "You can ask to see, correct or delete your details.",
      "If your details are in a company's Tolra account, ask that company first, and I'll help them with your request.",
    ],
  },
] as { id: string; title: string; paragraphs?: string[]; list?: string[] }[];
