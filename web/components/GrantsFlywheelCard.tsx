import { EXPLORER_ACCOUNT, GRANTS_FLYWHEEL } from "@/lib/xrpl-public";

export function GrantsFlywheelCard() {
  return (
    <section aria-labelledby="grants-flywheel-title">
      <div className="section-heading">
        <div>
          <p className="kicker">W6 // FLYWHEEL</p>
          <h2 id="grants-flywheel-title" className="section-title">
            Grants flywheel
          </h2>
        </div>
        <span className="section-meta">read-only · desk does not sign</span>
      </div>
      <article className="card">
        <p className="muted">
          W6 pays a small Testnet XRP grant to a counterparty who already used a
          Foundry artifact. Every address in the desk wallet list is excluded,
          including the labeled STRANGER wallet. This card does not submit a
          Payment.
        </p>
        <ul className="clean hash-list">
          <li>
            <span className="list-label">W6</span>
            <a
              className="mono truncate-link"
              href={EXPLORER_ACCOUNT(GRANTS_FLYWHEEL.payer)}
              target="_blank"
              rel="noreferrer"
            >
              {GRANTS_FLYWHEEL.payer}
            </a>
          </li>
          <li>
            <span className="list-label">Default</span>
            <span className="mono">{GRANTS_FLYWHEEL.defaultDrops} drops</span>
          </li>
          <li>
            <span className="list-label">Scan</span>
            <span className="mono">{GRANTS_FLYWHEEL.scanCommand}</span>
          </li>
          <li>
            <span className="list-label">Plan</span>
            <span className="mono">{GRANTS_FLYWHEEL.payCommand}</span>
          </li>
        </ul>
        <p className="storefront-links">
          <a href={GRANTS_FLYWHEEL.readme} target="_blank" rel="noreferrer">
            README
          </a>
          <a href={GRANTS_FLYWHEEL.runbook} target="_blank" rel="noreferrer">
            RUNBOOK
          </a>
        </p>
      </article>
    </section>
  );
}
