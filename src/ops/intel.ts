/**
 * Derived intelligence: the aggregates that answer "is there an edge here at
 * all, and is the model telling the truth about it".
 *
 * Everything here is computed from tables the bot already writes — no new
 * ingest, no third-party API. The point is that the raw rows (competitor
 * deploys, occupancy snapshots, settlements) already contain the answers to
 * the questions that actually drive strategy, and nothing was ever asking
 * them:
 *
 * - Board uniformity decides whether a sniper can work at all. A field of
 *   automations blanketing all 21 tiles leaves no emptiest-tile edge, and no
 *   amount of timing fixes that.
 * - Rival fire timing is the one thing we can see that public trackers cannot,
 *   because we log the slot each rival's deploy landed in. It tells us who is
 *   reacting to us versus committing before us.
 * - Modeled-vs-realized edge is the only honest check on the EV model. A model
 *   that ranks well but is biased high will still bleed through a threshold.
 *
 * All queries are bounded by a round window so cost stays flat as the DB grows.
 */
import { TILES_COUNT } from "../ingest/decode.js";
import type { StateDb } from "../state/db.js";
import { baseToUsd } from "../units.js";

/** Mask with all 21 tiles set — the automation signature. */
export const FULL_BOARD_MASK = (1 << TILES_COUNT) - 1;

/**
 * χ² critical value at p=0.05 for 20 degrees of freedom (21 tiles − 1). Above
 * this, tile draws are not plausibly uniform and a bias is worth chasing.
 */
export const CHI2_CRITICAL_05_DF20 = 31.41;

/**
 * Coefficient of variation below which a board is "effectively uniform" —
 * i.e. no tile is cheap enough for tile selection to matter. 5% is well inside
 * the noise of a board that ~30 automations have each spread evenly.
 */
export const UNIFORM_COV_THRESHOLD = 0.05;

/**
 * Net edge a passive all-21-tile deployer earns, in bps. The game's structural
 * edge is negative (only the true rake leaves the system); what makes passive
 * play positive is SATS appreciating against the fee that funds it. This is the
 * bar the sniper has to clear to be worth running at all — if realized edge
 * sits below it, spreading flat is strictly better.
 *
 * Sourced from the public fee/yield decomposition; re-measure as conditions
 * move — BTC appreciation is doing the work here, and it is not a constant.
 */
export const PASSIVE_BENCHMARK_BPS = 85;

export interface IntelJson {
  /** How many recent rounds the windowed sections cover. */
  windowRounds: number;
  field: {
    rounds: number;
    deploys: number;
    distinctRivals: number;
    avgDeploysPerRound: number;
    /** Fraction of rival deploys flagged is_automation. */
    automationShare: number;
    /** Fraction of rival deploys covering all 21 tiles — the "no edge" signal. */
    fullBoardShare: number;
    avgRivalStakeUsd: number;
  };
  uniformity: {
    samples: number;
    /** Median coefficient of variation of final tile stakes. */
    medianCov: number | null;
    /** Share of rounds that settled effectively uniform (no tile edge). */
    uniformShare: number | null;
  };
  fairness: {
    samples: number;
    counts: number[];
    chiSquare: number;
    degreesOfFreedom: number;
    criticalValue05: number;
    looksUniform: boolean;
  } | null;
  rivalTiming: {
    samples: number;
    /** Slots before round end that rivals commit (higher = earlier). */
    p10: number;
    p50: number;
    p90: number;
    /** Share committing LATER than our fire offset — the ones that can see us. */
    afterUsShare: number | null;
  } | null;
  calibration: {
    landed: number;
    /** Mean modeled edge, bps of gross deploy. */
    modeledBps: number | null;
    /** Realized edge over the same deploys, bps. */
    realizedBps: number | null;
    benchmarkBps: number;
  };
  strike: {
    rounds: number;
    strikes: number;
    roundsSinceLast: number | null;
  };
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(p * sortedAsc.length)));
  return sortedAsc[rank - 1] as number;
}

/** Coefficient of variation (σ/μ); null when the board is empty. */
export function coefficientOfVariation(values: number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return null;
  const variance =
    values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Pearson χ² of observed winning-tile counts against a uniform expectation.
 * Returns null when no tile has been observed.
 */
export function tileChiSquare(counts: number[]): { chiSquare: number; expected: number } | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const expected = total / counts.length;
  let chi = 0;
  for (const c of counts) chi += ((c - expected) * (c - expected)) / expected;
  return { chiSquare: chi, expected };
}

export interface IntelOptions {
  /** Rounds of history the windowed sections cover. */
  windowRounds: number;
  /** Our current fire offset, for the "who fires after us" split. */
  fireOffsetSlots: number;
}

export function buildIntel(db: StateDb, opts: IntelOptions): IntelJson {
  const window = Math.max(1, Math.trunc(opts.windowRounds));
  const latest =
    db.queryOne<{ id: number | null }>("SELECT MAX(id) AS id FROM rounds")?.id ?? 0;
  const since = latest - window;

  // ── Field composition ─────────────────────────────────────────────────────
  const f = db.queryOne<{
    deploys: number;
    rivals: number;
    rounds: number;
    autos: number;
    fullBoard: number;
    avgAmount: number | null;
  }>(
    `SELECT COUNT(*) AS deploys,
            COUNT(DISTINCT authority) AS rivals,
            COUNT(DISTINCT round_id) AS rounds,
            COALESCE(SUM(is_automation), 0) AS autos,
            COALESCE(SUM(CASE WHEN mask = ? THEN 1 ELSE 0 END), 0) AS fullBoard,
            AVG(CAST(amount AS REAL)) AS avgAmount
     FROM competitor_deploys WHERE round_id > ?`,
    FULL_BOARD_MASK,
    since,
  ) ?? { deploys: 0, rivals: 0, rounds: 0, autos: 0, fullBoard: 0, avgAmount: null };

  const share = (n: number, d: number): number => (d > 0 ? n / d : 0);
  const field = {
    rounds: f.rounds,
    deploys: f.deploys,
    distinctRivals: f.rivals,
    avgDeploysPerRound: share(f.deploys, f.rounds),
    automationShare: share(f.autos, f.deploys),
    fullBoardShare: share(f.fullBoard, f.deploys),
    // amount is stored as base units in TEXT; AVG gives a float of base units.
    avgRivalStakeUsd: f.avgAmount ? baseToUsd(BigInt(Math.round(f.avgAmount))) : 0,
  };

  // ── Board uniformity (final snapshot per round) ───────────────────────────
  const finals = db.query<{ stakes_json: string }>(
    `SELECT stakes_json FROM occupancy_snapshots s
     WHERE s.round_id > ?
       AND s.slot = (SELECT MAX(slot) FROM occupancy_snapshots WHERE round_id = s.round_id)`,
    since,
  );
  const covs: number[] = [];
  for (const row of finals) {
    let stakes: unknown;
    try {
      stakes = JSON.parse(row.stakes_json);
    } catch {
      continue; // a malformed snapshot must not take the panel down
    }
    if (!Array.isArray(stakes)) continue;
    const cov = coefficientOfVariation(stakes.map((v) => Number(v)));
    if (cov !== null && Number.isFinite(cov)) covs.push(cov);
  }
  covs.sort((a, b) => a - b);
  const uniformity = {
    samples: covs.length,
    medianCov: covs.length > 0 ? percentile(covs, 0.5) : null,
    uniformShare:
      covs.length > 0
        ? covs.filter((c) => c <= UNIFORM_COV_THRESHOLD).length / covs.length
        : null,
  };

  // ── Winning-tile fairness (all observed history — more samples is better) ─
  const tileRows = db.query<{ winning_tile: number; c: number }>(
    `SELECT winning_tile, COUNT(*) AS c FROM rounds
     WHERE winning_tile IS NOT NULL GROUP BY winning_tile`,
  );
  const counts = new Array<number>(TILES_COUNT).fill(0);
  for (const r of tileRows) {
    if (r.winning_tile >= 0 && r.winning_tile < TILES_COUNT) counts[r.winning_tile] = r.c;
  }
  const chi = tileChiSquare(counts);
  const fairness = chi
    ? {
        samples: counts.reduce((a, b) => a + b, 0),
        counts,
        chiSquare: chi.chiSquare,
        degreesOfFreedom: TILES_COUNT - 1,
        criticalValue05: CHI2_CRITICAL_05_DF20,
        looksUniform: chi.chiSquare <= CHI2_CRITICAL_05_DF20,
      }
    : null;

  // ── Rival fire timing ─────────────────────────────────────────────────────
  // Slots between a rival's deploy landing and the round's cutoff. This is the
  // view no public tracker has: it separates rivals who commit blind and early
  // from rivals who wait and react to a board we have already moved.
  const leads = db
    .query<{ lead: number }>(
      `SELECT (r.end_slot - c.slot) AS lead
       FROM competitor_deploys c JOIN rounds r ON r.id = c.round_id
       WHERE c.round_id > ? AND r.end_slot IS NOT NULL AND c.slot > 0`,
      since,
    )
    .map((r) => r.lead)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const rivalTiming =
    leads.length > 0
      ? {
          samples: leads.length,
          p10: percentile(leads, 0.1),
          p50: percentile(leads, 0.5),
          p90: percentile(leads, 0.9),
          // Smaller lead = closer to the cutoff = later than us.
          afterUsShare: leads.filter((l) => l < opts.fireOffsetSlots).length / leads.length,
        }
      : null;

  // ── Model calibration ─────────────────────────────────────────────────────
  const cal = db.queryOne<{
    n: number;
    modeled: number | null;
    deployed: number | null;
    won: number | null;
  }>(
    `SELECT COUNT(*) AS n,
            AVG(d.ev_expected / CAST(d.amount AS REAL)) AS modeled,
            SUM(CAST(d.amount AS REAL)) AS deployed,
            SUM(CAST(s.won_usd AS REAL)) AS won
     FROM my_deploys d JOIN settlements s ON s.round_id = d.round_id
     WHERE d.status = 'landed' AND CAST(d.amount AS REAL) > 0`,
  ) ?? { n: 0, modeled: null, deployed: null, won: null };
  const calibration = {
    landed: cal.n,
    modeledBps: cal.modeled != null ? cal.modeled * 10_000 : null,
    realizedBps:
      cal.deployed && cal.deployed > 0 && cal.won != null
        ? ((cal.won - cal.deployed) / cal.deployed) * 10_000
        : null,
    benchmarkBps: PASSIVE_BENCHMARK_BPS,
  };

  // ── Strike cadence ────────────────────────────────────────────────────────
  const s = db.queryOne<{ rounds: number; strikes: number; lastStrike: number | null }>(
    `SELECT COUNT(*) AS rounds,
            COALESCE(SUM(strike_triggered), 0) AS strikes,
            MAX(CASE WHEN strike_triggered = 1 THEN id END) AS lastStrike
     FROM rounds`,
  ) ?? { rounds: 0, strikes: 0, lastStrike: null };

  return {
    windowRounds: window,
    field,
    uniformity,
    fairness,
    rivalTiming,
    calibration,
    strike: {
      rounds: s.rounds,
      strikes: s.strikes,
      roundsSinceLast: s.lastStrike != null && latest > 0 ? latest - s.lastStrike : null,
    },
  };
}
