import { describe, expect, it } from "vitest";
import { auditSchema, expenseSchema, invoiceSchema, sendSchema } from "@/lib/validation";

describe("API boundary validation", () => {
  it("rejects an invoice whose due date precedes its issue date", () => {
    const result = invoiceSchema.safeParse({
      client: "Atlas",
      title: "Consulting",
      issueDate: "2026-08-20",
      dueDate: "2026-08-01",
      amountZec: "0.1",
      vatRate: 20,
      vaultId: "vault-export",
    });
    expect(result.success).toBe(false);
  });

  it("rejects nonexistent calendar dates", () => {
    expect(
      invoiceSchema.safeParse({
        client: "Atlas",
        title: "Consulting",
        issueDate: "2026-02-31",
        dueDate: "2026-99-99",
        amountZec: "0.1",
        vatRate: 20,
        vaultId: "vault-export",
      }).success,
    ).toBe(false);
  });

  it("accepts a valid expense", () => {
    expect(
      expenseSchema.safeParse({
        requestId: "123e4567-e89b-42d3-a456-426614174001",
        vendor: "Node Harbor",
        category: "Infrastructure",
        description: "Test node",
        date: "2026-08-01",
        amountZec: "0.01000000",
        vatRate: 20,
        vaultId: "vault-operations",
        payToAddress: "ztestsapling1n65uaftvs2g7075q2x2a04shfk066u3lldzxsrprfrqtzxnhc9ps73v4lhx4l9yfxj46sl0q90k",
      }).success,
    ).toBe(true);
  });

  it("rejects a short or malformed payment address at the HTTP boundary", () => {
    expect(sendSchema.safeParse({ toAddress: "mainnet", amountZec: "1", memo: "x" }).success).toBe(false);
  });

  it("requires the audit scope to be a calendar month", () => {
    expect(
      auditSchema.safeParse({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        vaultId: "vault-export",
        period: "2026-08",
        anchor: false,
      }).success,
    ).toBe(true);
    expect(
      auditSchema.safeParse({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        vaultId: "vault-export",
        period: "Q3",
        anchor: false,
      }).success,
    ).toBe(false);
    expect(
      auditSchema.safeParse({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        vaultId: "vault-export",
        period: "2026-99",
        anchor: false,
      }).success,
    ).toBe(false);
  });
});
