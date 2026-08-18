"use client";

import {
  Activity,
  BookOpen,
  FileText,
  LogOut,
  FlaskConical,
  LayoutDashboard,
  Menu,
  ReceiptText,
  ScanSearch,
  ShieldCheck,
  X,
} from "lucide-react";
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { StateResponse } from "@/lib/types";
import { DashboardView } from "@/components/dashboard-view";
import { InvoicesView } from "@/components/invoices-view";
import { TransactionsView } from "@/components/transactions-view";
import { ExpensesView } from "@/components/expenses-view";
import { LedgerView } from "@/components/ledger-view";
import { AuditView } from "@/components/audit-view";
import { TestnetView } from "@/components/testnet-view";

export type ViewKey = "dashboard" | "invoices" | "transactions" | "expenses" | "ledger" | "audit" | "testnet";

type Toast = { id: number; message: string; tone: "success" | "error" | "info" };

const navigation: Array<{
  id: ViewKey;
  label: string;
  shortLabel: string;
  icon: typeof LayoutDashboard;
  group?: string;
}> = [
  { id: "dashboard", label: "Overview", shortLabel: "Overview", icon: LayoutDashboard },
  { id: "invoices", label: "Receivables", shortLabel: "Receivables", icon: FileText },
  { id: "expenses", label: "Payments", shortLabel: "Payments", icon: ReceiptText },
  { id: "transactions", label: "Reconciliation", shortLabel: "Reconcile", icon: Activity },
  { id: "ledger", label: "Ledger", shortLabel: "Ledger", icon: BookOpen, group: "ACCOUNTING" },
  { id: "audit", label: "Evidence", shortLabel: "Evidence", icon: ScanSearch },
  { id: "testnet", label: "Network & wallet", shortLabel: "Network", icon: FlaskConical, group: "SYSTEM" },
];

const titles: Record<ViewKey, { title: string; subtitle: string }> = {
  dashboard: { title: "Overview", subtitle: "Exceptions, financial position, and evidence trail" },
  invoices: { title: "Receivables", subtitle: "Receivables aging and ZIP-321 records" },
  expenses: { title: "Payments", subtitle: "Expense records and controlled submission queue" },
  transactions: { title: "Reconciliation", subtitle: "Wallet observations, record matching, and evidence" },
  ledger: { title: "Ledger", subtitle: "Double-entry journal and hash chain" },
  audit: { title: "Evidence", subtitle: "Signed, scoped, and independently verifiable evidence" },
  testnet: { title: "Network & wallet", subtitle: "Zebra, Zallet, and broadcast safety interlocks" },
};

export function AppShell() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [view, setView] = useState<ViewKey>("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [loginToken, setLoginToken] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wasMobileOpen = useRef(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (response.status === 401) {
        setAuthRequired(true);
        setData(null);
        setError(null);
        return false;
      }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load application data.");
      setData(payload as StateResponse);
      setAuthRequired(false);
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection error");
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const applyHash = () => {
      const requested = window.location.hash.slice(1) as ViewKey;
      if (navigation.some((item) => item.id === requested)) setView(requested);
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    window.addEventListener("popstate", applyHash);
    return () => {
      window.removeEventListener("hashchange", applyHash);
      window.removeEventListener("popstate", applyHash);
    };
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => {
      setIsMobile(query.matches);
      if (!query.matches) setMobileOpen(false);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.title = `${titles[view].title} · ZechLedger`;
  }, [view]);
  useEffect(() => {
    if (!isMobile) return;
    if (mobileOpen) {
      wasMobileOpen.current = true;
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      window.requestAnimationFrame(() =>
        sidebarRef.current?.querySelector<HTMLButtonElement>(".sidebar__close")?.focus(),
      );
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") setMobileOpen(false);
      };
      document.addEventListener("keydown", closeOnEscape);
      return () => {
        document.body.style.overflow = previousOverflow;
        document.removeEventListener("keydown", closeOnEscape);
      };
    }
    if (wasMobileOpen.current) {
      wasMobileOpen.current = false;
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }
  }, [isMobile, mobileOpen]);

  const notify = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    if (tone !== "error") {
      window.setTimeout(
        () => setToasts((current) => current.filter((toast) => toast.id !== id)),
        tone === "info" ? 6000 : 3500,
      );
    }
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pendingOperationSignature = data
    ? [
        ...data.state.transactions
          .filter((tx) => tx.status === "pending" && !tx.operationOutcome && tx.txid.startsWith("opid:"))
          .map((tx) => tx.txid.slice(5)),
        ...data.state.auditCapsules
          .filter((capsule) => capsule.status === "pending" && capsule.operationId && !capsule.operationComplete)
          .map((capsule) => capsule.operationId!),
      ]
        .filter((id, index, all) => all.indexOf(id) === index)
        .join(",")
    : "";

  useEffect(() => {
    if (!data?.node.walletReachable || !pendingOperationSignature) return;
    const operationIds = pendingOperationSignature.split(",");
    let stopped = false;
    async function poll() {
      let terminal = false;
      let retryBlocked = false;
      for (const operationId of operationIds) {
        try {
          const response = await fetch(`/api/zcash/operation/${operationId}`, { cache: "no-store" });
          const payload = await response.json();
          if (
            (response.ok && ["success", "failed", "cancelled"].includes(payload.operation?.status)) ||
            (!response.ok && payload.status === "unknown" && payload.retryBlocked === true)
          )
            terminal = true;
          if (payload.retryBlocked) retryBlocked = true;
        } catch {}
      }
      if (terminal && !stopped) {
        const refreshed = await refresh();
        notify(
          refreshed
            ? retryBlocked
              ? "The operation outcome is uncertain; retrying is blocked while definitive wallet reconciliation is pending."
              : "Testnet operation status updated."
            : "The operation completed, but the latest view could not be loaded. Try again.",
          refreshed ? "info" : "error",
        );
      }
    }
    const first = window.setTimeout(() => void poll(), 1200);
    const interval = window.setInterval(() => void poll(), 5000);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [data?.node.walletReachable, pendingOperationSignature, refresh, notify]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoginBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: loginToken }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Sign-in failed.");
      setLoginToken("");
      setAuthRequired(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    if (busy) return;
    setBusy("logout");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not sign out.");
      setData(null);
      setAuthRequired(true);
      setView("dashboard");
      window.history.replaceState(null, "", window.location.pathname);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Could not sign out.", "error");
    } finally {
      setBusy(null);
    }
  }

  function navigate(next: ViewKey) {
    if (next !== view) {
      setView(next);
      window.history.pushState(null, "", `#${next}`);
    }
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
    window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  }

  function trapDrawerFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (!isMobile || !mobileOpen || event.key !== "Tab") return;
    const controls = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((element) => element.offsetParent !== null);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <div className="brand-mark brand-mark--large" aria-hidden="true">
            <span>Z</span>
            <span>L</span>
          </div>
          <span className="eyebrow eyebrow--green">ADMINISTRATOR SESSION</span>
          <h1>Administrator session</h1>
          <p>Live wallet and decrypted accounting data are available only in an administrator session.</p>
          <form onSubmit={login}>
            <label>
              <span>Administrator access token</span>
              <input
                type="password"
                value={loginToken}
                onChange={(event) => setLoginToken(event.target.value)}
                minLength={16}
                required
                autoFocus
                autoComplete="current-password"
                placeholder="ZECHLEDGER_ADMIN_TOKEN"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "login-error" : undefined}
              />
            </label>
            {error && (
              <div className="auth-error" id="login-error" role="alert">
                {error}
              </div>
            )}
            <button className="button button--primary button--wide" disabled={loginBusy}>
              {loginBusy ? "Verifying…" : "Sign in"}
            </button>
          </form>
          <div className="auth-assurance">
            <ShieldCheck aria-hidden="true" size={17} />
            <span>HttpOnly · SameSite=Strict · Origin/CSRF checks</span>
          </div>
        </section>
      </main>
    );
  }
  if (error && !data) {
    return (
      <main className="fatal-screen">
        <div className="brand-mark brand-mark--large" aria-hidden="true">
          <span>Z</span>
          <span>L</span>
        </div>
        <h1>Could not open the ledger</h1>
        <p role="alert">{error}</p>
        <button className="button button--primary" onClick={() => void refresh()}>
          Try again
        </button>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="boot-screen" aria-busy="true">
        <div className="brand-mark brand-mark--large" aria-hidden="true">
          <span>Z</span>
          <span>L</span>
        </div>
        <div className="boot-line" aria-hidden="true">
          <span />
        </div>
        <p role="status" aria-live="polite">
          Loading records…
        </p>
      </main>
    );
  }

  const actions = { refresh, notify, busy, setBusy };
  const currentTitle = titles[view];
  const nodeLive = data.node.reachable && data.node.safeTestnet;
  const operatorInitials =
    data.state.settings.operatorName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase("en-US"))
      .join("") || "ZL";

  return (
    <div className="app-frame">
      <a
        className="skip-link"
        href="#main-content"
        aria-hidden={isMobile && mobileOpen ? true : undefined}
        inert={isMobile && mobileOpen ? true : undefined}
      >
        Skip to main content
      </a>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close menu"
        className={`mobile-scrim ${mobileOpen ? "is-open" : ""}`}
        onClick={() => setMobileOpen(false)}
      />
      <aside
        ref={sidebarRef}
        id="primary-navigation"
        aria-label="Main menu"
        aria-hidden={isMobile ? !mobileOpen : undefined}
        inert={isMobile && !mobileOpen ? true : undefined}
        onKeyDown={trapDrawerFocus}
        className={`sidebar ${mobileOpen ? "is-open" : ""}`}
      >
        <div className="sidebar__brand">
          <div className="brand-mark" aria-hidden="true">
            <span>Z</span>
            <span>L</span>
          </div>
          <div>
            <strong>ZechLedger</strong>
            <small>ZCASH TESTNET ACCOUNTING</small>
          </div>
          <button className="sidebar__close" onClick={() => setMobileOpen(false)} aria-label="Close menu">
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <nav className="sidebar__nav" aria-label="Primary sections">
          {navigation.map((item, index) => {
            const previousGroup = index > 0 ? navigation[index - 1].group : undefined;
            return (
              <div key={item.id}>
                {item.group && item.group !== previousGroup && <span className="nav-group">{item.group}</span>}
                <button
                  aria-current={view === item.id ? "page" : undefined}
                  className={view === item.id ? "is-active" : ""}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon aria-hidden="true" size={18} />
                  <span>{item.label}</span>
                  {item.id === "transactions" && data.metrics.pendingTransactions > 0 && (
                    <em aria-label={`${data.metrics.pendingTransactions} pending transactions`}>
                      {data.metrics.pendingTransactions}
                    </em>
                  )}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="sidebar__spacer" />
        <button
          className="company-switcher"
          onClick={() => void logout()}
          disabled={busy !== null}
          aria-label={`Sign out of ${data.state.settings.operatorName}'s administrator session`}
        >
          <div className="company-avatar" aria-hidden="true">
            {operatorInitials}
          </div>
          <div>
            <b>{data.state.settings.operatorName} · Administrator</b>
            <span>{busy === "logout" ? "Signing out…" : `${data.state.company.name} · Sign out`}</span>
          </div>
          <LogOut aria-hidden="true" size={15} />
        </button>
      </aside>

      <main
        className="workspace"
        id="main-content"
        aria-hidden={isMobile && mobileOpen ? true : undefined}
        inert={isMobile && mobileOpen ? true : undefined}
      >
        <header className="topbar">
          <div className="topbar__title">
            <button
              ref={menuButtonRef}
              className="menu-button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              aria-expanded={mobileOpen}
              aria-controls="primary-navigation"
            >
              <Menu aria-hidden="true" size={21} />
            </button>
            <div>
              <p>{currentTitle.subtitle}</p>
              <h1 ref={headingRef} tabIndex={-1}>
                {currentTitle.title}
              </h1>
            </div>
          </div>
          <div className="topbar__actions">
            <button className="chain-chip" onClick={() => navigate("testnet")}>
              <span
                aria-hidden="true"
                className={
                  data.state.mode === "live" && data.node.safeTestnet && data.node.walletSynchronized
                    ? "pulse-dot"
                    : "demo-dot"
                }
              />
              <span className="chain-chip__label">
                {data.state.mode === "demo"
                  ? "TESTNET · DEMO DATA"
                  : !data.node.safeTestnet
                    ? data.node.reachable || data.node.walletReachable
                      ? "WRONG / UNVERIFIED NETWORK"
                      : "NO WALLET OBSERVATION"
                    : data.node.walletSynchronized
                      ? "TESTNET · WALLET SYNCED"
                      : data.node.walletReachable
                        ? "TESTNET · WALLET RPC REACHABLE"
                        : nodeLive
                          ? "TESTNET · READ-ONLY"
                          : "NO WALLET OBSERVATION"}
              </span>
            </button>
            <div
              className="topbar-avatar"
              role="img"
              aria-label={`${data.state.settings.operatorName}, administrator`}
              title={data.state.settings.operatorName}
            >
              {operatorInitials}
            </div>
          </div>
        </header>

        <div className="workspace__content">
          {error && (
            <div className="workspace-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void refresh()}>
                Try again
              </button>
            </div>
          )}
          {view === "dashboard" && <DashboardView data={data} {...actions} setView={navigate} />}
          {view === "invoices" && <InvoicesView data={data} {...actions} />}
          {view === "transactions" && <TransactionsView data={data} {...actions} />}
          {view === "expenses" && <ExpensesView data={data} {...actions} />}
          {view === "ledger" && <LedgerView data={data} {...actions} />}
          {view === "audit" && <AuditView data={data} {...actions} />}
          {view === "testnet" && <TestnetView data={data} {...actions} />}
        </div>
      </main>

      <nav
        className="mobile-nav"
        aria-label="Mobile sections"
        aria-hidden={isMobile && mobileOpen ? true : undefined}
        inert={isMobile && mobileOpen ? true : undefined}
      >
        {navigation.slice(0, 5).map((item) => (
          <button
            key={item.id}
            aria-label={item.label}
            aria-current={view === item.id ? "page" : undefined}
            className={view === item.id ? "is-active" : ""}
            onClick={() => navigate(item.id)}
          >
            <item.icon aria-hidden="true" size={19} />
            <span>{item.shortLabel}</span>
          </button>
        ))}
      </nav>

      <div className="toast-stack" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            role={toast.tone === "error" ? "alert" : "status"}
            key={toast.id}
            className={`toast toast--${toast.tone}`}
          >
            <span aria-hidden="true">{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}</span>
            <p>{toast.message}</p>
            <button type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification">
              <X aria-hidden="true" size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
