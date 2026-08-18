import { randomUUID } from "node:crypto";
import { appendJournal, sha256 } from "@/lib/accounting";
import { ApiConflictError, apiError, noStoreJson } from "@/lib/http";
import { netOfVatInclusiveKurus, parseZec, tryFromZatoshi } from "@/lib/money";
import { getState, mutateState } from "@/lib/store";
import { invoiceSchema } from "@/lib/validation";
import type { Invoice } from "@/lib/types";
import { invoiceCommitmentPayload, recordCommitment } from "@/lib/commitments";
import { accountFingerprintForVault } from "@/lib/vault-config";
import { verifyConfiguredWalletScope } from "@/lib/zcash-rpc";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = invoiceSchema.parse(await request.json());
    const zatoshi = parseZec(input.amountZec);
    if (zatoshi <= 0n || zatoshi > 100_000_000_000_000n) throw new Error("Invalid invoice amount.");
    const snapshot = await getState();
    const prior = snapshot.invoices.find((item) => item.requestId === input.requestId);
    if (prior) {
      const requestFingerprint = recordCommitment({
        kind: "invoice-request",
        requestId: input.requestId,
        client: input.client,
        title: input.title,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        zatoshi: zatoshi.toString(),
        vatRate: input.vatRate,
        vaultId: input.vaultId,
        receiveAddress: prior.receiveAddress,
        receiveAccountFingerprint: prior.receiveAccountFingerprint,
        issuerLegalName: prior.issuerLegalName,
        issuerTaxId: prior.issuerTaxId,
        issuerFingerprint: prior.issuerFingerprint,
        valuationRateTry: prior.valuationRateTry,
        valuationSource: prior.valuationSource,
      });
      if (prior.requestFingerprint !== requestFingerprint)
        throw new ApiConflictError("The same invoice requestId cannot be reused with a different payload.", true, {
          id: prior.id,
          number: prior.number,
        });
      return noStoreJson({ ok: true, invoice: prior, idempotent: true });
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
        throw new Error("A real testnet address has not been configured for this purpose vault in live mode.");
      }
      const year = input.issueDate.slice(0, 4);
      const next =
        Math.max(
          0,
          ...state.invoices
            .filter((item) => item.number.startsWith(`ZL-${year}-`))
            .map((item) => Number(item.number.split("-").at(-1)) || 0),
        ) + 1;
      const number = `ZL-${year}-${String(next).padStart(4, "0")}`;
      const tryTotal = tryFromZatoshi(zatoshi, state.settings.demoRateTry);
      const initials = input.client
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toLocaleUpperCase("en-US"))
        .join("");
      const receiveAccountFingerprint = accountFingerprintForVault(input.vaultId);
      if (state.mode === "live" && !receiveAccountFingerprint)
        throw new Error("A Zallet account mapping for the purpose vault is required for live invoices.");
      const receiveAddress = selectedVault.address;
      const issuerLegalName = state.company.legalName;
      const issuerTaxId = state.company.taxId;
      const issuerFingerprint = state.entityFingerprint;
      const requestFingerprint = recordCommitment({
        kind: "invoice-request",
        requestId: input.requestId,
        client: input.client,
        title: input.title,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        zatoshi: zatoshi.toString(),
        vatRate: input.vatRate,
        vaultId: input.vaultId,
        receiveAddress,
        receiveAccountFingerprint,
        issuerLegalName,
        issuerTaxId,
        issuerFingerprint,
        valuationRateTry: state.settings.demoRateTry,
        valuationSource: "configured-static",
      });
      const prior = state.invoices.find((item) => item.requestId === input.requestId);
      if (prior) {
        if (prior.requestFingerprint !== requestFingerprint)
          throw new ApiConflictError("The same invoice requestId cannot be reused with a different payload.", true, {
            id: prior.id,
            number: prior.number,
          });
        return { invoice: prior, idempotent: true };
      }
      const documentHash = recordCommitment(
        invoiceCommitmentPayload({
          requestId: input.requestId,
          number,
          client: input.client,
          title: input.title,
          issuerLegalName,
          issuerTaxId,
          issuerFingerprint,
          issueDate: input.issueDate,
          dueDate: input.dueDate,
          zatoshi: zatoshi.toString(),
          tryTotal,
          valuationRateTry: state.settings.demoRateTry,
          valuationSource: "configured-static",
          vatRate: input.vatRate,
          vaultId: input.vaultId,
          receiveAddress,
          receiveAccountFingerprint,
        }),
      );
      const memoRef = `ZECHLEDGER|${number}|${documentHash.slice(0, 12)}`;
      const invoice: Invoice = {
        id: randomUUID(),
        requestId: input.requestId,
        requestFingerprint,
        number,
        client: input.client,
        clientAlias: `Client ${sha256(input.client).slice(0, 4).toUpperCase()}`,
        clientInitials: initials,
        title: input.title,
        issuerLegalName,
        issuerTaxId,
        issuerFingerprint,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        zatoshi: zatoshi.toString(),
        tryTotal,
        valuationRateTry: state.settings.demoRateTry,
        valuationSource: "configured-static",
        vatRate: input.vatRate,
        status: "pending",
        vaultId: input.vaultId,
        receiveAddress,
        receiveAccountFingerprint,
        memoRef,
        documentHash,
        createdAt: new Date().toISOString(),
      };
      state.invoices.unshift(invoice);
      const net = netOfVatInclusiveKurus(tryTotal, input.vatRate);
      appendJournal(state, {
        date: input.issueDate,
        description: `${number} · ${input.client}`,
        sourceType: "invoice",
        sourceId: invoice.id,
        vaultId: input.vaultId,
        recordCommitment: invoice.documentHash,
        valuationRateTry: invoice.valuationRateTry,
        valuationSource: invoice.valuationSource,
        lines: [
          { accountCode: "120", accountName: "Trade Receivables", debitTry: tryTotal, creditTry: 0 },
          { accountCode: "600", accountName: "Service Revenue", debitTry: 0, creditTry: net },
          ...(tryTotal - net > 0
            ? [{ accountCode: "391", accountName: "Output VAT", debitTry: 0, creditTry: tryTotal - net }]
            : []),
        ],
      });
      state.activities.unshift({
        id: randomUUID(),
        kind: "invoice",
        title: "Invoice created",
        detail: `${number} · ${invoice.clientAlias}`,
        timestamp: new Date().toISOString(),
        tone: "neutral",
      });
      return { invoice, idempotent: false };
    });
    return noStoreJson({ ok: true, ...outcome }, { status: outcome.idempotent ? 200 : 201 });
  } catch (error) {
    return apiError(error);
  }
}
