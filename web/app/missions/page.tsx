import { missionStatus } from "@/lib/missions-public";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Missions — Aether Foundry Desk",
  description: "Read-only mission status folded from the Foundry ledger when that ledger is on this server.",
};

export default async function MissionsPage() {
  const feed = await missionStatus();
  const live = feed.live_spend_drops == null ? "unknown" : feed.live_spend_drops;
  return (
    <main>
      <header className="hero">
        <div className="hero-topline">
          <div className="eyebrow">
            <span className="signal" /> AETHER FOUNDRY / MISSIONS
          </div>
          <div className="status-group">
            <span className="badge">XRPL Testnet</span>
            <span className="badge warn">{feed.stale ? "stale" : "fresh"}</span>
          </div>
        </div>
        <div className="hero-copy">
          <div>
            <p className="kicker">LEDGER FOLD // NO VISITOR COMMANDS</p>
            <h1>Mission status</h1>
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
            <dd>1 XRP ({feed.authorized_per_mission_drops} drops)</dd>
            <dt>Per Chicago day</dt>
            <dd>
              5 XRP ({feed.authorized_daily_drops} drops, {feed.timezone})
            </dd>
          </dl>
        </article>
        <article className="card">
          <h2>Enabled</h2>
          <dl className="kv">
            <dt>Class approved</dt>
            <dd>{feed.spending_enabled ? "yes" : "no"}</dd>
            <dt>Source of that flag</dt>
            <dd>{feed.spending_enabled_source}</dd>
            <dt>Signing on this server</dt>
            <dd>{feed.signing_enabled ? "yes" : "no"}</dd>
          </dl>
        </article>
        <article className="card">
          <h2>Live spend</h2>
          <dl className="kv">
            <dt>Live drops</dt>
            <dd>{live}</dd>
            <dt>Reserved this window</dt>
            <dd>{feed.reserved_drops == null ? "unknown" : feed.reserved_drops}</dd>
            <dt>Uncertain</dt>
            <dd>{feed.uncertain_drops == null ? "unknown" : feed.uncertain_drops}</dd>
            <dt>Source health</dt>
            <dd>
              {feed.source}
              {feed.source_observed_at ? ` · observed ${feed.source_observed_at}` : " · no source timestamp"}
              {feed.stale ? " · stale" : ""}
            </dd>
          </dl>
        </article>
      </section>
      <section>
        <h2>Missions in this snapshot</h2>
        <p className="muted">
          Class approval is not a running worker. Signing on this server is{" "}
          {feed.signing_enabled ? "yes" : "no"}. A row is complete only when its complete flag is true.
          This page does not show a live execution loop.
        </p>
        <ul>
          {(feed.missions || []).map((mission) => (
            <li key={mission.id}>
              <code>{mission.id}</code> {mission.status}
              {mission.code ? ` · ${mission.code}` : ""} · {mission.complete ? "complete" : "not complete"}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>How this page gets data</h2>
        <p className="muted">
          The desk process reads <code>events.jsonl</code> from <code>FOUNDRY_MISSION_LEDGER</code>, or from{" "}
          <code>lab/missions</code> beside the repo when this server is the Foundry box. It folds those events. It does
          not use a committed example document, and a missing ledger is unknown spend rather than a measured zero.
          On Vercel the same route resolves the current main commit and reads the sanitized snapshot{" "}
          <code>lab/missions/public-status.json</code> at that commit. Until the box publishes one, this page stays
          unavailable. The snapshot is not a second ledger.
        </p>
      </section>
    </main>
  );
}
