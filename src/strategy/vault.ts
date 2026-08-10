/**
 * Hashrate-funded raffle EV + ticket selection (shared by the 1-BTC and epoch
 * vaults).
 *
 * Payout unification — both vaults reduce to the SAME expectation:
 *
 *   E[winnings] = (myTickets / totalTickets) · poolValue
 *
 * - 1-BTC vault: one winning ticket drawn uniformly takes the whole prize, so
 *   E = P(hold winner)·prize = (myTickets/total)·prize.
 * - Epoch vault: up to 21 winners drawn WITHOUT replacement share the pool by a
 *   steep rank curve (EPOCH_REWARD_CURVE_BPS: 32% / 14% / 8% / … ). Each of the
 *   21 slots is equally likely to be mine, so the rank weights cancel out of the
 *   mean: E = (myTickets/total)·Σ(weights)·pool. The curve changes VARIANCE, not
 *   the mean — but Σ(weights) = 9_000 bps, so only 90% of the pool is
 *   distributed, and `buildVaultContext` discounts the pool accordingly.
 *
 * The edge is timing: value per ticket ∝ poolValue/(others+k), so the fewer
 * tickets already committed by the field, the more each of ours is worth. The
 * selector therefore buys only while the marginal ticket clears the opportunity
 * cost of a hashrate point — which self-implements "sit out crowded draws, strike
 * when the field's hashrate is exhausted": a crowded field dilutes every ticket
 * below the threshold and the selector buys nothing.
 *
 * Hashrate is the currency (1 point = 1 ticket; see instructions.ts). Its
 * opportunity cost is `hashrateValueUsd` — the USD value of holding a point for a
 * better future draw. Raising it makes the bot pickier (waits for thinner
 * fields); 0 makes it enter whenever any positive share is on offer.
 */

export type VaultKind = "one_btc" | "epoch";

/**
 * Epoch reward curve in bps of the pool, by winner rank — the program's
 * EPOCH_REWARD_CURVE_BPS (confirmed by the owner). Steeply top-heavy: rank 1
 * takes 32%, the top five take 63%, the bottom eleven ~1.55% each.
 *
 * IMPORTANT: it sums to 9_000 bps, NOT 10_000 — only 90% of the pool is paid
 * out per iteration; the remaining 10% ROLLS OVER into the next iteration
 * (confirmed by the owner, same mechanic as Sat Strike). Expected winnings for
 * THIS iteration must be discounted by that fraction or vault EV is overstated
 * by ~11%.
 *
 * Note the rollover is a buffer, not a rake: at steady state pool = F/0.9 for
 * fee inflow F, so distribution per iteration (0.9 · pool) equals F exactly —
 * nothing leaks from the player pool. It just means pools run ~11% larger than
 * the per-iteration inflow, and a long-idle vault carries accumulated value.
 * Do NOT "simplify" the discount away: it is correct for the per-iteration
 * decision, which is the only decision this selector makes.
 *
 * The rank weights themselves do NOT affect the mean: each of the 21 slots is
 * equally likely to be ours, so E[winnings] = ticketShare · Σ(weights) · pool.
 * The curve only shapes variance — which the top-heavy shape makes severe.
 */
export const EPOCH_REWARD_CURVE_BPS: readonly number[] = [
  3200, 1400, 800, 500, 400, 200, 200, 200, 200, 200,
  155, 155, 155, 155, 155, 155, 154, 154, 154, 154, 154,
];

/** Fraction of the epoch pool actually distributed (0.90 — see the curve). */
export const EPOCH_PAYOUT_FRACTION =
  EPOCH_REWARD_CURVE_BPS.reduce((a, b) => a + b, 0) / 10_000;

/**
 * Expected epoch winnings as a fraction of the pool, for ticket share `p`.
 *
 * Winners are deduped BY WALLET (owner-confirmed): when a wallet is drawn, ALL
 * of its tickets leave the pool, so one wallet can win at most once. Payoff is
 * therefore CONCAVE in tickets, not linear — buying more raises P(selected) and
 * improves expected rank, but can never win twice. At p→1 you take rank 1 only
 * (32% of the pool), not the full 90%.
 *
 *   E/pool = Σ_{i=1..21} p·(1-p)^(i-1) · w_i        (first selected at rank i)
 *
 * For small p this reduces to p·Σw = 0.9p, matching the naive linear model; the
 * models diverge sharply above ~5% share (10% → 73% of linear, 30% → 55%).
 *
 * Deliberately CONSERVATIVE: it assumes the pool barely shrinks between draws.
 * In reality each rival winner's tickets are removed too, which lifts our share
 * on later draws — so true EV is somewhat higher. Understating vault EV is the
 * safe direction when this feeds Kelly sizing.
 *
 * Not modeled: if participants_count <= 21 every entrant wins something, which
 * is a materially better regime. Refine once recon shows typical participation.
 */
export function epochWinFraction(p: number): number {
  const share = Math.max(0, Math.min(1, p));
  let acc = 0;
  for (let i = 0; i < EPOCH_REWARD_CURVE_BPS.length; i++) {
    acc += share * Math.pow(1 - share, i) * ((EPOCH_REWARD_CURVE_BPS[i] ?? 0) / 10_000);
  }
  return acc;
}

export interface VaultTicketContext {
  kind: VaultKind;
  /** Total prize pool in USD (prize BTC valued in USD; epoch adds pool USD). */
  poolValueUsd: number;
  /** Tickets already committed by everyone else this iteration. */
  othersTickets: number;
  /** Tickets we already hold this iteration (sunk — not re-charged). */
  myTickets: number;
  /** Hashrate points we can still spend (1 point = 1 ticket). */
  hashrateAvailable: number;
  /** Opportunity cost of one hashrate point, in USD (the pickiness knob). */
  hashrateValueUsd: number;
  /** Hard cap on total tickets we hold in one iteration (risk bound). */
  maxTickets: number;
}

export interface VaultDecision {
  /** Additional tickets to buy now (0 = sit out). */
  tickets: number;
  /** Expected profit of the buy in USD (winnings gain − hashrate cost). */
  evUsd: number;
  /** Our win-share probability after the buy. */
  winShareAfter: number;
  reason:
    | "ok"
    | "no_pool"
    | "no_hashrate"
    | "field_too_crowded"
    | "cap_reached";
}

/** USD value of a BTC balance expressed in base units. */
export function btcBaseToUsd(
  btcBaseUnits: number,
  btcDecimals: number,
  btcUsd: number,
): number {
  if (!Number.isInteger(btcDecimals) || btcDecimals < 0) {
    throw new RangeError(`btcDecimals must be a non-negative integer: ${btcDecimals}`);
  }
  return (btcBaseUnits / 10 ** btcDecimals) * btcUsd;
}

export interface VaultContextInput {
  kind: VaultKind;
  poolValueUsd: number;
  /** iteration.total_tickets — everyone's tickets, including ours. */
  totalTickets: number;
  /** Our tickets already committed this iteration (0 if we have no entry). */
  myTickets: number;
  /** Spendable hashrate POINTS (any budget fraction already applied). */
  hashratePointsAvailable: number;
  /**
   * Program cost of one ticket in hashrate points. Measured on devnet = 100
   * (not 1 — see FINDINGS.md / vault-buy experiment). The selector works in
   * ticket units, so we convert points→tickets here.
   */
  ticketPriceHashrate: number;
  /** Opportunity value of one hashrate POINT, in USD. */
  hashrateValueUsdPerPoint: number;
  maxTickets: number;
}

/**
 * Adapt on-chain totals into the selector's context:
 * - total_tickets → others' tickets (subtract our sunk holdings, clamp at 0);
 * - spendable hashrate points → affordable tickets (÷ ticket price);
 * - per-point opportunity value → per-ticket cost (× ticket price).
 */
export function buildVaultContext(input: VaultContextInput): VaultTicketContext {
  if (!Number.isFinite(input.ticketPriceHashrate) || input.ticketPriceHashrate <= 0) {
    throw new RangeError(`ticketPriceHashrate must be positive: ${input.ticketPriceHashrate}`);
  }
  const affordableTickets = Math.floor(
    Math.max(0, input.hashratePointsAvailable) / input.ticketPriceHashrate,
  );
  return {
    kind: input.kind,
    // RAW pool — the epoch payout fraction lives inside epochWinFraction()'s
    // curve sum, so discounting here would double-count it.
    poolValueUsd: input.poolValueUsd,
    othersTickets: Math.max(0, input.totalTickets - input.myTickets),
    myTickets: input.myTickets,
    hashrateAvailable: affordableTickets,
    hashrateValueUsd: input.hashrateValueUsdPerPoint * input.ticketPriceHashrate,
    maxTickets: input.maxTickets,
  };
}

/**
 * E[winnings] for a ticket holding (see file header).
 * - epoch: concave in share (per-wallet dedup) — epochWinFraction(p)·pool.
 *   The 90% payout fraction is already inside the curve sum, so the pool passed
 *   in must be the RAW pool (do not pre-discount, or it double-counts).
 * - one_btc: single winner drawn from all tickets → linear share·prize.
 */
export function expectedWinningsUsd(
  myTickets: number,
  othersTickets: number,
  poolValueUsd: number,
  kind: VaultKind = "epoch",
): number {
  const total = myTickets + othersTickets;
  if (total <= 0) return 0;
  const p = myTickets / total;
  return kind === "epoch" ? epochWinFraction(p) * poolValueUsd : p * poolValueUsd;
}

function validate(ctx: VaultTicketContext): void {
  const nums: [string, number][] = [
    ["poolValueUsd", ctx.poolValueUsd],
    ["othersTickets", ctx.othersTickets],
    ["myTickets", ctx.myTickets],
    ["hashrateAvailable", ctx.hashrateAvailable],
    ["hashrateValueUsd", ctx.hashrateValueUsd],
    ["maxTickets", ctx.maxTickets],
  ];
  for (const [name, v] of nums) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`invalid ${name}: ${v}`);
  }
}

/**
 * Greedy ticket count: buy while the next ticket's marginal expected winnings
 * exceed the hashrate opportunity cost. E[winnings] is concave in our ticket
 * count, so greedy is optimal. Bounded by available hashrate and the per-
 * iteration cap.
 */
export function selectVaultTickets(ctx: VaultTicketContext): VaultDecision {
  validate(ctx);
  const winShare = (mine: number) =>
    mine + ctx.othersTickets <= 0 ? 0 : mine / (mine + ctx.othersTickets);

  if (ctx.poolValueUsd <= 0) {
    return { tickets: 0, evUsd: 0, winShareAfter: winShare(ctx.myTickets), reason: "no_pool" };
  }
  const budget = Math.min(
    Math.floor(ctx.hashrateAvailable),
    Math.floor(ctx.maxTickets) - ctx.myTickets,
  );
  if (budget <= 0) {
    return {
      tickets: 0,
      evUsd: 0,
      winShareAfter: winShare(ctx.myTickets),
      reason: ctx.hashrateAvailable < 1 ? "no_hashrate" : "cap_reached",
    };
  }

  const base = expectedWinningsUsd(ctx.myTickets, ctx.othersTickets, ctx.poolValueUsd, ctx.kind);
  let buy = 0;
  while (buy < budget) {
    const cur = expectedWinningsUsd(
      ctx.myTickets + buy,
      ctx.othersTickets,
      ctx.poolValueUsd,
      ctx.kind,
    );
    const next = expectedWinningsUsd(
      ctx.myTickets + buy + 1,
      ctx.othersTickets,
      ctx.poolValueUsd,
      ctx.kind,
    );
    if (next - cur <= ctx.hashrateValueUsd) break; // marginal ticket not worth it
    buy++;
  }

  if (buy === 0) {
    return {
      tickets: 0,
      evUsd: 0,
      winShareAfter: winShare(ctx.myTickets),
      reason: "field_too_crowded",
    };
  }

  const gain =
    expectedWinningsUsd(ctx.myTickets + buy, ctx.othersTickets, ctx.poolValueUsd, ctx.kind) -
    base;
  const evUsd = gain - buy * ctx.hashrateValueUsd;
  const reason = buy === budget ? "cap_reached" : "ok";
  return { tickets: buy, evUsd, winShareAfter: winShare(ctx.myTickets + buy), reason };
}
