import type { ReactNode } from "react";
import { CopyId } from "@/components/CopyId";
import type { StatusBody } from "@/lib/status-body";
import {
  DEVNET_EXPLORER_ACCOUNT,
  DEVNET_EXPLORER_MPT,
  DEVNET_EXPLORER_SEARCH,
  DEVNET_EXPLORER_TX,
  EXPLORER_ACCOUNT,
  EXPLORER_MPT,
  EXPLORER_SEARCH,
  EXPLORER_TX,
} from "@/lib/xrpl-public";

const ABSENT = "not on ledger yet";

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function formatUnix(sec: number | null): string | null {
  if (sec == null || !Number.isInteger(sec) || sec < 1_500_000_000) return null;
  const date = new Date(sec * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(".000Z", "Z");
}

function Absent() {
  return <span className="muted">{ABSENT}</span>;
}

function LedgerId({ id, href }: { id: string | null; href?: string }) {
  if (!id) return <Absent />;
  const label = shortId(id);
  return (
    <span className="id-line">
      {href ? (
        <a className="mono id-link" href={href} target="_blank" rel="noreferrer" title={id}>
          {label}
          <span aria-hidden="true" className="external-mark">
            ↗
          </span>
        </a>
      ) : (
        <span className="mono" title={id}>
          {label}
        </span>
      )}
      <CopyId value={id} />
    </span>
  );
}

function Chip({
  children,
  tone,
  href,
  title,
}: {
  children: ReactNode;
  tone?: "live" | "warn" | "error" | "muted";
  href?: string;
  title?: string;
}) {
  const toneClass =
    tone === "live"
      ? " live-chip"
      : tone === "warn"
        ? " warn"
        : tone === "error"
          ? " error-chip"
          : tone === "muted"
            ? " muted-chip"
            : "";
  const className = `status-chip${toneClass}`;
  if (href) {
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer" title={title}>
        {children}
      </a>
    );
  }
  return <span className={className}>{children}</span>;
}

function FrontierChips({ status }: { status: StatusBody | null }) {
  const beat = status?.last_heartbeat;
  const grants = status?.grants_paid;
  const batch = status?.batch_atomic_enabled;
  return (
    <div className="frontier-chips" id="f6" aria-label="Frontier counters">
      {beat?.hash ? (
        <Chip tone="live" href={EXPLORER_TX(beat.hash)} title={beat.hash}>
          heartbeat {shortId(beat.hash)}
          {beat.ledger_index != null ? ` · ${beat.ledger_index}` : ""}
        </Chip>
      ) : (
        <Chip tone="muted">heartbeat {ABSENT}</Chip>
      )}
      {grants == null ? (
        <Chip tone="muted">grants paid —</Chip>
      ) : (
        <Chip>grants paid {grants}</Chip>
      )}
      {batch == null ? (
        <Chip tone="muted">batch atomic —</Chip>
      ) : (
        <Chip tone={batch ? "live" : "warn"}>
          batch atomic {batch ? "on" : "off"}
        </Chip>
      )}
    </div>
  );
}

function OracleCard({ status }: { status: StatusBody | null }) {
  const id = status?.oracle_id ?? null;
  const oracle = status?.oracle;
  const quote = oracle?.quote_xrp_per_aeth ?? null;
  const updated = formatUnix(oracle?.last_update_time ?? null);
  const account = oracle?.account || "";
  return (
    <article className="card" id="f1">
      <div className="card-heading">
        <h3>Native Oracle</h3>
        <Chip tone={id ? "live" : "muted"}>{id ? "on ledger" : "absent"}</Chip>
      </div>
      <dl className="kv">
        <dt>oracle id</dt>
        <dd>
          <LedgerId id={id} href={id ? EXPLORER_SEARCH(id) : undefined} />
        </dd>
        <dt>quote</dt>
        <dd className={quote ? "balance-value" : undefined}>
          {quote ? (
            <>
              {quote} <span>XRP / AETH</span>
            </>
          ) : (
            <Absent />
          )}
        </dd>
        <dt>updated</dt>
        <dd>{updated ? <span className="mono">{updated}</span> : <Absent />}</dd>
        <dt>account</dt>
        <dd>
          {account ? (
            <a
              className="mono id-link"
              href={EXPLORER_ACCOUNT(account)}
              target="_blank"
              rel="noreferrer"
              title={account}
            >
              {shortId(account)}
              <span aria-hidden="true" className="external-mark">
                ↗
              </span>
            </a>
          ) : (
            <Absent />
          )}
        </dd>
        <dt>document</dt>
        <dd>
          {oracle?.oracle_document_id == null ? (
            <Absent />
          ) : (
            oracle.oracle_document_id
          )}
        </dd>
      </dl>
      <p className="muted">W5 price oracle. The desk reads it and does not sign OracleSet.</p>
    </article>
  );
}

function LaborCard({ status }: { status: StatusBody | null }) {
  const id = status?.mpt_issuance_id ?? null;
  return (
    <article className="card" id="f2">
      <span id="f3" className="anchor-target" />
      <div className="card-heading">
        <h3>Labor MPT</h3>
        <Chip tone={id ? "live" : "muted"}>{id ? "AETH-LABOR" : "absent"}</Chip>
      </div>
      <dl className="kv">
        <dt>issuance</dt>
        <dd>
          <LedgerId id={id} href={id ? EXPLORER_MPT(id) : undefined} />
        </dd>
      </dl>
      {id ? (
        <p className="muted">
          AETH-LABOR. TokenEscrow labor path. This card shows the issuance id.
        </p>
      ) : (
        <p className="muted">{ABSENT}</p>
      )}
    </article>
  );
}

function DomainCard({ status }: { status: StatusBody | null }) {
  const id = status?.domain_id ?? null;
  return (
    <article className="card" id="f4">
      <div className="card-heading">
        <h3>Credential Domain</h3>
        <Chip tone={id ? "live" : "muted"}>{id ? "on ledger" : "absent"}</Chip>
      </div>
      <dl className="kv">
        <dt>domain id</dt>
        <dd>
          <LedgerId id={id} href={id ? EXPLORER_SEARCH(id) : undefined} />
        </dd>
      </dl>
      {id ? (
        <p className="muted">
          Uncredentialed AMM take on this domain is rejected (tecNO_PERMISSION).
        </p>
      ) : (
        <p className="muted">{ABSENT}</p>
      )}
    </article>
  );
}

function FacilitatorCard({ status }: { status: StatusBody | null }) {
  const facilitator = status?.facilitator;
  const mode = facilitator?.mode;
  const hits = status?.x402_outbound_hits;
  const tone = mode === "dual" ? "live" : mode === "refused" ? "error" : mode ? "warn" : "muted";
  return (
    <article className="card" id="x402-frontier">
      <div className="card-heading">
        <h3>x402 dual-mode</h3>
        <Chip tone={tone}>{mode ?? "absent"}</Chip>
      </div>
      {facilitator ? (
        <dl className="kv">
          <dt>advertised</dt>
          <dd>
            {facilitator.advertised ? (
              <a
                className="mono id-link"
                href={facilitator.advertised}
                target="_blank"
                rel="noreferrer"
              >
                {facilitator.advertised.replace(/^https:\/\//, "")}
                <span aria-hidden="true" className="external-mark">
                  ↗
                </span>
              </a>
            ) : (
              <Absent />
            )}
          </dd>
          {facilitator.url ? (
            <>
              <dt>remote</dt>
              <dd className="mono">{facilitator.url}</dd>
            </>
          ) : null}
          <dt>remote verify</dt>
          <dd>{facilitator.remoteVerify ? "true" : "false"}</dd>
          <dt>settles</dt>
          <dd>{facilitator.settles ? "true" : "false"}</dd>
          <dt>outbound</dt>
          <dd>{hits == null ? <Absent /> : hits}</dd>
        </dl>
      ) : (
        <p className="muted">{ABSENT}</p>
      )}
      {mode === "self-verify" ? (
        <p className="muted">
          XRPL_FACILITATOR_URL is unset. The desk reads a validated Payment itself
          and does not call T54. Settles stays false.
        </p>
      ) : null}
      {mode === "dual" ? (
        <p className="muted">
          T54 testnet POST /verify is on for xrpl:1. Settles stays false. The desk
          does not submit the Payment.
        </p>
      ) : null}
      {mode === "refused" && facilitator?.error ? (
        <p className="error">{facilitator.error}</p>
      ) : null}
    </article>
  );
}

function DevnetAccount({ address }: { address: string | null }) {
  if (!address) return <Absent />;
  return (
    <LedgerId id={address} href={DEVNET_EXPLORER_ACCOUNT(address)} />
  );
}

function DevnetHash({ hash }: { hash: string | null }) {
  if (!hash) return <Absent />;
  return <LedgerId id={hash} href={DEVNET_EXPLORER_TX(hash)} />;
}

function SponsorCard({ status }: { status: StatusBody | null }) {
  const row = status?.devnet?.f8;
  const live = Boolean(row?.create_hash || row?.object_hash);
  return (
    <article className="card" id="f8">
      <div className="card-heading">
        <h3>F8 Sponsor</h3>
        <Chip tone={live ? "live" : "muted"}>{live ? "on ledger" : "absent"}</Chip>
      </div>
      <dl className="kv">
        <dt>network</dt>
        <dd>XRPL Devnet</dd>
        <dt>sponsor</dt>
        <dd>
          <DevnetAccount address={row?.sponsor ?? null} />
        </dd>
        <dt>sponsoree</dt>
        <dd>
          <DevnetAccount address={row?.sponsoree ?? null} />
        </dd>
        <dt>create</dt>
        <dd>
          <DevnetHash hash={row?.create_hash ?? null} />
        </dd>
        <dt>object</dt>
        <dd>
          <DevnetHash hash={row?.object_hash ?? null} />
        </dd>
        {row?.prior_sponsee ? (
          <>
            <dt>prior sponsoree</dt>
            <dd>
              <DevnetAccount address={row.prior_sponsee} />
            </dd>
          </>
        ) : null}
      </dl>
      <p className="muted">Create-account Sponsor on network id 2. Not a Testnet balance.</p>
    </article>
  );
}

function VaultCard({ status }: { status: StatusBody | null }) {
  const row = status?.devnet?.f9;
  const live = Boolean(row?.vault_id || row?.loan_id);
  return (
    <article className="card" id="f9">
      <div className="card-heading">
        <h3>F9 Vault / loan</h3>
        <Chip tone={live ? "live" : "muted"}>{live ? "on ledger" : "absent"}</Chip>
      </div>
      <dl className="kv">
        <dt>network</dt>
        <dd>XRPL Devnet</dd>
        <dt>owner</dt>
        <dd>
          <DevnetAccount address={row?.owner ?? null} />
        </dd>
        <dt>depositor</dt>
        <dd>
          <DevnetAccount address={row?.depositor ?? null} />
        </dd>
        <dt>vault</dt>
        <dd>
          <LedgerId
            id={row?.vault_id ?? null}
            href={row?.vault_id ? DEVNET_EXPLORER_SEARCH(row.vault_id) : undefined}
          />
        </dd>
        <dt>broker</dt>
        <dd>
          <LedgerId
            id={row?.broker_id ?? null}
            href={row?.broker_id ? DEVNET_EXPLORER_SEARCH(row.broker_id) : undefined}
          />
        </dd>
        <dt>loan</dt>
        <dd>
          <LedgerId
            id={row?.loan_id ?? null}
            href={row?.loan_id ? DEVNET_EXPLORER_SEARCH(row.loan_id) : undefined}
          />
        </dd>
        <dt>accounting</dt>
        <dd>{row?.accounting ? <span className="mono">{row.accounting}</span> : <Absent />}</dd>
        <dt>repay</dt>
        <dd>
          <DevnetHash hash={row?.repay_hash ?? null} />
        </dd>
      </dl>
      <p className="muted">Single-asset vault and one repaid loan. Cash-basis when the archive says so.</p>
    </article>
  );
}

function ConfidentialCard({ status }: { status: StatusBody | null }) {
  const row = status?.devnet?.f10;
  const live = Boolean(row?.issuance_id || row?.payment_hash || row?.clawback_hash);
  return (
    <article className="card" id="f10">
      <div className="card-heading">
        <h3>F10 Confidential MPT</h3>
        <Chip tone={live ? "live" : "muted"}>{live ? "on ledger" : "absent"}</Chip>
      </div>
      <dl className="kv">
        <dt>network</dt>
        <dd>XRPL Devnet</dd>
        <dt>issuer</dt>
        <dd>
          <DevnetAccount address={row?.issuer ?? null} />
        </dd>
        <dt>counterparty</dt>
        <dd>
          <DevnetAccount address={row?.counterparty ?? null} />
        </dd>
        <dt>sender</dt>
        <dd>
          <DevnetAccount address={row?.sender ?? null} />
        </dd>
        <dt>symbol</dt>
        <dd>{row?.symbol ? <span className="mono">{row.symbol}</span> : <Absent />}</dd>
        <dt>issuance</dt>
        <dd>
          <LedgerId
            id={row?.issuance_id ?? null}
            href={row?.issuance_id ? DEVNET_EXPLORER_MPT(row.issuance_id) : undefined}
          />
        </dd>
        <dt>payment</dt>
        <dd>
          <DevnetHash hash={row?.payment_hash ?? null} />
        </dd>
        <dt>clawback</dt>
        <dd>
          <DevnetHash hash={row?.clawback_hash ?? null} />
        </dd>
      </dl>
      <p className="muted">
        {row?.public_ledger
          ? row.public_ledger
          : "Confidential payment amount stays off this card until the public archive records it."}
      </p>
    </article>
  );
}

export function FrontierCards({ status }: { status: StatusBody | null }) {
  return (
    <>
      <section aria-labelledby="frontier-title">
        <div className="section-heading">
          <div>
            <p className="kicker">LIMIT PUSH // FRONTIER</p>
            <h2 id="frontier-title" className="section-title">
              Frontier
            </h2>
          </div>
          <span className="section-meta">same read as /api/status</span>
        </div>
        <FrontierChips status={status} />
        <div className="grid frontier-grid">
          <OracleCard status={status} />
          <LaborCard status={status} />
          <DomainCard status={status} />
          <FacilitatorCard status={status} />
        </div>
      </section>
      <section aria-labelledby="devnet-frontier">
        <div className="section-heading">
          <div>
            <p className="kicker">LIMIT PUSH // DEVNET</p>
            <h2 id="devnet-frontier" className="section-title">
              Devnet
            </h2>
          </div>
          <span className="section-meta">XRPL Devnet · not in Testnet NAV</span>
        </div>
        <div className="grid frontier-grid">
          <SponsorCard status={status} />
          <VaultCard status={status} />
          <ConfidentialCard status={status} />
        </div>
      </section>
    </>
  );
}
