"use client";

import { useMemo, useState } from "react";
import {
  CLOCK,
  TWIN_HREF,
  filterPrograms,
  type AmendmentDots,
  type Dot,
  type Program,
  type WallFilter,
  type WallPayload,
} from "@/lib/wall-schema";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const FILTERS: { id: WallFilter; label: string }[] = [
  { id: "all", label: "ALL" },
  { id: "on-chain", label: "ON-CHAIN" },
  { id: "press", label: "PRESS" },
  { id: "devnet", label: "DEVNET" },
  { id: "mainnet", label: "MAINNET" },
  { id: "foundry-twin", label: "FOUNDRY TWIN" },
];

function dotWord(dot: Dot): string {
  if (dot === "on") return "live";
  return dot;
}

function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function wireStamp(iso: string): { day: string; time: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = `${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCFullYear()).slice(-2)}`;
  const time = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
  return { day, time };
}

function tickerLine(name: string, dots: AmendmentDots | undefined): string {
  const row = dots || { testnet: "unknown" as Dot, devnet: "unknown" as Dot, mainnet: "unknown" as Dot };
  return `${name}  testnet ${dotWord(row.testnet)}  devnet ${dotWord(row.devnet)}  mainnet ${dotWord(row.mainnet)}`;
}

function Telegram({
  program,
  sources,
}: {
  program: Program;
  sources: WallPayload["sources"];
}) {
  const stamp = wireStamp(program.ts);
  const twin = program.foundry_twin;
  const twinHref = twin ? TWIN_HREF[twin] : undefined;
  return (
    <article className="telegram" id={program.id}>
      <p className="wire-when mono">
        {stamp ? (
          <>
            {stamp.day}
            <span> · </span>
            {stamp.time}
          </>
        ) : (
          "— · —"
        )}
      </p>
      <h3 className="wire-actor">{program.actor}</h3>
      {program.onchain.id ? (
        <p className="mono wire-hash" title={program.onchain.id}>
          {truncateId(program.onchain.id)}
        </p>
      ) : null}
      <p className="wire-chips">
        <span className="wall-chip">
          <span className={`stage-dot ${program.stage}`} aria-hidden="true" />
          {program.stage}
        </span>
        <span className="wall-chip">{program.networks.join(" ")}</span>
        <span className="wall-chip">{program.class}</span>
      </p>
      <p className="wire-claim">{program.claim}</p>
      <p className="wire-links">
        {program.sources.map((key, index) => {
          const source = sources[key];
          if (!source) return null;
          return (
            <span key={key}>
              {index > 0 ? " · " : null}
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>
            </span>
          );
        })}
        {program.onchain.url ? (
          <>
            <span> · </span>
            <a href={program.onchain.url} target="_blank" rel="noreferrer" title={program.onchain.id}>
              explorer
            </a>
          </>
        ) : null}
        {twin && twinHref ? (
          <>
            <span> · </span>
            <a className="twin-mark" href={twinHref}>
              {twin}
            </a>
          </>
        ) : null}
      </p>
    </article>
  );
}

export function WallOfChange({
  payload,
  variant,
}: {
  payload: WallPayload | null;
  variant: "hero" | "page";
}) {
  const [filter, setFilter] = useState<WallFilter>("all");
  const [query, setQuery] = useState("");
  const [amendment, setAmendment] = useState("");
  const down = !payload || payload.wire_status === "down";
  const rows = useMemo(() => {
    if (!payload) return [];
    return filterPrograms(payload.programs, filter, query, amendment);
  }, [payload, filter, query, amendment]);

  const ticker = CLOCK.map((row) => ({
    name: row.name,
    text: tickerLine(row.name, payload?.amendments[row.name]),
  }));

  let lastDay = "";

  return (
    <section
      className={`wall wall-${variant}${payload?.amendment_changed ? " wall-changed" : ""}`}
      aria-labelledby="wall-title"
    >
      <div className={`wall-bar${payload?.amendment_changed ? " changed" : ""}`} aria-hidden="true" />
      <div className="wall-inner">
        <div className="wall-mast">
          <div>
            <p className="kicker">WIRE // INSTITUTIONAL XRPL</p>
            <h2 id="wall-title" className="section-title wall-title">
              The Wall of Change
            </h2>
          </div>
          <div className="wall-mast-side">
            {down ? (
              <span className="status-chip error-chip">WIRE DOWN</span>
            ) : payload?.wire_status === "degraded" ? (
              <span className="status-chip warn">DEGRADED</span>
            ) : (
              <span className="status-chip live-chip">LIVE</span>
            )}
            <p className="mono wall-ledger">
              {down
                ? "TESTNET — · ledger — · pulled —"
                : `TESTNET ${payload?.server_build ?? "—"} · ledger ${payload?.ledger_index ?? "—"} · ${payload?.pulled_label ?? "pulled —"}`}
            </p>
          </div>
        </div>

        {down ? (
          <p className="muted">The wire could not be read. Rows stay empty. The desk does not sign.</p>
        ) : (
          <>
            <div className="wall-ticker" aria-label="Amendment ticker">
              <div className="wall-ticker-track">
                {ticker.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    className="ticker-btn"
                    aria-pressed={amendment === item.name}
                    onClick={() => setAmendment((current) => (current === item.name ? "" : item.name))}
                  >
                    {item.text}
                  </button>
                ))}
                {ticker.map((item) => (
                  <button
                    key={`${item.name}-copy`}
                    type="button"
                    className="ticker-btn ticker-copy"
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={() => setAmendment((current) => (current === item.name ? "" : item.name))}
                  >
                    {item.text}
                  </button>
                ))}
              </div>
            </div>

            <div className="wall-filters" role="toolbar" aria-label="Wire filters">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="filter-btn"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
              <input
                className="wall-search"
                type="search"
                value={query}
                placeholder="actor or claim"
                aria-label="Search actor or claim"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {payload?.probe_notes.length ? (
              <p className="mono wall-notes">{payload.probe_notes.join(" ")}</p>
            ) : null}

            <div className="wall-body">
              <div className="wall-clock" aria-label="Amendment clock">
                <p className="kicker">AMENDMENT CLOCK</p>
                <ul className="clean">
                  {CLOCK.map((row) => {
                    const dots = payload?.amendments[row.name] || {
                      testnet: "unknown" as Dot,
                      devnet: "unknown" as Dot,
                      mainnet: "unknown" as Dot,
                    };
                    const href = TWIN_HREF[row.twin];
                    return (
                      <li className="clock-row" key={row.name}>
                        <span className="clock-name">{row.name}</span>
                        <span
                          className="clock-dots"
                          aria-label={`Testnet ${dots.testnet}, Devnet ${dots.devnet}, Mainnet ${dots.mainnet}`}
                        >
                          <span className={`dot ${dots.testnet}`} title={`Testnet ${dots.testnet}`} />
                          <span className={`dot ${dots.devnet}`} title={`Devnet ${dots.devnet}`} />
                          <span className={`dot ${dots.mainnet}`} title={`Mainnet ${dots.mainnet}`} />
                        </span>
                        {href ? (
                          <a className="twin-mark" href={href}>
                            {row.twin}
                          </a>
                        ) : (
                          <span className="twin-mark">—</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="wire-scroll" aria-label="RSS wire">
                <p className="kicker">RSS</p>
                {rows.length === 0 ? <p className="muted">No telegrams for this filter.</p> : null}
                {rows.map((program) => {
                  const stamp = wireStamp(program.ts);
                  const day = stamp?.day ?? "";
                  const showDay = day !== lastDay;
                  if (day) lastDay = day;
                  return (
                    <div key={program.id}>
                      {showDay && day ? <p className="wire-day">— {day} —</p> : null}
                      <Telegram program={program} sources={payload?.sources || {}} />
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <footer className="wall-foot">
          <p>This wall is curated. RippleNet messaging ≠ XRPL settlement.</p>
          <p>No row is live without a source. The desk does not sign.</p>
          <p>
            <a href="/api/wall/rss.xml">RSS</a>
            <span> · </span>
            <a href="https://github.com/Hobie1Kenobi/aether-foundry/blob/main/lab/wall/README.md">
              lab/wall/README.md
            </a>
          </p>
          {payload?.mainnet_note ? <p className="muted">{payload.mainnet_note}</p> : null}
        </footer>
      </div>
    </section>
  );
}
