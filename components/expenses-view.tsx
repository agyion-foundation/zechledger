"use client";

import {
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
  FilePlus2,
  LockKeyhole,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { FolioPageHeader, FolioView, useCompactReviewLayout } from "@/components/folio";
import { CopyButton, HashText, InlineSpinner, Modal, StatusBadge } from "@/components/primitives";
import type { ViewProps } from "@/components/view-types";
import { formatTry, formatZec, receiverCapabilityLabel, zatoshiToZec } from "@/lib/money";
import { paymentRetryBlocked } from "@/lib/outbox";
import type { Expense } from "@/lib/types";
import { FieldErrors, firstFieldError, localDateInputValue, normalizeDecimalInput } from "@/components/form-utils";

export function ExpensesView({ data, refresh, notify, busy, setBusy }: ViewProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const paid = data.state.expenses.filter((item) => item.status === "paid");
  const approved = data.state.expenses.filter((item) => item.status === "approved");
  const paying = payingId ? (data.state.expenses.find((expense) => expense.id === payingId) ?? null) : null;
  const compactReview = useCompactReviewLayout();
  const vaultsById = new Map(data.state.vaults.map((vault) => [vault.id, vault]));
  const categorySpend = useMemo(() => {
    const colors = new Map(data.metrics.categorySpend.map((item) => [item.name, item.color]));
    const amounts = new Map<string, number>();
    for (const expense of data.state.expenses) {
      amounts.set(expense.category, (amounts.get(expense.category) ?? 0) + expense.tryTotal);
    }
    const rows = [...amounts].map(([name, value]) => ({
      name,
      value,
      color: colors.get(name) ?? "#596b63",
      share: 0,
      remainder: 0n,
    }));
    const total = rows.reduce((sum, item) => sum + BigInt(item.value), 0n);
    if (total === 0n) return rows;
    for (const row of rows) {
      const numerator = BigInt(row.value) * 100n;
      row.share = Number(numerator / total);
      row.remainder = numerator % total;
    }
    let undistributed = 100 - rows.reduce((sum, row) => sum + row.share, 0);
    for (const row of [...rows].sort((left, right) =>
      left.remainder === right.remainder
        ? left.name.localeCompare(right.name, "en-US")
        : left.remainder > right.remainder
          ? -1
          : 1,
    )) {
      if (undistributed === 0) break;
      row.share += 1;
      undistributed -= 1;
    }
    return rows.sort((left, right) => right.value - left.value || left.name.localeCompare(right.name, "en-US"));
  }, [data.metrics.categorySpend, data.state.expenses]);
  return (
    <FolioView className="folio-view--expenses">
      <FolioPageHeader
        overline="Payments worklist"
        title="Track expenses from entry to the wallet queue"
        description="Track the document, purpose vault, valuation, and send status in one place."
        actions={
          <button className="button button--primary" onClick={() => setCreateOpen(true)} disabled={busy !== null}>
            <FilePlus2 aria-hidden="true" size={17} /> New expense
          </button>
        }
      />
      <section className="expense-overview">
        <article className="panel expense-chart-card">
          <div className="panel__header">
            <div>
              <span className="eyebrow">CATEGORY REGISTER</span>
              <h3>Recorded expense distribution</h3>
            </div>
            <span className="register-count">{categorySpend.length} categories · including drafts</span>
          </div>
          <ul className="category-register">
            {categorySpend.map((item) => (
              <li key={item.name}>
                <span className="category-register__name">
                  <i aria-hidden="true" style={{ background: item.color }} />
                  {item.name}
                </span>
                <b>{formatTry(item.value)}</b>
                <span className="category-register__share">{item.share}%</span>
                <progress value={item.share} max={100} aria-label={`${item.name}: ${item.share}% of total`} />
              </li>
            ))}
          </ul>
        </article>
        <div className="expense-kpis">
          <article>
            <div>
              <CircleDollarSign aria-hidden="true" size={19} />
            </div>
            <span>RECOGNIZED EXPENSES</span>
            <b>{formatTry(data.metrics.expensesTry)}</b>
            <small>
              {formatZec(paid.reduce((sum, item) => sum + BigInt(item.zatoshi), 0n).toString(), 3)} test ZEC
            </small>
          </article>
          <article>
            <div>
              <CheckCircle2 aria-hidden="true" size={19} />
            </div>
            <span>PAID</span>
            <b>{paid.length} documents</b>
            <small>Posted to the ledger</small>
          </article>
          <article className={approved.length ? "kpi-warm" : ""}>
            <div>
              <CreditCard aria-hidden="true" size={19} />
            </div>
            <span>SINGLE-ADMIN PAYMENT QUEUE</span>
            <b>{approved.length} expenses</b>
            <small>
              {approved.length ? "No maker-checker controls · subject to broadcast prerequisites" : "Nothing pending"}
            </small>
          </article>
        </div>
      </section>
      <article className="panel table-panel">
        <div className="table-toolbar table-toolbar--plain">
          <div>
            <span className="eyebrow">EXPENSE DOCUMENTS</span>
            <h3>All expenses</h3>
          </div>
          <div className="safe-send">
            <LockKeyhole aria-hidden="true" size={15} />
            <span>Mainnet sends are locked in code</span>
          </div>
        </div>
        {!compactReview && (
          <div className="data-table-wrap" role="region" aria-label="Expense table" tabIndex={0}>
            <table className="data-table expense-table">
              <thead>
                <tr>
                  <th>DOCUMENT</th>
                  <th>VENDOR / DESCRIPTION</th>
                  <th>CATEGORY</th>
                  <th>PURPOSE VAULT</th>
                  <th>AMOUNT</th>
                  <th>STATUS</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.state.expenses.map((expense) => {
                  const vault = data.state.vaults.find((item) => item.id === expense.vaultId);
                  const retryBlocked = paymentRetryBlocked(data.state.transactions, expense.id);
                  return (
                    <tr key={expense.id}>
                      <td>
                        <b className="number-link">{expense.number}</b>
                        <small>
                          {new Date(expense.date).toLocaleDateString("en-US", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })}
                        </small>
                      </td>
                      <td>
                        <b>{expense.vendor}</b>
                        <small>{expense.description}</small>
                      </td>
                      <td>
                        <span className="category-chip">{expense.category}</span>
                      </td>
                      <td>
                        <div className="vault-cell">
                          <i style={{ background: vault?.color }} />
                          <span>
                            <b>{vault?.name}</b>
                            <small>{vault ? receiverCapabilityLabel(vault.pool) : "Not configured"}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <b>{formatZec(expense.zatoshi, 3)} ZEC</b>
                        <small>{formatTry(expense.tryTotal)}</small>
                      </td>
                      <td>
                        <StatusBadge status={expense.status} />
                      </td>
                      <td>
                        {expense.status === "approved" ? (
                          <button
                            className="pay-row-button"
                            data-modal-return={`expense-${expense.id}`}
                            onClick={() => setPayingId(expense.id)}
                            disabled={retryBlocked}
                            title={
                              retryBlocked
                                ? "The previous wallet result is awaiting reconciliation; rebroadcast is blocked."
                                : undefined
                            }
                          >
                            {retryBlocked ? (
                              <ShieldAlert aria-hidden="true" size={14} />
                            ) : (
                              <Send aria-hidden="true" size={14} />
                            )}{" "}
                            {retryBlocked ? "Awaiting reconciliation" : "Pay on testnet"}
                          </button>
                        ) : expense.txid ? (
                          <span title={expense.txid}>
                            <HashText value={expense.txid} chars={4} />
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {compactReview && (
          <ul className="review-task-list" aria-label="Mobile payments worklist">
            {data.state.expenses.map((expense) => (
              <li key={expense.id}>
                <div className="review-task-list__meta">
                  <span>{expense.number}</span>
                  <time dateTime={expense.date}>
                    {new Date(`${expense.date}T12:00:00Z`).toLocaleDateString("en-US")}
                  </time>
                </div>
                <div className="review-task-list__subject">
                  <div>
                    <b>{expense.vendor}</b>
                    <span>
                      {expense.category} · {expense.description}
                    </span>
                  </div>
                  <StatusBadge status={expense.status} />
                </div>
                <dl className="review-task-list__facts">
                  <div>
                    <dt>Vault / recipient type</dt>
                    <dd>
                      {vaultsById.get(expense.vaultId)?.name ?? expense.vaultId} ·{" "}
                      {vaultsById.get(expense.vaultId)
                        ? receiverCapabilityLabel(vaultsById.get(expense.vaultId)!.pool)
                        : "Unknown"}
                    </dd>
                  </div>
                  <div>
                    <dt>ZEC amount</dt>
                    <dd>{formatZec(expense.zatoshi, 8)} ZEC</dd>
                  </div>
                  {expense.txid && (
                    <div>
                      <dt>Wallet transaction ID</dt>
                      <dd>
                        <HashText value={expense.txid} chars={5} /> <CopyButton value={expense.txid} compact />
                      </dd>
                    </div>
                  )}
                </dl>
                <div className="review-task-list__footer">
                  <b>{formatTry(expense.tryTotal)}</b>
                  {expense.status === "approved" ? (
                    <button
                      type="button"
                      data-modal-return={`expense-${expense.id}`}
                      onClick={() => setPayingId(expense.id)}
                      disabled={paymentRetryBlocked(data.state.transactions, expense.id)}
                      title={
                        paymentRetryBlocked(data.state.transactions, expense.id)
                          ? "The previous wallet result is awaiting reconciliation; rebroadcast is blocked."
                          : undefined
                      }
                    >
                      {paymentRetryBlocked(data.state.transactions, expense.id)
                        ? "Rebroadcast blocked"
                        : "Open payment queue"}{" "}
                      <Send aria-hidden="true" size={14} />
                    </button>
                  ) : (
                    <span>
                      {expense.paymentCanonicalId && expense.paymentBlockHeight !== undefined
                        ? "Account-scoped wallet link"
                        : expense.txid
                          ? "Local transaction ID"
                          : "Document record"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="table-footer">
          <span>{data.state.expenses.length} expense documents</span>
          <span>Amounts are valued using the configured static TRY rate</span>
        </div>
      </article>
      <ExpenseCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        data={data}
        refresh={refresh}
        notify={notify}
        busy={busy}
        setBusy={setBusy}
      />
      <PaymentModal
        expense={paying}
        onClose={() => setPayingId(null)}
        data={data}
        refresh={refresh}
        notify={notify}
        busy={busy}
        setBusy={setBusy}
      />
    </FolioView>
  );
}

function ExpenseCreateModal({
  open,
  onClose,
  data,
  refresh,
  notify,
  busy,
  setBusy,
}: { open: boolean; onClose: () => void } & ViewProps) {
  const eligibleVaults = data.state.vaults.filter(
    (vault) => vault.status === "active" && (data.state.mode === "demo" || vault.addressSource === "env"),
  );
  const [form, setForm] = useState({
    requestId: crypto.randomUUID(),
    vendor: "",
    category: "Cloud & Infrastructure",
    description: "",
    date: localDateInputValue(),
    amountZec: "0.10000000",
    vatRate: "20",
    vaultId: eligibleVaults[0]?.id ?? "",
    payToAddress:
      data.state.mode === "demo"
        ? "ztestsapling1n65uaftvs2g7075q2x2a04shfk066u3lldzxsrprfrqtzxnhc9ps73v4lhx4l9yfxj46sl0q90k"
        : "",
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const error = (field: string) => fieldErrors[field]?.[0];
  const update = (key: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
  };
  function focusError(errors: FieldErrors) {
    const field = firstFieldError(errors);
    if (!field) return;
    window.requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus());
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFieldErrors({});
    setBusy("expense");
    try {
      const response = await fetch("/api/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (
        response.status === 409 &&
        payload.rotateRequestId &&
        window.confirm(
          `${payload.existingRecord?.number ?? "This record"} has already been recorded. Start a new request ID for the modified payload?`,
        )
      ) {
        setForm((value) => ({ ...value, requestId: crypto.randomUUID() }));
      }
      if (!response.ok) {
        const errors = (payload.fields ?? {}) as FieldErrors;
        setFieldErrors(errors);
        focusError(errors);
        notify(payload.error ?? "Expense could not be created.", "error");
        return;
      }
      const refreshed = await refresh();
      notify(
        refreshed
          ? "Expense and balanced payable entry created."
          : "Expense created, but the latest view could not be loaded. Please try again.",
        refreshed ? "success" : "error",
      );
      onClose();
      setForm((value) => ({ ...value, requestId: crypto.randomUUID(), vendor: "", description: "" }));
    } catch (cause) {
      notify((cause as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy === "expense"}
      eyebrow="NEW EXPENSE"
      title="Record expense"
      size="large"
    >
      <form ref={formRef} className="form-grid" onSubmit={submit}>
        {Object.keys(fieldErrors).length > 0 && (
          <div className="form-error-summary field--wide" role="alert">
            Review the highlighted fields.
          </div>
        )}
        <label className="field">
          <span>Vendor</span>
          <input
            name="vendor"
            required
            minLength={2}
            maxLength={120}
            value={form.vendor}
            onChange={(event) => update("vendor", event.target.value)}
            placeholder="Vendor name"
            data-modal-autofocus="true"
            aria-invalid={Boolean(error("vendor"))}
          />
          {error("vendor") && <small className="field-error">{error("vendor")}</small>}
        </label>
        <label className="field">
          <span>Category</span>
          <select
            name="category"
            value={form.category}
            onChange={(event) => update("category", event.target.value)}
            aria-invalid={Boolean(error("category"))}
          >
            {["Cloud & Infrastructure", "Professional Services", "Office", "Design", "Travel", "Other"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          {error("category") && <small className="field-error">{error("category")}</small>}
        </label>
        <label className="field field--wide">
          <span>Description</span>
          <input
            name="description"
            required
            minLength={3}
            maxLength={180}
            value={form.description}
            onChange={(event) => update("description", event.target.value)}
            placeholder="Business purpose of the expense"
            aria-invalid={Boolean(error("description"))}
          />
          {error("description") && <small className="field-error">{error("description")}</small>}
        </label>
        <label className="field">
          <span>Document date</span>
          <input
            name="date"
            type="date"
            required
            value={form.date}
            onChange={(event) => update("date", event.target.value)}
            aria-invalid={Boolean(error("date"))}
          />
          {error("date") && <small className="field-error">{error("date")}</small>}
        </label>
        <label className="field">
          <span>VAT rate</span>
          <select
            name="vatRate"
            value={form.vatRate}
            onChange={(event) => update("vatRate", event.target.value)}
            aria-invalid={Boolean(error("vatRate"))}
          >
            <option value="0">0%</option>
            <option value="10">10%</option>
            <option value="20">20%</option>
          </select>
          {error("vatRate") && <small className="field-error">{error("vatRate")}</small>}
        </label>
        <label className="field">
          <span>Amount</span>
          <div className="input-suffix">
            <input
              name="amountZec"
              required
              inputMode="decimal"
              pattern="^(0|[1-9]\d*)(\.\d{1,8})?$"
              value={form.amountZec}
              onChange={(event) => update("amountZec", normalizeDecimalInput(event.target.value))}
              aria-invalid={Boolean(error("amountZec"))}
            />
            <b>ZEC</b>
          </div>
          <small>Comma or period · up to 8 decimal places</small>
          {error("amountZec") && <small className="field-error">{error("amountZec")}</small>}
        </label>
        <label className="field">
          <span>Purpose vault</span>
          <select
            name="vaultId"
            required
            value={form.vaultId}
            onChange={(event) => update("vaultId", event.target.value)}
            aria-invalid={Boolean(error("vaultId"))}
          >
            {eligibleVaults.map((vault) => (
              <option key={vault.id} value={vault.id}>
                {vault.name}
              </option>
            ))}
          </select>
          {!eligibleVaults.length && <small className="field-error">No active purpose vaults are available.</small>}
          {error("vaultId") && <small className="field-error">{error("vaultId")}</small>}
        </label>
        <label className="field field--wide">
          <span>Approved vendor testnet address</span>
          <textarea
            name="payToAddress"
            required
            minLength={50}
            maxLength={300}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            value={form.payToAddress}
            onChange={(event) => update("payToAddress", event.target.value.trim())}
            placeholder="utest1… or ztestsapling1…"
            rows={3}
            aria-invalid={Boolean(error("payToAddress"))}
          />
          <small>
            The address is included in the record metadata commitment and cannot be changed at payment time.
          </small>
          {error("payToAddress") && <small className="field-error">{error("payToAddress")}</small>}
        </label>
        <div className="form-note field--wide">
          <Sparkles aria-hidden="true" size={18} />
          <p>
            <b>Automatic accounting preview</b>
            <span>
              Debit: 740 Expenses + 191 Deductible VAT · Credit: 320 Vendors. Totals are stored in zatoshi and minor TRY
              units.
            </span>
          </p>
        </div>
        <div className="form-actions field--wide">
          <button type="button" className="button button--ghost" onClick={onClose} disabled={busy === "expense"}>
            Cancel
          </button>
          <button className="button button--primary" disabled={busy !== null}>
            {busy === "expense" ? <InlineSpinner /> : <FilePlus2 aria-hidden="true" size={16} />} Save & add to payment
            queue
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PaymentModal({
  expense,
  onClose,
  data,
  refresh,
  notify,
  busy,
  setBusy,
}: { expense: Expense | null; onClose: () => void } & ViewProps) {
  if (!expense) return null;
  const currentExpense = expense;
  const memo = `ZECHLEDGER|${currentExpense.number}|${currentExpense.documentHash.slice(0, 12)}`;
  const retryBlocked = paymentRetryBlocked(data.state.transactions, currentExpense.id);
  const paymentReady = data.node.sendReady && !retryBlocked;
  const readinessMessage = retryBlocked
    ? "The outcome of the previous wallet operation is unresolved; rebroadcast is blocked until reconciliation."
    : !data.node.reachable
      ? "Cannot reach the testnet node."
      : !data.node.safeTestnet
        ? "The connected network could not be verified as testnet."
        : !data.node.walletReachable
          ? "Wallet RPC is not connected."
          : !data.node.walletSynchronized
            ? "Waiting for the wallet scan to finish."
            : !data.node.sendEnabled
              ? "The server send lock is disabled: ZCASH_ALLOW_SEND=true is required."
              : !data.node.externalBroadcastConfirmed
                ? "The operator’s external-broadcast declaration is missing."
                : !data.node.fullPrivacyEnabled
                  ? "FullPrivacy is not configured."
                  : "Server prerequisites are ready; node and wallet types, account scope, address, and RPC will be checked again when sending.";
  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || !paymentReady) return;
    const confirmed = window.confirm(
      `${currentExpense.number}: Broadcast ${formatZec(currentExpense.zatoshi, 8)} test ZEC to the address fixed in the document? This action cannot be undone.`,
    );
    if (!confirmed) return;
    setBusy("send");
    try {
      const response = await fetch("/api/zcash/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toAddress: currentExpense.payToAddress,
          amountZec: zatoshiToZec(currentExpense.zatoshi),
          memo,
          expenseId: currentExpense.id,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Payment could not be sent.");
      const refreshed = await refresh();
      notify(
        refreshed
          ? `Testnet operation started: ${String(payload.operationId).slice(0, 18)}…`
          : "Testnet operation started, but the latest view could not be loaded. Please try again.",
        refreshed ? "success" : "error",
      );
      onClose();
    } catch (cause) {
      await refresh();
      notify((cause as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }
  return (
    <Modal
      open={Boolean(expense)}
      onClose={onClose}
      closeDisabled={busy === "send"}
      eyebrow="LIVE TESTNET BROADCAST"
      title="Shielded expense payment"
      size="medium"
    >
      <form className="payment-form" onSubmit={send}>
        <div className="payment-hero">
          <div>
            <span>AMOUNT TO PAY</span>
            <h2>
              {formatZec(expense.zatoshi, 5)} <small>ZEC</small>
            </h2>
            <p>
              {expense.vendor} · {expense.number}
            </p>
          </div>
          <div className="shield-coin">
            <Send aria-hidden="true" size={23} />
          </div>
        </div>
        <div className="address-box">
          <span>VENDOR TESTNET ADDRESS FIXED IN THE DOCUMENT · CANNOT BE CHANGED</span>
          <code>{currentExpense.payToAddress}</code>
          <small>
            The address is covered by the expense document’s SHA-256 hash; the API validates it with the amount and
            memo.
          </small>
        </div>
        <div className="memo-box">
          <span>ENCRYPTED MEMO · {new TextEncoder().encode(memo).length}/512 BYTES</span>
          <code>{memo}</code>
        </div>
        <div className={`rpc-readiness ${paymentReady ? "is-ready" : ""}`}>
          {paymentReady ? <CheckCircle2 aria-hidden="true" size={18} /> : <ShieldAlert aria-hidden="true" size={18} />}
          <p>
            <b>{paymentReady ? "Server send prerequisites are ready" : "RPC send prerequisites are not ready"}</b>
            <span>{readinessMessage}</span>
          </p>
        </div>
        <div className="send-safety">
          <LockKeyhole aria-hidden="true" size={16} />
          <span>
            Before sending, the server revalidates the exact node and wallet types, account scope,
            <code>ZCASH_ALLOW_SEND=true</code>, FullPrivacy, and the operator’s broadcast declaration. This screen does
            not prove spending authority or custody.
          </span>
        </div>
        <div className="form-actions">
          <button type="button" className="button button--ghost" onClick={onClose} disabled={busy === "send"}>
            Cancel
          </button>
          <button className="button button--primary" disabled={busy !== null || !paymentReady}>
            {busy === "send" ? <InlineSpinner /> : <Send aria-hidden="true" size={16} />} Broadcast to testnet
          </button>
        </div>
      </form>
    </Modal>
  );
}
