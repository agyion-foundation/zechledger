import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getState, hardResetState, mutateState } from "@/lib/store";
import { createEmptyLiveState } from "@/lib/seed";
import { transactionObservationCommitment } from "@/lib/commitments";

let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "zechledger-store-"));
  process.env.ZECHLEDGER_DATA_DIR = directory;
  delete process.env.ZALLET_RPC_URL;
  delete process.env.ZCASH_RPC_URL;
  delete process.env.ZECHLEDGER_UNSAFE_DEMO_NO_AUTH;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file store serialization", () => {
  it("coalesces concurrent initial reads in an empty directory into a single state", async () => {
    const states = await Promise.all(Array.from({ length: 12 }, () => getState()));
    expect(new Set(states.map((state) => state.ledgerHead)).size).toBe(1);
    expect(new Set(states.map((state) => state.invoices[0]?.id)).size).toBe(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes reset and mutation in call order without losing data", async () => {
    const reset = hardResetState();
    const mutation = mutateState((state) => {
      state.activities.unshift({
        id: "concurrency-proof",
        kind: "system",
        title: "Serialized",
        detail: "Queue proof",
        timestamp: new Date().toISOString(),
        tone: "neutral",
      });
    });
    await Promise.all([reset, mutation]);
    const state = await getState();
    expect(state.activities.some((activity) => activity.id === "concurrency-proof")).toBe(true);
    expect(state.revision).toBe(2);
  });

  it("does not silently relabel a live state with legacy UTC chain dates as using the Istanbul policy", async () => {
    const legacyDirectory = await mkdtemp(path.join(os.tmpdir(), "zechledger-store-legacy-date-"));
    const legacy = createEmptyLiveState();
    delete (legacy.settings as Partial<typeof legacy.settings>).accountingDatePolicy;
    legacy.transactions.push({
      id: "b".repeat(64),
      canonicalId: "b".repeat(64),
      txid: "a".repeat(64),
      direction: "incoming",
      zatoshi: "1",
      memo: "",
      counterparty: "legacy",
      vaultId: "vault-export",
      accountFingerprint: "c".repeat(64),
      confirmations: 1,
      blockHeight: 1,
      timestamp: "2026-01-31T21:00:00.000Z",
      lastObservedAt: "2026-01-31T21:05:00.000Z",
      syncScope: "d".repeat(64),
      observationState: "observed",
      status: "confirmed",
      pool: "Sapling",
      source: "rpc",
    });
    legacy.transactions[0].observationHash = transactionObservationCommitment(legacy.transactions[0]);
    await writeFile(path.join(legacyDirectory, "ledger.json"), JSON.stringify(legacy));
    process.env.ZECHLEDGER_DATA_DIR = legacyDirectory;
    await expect(getState()).rejects.toThrow(/legacy UTC chain-date policy/);
    await rm(legacyDirectory, { recursive: true, force: true });
    process.env.ZECHLEDGER_DATA_DIR = directory;
  });

  it("rejects another live process's lock and safely takes over a stale lock", async () => {
    const activeDirectory = await mkdtemp(path.join(os.tmpdir(), "zechledger-store-active-"));
    const startToken = (await readFile(`/proc/${process.pid}/stat`, "utf8")).split(" ")[21];
    await writeFile(
      path.join(activeDirectory, ".zechledger.lock"),
      JSON.stringify({ pid: process.pid, startToken, nonce: "other" }),
    );
    process.env.ZECHLEDGER_DATA_DIR = activeDirectory;
    await expect(getState()).rejects.toThrow(/another live process/);
    await rm(activeDirectory, { recursive: true, force: true });

    const staleDirectory = await mkdtemp(path.join(os.tmpdir(), "zechledger-store-stale-"));
    await writeFile(
      path.join(staleDirectory, ".zechledger.lock"),
      JSON.stringify({ pid: 999_999_999, startToken: "stale", nonce: "stale" }),
    );
    process.env.ZECHLEDGER_DATA_DIR = staleDirectory;
    expect((await getState()).schemaVersion).toBe(2);
    await rm(staleDirectory, { recursive: true, force: true });
    process.env.ZECHLEDGER_DATA_DIR = directory;
  });
});
