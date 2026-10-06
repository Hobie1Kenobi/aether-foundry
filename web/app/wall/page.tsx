import { WallOfChange } from "@/components/wall-of-change";
import { loadDeskStatus } from "@/lib/load-desk-status";
import { buildWall } from "@/lib/wall";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Wall of Change — Aether Foundry Desk",
  description:
    "Curated wire of XRPL institutional primitives and named programs. The desk does not sign.",
};

export default async function WallPage() {
  let payload = null;
  try {
    const status = await loadDeskStatus().catch(() => null);
    payload = await buildWall({ status, fetch });
  } catch {
    payload = null;
  }

  return (
    <main>
      <header className="hero">
        <div className="hero-topline">
          <div className="eyebrow">
            <span className="signal" /> AETHER FOUNDRY / PUBLIC DESK
          </div>
          <div className="status-group">
            <a href="/">Desk</a>
          </div>
        </div>
        <nav className="hero-links" aria-label="Desk resources">
          <a href="/">Desk</a>
          <a href="/demo">Demo</a>
          <a href="/net">Net chat</a>
          <a href="/api/wall">Wall JSON</a>
          <a href="/api/wall/rss.xml">RSS</a>
          <a href="/.well-known/xrp-ledger.toml">XRPL.toml ↗</a>
        </nav>
      </header>
      <WallOfChange payload={payload} variant="page" />
      <footer style={{ marginTop: "2rem" }} className="muted">
        Aether Foundry · XRPL Testnet desk · does not sign ·{" "}
        <a href="/">Desk</a> · <a href="/demo">Demo</a> · <a href="/net">Net chat</a>
      </footer>
    </main>
  );
}
