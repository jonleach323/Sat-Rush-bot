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

## Open questions (devnet experiments will answer — do not assume)
1. Does deploy amount split across masked tiles, or apply per tile? Is TileStake.stake
   raw USD or streak-multiplied effective stake?
2. Can a wallet deploy twice in one round (accumulate), or is it one-shot?
3. Does the owner's crank execute Discretionary automations unprompted (preempting the
   round's one deployment slot with a stored/default mask), or does it wait for the
   authority? Can the authority self-execute with Some(mask)? Can a stranger?
4. Exact slot boundary where RoundNotActive fires relative to end_slot.
5. Streak multiplier growth curve and cap — and does the streak update at deploy time
   or settle time?
6. Actual SatrushConfig values on devnet.
7. When in the round does the owner's crank fire automation deploys? (Measurable from
   is_automation + slot on PublicDeployCreated events.)

## Roadmap notes from the owner
- The `public` naming exists because private (Zinc-style) deployments are planned
  later, possibly transitioning to full-private. Launch is public-only. Therefore:
  model occupancy as partial-observable from day one — GameState carries
  visibleStakes[21] plus a hiddenPoolEstimate (0 for now) — so the privacy era is a
  model swap, not a rewrite. The information edge is largest in the public-only era.
- The owner's backend crank runs automation execution and deployment settlement.
  Self-settle remains valuable (immediacy; rent refund goes to whoever cranks) and is
  config-toggleable.
