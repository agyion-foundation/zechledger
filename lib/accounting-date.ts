import type { Invoice } from "@/lib/types";

export function accountingDate(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid accounting timestamp.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function accountingMonth(date = new Date()): string {
  return accountingDate(date).slice(0, 7);
}

export function invoiceStatusAt(
  invoice: Pick<Invoice, "status" | "dueDate" | "paymentTxid">,
  asOf: string,
): Invoice["status"] {
  if (invoice.paymentTxid || !["pending", "overdue"].includes(invoice.status)) return invoice.status;
  return invoice.dueDate < asOf ? "overdue" : "pending";
}
