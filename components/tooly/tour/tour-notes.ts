/**
 * BOUNDARY (Tooly, tour notes): the fixed "What happens here and how it gets produced" note for each tour step, as data.
 * Inputs: none (static). Outputs: TOUR_NOTES (one entry per step id used by tour-steps.ts and role-tour-steps.ts) and tourNoteFor(id),
 * read by admin-tour.tsx, which shows the note only when the person opens it.
 * Fixed plain words, no AI, no live data, no answers. Each note only restates what the step's page does and where its result comes from;
 * it never promises anything the app does not do. No em or en dashes.
 * Must not change: that every step id has a note (a test pins it), or that a note says a thing happens that the page does not do.
 */
export type TourNote = { happens: string; produced: string };

export const TOUR_NOTES: Readonly<Record<string, TourNote>> = {
  hello: {
    happens: "Tooly opens by itself the first time you sign in, then never again unless you ask. It points at things and talks. It does not press anything.",
    produced: "The steps are fixed words written for your role. Nothing here is made up on the spot, and no AI is used.",
  },
  "sign-in": {
    happens: "You sign in once and land on the Dashboard. Admins add a six digit code as a second check.",
    produced: "The code comes from the authenticator app on your phone and changes every thirty seconds. Tolra checks it against that app.",
  },
  dashboard: {
    happens: "The Dashboard shows what needs you today, then the money, the work, the machines and your team.",
    produced: "Each block is read from your own company's quotes, jobs, invoices and machines when the page opens. Nothing on it is typed in here.",
  },
  attention: {
    happens: "The Needs attention card lists things waiting on a person, such as work that is late or something to approve.",
    produced: "It is counted from your company's own records each time the page opens, so it changes as people work.",
  },
  menu: {
    happens: "The menu lists every page you can open. A page that is switched off for you is not shown.",
    produced: "The list comes from your role, the pages an admin let you see, and the sections your company has switched on in Settings.",
  },
  quotes: {
    happens: "Quotes is where a price for a customer is worked out and kept.",
    produced: "Each quote is a saved record in your company with its lines, VAT and total. The totals are worked out from the lines you enter.",
  },
  "new-quote": {
    happens: "New quote starts a draft: customer, lines, then Save Quote. A saved quote is only a draft.",
    produced: "The VAT and the total at the bottom are worked out from the lines as you type. Saving stores the draft and sends nothing to the customer.",
  },
  "view-quote": {
    happens: "The eye opens the quote so you can read it. Download makes a PDF on your computer.",
    produced: "The PDF is made from the saved quote and saved to your computer. It is not sent to the customer.",
  },
  "send-quote": {
    happens: "Send to Customer asks you to confirm, then either opens your own email program or sends from Tolra if email is set up.",
    produced: "If email is not set up, Tolra saves a draft in Approvals for a person to approve. Nothing leaves Tolra without that choice.",
  },
  "decide-quote": {
    happens: "Mark Accepted or Mark Rejected records the customer's answer. You cannot undo either one.",
    produced: "Accepting makes the order and, if your company has it switched on, the job. The order and job are copied from the quote's lines.",
  },
  jobs: {
    happens: "The Job Board lists every job with its status: Not started, Running, Waiting for inspection or Complete.",
    produced: "A job is made from an accepted quote (if that is switched on) or added by hand. Its status changes when someone presses its buttons.",
  },
  "new-job": {
    happens: "New job adds a job by hand: customer, what the work is and the date it is needed.",
    produced: "The job is saved in your company and appears on the Job Board. It moves through Material, Setup, Machining and Inspection as people work.",
  },
  "job-buttons": {
    happens: "Start begins the work, Finish says it is done, Inspected records the check, Reopen undoes a finish, Print gives the job sheet and Worksheet opens the details.",
    produced: "Each press saves that change to the job, so the board shows the new status.",
  },
  "job-filters": {
    happens: "Show, Due and Stage narrow the list so you find a job quickly. Late means past the date it was needed.",
    produced: "The filters only change what you see on this screen. They change no job.",
  },
  schedule: {
    happens: "The Machine Schedule shows when each machine is free. New booking puts a job on a machine.",
    produced: "It is drawn from the bookings saved for each machine. A booking you add is saved and shows to everyone in your company.",
  },
  "main-buttons": {
    happens: "These buttons repeat on every page: make something new, open a record, open the menu, search, see emails waiting for your OK, and log out.",
    produced: "Log out ends your session on this device. The bell count comes from drafted emails waiting in the Approval Queue.",
  },
  settings: {
    happens: "Settings is where an admin switches features on. Most are off until switched on.",
    produced: "Each switch saves a setting for your whole company. Tooly never changes a setting.",
  },
  "menu-sections": {
    happens: "Each Menu Sections switch shows or hides one page in the menu for everyone in your company.",
    produced: "The choice is saved with the company, and the menu follows it.",
  },
  "quote-to-job": {
    happens: "With this on, accepting a quote makes the job for you. Customer sign-off is a separate switch, off until you want it.",
    produced: "The job is copied from the accepted quote's lines at the moment someone presses Mark Accepted.",
  },
  "job-reports": {
    happens: "Three switches control planned against actual machine time, the NCR register and the Reports page. All are off until turned on.",
    produced: "When on, the reports are worked out from the times people record on jobs. With nothing recorded they show nothing.",
  },
  "company-details": {
    happens: "Company details, logo and colours, working hours and email templates are set here. The setup list helps you check each one.",
    produced: "What you save is used on your quotes, invoices and PDFs, and by the schedule for working hours.",
  },
  people: {
    happens: "User Management is where you add a person, give them a role and choose which pages they can see. Integrations connects Xero, Microsoft 365 email and AI.",
    produced: "A person's role and page choices are saved with their account. AI stays off until you turn it on.",
  },
  done: {
    happens: "The tour ends. Tap Tooly any time for help. You can replay this tour from the Dashboard.",
    produced: "Finishing saves a flag on your own account that says you have seen the tour. The flag is only a reminder not to show it again. It is not a permission.",
  },
  "delivery-notes": {
    happens: "A delivery note goes with finished work. Despatch means sending finished work to the customer.",
    produced: "A delivery note is a saved record that lists what went out and to whom. It is written from the job and customer you pick.",
  },
  invoices: {
    happens: "Invoicing lists what customers owe and what is unpaid. A draft invoice has no number and is not owed until a person issues it.",
    produced: "An invoice is saved with its lines, VAT and total. The number is given only when it is issued.",
  },
  customers: {
    happens: "Customers are the companies you sell to, and Suppliers are the companies you buy from.",
    produced: "They are saved records you pick from on quotes, sales orders, invoices and purchase orders, so details are typed once.",
  },
  "purchase-orders": {
    happens: "Purchase Orders record what you buy from suppliers.",
    produced: "Each one is a saved record with its supplier and lines. It only leaves Tolra if a person sends it.",
  },
  approvals: {
    happens: "The Approval Queue holds emails Tolra has drafted until a person says OK.",
    produced: "Tolra writes the draft from the record you were working on. It is sent only after someone approves it here.",
  },
  "pick-machine": {
    happens: "Pick the machine in the Machine column, or choose No machine (bench), before you press Start.",
    produced: "The machine you pick is saved on the job, so machine hours are counted against the right machine.",
  },
  hours: {
    happens: "Hours is where you clock in and out and take breaks, and see the jobs and hours you worked.",
    produced: "Each clock in, break and clock out is saved with its time. The daily and weekly hours are added up from them.",
  },
  offline: {
    happens: "If the internet drops, the Job Board still opens from this device and says Offline with the time it last synced.",
    produced: "A Start or a worksheet save waits on the device and is sent when the connection is back, so nothing you did is lost.",
  },
};

/** The note for a step id, or null when there is none. */
export function tourNoteFor(id: string): TourNote | null {
  return TOUR_NOTES[id] ?? null;
}
