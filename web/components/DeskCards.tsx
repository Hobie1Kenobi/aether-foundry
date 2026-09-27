import {
  EXPLORER_ACCOUNT,
  EXPLORER_TX,
  MACHINES,
  NETWORK_LABEL,
  NFT_TAXON,
  WALLETS,
  XRPL_WS,
} from "@/lib/xrpl-public";
import {
  fetchAccountInfo,
  fetchAccountNfts,
  fetchAmmInfo,
  fetchBookOffers,
} from "@/lib/xrpl-read";

function HashList({
  entries,
}: {
  entries: Array<[string, string]>;
}) {
  return (
    <ul className="clean">
      {entries.map(([label, hash]) => (
        <li key={hash}>
          <span className="muted">{label}</span>
          <br />
          <a className="mono" href={EXPLORER_TX(hash)} target="_blank" rel="noreferrer">
            {hash}
          </a>
        </li>
      ))}
    </ul>
  );
}

export async function DeskCards() {
  const coreAccounts = [
    WALLETS.W0,
    WALLETS.W1,
    WALLETS.W2,
    WALLETS.AMM,
    WALLETS.STRANGER,
  ];

  const [accounts, amm, books, nftsW2, nftsStranger, nftsBuyer] =
    await Promise.all([
      Promise.all(
        coreAccounts.map((w) => fetchAccountInfo(w.address, `${w.id} ${w.role}`))
      ),
      fetchAmmInfo(),
      fetchBookOffers(),
      fetchAccountNfts(WALLETS.W2.address, "W2 ATELIER"),
      fetchAccountNfts(WALLETS.STRANGER.address, "STRANGER"),
      fetchAccountNfts(WALLETS.BUYER.address, "BUYER"),
    ]);

  const m1 = MACHINES["work-ticket-escrow"];
  const m2 = MACHINES["drip-pass"];
  const m3 = MACHINES["walk-in-window"];

  return (
    <>
      <header className="hero">
        <div>
          <span className="badge">{NETWORK_LABEL}</span>
          <span className="badge warn">read-only · no seeds</span>
        </div>
        <h1>Aether Foundry Desk</h1>
        <p className="muted">
          Public NAV-capable reads against XRPL Testnet. Addresses from{" "}
          <code>corp/wallets.md</code>. WS: <code className="mono">{XRPL_WS}</code>
        </p>
        <p className="muted">
          Toml:{" "}
          <a href="/.well-known/xrp-ledger.toml">/.well-known/xrp-ledger.toml</a>{" "}
          · Repo:{" "}
          <a
            href="https://github.com/Hobie1Kenobi/aether-foundry"
            target="_blank"
            rel="noreferrer"
          >
            Hobie1Kenobi/aether-foundry
          </a>
        </p>
      </header>

      <div className="callout">
        <strong>STRANGER walk-in</strong>
        <p className="muted" style={{ margin: "0.4rem 0" }}>
          Test actor{" "}
          <a
            href={EXPLORER_ACCOUNT(WALLETS.STRANGER.address)}
            target="_blank"
            rel="noreferrer"
          >
            {WALLETS.STRANGER.address}
          </a>{" "}
          accepted Walk-In NFT (taxon {NFT_TAXON}).
        </p>
        <p className="mono" style={{ margin: 0 }}>
          Accept:{" "}
          <a
            href={EXPLORER_TX(m3.hashes.strangerAccept)}
            target="_blank"
            rel="noreferrer"
          >
            {m3.hashes.strangerAccept}
          </a>
        </p>
      </div>

      <h2 className="section-title">Accounts (account_info)</h2>
      <div className="grid">
        {accounts.map((a) => (
          <article className="card" key={a.address}>
            <h3>{a.role}</h3>
            <dl className="kv">
              <dt>address</dt>
              <dd>
                <a href={EXPLORER_ACCOUNT(a.address)} target="_blank" rel="noreferrer">
                  {a.address}
                </a>
              </dd>
              <dt>balance</dt>
              <dd>{a.balanceXrp != null ? `${a.balanceXrp} XRP` : "—"}</dd>
              <dt>sequence</dt>
              <dd>{a.sequence ?? "—"}</dd>
            </dl>
            {a.error ? <p className="error">{a.error}</p> : null}
          </article>
        ))}
      </div>

      <h2 className="section-title">AMM (amm_info) · Books (book_offers)</h2>
      <div className="grid">
        <article className="card">
          <h3>AMM AETH/XRP</h3>
          <dl className="kv">
            <dt>account</dt>
            <dd>
              <a
                href={EXPLORER_ACCOUNT(amm.account)}
                target="_blank"
                rel="noreferrer"
              >
                {amm.account}
              </a>
            </dd>
            <dt>fee</dt>
            <dd>{amm.tradingFee ?? "—"}</dd>
            <dt>amount</dt>
            <dd>{JSON.stringify(amm.amount ?? null)}</dd>
            <dt>amount2</dt>
            <dd>{JSON.stringify(amm.amount2 ?? null)}</dd>
          </dl>
          {amm.error ? <p className="error">{amm.error}</p> : null}
        </article>
        <article className="card">
          <h3>{books.buyAeth.side}</h3>
          {books.buyAeth.error ? (
            <p className="error">{books.buyAeth.error}</p>
          ) : (
            <ul className="clean">
              {books.buyAeth.offers.length === 0 ? (
                <li className="muted">no offers</li>
              ) : (
                books.buyAeth.offers.map((o, i) => (
                  <li key={i} className="mono">
                    {o.account.slice(0, 8)}… pays {JSON.stringify(o.takerPays)} →{" "}
                    {JSON.stringify(o.takerGets)}
                  </li>
                ))
              )}
            </ul>
          )}
        </article>
        <article className="card">
          <h3>{books.sellAeth.side}</h3>
          {books.sellAeth.error ? (
            <p className="error">{books.sellAeth.error}</p>
          ) : (
            <ul className="clean">
              {books.sellAeth.offers.length === 0 ? (
                <li className="muted">no offers</li>
              ) : (
                books.sellAeth.offers.map((o, i) => (
                  <li key={i} className="mono">
                    {o.account.slice(0, 8)}… pays {JSON.stringify(o.takerPays)} →{" "}
                    {JSON.stringify(o.takerGets)}
                  </li>
                ))
              )}
            </ul>
          )}
        </article>
      </div>

      <h2 className="section-title">NFTs (account_nfts · taxon {NFT_TAXON})</h2>
      <div className="grid">
        {[nftsW2, nftsBuyer, nftsStranger].map((snap) => (
          <article className="card" key={snap.account}>
            <h3>{snap.role}</h3>
            <p className="mono muted">{snap.account}</p>
            {snap.error ? <p className="error">{snap.error}</p> : null}
            <ul className="clean">
              {snap.nfts.length === 0 ? (
                <li className="muted">none in taxon</li>
              ) : (
                snap.nfts.map((n) => (
                  <li key={n.nftokenID} className="mono">
                    <a
                      href={`https://testnet.xrpl.org/nft/${n.nftokenID}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {n.nftokenID}
                    </a>
                  </li>
                ))
              )}
            </ul>
          </article>
        ))}
      </div>

      <h2 className="section-title">Machines #1–#3 (RESULTS hashes)</h2>
      <div className="grid">
        <article className="card">
          <h3>{m1.label}</h3>
          <p className="muted">
            <a href={m1.readme} target="_blank" rel="noreferrer">
              README
            </a>
          </p>
          <HashList
            entries={[
              ["EscrowFinish", m1.hashes.escrowFinish],
              ["EscrowCancel", m1.hashes.escrowCancel],
              ["TokenEscrowFinish", m1.hashes.tokenEscrowFinish],
              ["TokenEscrowCancel", m1.hashes.tokenEscrowCancel],
            ]}
          />
        </article>
        <article className="card">
          <h3>{m2.label}</h3>
          <p className="muted">
            <a href={m2.readme} target="_blank" rel="noreferrer">
              README
            </a>
          </p>
          <p className="mono muted">channel {m2.channelId}</p>
          <HashList
            entries={[
              ["ChannelCreate", m2.hashes.channelCreate],
              ["Claim #1", m2.hashes.claim1],
              ["Claim #2", m2.hashes.claim2],
              ["Claim #3", m2.hashes.claim3],
              ["ChannelClose", m2.hashes.channelClose],
            ]}
          />
        </article>
        <article className="card">
          <h3>{m3.label}</h3>
          <p className="muted">
            <a href={m3.readme} target="_blank" rel="noreferrer">
              README
            </a>
          </p>
          <HashList
            entries={[
              ["STRANGER Accept", m3.hashes.strangerAccept],
              ["Path-pay ~50 AETH", m3.hashes.pathPay],
              ["TrustSet", m3.hashes.trustSet],
              ["CheckCash", m3.hashes.checkCash],
            ]}
          />
        </article>
      </div>
    </>
  );
}
