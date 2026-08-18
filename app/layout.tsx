import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./folio.css";

export const metadata: Metadata = {
  title: "ZechLedger · Shielded Accounting",
  description: "Privacy-preserving double-entry accounting and collections on Zcash Testnet",
  applicationName: "ZechLedger",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/zechledger-mark.svg", apple: "/zechledger-mark.svg" },
};

export const viewport: Viewport = {
  themeColor: "#16231e",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
