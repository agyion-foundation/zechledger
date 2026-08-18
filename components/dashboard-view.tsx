"use client";

import { ArrowRight } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ViewKey } from "@/components/app-shell";
import { FolioView, useAccountingAsOf } from "@/components/folio";
import type { ViewProps } from "@/components/view-types";
import { HashText, StatusBadge } from "@/components/primitives";
import { formatTry, formatZec, maskAddress, receiverCapabilityLabel } from "@/lib/money";
import type { Activity, ChainTransaction } from "@/lib/types";
import { invoiceStatusAt } from "@/lib/accounting-date";

const transactionDate = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const dueDate = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric" });
const checkedAt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const compactTry = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const activityLabels: Record<Activity["kind"], string> = {
  invoice: "Invoice",
  payment: "Payment / receipt",
  expense: "Expense",
  sync: "Wallet scan",
  audit: "Capsule",
  system: "System",
};

export function DashboardView({ data, setView }: ViewProps & { setView: (view: ViewKey) => void }) {
  const { state, metrics, node } = data;
  const accountingAsOf = useAccountingAsOf();
  const effectiveInvoices = state.invoices.map((invoice) => ({
    ...invoice,
    status: invoiceStatusAt(invoice, accountingAsOf),
  }));
  const recentTransactions = [...state.transactions]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 5);
  const recentActivities = [...state.activities]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 6);
  const openInvoices = effectiveInvoices.filter((invoice) => ["pending", "overdue"].includes(invoice.status));
  const invoicePreview = openInvoices.slice(0, 4);
  const overdueCount = openInvoices.filter((invoice) => invoice.status === "overdue").length;
  const paidInvoiceCount = effectiveInvoices.filter((invoice) => invoice.status === "paid").length;
  const hasScopedSynchronizedWallet =
    node.safeTestnet &&
    node.walletReachable &&
    node.walletSynchronized &&
    node.nodeSource !== "legacy" &&
    node.balanceZatoshi !== null;
  const liveBalance = hasScopedSynchronizedWallet ? node.balanceZatoshi : null;
  const displayedBalance = liveBalance ?? metrics.walletBalanceZatoshi;
  const reconciliationDelta = liveBalance === null ? null : BigInt(liveBalance) - BigInt(metrics.walletBalanceZatoshi);
  const transparentCount = state.transactions.filter((transaction) => transaction.pool === "Transparent").length;
  const shieldedCount = state.transactions.length - transparentCount;
  const unmatchedCount = state.transactions.filter(
    (transaction) =>
      transaction.source === "rpc" &&
      transaction.status === "confirmed" &&
      transaction.observationState !== "orphan-candidate" &&
      Boolean(transaction.observationHash) &&
      /^[0-9a-f]{64}$/i.test(transaction.txid) &&
      ["incoming", "outgoing"].includes(transaction.direction) &&
      !transaction.invoiceId &&
      !transaction.expenseId,
  ).length;
  const orphanCandidateCount = state.transactions.filter(
    (transaction) => transaction.observationState === "orphan-candidate",
  ).length;
  const reconciliationExceptionCount = unmatchedCount + orphanCandidateCount;
  const ambiguousCount = state.transactions.filter(
    (transaction) =>
      transaction.operationOutcome === "unknown" &&
      !(transaction.observationHash && /^[0-9a-f]{64}$/i.test(transaction.txid)),
  ).length;
  const controlItems: Array<{
    id: string;
    label: string;
    detail: string;
    count: number;
    view: ViewKey;
    tone: "neutral" | "warning" | "danger";
  }> = [
    {
      id: "unmatched",
      label: "Reconciliation exception",
      detail: orphanCandidateCount
        ? `${orphanCandidateCount} records missing from the latest exact scan`
        : "Wallet record is not linked to the books",
      count: reconciliationExceptionCount,
      view: "transactions",
      tone: reconciliationExceptionCount ? "warning" : "neutral",
    },
    {
      id: "ambiguous",
      label: "Submission with unknown outcome",
      detail: "Must not be rebroadcast",
      count: ambiguousCount,
      view: "transactions",
      tone: ambiguousCount ? "danger" : "neutral",
    },
    {
      id: "overdue",
      label: "Overdue receivable",
      detail: "Past-due invoice",
      count: overdueCount,
      view: "invoices",
      tone: overdueCount ? "warning" : "neutral",
    },
    {
      id: "transparent",
      label: "Transparent record",
      detail: "Review the privacy scope",
      count: transparentCount,
      view: "transactions",
      tone: transparentCount ? "warning" : "neutral",
    },
    {
      id: "integrity",
      label: "Ledger integrity",
      detail: metrics.journalBalanced ? "Check passed" : "Writes are blocked",
      count: metrics.journalBalanced ? 0 : 1,
      view: "ledger",
      tone: metrics.journalBalanced ? "neutral" : "danger",
    },
  ];
  const vaultNames = new Map(state.vaults.map((vault) => [vault.id, vault.name]));
  const sourceIsDemo = state.mode === "demo";
  const provenance = (() => {
    if (sourceIsDemo) {
      return {
        tone: "demo",
        title: "TESTNET · DEMO DATA",
        detail: node.safeTestnet
          ? `Block height ${node.blocks?.toLocaleString("en-US") ?? "—"} · records are not on-chain evidence`
          : "No wallet observation · records are not on-chain evidence",
      };
    }
    if (!node.safeTestnet) {
      return {
        tone: "warning",
        title: "TESTNET NOT VERIFIED",
        detail: "Live chain and wallet data were excluded from the financial summary",
      };
    }
    if (node.walletReachable && node.nodeSource === "legacy") {
      return {
        tone: "warning",
        title: "TESTNET · LEGACY WALLET RPC",
        detail:
          "The whole-wallet balance is not an allowlisted account scope and is excluded from the financial summary",
      };
    }
    if (node.walletReachable) {
      return {
        tone: node.walletSynchronized ? "live" : "warning",
        title: node.walletSynchronized
          ? "TESTNET · ACCOUNT-SCOPED WALLET RPC SYNCED"
          : "TESTNET · WAITING FOR WALLET SYNC",
        detail: `Block ${node.blocks?.toLocaleString("en-US") ?? "—"} · last checked ${checkedAt.format(new Date(node.lastCheckedAt))}`,
      };
    }
    return {
      tone: "readonly",
      title: "TESTNET · ZEBRA READ-ONLY",
      detail: `Block ${node.blocks?.toLocaleString("en-US") ?? "—"} · no wallet observation`,
    };
  })();

  return (
    <FolioView className="dashboard-view dashboard-folio">
      <header className="dashboard-masthead">
        <div>
          <span className="folio-kicker">{state.company.legalName || state.company.name}</span>
          <p>
            Reference {state.company.fiscalPeriod} · all records · {state.settings.operatorName} · revision{" "}
            {state.revision}
          </p>
        </div>
        <div className="dashboard-actions" role="group" aria-label="Quick actions">
          <button className="button folio-button folio-button--secondary" onClick={() => setView("expenses")}>
            Record expense
          </button>
          <button className="button folio-button folio-button--primary" onClick={() => setView("invoices")}>
            Create invoice
          </button>
        </div>
      </header>

      <section className={`provenance-strip provenance-strip--${provenance.tone}`} aria-label="Data source">
        <strong>{provenance.title}</strong>
        <span>{provenance.detail}</span>
      </section>

      <section className="control-desk" aria-labelledby="control-desk-title">
        <header>
          <div>
            <span className="folio-overline">Work queue</span>
            <h2 id="control-desk-title">Records requiring attention</h2>
          </div>
          <p>{controlItems.reduce((sum, item) => sum + item.count, 0)} open checks</p>
        </header>
        <div className="control-desk__items">
          {controlItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`control-task control-task--${item.tone}`}
              onClick={() => setView(item.view)}
              aria-label={`${item.label}: ${item.count}. Open the related workspace`}
            >
              <span className="control-task__count">{item.count}</span>
              <span>
                <b>{item.label}</b>
                {item.count > 0 && <small>{item.detail}</small>}
              </span>
              <ArrowRight aria-hidden="true" size={16} />
            </button>
          ))}
        </div>
      </section>

      <section className="summary-sheet" aria-labelledby="summary-title">
        <h2 className="sr-only" id="summary-title">
          Financial summary
        </h2>
        <div className="summary-sheet__balance">
          <span>
            {liveBalance !== null
              ? "Zallet allowlisted account total"
              : sourceIsDemo
                ? "Book balance (demo data)"
                : "Local book balance"}
          </span>
          <strong>{formatZec(displayedBalance, 4)} ZEC</strong>
          <small>
            {liveBalance === null
              ? "Source: local records · no claim of a whole-wallet balance"
              : `Source: Zallet RPC · local books net ${formatZec(metrics.walletBalanceZatoshi, 4)} ZEC`}
          </small>
        </div>
        <dl className="summary-sheet__facts">
          <div>
            <dt>Invoiced amount</dt>
            <dd>
              {formatTry(metrics.revenueTry)}
              <small>
                {state.invoices.filter((invoice) => invoice.status !== "draft").length} invoices · drafts excluded
              </small>
            </dd>
          </div>
          <div>
            <dt>Open receivables</dt>
            <dd>
              {formatTry(metrics.receivablesTry)}
              <small>
                {openInvoices.length} invoices · {overdueCount} overdue
              </small>
            </dd>
          </div>
          <div>
            <dt>Linked-document net cash</dt>
            <dd>
              {formatTry(metrics.netTry)}
              <small>Document receipts − expenses − fees · unmatched principal excluded</small>
            </dd>
          </div>
        </dl>
      </section>

      <div className="dashboard-analysis">
        <section className="folio-section cash-flow-register" aria-labelledby="cash-flow-title">
          <div className="folio-section__header">
            <div>
              <h2 id="cash-flow-title">Monthly cash flow</h2>
              <p>102.10 · last {metrics.monthlyFlow.length} rolling months · TRY</p>
            </div>
            <div className="folio-legend" aria-hidden="true">
              <span>
                <i className="folio-legend__income" />
                Receipts
              </span>
              <span>
                <i className="folio-legend__expense" />
                Payments
              </span>
            </div>
          </div>
          {metrics.monthlyFlow.length ? (
            <>
              <div className="folio-chart" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    accessibilityLayer={false}
                    data={metrics.monthlyFlow}
                    margin={{ top: 12, right: 8, left: 4, bottom: 0 }}
                  >
                    <CartesianGrid vertical={false} stroke="#d8d3c7" />
                    <XAxis
                      dataKey="month"
                      axisLine={{ stroke: "#8f918b" }}
                      tickLine={false}
                      tick={{ fill: "#59635e", fontSize: 12 }}
                      dy={8}
                      interval={0}
                    />
                    <YAxis
                      width={62}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "#59635e", fontSize: 11 }}
                      tickFormatter={(value) => `${compactTry.format(Number(value))} ₺`}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(23, 32, 29, 0.04)" }}
                      contentStyle={{
                        background: "#fffdf7",
                        border: "1px solid #9f9b90",
                        borderRadius: 2,
                        boxShadow: "none",
                        fontSize: 12,
                      }}
                      formatter={(value, name) => [
                        `${Number(value ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`,
                        name === "income" ? "Receipts" : "Payments",
                      ]}
                    />
                    <Bar
                      dataKey="income"
                      name="Receipts"
                      fill="#2f6b53"
                      maxBarSize={28}
                      radius={[1, 1, 0, 0]}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="expense"
                      name="Payments"
                      fill="#9b5b39"
                      maxBarSize={28}
                      radius={[1, 1, 0, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="cash-flow-table" tabIndex={0} role="region" aria-label="Monthly cash flow table">
                <table>
                  <caption>Monthly receipt and payment amounts</caption>
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Receipts</th>
                      <th>Payments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.monthlyFlow.map((item) => (
                      <tr key={item.period}>
                        <th>{item.month}</th>
                        <td>{formatTry(item.incomeKurus)}</td>
                        <td>{formatTry(item.expenseKurus)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="folio-empty">No classified cash flow for this period.</p>
          )}
        </section>

        <section className="folio-section control-register" aria-labelledby="control-title">
          <div className="folio-section__header">
            <div>
              <h2 id="control-title">Control status</h2>
              <p>Source, integrity, and privacy scope</p>
            </div>
          </div>
          <dl className="control-list">
            <div>
              <dt>Wallet / local books scope difference</dt>
              <dd>
                {reconciliationDelta === null
                  ? "Not performed"
                  : reconciliationDelta === 0n
                    ? "No difference within the observed scope"
                    : `${reconciliationDelta > 0n ? "+" : ""}${formatZec(reconciliationDelta, 8)} ZEC difference`}
              </dd>
            </div>
            <div>
              <dt>Journal chain</dt>
              <dd>{metrics.journalBalanced ? "Internal consistency verified" : "Review required"}</dd>
            </div>
            <div>
              <dt>Local pool classes</dt>
              <dd>
                {shieldedCount} shielded · {transparentCount} transparent
              </dd>
            </div>
            <div>
              <dt>Classification</dt>
              <dd>{unmatchedCount ? `${unmatchedCount} confirmed RPC records require review` : "No open records"}</dd>
            </div>
            <div>
              <dt>Collection rate</dt>
              <dd>
                {metrics.collectionRate}% · {paidInvoiceCount} collected
              </dd>
            </div>
          </dl>
          <button className="folio-text-link" onClick={() => setView("transactions")}>
            Review privacy scope <ArrowRight aria-hidden="true" size={15} />
          </button>
        </section>
      </div>

      <div className="dashboard-registers">
        <section className="folio-section transaction-register" aria-labelledby="transactions-title">
          <div className="folio-section__header">
            <div>
              <h2 id="transactions-title">Recent transaction records</h2>
              <p>Five newest local transaction records · source shown on each row</p>
            </div>
            <button className="folio-text-link" onClick={() => setView("transactions")}>
              All transactions <ArrowRight aria-hidden="true" size={14} />
            </button>
          </div>
          {recentTransactions.length ? (
            <div className="folio-table-wrap" tabIndex={0} role="region" aria-label="Recent transaction records table">
              <table className="folio-table transaction-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Counterparty / transaction</th>
                    <th>Vault / pool</th>
                    <th>Status</th>
                    <th className="is-numeric">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTransactions.map((transaction) => (
                    <TransactionRow
                      key={transaction.id}
                      transaction={transaction}
                      vaultName={vaultNames.get(transaction.vaultId) ?? transaction.vaultId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="folio-empty">No transaction records yet.</p>
          )}
        </section>

        <section className="folio-section receivables-register" aria-labelledby="receivables-title">
          <div className="folio-section__header">
            <div>
              <h2 id="receivables-title">Open invoices</h2>
              <p>
                {openInvoices.length} open records · {overdueCount} overdue
              </p>
            </div>
          </div>
          {invoicePreview.length ? (
            <ul className="receivable-list">
              {invoicePreview.map((invoice) => (
                <li key={invoice.id}>
                  <button type="button" onClick={() => setView("invoices")}>
                    <span>
                      <b>{invoice.clientAlias}</b>
                      <small>
                        {invoice.number} ·{" "}
                        <time dateTime={invoice.dueDate}>{dueDate.format(new Date(invoice.dueDate))}</time>
                      </small>
                    </span>
                    <span className="receivable-list__amount">
                      <b>{formatZec(invoice.zatoshi, 4)} ZEC</b>
                      <StatusBadge status={invoice.status} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="folio-empty">No open invoices.</p>
          )}
        </section>
      </div>

      <section className="folio-section evidence-timeline" aria-labelledby="activity-title">
        <div className="folio-section__header">
          <div>
            <h2 id="activity-title">Recently recorded events</h2>
            <p>Local activity log · not a substitute for a verification result</p>
          </div>
        </div>
        {recentActivities.length ? (
          <ol>
            {recentActivities.map((activity) => (
              <li key={activity.id} className={`evidence-timeline__item evidence-timeline__item--${activity.tone}`}>
                <time dateTime={activity.timestamp}>{transactionDate.format(new Date(activity.timestamp))}</time>
                <span>
                  <b>{activity.title}</b>
                  <small>{activity.detail}</small>
                </span>
                <em>{activityLabels[activity.kind]}</em>
              </li>
            ))}
          </ol>
        ) : (
          <p className="folio-empty">No recorded activity.</p>
        )}
      </section>

      <section className="folio-section vault-register" aria-labelledby="vault-title">
        <div className="folio-section__header">
          <div>
            <h2 id="vault-title">Vault scope</h2>
            <p>Purpose, pool, period, and recipient identity</p>
          </div>
          <button className="folio-text-link" onClick={() => setView("audit")}>
            Audit scope <ArrowRight aria-hidden="true" size={14} />
          </button>
        </div>
        {state.vaults.length ? (
          <div className="folio-table-wrap" tabIndex={0} role="region" aria-label="Vault scope table">
            <table className="folio-table vault-table">
              <thead>
                <tr>
                  <th>Vault</th>
                  <th>Purpose</th>
                  <th>Pool</th>
                  <th>Period</th>
                  <th>Recipient identity</th>
                </tr>
              </thead>
              <tbody>
                {state.vaults.map((vault) => (
                  <tr key={vault.id}>
                    <th scope="row">
                      <i style={{ backgroundColor: vault.color }} />
                      {vault.name}
                    </th>
                    <td>{vault.purpose}</td>
                    <td>{receiverCapabilityLabel(vault.pool)}</td>
                    <td>{vault.period}</td>
                    <td>
                      <code>{maskAddress(vault.address, 9, 7)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="folio-empty">No purpose-specific vaults defined.</p>
        )}
      </section>
    </FolioView>
  );
}

function TransactionRow({ transaction, vaultName }: { transaction: ChainTransaction; vaultName: string }) {
  const isNeutral = ["internal", "anchor"].includes(transaction.direction);
  const prefix = isNeutral ? "↔" : transaction.direction === "incoming" ? "+" : "−";
  return (
    <tr>
      <td>
        <time dateTime={transaction.timestamp}>{transactionDate.format(new Date(transaction.timestamp))}</time>
      </td>
      <td>
        <b>{transaction.counterparty}</b>
        <small>
          <HashText value={transaction.txid} chars={6} />
        </small>
      </td>
      <td>
        {vaultName}
        <small>
          {transaction.pool} ·{" "}
          {transaction.source === "rpc"
            ? transaction.observationState === "orphan-candidate"
              ? "missing from latest exact scan"
              : transaction.observationHash && /^[0-9a-f]{64}$/i.test(transaction.txid)
                ? "wallet observation"
                : "RPC outbox"
            : transaction.source === "demo-fixture"
              ? "demo fixture"
              : "local outbox"}
        </small>
      </td>
      <td>
        <StatusBadge
          status={transaction.observationState === "orphan-candidate" ? "warning" : transaction.status}
          label={transaction.observationState === "orphan-candidate" ? "Missing from latest exact scan" : undefined}
        />
      </td>
      <td className="is-numeric">
        <b>
          {prefix} {formatZec(transaction.zatoshi, 4)} ZEC
        </b>
        {isNeutral && (
          <small>
            net principal 0{BigInt(transaction.feeZatoshi ?? "0") > 0n ? " · network fee deducted separately" : ""}
          </small>
        )}
      </td>
    </tr>
  );
}
