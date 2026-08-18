"use client";

import { Check, Copy, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  children,
  size = "medium",
  variant = "dialog",
  closeDisabled = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  size?: "small" | "medium" | "large";
  variant?: "dialog" | "drawer";
  closeDisabled?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnFocusKeyRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled]);

  useEffect(() => {
    if (!open) return;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    if (activeElement && !dialog?.contains(activeElement)) {
      returnFocusRef.current = activeElement;
      returnFocusKeyRef.current = activeElement.dataset.modalReturn ?? null;
    }
    const backdrop = dialog?.parentElement;
    const inerted = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));

    document.body.style.overflow = "hidden";
    const preferred = dialog?.querySelector<HTMLElement>("[data-modal-autofocus]");
    (preferred ?? dialog)?.focus({ preventScroll: true });
    for (const item of inerted) {
      item.element.inert = true;
      item.element.setAttribute("aria-hidden", "true");
    }

    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!closeDisabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => element.offsetParent !== null && !element.hasAttribute("disabled"),
      );
      if (!controls.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === dialogRef.current ||
          document.activeElement === first ||
          !dialogRef.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialogRef.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = previousOverflow;
      for (const item of inerted) {
        item.element.inert = item.inert;
        if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden");
        else item.element.setAttribute("aria-hidden", item.ariaHidden);
      }
      window.requestAnimationFrame(() => {
        if (dialog?.isConnected) return;
        const isVisibleTarget = (element: HTMLElement | null): element is HTMLElement =>
          Boolean(
            element?.isConnected &&
            element.getClientRects().length > 0 &&
            !element.closest("[inert]") &&
            !element.hasAttribute("disabled"),
          );
        const returnTarget = returnFocusRef.current;
        const returnKey = returnFocusKeyRef.current;
        const equivalent = returnKey
          ? [...document.querySelectorAll<HTMLElement>("[data-modal-return]")].find(
              (element) => element.dataset.modalReturn === returnKey && isVisibleTarget(element),
            )
          : null;
        const fallback = document.querySelector<HTMLElement>('h1[tabindex="-1"]');
        const target = isVisibleTarget(returnTarget)
          ? returnTarget
          : isVisibleTarget(equivalent ?? null)
            ? equivalent
            : isVisibleTarget(fallback)
              ? fallback
              : null;
        target?.focus({ preventScroll: true });
        returnFocusRef.current = null;
        returnFocusKeyRef.current = null;
      });
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className={`modal-backdrop modal-backdrop--${variant}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closeDisabled) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`modal modal--${size} modal--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal__header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close" disabled={closeDisabled}>
            <X aria-hidden="true" size={19} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

export function CopyButton({
  value,
  label = "Copy",
  compact = false,
}: {
  value: string;
  label?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setFailed(true);
      window.setTimeout(() => setFailed(false), 3000);
    }
  }
  const currentLabel = failed ? "Copy failed" : copied ? "Copied" : label;
  return (
    <button
      className={compact ? "copy-button copy-button--compact" : "copy-button"}
      onClick={copy}
      type="button"
      aria-live="polite"
    >
      {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />} {currentLabel}
    </button>
  );
}

const labels: Record<string, string> = {
  paid: "Paid",
  pending: "Pending",
  overdue: "Overdue",
  draft: "Draft",
  confirmed: "Confirmed",
  failed: "Failed",
  replay: "Demo record",
  approved: "Single-admin payment queue",
  posted: "Posted",
  local: "Local digest",
  anchored: "Signed wallet observation",
  active: "Active",
  rotating: "Rotating",
  closed: "Closed",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`status status--${status}`}>
      <i aria-hidden="true" />
      {label ?? labels[status] ?? status}
    </span>
  );
}

export function HashText({ value, chars = 8 }: { value: string; chars?: number }) {
  return (
    <code className="hash-text" title={value}>
      {value.slice(0, chars)}…{value.slice(-chars)}
    </code>
  );
}

export function InlineSpinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}
