import type { Metadata } from "next";
import "./globals.css";

const TITLE = "Aether Foundry Desk — XRPL Testnet";
const DESCRIPTION =
  "Read-only XRPL Testnet desk for Aether Foundry. No wallets, no seeds.";

export const metadata: Metadata = {
  metadataBase: new URL("https://aether-foundry-desk.vercel.app"),
  title: TITLE,
  description: DESCRIPTION,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/brand/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/brand/apple-icon.png",
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Aether Foundry",
    images: [
      {
        url: "/brand/aether-foundry-logo.png",
        width: 1280,
        height: 720,
        alt: "Aether Foundry — Liberty ChainGuard",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/brand/aether-foundry-logo.png"],
  },
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
