import { DeskCards } from "@/components/DeskCards";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DeskPage() {
  return (
    <main>
      <DeskCards />
      <footer style={{ marginTop: "2rem" }} className="muted">
        Aether Foundry · XRPL Testnet desk · does not sign · x402 pay-to W3 ·{" "}
        <a href="/demo">Demo</a> · <a href="/net">Net chat</a> ·{" "}
        <a href="/wall">Wall of Change</a>
      </footer>
    </main>
  );
}
