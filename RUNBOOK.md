# RUNBOOK — mainnet launch, operations, rollback

Everything here assumes the devnet findings in FINDINGS.md and the defaults
in SIMULATION.md. The bot enforces its own gates: **mainnet mode will not
start unless every fatal preflight gate passes** (`src/ops/preflight.ts`,
also runnable standalone via `pnpm preflight`).

## 0. Pre-committed limits (decide these the night before, not launch morning)

| knob | launch value | scale-up rule |
|---|---|---|
| MAX_PER_ROUND_USD | minimum viable (= on-chain min deploy, likely $1) | ×2 only after each 50-round review |
| DAILY_LOSS_CAP_USD | 10 × MAX_PER_ROUND | never raise mid-day |
| STAKE_LADDER_USD | 1 | revisit with MAX_PER_ROUND |
| STRATEGY | water_filling | — |
| SWEEP_ENABLED | false | enable only after claim-fee math is verified on mainnet |
| SELF_SETTLE | true | load-bearing (FINDINGS.md interlude) — never disable |

## 1. Launch morning sequence

1. **Flip endpoints.** `.env`: `RPC_HTTP_URL` + `SECONDARY_RPC_URLS` to the
   mainnet RPCs, `GRPC_URL`/`GRPC_TOKEN` to the mainnet Yellowstone,
   `EXECUTION_MODE=mainnet`, `MAINNET_CONFIRM` **unset for now**.
2. **Confirm the program ID.** If the owner kept the vanity keypair
   (`satRushGBRY…`), the existing IDL stands. If mainnet has a new address:
   obtain the **mainnet IDL** from the owner, replace `satrush.json`, set
   `PROGRAM_ID`, and re-run the full test suite (`pnpm test`) — the coders,
   discriminators and PDAs all derive from that file.
3. **Re-dump the config:**
   `EXECUTION_MODE=devnet pnpm exec tsx scripts/experiments/e6-config-dump.ts`
   pointed at mainnet RPC (e6 only reads; the devnet gate just guards
   sends). Diff every fee bps against FINDINGS.md E6. Any change →
   recompute the EV pipeline constants before proceeding (preflight will
   also trip at >25% drift, but review ANY drift manually).
4. **Recalibrate the fire offset:**
   run `scripts/experiments/e4-cutoff-boundary.ts` against mainnet with the
   launch wallet (7 probes at min stake). Set `FIRE_OFFSET_SLOTS` =
   (smallest offset that landed) + 1. Devnet baseline was floor 3 → offset
   4 on public RPC; expect ~2 colocated.
5. **Preflight drill, then arm:**
   - `pnpm preflight` — expect only `mode_gate` failing (MAINNET_CONFIRM unset).
   - Set `MAINNET_CONFIRM=yes`, run `pnpm preflight` again — ALL gates green.
6. **Live at minimum ladder for 10 rounds:** start (`pnpm dev`), watch
   `/status` per round. After ~10 played rounds verify in sqlite that
   settlements reconcile: every `my_deploys` row `landed` has a matching
   `settlements` row and `pnl_daily.net` equals returned − deployed
   (`SELECT * FROM pnl_daily; SELECT status, COUNT(*) FROM my_deploys GROUP BY 1;`).
   Expected at min stake: small negative drift (fees) unless boards are
   busy — the point is reconciliation, not profit.
7. **Scale per the pre-committed caps** — one doubling at a time, 50-round
   review between steps, `/pnl` and `pnl_daily` as the source of truth.

## 2. Rollback / emergency stop

Fastest to slowest — all of these stop *new* risk immediately:

1. **Telegram `/kill`** — trips the in-memory kill switch; every
   `authorize()` blocks; no restart clears it until the process restarts.
2. **`touch KILL`** in the working directory (or `KILL_SWITCH_FILE` path) —
   works even if Telegram is down; survives restarts until the file is
   removed; checked immediately before every send.
3. **SIGINT/SIGTERM** the process — graceful shutdown, farewell alert, DB
   closed. In-flight round: the bankroll latch already prevents re-fires;
   an already-sent deploy settles normally later.

The kill switch stops deploys, settles, and sweeps. It does NOT cancel a
transaction already on the wire — that one resolves via confirm.ts and is
recorded either way.

## 3. Drain procedure (exit the game entirely)

1. `/kill` (or `touch KILL`) and stop the bot.
2. **Settle everything:** `EXECUTION_MODE=mainnet pnpm exec tsx
   scripts/experiments/settle-sweep.ts` — permissionless settles for every
   outstanding deployment; reclaims deployment rent and credits pending
   winnings (this recovered $3.24 + 52k shares + 0.062 SOL on devnet when
   the owner's crank was down).
3. **Claim USD:** `claim_usd` for the full `Miner.unclaimed_usd_amount`
   (builder: `buildClaimUsd`).
4. **Claim BTC shares:** `claim_sats` for the full
   `Miner.unclaimed_btc_shares` — note the 1000 bps claim fee and the 35%
   deferred-hashrate conversion; there is no way around the claim fee, so
   drain in ONE claim, not several.
5. Transfer USDC/BTC/SOL out of the operator wallet.
6. If an automation exists (it shouldn't — this client deploys directly):
   `cancel_public_automation` reclaims the escrow.

## 4. If account layouts differ from the IDL

Symptoms: `HaltError: failed to decode …`, tile-count/monotonicity halts,
or `satrush_config_decodes` failing in preflight. This means the program
was upgraded and OUR IDL IS STALE.

1. The bot already did the right thing: HaltError trips the kill switch and
   alerts; nothing further is sent. Do not restart it.
2. Do NOT guess layouts or patch offsets by hand — every coder,
   discriminator, and PDA in this codebase derives from `satrush.json`
   (CLAUDE.md ground rule).
3. Request the updated IDL from the owner; replace `satrush.json`;
   run `pnpm test` (161 tests re-validate coders round-trip);
   re-run e6 + preflight; only then relaunch.

## 5. Known operational facts (measured — see FINDINGS.md)

- Rounds are 50 slots; the clock arms on the FIRST deploy; with any live
  automation registered anywhere, the owner's crank keeps rounds rotating
  continuously and preempts Discretionary automations every round.
- Deploys must execute in a slot ≤ end_slot; public-RPC floor was
  cutoff 3; one deploy per wallet per round, final at fire time.
- Streak resets to 1 after ANY missed round and updates at deploy time —
  continuous play preserves the multiplier snapshot.
- The owner's settle crank can be offline for hours: self-settle is the
  only guaranteed path for rent + winnings recovery.
- The strike pool can grow very large ($1,957 on devnet, untriggered for
  ~1,850 rounds); `STRIKE_SIZE_BOOST` stays 1.0 until trigger mechanics
  are understood.
