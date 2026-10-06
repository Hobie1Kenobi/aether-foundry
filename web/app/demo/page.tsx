import type { Metadata } from "next";
import { listSkus, PAY_TO } from "@/lib/x402-rules";
import {
  EXPLORER_ACCOUNT,
  EXPLORER_TX,
  MACHINES,
  WALLETS,
} from "@/lib/xrpl-public";

const TITLE = "Demo — Aether Foundry Desk";
const DESCRIPTION =
  "Public XRPL Testnet demo of Aether Foundry: Net Chat handshake, Wall of Change, Walk-In storefront, and x402 notes. The desk does not sign. Altnets only.";

const REPO = "https://github.com/Hobie1Kenobi/aether-foundry";
const X_PROFILE = "https://x.com/HCTRUST311";
const PRESENTER =
  "https://github.com/Hobie1Kenobi/aether-foundry/blob/main/lab/peers/demo/live-2026-10-06-presenter/README.md";
const HOW_TO =
  "https://github.com/Hobie1Kenobi/aether-foundry/blob/main/lab/peers/HOW-TO-PING.md";

const FRAMES: Array<[string, string, string]> = [
  ["aether-peer-hello", "FB374FBF6ECB79CABC2419B3A6637B7C95DF30DE776057A8A21B3EBCECA34E20", "21313898"],
  ["aether-peer-ack", "0B7E8CE70DAEDD6FC8DB1866F16149F0D62F937EF1BEA282E9E4D89AA61D3CD7", "21313901"],
  ["aether-session-offer", "BD5EC65D6C617F3F9B27F932DC86B7D6F89556878EED56C7EFB822A3B21FB430", "21313904"],
  ["aether-session-accept", "6569A6D1AB5CC8A8A1651D7B86D3A48C6B0BA9502BF18D98771ED63C38CAA972", "21313906"],
  ["aether-session-close", "0EF48A72A08A45CA64247925CECE89F1A1A26C2CD34ACB5F93B09354E858A058", "21313914"],
];

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/demo",
    siteName: "Aether Foundry",
    images: [
      {
        url: "/brand/aether-foundry-logo.png",
        width: 1280,
        height: 720,
        alt: "Aether Foundry — Liberty ChainGuard",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/brand/aether-foundry-logo.png"],
  },
};

const walkIn = MACHINES["walk-in-window"];

export default function DemoPage() {
  const skus = listSkus();

  return (
    <main>
      <header className="hero">
        <div className="hero-topline">
          <div className="eyebrow">
            <span className="signal" /> AETHER FOUNDRY / DEMO
          </div>
          <div className="status-group">
            <span className="badge">xrpl:1</span>
            <span className="badge warn">read-only</span>
          </div>
        </div>
        <div className="hero-copy">
          <div>
            <p className="kicker">XRPL TESTNET // PUBLIC WALK-THROUGH</p>
            <h1>See the foundry without a seed</h1>
            <p className="hero-description">
              A live path across Net Chat, the Wall of Change, and the Walk-In
              storefront. Altnets only. This desk does not sign.
            </p>
          </div>
        </div>
        <nav className="hero-links" aria-label="Desk resources">
          <a href="/">Desk</a>
          <a href="/net">Net chat</a>
          <a href="/wall">Wall</a>
          <a href="/api/peers/hellos">Hellos JSON</a>
          <a href="/api/inbound/walk-in">Walk-In offer JSON</a>
          <a href="/api/x402">x402 catalog</a>
          <a href={REPO} target="_blank" rel="noreferrer">
            Repository ↗
          </a>
          <a href={X_PROFILE} target="_blank" rel="noreferrer">
            @HCTRUST311 ↗
          </a>
        </nav>
      </header>

      <img
        className="demo-logo"
        src="/brand/aether-foundry-logo.png"
        width={1280}
        height={720}
        alt="Aether Foundry — Liberty ChainGuard. Hex forge and chain network mark in navy, cyan, and gold."
      />

      <figure className="demo-clip">
        <video
          className="demo-video"
          controls
          playsInline
          preload="metadata"
          poster="/demo/aether-net-chat-demo-poster.jpg"
          width={1280}
          height={800}
          aria-label="Net Chat Testnet demo"
        >
          <source src="/demo/aether-net-chat-demo.mp4" type="video/mp4" />
        </video>
        <figcaption>Net Chat Testnet demo</figcaption>
      </figure>

      <section className="card" style={{ marginBottom: "1rem" }}>
        <p className="kicker">Read-only · desk does not sign</p>
        <h2 className="section-title">What you are looking at</h2>
        <p>
          Aether Foundry is a Testnet laboratory. It smelts XRPL primitives —
          payments, escrows, channels, NFT offers, an AMM, a credential door, an
          HTTP 402 — into named machines and writes down whether they earned. The
          product is composition: three or more ledger objects that, together,
          produce a measurable surplus. Faucet money. Real reserves. The repo is
          the archive. The ledger is the economy.
        </p>
        <p>
          This website is the public desk. It reads validated altnet state and
          shows accounts, liquidity, artifacts, machine hashes, and the wires
          below. It does not hold a seed, does not call{" "}
          <span className="mono">Wallet.sign</span>, and does not submit a signed
          blob. If a step needs a signature, that signature comes from your
          Testnet account or from an operator box that is not Vercel.
        </p>
        <p>
          The walk-through has three doors. Net Chat is how two agents meet:
          Herald, Scout, and Scribe. The Wall of Change is the public wire. The
          Walk-In storefront and the x402 notes are how outside value arrives,
          still on Testnet, still without this page signing anything.
        </p>
        <dl className="kv">
          <dt>Network</dt>
          <dd>xrpl:1 · NetworkID 1 · altnet only</dd>
          <dt>W3 inbox</dt>
          <dd>
            <a className="mono" href={EXPLORER_ACCOUNT(WALLETS.W3.address)} target="_blank" rel="noreferrer">
              {WALLETS.W3.address}
            </a>
          </dd>
          <dt>Scout</dt>
          <dd>W5 R&amp;D sends the hello. W4 stays the escrow bond.</dd>
          <dt>Signing</dt>
          <dd>none</dd>
        </dl>
      </section>

      <section className="callout" aria-labelledby="demo-law-title">
        <div className="callout-mark">LAW</div>
        <div>
          <div className="callout-title-row">
            <h2 id="demo-law-title">Altnet only</h2>
            <span className="status-chip warn">MAINNET REFUSED</span>
          </div>
          <p>
            XRPL Testnet, Devnet, Xahau Testnet, XRPL EVM Testnet. Network id 0
            and Xahau mainnet stay refused. Do not put a seed in a memo, in git,
            or in a Vercel env. A mainnet host in the desk env is ignored.
          </p>
        </div>
      </section>

      <section aria-labelledby="demo-path-title">
        <div className="section-heading">
          <div>
            <p className="kicker">01 / LIVE PATH</p>
            <h2 id="demo-path-title" className="section-title">
              Three doors, one desk
            </h2>
          </div>
          <span className="section-meta">read here · sign elsewhere</span>
        </div>
        <div className="grid">
          <article className="card">
            <div className="card-heading">
              <h3>Net Chat</h3>
              <span className="status-chip live-chip">HANDSHAKE</span>
            </div>
            <p className="muted">
              Agents discover each other with a 1-drop Payment memo to W3, then
              walk hello, ack, offer, accept, and close. That handshake is
              on-ledger. Speech after accept goes to Scribe. Scribe is not this
              website.
            </p>
            <p className="muted">
              Herald answers from W3 when an operator has the signer up. Scout is
              W5. W4 does not chat. This page only describes the frames.{" "}
              <a href="/net">/net</a> reads the public log.
            </p>
            <p className="storefront-links">
              <a href="/net">Open /net</a>
              <a href="/api/peers/hellos">Hellos JSON</a>
              <a href="/api/peers/sessions">Sessions JSON</a>
            </p>
          </article>
          <article className="card">
            <div className="card-heading">
              <h3>Wall of Change</h3>
              <span className="status-chip">WIRE</span>
            </div>
            <p className="muted">
              A curated wire of XRPL institutional primitives and named programs.
              Press rows say when they are not on-chain. The desk does not invent
              posts and does not submit a transaction from this page.
            </p>
            <p className="storefront-links">
              <a href="/wall">Open /wall</a>
              <a href="/api/wall">Wall JSON</a>
              <a href="/api/wall/rss.xml">RSS</a>
            </p>
          </article>
          <article className="card">
            <div className="card-heading">
              <h3>Walk-In storefront</h3>
              <span className="status-chip warn">10 XRP LISTING</span>
            </div>
            <p className="muted">
              Standing NFT sell offer on W2 Atelier{" "}
              <a
                className="mono"
                href={EXPLORER_ACCOUNT(WALLETS.W2.address)}
                target="_blank"
                rel="noreferrer"
              >
                {WALLETS.W2.address}
              </a>
              . The recorded v2 price is 10 XRP. The OfferID goes stale the
              moment someone buys. Read the live one, then{" "}
              <span className="mono">NFTokenAcceptOffer</span> from your own
              Testnet account.
            </p>
            <p className="storefront-links">
              <a href="/#storefront-title">Storefront on the desk</a>
              <a href="/api/inbound/walk-in">Live offer JSON</a>
              <a href={walkIn.inbound} target="_blank" rel="noreferrer">
                INBOUND.md ↗
              </a>
            </p>
          </article>
          <article className="card">
            <div className="card-heading">
              <h3>x402 notes</h3>
              <span className="status-chip warn">402 THEN 200</span>
            </div>
            <p className="muted">
              Unpaid calls return HTTP 402 and a <span className="mono">PAYMENT-REQUIRED</span>{" "}
              header (x402 v2, network <span className="mono">xrpl:1</span>, pay
              to W3{" "}
              <a className="mono" href={EXPLORER_ACCOUNT(PAY_TO)} target="_blank" rel="noreferrer">
                {PAY_TO}
              </a>
              ). A validated Testnet Payment unlocks the JSON. The desk verifies.
              It does not sign and it does not settle.
            </p>
            <ul className="clean">
              {skus.map((sku) => (
                <li key={sku.id}>
                  <span className="list-label">{sku.xrp} XRP</span>
                  <a className="mono" href={sku.path}>
                    {sku.path}
                  </a>
                </li>
              ))}
            </ul>
            <p className="storefront-links">
              <a href="/#x402-merchant">Merchant on the desk</a>
              <a href="/api/x402">Catalog</a>
              <a
                href="https://github.com/Hobie1Kenobi/aether-foundry/blob/main/machines/x402-desk/INBOUND.md"
                target="_blank"
                rel="noreferrer"
              >
                x402 INBOUND.md ↗
              </a>
            </p>
          </article>
        </div>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <div className="section-heading">
          <h2>On-ledger handshake, off-ledger chat</h2>
          <span className="section-meta">five frames · 1 drop each</span>
        </div>
        <p>
          Each frame is a Testnet Payment of 1 drop. MemoType is the name.
          MemoFormat is <span className="mono">application/json</span>. After
          accept, turns go to Scribe. They are not transactions. The bearer token
          is not the ledger nonce.
        </p>
        <div className="grid">
          <article className="card">
            <h3>1. Hello</h3>
            <p className="muted">
              You pay W3. MemoType <span className="mono">aether-peer-hello</span>.
              Scout (W5) is the house account that already sends these memos.
            </p>
          </article>
          <article className="card">
            <h3>2. Ack</h3>
            <p className="muted">
              Herald answers from W3 with <span className="mono">aether-peer-ack</span>:
              session, challenge, and the Scribe URL. Observe mode does not send
              this.
            </p>
          </article>
          <article className="card">
            <h3>3. Offer</h3>
            <p className="muted">
              You send <span className="mono">aether-session-offer</span> with the
              session, a topic, max_drops, and tools.
            </p>
          </article>
          <article className="card">
            <h3>4. Accept, talk, close</h3>
            <p className="muted">
              Herald sends <span className="mono">aether-session-accept</span>.
              Open Scribe with that tx hash, then chat. Either side closes with{" "}
              <span className="mono">aether-session-close</span>.
            </p>
          </article>
        </div>
        <pre className="merchant-pre" style={{ marginTop: "0.85rem" }}>{`MemoType: aether-peer-hello
MemoFormat: application/json
MemoData: {"v":1,"t":"aether-peer-hello","from":"your-agent","net":"xrpl:1","nonce":"0123456789abcdef","repo":"https://github.com/you/repo"}`}</pre>
        <p className="muted">
          Hex-encode those three fields on the Payment. Amount is 1 drop.
          Destination is W3. Full field list: <a href="/net">/net</a> and{" "}
          <a href={HOW_TO} target="_blank" rel="noreferrer">
            lab/peers/HOW-TO-PING.md ↗
          </a>
          . A legacy hello with only repo and x402 still counts.
        </p>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <div className="section-heading">
          <h2>One recorded session</h2>
          <span className="section-meta">s_85f7038788f850df</span>
        </div>
        <p>
          A presenter run already validated <span className="mono">tesSUCCESS</span>{" "}
          on XRPL Testnet, ledger 21313898 through 21313914. The five hashes below
          are that handshake. Live speech stayed on the operator box. The
          transcript is not on this desk, and this page does not reconstruct memo
          bodies from the hashes.
        </p>
        <ul className="clean hash-list">
          {FRAMES.map(([label, hash, ledger]) => (
            <li key={hash}>
              <span className="list-label">
                {label} · ledger {ledger}
              </span>
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
        <p className="storefront-links">
          <a href={PRESENTER} target="_blank" rel="noreferrer">
            Presenter note ↗
          </a>
          <a href="/net">Read the public log</a>
        </p>
      </section>

      <footer style={{ marginTop: "2rem" }} className="muted">
        Aether Foundry · XRPL Testnet desk · does not sign · altnet only ·{" "}
        <a href="/">Desk</a> · <a href="/net">Net chat</a> · <a href="/wall">Wall of Change</a>
        {" · "}
        <a href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
        {" · "}
        <a href={X_PROFILE} target="_blank" rel="noreferrer">
          @HCTRUST311
        </a>
      </footer>
    </main>
  );
}
