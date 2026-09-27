import { EXPLORER_ACCOUNT } from "@/lib/xrpl-public";
import { listSkus, PAY_TO } from "@/lib/x402-rules";

const DESK = "https://aether-foundry-desk.vercel.app";

export function MerchantSection() {
  const skus = listSkus();
  const curl = `# Unpaid call returns 402 and a PAYMENT-REQUIRED header.
curl -sS -D- -o /tmp/x402-reserve.json ${DESK}/api/x402/reserve-audit

# Operator pays on Testnet (seed stays off this desk), then retries.
# DESK_URL=${DESK} XRPL_BUYER_SEED=... npm run x402:pay -- reserve-audit --record`;

  return (
    <section aria-labelledby="x402-merchant">
      <div className="section-heading">
        <div>
          <p className="kicker">05 / X402 MERCHANT</p>
          <h2 id="x402-merchant" className="section-title">
            Paid desk routes
          </h2>
        </div>
        <span className="section-meta">xrpl:1 · exact XRP · pay W3</span>
      </div>
      <p className="muted">
        Unpaid requests get HTTP 402. A validated Testnet Payment to{" "}
        <a
          className="mono"
          href={EXPLORER_ACCOUNT(PAY_TO)}
          target="_blank"
          rel="noreferrer"
        >
          {PAY_TO}
        </a>{" "}
        unlocks the JSON. This desk does not sign and does not submit the
        signed blob. Mainnet <span className="mono">xrpl:0</span> is refused.
      </p>
      <div className="grid">
        {skus.map((sku) => (
          <article className="card" key={sku.id}>
            <div className="card-heading">
              <h3>{sku.title}</h3>
              <span className="status-chip warn">{sku.xrp} XRP</span>
            </div>
            <p className="muted">{sku.description}</p>
            <dl className="kv">
              <dt>route</dt>
              <dd className="mono">{sku.path}</dd>
              <dt>drops</dt>
              <dd>{sku.drops}</dd>
              <dt>source tag</dt>
              <dd>{sku.sourceTag}</dd>
            </dl>
          </article>
        ))}
      </div>
      <article className="card merchant-call">
        <div className="card-heading">
          <h3>How an agent calls</h3>
          <span className="status-chip">402 THEN 200</span>
        </div>
        <pre className="merchant-pre">{curl}</pre>
        <p className="muted">
          Catalog (free): <span className="mono">/api/x402</span>. Hits come
          back as <span className="mono">x402_hit</span>. Vercel does not write
          the P&amp;L file; <span className="mono">npm run x402:hit</span>{" "}
          appends <span className="mono">lab/ledger-log.jsonl</span> and updates{" "}
          <span className="mono">market/pnl.md</span>.
        </p>
      </article>
    </section>
  );
}
