/**
 * The company's bank details, printed on invoices only (never on quotes). Stored inside organization_settings.company_profile
 * (JSONB, no migration). Read leniently like the rest of the profile: anything missing or not text is an empty string, and
 * nothing is printed when every field is empty.
 *
 * Issued invoices do not freeze these: the issuer snapshot (migrations 019, 032) is built in SQL from a fixed list of fields,
 * so an invoice always prints the bank details the company has set today (see lib/document-snapshot.ts).
 */
export type BankDetails = {
  accountName: string;
  bankName: string;
  /** UK sort code, stored as "12-34-56". */
  sortCode: string;
  /** UK account number, 8 digits. */
  accountNumber: string;
  /** Optional, free-form. */
  iban: string;
  /** Optional, free-form. */
  bic: string;
};

export const EMPTY_BANK_DETAILS: BankDetails = { accountName: "", bankName: "", sortCode: "", accountNumber: "", iban: "", bic: "" };

const MAX_LENGTH = 80;
const KEYS = Object.keys(EMPTY_BANK_DETAILS) as Array<keyof BankDetails>;

/** Reads stored bank details leniently: unreadable or missing fields become "", text is trimmed and capped. */
export function parseBankDetails(value: unknown): BankDetails {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const bank = { ...EMPTY_BANK_DETAILS };
  for (const key of KEYS) bank[key] = typeof v[key] === "string" ? (v[key] as string).trim().slice(0, MAX_LENGTH) : "";
  return bank;
}

export type BankDetailsCheck = { bank: BankDetails; errors: string[] };

/**
 * Light checks for the settings form. A UK sort code is 6 digits (dashes or spaces allowed) and is tidied to "12-34-56";
 * a UK account number is 8 digits. A sort code and account number go together. IBAN and BIC are free-form, only trimmed.
 * Returns the tidied details and a friendly message for each problem (none = fine to save).
 */
export function validateBankDetails(input: Partial<BankDetails> | null | undefined): BankDetailsCheck {
  const bank = parseBankDetails(input);
  const errors: string[] = [];
  if (bank.sortCode) {
    const digits = bank.sortCode.replace(/[\s-]/g, "");
    if (/^\d{6}$/.test(digits)) bank.sortCode = `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
    else errors.push("The sort code needs 6 digits, like 12-34-56.");
  }
  if (bank.accountNumber) {
    const digits = bank.accountNumber.replace(/\s/g, "");
    if (/^\d{8}$/.test(digits)) bank.accountNumber = digits;
    else errors.push("The account number needs 8 digits.");
  }
  if (!errors.length && Boolean(bank.sortCode) !== Boolean(bank.accountNumber)) {
    errors.push("Enter both the sort code and the account number, or leave both empty.");
  }
  return { bank, errors };
}

export type PaymentDetailRow = { label: string; value: string };

/** The rows to print in the invoice's "Payment details" block: only the filled fields, in a fixed order. Empty = print nothing. */
export function paymentDetailRows(bank: Partial<BankDetails> | null | undefined): PaymentDetailRow[] {
  const b = parseBankDetails(bank);
  const rows: Array<[string, string]> = [
    ["Account name", b.accountName], ["Bank", b.bankName], ["Sort code", b.sortCode], ["Account number", b.accountNumber], ["IBAN", b.iban], ["BIC", b.bic],
  ];
  return rows.filter(([, value]) => value).map(([label, value]) => ({ label, value }));
}
