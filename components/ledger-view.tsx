"use client";

import {
  BookCheck,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Fingerprint,
  Link2,
  LockKeyhole,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import { FolioPageHeader, FolioView } from "@/components/folio";
import { CopyButton, HashText, StatusBadge } from "@/components/primitives";
import type { ViewProps } from "@/components/view-types";
import { csvContent } from "@/lib/csv";
import { formatTry, formatZec, safeKurusSum } from "@/lib/money";

export function LedgerView({ data }: ViewProps) {
  const [expanded, setExpanded] = useState<string | null>(data.state.journals.at(-1)?.id ?? null);
  const [filter, setFilter] = useState("all");
  const journals = useMemo(
    () => [...data.state.journals].filter((entry) => filter === "all" || entry.sourceType === filter).reverse(),
    [data.state.journals, filter],
  );
  const accounts = useMemo(() => {
    const map = new Map<string, { code: string; name: string; debit: number; credit: number }>();
    for (const entry of data.state.journals)
      for (const line of entry.lines) {
        const current = map.get(line.accountCode) ?? {
          code: line.accountCode,
          name: line.accountName,
          debit: 0,
          credit: 0,
        };
        current.debit = safeKurusSum([current.debit, line.debitTry]);
        current.credit = safeKurusSum([current.credit, line.creditTry]);
        map.set(line.accountCode, current);
      }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [data.state.journals]);
  const totalDebit = safeKurusSum(data.state.journals.flatMap((entry) => entry.lines).map((line) => line.debitTry));
  const totalCredit = safeKurusSum(data.state.journals.flatMap((entry) => entry.lines).map((line) => line.creditTry));
  const invoiceIds = new Set(data.state.invoices.map((invoice) => invoice.id));
  const expenseIds = new Set(data.state.expenses.map((expense) => expense.id));
  function exportLedger() {
    const rows: unknown[][] = [
      ["Journal Entry", "Date", "Description", "Account", "Account Name", "Debit TRY", "Credit TRY", "Zatoshi", "Hash"],
    ];
    for (const entry of data.state.journals)
      for (const line of entry.lines)
        rows.push([
          entry.number,
          entry.date,
          entry.description,
          line.accountCode,
          line.accountName,
          (line.debitTry / 100).toFixed(2),
          (line.creditTry / 100).toFixed(2),
          line.zatoshi ?? "",
          entry.hash,
        ]);
    const csv = csvContent(rows);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    link.download = `zechledger-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  return (
    <FolioView className="folio-view--ledger">
      <FolioPageHeader
        overline="Double-entry ledger"
        title="Journal, trial balance, and hash chain"
        description="TRY amounts are stored in minor units and ZEC amounts in zatoshis; balance and hash-chain integrity are checked separately."
        actions={
          <button className="button button--ghost" onClick={exportLedger}>
            <Download aria-hidden="true" size={16} /> Download journal
          </button>
        }
      />
      <section className={`ledger-integrity ${data.metrics.journalBalanced ? "is-valid" : "is-invalid"}`}>
        <div className="ledger-integrity__seal">
          {data.metrics.journalBalanced ? (
            <ShieldCheck aria-hidden="true" size={30} />
          ) : (
            <LockKeyhole aria-hidden="true" size={30} />
          )}
        </div>
        <div>
          <span>LEDGER INTEGRITY</span>
          <h3>
            {data.metrics.journalBalanced
              ? "All entries are balanced and the hash chain is valid"
              : "Integrity check failed"}
          </h3>
          <p>
            {data.state.journals.length} journal entries · revision {data.state.revision} · last checked now
          </p>
        </div>
        <div className="ledger-head">
          <span>LEDGER HEAD</span>
          <HashText value={data.state.ledgerHead} chars={12} />
          <CopyButton value={data.state.ledgerHead} compact />
        </div>
      </section>
      <section className="ledger-summary">
        <article>
          <Scale aria-hidden="true" size={19} />
          <span>TOTAL DEBITS</span>
          <b>{formatTry(totalDebit)}</b>
        </article>
        <article>
          <Scale aria-hidden="true" size={19} />
          <span>TOTAL CREDITS</span>
          <b>{formatTry(totalCredit)}</b>
        </article>
        <article>
          <Check aria-hidden="true" size={19} />
          <span>DIFFERENCE</span>
          <b>{formatTry(Math.abs(totalDebit - totalCredit))}</b>
        </article>
        <article>
          <Fingerprint aria-hidden="true" size={19} />
          <span>HASHED ENTRIES</span>
          <b>{data.state.journals.length}</b>
        </article>
      </section>
      <div className="ledger-layout">
        <article className="panel journal-panel">
          <div className="panel__header journal-header">
            <div>
              <span className="eyebrow">JOURNAL ENTRIES</span>
              <h3>Transaction journal</h3>
            </div>
            <select aria-label="Journal source filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All sources</option>
              <option value="invoice">Invoices</option>
              <option value="payment">Payments / receipts</option>
              <option value="expense">Expenses</option>
              <option value="fee">Network fees</option>
              <option value="transfer">Inter-vault transfers</option>
              <option value="anchor">Audit anchors</option>
            </select>
          </div>
          <div className="journal-list">
            {journals.map((entry) => {
              const isOpen = expanded === entry.id;
              const debit = entry.lines.reduce((sum, line) => sum + line.debitTry, 0);
              const sourceLabel =
                entry.sourceType === "invoice"
                  ? "Invoice entry"
                  : entry.sourceType === "payment"
                    ? invoiceIds.has(entry.sourceId)
                      ? "Wallet-observed receipt reconciliation"
                      : expenseIds.has(entry.sourceId)
                        ? "Wallet-observed expense reconciliation"
                        : "Payment / receipt"
                    : entry.sourceType === "expense"
                      ? "Expense entry"
                      : entry.sourceType === "fee"
                        ? "Network fee"
                        : entry.sourceType === "transfer"
                          ? "Inter-vault transfer"
                          : "Audit anchor";
              return (
                <div className={`journal-entry ${isOpen ? "is-open" : ""}`} key={entry.id}>
                  <button
                    className="journal-entry__summary"
                    aria-expanded={isOpen}
                    aria-controls={`journal-detail-${entry.id}`}
                    onClick={() => setExpanded(isOpen ? null : entry.id)}
                  >
                    <div className="journal-link-icon">
                      <Link2 aria-hidden="true" size={16} />
                    </div>
                    <div className="journal-entry__identity">
                      <b>{entry.number}</b>
                      <span>
                        {new Date(entry.date).toLocaleDateString("en-US", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </div>
                    <div className="journal-entry__description">
                      <b>{entry.description}</b>
                      <span>
                        {sourceLabel} · {data.state.vaults.find((v) => v.id === entry.vaultId)?.name}
                      </span>
                    </div>
                    <b className="journal-entry__amount">{formatTry(debit)}</b>
                    <StatusBadge status={entry.status} />
                    {isOpen ? <ChevronUp aria-hidden="true" size={17} /> : <ChevronDown aria-hidden="true" size={17} />}
                  </button>
                  {isOpen && (
                    <div
                      id={`journal-detail-${entry.id}`}
                      className="journal-entry__detail"
                      role="region"
                      aria-label={`${entry.number} journal lines`}
                      tabIndex={0}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th>ACCOUNT</th>
                            <th>DESCRIPTION</th>
                            <th>DEBIT</th>
                            <th>CREDIT</th>
                            <th>ZEC AMOUNT</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entry.lines.map((line, index) => (
                            <tr key={`${line.accountCode}-${index}`}>
                              <td>
                                <code>{line.accountCode}</code>
                              </td>
                              <td>{line.accountName}</td>
                              <td>{line.debitTry ? formatTry(line.debitTry) : "—"}</td>
                              <td>{line.creditTry ? formatTry(line.creditTry) : "—"}</td>
                              <td>{line.zatoshi ? `${formatZec(line.zatoshi, 5)} ZEC` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={2}>
                              Balanced total <Check aria-hidden="true" size={14} />
                            </td>
                            <td>{formatTry(debit)}</td>
                            <td>{formatTry(entry.lines.reduce((sum, line) => sum + line.creditTry, 0))}</td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                      <div
                        className="journal-proof"
                        role="region"
                        aria-label={`${entry.number} hash chain`}
                        tabIndex={0}
                      >
                        <div>
                          <span>PREVIOUS ENTRY</span>
                          <HashText value={entry.previousHash} chars={8} />
                        </div>
                        <Link2 aria-hidden="true" size={16} />
                        <div>
                          <span>SHA-256 HASH OF THIS ENTRY</span>
                          <HashText value={entry.hash} chars={10} />
                        </div>
                        {entry.chainTxid && (
                          <>
                            <Link2 aria-hidden="true" size={16} />
                            <div>
                              <span>TESTNET TRANSACTION</span>
                              <HashText value={entry.chainTxid} chars={8} />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </article>
        <aside className="panel trial-balance" aria-label="Trial balance account balances" tabIndex={0}>
          <div className="panel__header">
            <div>
              <span className="eyebrow">TRIAL BALANCE</span>
              <h3>Account balances</h3>
            </div>
            <BookCheck aria-hidden="true" size={19} />
          </div>
          <div className="trial-balance__head">
            <span>ACCOUNT</span>
            <span>DEBIT</span>
            <span>CREDIT</span>
          </div>
          {accounts.map((account) => (
            <div className="trial-balance__row" key={account.code}>
              <div>
                <code>{account.code}</code>
                <span>{account.name}</span>
              </div>
              <b>{account.debit > account.credit ? formatTry(account.debit - account.credit) : "—"}</b>
              <b>{account.credit > account.debit ? formatTry(account.credit - account.debit) : "—"}</b>
            </div>
          ))}
          <div className={`trial-balance__foot ${data.metrics.journalBalanced ? "" : "is-invalid"}`}>
            {data.metrics.journalBalanced ? (
              <Check aria-hidden="true" size={17} />
            ) : (
              <LockKeyhole aria-hidden="true" size={17} />
            )}
            <span>
              {data.metrics.journalBalanced
                ? "Trial balance totals verified"
                : "Trial balance totals could not be verified"}
            </span>
          </div>
        </aside>
      </div>
    </FolioView>
  );
}
