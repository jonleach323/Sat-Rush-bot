# Project: Sat Rush Strategy Client

## What this is
An automated strategy client for Sat Rush, an on-chain game on Solana
(program: satRushGBRY2vgapeTAkoxz26vL2cYqyPi6CnBj7Tco, devnet now, mainnet imminent).
Players deploy USDC onto a 21-tile board each round; one winning tile is drawn from
slot-hash entropy; the pot is swapped to BTC on-chain and winners are paid in vault shares.

## Authorization & provenance
- The game's owner has explicitly authorized this client and is actively supporting
  the build: he provided the Anchor IDL (`satrush-idl.json`, repo root) and devnet test funds.
- Automated play is a first-class feature of the program itself: it ships a
  `PublicAutomation` account with Static/Random/Discretionary strategies. This client is
  the direct-deploy equivalent — the same category of tool, with better information timing.
- The client trades only the operator's own funds, from the operator's own wallet.

## Ground rules (never violate)
- `EXECUTION_MODE` env gate: `dry` (default) | `devnet` | `mainnet`. Code must refuse
  to send transactions in `dry`. `mainnet` additionally requires `MAINNET_CONFIRM=yes`.
- Risk limits are load-bearing: MAX_PER_ROUND, DAILY_LOSS_CAP, and the kill switch must
  be enforced in the execution path, not just configured.
- All amounts in base units (USDC 6 decimals; BTC token decimals read from mint).
- Never hardcode account layouts, discriminators, or PDA seeds from memory —
  derive everything from `satrush-idl.json`.
- Secrets (keypair path, RPC URLs, Telegram token) come from `.env` only. `.env` is
  gitignored. Never print private keys.

## Numbers discipline (this is where every past error came from)
Nearly every wrong conclusion in this project was a bare `number` with no
provenance — not bad arithmetic. `evOfAllocation` verified exact against a
closed form while the answers it produced were wrong, because its INPUTS were
stale, invented, or duplicated. Rules:

- **The official SDK is the source of truth. Check it before measuring
  anything.** `@satrush/client` exports the program's real constants and
  formulas — `REWARD_MAX_STREAK`, `HASHRATE_PER_TICKET`, `TILE_COUNT`,
  `STRIKE_BOOST_*`, `hashrateReward()`, `satsToBtc()`, `getHashrateTicketsCount()`.
  Two constants were reverse-engineered for weeks (one of them a devnet
  measurement used for mainnet, one an outright assumption) that the SDK simply
  exports. `@satrush/api` (`https://api.satrush.io/api`) serves epoch
  participants, iteration history, leaderboards and per-wallet deployments —
  use it instead of scanning RPC signatures. `test/sdk-parity.test.ts` pins our
  implementations against the SDK's.
- **Every economic constant lives in `src/strategy/facts.ts`**, once, carrying a
  `Provenance`: `sdk` (strongest — the program's own constant) | `derived` (read
  from chain/config at use time) | `measured` (needs `n`, date, half-life,
  recheck command) | `stated` (by the owner) | `assumed` (must name the risk).
  Never inline the literal — `0.9333` survived in a script for weeks after being
  corrected in `ev.ts`.
- **Never report a point estimate without its standard error.** Use `Estimate`
  and `significant()` from facts.ts. A realized −25.45% over 193 single-tile
  deploys had a ±28.6-point standard error (z = −0.61) and was written up as a
  finding. Payout-based samples converge glacially at p = 1/21; ratio-based
  measurements converge fast — prefer the latter.
- **Our own config is never an economic input.** Reading `VAULT_MAX_TICKETS` to
  value hashrate concluded hashrate was worthless because we had configured
  ourselves not to spend it. Bound quantities economically (`VAULT_MAX_SHARE`).
- **Projecting a partial window means projecting EVERY dimension.** Scaling
  epoch tickets by `1/progress` while freezing the entrant count swung the
  answer by $200/day. Bracket the uncertain dimension; don't pick a value.
- **Every reconstruction needs a conservation check.** `strategy-compare`
  validates replayed gross against `Round.deployed_usd_amount × 1.250`; without
  it, scanning the Board PDA instead of the Round PDA silently dropped a third
  of deploys.
- **Don't assert operational state you have not read this turn.** "The KILL file
  is set" was repeated from a stale note while the bot was live and trading.
- `pnpm preflight` prints assumed and stale facts. Treat stale as an error.

## Stack
TypeScript, Node 20+, pnpm. Deps: @solana/web3.js v1, @coral-xyz/anchor,
@triton-one/yellowstone-grpc, better-sqlite3, grammy (Telegram), pino, zod, vitest, tsx.

## Architecture (one file per responsibility)
src/index.ts (state machine orchestrator) · src/config.ts · src/adapter/ (IDL-driven
PDAs, coders, ix builders) · src/ingest/ (Yellowstone gRPC + decoders + events) ·
src/strategy/ (ev, selector, bankroll) · src/exec/ (candidates, fees, sender, confirm) ·
src/state/ (SQLite, pnl) · src/ops/ (telegram, health) · scripts/experiments/ · test/

## Game facts (from the IDL — trust the IDL over this summary if they conflict)
- Board PDA ["board"]: round_id u32, round_duration u32, start_slot/end_slot u64,
  strike_pending_usd_amount, strike_usd_amount, strike_btc_amount,
  strike_last_trigger_round_id. Timing is SLOT-based; end_slot is the cutoff.
- Round PDA ["round", round_id u32 LE]: state enum {Active, Revealed, Settled, Finished},
  winning_tile Option<u8>, deployed_usd_amount, deployed_usd_on_winning_tile_amount,
  miners_count, public_tile_stakes: [ {stake u64, deploy_count u32} ; 21 ],
  strike_bonus_usd/btc, pending fee splits.
- Miner PDA ["miner", authority]: unclaimed_usd_amount, unclaimed_btc_shares,
  hashrate_amount, current_streak_count, last_mined_round_id, unclaimed_hashrate.
- PublicDeployment PDA ["public_deployment", authority, round_id u32 LE]:
  deployed_usd_amount, total_stake_usd_amount, selection_mask u32, streak_multiplier u32.
  Seeding implies at most one deployment account per wallet per round.
- SatrushConfig PDA ["satrush_config"]: all fee bps (strike, epoch, one_btc,
  sats_vault_round, sats_vault_claim, protocol), unclaimed_hashrate_bps,
  min_deploy_usd_amount, durations. SatsVault PDA ["sats_vault"]: btc_amount, btc_shares.
- Key instructions: deploy_public(selection_mask u32, amount u64) — mask selects 1–21
  tiles (error 6007 bounds it); settle_deploy_public() — permissionless, refunds rent to
  rent_recipient; claim_sats(shares u64); claim_usd(amount u64).
- Events (real-time via logs): PublicDeployCreated {authority, round_id,
  deployed_usd_amount, total_stake_usd_amount, selection_mask, is_automation, reload},
  RoundRevealed {round_id, winning_tile, is_strike_triggered, strike bonuses, fee splits},
  PublicDeploySettled {winning_stake, won_usd_amount, won_shares_amount, hashrate_earned},
  SatsClaimed.
- Relevant errors: 6005 RoundNotActive, 6007 InvalidSelectionMask.

## Open questions — ANSWERED (devnet experiments 2026-08-02; evidence with tx sigs in FINDINGS.md)
1. **Split-evenly, raw net USD.** The gross deploy loses the 800 bps deploy legs, then
   the net divides evenly across masked tiles (floor); TileStake.stake records raw net
   USD — the streak multiplier is NOT applied to tile stakes. Σ tile deltas ==
   total_stake_usd_amount. `PublicDeployment.streak_multiplier` is simply the raw
   streak count snapshot. → STAKE_SEMANTICS=raw (config default, confirmed).
2. **One-shot per round.** A second deploy_public fails at the system level
   (deployment PDA "already in use"). Deploy size and mask are final at fire time.
3. **The owner's crank preempts Discretionary automations every round — and arms idle
   boards itself.** It executed a fresh Discretionary automation within ~60s on an
   idle board, choosing its own 19-of-21-tile mask, and took every following round
   before the authority could. Strangers get 6000 Unauthorized. Authority Some(mask)
   override is untestable in practice — the crank wins the race each round.
   reload=true confirmed: winnings compound into the automation escrow ATA.
   Consequence: any live automation keeps rounds rotating continuously, and
   Discretionary means surrendering mask choice to the owner's backend — direct
   deploys (this client) are the only way to keep information timing.
4. **Deploys must execute in a slot ≤ end_slot.** Probes sent at cutoff 8/6/4/3
   landed (send→land 1–2 slots on public RPC); sent at 2/1/0 all failed 6005.
   Empirical FIRE_OFFSET_SLOTS floor ≈ 3 remote; default 4 keeps one slot of cushion;
   revisit ~2 when colocated.
5. **Streak: linear counter, updates at DEPLOY time, resets on a missed round.**
   current_streak_count increments each consecutively-played round (observed to 28,
   no cap seen) and snapshots into the deployment; missing one round resets it to 1
   (observed 28 → 1). Losses still earn hashrate; 35% (unclaimed_hashrate_bps) defers
   to claim time.
6. **Devnet SatrushConfig:** strike 264 / epoch 262 / one_btc 132 / sats_vault_round
   1200 / sats_vault_claim 1000 / protocol 142 bps; unclaimed_hashrate 3500 bps; min
   deploy $1; 50-slot rounds; epoch iteration 1000 slots; settle grace 0. BTC mint is
   8-decimals (cbBTC-style). Full dump incl. mints in FINDINGS.md (E6).
7. **Immediately, every round.** With any automation registered the crank executes at
   round open (it opened rounds itself on an idle board). The "disarmed until first
   deploy" board state only occurs when no automation exists.

Operational lesson (see FINDINGS.md interlude): the owner's settle crank can be
offline for long stretches — SELF_SETTLE=true is load-bearing, not an optimization:
it is how deployment rent and winnings come back.

## V2 (program upgrade, cutover 2026-09-11) — READ V2-STRATEGY.md
- The program is upgraded IN PLACE (same address) with account migrations. The
  "Game facts" section above describes V1 (`satrush-v1.json`). `satrush.json`
  is now the V2 IDL, REGENERATED from the SDK's Codama codecs by `pnpm idl:gen`
  (`scripts/idl/gen-idl-from-sdk.ts`, which also emits
  `src/adapter/generated-types.ts`) — never hand-edit either. `pnpm idl:verify`
  decodes live mainnet accounts + a settled event through it and diffs the
  deploy/settle builders against real transactions (FINDINGS.md § E-v2-idl).
- `@satrush/client@0.1.15` (published 2026-09-10) is the V2 SDK and is pinned.
  It settled the fee layer, the 89% losing-tile refund, the 5% sats leg, the
  RUSH 64/16/14/6 split, the coupled 10% vault exit fee, equal epoch prizes and
  the 2-round streak grace — see FINDINGS.md § E-v2-sdk. It does NOT contain the
  mint program: the RUSH emission rule and price are measured, never assumed.
- The V2 economics live in `src/strategy/ev-v2.ts` (`v2Model` plugs into the
  unchanged selector through the `EvModel` swap point in `ev.ts`); the numbers
  are `pnpm v2-strategy`. Sizing is on the 11% toll at risk, not the stake.
- V2 IS LIVE (2026-09-11). FINDINGS.md § E-v2-live verified the model to the cent:
  fee legs 208/194/48/100/50 bps, 89% losing-tile refund, swap = 5%·V + 89%·W_win,
  RUSH legs pro-rata by stake, hashrate on gross at the cap. The mint program
  (`sAtmiNt6…`) has no IDL and mints 1 RUSH per ~$3,600 (1.38% at spot), not the
  stated 1 per $500 — `RUSH_MINT_USD_YIELD` has a one-day half-life for that reason.
  Deploys must append the four rotor remaining accounts (`getRngRemainingAccounts`).
  `GET /v1/rounds/{id}` returns per-deployment settlements: the reconcile tripwire
  should be rebuilt on it. No docs exist outside the app; nothing publishes an IDL.
- Built: adapter/IDL + builders (deploy with rotor accounts, settle with the
  token leg, claim_token, distribute_epoch_reward replacing claim_epoch_reward),
  preflight re-baseline. Not built: orchestrator wiring (`GAME_VERSION`),
  wallet-set wiring, share-marked P&L, the V2 reconcile tripwire. Do not trade
  V2 live before those land (V2-STRATEGY.md § 6) — and on measured numbers the
  game is −1.0% per dollar even with 21 wallets (`pnpm v2-ledger`).

## Roadmap notes from the owner
- The `public` naming exists because private (Zinc-style) deployments are planned
  later, possibly transitioning to full-private. Launch is public-only. Therefore:
  model occupancy as partial-observable from day one — GameState carries
  visibleStakes[21] plus a hiddenPoolEstimate (0 for now) — so the privacy era is a
  model swap, not a rewrite. The information edge is largest in the public-only era.
- The owner's backend crank runs automation execution and deployment settlement.
  Self-settle remains valuable (immediacy; rent refund goes to whoever cranks) and is
  config-toggleable.
