/**
 * RUSH token feed for the V2 economics: the oracle price of RUSH and the
 * measured mint rate (RUSH per USD of gross round volume), both from the
 * public API's `/board` payload. Their product is the token yield `y` that
 * `V2EvContext.tokenYieldPerVolume` prices the token leg with.
 *
 * Why the API and not the chain: RUSH has no Pyth feed (the API marks it from
 * the Orca pool), and the mint program publishes no rule — `RUSH_MINT_USD_YIELD`
 * in facts.ts carries a one-day half-life for exactly that reason, so the
 * live rate is re-measured from the last settled rounds every poll.
 *
 * Fail-closed: a read that fails or fails its bounds holds the last accepted
 * value and drops `live`; a feed that never succeeded reports the configured
 * fallbacks (default 0 → the token leg is worth nothing, the honest prior).
 */

export interface TokenFeedOptions {
  /** `https://api.satrush.io/api/v1` — no trailing slash. */
  apiUrl: string;
  /** Cold-start values (and what a never-live feed reports). */
  fallback: { tokenUsd: number; mintRushPerUsd: number };
  pollMs?: number | undefined;
  /** A value older than this is no longer `live` (default 5 min). */
  maxAgeMs?: number | undefined;
  /** Sanity bounds; anything outside is rejected as a bad quote. */
  bounds?: { tokenUsd: [number, number]; mintRushPerUsd: [number, number] } | undefined;
  fetchJson?: ((url: string) => Promise<unknown>) | undefined;
  now?: (() => number) | undefined;
  log?: ((obj: Record<string, unknown>, msg: string) => void) | undefined;
}

export interface TokenFeedStatus {
  tokenUsd: number;
  mintRushPerUsd: number;
  /** USD of RUSH minted per USD of gross volume. */
  yieldPerVolume: number;
  live: boolean;
  ageMs: number | null;
  /** Rounds the mint rate was averaged over. */
  mintSampleRounds: number;
}

export interface BoardMintSample {
  roundId: number;
  grossUsd: number;
  mintedRush: number;
}

/** What one `/board` read yields, or null per field when it cannot be read. */
export interface ParsedBoard {
  tokenUsd: number | null;
  /** Gross-weighted RUSH per USD across the rounds the payload carries. */
  mintRushPerUsd: number | null;
  samples: BoardMintSample[];
}

const RUSH_DECIMALS = 9;
const USD_DECIMALS = 6;
const DEFAULT_BOUNDS = { tokenUsd: [0.001, 100_000] as [number, number], mintRushPerUsd: [0, 1] as [number, number] };

/**
 * Pure parse of the API board payload. Mint rate = Σ minted / Σ gross over
 * the previous rounds (gross-weighted, so a fat round counts for what it
 * minted), from `previous_round` plus `previous_rounds` when present. Rounds
 * with zero gross are skipped; a rate is only reported with ≥ 1 sample.
 */
export function parseBoardPayload(payload: unknown): ParsedBoard {
  const data = (payload as { data?: unknown } | null)?.["data"] ?? payload;
  const d = (data ?? {}) as Record<string, unknown>;
  const prices = (d["prices"] ?? {}) as Record<string, unknown>;
  const px = Number(prices["token"]);
  const tokenUsd = Number.isFinite(px) && px > 0 ? px : null;

  const rounds: Record<string, unknown>[] = [];
  const prev = d["previous_round"];
  if (prev && typeof prev === "object") rounds.push(prev as Record<string, unknown>);
  const prevs = d["previous_rounds"];
  if (Array.isArray(prevs)) for (const r of prevs) if (r && typeof r === "object") rounds.push(r as Record<string, unknown>);

  const seen = new Set<number>();
  const samples: BoardMintSample[] = [];
  for (const r of rounds) {
    const id = Number(r["id"]);
    const gross = Number(r["total_gross_deployed_usd"]) / 10 ** USD_DECIMALS;
    const minted = Number(r["minted_token_amount"]) / 10 ** RUSH_DECIMALS;
    if (!Number.isInteger(id) || seen.has(id)) continue;
    if (!Number.isFinite(gross) || !(gross > 0) || !Number.isFinite(minted) || minted < 0) continue;
    seen.add(id);
    samples.push({ roundId: id, grossUsd: gross, mintedRush: minted });
  }
  const gross = samples.reduce((a, s) => a + s.grossUsd, 0);
  const minted = samples.reduce((a, s) => a + s.mintedRush, 0);
  return { tokenUsd, mintRushPerUsd: gross > 0 ? minted / gross : null, samples };
}

export class TokenFeed {
  private tokenUsdValue: number;
  private mintRate: number;
  private liveFlag = false;
  private acceptedAtMs: number | null = null;
  private sampleRounds = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastWarn = "";

  constructor(private readonly opts: TokenFeedOptions) {
    this.tokenUsdValue = opts.fallback.tokenUsd;
    this.mintRate = opts.fallback.mintRushPerUsd;
  }

  /** RUSH/USD — the last accepted quote, else the fallback. */
  tokenUsd(): number {
    return this.tokenUsdValue;
  }
  /** RUSH minted per USD of gross volume (whole tokens per dollar). */
  mintRushPerUsd(): number {
    return this.mintRate;
  }
  /**
   * USD of RUSH per USD of gross volume — the V2 token yield. 0 unless both
   * inputs are positive; a stale feed still reports its last value (the
   * caller decides what staleness means via `status().live`).
   */
  yieldPerVolume(): number {
    const y = this.tokenUsdValue * this.mintRate;
    return Number.isFinite(y) && y > 0 ? y : 0;
  }
  status(): TokenFeedStatus {
    const now = (this.opts.now ?? Date.now)();
    const ageMs = this.acceptedAtMs === null ? null : now - this.acceptedAtMs;
    const maxAge = this.opts.maxAgeMs ?? 300_000;
    return {
      tokenUsd: this.tokenUsdValue,
      mintRushPerUsd: this.mintRate,
      yieldPerVolume: this.yieldPerVolume(),
      live: this.liveFlag && ageMs !== null && ageMs <= maxAge,
      ageMs,
      mintSampleRounds: this.sampleRounds,
    };
  }

  async refresh(): Promise<void> {
    let payload: unknown;
    try {
      payload = await (this.opts.fetchJson ?? defaultFetchJson)(`${this.opts.apiUrl}/board`);
    } catch (err) {
      this.liveFlag = false;
      this.warn({ err: String(err) }, "token feed read failed — holding last values");
      return;
    }
    const parsed = parseBoardPayload(payload);
    const bounds = this.opts.bounds ?? DEFAULT_BOUNDS;
    const okPrice = parsed.tokenUsd !== null && within(parsed.tokenUsd, bounds.tokenUsd);
    const okRate = parsed.mintRushPerUsd !== null && within(parsed.mintRushPerUsd, bounds.mintRushPerUsd);
    if (!okPrice || !okRate) {
      this.liveFlag = false;
      this.warn(
        { tokenUsd: parsed.tokenUsd, mintRushPerUsd: parsed.mintRushPerUsd, samples: parsed.samples.length },
        "token feed quote rejected — holding last values",
      );
      return;
    }
    this.tokenUsdValue = parsed.tokenUsd as number;
    this.mintRate = parsed.mintRushPerUsd as number;
    this.sampleRounds = parsed.samples.length;
    this.acceptedAtMs = (this.opts.now ?? Date.now)();
    this.liveFlag = true;
    this.lastWarn = "";
  }

  /** Prime once (errors are held, never thrown), then poll. */
  async start(): Promise<void> {
    await this.refresh();
    const pollMs = this.opts.pollMs ?? 30_000;
    if (pollMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), pollMs);
      this.timer.unref?.();
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private warn(obj: Record<string, unknown>, msg: string): void {
    const key = `${msg}:${JSON.stringify(obj)}`;
    if (key === this.lastWarn) return; // one line per distinct condition, not per poll
    this.lastWarn = key;
    this.opts.log?.(obj, msg);
  }
}

function within(v: number, [lo, hi]: [number, number]): boolean {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as unknown;
}
