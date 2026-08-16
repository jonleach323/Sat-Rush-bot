/**
 * Every economic input, in one place, carrying where it came from.
 *
 * WHY THIS EXISTS
 *
 * Nearly every wrong number in this project has had the same shape. Not bad
 * arithmetic — `evOfAllocation` was verified exact against a closed form — but
 * a bare `number` whose provenance lived in a prose comment, copied into three
 * files, with nothing linking it back to its source and nothing noticing when
 * the source moved:
 *
 *   806_582   iteration-4 field    4 copies; live value 138,624 and climbing
 *   46_553    iteration-4 pool     2 copies; live value $12,836
 *   1.179     unclaimed uplift     3 copies; contested against a 0.246 measurement
 *   100       ticket price         measured on DEVNET, used for mainnet math
 *   0.9333    strike fraction      corrected in ev.ts; 0.0636 survived elsewhere
 *
 * At the call site `0.909` (derived from live config this second) and `1.246`
 * (invented to make a model run) are the same type and read the same. So the
 * three defects are: no provenance, no single source, no uncertainty.
 *
 * A Fact fixes the first two — it cannot be written without declaring where it
 * came from, and it lives here once. `Estimate` in this file fixes the third.
 *
 * RULES
 *  - `derived` is always preferred: read it from chain or SatrushConfig at the
 *    moment of use and it cannot go stale. Most things here should eventually
 *    become derived and disappear from this file.
 *  - `measured` must carry a sample size and a recheck command. If it has a
 *    half-life it is checked against it, and staleness is an error, not a note.
 *  - `assumed` is allowed but must state the risk, and `test/facts.test.ts`
 *    pins the full list so a new one cannot appear quietly.
 *  - A `config` value — one of OUR OWN knobs — is never an economic input.
 *    That circularity has bitten twice: the model concluded hashrate was
 *    worthless because we had configured ourselves not to spend it.
 */

import {
  HASHRATE_PER_TICKET,
  REWARD_MAX_STREAK as SDK_REWARD_MAX_STREAK,
  STRIKE_BOOST_HASHRATE_MULTIPLIER,
  STRIKE_BOOST_ROUNDS,
  TILE_COUNT,
} from "@satrush/client";

/** Pinned in package.json; recorded so a fact's source is reproducible. */
const SDK_VERSION = "@satrush/client@0.1.12";

export type Provenance =
  | {
      /**
       * Read straight out of the official @satrush/client. The strongest kind
       * available: it is the program's own constant, versioned with the SDK,
       * and `test/sdk-parity.test.ts` fails if the two ever diverge. Prefer
       * this over measuring something the SDK already exports.
       */
      kind: "sdk";
      /** Exported symbol it comes from. */
      symbol: string;
      version: string;
    }
  | {
      /** Computed from live chain state or SatrushConfig at use time. Cannot go stale. */
      kind: "derived";
      from: string;
    }
  | {
      kind: "measured";
      /** What was measured, and off what. */
      source: string;
      /** ISO date of the measurement. */
      at: string;
      /** Sample size. A measurement without one is an anecdote. */
      n: number;
      /** Standard error in the same unit as `value`, when known. */
      stderr?: number;
      /**
       * Days after which this must be re-measured. Null means the quantity is
       * structural and does not drift (a program constant, say). Anything that
       * tracks volume needs a short one — the pool and field constants were
       * four days stale across a 4.7x collapse and inverted the farming answer.
       */
      halfLifeDays: number | null;
      /** Command that re-measures it. */
      recheck: string;
    }
  | {
      /** The game's owner said so. Authoritative but unverifiable by us. */
      kind: "stated";
      by: string;
      at: string;
    }
  | {
      /** No source. Permitted, but the risk must be named. */
      kind: "assumed";
      why: string;
      /** What breaks, and in which direction, if this is wrong. */
      risk: string;
    };

export interface Fact<T = number> {
  readonly value: T;
  readonly unit: string;
  readonly provenance: Provenance;
}

const fact = <T>(value: T, unit: string, provenance: Provenance): Fact<T> =>
  Object.freeze({ value, unit, provenance });

// ── facts ────────────────────────────────────────────────────────────────────

/** Board tiles. */
export const TILES = fact(TILE_COUNT, "tiles", {
  kind: "sdk", symbol: "TILE_COUNT", version: SDK_VERSION,
});

/**
 * Share of a Sat Strike bonus that reaches the winner. Replaced an invented
 * 0.9333 that flattered every deploying strategy by ~68 bps of gross.
 */
export const STRIKE_PAYOUT_FRACTION = fact(0.70, "fraction", {
  kind: "stated",
  by: "game owner",
  at: "2026-08-15",
});

/**
 * Multiple on headline `hashrate_earned` once the deferred part is claimed.
 *
 * CONTESTED. PublicDeploySettled carries both `hashrate_earned` and
 * `unclaimed_hashrate_earned`; over 1,875 settles their ratio is 0.179 (median
 * 0.173), giving 1.179. A separate note claimed "measured mean 0.246" with no
 * stated sample and it cannot be reproduced. 1.179 is used because it has the
 * sample size AND is the conservative direction for anything that makes
 * farming look good.
 */
export const UNCLAIMED_HASHRATE_UPLIFT = fact(1.179, "multiple", {
  kind: "measured",
  source: "unclaimed_hashrate_earned / hashrate_earned over PublicDeploySettled",
  at: "2026-08-14",
  n: 1875,
  halfLifeDays: null,
  recheck: "pnpm accrual-ev",
});

/**
 * Hashrate points per vault ticket.
 *
 * Was a DEVNET measurement (n=2) used for every mainnet ticket count. The SDK
 * confirms it, so the cluster mismatch no longer matters.
 */
export const VAULT_HASHRATE_PER_TICKET = fact(
  Number(HASHRATE_PER_TICKET), "raw hashrate/ticket",
  { kind: "sdk", symbol: "HASHRATE_PER_TICKET", version: SDK_VERSION },
);

/**
 * Cap on the streak multiplier.
 *
 * Was ASSUMED — asserted as "the program cap" with the highest streak actually
 * observed at 28, while every farming estimate scaled linearly with it. The SDK
 * exports it, so it is now sourced. Note `hashrateReward()` does NOT apply the
 * clamp itself; the caller must, and `hashrateRawPerUsd` does.
 */
export const REWARD_MAX_STREAK = fact(SDK_REWARD_MAX_STREAK, "rounds", {
  kind: "sdk", symbol: "REWARD_MAX_STREAK", version: SDK_VERSION,
});

/** Hashrate multiplier during the post-Sat-Strike window. */
export const STRIKE_HASHRATE_MULTIPLIER = fact(
  Number(STRIKE_BOOST_HASHRATE_MULTIPLIER), "multiple",
  { kind: "sdk", symbol: "STRIKE_BOOST_HASHRATE_MULTIPLIER", version: SDK_VERSION },
);

/**
 * Rounds the strike hashrate boost covers, EXCLUSIVE of the strike round
 * itself — measured against the public API the boosted span is 241 rounds
 * inclusive, which agrees with this.
 */
export const STRIKE_BOOST_WINDOW_ROUNDS = fact(STRIKE_BOOST_ROUNDS, "rounds", {
  kind: "sdk", symbol: "STRIKE_BOOST_ROUNDS", version: SDK_VERSION,
});

/**
 * Fraction of the epoch field funded by hashrate banked before the iteration
 * opened, and so insensitive to current volume.
 */
export const EPOCH_FIELD_BANKED_SHARE = fact(0.3, "fraction", {
  kind: "assumed",
  why: "idle hashrate across miners is roughly 3x one iteration's draw",
  risk: "sets the floor under the field when volume falls; too low makes a "
    + "shrinking pool look like a rising share, which flatters farming",
});

/**
 * Uplift on modelled epoch EV from per-wallet dedup — winners are drawn without
 * replacement and a drawn wallet's whole block leaves the pool.
 *
 * Sensitive to CONCENTRATION, not just size, so it needs re-measuring whenever
 * the field's shape moves. The live field is 52 wallets against 21 winner
 * slots, a far more favourable regime than the 127 this was measured on.
 */
export const EPOCH_DEDUP_UPLIFT = fact(1.45, "multiple", {
  kind: "measured",
  source: "21-draw simulation against the live entry distribution",
  at: "2026-08-15",
  n: 127,
  halfLifeDays: 3,
  recheck: "pnpm epoch-uplift",
});

/** Ticket count at the last COMPLETE epoch draw. Anchors field projection. */
export const EPOCH_LAST_CLOSE_TICKETS = fact(806_582, "tickets", {
  kind: "measured",
  source: "EpochDrawTriggered, iteration 4",
  at: "2026-08-15",
  n: 1,
  halfLifeDays: 3,
  recheck: "pnpm epoch-history",
});

/** Pool at that same draw, USD. */
export const EPOCH_LAST_CLOSE_POOL_USD = fact(46_553, "USD", {
  kind: "measured",
  source: "EpochVault USD + BTC legs at the iteration-4 draw",
  at: "2026-08-15",
  n: 1,
  halfLifeDays: 3,
  recheck: "pnpm epoch-history",
});

/** Mainnet slot time, for turning slot counts into wall clock. */
export const SLOT_SECONDS = fact(0.4, "seconds", {
  kind: "measured",
  source: "Solana mainnet target slot time",
  at: "2026-08-01",
  n: 1,
  halfLifeDays: null,
  recheck: "compare block times over a few hundred slots",
});

/** Everything above, for the staleness sweep and the provenance test. */
export const ALL_FACTS: Readonly<Record<string, Fact<number>>> = Object.freeze({
  TILES,
  STRIKE_HASHRATE_MULTIPLIER,
  STRIKE_BOOST_WINDOW_ROUNDS,
  STRIKE_PAYOUT_FRACTION,
  UNCLAIMED_HASHRATE_UPLIFT,
  VAULT_HASHRATE_PER_TICKET,
  REWARD_MAX_STREAK,
  EPOCH_FIELD_BANKED_SHARE,
  EPOCH_DEDUP_UPLIFT,
  EPOCH_LAST_CLOSE_TICKETS,
  EPOCH_LAST_CLOSE_POOL_USD,
  SLOT_SECONDS,
});

// ── staleness ────────────────────────────────────────────────────────────────

export interface Staleness {
  name: string;
  ageDays: number;
  halfLifeDays: number;
  fact: Fact<number>;
}

/**
 * Measured facts past their half-life. These are not warnings to skim — the
 * two epoch constants going four days stale across a 4.7x volume collapse is
 * the single error that made farming look profitable.
 */
export function staleFacts(now = new Date()): Staleness[] {
  const out: Staleness[] = [];
  for (const [name, f] of Object.entries(ALL_FACTS)) {
    const p = f.provenance;
    if (p.kind !== "measured" || p.halfLifeDays === null) continue;
    const ageDays = (now.getTime() - new Date(p.at).getTime()) / 86_400_000;
    if (ageDays > p.halfLifeDays) {
      out.push({ name, ageDays, halfLifeDays: p.halfLifeDays, fact: f });
    }
  }
  return out.sort((a, b) => b.ageDays / b.halfLifeDays - a.ageDays / a.halfLifeDays);
}

/** Facts with no source behind them. */
export function assumedFacts(): { name: string; fact: Fact<number> }[] {
  return Object.entries(ALL_FACTS)
    .filter(([, f]) => f.provenance.kind === "assumed")
    .map(([name, f]) => ({ name, fact: f }));
}

/** One-line provenance, for logs and script headers. */
export function describe(name: string, f: Fact<number>): string {
  const p = f.provenance;
  const tag =
    p.kind === "sdk" ? `${p.symbol} from ${p.version}`
    : p.kind === "derived" ? `derived from ${p.from}`
    : p.kind === "stated" ? `stated by ${p.by} on ${p.at}`
    : p.kind === "assumed" ? `ASSUMED — ${p.why}`
    : `measured ${p.at} (n=${p.n}${p.stderr !== undefined ? `, se=${p.stderr}` : ""})`;
  return `${name} = ${f.value} ${f.unit} — ${tag}`;
}

// ── estimates ────────────────────────────────────────────────────────────────

/**
 * A number with an error bar, because a point estimate is not a result.
 *
 * This exists because a realized -25.45% over 193 single-tile deploys was
 * reported as a finding when the standard error on that sample was +/-28.6
 * points. z was -0.61. The sample could not distinguish the strategy from
 * doing nothing, and nothing in the code or the output said so.
 */
export interface Estimate {
  value: number;
  /** Standard error, same unit as `value`. */
  stderr: number;
  /** Observations behind it. */
  n: number;
}

/** Is `e` distinguishable from `against` at `sigmas` standard errors? */
export function significant(e: Estimate, against = 0, sigmas = 2): boolean {
  return e.stderr > 0 && Math.abs(e.value - against) >= sigmas * e.stderr;
}

/** Observations needed to resolve an effect the size of `e.value` at `sigmas`. */
export function samplesNeeded(e: Estimate, sigmas = 2): number {
  if (!(Math.abs(e.value) > 0) || !(e.stderr > 0) || !(e.n > 0)) return Infinity;
  // stderr scales as 1/sqrt(n), so n_needed = n * (sigmas*stderr / |value|)^2.
  return Math.ceil(e.n * Math.pow((sigmas * e.stderr) / Math.abs(e.value), 2));
}

/**
 * Render an estimate so it cannot be quoted without its error bar. Anything
 * that fails the significance test says so in the same breath as the number.
 */
export function formatEstimate(e: Estimate, unit = "", against = 0): string {
  const sig = significant(e, against);
  const need = sig ? "" : `, need ~${samplesNeeded(e).toLocaleString()}`;
  return `${e.value >= 0 ? "+" : ""}${e.value.toFixed(2)}${unit} ` +
    `± ${e.stderr.toFixed(2)}${unit} (n=${e.n}${need})` +
    `${sig ? "" : " NOT SIGNIFICANT"}`;
}
