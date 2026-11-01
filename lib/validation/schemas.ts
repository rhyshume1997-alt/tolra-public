import { z } from "zod";

import { friendlyError } from "@/lib/friendly-error";
import { decimalPlaces, PRICE_DECIMALS, QUANTITY_DECIMALS } from "@/lib/money";

export const emailSchema = z.string().email("Enter a valid email address");
export const requiredText = z.string().trim().min(1, "This field is required");
export const moneyValue = z.coerce.number().min(0, "Value cannot be negative");
export const positiveQuantity = z.coerce.number().min(1, "Quantity must be at least 1");

/** Customer name, 1..200 characters. */
export const customerName = z.string().trim().min(1, "Customer is required").max(200, "Customer name is too long");
/** Line description, 1..500 characters. */
export const lineDescription = z.string().trim().min(1, "Every line needs a description").max(500, "Descriptions are limited to 500 characters");
/** Quantity: a finite number above zero, at most 3 decimal places (the stored scale; never silently rounded). */
export const quantityAboveZero = z.number({ message: "Quantity must be a number" })
  .refine((n) => Number.isFinite(n) && n > 0, "Quantity must be more than 0")
  .refine((n) => decimalPlaces(n) <= QUANTITY_DECIMALS, `Quantities can have at most ${QUANTITY_DECIMALS} decimal places`);
/** Unit price: a finite number, zero or more, in pounds and pence (at most 2 decimal places). */
export const unitPriceValue = z.number({ message: "Price must be a number" })
  .refine((n) => Number.isFinite(n) && n >= 0, "Price can't be negative")
  .refine((n) => decimalPlaces(n) <= PRICE_DECIMALS, "Prices are in pounds and pence (at most 2 decimal places)");
/** Any other amount of money (carriage, order value): zero or more, pounds and pence. */
export const moneyAmount = (label: string) => z.number({ message: `${label} must be a number` })
  .refine((n) => Number.isFinite(n) && n >= 0, `${label} can't be negative`)
  .refine((n) => decimalPlaces(n) <= PRICE_DECIMALS, `${label} is in pounds and pence (at most 2 decimal places)`);
const optionalNote = z.string().trim().max(2000, "Notes are limited to 2000 characters");

export const customerSchema = z.object({
  name: customerName,
  email: emailSchema.optional().or(z.literal("")),
  phone: z.string().max(50).optional(),
  /** Migration 073. */
  mobile: z.string().trim().max(40, "The mobile number is at most 40 characters.").optional(),
});

/** First human-readable message from a failed parse. */
export function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Check the details and try again.";
}

/** Thrown for bad user input. The message is written for users, so it is safe to show as is. */
export class ValidationError extends Error {}

/** Parses with a schema and returns the data, or throws a ValidationError carrying the first friendly message. */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError(firstIssue(result.error));
  return result.data;
}

export const documentLineSchema = z.object({
  description: lineDescription,
  quantity: quantityAboveZero,
  unitPrice: unitPriceValue,
});

/** Quote builder save: customer, at least one valid line. */
export const quoteSaveSchema = z.object({
  customer: customerName,
  description: z.string().trim().max(2000, "Description is too long"),
  customerNotes: optionalNote,
  internalNotes: optionalNote,
  terms: z.string().trim().max(200, "Terms are too long"),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date").or(z.literal("")),
  // The customer's PO (migration 123): optional; trimmed, at most 100 characters (as on the order).
  customerPo: z.string().trim().max(100, "Order number is too long").default(""),
  lines: z.array(documentLineSchema).min(1, "Add at least one line item"),
});

export const invoiceSaveSchema = z.object({
  customer: customerName,
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid invoice date"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid due date"),
  /** Date of supply, only when it differs from the invoice date (printed as "Tax Point"). Empty = same as the invoice date. */
  taxPoint: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid tax point date")]).optional(),
  terms: z.string().trim().max(200),
  quoteRef: z.string().trim().max(50),
  customerPo: z.string().trim().max(100),
  carriage: moneyAmount("Carriage"),
  lines: z.array(documentLineSchema).min(1, "Add at least one line item"),
});

export const deliveryNoteSaveSchema = z.object({
  customer: customerName,
  invoiceRef: z.string().trim().regex(/^INV[-\s]?\d+$/i, "Enter an invoice number like INV-0456").or(z.literal("")),
  job: z.string().trim().max(50),
  shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid ship date"),
  taxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid tax date"),
  notes: optionalNote,
  items: z.array(z.object({ description: lineDescription, quantity: quantityAboveZero })).min(1, "Add at least one item"),
});

export const deliveryNoteEditSchema = z.object({
  customer: customerName,
  job: z.string().trim().max(50, "Job reference is too long"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid delivery date"),
  shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid ship date").or(z.literal("")),
  taxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid tax date").or(z.literal("")),
  shipVia: z.string().trim().max(100, "Ship via is too long"),
});

export const signatureSchema = z.object({
  signedByName: z.string().trim().min(1, "Enter who signed").max(200, "Name is too long"),
  signedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid signed date"),
  signatureNotes: optionalNote,
});

export const salesOrderSaveSchema = z.object({
  customer: customerName,
  // Optional (customer_po is nullable, as on Mark accepted): empty means the order is made with a provisional SO-#### number.
  customerPo: z.string().trim().max(100, "Order number is too long"),
  quoteRef: z.string().trim().max(50),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid order date"),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid delivery date").or(z.literal("")),
  totalValue: moneyAmount("Value"),
});

export const purchaseOrderSaveSchema = z.object({
  supplier: z.string().trim().min(1, "Select a supplier").max(200),
  expectedDelivery: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date").or(z.literal("")),
  notes: optionalNote,
  lines: z.array(documentLineSchema).min(1, "Add at least one line item"),
});

export const supplierSchema = z.object({
  name: requiredText,
  email: emailSchema,
  onTimeRate: z.coerce.number().min(0).max(100),
  status: z.enum(["Reliable", "Watch", "High risk"]),
});

export const stockSchema = z.object({
  sku: requiredText,
  material: requiredText,
  currentStock: z.coerce.number().min(0),
  minStock: z.coerce.number().min(0),
  reorderQty: z.coerce.number().min(0),
});

export const rfqSchema = z.object({
  customer: requiredText,
  email: emailSchema.optional().or(z.literal("")),
  description: requiredText,
  quantity: positiveQuantity.optional(),
  material: requiredText,
  estimatedValue: moneyValue.optional(),
});

export const quoteSchema = z.object({
  customer: requiredText,
  description: requiredText,
  value: moneyValue,
  validUntil: requiredText,
});

export const jobSchema = z.object({
  customer: requiredText,
  description: requiredText,
  quantity: positiveQuantity,
  material: requiredText,
  dueDate: requiredText,
});

export const invoiceSchema = z.object({
  customer: requiredText,
  description: requiredText,
  quantity: positiveQuantity,
  unitPrice: moneyValue,
  dueDate: requiredText,
});

export const salesOrderSchema = z.object({
  customer: requiredText,
  deliveryDate: requiredText,
  totalValue: moneyValue,
});

export const purchaseOrderSchema = z.object({
  supplier: requiredText,
  expectedDate: requiredText,
  totalValue: moneyValue,
});

export const deliveryNoteSchema = z.object({
  customer: requiredText,
  jobRef: requiredText,
  deliveryDate: requiredText,
});

/** Message to toast for a failed action: validation text as written, anything else through friendlyError. */
export function userMessage(err: unknown, fallback?: string) {
  return err instanceof ValidationError ? err.message : friendlyError(err, fallback);
}
