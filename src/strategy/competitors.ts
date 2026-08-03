/**
 * Competitor intelligence + anti-collision.
 *
 * We already record every rival's deploy (competitor_deploys). This turns that
 * history into per-wallet profiles, classifies who is a *sniper* (fires late,
 * few tiles) vs a *spreader* (the owner's crank / broad automations) vs a whale
 * vs a manual player, and predicts where rivals will pile THIS round.
 *
 * That prediction feeds the occupancy the selector optimizes against (via the
 * predictor's inflow term), so water-filling naturally routes AROUND tiles
 * rivals will crowd — the collision that, in a parimutuel, dilutes every
 * sniper's edge toward the rake. Avoiding collisions is how you make sniping
 * unprofitable for the other bots while keeping your own edge.
 */
import { maskToTiles } from "../adapter/mask.js";
import { TILES_COUNT } from "./ev.js";

export interface CompetitorDeployRow {
  round_id: number;
  authority: string;
  mask: number;
  amount: string; // base units
  is_automation: number; // 0 | 1
  slot: number;
}

export interface RoundWindow {
  /** Deploy cutoff slot (Board.end_slot) for the round. */
  end: number;
}

export type RivalKind = "sniper" | "spreader" | "whale" | "manual";

export interface RivalProfile {
  authority: string;
  deploys: number;
  avgTiles: number;
  avgAmountBase: bigint;
  /** How often each tile is chosen, length 21 (fraction of this rival's deploys). */
  tileFreq: number[];
  /** Avg slots BEFORE cutoff the rival fires (smaller = later = more sniper-like). */
  avgLatenessSlots: number | null;
  isAutomation: boolean;
  kind: RivalKind;
}

export interface ClassifyConfig {
  /** ≤ this many tiles counts as "concentrated". */
  sniperMaxTiles: number;
  /** Fires within this many slots of cutoff counts as "late". */
  sniperMaxLatenessSlots: number;
  /** ≥ this many tiles counts as a broad "spreader" (crank-like). */
  spreaderMinTiles: number;
  /** ≥ this avg size (base units) counts as a whale. */
  whaleMinAmountBase: bigint;
}

export const DEFAULT_CLASSIFY: ClassifyConfig = {
  sniperMaxTiles: 5,
  sniperMaxLatenessSlots: 6,
  spreaderMinTiles: 12,
  whaleMinAmountBase: 100_000_000n, // $100
};

function classify(p: Omit<RivalProfile, "kind">, cfg: ClassifyConfig): RivalKind {
  if (p.isAutomation || p.avgTiles >= cfg.spreaderMinTiles) return "spreader";
  const late = p.avgLatenessSlots !== null && p.avgLatenessSlots <= cfg.sniperMaxLatenessSlots;
  if (late && p.avgTiles <= cfg.sniperMaxTiles) return "sniper";
  if (p.avgAmountBase >= cfg.whaleMinAmountBase) return "whale";
  return "manual";
}

/** Build per-wallet profiles from recent competitor deploys. */
export function profileCompetitors(
  rows: CompetitorDeployRow[],
  windows: Map<number, RoundWindow>,
  cfg: ClassifyConfig = DEFAULT_CLASSIFY,
): Map<string, RivalProfile> {
  interface Acc {
    deploys: number;
    tileHits: number[];
    tilesTotal: number;
    amountTotal: bigint;
    latenessTotal: number;
    latenessCount: number;
    automation: boolean;
  }
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const a =
      acc.get(r.authority) ??
      {
        deploys: 0,
        tileHits: new Array<number>(TILES_COUNT).fill(0),
        tilesTotal: 0,
        amountTotal: 0n,
        latenessTotal: 0,
        latenessCount: 0,
        automation: false,
      };
    const tiles = maskToTiles(r.mask);
    a.deploys += 1;
    a.tilesTotal += tiles.length;
    for (const t of tiles) if (t >= 0 && t < TILES_COUNT) a.tileHits[t]! += 1;
    a.amountTotal += BigInt(r.amount);
    a.automation = a.automation || r.is_automation === 1;
    const w = windows.get(r.round_id);
    if (w) {
      a.latenessTotal += Math.max(0, w.end - r.slot);
      a.latenessCount += 1;
    }
    acc.set(r.authority, a);
  }

  const out = new Map<string, RivalProfile>();
  for (const [authority, a] of acc) {
    const base: Omit<RivalProfile, "kind"> = {
      authority,
      deploys: a.deploys,
      avgTiles: a.tilesTotal / a.deploys,
      avgAmountBase: a.amountTotal / BigInt(a.deploys),
      tileFreq: a.tileHits.map((h) => h / a.deploys),
      avgLatenessSlots: a.latenessCount > 0 ? a.latenessTotal / a.latenessCount : null,
      isAutomation: a.automation,
    };
    out.set(authority, { ...base, kind: classify(base, cfg) });
  }
  return out;
}

export interface RivalInflowConfig {
  /** Ignore rivals seen fewer than this many times (drop one-offs). */
  minDeploys: number;
}

export const DEFAULT_INFLOW: RivalInflowConfig = { minDeploys: 2 };

/**
 * Predicted additional per-tile stake from rivals THIS round (base units,
 * length 21), to add to the occupancy the selector optimizes against:
 * - snipers pile on the currently-emptiest tiles (same logic as us) → their
 *   expected size lands there, so we predict collisions exactly where naive
 *   water-filling would want to go, and route around them;
 * - spreaders/automations distribute by their historical tile frequency (the
 *   crank's broad flood).
 * Manual/whale rivals are left out — their placement isn't predictable enough
 * to bias our allocation without adding noise.
 */
export function predictRivalInflow(
  profiles: Iterable<RivalProfile>,
  visibleStakes: bigint[],
  cfg: RivalInflowConfig = DEFAULT_INFLOW,
): bigint[] {
  if (visibleStakes.length !== TILES_COUNT) {
    throw new RangeError(`visibleStakes must have ${TILES_COUNT} entries`);
  }
  const inflow = new Array<bigint>(TILES_COUNT).fill(0n);
  // Tiles ranked emptiest-first (where snipers go), by current visible stake.
  const emptiest = [...Array(TILES_COUNT).keys()].sort((x, y) => {
    const sx = visibleStakes[x]!;
    const sy = visibleStakes[y]!;
    return sx === sy ? x - y : sx < sy ? -1 : 1;
  });

  for (const p of profiles) {
    if (p.deploys < cfg.minDeploys) continue;
    if (p.kind === "sniper") {
      const k = Math.max(1, Math.min(TILES_COUNT, Math.round(p.avgTiles)));
      const per = p.avgAmountBase / BigInt(k);
      for (let i = 0; i < k; i++) {
        const tile = emptiest[i]!;
        inflow[tile] = (inflow[tile] ?? 0n) + per;
      }
    } else if (p.kind === "spreader") {
      // distribute expected size by historical tile frequency
      const freqSum = p.tileFreq.reduce((s, f) => s + f, 0) || 1;
      for (let t = 0; t < TILES_COUNT; t++) {
        const share = (p.tileFreq[t] ?? 0) / freqSum;
        inflow[t] = (inflow[t] ?? 0n) + BigInt(Math.round(Number(p.avgAmountBase) * share));
      }
    }
    // whale / manual: not predicted (too noisy to bias allocation)
  }
  return inflow;
}

/** Count active rivals by kind (for /vault-style ops visibility + decisions). */
export function fieldSummary(
  profiles: Iterable<RivalProfile>,
  minDeploys = 2,
): Record<RivalKind, number> {
  const out: Record<RivalKind, number> = { sniper: 0, spreader: 0, whale: 0, manual: 0 };
  for (const p of profiles) if (p.deploys >= minDeploys) out[p.kind] += 1;
  return out;
}
