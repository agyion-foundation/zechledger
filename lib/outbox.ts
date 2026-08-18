import type { ChainTransaction } from "@/lib/types";

export function paymentRetryBlocked(transactions: ChainTransaction[], expenseId: string): boolean {
  return transactions.some(
    (transaction) =>
      transaction.expenseId === expenseId &&
      transaction.source === "rpc" &&
      !(
        transaction.status === "failed" &&
        ["expired-unmined", "definite-rpc-reject"].includes(transaction.failureReason ?? "")
      ),
  );
}
