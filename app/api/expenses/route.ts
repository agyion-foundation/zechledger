import { randomUUID } from "node:crypto";
import { appendJournal } from "@/lib/accounting";
import { ApiConflictError, apiError, noStoreJson } from "@/lib/http";
import { netOfVatInclusiveKurus, parseZec, tryFromZatoshi } from "@/lib/money";
import { expenseAccountCode } from "@/lib/accounting-policy";
import { getState, mutateState } from "@/lib/store";
import { expenseSchema } from "@/lib/validation";
import { canonicalShieldedTestnetAddress } from "@/lib/zcash-address";
import type { Expense } from "@/lib/types";
import { expenseCommitmentPayload, recordCommitment } from "@/lib/commitments";
import { accountFingerprintForVault } from "@/lib/vault-config";
import { verifyConfiguredWalletScope } from "@/lib/zcash-rpc";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = expenseSchema.parse(await request.json());
    const zatoshi = parseZec(input.amountZec);
    const payToAddress = canonicalShieldedTestnetAddress(input.payToAddress);
    if (zatoshi <= 0n) throw new Error("The expense amount must be greater than zero.");
    const snapshot = await getState();
    const prior = snapshot.expenses.find((item) => item.requestId === input.requestId);
    if (prior) {
      const requestFingerprint = recordCommitment({
        kind: "expense-request",
        requestId: input.requestId,
        vendor: input.vendor,
        category: input.category,
        description: input.description,
        date: input.date,
        zatoshi: zatoshi.toString(),
        vatRate: input.vatRate,
        vaultId: input.vaultId,
        payToAddress,
        sourceAccountFingerprint: prior.sourceAccountFingerprint,
        issuerLegalName: prior.issuerLegalName,
        issuerTaxId: prior.issuerTaxId,
        issuerFingerprint: prior.issuerFingerprint,
        valuationRateTry: prior.valuationRateTry,
        valuationSource: prior.valuationSource,
      });
      if (prior.requestFingerprint !== requestFingerprint)
        throw new ApiConflictError("The same expense requestId cannot be reused with a different payload.", true, {
          id: prior.id,
          number: prior.number,
        });
      return noStoreJson({ ok: true, expense: prior, idempotent: true });
    }
    if (process.env.ZALLET_RPC_URL) await verifyConfiguredWalletScope();
    else if (process.env.ZCASH_RPC_URL)
      throw new Error(
        "Live documents require Zallet z_getaccount to prove address-to-account ownership; a legacy wallet is insufficient.",
      );

    const { result: outcome } = await mutateState((state) => {
      const selectedVault = state.vaults.find((vault) => vault.id === input.vaultId && vault.status === "active");
      if (!selectedVault) throw new Error("Active purpose vault not found.");
      if (state.mode === "live" && selectedVault.metadataSource !== "env")
        throw new Error("Purpose-vault metadata has not been configured in live mode.");
      if (state.mode === "live" && selectedVault.addressSource !== "env") {
        throw new Error("This purpose vault's source address has not been configured in live mode.");
      }
      const sourceAccountFingerprint = accountFingerprintForVault(input.vaultId);
      if (state.mode === "live" && !sourceAccountFingerprint)
        throw new Error("A Zallet account mapping for the purpose vault is required for live expenses.");
      const year = input.date.slice(0, 4);
      const next =
        Math.max(
          0,
          ...state.expenses
            .filter((item) => item.number.startsWith(`EXP-${year}-`))
            .map((item) => Number(item.number.split("-").at(-1)) || 0),
        ) + 1;
      const number = `EXP-${year}-${String(next).padStart(4, "0")}`;
      const issuerLegalName = state.company.legalName;
      const issuerTaxId = state.company.taxId;
      const issuerFingerprint = state.entityFingerprint;
      const tryTotal = tryFromZatoshi(zatoshi, state.settings.demoRateTry);
      const requestFingerprint = recordCommitment({
        kind: "expense-request",
        requestId: input.requestId,
        vendor: input.vendor,
        category: input.category,
        description: input.description,
        date: input.date,
        zatoshi: zatoshi.toString(),
        vatRate: input.vatRate,
        vaultId: input.vaultId,
        payToAddress,
        sourceAccountFingerprint,
        issuerLegalName,
        issuerTaxId,
        issuerFingerprint,
        valuationRateTry: state.settings.demoRateTry,
        valuationSource: "configured-static",
      });
      const prior = state.expenses.find((item) => item.requestId === input.requestId);
      if (prior) {
        if (prior.requestFingerprint !== requestFingerprint)
          throw new ApiConflictError("The same expense requestId cannot be reused with a different payload.", true, {
            id: prior.id,
            number: prior.number,
          });
        return { expense: prior, idempotent: true };
      }
      const expense: Expense = {
        id: randomUUID(),
        requestId: input.requestId,
        requestFingerprint,
        number,
        vendor: input.vendor,
        category: input.category,
        description: input.description,
        issuerLegalName,
        issuerTaxId,
        issuerFingerprint,
        date: input.date,
        zatoshi: zatoshi.toString(),
        tryTotal,
        valuationRateTry: state.settings.demoRateTry,
        valuationSource: "configured-static",
        vatRate: input.vatRate,
        vaultId: input.vaultId,
        sourceAccountFingerprint,
        payToAddress,
        status: "approved",
        documentHash: recordCommitment(
          expenseCommitmentPayload({
            requestId: input.requestId,
            number,
            vendor: input.vendor,
            category: input.category,
            description: input.description,
            issuerLegalName,
            issuerTaxId,
            issuerFingerprint,
            date: input.date,
            zatoshi: zatoshi.toString(),
            tryTotal,
            valuationRateTry: state.settings.demoRateTry,
            valuationSource: "configured-static",
            vatRate: input.vatRate,
            vaultId: input.vaultId,
            payToAddress,
            sourceAccountFingerprint,
          }),
        ),
      };
      state.expenses.unshift(expense);
      const net = netOfVatInclusiveKurus(tryTotal, input.vatRate);
      appendJournal(state, {
        date: input.date,
        description: `${number} · ${input.vendor}`,
        sourceType: "expense",
        sourceId: expense.id,
        vaultId: input.vaultId,
        recordCommitment: expense.documentHash,
        valuationRateTry: expense.valuationRateTry,
        valuationSource: expense.valuationSource,
        lines: [
          { accountCode: expenseAccountCode(input.category), accountName: input.category, debitTry: net, creditTry: 0 },
          ...(tryTotal - net > 0
            ? [{ accountCode: "191", accountName: "Deductible VAT", debitTry: tryTotal - net, creditTry: 0 }]
            : []),
          { accountCode: "320", accountName: "Trade Payables", debitTry: 0, creditTry: tryTotal },
        ],
      });
      state.activities.unshift({
        id: randomUUID(),
        kind: "expense",
        title: "Expense added to the single-admin payment queue",
        detail: `${number} · ${input.vendor}`,
        timestamp: new Date().toISOString(),
        tone: "neutral",
      });
      return { expense, idempotent: false };
    });
    return noStoreJson({ ok: true, ...outcome }, { status: outcome.idempotent ? 200 : 201 });
  } catch (error) {
    return apiError(error);
  }
}
