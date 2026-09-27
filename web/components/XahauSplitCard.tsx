import { XAHAU_W7 } from "@/lib/xrpl-public";

function xahauAccount(address: string): string {
  return `https://xahau-testnet.xrpl.org/accounts/${address}`;
}

function xahauTx(hash: string): string {
  return `https://xahau-testnet.xrpl.org/transactions/${hash}`;
}

export function XahauSplitCard() {
  return (
    <section aria-labelledby="xahau-split-title">
      <div className="section-heading">
        <div>
          <p className="kicker">XAHAU TESTNET // HOOK</p>
          <h2 id="xahau-split-title" className="section-title">
            W7 split treasury
          </h2>
        </div>
        <span className="section-meta">display only · not XRPL Testnet</span>
      </div>
      <article className="card">
        <p className="muted">
          Incoming native payments to W7 are split 40 / 25 / 20 / 10 / remainder
          by a Hook on {XAHAU_W7.ws}. This card does not submit transactions.
        </p>
        <ul className="clean hash-list">
          <li>
            <span className="list-label">W7</span>
            <a className="mono truncate-link" href={xahauAccount(XAHAU_W7.address)}>
              {XAHAU_W7.address}
            </a>
          </li>
          <li>
            <span className="list-label">HookHash</span>
            <span className="mono">{XAHAU_W7.hookHash}</span>
          </li>
          <li>
            <span className="list-label">SetHook</span>
            <a className="mono truncate-link" href={xahauTx(XAHAU_W7.setHookHash)}>
              {XAHAU_W7.setHookHash}
            </a>
          </li>
          <li>
            <span className="list-label">Trial</span>
            <a className="mono truncate-link" href={xahauTx(XAHAU_W7.trialHash)}>
              {XAHAU_W7.trialHash}
            </a>
          </li>
          {XAHAU_W7.destinations.map((row) => (
            <li key={row.role}>
              <span className="list-label">{row.role}</span>
              <a className="mono truncate-link" href={xahauAccount(row.address)}>
                {row.address}
              </a>
            </li>
          ))}
        </ul>
      </article>
    </section>
  );
}
