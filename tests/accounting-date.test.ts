import { describe, expect, it } from "vitest";
import { accountingDate, accountingMonth, invoiceStatusAt } from "@/lib/accounting-date";

describe("Europe/Istanbul accounting cutoff", () => {
  it("converts the UTC month boundary to an Istanbul calendar date", () => {
    expect(accountingDate(new Date("2026-01-31T20:59:59.999Z"))).toBe("2026-01-31");
    expect(accountingDate(new Date("2026-01-31T21:00:00.000Z"))).toBe("2026-02-01");
    expect(accountingMonth(new Date("2026-01-31T21:00:00.000Z"))).toBe("2026-02");
  });

  it("computes due status using the same Istanbul as-of date", () => {
    const invoice = { status: "pending" as const, dueDate: "2026-01-31" };
    expect(invoiceStatusAt(invoice, "2026-01-31")).toBe("pending");
    expect(invoiceStatusAt(invoice, "2026-02-01")).toBe("overdue");
  });

  it("fails closed for an invalid instant", () => {
    expect(() => accountingDate(new Date("invalid"))).toThrow(/Invalid/);
    expect(() => accountingMonth(new Date("invalid"))).toThrow(/Invalid/);
  });
});
