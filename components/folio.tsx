"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { accountingDate } from "@/lib/accounting-date";

export function useAccountingAsOf() {
  const [asOf, setAsOf] = useState(accountingDate);

  useEffect(() => {
    const update = () => setAsOf(accountingDate());
    const interval = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", update);
    };
  }, []);

  return asOf;
}

export function useCompactReviewLayout() {
  const [compact, setCompact] = useState(false);
  const pendingFocusKey = useRef<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 680px)");
    const update = () => {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (active?.closest(".data-table-wrap, .review-task-list")) {
        pendingFocusKey.current = active.dataset.modalReturn ?? "__view-heading__";
      }
      setCompact(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const key = pendingFocusKey.current;
    if (!key) return;
    pendingFocusKey.current = null;
    const target =
      key === "__view-heading__"
        ? document.querySelector<HTMLElement>('h1[tabindex="-1"]')
        : [...document.querySelectorAll<HTMLElement>("[data-modal-return]")].find(
            (element) => element.dataset.modalReturn === key && element.getClientRects().length > 0,
          );
    target?.focus({ preventScroll: true });
  }, [compact]);

  return compact;
}

export function FolioView({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`view-stack folio-view ${className}`.trim()}>{children}</div>;
}

export function FolioPageHeader({
  overline,
  title,
  description,
  actions,
  aside,
  className = "",
}: {
  overline: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`folio-page-header ${className}`.trim()}>
      <div className="folio-page-header__copy">
        <span className="folio-overline">{overline}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {aside && <div className="folio-page-header__aside">{aside}</div>}
      {actions && <div className="folio-page-header__actions">{actions}</div>}
    </header>
  );
}
