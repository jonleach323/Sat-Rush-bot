# Simulation findings

`pnpm sim` — 10,000 synthetic rounds per scenario × 2 mask-split semantics ×
5 strategies (18s). The bot rows run the **production** strategy code
(`selectAllocation`, `predictFinalOccupancy`, the EV model) — no test forks;
`test/sim.test.ts` asserts module identity. Mechanics mirror the
devnet-measured pipeline (docs/devnet-findings.md): 800 bps deploy legs,
even split across masked tiles, 1200 bps pot leg, uniform 1/21 winning
tile, parimutuel payout by winning-tile stake share. Common random numbers
pair every strategy against identical rival schedules and winning tiles.

Bot budget in all runs: $1 ladder quantum, $5 max/round, $1 on-chain min.

## Headline results (mean net USD per round, 10k rounds)

| scenario           | split    | water_filling | k_emptiest(3) | single_emptiest | random_tile | static_tile |
|--------------------|----------|--------------:|--------------:|----------------:|------------:|------------:|
| sparse_automations | even     |     **+0.29** |         −0.02 |           −3.91 |       −4.04 |       −4.19 |
| busy_board         | even     |     **+9.33** |         +2.29 |           +0.22 |       −1.50 |       −2.43 |
| copycats           | even     |     **+1.75** |         +0.26 |           −3.64 |       −3.78 |       −3.86 |
| herding            | even     |     **+2.73** |         +0.34 |           −3.46 |       −3.65 |       −3.73 |
| whale_dominated    | even     |    **+22.59** |         +4.15 |           +0.64 |       −0.22 |       −0.12 |
| empty_board        | even     |  **0 (skip)** |         −0.96 |           −4.81 |       −4.81 |       −4.81 |
| sparse_automations | per_tile |         +2.71 |     **+4.24** |           +0.45 |       −2.05 |       −3.37 |
| busy_board         | per_tile |    **+21.54** |         +4.55 |           +8.51 |       +0.44 |       −2.19 |
| copycats           | per_tile |         +0.17 |     **+2.87** |           −1.08 |       −2.54 |       −3.58 |
| herding            | per_tile |     **+7.84** |         +4.44 |           +0.79 |       −1.61 |       −3.14 |
| whale_dominated    | per_tile |    **+18.35** |         +6.46 |           +3.10 |       +1.63 |       +1.97 |
| empty_board        | per_tile |  **0 (skip)** |         −0.96 |           −4.81 |       −4.81 |       −4.81 |

Full table with fire rate, hit rate, and σ: run `pnpm sim`.

## Findings

1. **Water-filling ≥ single-emptiest in all 12 scenario/split combinations**
   (vitest-asserted with paired CRN). Under the measured even-split
   semantics it is the *only* strategy that is positive in every populated
   scenario, and the margin is largest exactly where the edge should be:
   boards with real money to chase (busy: +$9.3/rd, whales: +$22.6/rd on a
   $5 budget).

2. **Coverage is the mechanism.** Water-filling's hit rate runs ~23–24% (it
   typically spreads $1 quanta over ~5 profitable tiles) vs ~4.8% (1/21)
   for single-tile strategies — more, smaller wins with far better mean and
   comparable variance per dollar.

3. **Empty-board discipline matters.** Solo play returns your own pot minus
   20% of fees: single-tile baselines bleed −$4.81/round on an empty board.
   Water-filling's marginal-EV stop simply refuses to fire (0% fire rate,
   $0). This directly validates the orchestrator's skip behavior on idle
   devnet rounds. (k_emptiest bleeds only −$0.96 because the min-deploy
   floor caps its stake at $1 — the fallback should still not be run
   unattended on dead boards.)

4. **Herding: randomization + spreading beat deterministic tile-picking.**
   Against a pack of 5 deterministic emptiest-bots sharing a stale view,
   the deterministic single-emptiest baseline picks the exact tile the pack
   piles onto: −$3.46/rd. Randomized k_emptiest(3) (+$0.34) and
   water-filling (+$2.73) avoid the collision — a $3.8–6.2/round swing
   purely from tie-break randomization and multi-tile spreading.

5. **Robust under open question 1.** Under per_tile semantics pots are much
   larger (multi-tile rivals commit gross × n), and water-filling stays
   positive everywhere while still dominating single-emptiest.
   k_emptiest(3) sometimes beats it there (sparse, copycats) because
   water-filling's EV model assumes its own even-split allocation — if
   experiments ever confirm per_tile, re-tune before trusting water-filling
   margins. Under the *measured* even-split reality, water-filling is
   strictly the right default.

6. **Instrument constraint worth remembering:** on-chain `deploy_public`
   takes (mask, amount) with an even split — the deployable space is
   "uniform over a chosen tile set". Water-filling's greedy quanta almost
   always land one-per-tile anyway (equal allocations), so the support-set
   choice survives translation to a mask intact.

## Chosen defaults (now in .env.example)

| parameter          | value           | rationale                                                        |
|--------------------|-----------------|------------------------------------------------------------------|
| STRATEGY           | `water_filling` | dominant or tied in every scenario; only strategy that skips -EV |
| K_EMPTIEST         | `3`             | herding scenario: k=1 deterministic is the collision victim; k=3 randomized recovers ~$3.8/rd; larger k dilutes tile quality |
| STAKE_LADDER_USD   | `1`             | $1 quantum = finest granularity above the on-chain $1 min deploy; lets water-filling spread across ~5 tiles at a $5 cap |
| MAX_PER_ROUND_USD  | `5` (devnet)    | enough budget for meaningful spread; scale with bankroll on mainnet |
| FIRE_OFFSET_SLOTS  | `4`             | measured devnet land latency is 0–3 slots after fire (median 1); 4 = 1 slot to land + 3 cushion on public RPC. Compress toward 2 when colocated with Yellowstone (see exec timing report) |
| STAKE_SEMANTICS    | `raw`           | matches all devnet observations; strategy verified robust under the alternative |

## Not modeled (future work)

Streak multipliers (open question 5 — hashrate curve unmeasured), the
strike jackpot overlay, reactive rivals beyond fixed-latency copycats,
hidden-pool occupancy (private-deployment era), and the v1 linear
occupancy extrapolation's early-round overshoot (predictor is swappable
via `OccupancyPredictor`).
