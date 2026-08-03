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
 * - Epoch vault: up to 21 winners drawn WITHOUT replacement split the pool. Each
 *   winning ticket is equally likely to be mine, so E[my winning tickets] =
 *   21·myTickets/total, and whatever the per-rank split, the pool is shared
 *   among the 21, averaging pool/21 per winner → E = (21·myTickets/total)·
 *   (pool/21) = (myTickets/total)·pool. The rank split changes variance, not
 *   the mean.
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
    poolValueUsd: input.poolValueUsd,
    othersTickets: Math.max(0, input.totalTickets - input.myTickets),
    myTickets: input.myTickets,
    hashrateAvailable: affordableTickets,
    hashrateValueUsd: input.hashrateValueUsdPerPoint * input.ticketPriceHashrate,
    maxTickets: input.maxTickets,
  };
}

/** E[winnings] = ticket fraction · pool (see file header). */
export function expectedWinningsUsd(
  myTickets: number,
  othersTickets: number,
  poolValueUsd: number,
): number {
  const total = myTickets + othersTickets;
  if (total <= 0) return 0;
  return (myTickets / total) * poolValueUsd;
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

  const base = expectedWinningsUsd(ctx.myTickets, ctx.othersTickets, ctx.poolValueUsd);
  let buy = 0;
  while (buy < budget) {
    const cur = expectedWinningsUsd(ctx.myTickets + buy, ctx.othersTickets, ctx.poolValueUsd);
    const next = expectedWinningsUsd(
      ctx.myTickets + buy + 1,
      ctx.othersTickets,
      ctx.poolValueUsd,
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
    expectedWinningsUsd(ctx.myTickets + buy, ctx.othersTickets, ctx.poolValueUsd) - base;
  const evUsd = gain - buy * ctx.hashrateValueUsd;
  const reason = buy === budget ? "cap_reached" : "ok";
  return { tickets: buy, evUsd, winShareAfter: winShare(ctx.myTickets + buy), reason };
}
