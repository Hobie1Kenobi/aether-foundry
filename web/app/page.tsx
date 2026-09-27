import { DeskCards } from "@/components/DeskCards";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DeskPage() {
  return (
    <main>
      <DeskCards />
      <footer style={{ marginTop: "2rem" }} className="muted">
        Aether Foundry · XRPL Testnet desk · does not sign · x402 pay-to W3
      </footer>
    </main>
  );
}
