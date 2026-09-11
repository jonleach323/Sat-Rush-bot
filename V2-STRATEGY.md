# Sat Rush V2 — strategy

Written 2026-09-10 from `@satrush/client@0.1.15` and the owner's announcement;
verified 2026-09-11 against live mainnet settlements (FINDINGS.md § E-v2-live:
every leg of the board model exact to the cent on four rounds and one
per-deployment ledger; the mint measured, not stated). Numbers:
`pnpm v2-strategy`, `pnpm v2-ledger`, `pnpm wallet-set`. Model:
`src/strategy/ev-v2.ts`. Facts and provenance: `src/strategy/facts.ts`.

**Status on measured numbers: not +EV.** The program mints 1 RUSH per
~$3,600 of volume (0.279 per $1,000), a 1.38% yield at the $49 oracle,
against the 2% the stated "1 per $500 at $10" implied. With 21 wallets the
expectation is −1.00% per dollar of volume before the vault carry; break-even
needs a 2.38% yield. The owner says an algorithm sets the volume-to-RUSH
ratio and that it decreases over time; 1 per $500 at launch to 1 per $3,600
a day later is that decrease. The rate is not keyed to spot (it drifted up
~0.09% per round over an hour while spot moved both ways), so the yield is
rate × price with the rate on a falling schedule of unknown shape. Nothing in
that points toward the 2.38% break-even; it points away from it. The launch
window was the best the token leg will ever be, and it has mostly passed.

## 0. The answer

V2 replaces the parimutuel with fee-bounded rounds plus a token. Every dollar
gets 89% back in USD when its tile loses, so the most the board can take from a
dollar in one round is 11%, not 100%. What is still keyed to the winning tile —
a 5%-of-volume BTC pool, 64% of the round's RUSH mint, the Sat Strike jackpot —
is shared pro-rata exactly the way V1's pot was. So:

1. **Whether presence pays is decided by the RUSH yield per dollar of
   volume, and the owner has now stated it: 1 RUSH per $500 of volume,
   listing at $10, so y = 2% of volume.** The mint is proportional to volume,
   so there is no thin-round timing edge on the token leg: every dollar
   earns the same 0.002 RUSH whoever else plays, and only the price and the
   mint rate move it. A proportional player gets back exactly 1 − fee layer
   (94%) from the USD/BTC legs whatever the draw, plus 80% of the mint this
   round. At $10 that is −4.4% per dollar on the board-only view and about
   +0.9% all-in (fee legs recycling through the vaults to a full
   participant). Break-even price at the launch rate: $37.50 board-only,
   about $6.7 protocol-leg-only (the leg's V2 split is read at boot). The price is the whole trade: every dollar of
   volume mints $0.02 of sell-side supply, the 2.1M cap means the rate can
   only fall, and the realisable yield is −10% through the exit fee unless
   held for the vault APR. The launch window is the richest the leg will be.
2. **The board edge survives but shrinks ~17x** (5% of volume up for grabs
   instead of ~88%). At today's $220/round it is worth about a dollar a
   round. Water-filling still finds it, unchanged.
3. **Sizing inverts.** Kelly and the caps must be written on the 11% toll,
   not the stake: a $100 V2 deploy carries the risk of an $11 V1 deploy.
4. **Hold everything.** Both vaults charge the same 10% exit fee and it stays
   in the vault, paid to whoever does not claim; the API already reports a
   sats-vault APR of 119.7% (7-day projected, annualized, decays as the field
   learns). Never `claim_sats`, never `claim_token`.
5. **Concentrate.** One tile earns 121 raw hashrate per dollar at the streak
   cap against a blanket's 101, and the USD leg no longer punishes it.
6. **The streak survives two skipped rounds** (SDK `STREAK_GRACE_ROUNDS = 2`),
   so a −EV round is skippable and the counter costs $0.11 per three rounds
   to keep, not a full toll per round.
7. **Epoch prizes are equal, so run a wallet set.** One wallet's take caps
   at one flat slot however many tickets it holds, and at any real volume we
   dominate the tickets: with one wallet at $1,000/round we get back 5% of
   the epoch fee we ourselves pay in, with 21 wallets 88%. The owner has
   approved extra wallets under our affiliate tag. This is the correction to
   the "+0.9% all-in" above: that figure assumes the epoch leg recycles,
   which it only does with the wallet set (§7).

**The one-page ledger (`pnpm v2-ledger`, every leg per dollar of volume, in
expectation, before the vault carry):** at $10 with 21 wallets the net is
−0.07%, i.e. break-even; with one wallet −1.9%. Break-even RUSH price
$10.36 with the strike leg at its 70% payout, $7.50 if the strike buffer
returns too; $20 for a single wallet. Left out and only additive: the vault
carry, the board edge. Left out and only subtractive: a buybacks leg carved
from the 6%, Jito tips, RUSH slippage, the mint rate falling. The strike
and 1-BTC legs are 2.8% of volume paid in lumps, so any one iteration swings
±2 points around the expectation. So: not +EV on the stated numbers alone;
+EV if the price holds above ~$10, or the carry is real, or both.

Nothing above is a reason to trade on day one. The client cannot decode the
migrated accounts until the V2 IDL is loaded, and the first V2 settlement will
(correctly) trip the reconcile tripwire and write the KILL file. Day one is
dry mode plus measurement (§6).

## 1. What V2 actually is

The SDK diff (0.1.12 → 0.1.15), not the marketing copy:

| announced | what the program does |
|---|---|
| "protocol fee 8% → 6%" | The deploy fee layer. V1's layer was strike + epoch + one_btc + protocol = 800 bps (E6); V2 adds a `buybacks_fee_bps` leg. The split is read from `SatrushConfig` at boot; only the total is announced. |
| "parimutuel is gone; losers get remaining USDC back" | `PublicDeploySettled.wonUsdAmount` = "losing-tile refunds (89% of gross per losing tile) plus any strike USD bonus share". |
| "the winning block's Sats Fee is converted into BTC, pro-rata" | `SatrushConfig.satsVaultRoundFeeBps` is DEPRECATED ("the swap budget is now derived per round"). 100 − 89 − 6 = 5% of gross is neither refunded nor fee: that, plus the winning tile's own net stake, is swapped to BTC and paid to the winning tile's stakers as Sats Vault shares. |
| RUSH, 64/16/14/6 | `Round.mintedTokenAmount`, minted by a separate mint program at rotation; `RoundRevealed` doc: winners' 64%, losers' 16%, epoch 6% derived from it, strike 14% plus any leg with no claimant. Paid as Token Vault shares (`Miner.unclaimedTokenShares`). |
| "same 10% claim tax", "APR on unclaimed" | `SatrushConfig.vaultExitFeeBps`, applied to both vaults; the fee stays in the vault. `claim_sats` and `claim_token` are COUPLED: either burns the same fraction of the other balance. |
| "Sat Strike unchanged" | Same trigger (`rng % strike_trigger_modulus`), now with a token leg. At reveal 10% of the folded pot goes to the epoch vault and 5% to a reserve; the API still reports the payable pool as "the pot minus the 30%" → keep `STRIKE_PAYOUT_FRACTION = 0.70`, re-measure at the first V2 strike. |
| "Epoch Vault equal for every winner" | `EpochWinnerSelected.rank` "does not affect the pot share (all winners receive the same fixed share)". Selection is still ticket-weighted without replacement; rewards are crank-distributed (`distribute_epoch_reward`). 10% still rolls over. |
| "provably verifiable RNG" | A separate program `SatRngpc6hC9uMXqS4dRk4trqhySktoxMXYSSRbjemd` runs "rotors"; the round rotor is armed at `end_slot` and rotation requires its settlement. Deploy cutoff semantics are unchanged (6005 `ROUND_NOT_ACTIVE` past `end_slot`). |
| "two-round streak grace" | `STREAK_GRACE_ROUNDS = 2`; `nextStreakMultiplier`: a play `gap` rounds after the last continues the streak iff `1 ≤ gap ≤ 3`. Applies to every play, manual included. |
| "$100k airdrop in your Rewards" | `airdrop_token` deposits Token Vault shares onto a miner. Check `Miner.unclaimedTokenShares` after migration. |
| referrals | `Miner.affiliate` binds at miner creation only; `SELF_REFERRAL_NOT_ALLOWED` (6066). Our existing miner cannot be referred. Not a strategy input. |
| grubstake | Bonus USD spendable only on rounds, earns no hashrate. Not ours unless referred. |

Also new and operationally relevant: the program is upgraded IN PLACE (same
address) with `migrate_board/miner/satrush_config/treasury` growing the live
accounts; `deploy_public` gains an `is_grubstake_funded` arg and an optional
`affiliate` account; `settle_deploy_public` gains `token_vault`, `token_mint`
and `affiliate`; errors 6060–6090 are new. The API package (`@satrush/api@0.1.21`)
serves `prices.token` (RUSH oracle spot), `token_vault.apr`, `sats_vault.apr`,
`rounds[].minted_token_amount`, and an SSE stream.

## 2. The economics per dollar

Stated until measured — every constant in `facts.ts` with its source:

```
  fee layer          6.00%   V2_DEPLOY_FEE_LAYER_BPS   stated (announcement); read from chain at boot
  losing tile       89.00%   V2_LOSING_TILE_REFUND_BPS stated (SDK doc); confirm on the first settlements
  sats leg           5.00%   derived: 1 − fee − refund; funds the winning tile's BTC pool
  winning tile      89.00%   own stake back as BTC, plus the pro-rata slice of the 5%·V pool
  RUSH               M       64% winning tile · 16% losing tiles · 14% strike · 6% epoch, pro-rata by stake
  vault exit fee    10.00%   V2_VAULT_EXIT_FEE_BPS     stated; read from chain at boot; paid only if we claim
```

At a uniform board a blanket returns `1 − f + 0.80·y` where `y = M·P/V` is the
token yield (`blanketReturnV2`). The strike and epoch RUSH legs (20%) reach
players later, pro-rata in expectation. The fee layer's own legs mostly
recycle too (E-accounting measured V1's true leak at 1.42% of the 8%), so the
all-in break-even yield is ~1.3%, the board-only one 7.5%.

**Reading A vs B.** The SDK says the winner's USD is refunds only, so the
winning tile's own stake is swapped to BTC (A). If it were refunded in USD (B)
only the currency mix changes; the contested slice is identical. The model
carries A and `valueNetOfExitFee` for the difference.

**The announcement's "more BTC for winning blocks" does not fall out of this
ledger at uniform occupancy** (a blanket takes 9.2% of stake in BTC per round
against V1's 11%). Either the winning tile's pool is larger than 5% of volume,
or the claim is per-winner (fewer winners as the field concentrates). It is
the first thing to measure: `won_shares × vault ratio × price` against the
winning-tile stake, per settlement.

## 3. Where the edge is, ranked

1. **Token yield, front-loaded.** The mint is proportional to volume (owner:
   "initially 1 token per $500 volume"), so `y = k·P` is a per-dollar
   constant — 2% at $10 — and there is nothing to time within a round. What
   there is to time is the launch window: the "complex algo" that replaces
   the rate can only lower it under a 2.1M cap, and the price is highest
   before the linear supply meets the market. Deploy full size from round
   one while `P ≥ break-even` and the measured rate holds; `pnpm v2-strategy`
   prints both against the oracle every run. Size against how much RUSH the
   market can absorb, not against the 11% toll: at today's ~$300/round the
   whole game mints ~660 RUSH/day, ~$6.6k at $10, and a $1,000/round bot
   alone would add ~2,160 RUSH/day, ~$21.6k of supply. The buyback sink is the `buybacks_fee_bps` leg
   times volume — read it from the config on day one.
2. **The contested pool** `C = 0.05·V + 0.64·M·P + E_strike`, shared pro-rata
   on the winning tile. Same shape as V1's pot, so `selectAllocation` is
   unchanged; only `v2Model` is handed in. At $220/round it is $11 of BTC plus
   64% of the mint. A $1 ticket on an empty tile is worth +39% of stake at
   that volume; a $10 one is already −6%, because alone on a tile the share
   is 1 and each further dollar only adds its own 5%.
3. **Hold: the carry, now on two vaults.** Field appreciation was +6.61% ±
   0.89% on V1 (n=41). The API's 119.7% projected sats APR is a 7-day window
   and will decay, but the direction is settled: claiming pays holders.
4. **Concentration for hashrate.** +19.8% raw per dollar at the cap, free on
   the USD leg. Transition alpha (decays as the field concentrates too), and
   hashrate is still the only way into the epoch and 1-BTC vaults.
5. **Streak upkeep at a third of the cost**, and −EV rounds are skippable.
6. **Epoch flat prizes**: same value per ticket at the margin, one slot cap.
   Multi-wallet splitting is the obvious exploit of a flat curve (E-redesign
   measured it saturating at ~2.8x); this client flagged it to the owner as a
   design hole and does not play it.

## 4. Sizing and risk under an 11% toll

- `tollAtRiskFraction(econ) = 0.11`: the daily-loss check must charge
  `stake × 0.11`, not `stake`. Per-round cap: divide the V1 figure by 0.11
  for the same dollars at risk ($110 at risk = $1,000 V2 stake).
- `outcomeReturnsV2` has a floor of −0.11, so Kelly's feasibility bound is
  the whole bankroll; `kellyFraction` will size aggressively on any positive
  edge. Run `KELLY_FRACTION` at 0.25–0.5 until the model has a settled
  sample, and keep `MAX_PER_ROUND` as the hard stop.
- P&L must mark BTC and RUSH legs to USD (vault ratios × oracle prices) or
  every day reads as a loss of ~11% of volume plus the winning-tile BTC, and
  the daily cap trips on phantom losses.
- `MIN_EDGE_BPS` is in bps of gross; 200 bps was 3% of V1's toll and is 18%
  of V2's. Re-tune after the first measured week.
- The existing tripwires stay load-bearing. The reconcile check models V1's
  payout and will halt on the first V2 settlement — intended; it must be
  ported (§5) before live trading, not loosened.

## 5. What this branch built, and what is deliberately not built

Built (pure strategy layer, all tested, 617 tests green):

- `src/strategy/ev-v2.ts` — the V2 EV model, closed-form tested; `v2Model`
  implements the new `EvModel` interface.
- `src/strategy/ev.ts` + `selector.ts` — `EvModel` swap point; V1 callers
  unchanged (parity-tested), V2 passes `v2Model(ctx)`.
- `src/strategy/facts.ts` — V2 facts with provenance; SDK pinned to 0.1.15.
- `src/strategy/streak.ts` — `nextStreakMultiplier` (SDK-parity tested),
  `skipBreaksStreak`, presence credit zero inside the grace.
- `src/strategy/vault.ts` — `EPOCH_EQUAL_CURVE_BPS`, curve-injectable ticket
  selector.
- `scripts/v2-strategy.ts` — the numbers, offline / V1 API / V2 API.

Not built, because none of it can be validated before the upgrade is
observable — and each is a place the bot would trade on wrong numbers:

- ~~**Adapter.**~~ DONE 2026-09-11: `satrush.json` is regenerated from the
  SDK codecs (`pnpm idl:gen`) and verified on mainnet (`pnpm idl:verify`,
  FINDINGS.md § E-v2-idl); builders carry `is_grubstake_funded`, the
  affiliate slot, the rotor and token-leg remaining accounts.
- ~~**Orchestrator wiring**~~ DONE 2026-09-11 (`GAME_VERSION=v2` default):
  `evSource()` → `v2Model` with `tokenYieldPerVolume` from the token feed
  (`src/ingest/token-feed.ts`: API `prices.token` × RUSH-per-$ over the last
  settled rounds, fail-closed to the configured fallback, default 0);
  `candidates.ts` takes a model factory for its excluded-tile variants;
  the presence credit carries the 2-round grace; the strike pot values the
  BTC and RUSH legs. Still open: the vault engine's flat curve.
- **Accounting**: `settlements` needs `won_token_shares`; `pnl.ts` must mark
  shares; `reconcile.ts` must model refunds + sats slice; `bankroll.ts` and
  `guards.ts` need the loss fraction.
- ~~**Preflight**~~ DONE: `MEASURED_ECONOMICS` re-baselined to the live V2
  config.
- **Token price feed** for `mintedTokenValueBase` (API oracle spot).

## 6. Launch-day runbook

1. **Do not restart into V2 live.** `touch KILL` before the upgrade window;
   `EXECUTION_MODE=dry`. The decoders will `HaltError` on the migrated
   layouts regardless — that is the fail-safe working.
2. **Get the IDL** (owner, or `anchor idl fetch`). Drop it in as
   `satrush.json`; `pnpm test` (`test/idl.test.ts`, `pdas`, `instructions`
   round-trips) tells you what moved.
3. **Dump the config** (`scripts/experiments/e6-config-dump.ts` pattern):
   all fee legs incl. `buybacks_fee_bps`, `vault_exit_fee_bps`, `token_mint`,
   `strike_trigger_modulus`. Re-baseline `MEASURED_ECONOMICS`.
4. **Migration state**: read our `Miner` (version, `unclaimedTokenShares` —
   the airdrop — `affiliate`), the Board, the Token Vault.
5. **Measure, in dry mode, before any deploy** (`pnpm v2-strategy`):
   - refund ratio `won_usd / losing gross` on others' settlements (expect 0.89);
   - the swap budget: `RoundStakeSwapped.deployedUsdAmount` against
     `0.05·V + 0.89·W_win` (reading A) or `0.05·V` (reading B);
   - the mint rule: `minted_token_amount` vs gross volume over ~50 rounds;
   - RUSH price: `prices.token` non-null and sane against a DEX quote;
   - board ratio at cutoff (`pnpm fire-timing`): does the field disperse?
   - strike: first trigger's `strikeBonus*` vs the displayed pool.
6. **Go/no-go for live.** Go only when: IDL loaded and tests green; preflight
   re-baselined; reconcile ported and passing on replayed V2 settlements; pnl
   marks shares; the token yield `y` measured with an error bar; the refund
   confirmed. Then `devnet` mode if the owner deploys V2 there first,
   otherwise mainnet with `MAX_PER_ROUND` = one toll-sized bet, `KELLY_FRACTION=0.25`,
   `SWEEP_ENABLED=false`, `CLAIM_USD_ENABLED=true` (refunds and strike USD are
   fee-free to claim), `SELF_SETTLE=true`.

## 7. The wallet set (owner-approved, 2026-09-10)

`pnpm wallet-set [usdPerRound]` sizes it against the last closed field
(iteration 13: 90 participants, 458k tickets, $11.5k pool):

```
  $1,000/round → 5.2M tickets (92% of all), our own epoch leg $75k/iteration
  wallets     take of pool      $/iteration   marginal   of our own leg
        1         4.3%             $3,713      $3,713          5%
        5        21.4%            $18,563      $3,713         25%
       13        55.7%            $48,211      $3,702         64%
       21        76.5%            $66,254      $2,255         88%
       34        80.4%            $69,667        $263         93%
  fees ≈ $43 per wallet per iteration at an ASSUMED $0.005/tx, 2 tx/round
```

At $100/round the curve is the same shape at a tenth the scale and the
13th wallet is already marginal. Under V1's rank curve one wallet would
have taken 21–31%; V2's flat slot makes the split the only way a large
holder collects the pool it funds. The field will do the same, and the live
iteration already holds one-ticket wallets, so re-run against every closed
iteration.

What each wallet is for:
- an epoch slot (the reason), with its own tickets bought late;
- a single-tile deploy each round on a distinct tile, 121 vs 101 raw/$
  against a blanket, splitting one aggregate budget — not extra volume;
- its own streak, kept alive by a play at least every third round;
- the affiliate rebate: 10% of the protocol leg ≈ 0.1% of referred volume,
  landing as grubstake on the main miner. A rounding term next to the RUSH
  on the same volume, but free.

Binding sequence: the main wallet claims a tag (`set_miner_tag`, 3–16 chars
of `a-z0-9_-`, creating the Affiliate PDA); each new wallet's FIRST deploy
passes that PDA as `affiliate` and is bound for life; points freeze at deploy
and land at settlement; `exchange_affiliate_points` moves them to the main
miner's grubstake; `deploy_public(is_grubstake_funded=true)` spends it.
A wallet that has already deployed can never be bound, so the new wallets
must not touch the program before the tag exists.

Right now (iteration 14, a day in) there are 16 participants: with 21 or
fewer every wallet is drawn and a one-ticket wallet takes a full slot. Five
more fit. Iterations have closed at 75–90 entrants, so this usually ends
before the draw, but entering early costs one ticket per wallet.

Execution: `src/exec/wallets.ts` already has the wallet set (loading,
funding floor, equal-split allocation of ONE aggregate budget so MAX_PER_ROUND
and DAILY_LOSS_CAP stay aggregate) and is not wired into the orchestrator.
Wiring it — per-wallet miner state, latches, candidates, ticket buys, the
`affiliate` account on deploys — is cutover work alongside §5, not before.
Fees are the cost to measure: at Jito-tip levels the per-wallet line moves.

## 8. Questions for the owner

1. Is the losing-tile refund a fixed 89% of gross, or 100% − fee legs − 5%?
   What happens to it if `update_deploy_fees` changes the layer?
2. `Round::swap_budget`: 5% of gross plus the winning tile's net stake, or
   5% of gross with winners refunded in USD? How does "significantly more
   BTC for winning blocks" follow — is the pool larger than 5% of volume?
3. The mint is 1 RUSH per $500 of gross volume at launch (stated). What does
   the "complex algo" key on, when does it switch, and is its config
   readable on-chain? Is the $10 listing a seeded pool, and how deep?
4. Are the winners' and losers' RUSH legs pro-rata by stake?
5. `prices.token`: which pool/oracle, and is it a spot or a TWAP?
6. Strike: with the 10% epoch skim and 5% reserve at reveal, is the payable
   fraction still 70% of the displayed pot?
7. Epoch: still 90% payout / 10% rollover, ticket-weighted with wallet dedup?
8. Migration: who cranks `migrate_miner`, and is V1 unclaimed state preserved?
9. Will the V2 IDL be published on-chain?
