# Plan: maximizing EV off Sat Rush V2 (2026-09-21)

Grounded in SAT-RUSH-MODEL.md and `pnpm ev-map` / `pnpm measure-remaining`.
The edge is small, bounded by the vault pools, and lives in one place: a
21-tile blanket at the streak cap during the 240-round post-strike boost
windows (22% of rounds). Everything else is either "hold" or "never".

## What the platform can pay, at most

```
  epoch vault    ~$28k pool per 10.7-day iteration → 90% paid to 21 wallets, one prize each   ≈ $2.4k/day theoretical
  1-BTC vault    1 BTC per 56–115 days                                                          ≈ $0.7–1.4k/day theoretical
  strike / sats  parimutuel — return your own fee legs pro rata, no edge
  staking        29% of 108 bps of volume ≈ $166/day across ALL stakers at $130k/day
  vault carry    leavers' 10% exit fees: 0.30%/day (sats) · 0.24%/day (token) on what you hold, decaying
```

A fleet that holds ~half of the vault tickets takes roughly half of the two
pools: **~$1–1.5k/day is the realistic ceiling of positive EV on this
platform at today's volume**, and it scales with volume, not with capital.
Capital beyond ~$10k buys nothing but variance.

## Phase 0 — prove the send path (day 1, $1 at risk)

1. Fund the primary wallet with USDC and SOL; `EXECUTION_MODE=mainnet`,
   `MAINNET_CONFIRM=yes`, `MAX_PER_ROUND_USD=1`, `DAILY_LOSS_CAP_USD=5`.
2. Fire one $1 blanket, self-settle it, watch the reconcile line match the
   89% refund and the BTC/RUSH share legs (RUNBOOK § 9). Buy one epoch and
   one 1-BTC ticket with the hashrate. Claim the USD. That is the whole V2
   send path exercised once.
3. Register the affiliate tag in the app (10 bps rebate on the fleet's
   own volume, 1:1 to grubstake).

## Phase 1 — presence (day 1–2, ≤ $8/day)

4. Ramp to the streak cap: 99 consecutive rounds of a $1 blanket, 2.5 h,
   at most $2.25 of negative EV. Then hold it: a $1 blanket every round
   (the 2-round grace allows every third round, but a $1 stake every round
   also earns the strike/sats legs pro rata). Cost ceiling $7.42/day.
5. Verify in the skip log that the selector's streak-option credit keeps
   the $1 presence deploy firing when the round's board EV is negative. If
   it does not, this is the one build item: a `PRESENCE_MIN_USD` floor
   that deploys the minimum blanket whenever the streak would otherwise
   break. Nothing else in the plan works without the cap held.

## Phase 2 — the boost windows (from day 2)

6. In the 240 rounds after every strike (`Round.is_hashrate_boosted`, the
   bot's multiplier is now on the SDK's round count), deploy the maximum
   blanket. Measured EV +2.5% to +3.5% of gross per round on iteration
   16's pace, positive in every bracket.
7. Size per wallet at **$10–25 per boosted round**. Above that the wallet's
   ticket share climbs past ~5% of the field and its epoch value collapses
   toward one prize per iteration; the hashrate then flows to 1-BTC
   tickets, which dilute more slowly. `pnpm ev-map <stake>` prints the
   toll at the stake you mean; keep the boosted blanket's EV above +1%.
8. Spend hashrate as it lands; the engine ranks epoch vs 1-BTC by
   marginal ticket value each tick. Never let it sit: it is only worth
   anything as tickets.

## Phase 3 — the fleet (week 1)

9. Add wallets under the primary's affiliate tag (`WALLET_PATHS`), up to
   21. Each holds its own streak at the cap (step 4) and its own boosted
   blanket (step 7). The epoch draw pays one prize per wallet, so wallets
   are the only way to scale the epoch leg; the 1-BTC leg is shared and
   does not scale with wallets.
10. Aggregate boosted volume of ~$200/round across the fleet is the point
    where the fleet holds about half the vault tickets and the marginal
    ticket is worth half the average. Stop adding size there.

## Standing rules (every day)

11. Never single tiles, at any streak, any board.
12. Hold every sats and token share. Claim USD always. Claim shares only to
    release deferred hashrate, pro rata, when the tickets it buys are
    worth more than the 10% fee on that fraction.
13. RUSH exposure, if wanted, is bought in ≤ $10k clips and staked:
    0.128%/day forward at today's volume, cbBTC, no lock. Mining is not a
    cheaper source of RUSH except inside the boost windows.
14. Grubstake (affiliate points) is 97.7 cents on the dollar as a blanket:
    spend it before it expires.

## What to watch, and when to stop

- **Volume.** Every yield above is proportional to it: $130k/day now,
  falling ($83/round in the last 100). Below ~$50k/day the boost-window
  edge is under $300/day for the whole fleet and presence costs are a
  material fraction of it.
- **The fee split** (preflight's economics gate) and the **strike
  modulus** (scripts read the chain). A modulus back at 1440 cuts boosted
  rounds to 17%.
- **Iteration 16's close** (`pnpm measure-remaining`): the ticket value is
  the number the blanket EV rests on.
- **The 30-day TWAP** falling to spot lifts the RUSH leg from 1.83% toward
  2% of gross; a RUSH rally does the opposite via the cap.
- **Kill:** two consecutive iterations with a realized fleet return below
  zero on the marked ledger (`markedNetTodayUsd`), or the daily loss cap.

## Expected result, honestly

At $200/round boosted across 21 wallets: ~$40k of boosted volume per day
at +2.5–3.5% ≈ $1.0–1.4k/day of EV before dilution, ~$0.5–1k/day after,
minus ~$150/day of presence and fees, on ~$10k of working capital. Realized
results will swing ±$500/day on the strike and draw lumps and only
converge over several iterations. The passive book (shares held, RUSH
staked) adds a few tens of dollars a day on the current position.
