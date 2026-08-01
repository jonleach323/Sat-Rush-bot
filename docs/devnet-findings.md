# Devnet findings — live observation session, 2026-08-01

Source: `scripts/watch.ts` against the live devnet program (rounds 1797–1805,
owner playing manually). Raw evidence: decoded account streams + events with
slots and signatures. This updates several CLAUDE.md "open questions".

## Answered

**Q1 — deploy amount splits evenly across masked tiles; stake is net USD.**
$5.00 gross → $4.60 net; with a 15-tile mask each tile showed exactly
4 600 000 / 15 = 306 666 base units (also the settle's `winning_stake`), with
mask=1 the full 4 600 000 sat on one tile. `TileStake.stake` is net-of-fee
USD, not streak-multiplied — the streak shows up in hashrate instead.

**Q6 — devnet SatrushConfig values.**
strike 264 bps · epoch 262 · one_btc 132 · sats_vault_round 1200 ·
sats_vault_claim 1000 · protocol 142 · unclaimed_hashrate 3500 bps ·
min_deploy 1 USDC. Mints: USD `2swmsmWgoaPEEaHXZX5BbLXSJS4xShsAZxjwX1g31kDV`,
BTC `6Xec3vTwoj52UXmohiBCs86KNRMbcPi4vtgRXrvjecrC`.

**Fee mechanics (corollary).** Deploy leg deducts exactly 800 bps
(264+262+132+142): 5.00 → 4.60. The 1200 bps sats-vault round fee comes out
at the round level: 4.60 staked → 4.048 pot after the USD→BTC swap (−12%).
Reveal-time fee sweeps equal the per-deploy legs to the lamport
(131 000 / 66 000 / 71 000 on a single $5 deploy).

**Round clock arms on the FIRST deploy.** Idle rounds sit at
`start_slot = end_slot = u64::MAX` ("disarmed") indefinitely; the first
deploy sets the 50-slot (~20 s) countdown. Implication: `FIRE_OFFSET_SLOTS`
timing only exists once someone opens the round; a fire-late strategy cannot
assume a ticking clock on an empty round.

**Events are emit_cpi, not logs.** CLAUDE.md's "real-time via logs" is wrong:
all events arrive as self-CPI inner instructions
(`[sha256("anchor:event")[0..8] LE][event discriminator][borsh]`). Yellowstone
transaction streams carry them; log subscriptions alone cannot. Also:
`logsSubscribe` never fires on the public devnet RPC — the ws fallback polls
`getSignaturesForAddress` instead.

## Partially answered

**Q4 — cutoff boundary.** Rotation (reveal) landed 2–3 slots after
`end_slot` in every observed round. The exact slot where `deploy_public`
starts failing with 6005 still needs a deliberate late-deploy probe.

**Q5 — streak/hashrate.** Losses DO earn hashrate ("all zeros except
hashrate"), and consecutive-round hashrate grew every round:
10 → 17 → 22 → 125 → 130 → 135 → 140 (raw, 2 display decimals) across rounds
1797–1803. The +5/round arithmetic step held while stake and tile count were
constant; the 22 → 125 jump coincided with a mask change (15 tiles → 1
tile) so tile count or deploy composition affects the base. Needs controlled
experiments. `unclaimed_hashrate_earned` ≈ 35% of `hashrate_earned` every
time — matches `unclaimed_hashrate_bps = 3500` exactly, deferred as
`Miner.unclaimed_hashrate`.

## Other observations

- **Winner economics:** a sole winner received the full pot both ways:
  `won_usd_amount` 4 048 000 AND 70 692 sats-vault shares per win.
  `RoundStakeSwapped` showed each 4.048 USD pot swapping to 552 BTC base
  units.
- **Winning tiles observed:** 10, 12, 17, 15, 15, 9, 19 (rounds 1798–1804).
- **Epoch vault lifecycle:** `EpochDrawTriggered` (iteration 1: 1033
  tickets, pool $241.06 + 240 103 BTC units) followed by 21
  `EpochWinnerSelected` cranks (ranks 0–20), one transaction each, ~1 s
  apart. An owner-side bot was buying epoch tickets every ~13 s before the
  idle window.
- **Crank cadence:** settle cranks follow reveals within ~1–2 s. Board and
  round account updates can arrive out of order within a slot (a deploy's
  round update may precede the board's clock-arming update).
- **Idle behavior:** with nobody playing, rounds do not rotate at all (the
  board waits disarmed), and the owner's bots can be offline for hours —
  don't assume continuous devnet activity when scheduling experiments.
