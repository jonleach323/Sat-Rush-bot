/**
 * Priority-fee estimation: RPC getRecentPrioritizationFees (when the
 * endpoint supports it) blended 50/50 with an EMA of CU prices observed on
 * landed program transactions, clamped to the configured [MIN, MAX].
 */
import type { Connection, PublicKey } from "@solana/web3.js";

export interface FeeEstimatorConfig {
  minMicroLamports: number;
  maxMicroLamports: number;
  /** EMA smoothing for observed landed fees (default 0.2). */
  emaAlpha?: number | undefined;
}

export class FeeEstimator {
  private ema: number | null = null;
  private rpcEstimate: number | null = null;
  private readonly alpha: number;

  constructor(private readonly cfg: FeeEstimatorConfig) {
    if (cfg.minMicroLamports > cfg.maxMicroLamports) {
      throw new RangeError("fee clamp: min > max");
    }
    this.alpha = cfg.emaAlpha ?? 0.2;
    if (this.alpha <= 0 || this.alpha > 1) throw new RangeError("emaAlpha in (0,1]");
  }

  /** Feed a CU price (micro-lamports) seen on a landed program transaction. */
  observeLandedCuPrice(microLamports: number): void {
    if (!Number.isFinite(microLamports) || microLamports < 0) return;
    this.ema = this.ema === null ? microLamports : this.alpha * microLamports + (1 - this.alpha) * this.ema;
  }

  /** Query the RPC priority-fee API; keeps the last estimate on failure. */
  async refreshFromRpc(
    connection: Connection,
    lockedWritableAccounts: PublicKey[] = [],
  ): Promise<void> {
    try {
      const fees = await connection.getRecentPrioritizationFees({
        lockedWritableAccounts,
      });
      const values = fees
        .map((f) => f.prioritizationFee)
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
      if (values.length === 0) {
        this.rpcEstimate = 0;
        return;
      }
      // p90 of the per-slot minimum landing fee for these locked accounts:
      // a deploy competes for the Round write lock in the cutoff slot, the
      // busiest slot of the round, so the median slot understates it.
      this.rpcEstimate = values[Math.floor(values.length * 0.9)] ?? values.at(-1)!;
    } catch {
      /* endpoint without the API or transient failure — keep last estimate */
    }
  }

  /** Current estimate, clamped to [MIN, MAX] micro-lamports per CU. */
  currentMicroLamportsPerCu(): number {
    const parts = [this.rpcEstimate, this.ema].filter(
      (v): v is number => v !== null,
    );
    const blended =
      parts.length === 0 ? this.cfg.minMicroLamports : parts.reduce((a, b) => a + b, 0) / parts.length;
    return Math.round(
      Math.min(this.cfg.maxMicroLamports, Math.max(this.cfg.minMicroLamports, blended)),
    );
  }
}

/**
 * Extract the setComputeUnitPrice value from raw instruction datas of a
 * landed transaction (ComputeBudget layout: [3, u64 micro-lamports LE]).
 */
export function cuPriceFromInstructionDatas(datas: Uint8Array[]): number | null {
  for (const data of datas) {
    if (data.length === 9 && data[0] === 3) {
      return Number(Buffer.from(data).readBigUInt64LE(1));
    }
  }
  return null;
}
