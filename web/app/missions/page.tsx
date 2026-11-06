import { missionFeed } from "@/lib/missions-public";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Missions — Aether Foundry Desk",
  description: "Read-only Testnet mission feed. Authorized caps are not live spend. The desk does not sign.",
};

export default function MissionsPage() {
  const feed = missionFeed();
  return (
    <main>
      <header className="hero">
        <div className="hero-topline">
          <div className="eyebrow">
            <span className="signal" /> AETHER FOUNDRY / MISSIONS
          </div>
          <div className="status-group">
            <span className="badge">XRPL Testnet</span>
            <span className="badge warn">read-only</span>
          </div>
        </div>
        <div className="hero-copy">
          <div>
            <p className="kicker">GOAL TO EVALUATE // NO SIGNING</p>
            <h1>Mission feed</h1>
            <p className="hero-description">{feed.note}</p>
          </div>
        </div>
        <nav className="hero-links" aria-label="Mission resources">
          <a href="/">Desk</a>
          <a href="/api/missions">Feed JSON</a>
          <a href="/api/missions/status">Status JSON</a>
        </nav>
      </header>
      <section className="account-grid">
        <article className="card">
          <h2>Authorized caps</h2>
          <dl className="kv">
            <dt>Per mission</dt>
            <dd>{feed.authorized_per_mission_xrp} XRP ({feed.authorized_per_mission_drops} drops)</dd>
            <dt>Per Chicago day</dt>
            <dd>
              {feed.authorized_daily_xrp} XRP ({feed.authorized_daily_drops} drops, {feed.timezone})
            </dd>
          </dl>
        </article>
        <article className="card">
          <h2>Enabled</h2>
          <dl className="kv">
            <dt>Spending</dt>
            <dd>{feed.spending_enabled ? "yes" : "no"}</dd>
            <dt>Signing</dt>
            <dd>{feed.signing_enabled ? "yes" : "no"}</dd>
          </dl>
        </article>
        <article className="card">
          <h2>Live spend</h2>
          <dl className="kv">
            <dt>Live XRP</dt>
            <dd>{feed.live_spend_xrp}</dd>
            <dt>Source health</dt>
            <dd>
              {feed.source}
              {feed.source_observed_at ? ` · ${feed.source_observed_at}` : " · no source timestamp"}
            </dd>
          </dl>
        </article>
      </section>
      <section>
        <h2>Missions</h2>
        {feed.missions.length === 0 ? (
          <p className="muted">No public mission rows in this snapshot. A blocked foreign-seller run stays on the operator ledger until a sanitized export is committed.</p>
        ) : (
          <ul className="clean">
            {feed.missions.map((mission) => (
              <li key={mission.id}>
                <a href={`/api/missions/${mission.id}`}>{mission.id}</a> {mission.status}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
