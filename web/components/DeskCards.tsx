import type { ReactNode } from "react";
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

function HashList({ entries }: { entries: Array<[string, string]> }) {
  return (
    <ul className="clean hash-list">
      {entries.map(([label, hash]) => (
        <li key={hash}>
          <span className="list-label">{label}</span>
          <a
            className="mono truncate-link"
            href={EXPLORER_TX(hash)}
            target="_blank"
            rel="noreferrer"
            title={hash}
          >
            {hash}
          </a>
        </li>
      ))}
    </ul>
  );
}

function ExternalLink({
  href,
  children,
  title,
}: {
  href: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" title={title}>
      {children}
      <span aria-hidden="true" className="external-mark">
        ↗
      </span>
    </a>
  );
}

function MachineCard({
  number,
  title,
  readme,
  channelId,
  entries,
}: {
  number: number;
  title: string;
  readme: string;
  channelId?: string;
  entries: Array<[string, string]>;
}) {
  return (
    <article className="card machine-card">
      <div className="machine-top">
        <span className="machine-number">#{number}</span>
        <span className="status-chip live-chip">RECORDED</span>
      </div>
      <h3>{title}</h3>
      <ExternalLink href={readme}>
        <span className="muted">Machine README</span>
      </ExternalLink>
      {channelId ? (
        <p className="mono muted channel-id" title={channelId}>
          channel {channelId}
        </p>
      ) : null}
      <HashList entries={entries} />
    </article>
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

  const onlineAccounts = accounts.filter((account) => account.balanceXrp != null);
  const totalDrops = onlineAccounts.reduce(
    (sum, account) => sum + Math.round(Number(account.balanceXrp) * 1_000_000),
    0
  );
  const totalXrp =
    onlineAccounts.length === 0 ? null : (totalDrops / 1_000_000).toFixed(6);

  return (
    <>
      <header className="hero">
        <div className="hero-topline">
          <div className="eyebrow">
            <span className="signal" /> AETHER FOUNDRY / PUBLIC DESK
          </div>
          <div className="status-group">
            <span className="badge">{NETWORK_LABEL}</span>
            <span className="badge warn">read-only</span>
          </div>
        </div>
        <div className="hero-copy">
          <div>
            <p className="kicker">XRPL TESTNET // LEDGER OBSERVATORY</p>
            <h1>Aether Foundry Desk</h1>
            <p className="hero-description">
              A controlled view of foundry accounts, liquidity, artifacts, and
              machine results.
            </p>
          </div>
          <div className="connection-note">
            <span className="muted">validated ledger reads</span>
            <code className="mono">{XRPL_WS}</code>
          </div>
        </div>
        <nav className="hero-links" aria-label="Desk resources">
          <a href="/.well-known/xrp-ledger.toml">XRPL.toml ↗</a>
          <a
            href="https://github.com/Hobie1Kenobi/aether-foundry"
            target="_blank"
            rel="noreferrer"
          >
            Repository ↗
          </a>
        </nav>
      </header>

      <section className="summary-strip" aria-label="Desk summary">
        <div className="summary-item">
          <span className="summary-label">NAV XRP / SHOWN ACCOUNTS</span>
          <strong>
            {totalXrp ?? "—"} {totalXrp != null ? <small>XRP</small> : null}
          </strong>
          <span className="summary-detail">
            {onlineAccounts.length} of {accounts.length} account_info reads
          </span>
        </div>
        <div className="summary-item">
          <span className="summary-label">LIQUIDITY WINDOW</span>
          <strong>AMM AETH/XRP</strong>
          <span className="summary-detail">Pool and order books below</span>
        </div>
        <div className="summary-item summary-note">
          <span className="summary-label">OPERATING MODE</span>
          <strong>OBSERVE ONLY</strong>
          <span className="summary-detail">
            No signing · no seeds · validated ledger
          </span>
        </div>
      </section>

      <section className="callout" aria-labelledby="walk-in-title">
        <div className="callout-mark">INBOUND</div>
        <div>
          <div className="callout-title-row">
            <h2 id="walk-in-title">STRANGER walk-in</h2>
            <span className="status-chip">NFT ACCEPTED</span>
          </div>
          <p className="muted">
            First inbound counterparty. Test actor{" "}
            <ExternalLink
              href={EXPLORER_ACCOUNT(WALLETS.STRANGER.address)}
              title={WALLETS.STRANGER.address}
            >
              <span className="mono truncate-inline">
                {WALLETS.STRANGER.address}
              </span>
            </ExternalLink>{" "}
            accepted Walk-In NFT, taxon {NFT_TAXON}.
          </p>
          <p className="mono event-line">
            <span>Accept / Machine #3</span>
            <ExternalLink
              href={EXPLORER_TX(m3.hashes.strangerAccept)}
              title={m3.hashes.strangerAccept}
            >
              <span className="mono truncate-link">{m3.hashes.strangerAccept}</span>
            </ExternalLink>
          </p>
        </div>
      </section>

      <section aria-labelledby="accounts-title">
        <div className="section-heading">
          <div>
            <p className="kicker">01 / CONTROLLED ACCOUNTS</p>
            <h2 id="accounts-title" className="section-title">
              Account ledger
            </h2>
          </div>
          <span className="section-meta">account_info / validated</span>
        </div>
        <div className="grid account-grid">
          {accounts.map((a) => {
            const [id, ...rest] = a.role.split(" ");
            const name = rest.join(" ") || a.role;
            return (
              <article className="card account-card" key={a.address}>
                <div className="card-heading">
                  <div>
                    <span className="card-index">{id}</span>
                    <h3>{name}</h3>
                  </div>
                  <span
                    className={
                      a.error ? "status-chip error-chip" : "status-chip live-chip"
                    }
                  >
                    {a.error ? "ERROR" : "LIVE"}
                  </span>
                </div>
                <ExternalLink href={EXPLORER_ACCOUNT(a.address)} title={a.address}>
                  <span className="mono truncate-link address-link">{a.address}</span>
                </ExternalLink>
                <dl className="kv account-kv">
                  <dt>balance</dt>
                  <dd className="balance-value">
                    {a.balanceXrp != null ? (
                      <>
                        {a.balanceXrp} <span>XRP</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </dd>
                  <dt>sequence</dt>
                  <dd>{a.sequence ?? "—"}</dd>
                </dl>
                {a.error ? <p className="error">{a.error}</p> : null}
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="liquidity-title">
        <div className="section-heading">
          <div>
            <p className="kicker">02 / MARKET SURFACE</p>
            <h2 id="liquidity-title" className="section-title">
              Liquidity monitor
            </h2>
          </div>
          <span className="section-meta">amm_info + book_offers</span>
        </div>
        <div className="grid liquidity-grid">
          <article className="card">
            <div className="card-heading">
              <h3>AMM AETH / XRP</h3>
              <span className="status-chip live-chip">READ</span>
            </div>
            <dl className="kv">
              <dt>account</dt>
              <dd>
                <ExternalLink href={EXPLORER_ACCOUNT(amm.account)} title={amm.account}>
                  <span className="mono truncate-link">{amm.account}</span>
                </ExternalLink>
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
          {[books.buyAeth, books.sellAeth].map((book) => (
            <article className="card" key={book.side}>
              <div className="card-heading">
                <h3>{book.side}</h3>
                <span className="status-chip">{book.offers.length} OFFERS</span>
              </div>
              {book.error ? (
                <p className="error">{book.error}</p>
              ) : (
                <ul className="clean offer-list">
                  {book.offers.length === 0 ? (
                    <li className="muted">No offers returned</li>
                  ) : (
                    book.offers.map((o, i) => (
                      <li key={`${o.account}-${i}`} className="mono">
                        <span title={o.account}>{o.account.slice(0, 8)}…</span> pays{" "}
                        {JSON.stringify(o.takerPays)}{" "}
                        <span className="offer-arrow">→</span>{" "}
                        {JSON.stringify(o.takerGets)}
                      </li>
                    ))
                  )}
                </ul>
              )}
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="nfts-title">
        <div className="section-heading">
          <div>
            <p className="kicker">03 / ARTIFACT REGISTRY</p>
            <h2 id="nfts-title" className="section-title">
              Foundry NFTs
            </h2>
          </div>
          <span className="section-meta">account_nfts / taxon {NFT_TAXON}</span>
        </div>
        <div className="grid">
          {[nftsW2, nftsBuyer, nftsStranger].map((snap) => (
            <article className="card" key={snap.account}>
              <div className="card-heading">
                <h3>{snap.role}</h3>
                <span className="status-chip">{snap.nfts.length} FOUND</span>
              </div>
              <p className="mono muted truncate-link" title={snap.account}>
                {snap.account}
              </p>
              {snap.error ? <p className="error">{snap.error}</p> : null}
              <ul className="clean nft-list">
                {snap.nfts.length === 0 ? (
                  <li className="muted">None in taxon</li>
                ) : (
                  snap.nfts.map((n) => (
                    <li key={n.nftokenID}>
                      <ExternalLink
                        href={`https://testnet.xrpl.org/nft/${n.nftokenID}`}
                        title={n.nftokenID}
                      >
                        <span className="mono truncate-link">{n.nftokenID}</span>
                      </ExternalLink>
                    </li>
                  ))
                )}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="machines-title">
        <div className="section-heading">
          <div>
            <p className="kicker">04 / EXECUTION RECORD</p>
            <h2 id="machines-title" className="section-title">
              Machines #1–#3
            </h2>
          </div>
          <span className="section-meta">RESULTS hashes / display only</span>
        </div>
        <div className="grid machine-grid">
          <MachineCard
            number={m1.number}
            title={m1.label.replace(`Machine #${m1.number} — `, "")}
            readme={m1.readme}
            entries={[
              ["EscrowFinish", m1.hashes.escrowFinish],
              ["EscrowCancel", m1.hashes.escrowCancel],
              ["TokenEscrowFinish", m1.hashes.tokenEscrowFinish],
              ["TokenEscrowCancel", m1.hashes.tokenEscrowCancel],
            ]}
          />
          <MachineCard
            number={m2.number}
            title={m2.label.replace(`Machine #${m2.number} — `, "")}
            readme={m2.readme}
            channelId={m2.channelId}
            entries={[
              ["ChannelCreate", m2.hashes.channelCreate],
              ["Claim #1", m2.hashes.claim1],
              ["Claim #2", m2.hashes.claim2],
              ["Claim #3", m2.hashes.claim3],
              ["ChannelClose", m2.hashes.channelClose],
            ]}
          />
          <MachineCard
            number={m3.number}
            title={m3.label.replace(`Machine #${m3.number} — `, "")}
            readme={m3.readme}
            entries={[
              ["STRANGER Accept", m3.hashes.strangerAccept],
              ["Path-pay ~50 AETH", m3.hashes.pathPay],
              ["TrustSet", m3.hashes.trustSet],
              ["CheckCash", m3.hashes.checkCash],
            ]}
          />
        </div>
      </section>
    </>
  );
}
