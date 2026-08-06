/**
 * EV-scaled Jito tip. Blockspace near the cutoff is an auction: on a fat round
 * you want to outbid rival snipers for inclusion; on a thin one you want to tip
 * the minimum. So the tip is a base floor plus a fraction of the round's modeled
 * expected profit, converted USD→lamports via a SOL price, and hard-clamped to a
 * ceiling. evFraction = 0 disables the scaling (flat base tip = prior behavior).
 */
export interface TipConfig {
  /** Floor — always tip at least this (lamports). */
  baseLamports: number;
  /** Ceiling — never tip more than this (lamports). */
  maxLamports: number;
  /** Fraction of the round's EV to bid as tip (0 = flat base tip). */
  evFraction: number;
  /** SOL price (USD) used to convert EV (USD) into lamports. */
  solUsd: number;
}

/**
 * Tip for a deploy with modeled EV `evBaseUnits` (USD base units, float).
 * Returns lamports in [baseLamports, maxLamports]. Negative/zero EV → base.
 */
export function scaledTipLamports(evBaseUnits: number, cfg: TipConfig): number {
  const evUsd = Math.max(0, evBaseUnits) / 1e6;
  const fromEv =
    cfg.evFraction > 0 && cfg.solUsd > 0
      ? Math.floor((evUsd * cfg.evFraction * 1e9) / cfg.solUsd)
      : 0;
  const tip = cfg.baseLamports + fromEv;
  return Math.max(cfg.baseLamports, Math.min(cfg.maxLamports, tip));
}
