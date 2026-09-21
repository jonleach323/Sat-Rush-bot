/**
 * Reconciliation tripwires. After a round settles, and periodically for the
 * wallet, compare what actually happened against what our model expected.
 * Any mismatch beyond tolerance flips the kill switch — converting a
 * surviving model/parsing bug into a halt instead of compounding losses.
 *
 * Honesty note (see AUDIT.md residual risks): the DIRECTION checks below are
 * exact and cannot false-trip — they are the load-bearing part. The
 * MAGNITUDE check is coarse: the round pays winners in both USD and BTC
 * vault shares and the exact USD/BTC split is not fully characterized
 * (CLAUDE.md open items), so magnitude drift uses a generous tolerance and
 * is a sanity bound on scale/sign errors, not a fee-level audit.
 */

export interface RoundOutcomeInputs {
  /** Our even-split stake on the winning tile, base units (0 if uncovered). */
  ourStakeOnWinnerBase: bigint;
  /** Round total net stake on the winning tile (deployed_usd_on_winning_tile). */
  totalStakeOnWinnerBase: bigint;
  /** Round net pot available to winners (deployed_usd_amount), base units. */
  potBase: bigint;
  /** Realized USD credited by settlement (won_usd_amount), base units. */
  realizedWonUsdBase: bigint;
  /** Realized vault shares credited (won_shares_amount). */
  realizedWonShares: bigint;
  /** Magnitude tolerance as a fraction (e.g. 0.25). */
  toleranceFrac: number;
  /** Absolute floor (base units) below which magnitude drift is ignored. */
  floorBase: bigint;
}

export interface ReconResult {
  ok: boolean;
  reason: string | null;
  modeledUsdBase: bigint;
  driftFrac: number;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

export function reconcileRoundOutcome(inp: RoundOutcomeInputs): ReconResult {
  const covered = inp.ourStakeOnWinnerBase > 0n;

  // ── exact direction checks (cannot false-trip) ─────────────────────────────
  if (!covered && (inp.realizedWonUsdBase > 0n || inp.realizedWonShares > 0n)) {
    return {
      ok: false,
      reason: "paid on a tile we did not cover — parse/model error",
      modeledUsdBase: 0n,
      driftFrac: Infinity,
    };
  }
  if (covered && inp.potBase > 0n && inp.realizedWonUsdBase === 0n && inp.realizedWonShares === 0n) {
    return {
      ok: false,
      reason: "covered the winning tile but received nothing",
      modeledUsdBase: 0n,
      driftFrac: Infinity,
    };
  }

  // ── coarse magnitude check ─────────────────────────────────────────────────
  // Modeled USD win = pot · (ourStakeOnWinner / totalStakeOnWinner).
  const modeled =
    covered && inp.totalStakeOnWinnerBase > 0n
      ? (inp.potBase * inp.ourStakeOnWinnerBase) / inp.totalStakeOnWinnerBase
      : 0n;
  const denom = inp.realizedWonUsdBase > inp.floorBase ? inp.realizedWonUsdBase : inp.floorBase;
  const driftFrac = denom === 0n ? 0 : Number(abs(modeled - inp.realizedWonUsdBase)) / Number(denom);

  if (driftFrac > inp.toleranceFrac && abs(modeled - inp.realizedWonUsdBase) > inp.floorBase) {
    return {
      ok: false,
      reason: `payout magnitude drift ${(driftFrac * 100).toFixed(0)}% > tol ${(inp.toleranceFrac * 100).toFixed(0)}%`,
      modeledUsdBase: modeled,
      driftFrac,
    };
  }
  return { ok: true, reason: null, modeledUsdBase: modeled, driftFrac };
}

export interface WalletDriftInputs {
  /** Expected net change to wallet USDC since baseline (base units, signed). */
  expectedDeltaBase: bigint;
  /** Actual net change to wallet USDC since baseline (base units, signed). */
  actualDeltaBase: bigint;
  /** Absolute tolerance (base units) — must exceed fee/rent noise. */
  toleranceBase: bigint;
}

export interface WalletDriftResult {
  ok: boolean;
  reason: string | null;
  unexplainedBase: bigint;
}

/**
 * Coarse wallet-drift tripwire: trips only when actual USDC left the wallet
 * FASTER than the ledger explains, beyond an absolute tolerance. Directional
 * (an unexpected inflow never trips) and generous by design — it catches an
 * unexpected drain/bug, not fee-level noise.
 */
export function reconcileWalletDrift(inp: WalletDriftInputs): WalletDriftResult {
  // Negative delta = outflow. Unexplained outflow = how much MORE left than expected.
  const unexplained = inp.expectedDeltaBase - inp.actualDeltaBase; // >0 means more left than expected
  if (unexplained > inp.toleranceBase) {
    return {
      ok: false,
      reason: `wallet dropped ${unexplained} base units more than expected (tol ${inp.toleranceBase})`,
      unexplainedBase: unexplained,
    };
  }
  return { ok: true, reason: null, unexplainedBase: unexplained };
}

// ── V2 ────────────────────────────────────────────────────────────────────────

export interface RoundOutcomeInputsV2 {
  /** Our gross deploy this round (base units) — what deploy_public took. */
  ourGrossBase: bigint;
  /** Tiles our mask covered (1–21). */
  tilesCovered: number;
  /** Whether the winning tile was one of ours. */
  coveredWinner: boolean;
  /** Losing-tile refund, bps of gross (V2_LOSING_TILE_REFUND_BPS). */
  refundBps: number;
  /** Realized USD credited by settlement (won_usd_amount), base units. */
  realizedWonUsdBase: bigint;
  /** Realized sats-vault shares (won_shares_amount). */
  realizedWonShares: bigint;
  /** Realized RUSH vault shares (won_token_shares). */
  realizedWonTokenShares: bigint;
  /** The round minted RUSH (Round.minted_token_amount > 0) — every deployer gets a leg. */
  roundMintedToken: boolean;
  /** Sat Strike fired this round: the USD leg carries a bonus share on top of the refund. */
  strikeTriggered: boolean;
  /** Relative tolerance on the refund (rounding is per tile: a few base units). */
  toleranceFrac: number;
  /** Absolute floor (base units) below which drift is ignored. */
  floorBase: bigint;
}

/**
 * V2 settlement tripwire. The refund rule is exact — `usd_earned = 0.89 ×
 * gross on losing tiles`, verified per deployment on mainnet (FINDINGS
 * E-v2-live) — so unlike V1 the magnitude check here is tight, and every
 * leg has a direction that cannot false-trip:
 *   USD    = refund of the losing tiles (+ a strike bonus share, if fired);
 *   BTC    > 0 iff we covered the winner (the swap goes to the winning tile);
 *   RUSH   > 0 whenever the round minted (losers get the 16% leg too).
 */
export function reconcileRoundOutcomeV2(inp: RoundOutcomeInputsV2): ReconResult {
  const n = inp.tilesCovered;
  if (!Number.isInteger(n) || n < 1 || n > 21) {
    return { ok: false, reason: `tilesCovered out of range: ${n}`, modeledUsdBase: 0n, driftFrac: Infinity };
  }
  if (inp.ourGrossBase <= 0n) {
    return { ok: false, reason: "no gross recorded for a settled round", modeledUsdBase: 0n, driftFrac: Infinity };
  }
  // Direction: BTC shares only for the winning tile.
  if (!inp.coveredWinner && inp.realizedWonShares > 0n) {
    return { ok: false, reason: "BTC shares on a round whose winner we did not cover — parse/model error", modeledUsdBase: 0n, driftFrac: Infinity };
  }
  if (inp.coveredWinner && inp.realizedWonShares === 0n) {
    return { ok: false, reason: "covered the winning tile but received no BTC shares", modeledUsdBase: 0n, driftFrac: Infinity };
  }
  // Direction: the RUSH leg reaches every deployer of a minting round.
  if (inp.roundMintedToken && inp.realizedWonTokenShares === 0n) {
    return { ok: false, reason: "round minted RUSH but our settlement carries no token shares", modeledUsdBase: 0n, driftFrac: Infinity };
  }
  if (!inp.roundMintedToken && inp.realizedWonTokenShares > 0n) {
    return { ok: false, reason: "token shares on a round that minted nothing", modeledUsdBase: 0n, driftFrac: Infinity };
  }
  // Magnitude: the refund is exact per losing tile (even split, floor).
  const perTile = inp.ourGrossBase / BigInt(n);
  const losingTiles = BigInt(inp.coveredWinner ? n - 1 : n);
  const modeled = (perTile * losingTiles * BigInt(Math.round(inp.refundBps))) / 10_000n;
  const diff = inp.realizedWonUsdBase - modeled;
  const denom = modeled > inp.floorBase ? modeled : inp.floorBase;
  const driftFrac = denom === 0n ? 0 : Number(abs(diff)) / Number(denom);
  // A strike can only ADD to the USD leg; below the refund is always wrong.
  const tooLow = diff < 0n && driftFrac > inp.toleranceFrac && abs(diff) > inp.floorBase;
  const tooHigh = !inp.strikeTriggered && diff > 0n && driftFrac > inp.toleranceFrac && diff > inp.floorBase;
  if (tooLow || tooHigh) {
    return {
      ok: false,
      reason: `refund drift ${(driftFrac * 100).toFixed(1)}% ${tooLow ? "below" : "above"} the ${inp.refundBps / 100}% rule (tol ${(inp.toleranceFrac * 100).toFixed(1)}%)`,
      modeledUsdBase: modeled,
      driftFrac,
    };
  }
  return { ok: true, reason: null, modeledUsdBase: modeled, driftFrac };
}

