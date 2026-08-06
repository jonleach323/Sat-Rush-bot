/**
 * Growth-optimal (Kelly) bet sizing for a single round.
 *
 * The water-filling selector maximizes expected *value* — it keeps adding stake
 * while marginal EV > 0. For a one-shot linear-utility bet that is optimal, but
 * for a bankroll played over many high-variance rounds it OVER-bets: betting to
 * the EV-maximizing point maximizes the mean while quietly maximizing variance,
 * which lowers long-run compounded growth (and, past the growth-optimal point,
 * can make it negative). Kelly sizes to the fraction of bankroll that maximizes
 * expected log-growth instead — the definition of "max extraction" for a
 * repeated game with reinvestment.
 *
 * A round has 21 equally-likely outcomes (tile i wins). `returns[i]` is the
 * return on total stake if tile i wins: (payout_i − cost)/cost. The Kelly
 * fraction f* maximizes  Σ_i (1/21)·log(1 + f·returns[i])  over f ∈ [0, 1).
 * The 1/21 is a constant factor and drops out of the root-finding.
 *
 * Callers apply a fractional multiplier (half-Kelly is standard) and clamp the
 * result against the on-chain min and the risk cap — this module is pure math.
 */

/** d/df of Σ log(1 + f·r): Σ r/(1 + f·r). Zero at the growth-optimal f. */
function growthDerivative(returns: number[], f: number): number {
  let sum = 0;
  for (const r of returns) sum += r / (1 + f * r);
  return sum;
}

/**
 * Full-Kelly fraction of bankroll to stake this round, in [0, 1).
 *
 * Returns 0 when the aggregate edge is non-positive (Σ returns ≤ 0). When the
 * edge is so strong the feasibility bound binds (a tile pays enough that you'd
 * want to bet everything), returns the largest feasible fraction just shy of
 * the point where a losing outcome would wipe the bankroll.
 */
export function kellyFraction(returns: number[]): number {
  if (returns.length === 0) return 0;

  // Non-positive aggregate edge → don't bet (the derivative at 0 is Σ returns).
  if (growthDerivative(returns, 0) <= 0) return 0;

  // Feasibility: 1 + f·r > 0 for every outcome. The binding one is the most
  // negative return (a full-stake loss is r = −1 → f < 1). Stay just inside it.
  let minReturn = Infinity;
  for (const r of returns) if (r < minReturn) minReturn = r;
  const fMax = minReturn < 0 ? Math.min(1, -1 / minReturn) - 1e-9 : 1;
  if (fMax <= 0) return 0;

  // If growth is still increasing at the feasible ceiling, size to the ceiling.
  if (growthDerivative(returns, fMax) >= 0) return fMax;

  // Otherwise the growth-optimal fraction is the interior root — bisect.
  let lo = 0;
  let hi = fMax;
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2;
    const g = growthDerivative(returns, mid);
    if (g > 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-9) break;
  }
  return (lo + hi) / 2;
}
