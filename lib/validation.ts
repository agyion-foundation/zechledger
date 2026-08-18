import { z } from "zod";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "The date must be in YYYY-MM-DD format.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "The calendar date must be valid.");
const zecAmount = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/, "Enter a ZEC amount with no more than 8 decimal places.");

export const invoiceSchema = z
  .object({
    requestId: z.string().uuid(),
    client: z.string().trim().min(2).max(120),
    title: z.string().trim().min(3).max(180),
    issueDate: date,
    dueDate: date,
    amountZec: zecAmount,
    vatRate: z.coerce.number().int().min(0).max(100),
    vaultId: z.string().min(1).max(80),
  })
  .refine((value) => value.dueDate >= value.issueDate, {
    message: "The due date cannot be earlier than the invoice date.",
    path: ["dueDate"],
  });

export const expenseSchema = z.object({
  requestId: z.string().uuid(),
  vendor: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().min(3).max(180),
  date,
  amountZec: zecAmount,
  vatRate: z.coerce.number().int().min(0).max(100),
  vaultId: z.string().min(1).max(80),
  payToAddress: z.string().trim().min(50).max(300),
});

export const sendSchema = z.object({
  toAddress: z.string().trim().min(20).max(300),
  amountZec: zecAmount,
  memo: z.string().max(512),
  expenseId: z.string().uuid(),
});

export const auditSchema = z.object({
  requestId: z.string().uuid(),
  vaultId: z.string().min(1).max(80),
  period: z
    .string()
    .regex(/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/, "The period must be in YYYY-MM format and within 2000-01..2100-12."),
  anchor: z.boolean().default(false),
});
