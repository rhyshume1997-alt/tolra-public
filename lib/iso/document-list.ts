/**
 * The nine draft ISO 9001 documents, as data. Inputs: none. Output: ISO_DOCUMENTS, each a title, the clause it supports and sections
 * of wording. Wording uses {{tokens}} that lib/iso/fill.ts replaces with the company's details or with counts read from Tolra; a token
 * with no value prints "[to complete]".
 * Must not change: no wording here may invent a record (an inspection, training, calibration, audit, objective, customer-satisfaction
 * or management-review entry), and none may claim a standard is met (tests/unit/iso-wording.test.ts). Prompts ask the company to
 * write its own content; they never supply it.
 */

/** A section line: plain wording, or a labelled value that comes only from a token. */
export type IsoSection = {
  heading: string;
  lines: string[];
  /** A table of blank rows to fill in by hand (the internal audit checklist). Cells are left empty on purpose. */
  blankTable?: { columns: string[]; rows: number };
};

export type IsoDocument = {
  id: string;
  title: string;
  /** The ISO 9001:2015 clause(s) the document supports. */
  clause: string;
  /** File name (without extension) in the zip. */
  filename: string;
  sections: IsoSection[];
};

const TO_COMPLETE = "[to complete]";

export const ISO_DOCUMENTS: IsoDocument[] = [
  {
    id: "quality-policy", title: "Quality policy", clause: "5.2", filename: "01-quality-policy",
    sections: [
      { heading: "Company", lines: ["{{company}}", "{{address}}"] },
      { heading: "Policy statement", lines: ["Write the company's own quality policy here: what the company commits to for its customers and for improving how it works.", "Statement: " + TO_COMPLETE] },
      { heading: "Objectives", lines: ["List the quality objectives the company has set, with who owns each and how it is measured.", "Objectives: " + TO_COMPLETE] },
      { heading: "Issue", lines: ["Issued by the company's top management on: " + TO_COMPLETE, "Signed: " + TO_COMPLETE] },
    ],
  },
  {
    id: "qms-scope", title: "QMS scope and context", clause: "4.1, 4.2, 4.3", filename: "02-qms-scope-and-context",
    sections: [
      { heading: "Company", lines: ["{{company}}", "{{address}}"] },
      { heading: "Scope of the quality management system", lines: ["State the products, services, sites and activities the system covers, and anything excluded with the reason.", "Scope: " + TO_COMPLETE] },
      { heading: "Context (clause 4.1)", lines: ["Internal and external issues that matter to the company's purpose.", "Issues: " + TO_COMPLETE] },
      { heading: "Interested parties (clause 4.2)", lines: ["The parties that matter (for example customers, suppliers, regulators) and what each needs.", "Parties and needs: " + TO_COMPLETE] },
    ],
  },
  {
    id: "documented-information", title: "7.5 Documented information", clause: "7.5", filename: "03-documented-information",
    sections: [
      { heading: "Purpose", lines: ["How the company creates, updates, controls and keeps its documents and records."] },
      { heading: "Creating and updating", lines: ["Who writes, reviews and releases each kind of document, and how its identification and version are shown.", "Method: " + TO_COMPLETE] },
      { heading: "Control", lines: ["Where documents are kept, who may read and change them, how old versions are withdrawn and how retention is decided.", "Method: " + TO_COMPLETE] },
      { heading: "What Tolra keeps", lines: ["Tolra keeps a change history of records made in it (who changed what and when). Whether that meets the company's retention and protection needs is for the company to decide: " + TO_COMPLETE] },
    ],
  },
  {
    id: "external-providers", title: "8.4 External providers", clause: "8.4", filename: "04-external-providers",
    sections: [
      { heading: "Purpose", lines: ["How the company chooses, checks and keeps control of suppliers of materials, parts and processes."] },
      { heading: "Selection and evaluation", lines: ["The criteria used to accept a supplier and how often each is reviewed.", "Criteria: " + TO_COMPLETE] },
      { heading: "Supplier statuses held in Tolra", lines: ["Suppliers listed in Tolra: {{suppliersTotal}}", "Approved: {{suppliersApproved}}", "Conditional: {{suppliersConditional}}", "Blocked: {{suppliersBlocked}}", "A status is a flag set by an admin. It is not an evaluation record: write the company's evaluation method above."] },
      { heading: "Information given to providers", lines: ["What the company tells suppliers about what it is buying and what it needs back (certificates, tolerances, delivery).", "Information: " + TO_COMPLETE] },
    ],
  },
  {
    id: "production", title: "8.5 Production", clause: "8.5.1, 8.5.2", filename: "05-production",
    sections: [
      { heading: "Purpose", lines: ["How production is carried out under controlled conditions."] },
      { heading: "Controlled conditions", lines: ["Work instructions, drawings and revisions used, equipment and who may release work.", "Method: " + TO_COMPLETE] },
      { heading: "Identification and traceability", lines: ["Which products or jobs must be traceable to material and how the identity is kept.", "Jobs marked traceable in Tolra: {{traceableJobs}}", "Method: " + TO_COMPLETE] },
      { heading: "Customer property", lines: ["How customers' drawings, materials and data are looked after.", "Method: " + TO_COMPLETE] },
    ],
  },
  {
    id: "nonconforming-outputs", title: "8.7 Nonconforming outputs", clause: "8.7", filename: "06-nonconforming-outputs",
    sections: [
      { heading: "Purpose", lines: ["How the company stops nonconforming work being used or delivered by mistake and decides what happens to it."] },
      { heading: "Handling", lines: ["Who may decide to rework, scrap, repair or accept a concession, and who tells the customer.", "Method: " + TO_COMPLETE] },
      { heading: "Records", lines: ["Open nonconformance records in Tolra (confirmed NCRs, all dates): {{openNcrs}}", "What is recorded for each one (the nonconformity, the action taken, any concession and who decided): " + TO_COMPLETE] },
    ],
  },
  {
    id: "corrective-action", title: "10.2 Corrective action", clause: "10.2", filename: "07-corrective-action",
    sections: [
      { heading: "Purpose", lines: ["How the company reacts to a nonconformity, finds its cause and stops it happening again."] },
      { heading: "Steps", lines: ["React and contain; find the cause; decide the action; do it; check it worked; update risks if needed.", "How each step is done and recorded: " + TO_COMPLETE] },
      { heading: "Review", lines: ["How long after an action is raised the company reviews it, and who does that.", "Method: " + TO_COMPLETE] },
    ],
  },
  {
    id: "records-index", title: "Records index", clause: "7.5.3", filename: "08-records-index",
    sections: [
      { heading: "Records the company keeps", lines: ["For each record type: where it is kept, who owns it, how long it is kept and how it is protected."] },
      { heading: "Records Tolra holds", lines: ["Quotes, sales orders, jobs, inspections, nonconformance records, purchase orders, delivery notes, invoices and the change history of each. Retention period for each: " + TO_COMPLETE] },
      { heading: "Records held elsewhere", lines: ["List any records kept outside Tolra (for example training, calibration, audit and review records) with where they are.", "Records: " + TO_COMPLETE] },
      { heading: "Authorised inspectors", lines: ["People on Tolra's authorised inspectors list: {{inspectors}}"] },
    ],
  },
  {
    id: "internal-audit-checklist", title: "Internal audit checklist", clause: "9.2", filename: "09-internal-audit-checklist",
    sections: [
      { heading: "How to use", lines: ["Blank rows for the company's own audits. Nothing here has been audited: every row is filled in by hand."] },
      { heading: "Audit rows", lines: [], blankTable: { columns: ["Date", "Area or clause", "Auditor", "Finding", "Action and owner"], rows: 12 } },
    ],
  },
];
