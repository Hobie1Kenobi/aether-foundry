"use client";

import { useMemo, useState } from "react";
import {
  CLOCK,
  TWIN_HREF,
  WALL_TICKER_LOOP_S,
  X_POST_LABEL,
  filterPrograms,
  type AmendmentDots,
  type Dot,
  type PressHeadline,
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

type TickerItem =
  | { key: string; kind: "headline"; mark: string; title: string; href: string }
  | { key: string; kind: "mark" }
  | { key: string; kind: "amendment"; name: string; text: string };

function tickerHeadline(row: PressHeadline): { mark: string; title: string } {
  if (row.label === X_POST_LABEL) return { mark: "X", title: `${row.actor} — ${row.title}` };
  return { mark: "PRESS", title: row.title };
}

function tickerItems(headlines: PressHeadline[], amendments: Record<string, AmendmentDots> | undefined): TickerItem[] {
  const stories: TickerItem[] = headlines.map((row) => {
    const line = tickerHeadline(row);
    return {
      key: `h-${row.id}`,
      kind: "headline",
      mark: line.mark,
      title: line.title,
      href: row.url,
    };
  });
  const clock: TickerItem[] = CLOCK.map((row) => ({
    key: `a-${row.name}`,
    kind: "amendment",
    name: row.name,
    text: tickerLine(row.name, amendments?.[row.name]),
  }));
  if (stories.length === 0) return clock;
  return [...stories, { key: "clock-mark", kind: "mark" }, ...clock];
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

function TickerBit({
  item,
  amendment,
  onAmendment,
  copy = false,
}: {
  item: TickerItem;
  amendment: string;
  onAmendment: (name: string) => void;
  copy?: boolean;
}) {
  if (item.kind === "mark") {
    return (
      <span className={copy ? "ticker-mark ticker-copy" : "ticker-mark"} aria-hidden={copy || undefined}>
        AMENDMENT CLOCK
      </span>
    );
  }
  if (item.kind === "headline") {
    return (
      <a
        className={copy ? "ticker-link ticker-copy" : "ticker-link"}
        href={item.href}
        target="_blank"
        rel="noreferrer"
        tabIndex={copy ? -1 : undefined}
        aria-hidden={copy || undefined}
      >
        <span className="ticker-press">{item.mark} ·</span> {item.title}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={copy ? "ticker-btn ticker-copy" : "ticker-btn"}
      aria-pressed={copy ? undefined : amendment === item.name}
      tabIndex={copy ? -1 : undefined}
      aria-hidden={copy || undefined}
      onClick={() => onAmendment(item.name)}
    >
      {item.text}
    </button>
  );
}

function PressWire({ headlines }: { headlines: PressHeadline[] }) {
  let lastDay = "";
  return (
    <div className="press-wire">
      <p className="kicker">PRESS HEADLINES · NOT ON-CHAIN</p>
      {headlines.map((row) => {
        const stamp = wireStamp(row.ts);
        const day = stamp?.day ?? "";
        const showDay = Boolean(day) && day !== lastDay;
        if (day) lastDay = day;
        return (
          <div key={row.id}>
            {showDay ? <p className="wire-day">— {day} —</p> : null}
            <article className="telegram press-headline" id={row.id}>
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
              <h3 className="wire-actor">{row.actor}</h3>
              <p className="wire-chips">
                <span className="wall-chip">
                  <span className="stage-dot press" aria-hidden="true" />
                  {row.stage}
                </span>
                <span className="wall-chip">not on-chain</span>
              </p>
              <p className="wire-claim">{row.title}</p>
              <p className="wire-links">
                <a href={row.url} target="_blank" rel="noreferrer">
                  {row.source_title}
                </a>
                <span> · </span>
                <span>{row.label}</span>
              </p>
            </article>
          </div>
        );
      })}
    </div>
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

  const headlines = payload?.headlines ?? [];
  const ticker = tickerItems(headlines, payload?.amendments);
  const headlineRows = useMemo(() => {
    if (filter !== "all" && filter !== "press") return [];
    if (amendment) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return headlines;
    return headlines.filter((row) => `${row.actor} ${row.title}`.toLowerCase().includes(needle));
  }, [headlines, filter, query, amendment]);

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
            <div
              className="wall-ticker"
              aria-label={
                headlines.length
                  ? "Live Ripple press headlines and amendment ticker"
                  : "Amendment ticker"
              }
            >
              <div className="wall-ticker-track" style={{ animationDuration: `${WALL_TICKER_LOOP_S}s` }}>
                {ticker.map((item) => (
                  <TickerBit
                    key={item.key}
                    item={item}
                    amendment={amendment}
                    onAmendment={(name) => setAmendment((current) => (current === name ? "" : name))}
                  />
                ))}
                {ticker.map((item) => (
                  <TickerBit
                    key={`${item.key}-copy`}
                    item={item}
                    amendment={amendment}
                    onAmendment={(name) => setAmendment((current) => (current === name ? "" : name))}
                    copy
                  />
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
                {headlineRows.length ? <PressWire headlines={headlineRows} /> : null}
                {rows.length === 0 && headlineRows.length === 0 ? (
                  <p className="muted">No telegrams for this filter.</p>
                ) : null}
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
          <p>Press headlines are Cointelegraph titles and X posts. They are not on-chain reads.</p>
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
