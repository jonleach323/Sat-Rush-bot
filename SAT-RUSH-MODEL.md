# Sat Rush V2 — the complete model (2026-09-21)

Every instruction the program exposes, every number that governs the money,
where each came from, and what every action a player can take is worth.
`pnpm ev-map` prints section 5 from live data; nothing in this file is a
number without a source. Sources: the V2 IDL regenerated from
`@satrush/client@0.1.15` (61 instructions), the SDK's exported constants and
formulas, the on-chain `SatrushConfig` / vault / treasury accounts (read
2026-09-21), the public API, the app's own rule text (About / Stake /
Referrals pages), and the measurements in FINDINGS.md.

## 0. The answer

1. **Sat Rush is not a game you beat on the board.** A dollar deployed pays a
   6% fee layer; 89% of a losing tile comes back, 5% of gross becomes BTC
   for the winning tile's stakers, and the strike/epoch/1-BTC legs come back
   only through the vaults. Single-tile play loses 3–7% of gross per round
   at every streak. Nothing about tile choice, timing or size changes that:
   the board is final 40 s before cutoff and the mint is proportional to
   volume.
2. **The only positive-EV deploy is a 21-tile blanket at the streak cap
   during a post-strike boost window** (240 rounds after each strike, ~22%
   of rounds, 2× hashrate): +0.27%…+3.45% of gross per round on today's
   inputs. Outside the window the same blanket is −1.0%…+0.6%. It exists
   because a blanket is parimutuel (refund, sats, strike all come back pro
   rata) and the hashrate it earns buys vault tickets worth more than the
   remaining toll when doubled. Its uncertainty is the epoch ticket value
   under the 104 bps epoch fee (three brackets in `pnpm ev-map`).
3. **Every claim decision is "hold"** except USD. Sats-vault shares earn
   0.30%/day and token-vault shares 0.24%/day from leavers' 10% exit fees
   (decaying); claiming pays 10% and nothing yields more.
4. **Bought RUSH should be staked, not vaulted**, and the yield is a
   VOLUME yield: 29% of the 108 bps buybacks leg ÷ staked value = 0.128%/day
   at $130k/day of volume (lifetime 0.208%/day at the earlier volume). It
   pays cbBTC, no lock, no fee, and carries the RUSH price.
5. **Mining RUSH is cheaper than buying it only in configuration 2.** The
   mint is capped at $20 of RUSH per $1,000 at the TWAP price, so the RUSH
   leg is worth ≤ 2% of gross in dollars at any price; mining beats buying
   iff the non-token toll is under ~1.85%, which only the boosted blanket
   at the cap clears in every bracket.
6. **Hashrate is worth about the same in either vault**: a 1-BTC ticket
   $0.023–$0.045 (1.0–1.9× an epoch ticket's $0.024) depending on how long
   the vault takes to fill, at winner-take-all variance (one ticket in
   1.8–3.5M). The engine ranks them by marginal value each tick.
7. **Grubstake is 97.7 cents on the dollar** deployed as a blanket, and
   expires. Affiliate points are 10 bps of referred volume, 1:1 to grubstake.

The strategy that follows from 1–7 is in §6.

## 1. Programs, accounts, lifecycle

```
  game      satRushGBRY2vgapeTAkoxz26vL2cYqyPi6CnBj7Tco   upgraded in place 2026-09-10/11 (V2)
  mint      sAtmiNt6gsZ9GmaABzuUfTufpBtbQCuTiQN8yGJzeH6   CPI'd by rotate_round; no IDL; 3 accounts (config, TWAP ring, tranche table)
  rng       SatRngpc6hC9uMXqS4dRk4trqhySktoxMXYSSRbjemd   rotors ['rotor','round'|'epoch'|'btc'], armed by deploys/triggers
  staking   SaTsTaKpGdTfUEPSSwyYgLKkfnZu8uL3D1DbLXshdb7   treasury BdJVbMKd…; stake RUSH, earn cbBTC; 24 h reward stream; no lock/fee
  RUSH      SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH   9 dec; supply 42,942 (2026-09-21); Orca pool AFdizLL2… $541k
```

Singletons (PDA, decoded 2026-09-21): `SatrushConfig` (fees, modulus,
durations), `Board` (round id/slots, strike pot USD+BTC+RUSH and reserves),
`SatsVault` (btc_amount 6.7636 BTC / btc_shares 323.6e9), `TokenVault`
(4,248.6 RUSH / 3.256e15 shares), `EpochVault` (iteration 16, pool
$8,240 USD + 0.1054 BTC + 28.87 RUSH), `OneBtcVault` (iteration 3, 0.1274 BTC
filled), `Treasury` (protocol fees $2,778; affiliate reserve $325; token
buybacks $8.97 / staking buybacks $9.22 pending). Per player: `Miner`
(unclaimed USD, sats shares, token shares, hashrate, deferred hashrate,
streak, grubstake, affiliate binding), `PublicDeployment` per (wallet,
round), `PublicAutomation` (one per wallet), `Affiliate` + `AffiliateTag`.

Round lifecycle: `rotate_round` (owner crank) closes the previous round,
draws the winning tile from the rotor entropy, CPIs the mint program, sweeps
the fee legs to their vaults, stamps `is_hashrate_boosted`, and opens the
next 230-slot (~92 s) round. Deploys land while `slot ≤ end_slot` (6005
after). `settle_deploy_public` (permissionless) pays each deployment.

## 2. One dollar of gross deploy

```
  leg                                   bps     where it goes                                   who gets it back, how
  losing-tile refund                   8900     stays USD on the winning miner's Miner          you, on each losing tile you covered; claim_usd (no fee)
  swap to BTC (winning tile)            500     board USDC → cbBTC → sats-vault shares          the winning tile's stakers pro rata (+ 89% of their own stake)
  strike fee                            240     board jackpot pot (USD, later BTC/RUSH legs)    93.33% of the pot to the winning tile's stakers at trigger (1/1097 rounds); reserve re-seeds → ~100% over time
  epoch fee                             104     epoch vault (USD→BTC swap + RUSH leg)           21 equal prizes per 10.73-day iteration, by tickets bought with hashrate, one win per wallet
  1-BTC fee                              48     1-BTC vault (BTC)                               one winner per 1 BTC accumulated, by tickets bought with hashrate
  protocol fee                          100     treasury                                        10% (10 bps) to the referrer as points → grubstake; 90 bps leaves
  buybacks                              108     treasury                                        29% buys BTC for RUSH stakers pro rata (31.3 bps); 71% buys and burns RUSH (76.7 bps)
  = fee layer                           600     (tape: net = 94.00% of gross on every V2 round; was 208/194/48/100/50 until round 64175, 2026-09-17)
  + RUSH minted                    ≤ 200 $-bps  min(tranche rate, $20/$1k ÷ max(30 d, 1 d TWAP)); live 0.426 RUSH/$1k = 1.83% at $42.95
                                                64% winners' stake pro rata · 16% losers' · 14% strike pot · 6% epoch pool; paid as token-vault shares
  + hashrate                              —     (streak + 21/tiles) raw per GROSS $, ×2 in a boost round; 35% deferred until a sats claim; 100 raw = 1 ticket
```

So a miss costs 11% of the stake on that tile (6% fee + 5% swap) and a
blanket keeps 94% of gross as USD/BTC before the vault legs, exactly as the
app's rule text states.

## 3. Every instruction (61), by who calls it and what it moves

**Player (13).** `deploy_public(mask, amount, is_grubstake_funded)` stake
gross USD on 1–21 tiles for the current round; arms the round rotor (4
remaining accounts); a grubstake-funded play earns no hashrate.
`settle_deploy_public()` permissionless; pays refunds/BTC shares/RUSH
shares/hashrate; refunds rent to the payer. `claim_usd(amount)` fee-free.
`claim_sats(shares)` / `claim_token(token_shares)` coupled redemptions with
the 10% exit fee on both legs; release the deferred hashrate pro rata.
`buy_epoch_tickets(n, page)` / `buy_one_btc_tickets(n)` spend 100 raw
hashrate per ticket. `claim_one_btc_reward()` the winner takes 1 BTC.
`set_miner_tag(tag)` creates the wallet's affiliate identity (once, 3–16
chars). `exchange_affiliate_points(points)` points → grubstake 1:1.
`deposit_grubstake` / `withdraw_grubstake` (owner's pool side),
`claim_grubstake_airdrop()` claims an airdrop into the miner's grubstake.

**Automation (5).** `create_public_automation(strategy, mask, per_round,
reload, deposit, grubstake)`, `top_up_public_automation`,
`cancel_public_automation`, `execute_public_automation` (crank, per round),
`reclaim_grubstake_automation`. Same fees as a manual deploy; the owner's
crank picks Discretionary masks and fronts rent.

**Cranks, permissionless or crank-authority (16).** `rotate_round`,
`close_round`, `swap_round_stake` / `swap_strike_stake` /
`swap_epoch_stake` / `swap_one_btc_stake` (USD → BTC via a swap program),
`trigger_epoch_draw` → `seal_epoch_page` → `select_epoch_winner(page)` →
`distribute_epoch_reward(rank)` → `close_epoch_entry/page/iteration`,
`trigger_one_btc_draw` → `settle_one_btc_draw` → `close_one_btc_ticket/
iteration`, `buyback_burn_token` (RUSH buy + burn), `distribute_staking_
reward` (BTC to the staking treasury), `reclaim_miner_grubstake` (sweeps
expired grubstake to the treasury).

**Owner / admin (27).** `create_*` (board, config, vaults, treasury),
`migrate_*` (V1 → V2 layouts), `update_deploy_fees` (the five legs, sum
600), `update_strike_trigger_modulus` (1440 → 1097), `update_board_round_
duration`, `update_epoch_vault_iteration_duration`, `update_min_deploy_usd_
amount`, `update_unclaimed_hashrate_bps`, `update_deployment_settle_grace_
duration`, `set_affiliate_rate`, `airdrop_token`, `create_grubstake_
airdrop`, `reclaim_grubstake_airdrop`, `withdraw_protocol_fees`.

Errors that bound play: 6005 RoundNotActive (past end_slot), 6007 invalid
mask, 6049 below the $1 minimum, 6062 insufficient grubstake, 6030 epoch
max participants.

## 4. Every number, with its source

**SDK constants (program truth, pinned by `test/sdk-parity.test.ts`):**
TILE_COUNT 21 · REWARD_MAX_STREAK 100 · STREAK_GRACE_ROUNDS 2 (a deploy
continues the streak iff 1 ≤ gap ≤ 3) · HASHRATE_PER_TICKET 100 raw ·
HASHRATE_DECIMALS 2 · LOYALTY_WEIGHT 1 · SKILL_WEIGHT 1 (hashrate =
stake × (streak + 21/tiles) per whole USD) · STRIKE_BOOST_ROUNDS 240 ·
STRIKE_BOOST_HASHRATE_MULTIPLIER 2 · SHARE_OFFSET 1000 (vault share math:
gross = shares × (assets+1) ÷ (shares_issued+1000)) · AFFILIATE_TAG 3–16.

**On-chain config (2026-09-21):** strike 240 · epoch 104 · one_btc 48 ·
protocol 100 · buybacks 108 (= 600) · vault_exit_fee 1000 · unclaimed_
hashrate 3500 · min deploy $1 · round 230 slots · epoch iteration
2,318,400 slots (7.2 d at the live 267 ms slot; iteration 16 ran 2026-09-16 09:33 → 09-23 13:55) · settle grace 0 · strike_trigger_modulus 1097.
The API's `/config` omits buybacks and the modulus; scripts read the chain
(`scripts/lib/onchain.ts`); the orchestrator decodes it at boot.

**Measured (facts.ts, each with n, date, half-life, recheck):**
losing refund 8900 bps (exact on every settlement) · swap = 5%·V + 89%·W_win
(exact, 4 rounds) · RUSH legs pro rata by stake (exact) · hashrate on gross
at the cap (exact) · strike payout 93.33% at trigger, reserve re-seeded (12
strikes, sd 0) · mint 0.4308 RUSH/$1k (last 100 rounds), proportional to
volume R² 0.996, +1.74%/day drift · sats carry 0.30%/day (n=67) · token
carry 0.24%/day · staking 0.208%/day lifetime (a lower bound now: the leg
doubled on 09-17) · board final 40 s before cutoff, 93.3% automation ·
epoch: last close 882,469 tickets / $27,798 / 369 wallets, dedup uplift
1.37 ± 0.10, banked share 0.107 ± 0.039 · deferred-hashrate uplift 1.179
(n=1,875) · Orca depth: $1k costs +0.09%, $10k +0.8%, $50k +7.5%.

**Stated (app rule text / owner), not yet measurable:** RUSH mint cap $20
per $1k at max(30 d, 1 d) TWAP; tranche 1 = 515,813 RUSH at 1/$500, each
next tranche 75% of tokens at 75% of rate; 2.1M max supply; buybacks split
29% staking / 71% burn; affiliate rate 10% of the protocol leg (set per
affiliate by the admin).

**Live (read at use time, never cached as a fact):** board gross and
occupancy, strike pot ($3,305 combined), epoch pool and tickets, 1-BTC fill
(12.74%) and tickets (231,393), vault ratios, prices (`/board`), staked
value ($318.9k), daily volume ($130k ± $0.7k over the last 3 days; the
last 100 rounds average $83/round and falling).

## 5. Every action, priced (from `pnpm ev-map`, 2026-09-21 04:57Z)

```
  DEPLOY (EV per $ of gross per round, RUSH at spot, $5/round on the mean board; three epoch-ticket brackets)
                                                   ticket $0.0237 (15 closed)   $0.0127 (live fee)   $0.0284 (16 pace)
  fresh wallet, single emptiest tile (streak 1)            −6.26%                    −6.50%              −6.16%
  single tile at the streak cap                            −3.91%                    −5.25%              −3.34%
  21-tile blanket, streak 1                                −2.25%                    −2.27%              −2.24%
  21-tile blanket at the streak cap                        +0.10%                    −1.01%              +0.58%
  21-tile blanket at cap, BOOSTED round (2× hashrate)      +2.49%                    +0.27%              +3.45%
  $1 presence blanket outside boosts: ≤ $7.42/day; ramp to the cap: 99 rounds (2.5 h), ≤ $2.25 of negative EV at $1
  blended full-time blanket at cap (22% of rounds boosted): −0.73% … +1.20% per $ per round

  HASHRATE (100 raw = 1 ticket)
  epoch ticket $0.0236 at iteration 16's projected close (pace: $28.2k pool / 900k tickets; iteration 15 closed $0.0237) · 1-BTC ticket $0.023–$0.045 (1 BTC ÷ 1.8–3.5M tickets; 56–115 days to the draw)
  → 1-BTC pays 1.0–1.9× the epoch vault per unit (iterations 1–2 drew at 0.88M and 1.69M tickets); winner-take-all

  HOLD / CLAIM / STAKE / BUY
  sats-vault shares: +0.30%/day carry, hold · token-vault shares: +0.24%/day, hold · claim USD: free, always
  stake bought RUSH: +0.128%/day forward (31.3 bps × $130k/day ÷ $319k) · +0.208% lifetime · no lock, no fee · RUSH price risk
  buy RUSH: $1k at +0.09% over spot on Jupiter

  GRUBSTAKE / AFFILIATE / AUTOMATION
  grubstake: 97.7% of face as a blanket at cap (no hashrate); expires · affiliate: 10 bps of referred volume → grubstake 1:1
  automation: same fees, no timing, the crank's mask; only a streak-holder for someone without a bot
```

Standard errors: the mean board ±$3/round; daily volume ±$745; the uplift
±0.10 (≈ ±0.2 pts on the hashrate credit); the strike payout is exact; the
mint rate CV 5%; the epoch ticket value is the bracket itself (the fee halved
mid-iteration while the field shrank — iteration 16's close settles it).

## 6. The strategy, definitively

- **Board:** never single tiles. Hold the streak at the cap with a $1
  blanket every round (grace 2, so at most every third round, at ≤ $7/day).
  Deploy the MAX blanket in boost rounds (`Round.is_hashrate_boosted`, 240
  rounds after each strike). Outside boosts, deploy above $1 only when the
  live epoch ticket value makes the blanket positive (`pnpm ev-map` col. 3
  and the bot's `blanketEvBpsAtStreakCap`). The bot's selector prices this
  per round; the ramp alert (`RAMP_ALERT_MIN_BPS`) fires when the cap pays.
- **Hashrate:** spend it, don't hold it; 1-BTC tickets first (the engine
  ranks by marginal ticket value), epoch tickets late in the iteration.
- **Vaults:** hold all shares; claim USD always. The 35% deferred hashrate
  is the only reason to ever claim shares, and only pro rata.
- **RUSH:** buy in ≤ $10k clips and stake for the volume yield if you want
  RUSH exposure; mining does not produce it cheaper except in boost rounds.
- **Fleet:** 21 wallets under one affiliate tag recover the epoch leg
  (`pnpm v2-ledger`) and rebate 10 bps; each wallet holds its own streak.
- **Watch:** volume (every yield above is proportional to it), the epoch
  ticket value at iteration 16's close, the mint TWAP (2% cap), the fee
  split (preflight's economics gate), the strike modulus.

## 7. What was uncertain, measured (`pnpm measure-remaining`, 2026-09-21)

- **Epoch ticket value under the 104 bps fee: unchanged.** Iteration 16 at
  5.1 of 10.7 days holds $16,263 against $13,802 of epoch fee collected
  (118%: the BTC/RUSH legs' price moves and pending sweeps). At the
  post-09-17 pace ($2,134/day of fee, 83,817 tickets/day) it closes at
  ~$28.2k over ~900k tickets: a ticket worth $0.0236, against iteration
  15's $0.0237. The field shrank as much as the fee did, so the "live fee"
  low case ($0.0127) in `pnpm ev-map` is a floor, not the estimate; the
  central column is the closed-15 / 16-pace one. The blanket at the cap is
  therefore +0.10%…+0.58% unboosted and +2.49%…+3.45% boosted.
- **Staking split: 31.4% ± 3 measured** ($6,960 of BTC deposited against
  $22,165 of buybacks fee collected over 13,299 rounds; BTC priced today,
  deposits stream over 24 h), consistent with the app's stated 29%. Kept
  at the stated round number.
- **1-BTC tickets at the draw: 1.8–3.5M.** Iterations 1 and 2 drew at
  883,982 and 1,694,036 tickets; iteration 3 runs 28,486 tickets/day at
  12.7% filled after 8.1 days, and the fill takes 56 more days at its own
  average or 115 at the last-3-day volume. Ticket value $0.023–$0.045.
- **The mint's binding average is the 30-day TWAP** at ~$46.4 (the cap
  price implied by the live rate), above spot $42.95 and above the mint
  program's 1-day observation ring (~$42; ~270 records at ~4-minute
  spacing, layout inferred from a raw dump). So the RUSH leg is 1.83% of
  gross today and rises toward 2% only as the 30-day average falls to spot.

**Not measurable from here:** a live V2 send (deploy, settle, ticket buy,
claim) from this client. Every builder is verified key-for-key against
mainnet transactions, but firing one needs a funded keypair and
`MAINNET_CONFIRM=yes`, which only the operator can supply. That is the
one open item, and it is an operational test, not an economic unknown.
