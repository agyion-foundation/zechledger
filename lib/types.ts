export type InvoiceStatus = "paid" | "pending" | "overdue" | "draft";
export type ChainStatus = "confirmed" | "pending" | "failed" | "replay";
export type VaultStatus = "active" | "rotating" | "closed";
export type AuditStatus = "local" | "pending" | "anchored";

export interface Company {
  name: string;
  legalName: string;
  taxId: string;
  fiscalPeriod: string;
  logoMark: string;
  source: "demo" | "env" | "placeholder";
}

export interface Vault {
  id: string;
  name: string;
  purpose: string;
  period: string;
  color: string;
  budgetTry: number;
  metadataSource: "demo" | "env" | "stale" | "placeholder";
  metadataFingerprint?: string;
  address: string;
  addressSource: "demo" | "env";
  pool: "Orchard" | "Sapling" | "Ironwood" | "Transparent" | "Shielded";
  status: VaultStatus;
  viewingKeyFingerprint?: string;
  viewingKeySource: "demo" | "env" | "unknown";
}

export interface Invoice {
  id: string;
  requestId: string;
  requestFingerprint: string;
  number: string;
  client: string;
  clientAlias: string;
  clientInitials: string;
  title: string;
  issuerLegalName: string;
  issuerTaxId: string;
  issuerFingerprint: string;
  issueDate: string;
  dueDate: string;
  zatoshi: string;
  tryTotal: number;
  valuationRateTry: number;
  valuationSource: "configured-static";
  vatRate: number;
  status: InvoiceStatus;
  vaultId: string;
  receiveAddress: string;
  receiveAccountFingerprint?: string;
  memoRef: string;
  documentHash: string;
  paymentTxid?: string;
  paymentCanonicalId?: string;
  paymentBlockHeight?: number;
  paidAt?: string;
  createdAt: string;
}

export interface Expense {
  id: string;
  requestId: string;
  requestFingerprint: string;
  number: string;
  vendor: string;
  category: string;
  description: string;
  issuerLegalName: string;
  issuerTaxId: string;
  issuerFingerprint: string;
  date: string;
  zatoshi: string;
  tryTotal: number;
  valuationRateTry: number;
  valuationSource: "configured-static";
  vatRate: number;
  vaultId: string;
  sourceAccountFingerprint?: string;
  payToAddress: string;
  status: "paid" | "approved" | "draft";
  txid?: string;
  paymentCanonicalId?: string;
  paymentBlockHeight?: number;
  documentHash: string;
}

export interface ChainTransaction {
  id: string;
  txid: string;
  direction: "incoming" | "outgoing" | "anchor" | "internal";
  zatoshi: string;
  feeZatoshi?: string;
  memo: string;
  toAddress?: string;
  counterparty: string;
  vaultId: string;
  accountFingerprint?: string;
  sourceAccountFingerprint?: string;
  destinationAccountFingerprint?: string;
  sourceVaultId?: string;
  destinationVaultId?: string;
  anchorInternalProvenance?: boolean;
  invoiceId?: string;
  expenseId?: string;
  confirmations: number;
  blockHeight?: number;
  timestamp: string;
  status: ChainStatus;
  pool: "Orchard" | "Sapling" | "Ironwood" | "Transparent" | "Shielded";
  source: "rpc" | "demo-fixture" | "local";
  canonicalId?: string;
  observationHash?: string;
  syncScope?: string;
  lastObservedAt?: string;
  observationState?: "observed" | "orphan-candidate" | "absent";
  accountingValuationRateTry?: number;
  accountingValuationSource?: "configured-static";
  operationTxids?: string[];
  operationOutcome?: "created" | "unknown";
  failureReason?: "expired-unmined" | "orphan-missing" | "definite-rpc-reject";
}

export interface JournalLine {
  accountCode: string;
  accountName: string;
  debitTry: number;
  creditTry: number;
  zatoshi?: string;
}

export interface JournalEntry {
  id: string;
  number: string;
  date: string;
  description: string;
  sourceType: "invoice" | "payment" | "expense" | "fee" | "anchor" | "transfer";
  sourceId: string;
  vaultId: string;
  chainTxid?: string;
  recordCommitment?: string;
  lines: JournalLine[];
  previousHash: string;
  hash: string;
  status: "posted" | "pending";
  valuationRateTry?: number;
  valuationSource?: "configured-static";
  createdAt: string;
}

export interface AuditCapsule {
  id: string;
  requestId: string;
  requestFingerprint?: string;
  name: string;
  vaultId: string;
  period: string;
  scopes: Array<"journals" | "transactions" | "documents" | "viewing-key-fingerprint">;
  manifestHash: string;
  signature: string;
  signatureAlgorithm: "Ed25519";
  signingKeyFingerprint: string;
  ledgerHead: string;
  entryCount: number;
  createdAt: string;
  status: AuditStatus;
  operationId?: string;
  operationComplete?: boolean;
  operationTxids?: string[];
  anchorAddress?: string;
  anchorAccountFingerprint?: string;
  anchorTxid?: string;
  anchoredAt?: string;
  anchorReceipt?: {
    manifestHash: string;
    txid: string;
    blockHeight: number;
    confirmations: number;
    observedAt: string;
    destinationObserved: string | null;
    accountFingerprint: string;
    memo: string;
    zatoshi: string;
    internalProvenance: "same-account-from-to";
    signature: string;
    signatureAlgorithm: "Ed25519";
    signingKeyFingerprint: string;
  };
  manifest?: unknown;
}

export interface Activity {
  id: string;
  kind: "invoice" | "payment" | "expense" | "sync" | "audit" | "system";
  title: string;
  detail: string;
  timestamp: string;
  tone: "positive" | "neutral" | "warning";
}

export interface AppState {
  schemaVersion: 2;
  revision: number;
  mode: "demo" | "live";
  createdAt: string;
  updatedAt: string;
  ledgerHead: string;
  entityFingerprint: string;
  company: Company;
  settings: {
    displayCurrency: "TRY";
    operatorName: string;
    demoRateTry: number;
    minConfirmations: number;
    accountingDatePolicy: "Europe/Istanbul/v1";
    receiverAddress: string;
    explorerTxUrl: string;
    lastSyncScope?: string;
    lastSyncToken?: string;
    lastSyncAt?: string;
    accountScopeFingerprint?: string;
    orphanCandidates?: Record<string, number>;
  };
  vaults: Vault[];
  invoices: Invoice[];
  expenses: Expense[];
  transactions: ChainTransaction[];
  journals: JournalEntry[];
  auditCapsules: AuditCapsule[];
  activities: Activity[];
}

export interface ZcashStatus {
  configured: boolean;
  reachable: boolean;
  safeTestnet: boolean;
  nodeSource: "local-zebra" | "public-readonly" | "legacy" | "unavailable";
  walletConfigured: boolean;
  walletReachable: boolean;
  walletSynchronized: boolean;
  sendEnabled: boolean;
  externalBroadcastConfirmed: boolean;
  fullPrivacyEnabled: boolean;
  sendReady: boolean;
  walletHeight: number | null;
  walletSyncProgress: number | null;
  chain: string | null;
  blocks: number | null;
  headers: number | null;
  verificationProgress: number | null;
  connections: number | null;
  balanceZatoshi: string | null;
  receiverAddress: string | null;
  receiverMasked: string | null;
  latencyMs: number | null;
  nodeVersion: string | null;
  lastCheckedAt: string;
  message: string;
}

export interface StateResponse {
  state: AppState;
  node: ZcashStatus;
  metrics: DashboardMetrics;
}

export interface DashboardMetrics {
  walletBalanceZatoshi: string;
  receivablesTry: number;
  revenueTry: number;
  expensesTry: number;
  netTry: number;
  networkFeesTry: number;
  collectionRate: number;
  confirmedTransactions: number;
  pendingTransactions: number;
  unclassifiedTransactions: number;
  journalBalanced: boolean;
  monthlyFlow: Array<{
    period: string;
    month: string;
    income: number;
    expense: number;
    incomeKurus: number;
    expenseKurus: number;
  }>;
  categorySpend: Array<{ name: string; value: number; color: string }>;
}
