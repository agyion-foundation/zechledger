import { randomUUID } from "node:crypto";
import { apiError, noStoreJson } from "@/lib/http";
import { parseZec } from "@/lib/money";
import { getState, mutateState } from "@/lib/store";
import { sendSchema } from "@/lib/validation";
import { assertFreshWalletSyncScope, sendShieldedPayment, ZcashRpcError } from "@/lib/zcash-rpc";
import { accountFingerprintForVault } from "@/lib/vault-config";
import { paymentRetryBlocked } from "@/lib/outbox";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let intentId: string | null = null;
  try {
    const input = sendSchema.parse(await request.json());
    const snapshot = await getState();
    const expense = snapshot.expenses.find((item) => item.id === input.expenseId);
    if (!expense) throw new Error("Expense not found.");
    if (expense.status !== "approved")
      throw new Error("Only unpaid expenses in the single-admin payment queue can be broadcast.");
    const currentAccountFingerprint = accountFingerprintForVault(expense.vaultId);
    if (!expense.sourceAccountFingerprint || expense.sourceAccountFingerprint !== currentAccountFingerprint) {
      throw new Error(
        "The expense's committed source account fingerprint does not match the current vault mapping; wallet scope rotation requires a new ZECHLEDGER_DATA_DIR.",
      );
    }
    const expectedMemo = `ZECHLEDGER|${expense.number}|${expense.documentHash.slice(0, 12)}`;
    const submittedZatoshi = parseZec(input.amountZec).toString();
    if (
      submittedZatoshi !== expense.zatoshi ||
      input.memo !== expectedMemo ||
      input.toAddress !== expense.payToAddress
    ) {
      throw new Error("The payment address, amount, or memo does not match the queued expense record.");
    }
    if (process.env.ZCASH_ALLOW_SEND !== "true") {
      throw new ZcashRpcError("Sending is disabled. Set ZCASH_ALLOW_SEND=true to broadcast to the real testnet.");
    }
    assertFreshWalletSyncScope(snapshot.settings.lastSyncScope, snapshot.settings.lastSyncAt);

    intentId = randomUUID();
    await mutateState((state) => {
      const current = state.expenses.find((item) => item.id === input.expenseId);
      if (!current || current.status !== "approved") throw new Error("The expense is no longer eligible for payment.");
      const retryBlocked = paymentRetryBlocked(state.transactions, current.id);
      if (retryBlocked)
        throw new Error(
          "This expense's previous outcome cannot be safely abandoned; a retry is allowed only after an exact wallet expired-unmined result or a synchronous RPC rejection.",
        );
      state.transactions.unshift({
        id: intentId!,
        txid: `intent:${intentId}`,
        direction: "outgoing",
        zatoshi: current.zatoshi,
        memo: expectedMemo,
        toAddress: current.payToAddress,
        counterparty: current.vendor,
        vaultId: current.vaultId,
        accountFingerprint: current.sourceAccountFingerprint,
        expenseId: current.id,
        confirmations: 0,
        timestamp: new Date().toISOString(),
        status: "pending",
        pool: "Shielded",
        source: "rpc",
      });
      state.activities.unshift({
        id: randomUUID(),
        kind: "payment",
        title: "Payment intent recorded safely",
        detail: `${current.number} · awaiting broadcast`,
        timestamp: new Date().toISOString(),
        tone: "warning",
      });
    });

    let fromAddress: string | undefined;
    if (process.env.ZCASH_VAULT_ADDRESS_MAP) {
      const addressMap = JSON.parse(process.env.ZCASH_VAULT_ADDRESS_MAP) as Record<string, string>;
      fromAddress = addressMap[expense.vaultId];
    }
    const { operationId } = await sendShieldedPayment({
      toAddress: expense.payToAddress,
      zatoshi: expense.zatoshi,
      memo: expectedMemo,
      fromAddress,
    });
    await mutateState((state) => {
      const tx = state.transactions.find((item) => item.id === intentId);
      if (tx) tx.txid = `opid:${operationId}`;
      state.activities.unshift({
        id: randomUUID(),
        kind: "payment",
        title: "Shielded payment submitted to Zallet",
        detail: `Operation ${operationId.slice(0, 18)}…`,
        timestamp: new Date().toISOString(),
        tone: "warning",
      });
    });
    return noStoreJson({ ok: true, operationId, trackingId: intentId }, { status: 202 });
  } catch (error) {
    if (intentId) {
      const definitelyFailed =
        error instanceof ZcashRpcError &&
        (error.method !== "z_sendmany" || (error.code !== undefined && error.code < 0));
      await mutateState((state) => {
        const tx = state.transactions.find((item) => item.id === intentId);
        if (tx && definitelyFailed) {
          tx.status = "failed";
          tx.failureReason = "definite-rpc-reject";
        } else if (tx) {
          tx.operationOutcome = "unknown";
        }
        state.activities.unshift({
          id: randomUUID(),
          kind: "payment",
          title: definitelyFailed ? "Payment broadcast rejected" : "RPC outcome uncertain · do not resend",
          detail: (error as Error).message,
          timestamp: new Date().toISOString(),
          tone: "warning",
        });
      }).catch(() => undefined);
    }
    return apiError(error);
  }
}
