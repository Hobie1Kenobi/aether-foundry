import type { ReactNode } from "react";
import { CopyId } from "@/components/CopyId";
import type { StatusBody } from "@/lib/status-body";
import {
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
    <div className="frontier-chips" aria-label="Frontier counters">
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
    <article className="card">
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
    <article className="card">
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
    <article className="card">
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
    <article className="card">
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
          Desk verifies a validated Payment itself. The advertised T54 URL is not a
          settle path.
        </p>
      ) : null}
      {mode === "dual" ? (
        <p className="muted">
          Self-verify plus a T54 testnet receipt. The desk does not settle.
        </p>
      ) : null}
      {mode === "refused" && facilitator?.error ? (
        <p className="error">{facilitator.error}</p>
      ) : null}
    </article>
  );
}

export function FrontierCards({ status }: { status: StatusBody | null }) {
  return (
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
  );
}
