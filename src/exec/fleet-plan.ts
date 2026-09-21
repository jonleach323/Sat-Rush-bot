/**
 * The fleet treasury's planner — pure, testable, no chain.
 *
 * You fund the fleet by sending USDC and SOL to the PRIMARY wallet. Wallets
 * on single tiles drain unevenly in the short run (a wallet whose tile keeps
 * missing loses 11% a round; the one that hits banks BTC shares, not USDC),
 * so the primary tops up whichever wallet is closest to being unable to play,
 * lowest runway first, and takes back what a wallet no longer needs.
 *
 * Rules (all in base units):
 *  - a wallet below LOW is topped up to TARGET, in order of runway
 *    (balance ÷ per-round need), from the primary's distributable pool
 *    (what it holds above its own TARGET plus the RESERVE);
 *  - a wallet above 2 × TARGET sweeps the excess back to the primary;
 *  - the primary itself is never topped up or swept;
 *  - transfers below `minTransfer` are not worth a fee and are skipped.
 * Same rules for SOL (lamports). Reports the shortfall when the pool runs out
 * so the operator can be told exactly what to deposit.
 */
export interface FleetWalletBalance {
  pubkey: string;
  usdcBase: bigint;
  lamports: number;
  /** Gross USDC this wallet is expected to stake per round (its tile's share). */
  perRoundBase: bigint;
}

export interface FleetPlanParams {
  targetUsdcBase: bigint;
  lowUsdcBase: bigint;
  targetLamports: number;
  lowLamports: number;
  /** Kept on the primary on top of its own target; never distributed. */
  reserveUsdcBase: bigint;
  minTransferUsdcBase: bigint;
  minTransferLamports: number;
}

export interface FleetTransfer {
  from: string;
  to: string;
  asset: "usdc" | "sol";
  /** Base units (USDC 6 dec) or lamports. */
  amount: bigint;
  reason: "top_up" | "sweep";
}

export interface FleetPlan {
  transfers: FleetTransfer[];
  /** USDC the primary lacked to bring every low wallet to target (0 = fully funded). */
  shortfallUsdcBase: bigint;
  shortfallLamports: number;
  /** Rounds the thinnest wallet can still play from its own balance. */
  minRunwayRounds: number;
}

export function planFleet(wallets: readonly FleetWalletBalance[], p: FleetPlanParams): FleetPlan {
  const transfers: FleetTransfer[] = [];
  const primary = wallets[0];
  if (!primary) return { transfers, shortfallUsdcBase: 0n, shortfallLamports: 0, minRunwayRounds: 0 };
  const extras = wallets.slice(1);

  // Sweeps first: they replenish the pool before the top-ups draw on it.
  let poolUsdc = primary.usdcBase - p.targetUsdcBase - p.reserveUsdcBase;
  let poolSol = BigInt(primary.lamports) - BigInt(p.targetLamports);
  for (const w of extras) {
    const excessUsdc = w.usdcBase - 2n * p.targetUsdcBase;
    if (excessUsdc >= p.minTransferUsdcBase) {
      transfers.push({ from: w.pubkey, to: primary.pubkey, asset: "usdc", amount: excessUsdc, reason: "sweep" });
      poolUsdc += excessUsdc;
    }
    const excessSol = BigInt(w.lamports) - 2n * BigInt(p.targetLamports);
    if (excessSol >= BigInt(p.minTransferLamports)) {
      transfers.push({ from: w.pubkey, to: primary.pubkey, asset: "sol", amount: excessSol, reason: "sweep" });
      poolSol += excessSol;
    }
  }

  const runway = (w: FleetWalletBalance): number =>
    w.perRoundBase > 0n ? Number(w.usdcBase / w.perRoundBase) : Number.POSITIVE_INFINITY;
  const lowUsdc = extras.filter((w) => w.usdcBase < p.lowUsdcBase).sort((a, b) => runway(a) - runway(b));
  let shortfallUsdc = 0n;
  for (const w of lowUsdc) {
    const need = p.targetUsdcBase - w.usdcBase;
    if (need < p.minTransferUsdcBase) continue;
    const give = poolUsdc >= need ? need : poolUsdc > p.minTransferUsdcBase ? poolUsdc : 0n;
    if (give > 0n) {
      transfers.push({ from: primary.pubkey, to: w.pubkey, asset: "usdc", amount: give, reason: "top_up" });
      poolUsdc -= give;
    }
    shortfallUsdc += need - give;
  }

  const lowSol = extras.filter((w) => w.lamports < p.lowLamports).sort((a, b) => a.lamports - b.lamports);
  let shortfallSol = 0n;
  for (const w of lowSol) {
    const need = BigInt(p.targetLamports - w.lamports);
    if (need < BigInt(p.minTransferLamports)) continue;
    const give = poolSol >= need ? need : poolSol > BigInt(p.minTransferLamports) ? poolSol : 0n;
    if (give > 0n) {
      transfers.push({ from: primary.pubkey, to: w.pubkey, asset: "sol", amount: give, reason: "top_up" });
      poolSol -= give;
    }
    shortfallSol += need - give;
  }

  const minRunwayRounds = extras.length ? Math.min(...extras.map(runway)) : runway(primary);
  return { transfers, shortfallUsdcBase: shortfallUsdc, shortfallLamports: Number(shortfallSol), minRunwayRounds };
}
