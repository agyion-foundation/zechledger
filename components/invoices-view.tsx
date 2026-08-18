"use client";

import { ArrowRight, Download, FileCheck2, FilePlus2, MoreHorizontal, QrCode, Search, Shield, X } from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { FolioPageHeader, FolioView, useAccountingAsOf, useCompactReviewLayout } from "@/components/folio";
import { CopyButton, HashText, InlineSpinner, Modal, StatusBadge } from "@/components/primitives";
import type { ViewProps } from "@/components/view-types";
import { buildZip321Uri, formatTry, formatZec, maskAddress, receiverCapabilityLabel } from "@/lib/money";
import type { Invoice } from "@/lib/types";
import { invoiceStatusAt } from "@/lib/accounting-date";
import { csvContent } from "@/lib/csv";
import {
  addLocalDays,
  FieldErrors,
  firstFieldError,
  localDateInputValue,
  normalizeDecimalInput,
} from "@/components/form-utils";

export function InvoicesView({ data, refresh, notify, busy, setBusy }: ViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const agingAsOf = useAccountingAsOf();
  const compactReview = useCompactReviewLayout();
  const effectiveInvoices = useMemo(
    () => data.state.invoices.map((invoice) => ({ ...invoice, status: invoiceStatusAt(invoice, agingAsOf) })),
    [agingAsOf, data.state.invoices],
  );
  const selected = selectedId ? (effectiveInvoices.find((invoice) => invoice.id === selectedId) ?? null) : null;
  const invoices = useMemo(
    () =>
      effectiveInvoices.filter((invoice) => {
        const matchesQuery = `${invoice.number} ${invoice.client} ${invoice.title}`
          .toLocaleLowerCase("en-US")
          .includes(query.toLocaleLowerCase("en-US"));
        return matchesQuery && (filter === "all" || invoice.status === filter);
      }),
    [effectiveInvoices, query, filter],
  );
  const paidTotal = effectiveInvoices
    .filter((item) => item.status === "paid")
    .reduce((sum, item) => sum + item.tryTotal, 0);
  const openTotal = effectiveInvoices
    .filter((item) => ["pending", "overdue"].includes(item.status))
    .reduce((sum, item) => sum + item.tryTotal, 0);
  const collectionDays = effectiveInvoices
    .filter((item) => item.status === "paid" && item.paidAt)
    .map((item) =>
      Math.max(0, (new Date(item.paidAt!).valueOf() - new Date(`${item.issueDate}T00:00:00Z`).valueOf()) / 86_400_000),
    );
  const averageCollectionDays = collectionDays.length
    ? collectionDays.reduce((sum, days) => sum + days, 0) / collectionDays.length
    : null;
  const agingBuckets = useMemo(() => {
    const [year, month, day] = agingAsOf.split("-").map(Number);
    const asOf = Date.UTC(year, month - 1, day);
    const definitions = [
      { id: "not-due", label: "Not yet due / due today", min: Number.NEGATIVE_INFINITY, max: 0 },
      { id: "1-7", label: "1–7 days", min: 1, max: 7 },
      { id: "8-30", label: "8–30 days", min: 8, max: 30 },
      { id: "31-60", label: "31–60 days", min: 31, max: 60 },
      { id: "60-plus", label: "61+ days", min: 61, max: Number.POSITIVE_INFINITY },
    ];
    const openInvoices = effectiveInvoices.filter((invoice) => ["pending", "overdue"].includes(invoice.status));
    return definitions.map((definition) => {
      const matching = openInvoices.filter((invoice) => {
        const due = Date.parse(`${invoice.dueDate}T00:00:00Z`);
        const days = Number.isFinite(due) ? Math.floor((asOf - due) / 86_400_000) : 0;
        return days >= definition.min && days <= definition.max;
      });
      return {
        ...definition,
        count: matching.length,
        total: matching.reduce((sum, invoice) => sum + invoice.tryTotal, 0),
      };
    });
  }, [agingAsOf, effectiveInvoices]);

  function exportCsv() {
    const rows = [
      ["Invoice", "Customer", "Issue Date", "Due Date", "ZEC", "TRY", "Status"],
      ...effectiveInvoices.map((i) => [
        i.number,
        i.client,
        i.issueDate,
        i.dueDate,
        formatZec(i.zatoshi, 8),
        (i.tryTotal / 100).toFixed(2),
        i.status,
      ]),
    ];
    const csv = csvContent(rows);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    link.download = `zechledger-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <FolioView className="folio-view--invoices">
      <FolioPageHeader
        overline="Collections worklist"
        title="Manage receivables by due date and proof status"
        description="Track ZIP-321 requests, fixed TRY valuations, and wallet observations in one place."
        actions={
          <>
            <button className="button button--ghost" onClick={exportCsv}>
              <Download aria-hidden="true" size={16} /> CSV
            </button>
            <button className="button button--primary" onClick={() => setCreateOpen(true)} disabled={busy !== null}>
              <FilePlus2 aria-hidden="true" size={17} /> New invoice
            </button>
          </>
        }
      />

      <section className="summary-ribbon">
        <div>
          <span>TOTAL COLLECTED</span>
          <b>{formatTry(paidTotal)}</b>
          <small>{effectiveInvoices.filter((item) => item.status === "paid").length} invoices</small>
        </div>
        <div>
          <span>OPEN BALANCE</span>
          <b>{formatTry(openTotal)}</b>
          <small>
            {formatZec(
              effectiveInvoices
                .filter((i) => ["pending", "overdue"].includes(i.status))
                .reduce((sum, i) => sum + BigInt(i.zatoshi), 0n)
                .toString(),
              3,
            )}{" "}
            ZEC
          </small>
        </div>
        <div>
          <span>AVERAGE COLLECTION TIME</span>
          <b>
            {averageCollectionDays === null
              ? "—"
              : `${averageCollectionDays.toLocaleString("en-US", { maximumFractionDigits: 1 })} days`}
          </b>
          <small>{collectionDays.length} paid invoices</small>
        </div>
        <div className="summary-ribbon__privacy">
          <Shield aria-hidden="true" size={22} />
          <p>
            <b>Fixed valuation at time of entry</b>
            <span>
              The TRY equivalent uses the configured static rate at creation; it is not the current market value.
            </span>
          </p>
        </div>
      </section>

      <section className="aging-register" aria-labelledby="aging-heading">
        <header>
          <div>
            <span className="folio-overline">Receivables aging</span>
            <h3 id="aging-heading">Due-date distribution of open invoices</h3>
          </div>
          <p>
            {effectiveInvoices.filter((invoice) => ["pending", "overdue"].includes(invoice.status)).length} open records
            · as of {new Date(`${agingAsOf}T12:00:00`).toLocaleDateString("en-US")} · partial payments are not supported
          </p>
        </header>
        <dl>
          {agingBuckets.map((bucket) => (
            <div key={bucket.id} className={bucket.id === "60-plus" && bucket.count ? "is-critical" : ""}>
              <dt>{bucket.label}</dt>
              <dd>
                {formatTry(bucket.total)}
                <small>{bucket.count} invoices</small>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <article className="panel table-panel">
        <div className="table-toolbar">
          <div className="search-box">
            <Search aria-hidden="true" size={17} />
            <input
              aria-label="Search by invoice or customer"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by invoice or customer…"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                <X aria-hidden="true" size={14} />
              </button>
            )}
          </div>
          <div className="filter-tabs" role="group" aria-label="Invoice status filters">
            {[
              ["all", "All"],
              ["pending", "Pending"],
              ["paid", "Paid"],
              ["overdue", "Overdue"],
              ["draft", "Draft"],
            ].map(([id, label]) => (
              <button
                type="button"
                aria-pressed={filter === id}
                key={id}
                className={filter === id ? "is-active" : ""}
                onClick={() => setFilter(id)}
              >
                {label}
                {id !== "all" && <em>{effectiveInvoices.filter((item) => item.status === id).length}</em>}
              </button>
            ))}
          </div>
        </div>
        {!compactReview && (
          <div className="data-table-wrap" role="region" aria-label="Invoice table" tabIndex={0}>
            <table className="data-table invoice-table">
              <thead>
                <tr>
                  <th>INVOICE</th>
                  <th>CUSTOMER / WORK</th>
                  <th>ISSUED</th>
                  <th>DUE</th>
                  <th>AMOUNT</th>
                  <th>STATUS</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => {
                  const vault = data.state.vaults.find((item) => item.id === invoice.vaultId);
                  return (
                    <tr
                      key={invoice.id}
                      tabIndex={0}
                      aria-label={`Open details for ${invoice.number}`}
                      data-modal-return={`invoice-${invoice.id}`}
                      onClick={() => setSelectedId(invoice.id)}
                      onKeyDown={(event) => {
                        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                          event.preventDefault();
                          setSelectedId(invoice.id);
                        }
                      }}
                    >
                      <td>
                        <b className="number-link">{invoice.number}</b>
                        <small>
                          <i style={{ background: vault?.color }} />
                          {vault?.name}
                        </small>
                      </td>
                      <td>
                        <div className="party-cell">
                          <span className="client-badge">{invoice.clientInitials}</span>
                          <div>
                            <b>{invoice.client}</b>
                            <small>{invoice.title}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {new Date(invoice.issueDate).toLocaleDateString("en-US", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className={invoice.status === "overdue" ? "danger-text" : ""}>
                        {new Date(invoice.dueDate).toLocaleDateString("en-US", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td>
                        <b>{formatZec(invoice.zatoshi, 3)} ZEC</b>
                        <small>{formatTry(invoice.tryTotal)}</small>
                      </td>
                      <td>
                        <StatusBadge status={invoice.status} />
                      </td>
                      <td>
                        <button
                          className="row-action"
                          data-modal-return={`invoice-${invoice.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedId(invoice.id);
                          }}
                          aria-label={`Open actions for ${invoice.number}`}
                        >
                          {["pending", "overdue"].includes(invoice.status) ? (
                            <QrCode aria-hidden="true" size={17} />
                          ) : (
                            <MoreHorizontal aria-hidden="true" size={17} />
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {compactReview && (
          <ul className="review-task-list" aria-label="Mobile invoice worklist">
            {invoices.map((invoice) => (
              <li key={invoice.id}>
                <div className="review-task-list__meta">
                  <span>{invoice.number}</span>
                  <time dateTime={invoice.dueDate}>
                    Due {new Date(`${invoice.dueDate}T12:00:00Z`).toLocaleDateString("en-US")}
                  </time>
                </div>
                <div className="review-task-list__subject">
                  <div>
                    <b>{invoice.client}</b>
                    <span>{invoice.title}</span>
                  </div>
                  <StatusBadge status={invoice.status} />
                </div>
                <div className="review-task-list__footer">
                  <b>{formatTry(invoice.tryTotal)}</b>
                  <button
                    type="button"
                    data-modal-return={`invoice-${invoice.id}`}
                    onClick={() => setSelectedId(invoice.id)}
                  >
                    Open record <ArrowRight aria-hidden="true" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {invoices.length === 0 && (
          <div className="empty-state">
            <Search aria-hidden="true" size={28} />
            <h3>No invoices found</h3>
            <p>Try changing your search or filters.</p>
          </div>
        )}
        <div className="table-footer">
          <span>Showing {invoices.length} records</span>
          <span>Ledger revision #{data.state.revision}</span>
        </div>
      </article>

      <InvoiceCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        data={data}
        busy={busy}
        setBusy={setBusy}
        refresh={refresh}
        notify={notify}
        onCreated={(invoice) => {
          setCreateOpen(false);
          setSelectedId(invoice.id);
        }}
      />
      <InvoiceDetailModal invoice={selected} onClose={() => setSelectedId(null)} data={data} />
    </FolioView>
  );
}

function InvoiceCreateModal({
  open,
  onClose,
  data,
  busy,
  setBusy,
  refresh,
  notify,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  data: ViewProps["data"];
  busy: string | null;
  setBusy: (value: string | null) => void;
  refresh: () => Promise<boolean>;
  notify: ViewProps["notify"];
  onCreated: (invoice: Invoice) => void;
}) {
  const baseDate = new Date();
  const eligibleVaults = data.state.vaults.filter(
    (vault) => vault.status === "active" && (data.state.mode === "demo" || vault.addressSource === "env"),
  );
  const [form, setForm] = useState({
    requestId: crypto.randomUUID(),
    client: "",
    title: "",
    issueDate: localDateInputValue(baseDate),
    dueDate: addLocalDays(baseDate, 21),
    amountZec: "0.25000000",
    vatRate: "20",
    vaultId: eligibleVaults[0]?.id ?? "",
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);

  function focusError(errors: FieldErrors) {
    const field = firstFieldError(errors);
    if (!field) return;
    window.requestAnimationFrame(() => {
      const target = formRef.current?.querySelector<HTMLElement>(`[name="${field}"], [data-field="${field}"]`);
      target?.focus();
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFieldErrors({});
    setBusy("invoice");
    try {
      const response = await fetch("/api/invoices", {
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
        notify(payload.error ?? "Invoice could not be created.", "error");
        return;
      }
      const refreshed = await refresh();
      notify(
        refreshed
          ? "Invoice and balanced journal entry created."
          : "Invoice created, but the latest view could not be loaded. Please try again.",
        refreshed ? "success" : "error",
      );
      onCreated(payload.invoice as Invoice);
      setForm((value) => ({ ...value, requestId: crypto.randomUUID(), client: "", title: "" }));
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  const update = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };
  const error = (field: string) => fieldErrors[field]?.[0];

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy === "invoice"}
      eyebrow="NEW RECEIVABLE"
      title="Create invoice"
      size="large"
    >
      <form ref={formRef} className="form-grid" onSubmit={submit}>
        {Object.keys(fieldErrors).length > 0 && (
          <div className="form-error-summary field--wide" role="alert">
            Review the highlighted fields.
          </div>
        )}
        <label className="field field--wide">
          <span>Customer / organization</span>
          <input
            name="client"
            required
            minLength={2}
            maxLength={120}
            value={form.client}
            onChange={(event) => update("client", event.target.value)}
            placeholder="e.g., Atlas Open Technology"
            data-modal-autofocus="true"
            aria-invalid={Boolean(error("client"))}
          />
          {error("client") && <small className="field-error">{error("client")}</small>}
        </label>
        <label className="field field--wide">
          <span>Service description</span>
          <input
            name="title"
            required
            minLength={3}
            maxLength={180}
            value={form.title}
            onChange={(event) => update("title", event.target.value)}
            placeholder="Product or service delivered"
            aria-invalid={Boolean(error("title"))}
          />
          {error("title") && <small className="field-error">{error("title")}</small>}
        </label>
        <label className="field">
          <span>Invoice date</span>
          <input
            name="issueDate"
            type="date"
            required
            value={form.issueDate}
            onChange={(event) => update("issueDate", event.target.value)}
            aria-invalid={Boolean(error("issueDate"))}
          />
          {error("issueDate") && <small className="field-error">{error("issueDate")}</small>}
        </label>
        <label className="field">
          <span>Due date</span>
          <input
            name="dueDate"
            type="date"
            required
            min={form.issueDate}
            value={form.dueDate}
            onChange={(event) => update("dueDate", event.target.value)}
            aria-invalid={Boolean(error("dueDate"))}
          />
          {error("dueDate") && <small className="field-error">{error("dueDate")}</small>}
        </label>
        <label className="field">
          <span>Amount (test ZEC)</span>
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
        <fieldset className="field field--wide vault-field" aria-invalid={Boolean(error("vaultId"))}>
          <legend>Purpose vault</legend>
          <div className="vault-options">
            {eligibleVaults.map((vault) => (
              <button
                data-field="vaultId"
                type="button"
                key={vault.id}
                aria-pressed={form.vaultId === vault.id}
                className={form.vaultId === vault.id ? "is-active" : ""}
                onClick={() => update("vaultId", vault.id)}
              >
                <i aria-hidden="true" style={{ background: vault.color }} />
                <span>
                  <b>{vault.name}</b>
                  <small>{vault.purpose}</small>
                </span>
                <em>{receiverCapabilityLabel(vault.pool)}</em>
              </button>
            ))}
          </div>
          {!eligibleVaults.length && <small className="field-error">No active purpose vaults are available.</small>}
          {error("vaultId") && <small className="field-error">{error("vaultId")}</small>}
        </fieldset>
        <div className="form-note field--wide">
          <Shield aria-hidden="true" size={18} />
          <p>
            <b>The customer name is never written to the blockchain.</b>
            <span>The memo contains only the invoice reference and the first 12 characters of the document hash.</span>
          </p>
        </div>
        <div className="form-actions field--wide">
          <button type="button" className="button button--ghost" onClick={onClose} disabled={busy === "invoice"}>
            Cancel
          </button>
          <button className="button button--primary" disabled={busy !== null}>
            {busy === "invoice" ? <InlineSpinner /> : <FilePlus2 aria-hidden="true" size={17} />} Create invoice & QR
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InvoiceDetailModal({
  invoice,
  onClose,
  data,
}: {
  invoice: Invoice | null;
  onClose: () => void;
  data: ViewProps["data"];
}) {
  if (!invoice) return null;
  const vault = data.state.vaults.find((item) => item.id === invoice.vaultId)!;
  const uri = buildZip321Uri(invoice.receiveAddress, invoice.zatoshi, invoice.memoRef);
  const isOpen = ["pending", "overdue"].includes(invoice.status);
  const addressStillConfigured =
    data.state.mode === "demo" || (vault.addressSource === "env" && vault.address === invoice.receiveAddress);
  const canRequestPayment = isOpen && addressStillConfigured;
  const paymentTransaction = data.state.transactions.find(
    (transaction) => transaction.txid === invoice.paymentTxid || transaction.canonicalId === invoice.paymentCanonicalId,
  );
  const canonicalPayment =
    paymentTransaction?.source === "rpc" &&
    Boolean(paymentTransaction.observationHash) &&
    paymentTransaction.observationState !== "orphan-candidate" &&
    paymentTransaction.status === "confirmed" &&
    paymentTransaction.confirmations >= data.state.settings.minConfirmations;
  const liveWalletLabel =
    data.state.mode === "live" && data.node.safeTestnet && data.node.walletReachable && data.node.walletSynchronized;
  return (
    <Modal
      open={Boolean(invoice)}
      onClose={onClose}
      eyebrow={isOpen ? "SHIELDED COLLECTION" : "INVOICE PROOF"}
      title={invoice.number}
      size="large"
    >
      <div className="invoice-detail">
        <div className="invoice-detail__main">
          <div className="invoice-paper">
            <div className="invoice-paper__head">
              <div className="mini-logo">ZL</div>
              <div>
                <span>
                  ZECHLEDGER ACCOUNTING DOCUMENT · TESTNET /{" "}
                  {data.state.mode === "demo" ? "PRESENTATION" : liveWalletLabel ? "LIVE WALLET" : "LIVE LEDGER"}
                </span>
                <b>{invoice.issuerLegalName}</b>
              </div>
              <StatusBadge status={invoice.status} />
            </div>
            <div className="invoice-paper__client">
              <span>BILL TO</span>
              <h3>{invoice.client}</h3>
              <p>{invoice.title}</p>
            </div>
            <div className="invoice-paper__totals">
              <span>Amount due</span>
              <h2>
                {formatZec(invoice.zatoshi, 4)} <small>ZEC</small>
              </h2>
              <p>
                {formatTry(invoice.tryTotal)} · recorded rate {invoice.valuationRateTry.toLocaleString("en-US")} TRY/ZEC
                (configured static rate)
              </p>
            </div>
            <div className="invoice-paper__meta">
              <div>
                <span>Issued</span>
                <b>{new Date(invoice.issueDate).toLocaleDateString("en-US")}</b>
              </div>
              <div>
                <span>Due</span>
                <b>{new Date(invoice.dueDate).toLocaleDateString("en-US")}</b>
              </div>
              <div>
                <span>VAT</span>
                <b>{invoice.vatRate}%</b>
              </div>
            </div>
          </div>
          <div className="proof-box">
            <FileCheck2 aria-hidden="true" size={18} />
            <div>
              <span>Record metadata SHA-256</span>
              <HashText value={invoice.documentHash} chars={10} />
            </div>
            <CopyButton value={invoice.documentHash} compact />
          </div>
        </div>
        <aside className="payment-request">
          <span className="eyebrow">ZIP-321 PAYMENT REQUEST</span>
          {canRequestPayment ? (
            <>
              <div className="qr-frame">
                <QRCodeSVG
                  role="img"
                  aria-label={`${invoice.number} ZIP-321 payment QR code`}
                  value={uri}
                  size={168}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#0b1916"
                  marginSize={2}
                />
                <i className="qr-logo">Z</i>
              </div>
              <h3>{formatZec(invoice.zatoshi, 5)} test ZEC</h3>
              <p>Scan with a Zcash-compatible testnet wallet.</p>
              <div className="address-box">
                <span>RECIPIENT · {receiverCapabilityLabel(vault.pool).toUpperCase()}</span>
                <code>{maskAddress(invoice.receiveAddress, 18, 12)}</code>
                <CopyButton value={invoice.receiveAddress} compact />
              </div>
              <div className="memo-box">
                <span>ENCRYPTED MEMO CONTENT</span>
                <code>{invoice.memoRef}</code>
                <CopyButton value={invoice.memoRef} compact />
              </div>
              <CopyButton value={uri} label="Copy payment request" />
              {data.state.mode === "demo" && (
                <div className="demo-warning">
                  <QrCode aria-hidden="true" size={15} />
                  <span>
                    This testnet presentation address has a valid checksum; it does not belong to you and must not be
                    funded. Connect your own address to collect real payments.
                  </span>
                </div>
              )}
            </>
          ) : isOpen ? (
            <div className="paid-seal paid-seal--warning">
              <QrCode aria-hidden="true" size={34} />
              <b>QR LOCKED</b>
              <span>
                The invoice’s immutable recipient address no longer matches the current environment mapping. The QR code
                was not regenerated; secure reissuance or manual review is required.
              </span>
            </div>
          ) : invoice.status === "paid" ? (
            <>
              <div className="paid-seal">
                <Shield aria-hidden="true" size={34} />
                <b>COLLECTED IN THE LEDGER</b>
                <span>
                  {canonicalPayment
                    ? "Matched by an account-scoped wallet observation"
                    : "Local/demo record · not blockchain proof"}
                </span>
              </div>
              {invoice.paymentTxid && (
                <div className="address-box">
                  <span>TRANSACTION ID</span>
                  <HashText value={invoice.paymentTxid} chars={10} />
                  <CopyButton value={invoice.paymentTxid} compact />
                </div>
              )}
              <p className="subtle-copy">
                Double-entry record posted; the txid does not prove the parties, amount, or memo owner.
              </p>
            </>
          ) : (
            <div className="paid-seal paid-seal--warning">
              <FileCheck2 aria-hidden="true" size={34} />
              <b>LOCAL DRAFT</b>
              <span>The payment request is inactive; no wallet settlement or collection claim.</span>
            </div>
          )}
        </aside>
      </div>
    </Modal>
  );
}
