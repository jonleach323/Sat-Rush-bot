# Devnet experiment findings

Each section is appended by a standalone script in `scripts/experiments/` — raw transaction signatures are the evidence.

## E6 — on-chain config dump (2026-08-02T02:32:34Z)

| field | value |
|---|---|
| usd_mint | `2swmsmWgoaPEEaHXZX5BbLXSJS4xShsAZxjwX1g31kDV` (decimals 6) |
| btc_mint | `6Xec3vTwoj52UXmohiBCs86KNRMbcPi4vtgRXrvjecrC` (decimals 8, supply 299999999900000) |
| strike_fee_bps | 264 |
| epoch_fee_bps | 262 |
| one_btc_fee_bps | 132 |
| sats_vault_round_fee_bps | 1200 |
| sats_vault_claim_fee_bps | 1000 |
| protocol_fee_bps | 142 |
| unclaimed_hashrate_bps | 3500 |
| min_deploy_usd_amount | $1.0000 |
| epoch_vault_iteration_duration | 1000 slots |
| deployment_settle_grace_duration | 0 slots |
| round_authority | `CYCf8sBj4zLZheRovh37rWLe7pK8Yn5G7nb4SeBmgfMG` |
| board.round_id | 1888 (duration 50 slots) |
| board clock | DISARMED (u64::MAX until first deploy) |
| strike pool | $1957.4122 swapped + $0.6864 pending, 838324 BTC units |
| strike last trigger | round 39 |
| sats vault | btc 3834309 / shares 455656262 / leftovers 0 |

**Conclusion (Q6):** deploy legs = 264+262+132+142 = 800 bps; sats-vault round leg 1200 bps at pot swap; claim fee 1000 bps; 35% hashrate deferral; $1 min deploy; 50-slot rounds. Total per-cycle fee load ≈ 20% of gross before claim fees.

## E1 — mask semantics (2026-08-02T02:32:46Z)

Deployed **$3** with mask over tiles 5, 10, 15 in round 1888: [`49sqTQsjkf5D…`](https://explorer.solana.com/tx/49sqTQsjkf5DygKptUhBwsatN42w2UpXQB5vCRA6BKcpyLiiohaXnkiAiVPYxXY9PmfeJXXS5NGaueEJj3grYcBJ?cluster=devnet) (slot 480581725)

| measure | value |
|---|---|
| TileStake delta per tile | 920000 / 920000 / 920000 (base units) |
| Σ deltas | 2760000 |
| PublicDeployment.deployed_usd_amount (gross) | $3.0000 |
| PublicDeployment.total_stake_usd_amount (net) | $2.7600 |
| net/3 (expected even-split per tile) | 920000 |
| PublicDeployment.streak_multiplier | 23 |
| Miner.current_streak_count before → after deploy | 22 → 23 |

**Conclusion (Q1):** SPLIT-EVENLY: the net amount divides across masked tiles. TileStake.stake records **RAW net USD (delta = net/3 exactly; streak multiplier NOT applied to TileStake)**. Σ per-tile deltas == total_stake_usd_amount exactly (floor dust ≤ tile count).
→ STAKE_SEMANTICS=raw confirmed; amount splits evenly.

## E2 — double deploy in one round (2026-08-02T02:33:08Z)

Round 1889: first deploy [`2VcrXizCqsEu…`](https://explorer.solana.com/tx/2VcrXizCqsEurdVbQMEhAy73bHx9gawMaoMHjqrExBz6ZkKZryaCY9eXdaA9gJwwLnM2MzbaoSDhR9Q7nngYwei6?cluster=devnet) landed (slot 480581781). Second deploy attempt [`DQJC9XtWN4rk…`](https://explorer.solana.com/tx/DQJC9XtWN4rk7Poe3doPhBEiGg2XiKibHzVhuvnwtkJQhnZZkHkmNnf5D6muHDGg3Cd1XL3SQvpRpnS693oSY1g?cluster=devnet):

- outcome: **FAILED**
- error: `{"InstructionError":[2,{"Custom":0}]}`
- program log:
> Allocate: account Address { address: 6vFFf3zrfZyNC4Jc31x842ZtxwW8MBut2PN5q44LGDa2, base: None } already in use
> Program 11111111111111111111111111111111 failed: custom program error: 0x0
> Program satRushGBRY2vgapeTAkoxz26vL2cYqyPi6CnBj7Tco failed: custom program error: 0x0
- PublicDeployment after both attempts: gross $1.0000, net $0.9200, mask 4

**Conclusion (Q2):** one-shot per round confirmed: the PublicDeployment PDA is round-seeded and the second create fails (see error). Deploy sizing must be final at fire time — no topping up after more information arrives.

## E4 — cutoff boundary (2026-08-02T02:35:53Z)

One probe per round; a second wallet armed each round first. "sent@" is the
observed slotsToCutoff at send (HTTP slot polling ≈ ±1 slot).

| target offset | round | sent@cutoff | result | evidence |
|---:|---:|---:|---|---|
| 8 | 1890 | 8 | LANDED at end_slot-7 (slot 480581882, end 480581889) | [`5iNSoQ4ziJMS…`](https://explorer.solana.com/tx/5iNSoQ4ziJMSwm5HMNJMUoHCiiQGEhQBPwbyAn8HmUUhj2hTVu77Ed8wLCGnSWB6V3tnXWKDe5DW9ZXsHFbSezJH?cluster=devnet) |
| 6 | 1891 | 6 | LANDED at end_slot-4 (slot 480581941, end 480581945) | [`A6Q398CK3ee6…`](https://explorer.solana.com/tx/A6Q398CK3ee6XN9SqFkpUEaLGTrhqhRfdFR24G78y9eMUNvuTriJuV9skFyHrnC7Z3rJ9KxFgvrDSgcPaB8Rqxg?cluster=devnet) |
| 4 | 1892 | 4 | LANDED at end_slot-2 (slot 480581998, end 480582000) | [`3Qzw7gNd8yEx…`](https://explorer.solana.com/tx/3Qzw7gNd8yExPxj1ZJ2QRbRQdGhvDrUGfwRbTqqAaWYPbpBVU9fhWUUzjRUPCbx2H7efptqB9kLdE2JnkXPTSeVz?cluster=devnet) |
| 3 | 1893 | 3 | LANDED at end_slot-1 (slot 480582056, end 480582057) | [`2yJsfK5dzaka…`](https://explorer.solana.com/tx/2yJsfK5dzakaBMQ1vQLU4bKTntcebYAzHiJy1dPqb1wPZXE1qcvMJc9xwdTh7Df4DYMpofmoz1t5btfv1uYGAp4E?cluster=devnet) |
| 2 | 1894 | 2 | expired (round_not_active) | [`5L46Dtdm2NeR…`](https://explorer.solana.com/tx/5L46Dtdm2NeRZEdZZ3Fv9DCrYS8xpGytTAjE5LtLmrBcfQsQE9i93tpqcZU8hLTmXbFZMrnU2zT2jW4Y2jUhC75x?cluster=devnet) |
| 1 | 1895 | 1 | expired (round_not_active) | [`5h5GzGi3KMV8…`](https://explorer.solana.com/tx/5h5GzGi3KMV8qp6NXecVgCmGwtSwEaRByYjXtBcXqWk8LKwXp813vsdPLN4XMA3dkNrM7Ufr9wSENwRm2sKnATJM?cluster=devnet) |
| 0 | 1896 | 0 | expired (round_not_active) | [`3uobDfnpXJZ1…`](https://explorer.solana.com/tx/3uobDfnpXJZ1qegUgSpWYXV9JhH3gqnw2A8yFSrtLgqUFBxWuscJxxgxTeGi9Vi33A7YdckD7ukNoScucZ4buZ4u?cluster=devnet) |

**Conclusion (Q4):** smallest offset that landed in this run: **3**. Deploys land when they execute in a slot ≤ end_slot; the boundary is the leader's inclusion latency, not program grace. Empirical FIRE_OFFSET_SLOTS floor on public devnet RPC ≈ 3 + 1 cushion; keep default 4 remote, revisit at ~2 when colocated.

## E5 — streak multiplier curve (2026-08-02T02:38:18Z)

Prior state: streak_count=28, last_mined_round=1893. Then $1 deploys in 6 consecutive rounds:

| round | Miner.current_streak_count (after deploy) | PublicDeployment.streak_multiplier | evidence |
|---:|---:|---:|---|
| 1897 | 1 | 1 | [`128eNej2kVjF…`](https://explorer.solana.com/tx/128eNej2kVjFhEwXkfaBjgg6Zz23TKmFzQiUKeBChi7rjVkSDH6XKocHJXBk3PnkVjxZuK9p89dmRYHPUAUex9sH?cluster=devnet) |
| 1898 | 2 | 2 | [`4sDF2JFiuP4j…`](https://explorer.solana.com/tx/4sDF2JFiuP4jGm2o2q7ag6W36FsK3qHYGtG2FS7wJRvKbX66D4ATTRp4rrpjojSa2WMdJYbJUX93FT2NHWhDt38n?cluster=devnet) |
| 1899 | 3 | 3 | [`2DrLC7gvPsG4…`](https://explorer.solana.com/tx/2DrLC7gvPsG4aS5iX5qbfTfoGKCCiZCg76V41SVrRQ3rBYjTvJBqbK9dvZ9uupionrVJwtGyVPXnUCmh5mdQez2G?cluster=devnet) |
| 1900 | 4 | 4 | [`4ojcAPK221Vd…`](https://explorer.solana.com/tx/4ojcAPK221VdXDX8TxM66cdtNGVJ32iV141PHtXumGoYiXNCWF9Q229GcjwzX6SmkXGWom6ki9gDWVRfuT3cob5s?cluster=devnet) |
| 1901 | 5 | 5 | [`3ncZjWp4Xb91…`](https://explorer.solana.com/tx/3ncZjWp4Xb91oJTrHBjYgDhddMjuKLnA12g24jzv9QaqtVJ77Xu6HKwcj3kMgk4xXza77iWgTu5Yj3vFew6hnco7?cluster=devnet) |
| 1902 | 6 | 6 | [`564YpqaQGCs9…`](https://explorer.solana.com/tx/564YpqaQGCs9PzFubUP7MdjGFnh3adzwuSyoekUh1fW6N2cEzj91CrAaTcyC21YKpnApbk8c3xkkanU71iSBaW2P?cluster=devnet) |

- multiplier deltas per consecutive round: 1, 1, 1, 1, 1
- no cap reached in this window
- **streak updates at DEPLOY time** (Miner.current_streak_count and the
  deployment's snapshotted multiplier both advance in the deploy
  transaction — no settle needed; consistent with the multiplier being
  "snapshotted at deploy" per the IDL docs).

**Conclusion (Q5, partial):** table above is the measured curve start; the
gap behavior is visible in whether streak_count continued from the prior
session (28) or reset when rounds 1893→first-row were skipped.

## Interlude — self-settle sweep (2026-08-02T02:43:13Z)

Rent exhaustion discovered during E5 (deploy failed with system error
Custom:1 — insufficient lamports for the deployment PDA): the owner's
settle crank has been offline all session, so every deployment's rent
stayed locked. Swept 34 unsettled deployments (ours + the armer's —
settle is permissionless, rent to the cranker) in one pass; 7 failed
(rounds not yet in a settleable state). Last: [`2MpKWYG6H9ow…`](https://explorer.solana.com/tx/2MpKWYG6H9owTQmHCQzEwBgMGBLuaSpyTL37HmjYqXj9aQKs3E7FTPCP8mjDHMNSrunroZkUZKBG2CVPhewCpJ82?cluster=devnet)

- SOL: 0.00135 → 0.06360 (+0.06225 rent reclaimed net of fees)
- Miner unclaimed USD: $0.0000 → $3.2384
- Miner unclaimed shares: 141384 → 193790
- Miner hashrate: 579 → 1766

**Operational lesson:** SELF_SETTLE is not just rent-optimization — when the
owner's crank is down, it is the ONLY way rent and winnings come back.
Keep SELF_SETTLE=true.

## E3 — Discretionary automation behavior (2026-08-02T02:44:31Z)

- created Discretionary automation (mask 0, $1/round, reload, $2 deposit): [`3x8bitEXFQj3…`](https://explorer.solana.com/tx/3x8bitEXFQj3MDsuKYAR9XydoyJnBLTfrzDqVHLJUYYH1g1r5Uhm1fiVCr3gMDM2c6KGdkMwAe3BMotdmpnaB97E?cluster=devnet)
- top_up $1 → ok: [`5s7GvzWAXGdX…`](https://explorer.solana.com/tx/5s7GvzWAXGdXeWEJ6fWx64Tv4koAfkpnNru7aYf55Y2fXc9Qk1GfkDvLdFv9Q1CUrYAWmYTR924Q7pju1pCAMX7k?cluster=devnet)
- observing idle board (round 1903) for 90s — does the crank fire the automation with no activity?
- CRANK FIRED on idle board: round 1903, mask 2031611
- armed round 1905 for self-execute test: [`4gm5uhGphA8C…`](https://explorer.solana.com/tx/4gm5uhGphA8CBQ7QWyPC9ohkZ1rLFCVsqaeroi3xaXpmN4BPHj7NCKSe14nudR9g3DDXN3eSSXUKhhThgWc4f2UC?cluster=devnet)
- self execute_public_automation Some(mask=128) round 1905: FAILED: {"InstructionError":[2,{"Custom":0}]} |  [`cvQwP3x7Y4Dz…`](https://explorer.solana.com/tx/cvQwP3x7Y4DzywrjqCh9k9KqpAjsL7svTa8rNNPowp9m4HNUyiZNdDcveLgJfXBDdegjVXS9pFyyTriihj8p3hc?cluster=devnet)
- stranger execute Some(mask=512) round 1906: FAILED: {"InstructionError":[2,{"Custom":6000}]} |  [`hYrz55JocsQd…`](https://explorer.solana.com/tx/hYrz55JocsQdnip8Tn8Tr7mntqKF7UpGeuSYy2sf4a2s8pgfXZivzkTbY21xN4wASmis2Am4PazXzJAjtCpxBVX?cluster=devnet)
- stranger execute None same round: failed: {"InstructionError":[2,{"Custom":6000}]} [`4Gm7uaoxmgVT…`](https://explorer.solana.com/tx/4Gm7uaoxmgVTzdSvroauKCZM7YfFder1ArT1bjnbtUfq9ryrq6J9y5ipu9DGu7xegeKTHMEoxSgm6Y1SwdjTL3q6?cluster=devnet)
- automation state pre-cancel: remaining $0.8096, total_spent $3.0000, escrow ATA $0.8096 — reload compounding not observed in this window (no automation win settled)
- cancel_public_automation: escrow reclaimed [`2xPmcvhnhTrX…`](https://explorer.solana.com/tx/2xPmcvhnhTrX4XvcmpeTn32vmXZMkCKSPA28paP41N5HoVkxVi3kuyeA2dbm25AYhJpK2eGhBAooRdPZ3Bf83xZC?cluster=devnet)

**Conclusions (Q3/Q7):**
- Crank preemption: the owner's crank DOES execute Discretionary automations unprompted (mask 2031611).
- Authority self-execute with Some(mask): see evidence line above.
- Stranger execute: see evidence lines — this decides whether Discretionary masks are authority-gated.
- reload compounding: not conclusively observed unless an automation deployment won during the window (see evidence).

## E3 addendum — corrected conclusions (post-analysis)

Three of E3's automated conclusion lines undersold the evidence:

1. **reload=true COMPOUNDING CONFIRMED.** Pre-cancel state was
   `total_spent $3.0000` (the entire $2+$1 deposit) with
   `remaining $0.8096` still in escrow. $0.8096 is *exactly* a solo-round
   win pot ($1 × 0.92 × 0.88) — one of the automation's three
   crank-executed rounds won and the USD winnings were reloaded into the
   automation ATA, which is the only way `remaining` can exceed
   deposit − spent = $0. Winnings compound into the escrow.

2. **The crank preempts Discretionary automations EVERY round — including
   arming idle boards itself.** It executed our automation within ~60s of
   creation on a fully idle board (round 1903, mask 2031611 = 19 tiles,
   all but tiles 2 and 16), and had already taken rounds 1904–1905 before
   our own execute attempt. The earlier "rounds stay disarmed until
   someone deploys" behavior existed only because no automation was
   registered. **Consequence for the strategy client: any live automation
   (anyone's) keeps rounds rotating continuously, and a Discretionary
   automation surrenders its mask choice to the owner's backend.** The
   crank's mask policy in this sample: near-full coverage (19/21).

3. **Execute authorization:** the stranger wallet's
   `execute_public_automation` failed with **6000 Unauthorized** (both
   Some(mask) and None) — the instruction is signer-gated in the program,
   not by account derivation. Our own self-execute failed with the system
   "account already in use" error (Custom 0) because the crank had already
   created the round's deployment — preemption, not authorization,
   blocked it. So: executor ∈ {automation authority, round_authority
   (owner's crank)}; strangers are rejected; whether the *authority's*
   Some(mask) overrides on a Discretionary remains untested because the
   crank wins the race every round — it would need an execute fired in
   the same slot the round opens.

## Vault tickets — hashrate cost measured (2026-08-03, epoch vault)

Live devnet `buy_epoch_tickets` from the test wallet (iteration 293, an open
$971 pool with 0 prior tickets): bought **5 tickets**, miner `hashrate_amount`
went **1795 → 1295 = 500 spent → 100 hashrate points per ticket** (NOT 1:1 as
first inferred from the IDL — there is no price constant in the IDL, so it had
to be measured). Entry recorded 5 tickets; iteration total_tickets 0 → 5. Tx:
[`2UPj2Wk4vRAX…`](https://explorer.solana.com/tx/2UPj2Wk4vRAXyvTSXTTh75sbjiqxQup95yRDXvv9PyKFbEP4s7bVTxmJXgfpHvu3JSVyeYwi4LLgSarh2RBgwgNg?cluster=devnet)

Consequence: the vault EV model must convert hashrate points → tickets at this
price (config `VAULT_HASHRATE_PER_TICKET`, default 100). Also confirmed live:
the builders, PDAs, and page/entry init all land correctly, and the decoders
round-trip against real on-chain vault accounts. **Verify the price on mainnet
before enabling live.**

1-BTC vault confirmed too (iteration 19): `buy_one_btc_tickets` with a fresh
ticket-keypair signer landed, 2 tickets for 200 hashrate → **also 100
points/ticket** (uniform across both vaults). Tx:
[`2ch9Dyta5DjB…`](https://explorer.solana.com/tx/2ch9Dyta5DjBBwagSY9tCz3cKkf5W2Sb5orWbwMWognZYxkAS87sT6aYy3EZPXRFLYFCZ7pr1PxCKdxxxAvrHJd6?cluster=devnet)
