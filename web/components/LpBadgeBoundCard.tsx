import { EXPLORER_ACCOUNT, EXPLORER_TX, LP_BADGE_BOUND } from "@/lib/xrpl-public";

function filled(value: string): boolean {
  return value.trim().length > 0;
}

export function LpBadgeBoundCard() {
  const hashes = [
    ["Stranger fail", LP_BADGE_BOUND.hashes.strangerFail],
    ["Holder bare fail", LP_BADGE_BOUND.hashes.holderBareFail],
    ["Holder pass", LP_BADGE_BOUND.hashes.holderPass],
    ["Revoked fail", LP_BADGE_BOUND.hashes.holderRevokedFail],
  ].filter((row): row is [string, string] => filled(row[1]));
  const accounts = [
    ["Issuer", LP_BADGE_BOUND.issuer],
    ["Holder", LP_BADGE_BOUND.holder],
    ["Door", LP_BADGE_BOUND.door],
    ["Stranger", LP_BADGE_BOUND.stranger],
  ].filter((row): row is [string, string] => filled(row[1]));

  return (
    <section aria-labelledby="lp-badge-bound-title">
      <div className="section-heading">
        <div>
          <p className="kicker">XRPL TESTNET // CREDENTIAL DOOR</p>
          <h2 id="lp-badge-bound-title" className="section-title">
            LP Badge bound
          </h2>
        </div>
        <span className="section-meta">display only · DepositPreauth</span>
      </div>
      <article className="card">
        <p className="muted">
          Guild-door payments require an accepted {LP_BADGE_BOUND.credentialType}{" "}
          credential. The v0 NFT is not the gate. This card does not submit
          transactions.
        </p>
        <ul className="clean hash-list">
          <li>
            <span className="list-label">Amendment</span>
            <span className="mono">{LP_BADGE_BOUND.amendment}</span>
          </li>
          <li>
            <span className="list-label">Hooks on this net</span>
            <span className="mono">
              {LP_BADGE_BOUND.hooksOnXrplTestnet ? "yes" : "no"}
            </span>
          </li>
          {filled(LP_BADGE_BOUND.credentialId) ? (
            <li>
              <span className="list-label">Credential</span>
              <span className="mono">{LP_BADGE_BOUND.credentialId}</span>
            </li>
          ) : null}
          {accounts.map(([label, address]) => (
            <li key={label}>
              <span className="list-label">{label}</span>
              <a
                className="mono truncate-link"
                href={EXPLORER_ACCOUNT(address)}
              >
                {address}
              </a>
            </li>
          ))}
          {hashes.map(([label, hash]) => (
            <li key={hash}>
              <span className="list-label">{label}</span>
              <a className="mono truncate-link" href={EXPLORER_TX(hash)}>
                {hash}
              </a>
            </li>
          ))}
        </ul>
        <p className="muted">
          <a href={LP_BADGE_BOUND.readme}>Machine README</a>
        </p>
      </article>
    </section>
  );
}
