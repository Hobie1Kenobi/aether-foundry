import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aether Foundry Desk — XRPL Testnet",
  description:
    "Read-only XRPL Testnet desk for Aether Foundry. No wallets, no seeds.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
