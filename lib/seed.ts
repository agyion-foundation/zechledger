import { randomUUID } from "node:crypto";
import { addDays, addMonths, formatISO, startOfMonth, subMonths } from "date-fns";
import { appendJournal, canonicalJson, GENESIS_HASH, sha256 } from "@/lib/accounting";
import { netOfVatInclusiveKurus, tryFromZatoshi } from "@/lib/money";
import { expenseAccountCode } from "@/lib/accounting-policy";
import type { AppState, Expense, Invoice, Vault } from "@/lib/types";
import {
  expenseCommitmentPayload,
  invoiceCommitmentPayload,
  recordCommitment,
  transactionObservationCommitment,
} from "@/lib/commitments";

const isoDate = (date: Date) => formatISO(date, { representation: "date" });
const atNoon = (date: Date) => `${isoDate(date)}T12:00:00.000Z`;
const txid = (label: string) => sha256(`zechledger-demo-fixture:${label}`);

export const DEMO_TESTNET_ADDRESSES = {
  export: "ztestsapling1knww2nyjc62njkard0jmx7hlsj6twxmxwprn7anvrv4dc2zxanl3nemc0qx2hvplxmd2uau8gyw",
  operations: "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez",
  rnd: "ztestsapling1n65uaftvs2g7075q2x2a04shfk066u3lldzxsrprfrqtzxnhc9ps73v4lhx4l9yfxj46sl0q90k",
} as const;

export function createSeedState(): AppState {
  const issuerLegalName = "ZechLedger Technology and Consulting Inc.";
  const issuerTaxId = "TESTNET-3400492048";
  const issuerFingerprint = sha256(canonicalJson({ legalName: issuerLegalName, taxId: issuerTaxId }));
  const now = new Date();
  const currentMonth = startOfMonth(now);
  const rate = Number(process.env.ZECHLEDGER_DEMO_RATE_TRY ?? 2950);
  const receiver = DEMO_TESTNET_ADDRESSES.export;

  const vaults: Vault[] = [
    {
      id: "vault-export",
      name: "Export Vault",
      purpose: "Customer collections",
      period: `${now.getUTCFullYear()} / Q3`,
      color: "#9adf70",
      budgetTry: 3_200_000_00,
      metadataSource: "demo",
      address: receiver,
      addressSource: "demo",
      pool: "Sapling",
      status: "active",
      viewingKeyFingerprint: sha256("demo-ufvk-export").slice(0, 16).toUpperCase(),
      viewingKeySource: "demo",
    },
    {
      id: "vault-operations",
      name: "Operations Vault",
      purpose: "Supplier and operating expenses",
      period: `${now.getUTCFullYear()} / Q3`,
      color: "#ffb86b",
      budgetTry: 1_150_000_00,
      metadataSource: "demo",
      address: DEMO_TESTNET_ADDRESSES.operations,
      addressSource: "demo",
      pool: "Sapling",
      status: "active",
      viewingKeyFingerprint: sha256("demo-ufvk-operations").slice(0, 16).toUpperCase(),
      viewingKeySource: "demo",
    },
    {
      id: "vault-rnd",
      name: "R&D Fund",
      purpose: "Restricted project budget",
      period: `${now.getUTCFullYear()} / Q3`,
      color: "#6f8dff",
      budgetTry: 880_000_00,
      metadataSource: "demo",
      address: DEMO_TESTNET_ADDRESSES.rnd,
      addressSource: "demo",
      pool: "Sapling",
      status: "active",
      viewingKeyFingerprint: sha256("demo-ufvk-rnd").slice(0, 16).toUpperCase(),
      viewingKeySource: "demo",
    },
  ];

  for (const vault of vaults) {
    vault.metadataFingerprint = sha256(
      canonicalJson({
        name: vault.name,
        purpose: vault.purpose,
        period: vault.period,
        budgetTryKurus: vault.budgetTry,
      }),
    );
  }

  const invoiceSeed: Array<{
    no: number;
    client: string;
    alias: string;
    initials: string;
    title: string;
    monthOffset: number;
    days: number;
    zec: string;
    status: Invoice["status"];
    vault: string;
    vat: number;
  }> = [
    {
      no: 42,
      client: "Asteria Software GmbH",
      alias: "European Client A",
      initials: "AS",
      title: "Privacy infrastructure consulting",
      monthOffset: -5,
      days: 4,
      zec: "3.85000000",
      status: "paid",
      vault: "vault-export",
      vat: 20,
    },
    {
      no: 43,
      client: "Lumen Health Technologies",
      alias: "Healthcare Client B",
      initials: "LH",
      title: "Data security development package",
      monthOffset: -4,
      days: 9,
      zec: "2.40000000",
      status: "paid",
      vault: "vault-export",
      vat: 20,
    },
    {
      no: 44,
      client: "Nordwind Research AS",
      alias: "Research Client C",
      initials: "NR",
      title: "Q2 prototype delivery",
      monthOffset: -3,
      days: 12,
      zec: "4.12500000",
      status: "paid",
      vault: "vault-rnd",
      vat: 0,
    },
    {
      no: 45,
      client: "Koru Digital Products Inc.",
      alias: "Domestic Client D",
      initials: "KD",
      title: "Monthly product engineering",
      monthOffset: -2,
      days: 7,
      zec: "1.76000000",
      status: "paid",
      vault: "vault-export",
      vat: 20,
    },
    {
      no: 46,
      client: "Nebula Labs Ltd.",
      alias: "Technology Client E",
      initials: "NL",
      title: "Shielded payment integration",
      monthOffset: -1,
      days: 11,
      zec: "2.89000000",
      status: "paid",
      vault: "vault-export",
      vat: 20,
    },
    {
      no: 47,
      client: "Pera Design Collective",
      alias: "Design Client F",
      initials: "PD",
      title: "Product design and audit dashboards",
      monthOffset: -1,
      days: 19,
      zec: "1.32000000",
      status: "overdue",
      vault: "vault-export",
      vat: 20,
    },
    {
      no: 48,
      client: "Atlas Open Technology",
      alias: "Open Source Client G",
      initials: "AO",
      title: "August development sprint",
      monthOffset: 0,
      days: 4,
      zec: "2.25000000",
      status: "pending",
      vault: "vault-export",
      vat: 20,
    },
    {
      no: 49,
      client: "Blue Capsule Foundation",
      alias: "Restricted Fund H",
      initials: "BC",
      title: "Privacy-preserving donation reporting module",
      monthOffset: 0,
      days: 13,
      zec: "0.84000000",
      status: "draft",
      vault: "vault-rnd",
      vat: 0,
    },
  ];

  const invoices: Invoice[] = invoiceSeed.map((item) => {
    const issueDate = addDays(addMonths(currentMonth, item.monthOffset), item.days);
    const zatoshi = String(BigInt(item.zec.replace(".", "")));
    const number = `ZL-${now.getUTCFullYear()}-${String(item.no).padStart(4, "0")}`;
    const receiveAddress = vaults.find((vault) => vault.id === item.vault)!.address;
    const requestId = randomUUID();
    const requestFingerprint = recordCommitment({ kind: "invoice", requestId, number });
    const tryTotal = tryFromZatoshi(zatoshi, rate);
    const receiveAccountFingerprint = `demo:${item.vault}`;
    const recordHash = recordCommitment(
      invoiceCommitmentPayload({
        requestId,
        number,
        client: item.client,
        title: item.title,
        issuerLegalName,
        issuerTaxId,
        issuerFingerprint,
        issueDate: isoDate(issueDate),
        dueDate: isoDate(addDays(issueDate, 21)),
        zatoshi,
        tryTotal,
        valuationRateTry: rate,
        valuationSource: "configured-static",
        vatRate: item.vat,
        vaultId: item.vault,
        receiveAddress,
        receiveAccountFingerprint,
      }),
    );
    return {
      id: randomUUID(),
      requestId,
      requestFingerprint,
      number,
      client: item.client,
      clientAlias: item.alias,
      clientInitials: item.initials,
      title: item.title,
      issuerLegalName,
      issuerTaxId,
      issuerFingerprint,
      issueDate: isoDate(issueDate),
      dueDate: isoDate(addDays(issueDate, 21)),
      zatoshi,
      tryTotal,
      valuationRateTry: rate,
      valuationSource: "configured-static",
      vatRate: item.vat,
      status: item.status,
      vaultId: item.vault,
      receiveAddress,
      receiveAccountFingerprint,
      memoRef: `ZECHLEDGER|${number}|${recordHash.slice(0, 12)}`,
      documentHash: recordHash,
      paymentTxid: item.status === "paid" ? txid(`payment-${number}`) : undefined,
      paidAt: item.status === "paid" ? atNoon(addDays(issueDate, 3)) : undefined,
      createdAt: atNoon(issueDate),
    };
  });

  const expenseSeed: Array<{
    vendor: string;
    category: string;
    description: string;
    monthOffset: number;
    days: number;
    zec: string;
    vault: string;
    vat: number;
  }> = [
    {
      vendor: "Orbit Cloud",
      category: "Cloud & Infrastructure",
      description: "Private transaction monitoring infrastructure",
      monthOffset: -4,
      days: 18,
      zec: "0.62000000",
      vault: "vault-operations",
      vat: 20,
    },
    {
      vendor: "Independent Security Lab",
      category: "Professional Services",
      description: "External security audit",
      monthOffset: -3,
      days: 22,
      zec: "0.93000000",
      vault: "vault-rnd",
      vat: 0,
    },
    {
      vendor: "North Office",
      category: "Office",
      description: "Team workspace",
      monthOffset: -2,
      days: 15,
      zec: "0.41000000",
      vault: "vault-operations",
      vat: 20,
    },
    {
      vendor: "Node Harbor",
      category: "Cloud & Infrastructure",
      description: "Testnet node hosting",
      monthOffset: -1,
      days: 26,
      zec: "0.38000000",
      vault: "vault-operations",
      vat: 20,
    },
    {
      vendor: "Pixel Studio",
      category: "Design",
      description: "Presentation and branding work",
      monthOffset: 0,
      days: 8,
      zec: "0.27000000",
      vault: "vault-operations",
      vat: 20,
    },
  ];

  const expenses: Expense[] = expenseSeed.map((item, index) => {
    const date = addDays(addMonths(currentMonth, item.monthOffset), item.days);
    const zatoshi = String(BigInt(item.zec.replace(".", "")));
    const number = `EXP-${now.getUTCFullYear()}-${String(index + 118).padStart(4, "0")}`;
    const payToAddress = DEMO_TESTNET_ADDRESSES.rnd;
    const requestId = randomUUID();
    const requestFingerprint = recordCommitment({ kind: "expense", requestId, number });
    const tryTotal = tryFromZatoshi(zatoshi, rate);
    const sourceAccountFingerprint = `demo:${item.vault}`;
    const recordHash = recordCommitment(
      expenseCommitmentPayload({
        requestId,
        number,
        vendor: item.vendor,
        category: item.category,
        description: item.description,
        issuerLegalName,
        issuerTaxId,
        issuerFingerprint,
        date: isoDate(date),
        zatoshi,
        tryTotal,
        valuationRateTry: rate,
        valuationSource: "configured-static",
        vatRate: item.vat,
        vaultId: item.vault,
        payToAddress,
        sourceAccountFingerprint,
      }),
    );
    return {
      id: randomUUID(),
      requestId,
      requestFingerprint,
      number,
      vendor: item.vendor,
      category: item.category,
      description: item.description,
      issuerLegalName,
      issuerTaxId,
      issuerFingerprint,
      date: isoDate(date),
      zatoshi,
      tryTotal,
      valuationRateTry: rate,
      valuationSource: "configured-static",
      vatRate: item.vat,
      vaultId: item.vault,
      sourceAccountFingerprint,
      payToAddress,
      status: "paid",
      txid: txid(`expense-${number}`),
      documentHash: recordHash,
    };
  });

  const state: AppState = {
    schemaVersion: 2,
    revision: 1,
    mode: "demo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ledgerHead: GENESIS_HASH,
    entityFingerprint: issuerFingerprint,
    company: {
      name: "ZechLedger Labs",
      legalName: issuerLegalName,
      taxId: issuerTaxId,
      fiscalPeriod: String(now.getUTCFullYear()),
      logoMark: "ZL",
      source: "demo",
    },
    settings: {
      displayCurrency: "TRY",
      operatorName: "Aisha",
      demoRateTry: rate,
      minConfirmations: Number(process.env.ZCASH_MIN_CONFIRMATIONS ?? 1),
      accountingDatePolicy: "Europe/Istanbul/v1",
      receiverAddress: receiver,
      explorerTxUrl: process.env.ZCASH_EXPLORER_TX_URL ?? "https://zexplorer.app/testnet/tx/",
    },
    vaults,
    invoices,
    expenses,
    transactions: [],
    journals: [],
    auditCapsules: [],
    activities: [],
  };

  for (const invoice of invoices.filter((item) => item.status !== "draft")) {
    const net = netOfVatInclusiveKurus(invoice.tryTotal, invoice.vatRate);
    appendJournal(state, {
      date: invoice.issueDate,
      description: `${invoice.number} · ${invoice.client}`,
      sourceType: "invoice",
      sourceId: invoice.id,
      vaultId: invoice.vaultId,
      recordCommitment: invoice.documentHash,
      valuationRateTry: invoice.valuationRateTry,
      valuationSource: invoice.valuationSource,
      status: "posted",
      lines: [
        { accountCode: "120", accountName: "Trade Receivables", debitTry: invoice.tryTotal, creditTry: 0 },
        { accountCode: "600", accountName: "Domestic / International Sales", debitTry: 0, creditTry: net },
        ...(invoice.tryTotal - net > 0
          ? [{ accountCode: "391", accountName: "Output VAT", debitTry: 0, creditTry: invoice.tryTotal - net }]
          : []),
      ],
    });

    if (invoice.status === "paid" && invoice.paymentTxid) {
      appendJournal(state, {
        date: invoice.paidAt!.slice(0, 10),
        description: `Shielded receipt · ${invoice.number}`,
        sourceType: "payment",
        sourceId: invoice.id,
        recordCommitment: invoice.documentHash,
        vaultId: invoice.vaultId,
        chainTxid: invoice.paymentTxid,
        valuationRateTry: invoice.valuationRateTry,
        valuationSource: invoice.valuationSource,
        lines: [
          {
            accountCode: "102.10",
            accountName: "ZEC Testnet Asset",
            debitTry: invoice.tryTotal,
            creditTry: 0,
            zatoshi: invoice.zatoshi,
          },
          { accountCode: "120", accountName: "Trade Receivables", debitTry: 0, creditTry: invoice.tryTotal },
        ],
      });
      state.transactions.push({
        id: randomUUID(),
        txid: invoice.paymentTxid,
        direction: "incoming",
        zatoshi: invoice.zatoshi,
        memo: invoice.memoRef,
        counterparty: invoice.clientAlias,
        vaultId: invoice.vaultId,
        invoiceId: invoice.id,
        confirmations: 8 + state.transactions.length * 3,
        blockHeight: 3_120_540 - state.transactions.length * 145,
        timestamp: invoice.paidAt!,
        status: "confirmed",
        pool: "Orchard",
        source: "demo-fixture",
      });
    }
  }

  for (const expense of expenses) {
    const net = netOfVatInclusiveKurus(expense.tryTotal, expense.vatRate);
    appendJournal(state, {
      date: expense.date,
      description: `${expense.number} · ${expense.vendor}`,
      sourceType: "expense",
      sourceId: expense.id,
      vaultId: expense.vaultId,
      recordCommitment: expense.documentHash,
      valuationRateTry: expense.valuationRateTry,
      valuationSource: expense.valuationSource,
      lines: [
        {
          accountCode: expenseAccountCode(expense.category),
          accountName: expense.category,
          debitTry: net,
          creditTry: 0,
        },
        ...(expense.tryTotal - net > 0
          ? [{ accountCode: "191", accountName: "Recoverable VAT", debitTry: expense.tryTotal - net, creditTry: 0 }]
          : []),
        { accountCode: "320", accountName: "Trade Payables", debitTry: 0, creditTry: expense.tryTotal },
      ],
    });
    appendJournal(state, {
      date: expense.date,
      description: `Shielded expense payment · ${expense.number}`,
      sourceType: "payment",
      sourceId: expense.id,
      recordCommitment: expense.documentHash,
      vaultId: expense.vaultId,
      chainTxid: expense.txid,
      valuationRateTry: expense.valuationRateTry,
      valuationSource: expense.valuationSource,
      lines: [
        { accountCode: "320", accountName: "Trade Payables", debitTry: expense.tryTotal, creditTry: 0 },
        {
          accountCode: "102.10",
          accountName: "ZEC Testnet Asset",
          debitTry: 0,
          creditTry: expense.tryTotal,
          zatoshi: expense.zatoshi,
        },
      ],
    });
    const feeZatoshi = "10000";
    const feeTry = tryFromZatoshi(feeZatoshi, expense.valuationRateTry);
    appendJournal(state, {
      date: expense.date,
      description: `ZIP-317 demo-fixture network fee · ${expense.number}`,
      sourceType: "fee",
      sourceId: `${expense.id}:fee`,
      vaultId: expense.vaultId,
      chainTxid: expense.txid,
      valuationRateTry: expense.valuationRateTry,
      valuationSource: expense.valuationSource,
      lines: [
        { accountCode: "780", accountName: "Financing / Network Expenses", debitTry: feeTry, creditTry: 0 },
        {
          accountCode: "102.10",
          accountName: "ZEC Testnet Asset",
          debitTry: 0,
          creditTry: feeTry,
          zatoshi: feeZatoshi,
        },
      ],
    });
    state.transactions.push({
      id: randomUUID(),
      txid: expense.txid!,
      direction: "outgoing",
      zatoshi: expense.zatoshi,
      feeZatoshi,
      memo: `ZECHLEDGER|${expense.number}|${expense.documentHash.slice(0, 12)}`,
      counterparty: expense.vendor,
      vaultId: expense.vaultId,
      expenseId: expense.id,
      confirmations: 5 + state.transactions.length * 2,
      blockHeight: 3_120_100 - state.transactions.length * 87,
      timestamp: `${expense.date}T15:40:00.000Z`,
      status: "confirmed",
      pool: "Orchard",
      source: "demo-fixture",
    });
  }

  const pendingInvoice = invoices.find((item) => item.status === "pending")!;
  state.transactions.push({
    id: randomUUID(),
    txid: txid("pending-broadcast"),
    direction: "incoming",
    zatoshi: pendingInvoice.zatoshi,
    memo: pendingInvoice.memoRef,
    counterparty: pendingInvoice.clientAlias,
    vaultId: pendingInvoice.vaultId,
    invoiceId: pendingInvoice.id,
    confirmations: 0,
    timestamp: new Date().toISOString(),
    status: "pending",
    pool: "Orchard",
    source: "demo-fixture",
  });

  for (const transaction of state.transactions)
    transaction.observationHash = transactionObservationCommitment(transaction);

  state.activities = (
    [
      {
        id: randomUUID(),
        kind: "payment",
        title: "Shielded receipt matched",
        detail: `${invoices[4].number} · ${invoices[4].clientAlias}`,
        timestamp: invoices[4].paidAt!,
        tone: "positive",
      },
      {
        id: randomUUID(),
        kind: "sync",
        title: "Testnet records synced",
        detail: "11 transactions · 100% memo match",
        timestamp: atNoon(subMonths(now, 0)),
        tone: "neutral",
      },
      {
        id: randomUUID(),
        kind: "invoice",
        title: "New invoice draft",
        detail: `${invoices[7].number} · ${invoices[7].clientAlias}`,
        timestamp: invoices[7].createdAt,
        tone: "neutral",
      },
      {
        id: randomUUID(),
        kind: "system",
        title: "Demo mode enabled",
        detail: "Actual testnet data will be used once live RPC is connected",
        timestamp: new Date().toISOString(),
        tone: "warning",
      },
    ] as AppState["activities"]
  ).sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return state;
}

export function createEmptyLiveState(): AppState {
  const state = createSeedState();
  state.mode = "live";
  state.company = {
    name: "Unconfigured",
    legalName: "Unconfigured live legal entity",
    taxId: "UNCONFIGURED",
    fiscalPeriod: String(new Date().getUTCFullYear()),
    logoMark: "ZL",
    source: "placeholder",
  };
  state.settings.operatorName = "Administrator";
  for (const [index, vault] of state.vaults.entries()) {
    vault.name = `Purpose Vault ${index + 1}`;
    vault.purpose = "Live metadata is not configured";
    vault.budgetTry = 0;
    vault.metadataSource = "placeholder";
    delete vault.metadataFingerprint;
  }
  state.invoices = [];
  state.expenses = [];
  state.transactions = [];
  state.journals = [];
  state.auditCapsules = [];
  state.activities = [
    {
      id: randomUUID(),
      kind: "system",
      title: "Clean live testnet ledger created",
      detail: "Demo fixtures were not imported into this ledger",
      timestamp: new Date().toISOString(),
      tone: "positive",
    },
  ];
  state.ledgerHead = GENESIS_HASH;
  state.revision = 1;
  state.createdAt = new Date().toISOString();
  state.updatedAt = state.createdAt;
  return state;
}
