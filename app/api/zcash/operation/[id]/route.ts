import { randomUUID } from "node:crypto";
import { apiError, noStoreJson } from "@/lib/http";
import { mutateState } from "@/lib/store";
import { getOperationStatus } from "@/lib/zcash-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OperationRecord {
  id?: string;
  status?: string;
  result?: { txid?: string; txids?: string[]; broadcast?: boolean };
  error?: { message?: string };
}

async function persistUnknownOperation(id: string, title: string, detail: string): Promise<void> {
  await mutateState((state) => {
    const tx = state.transactions.find(
      (item) => item.status === "pending" && (item.txid === `opid:${id}` || item.txid === `opdone:${id}`),
    );
    const capsule = state.auditCapsules.find((item) => item.operationId === id && item.status === "pending");
    const alreadyRecorded = (!tx || tx.operationOutcome === "unknown") && (!capsule || capsule.operationComplete);
    if (tx) tx.operationOutcome = "unknown";
    if (capsule) {
      capsule.operationComplete = true;
      capsule.operationTxids = [];
    }
    if (alreadyRecorded) return;
    state.activities.unshift({
      id: randomUUID(),
      kind: "payment",
      title,
      detail,
      timestamp: new Date().toISOString(),
      tone: "warning",
    });
  });
}

function unknownOperationResponse(error: string) {
  return noStoreJson({ ok: false, operation: null, status: "unknown", error, retryBlocked: true }, { status: 409 });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^opid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error("Invalid operation ID.");
    const rawRecords: unknown = await getOperationStatus(id);
    if (!Array.isArray(rawRecords)) {
      await persistUnknownOperation(
        id,
        "Malformed Zallet operation response · retries blocked",
        "Non-array RPC response; awaiting reconciliation with canonical wallet output",
      );
      return unknownOperationResponse("The Zallet operation response is not in the expected array format.");
    }
    const records = rawRecords as OperationRecord[];
    const record = records.find((item) => item && typeof item === "object" && item.id === id);
    if (!record) {
      await persistUnknownOperation(
        id,
        "Exact Zallet opid not found · retries blocked",
        "Awaiting reconciliation with canonical wallet output",
      );
      return unknownOperationResponse(
        "The exact opid was not found in Zallet's bounded operation queue; the payment will not be resent. Wallet sync must observe the exact memo, amount, and destination.",
      );
    }
    const malformedRecord =
      typeof record.status !== "string" ||
      (record.result !== undefined &&
        (typeof record.result !== "object" ||
          (record.result.txid !== undefined && typeof record.result.txid !== "string") ||
          (record.result.txids !== undefined &&
            (!Array.isArray(record.result.txids) || record.result.txids.some((txid) => typeof txid !== "string"))) ||
          (record.result.broadcast !== undefined && typeof record.result.broadcast !== "boolean"))) ||
      (record.error !== undefined &&
        (typeof record.error !== "object" ||
          (record.error.message !== undefined && typeof record.error.message !== "string")));
    if (malformedRecord) {
      await persistUnknownOperation(
        id,
        "Malformed Zallet operation record · retries blocked",
        "Runtime shape validation failed; awaiting reconciliation with canonical wallet output",
      );
      return unknownOperationResponse("The exact Zallet operation record does not have the expected runtime shape.");
    }
    const returnedTxids = [
      ...new Set([...(record?.result?.txids ?? []), ...(record?.result?.txid ? [record.result.txid] : [])]),
    ];
    const validTxidSet = returnedTxids.length > 0 && returnedTxids.every((txid) => /^[0-9a-f]{64}$/i.test(txid));
    const txids = validTxidSet ? returnedTxids : [];
    const operationCreated = record.status === "success" && validTxidSet && record.result?.broadcast !== false;
    if (operationCreated) {
      await mutateState((state) => {
        const tx = state.transactions.find((item) => item.status === "pending" && item.txid === `opid:${id}`);
        const capsule = state.auditCapsules.find(
          (item) => item.operationId === id && item.status === "pending" && !item.operationComplete,
        );
        if (!tx && !capsule) return;
        if (tx) {
          tx.operationTxids = txids;
          tx.operationOutcome = "created";
          tx.txid = txids.length === 1 ? txids[0] : `opdone:${id}`;
        }
        if (capsule) {
          capsule.operationTxids = txids;
          capsule.operationComplete = true;
        }
        state.activities.unshift({
          id: randomUUID(),
          kind: "payment",
          title: `${txids.length} testnet txid generated · awaiting exact memo observation`,
          detail: txids.map((txid) => `${txid.slice(0, 10)}…`).join(" · "),
          timestamp: new Date().toISOString(),
          tone: "warning",
        });
      });
    }
    const outcomeUnknown =
      ["failed", "cancelled"].includes(record.status ?? "") ||
      (record.status === "success" && (record.result?.broadcast === false || !validTxidSet));
    const operationErrorDetail =
      record.status === "success" && !validTxidSet
        ? "The Zallet success result did not contain an entirely valid txid set"
        : (record.error?.message ?? record.status ?? "Unknown RPC result");
    if (outcomeUnknown) {
      await mutateState((state) => {
        const tx = state.transactions.find(
          (item) =>
            item.status === "pending" &&
            (item.txid === `opid:${id}` ||
              item.txid === `opdone:${id}` ||
              item.operationTxids?.some((txid) => txids.includes(txid))),
        );
        const capsule = state.auditCapsules.find((item) => item.operationId === id && item.status === "pending");
        if (!tx && !capsule) return;
        const alreadyRecorded = (!tx || tx.operationOutcome === "unknown") && (!capsule || capsule.operationComplete);
        if (tx) {
          tx.operationTxids = txids;
          tx.operationOutcome = "unknown";
        }
        if (capsule) {
          capsule.operationComplete = true;
          capsule.operationTxids = txids;
        }
        if (alreadyRecorded) return;
        state.activities.unshift({
          id: randomUUID(),
          kind: "payment",
          title: "Zallet operation outcome uncertain · retries blocked",
          detail: `${operationErrorDetail} · awaiting reconciliation with exact wallet output`,
          timestamp: new Date().toISOString(),
          tone: "warning",
        });
      });
    }
    return noStoreJson({ ok: true, operation: record, retryBlocked: true, outcomeUnknown });
  } catch (error) {
    return apiError(error);
  }
}
