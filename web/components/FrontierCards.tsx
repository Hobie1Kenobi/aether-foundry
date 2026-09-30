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
