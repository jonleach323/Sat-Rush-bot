# RUNBOOK — mainnet launch, operations, rollback

Everything here assumes the devnet findings in FINDINGS.md and the defaults
in SIMULATION.md. The bot enforces its own gates: **mainnet mode will not
start unless every fatal preflight gate passes** (`src/ops/preflight.ts`,
also runnable standalone via `pnpm preflight`).

## 0. Capital structure + pre-committed limits (decided 2026-08-02, before launch)

**Bankroll: $100,000 total. Split: $95,000 cold storage / $5,000 operator
float.** The cold wallet is a hardware wallet whose key never touches the
VPS, this repo, or any machine the bot runs on. The bot can only ever lose
what is in the operator wallet — a physical cap no config or code path can
exceed. Cold→hot top-ups are manual, deliberate, and phase-gated below.
"Float" counts wallet balance PLUS unclaimed in-protocol value (the
`unclaimed` line in `/status`) — winnings sitting in the program's vault
are still at risk.

Sweep discipline: weekly, move anything above the phase float from hot →
cold. Claim USD freely; claim BTC shares RARELY and in large chunks (the
1000 bps claim fee punishes frequent claims).

**Posture: MAX EXTRACTION within the $5k.** The $95k firewall is the risk
management; inside the float, the EV engine takes every positive-EV dollar
from day one. Water-filling self-limits (marginal EV → 0 stops allocation
before over-deployment dilutes returns), so the caps below are BACKSTOPS
sized to bind only on model failure — not throttles. Two instruments keep
this honest:

- **cap-bound alert** (Telegram): fires when MAX_PER_ROUND bound while the
  next quantum's marginal EV was still positive — i.e., capital, not the
  model, limited the round. Repeated cap-bound alerts = the signal to
  consider a deliberate float top-up from cold.
- **usdc_low health alert**: wallet USDC below one full-size fire — the
  bot is silently under-extracting; top up the float.

| knob | launch value | rationale |
|---|---|---|
| MAX_PER_ROUND_USD | $1,000 (= DAILY_LOSS_CAP) | NO independent per-round throttle: the bot sizes purely by marginal EV. bankroll.authorize() already bounds every fire by the day's remaining loss budget, so this knob is set equal to the daily cap and only that cap binds. Sizing accuracy is protected by the predictor's extrapolation guards (min 5 slots observed, ratio ≤ 5×) — the EV stop is only as good as the predicted stakes. |
| DAILY_LOSS_CAP_USD | $1,000 (20% of float) | ruin protection ONLY — a broken model needs 5 consecutive worst-case days to zero the float, leaving time to react. Ruin ends extraction; this cap protects the extracting. |
| STAKE_LADDER_USD | 1 | $1 quantum keeps allocation granular |
| STRATEGY | water_filling | — (k_emptiest fallback never runs unattended: it deploys regardless of EV) |
| SWEEP_ENABLED | false | enable only after claim-fee math is verified on mainnet |
| SELF_SETTLE | true | load-bearing (FINDINGS.md interlude) — never disable |

Standing rules:
- **Never raise DAILY_LOSS_CAP mid-day.** Raising the per-round cap in
  response to cap-bound alerts is fine (that IS max extraction); raising
  the daily stop while losing is tilt.
- Float top-ups beyond $5,000 are a deliberate cold-wallet decision made
  on a green day, not a config edit during a drawdown.
- The 20% rake is the viability bar: if realized edge after ~1,000 rounds
  doesn't clear it, more capital multiplies losses — drain per §3 instead.
- Weekly: claim + sweep everything above $5,000 (wallet + unclaimed) to cold.

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

## 6. VPS provisioning + server checklist

Deploy flow: `./deploy/deploy.sh user@vps` — builds + verifies locally,
rsyncs the repo (**never** `.env`, `keypairs/`, `data/`), installs the
systemd unit, restarts, tails `journalctl`. Secrets are placed once, by
hand (unit reads `/etc/satrush/.env`; keypair at
`/opt/satrush/keypairs/operator.json`, chmod 600).

One-time provisioning:

```bash
sudo useradd -r -m -d /opt/satrush satrush
sudo mkdir -p /etc/satrush /opt/satrush/{keypairs,data}
sudo chown -R satrush:satrush /opt/satrush
# place /etc/satrush/.env (root:satrush 640) with at minimum:
#   EXECUTION_MODE=dry            # first boot is ALWAYS dry
#   KEYPAIR_PATH=/opt/satrush/keypairs/operator.json
#   DB_PATH=/opt/satrush/data/satrush.db
#   RPC/GRPC endpoints, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, caps
```

Checklist before first launch (verify each, in order):

- [ ] **Clock synced:** `chronyc tracking` → `Leap status: Normal`,
      offset < 10ms. Slot-based firing assumes a sane clock.
- [ ] **Firewall:** `ufw default deny incoming && ufw allow ssh && ufw enable`;
      `ufw status verbose` shows deny-inbound, SSH only. The bot makes
      outbound connections only — nothing listens.
- [ ] **Node LTS:** `node --version` ≥ 20 (install via nodesource or nvm,
      then `corepack enable` for pnpm). `pnpm install` on the server
      compiles better-sqlite3 against the server ABI — never rsync
      node_modules.
- [ ] **Swap:** 2G swapfile active (`swapon --show`) — protects the ~150MB
      node process from OOM on 1GB boxes during pnpm installs.
- [ ] **DB on persistent disk:** `DB_PATH=/opt/satrush/data/satrush.db`
      and `/opt/satrush` is NOT tmpfs (`df /opt/satrush`). pnl_daily is
      the loss-cap memory — losing it resets the daily cap accounting.
- [ ] **Unit installed + enabled:** `systemctl is-enabled satrush` →
      `enabled`; logs flowing: `journalctl -u satrush -n 20`.
- [ ] **Telegram from the phone:** `/status` answers; `/kill` engages the
      switch (verify a `deploy blocked … kill_switch_engaged` line or
      `/status` showing ⛔), then RESTART the service to clear it
      (`sudo systemctl restart satrush`) — the in-memory trip is
      intentionally not persisted, the KILL file variant is.
- [ ] **Reboot-survival test (in dry mode):** `sudo systemctl reboot`.
      After the box returns: `journalctl -b -u satrush | head -40` shows
      the unit auto-started, preflight-free dry boot, `orchestrator
      started` + `STATE BOOT → SYNCED → ROUND_OPEN` with **no manual
      steps**. Only after this passes does EXECUTION_MODE ever change
      from `dry`.
- [ ] **Crash-loop guard sanity:** `systemctl show satrush -p Restart,RestartUSec`
      → `always / 3s`. Kill the process (`sudo pkill -f dist/index.js`)
      and confirm journald shows it back within ~5s.

Operational notes:

- `Restart=always` + the in-memory kill switch: a service restart CLEARS a
  Telegram `/kill`. For a stop that survives restarts and reboots, use the
  KILL file (`touch /opt/satrush/KILL`) or `systemctl disable --now satrush`.
- Upgrades are just `./deploy/deploy.sh user@vps` again — rsync + restart;
  the unit's 15s stop timeout covers the graceful shutdown path.
- The dry-mode ground rule holds on the server exactly as locally: dry
  refuses to send; mainnet refuses to start without every preflight gate.
