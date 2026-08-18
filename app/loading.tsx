export default function Loading() {
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
        Opening the ZechLedger ledger…
      </p>
    </main>
  );
}
