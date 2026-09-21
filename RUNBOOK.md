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

## 0b. Rollout — devnet verify, then full mainnet (no canary)

Decision (operator, 2026-08-03): no canary warmup. The **$5,000 operator float
is the risk bound** — the bot can only ever lose what's in the hot wallet, and
the $95k cold firewall is the real containment. With the owner's $1M marketing
campaign imminent, the cost of waiting out a 50-round warmup outweighs its
benefit, so we validate once on devnet and then go straight to the §0
max-extraction caps on mainnet.

Rollout:
1. **Devnet verify** — run the full bot (deploy + vault) on devnet, confirm it
   deploys, settles, reconciles, and — with the vault enabled — buys/claims
   without tripwire halts. This is the correctness gate.
2. **Full mainnet** — arm at the §0 values immediately (`MAX_PER_ROUND_USD` =
   `DAILY_LOSS_CAP_USD` = $1,000; EV sizes each fire). No step-up ladder.

What is NOT removed (these are ruin protection, not a canary): the per-round +
daily caps, the persisted kill switch, and the reconcile / wallet-drift
tripwires all stay active on mainnet. If the KILL file appears, read the
alert/log reason, fix or explain it, then `rm KILL` and restart. `RECONCILE_
TOLERANCE` and `WALLET_DRIFT_TOLERANCE_USD` stay at their §0/​default values
(sized for full-size deploys, not $1 tickets).

## 1. Launch morning sequence

1. **Flip endpoints.** `.env`: `RPC_HTTP_URL` + `SECONDARY_RPC_URLS` to the
   mainnet RPCs, `GRPC_URL`/`GRPC_TOKEN` to the mainnet Yellowstone,
   `EXECUTION_MODE=mainnet`, `MAINNET_CONFIRM` **unset for now**.
2. **Confirm the program ID.** The program kept its vanity address
   (`satRushGBRY…`) through the V2 upgrade. `satrush.json` is generated from
   the pinned SDK (`pnpm idl:gen`) and checked against the chain
   (`pnpm idl:verify`) — see § 9; if the address ever changes, set
   `PROGRAM_ID`, regenerate, verify, and re-run `pnpm test`.
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
6. **Go live at the §0 caps.** After a green devnet verify (§0b step 1),
   start the service in mainnet mode at the full max-extraction values — no
   step-up ladder. EV sizes each fire; the daily cap + tripwires are the
   backstops. Watch `/status`, `/pnl`, and the reconcile line, and confirm in
   sqlite that settlements reconcile (`SELECT * FROM pnl_daily; SELECT status,
   COUNT(*) FROM my_deploys GROUP BY 1;`). A tripwire halt (KILL file) means
   stop and investigate — otherwise let the EV engine run.

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
3. Bump `@satrush/client` to the release matching the upgrade (nothing
   publishes an IDL; the SDK's codecs are the source), then
   `pnpm idl:gen && pnpm idl:verify && pnpm test` — the generator rebuilds
   `satrush.json` and `src/adapter/generated-types.ts`, the verifier reads
   the live accounts and diffs the builders against real transactions, and
   the suite re-validates the coders round-trip. Re-run preflight; only then
   relaunch. If the SDK has not been published yet, wait: a hand-patched
   layout is how money gets lost.

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

## 7. Monitoring: read-only API, dashboard, Telegram

Three views of the same read-only data layer (`src/ops/monitor.ts`). None
can control the bot — deploy/cap/kill are NOT reachable from any of them.

**Telegram** (from your phone): `/status` (V2: marked net with both share legs,
token yield, vault carry) `/wallets` (the fleet) `/pnl` `/board` `/rounds`
`/competitors` `/health` for viewing; `/pause` `/resume` `/kill` for
control (control is Telegram-only, gated to TELEGRAM_CHAT_ID). Plus the
unsolicited alerts (HaltError, missed round, daily-cap, cap-bound, low
SOL/USDC, gRPC stale).

**HTTP API + dashboard** (enabled only when API_TOKEN is set):
- Binds `127.0.0.1:8787` by default. Dashboard: `http://<host>:8787/?token=<API_TOKEN>`.
- `GET /health` (no auth, liveness for uptime monitors); `GET /api/status
  |pnl|health|rounds|deploys|competitors` (bearer or `?token=`).
- STRICTLY read-only: non-GET → 405, no control endpoints exist. A leaked
  token is info-disclosure (all on-chain-public anyway), never fund/control risk.

**Remote access — do NOT open a port** (breaks the ufw deny-inbound rule).
Use an outbound tunnel from the VPS:
- Cloudflare Tunnel: `cloudflared tunnel --url http://127.0.0.1:8787` →
  gives an HTTPS URL. Open `<url>/?token=<API_TOKEN>` on any device.
- or Tailscale: reach `http://<tailnet-ip>:8787` from your devices only.

**Letting Claude check it in a session:** expose via the tunnel above and
paste the HTTPS URL + token; Claude fetches `<url>/api/status` etc. and
diagnoses. Use a monitoring-scoped API_TOKEN you can rotate (it's read-only
and everything it shows is public chain data, but rotate it after sharing).

## 8. Send-path infrastructure (latency + inclusion)

Two independent latency paths — optimize them separately.

**Read path (board → bot).** Already optimal if colocated with the stream:
Helius LaserStream + a box in the same region (SLC). Verify on the dashboard —
`ingest.slotAgeMs` should be a few hundred ms (≈ one slot). Geography is what
makes this fast; nothing else to do.

**Send path (deploy → into a block).** The leader rotates nationwide, so your
geography barely helps here — you win on *how* you send, not *where from*. The
bot already race-sends the same signed tx to every `SECONDARY_RPC_URLS` endpoint
AND (when configured) a Jito bundle, simultaneously; identical signature, so
duplicate lands are impossible. To make that land in fewer slots:

1. **Staked / SWQoS send.** A plain RPC deprioritizes your tx under load — that's
   your tail latency. Use the Helius **Sender** endpoint (low-latency, no API
   key, dual-routes to validators + Jito) first in `SECONDARY_RPC_URLS`, with a
   normal RPC as fallback: `SECONDARY_RPC_URLS=http://slc-sender.helius-rpc.com/fast,https://<your-rpc>`.
   The single biggest, cheapest win. NOTE: Sender REQUIRES a Jito tip in the tx
   (min ~0.001 SOL = 1_000_000 lamports — verify in Helius docs), so set the tip
   below with `JITO_TIP_LAMPORTS=1000000` as the floor.
2. **Tip.** A tip is embedded on every fire whenever `JITO_TIP_ACCOUNTS` is set —
   Helius Sender requires one (Sender routes to validators + Jito itself), so this
   is NOT gated on `JITO_BLOCK_ENGINE_URL`. Use the tip accounts Helius gave you
   for the Sender path (see .env.example); one is picked at random per fire to
   dodge the write-lock hotspot. The tip is EV-scaled: `JITO_TIP_LAMPORTS` (floor)
   + `JITO_TIP_EV_FRACTION` (0.1 = bid 10% of the round's modeled EV), clamped to
   `JITO_TIP_MAX_LAMPORTS`. Set `SOL_USD_ESTIMATE` roughly right (converts
   EV→lamports). For Helius Sender set floor `1_000_000` and max higher (e.g.
   `5_000_000`) for EV-scaling room. `JITO_BLOCK_ENGINE_URL` is OPTIONAL — set it
   only for a redundant *direct* Jito bundle (which needs Jito's own tip accounts);
   with Helius Sender you can leave it unset and let Sender do the Jito routing.
3. **Priority fee.** `PRIORITY_FEE_MIN/MAX_MICROLAMPORTS` clamp the dynamic fee;
   raise the max in contention.

**Payoff — this lowers the latency the adaptive fire offset feeds on.**
`ADAPTIVE_FIRE_OFFSET` fires as late as your measured `landed_slot − fired_slot`
safely allows (see §5). As the staked/Jito path drops that latency from ~2 slots
toward ~1, the offset self-lowers from 4 toward its floor (2) — firing ~1 s later
with no manual retune, which is exactly what shrinks win-dilution. Watch the
"adaptive fire offset updated" log lines and the `land` column on the dashboard.

**Setup order:** add the staked endpoint → confirm deploys still land (dashboard
`land` column, near-zero "missed" alerts) → add the Jito URL + tip account →
confirm again → let the adaptive offset re-tune down on its own.

## 9. V2 operation (program upgrade of 2026-09-11)

The bot runs the V2 economics by default (`GAME_VERSION=v2`). What changed
operationally — everything else in this runbook still applies:

- **IDL.** `satrush.json` is generated from the SDK (`pnpm idl:gen`), never
  edited. After any SDK bump: `pnpm idl:gen && pnpm idl:verify && pnpm test`.
  `idl:verify` reads mainnet through the coders, matches 40 fields to the
  public API, decodes a settled event, and diffs the deploy/settle builders
  against live transactions — it must print ALL CHECKS PASSED before a
  restart into live mode.
- **Preflight** adds `game_version_matches_chain` (fatal on mainnet: a V1
  model against the V2 program is wrong) and `token_feed_live` (advisory:
  without the API the RUSH leg is priced at `RUSH_USD_ESTIMATE ×
  RUSH_MINT_PER_USD_ESTIMATE`, default 0). `MEASURED_ECONOMICS` is the live
  V2 config; the 25% drift gate is unchanged.
- **Token feed.** `SATRUSH_API_URL` `/board` every `TOKEN_FEED_POLL_MS`: RUSH
  oracle price × RUSH-per-$ measured over the last settled rounds = the
  token yield the selector credits. Stale past `TOKEN_FEED_MAX_AGE_MS` → the
  leg falls back to the estimates (default: worth nothing). The skip log
  line carries `tokenYield`, `blanketEvBps`, `emptiestEvBps` so you can see
  how far from +EV the board is without a debugger.
- **Expect skips.** On measured numbers the board is about −4% per dollar
  at the round level (FINDINGS § E-v2-dryrun); `no_positive_marginal_ev`
  every round is the model working, not a fault. It fires when the token
  yield, a strike pool, or the occupancy prediction makes a tile +EV.
- **Accounting.** A V2 win pays in BTC and RUSH vault shares, not USDC. The
  daily-loss figure marks the day's won shares (vault rate × live price ×
  (1 − exit fee); RUSH at 0 unless the feed is live) — the dashboard shows
  `markedNetTodayUsd` next to the USD-only `todayNetUsd`. The reconcile
  tripwire checks the exact 89% refund per deployment and halts on any
  deviation, on BTC shares without a covered winner, or on a missing RUSH
  leg. Claims: `claim_usd` compounds refunds (on by default); `claim_sats`
  and `claim_token` pay the 10% exit fee and stay opt-in.
- **Risk.** `MAX_PER_ROUND_USD` is still on gross. The daily cap counts 11%
  of each stake (the toll: `1 − refund`) as at risk, both in the bankroll
  and in the pre-send guard; realized losses are actual.
- **Epoch rewards** are no longer claimed by the winner: the bot cranks
  `distribute_epoch_reward(rank)`, which credits the winner's Miner (USD to
  the claim pool, BTC to sats shares, RUSH to token shares). Nothing reaches
  the wallet ATA until the claims above run.
- **Wallet set.** `WALLET_PATHS` (see .env.example). One process, aggregate
  caps split per round, one signed leg per wallet, per-wallet Miners,
  settles (the primary cranks and pays), sweeps, vault engines and claims.
  Fund each extra with USDC and `WALLET_MIN_LAMPORTS`; register the
  primary's affiliate tag in the app first so extras bind to it at their
  first deploy (`AFFILIATE_AUTHORITY` overrides). A leg that fails to land
  is alerted with the per-wallet outcomes; the round counts as played if any
  leg landed. The kill switch and pause apply to the whole fleet.
- **RPC load.** Do not point the bot at `rpc.satrush.io`: it rate-limits a
  poller within minutes (429 → Cloudflare 1015). Helius as before.
- **Re-measure before any live start.** `pnpm mint-rule`, `pnpm vault-carry`,
  `pnpm epoch-uplift`, `pnpm epoch-history`, `pnpm v2-timing`,
  `pnpm staking-yield` refresh every short-lived fact; preflight refuses a
  stale one. `pnpm hold-vs-stake` answers whether to leave winnings as
  unclaimed shares or claim and stake (hold, at today's rates);
  `pnpm buy-vs-mine` prices mining RUSH against buying it on Jupiter and
  staking (buy for any single-tile play; a small blanket at the streak cap
  mines it under spot, at break-even-to-+1% per round).
- **The map.** `SAT-RUSH-MODEL.md` is the complete model; `pnpm ev-map`
  prints every action's EV from live data. Start there before changing any
  economic setting.
- **The flip signal.** The selector prices the wallet's CURRENT streak, so
  a −EV board at streak 1 keeps the bot skipping even when a blanket at the
  cap would pay. Every skip log carries `blanketEvBpsAtStreakCap`; when it
  clears `RAMP_ALERT_MIN_BPS` (default 50) one Telegram alert says the ramp
  pays and mining RUSH beats buying it. Starting the ~100-round ramp is the
  operator's call (`pnpm streak-ramp` prices it); the alert re-arms after
  the signal drops below zero. Until then, bought-and-staked RUSH is the
  confirmed return (`pnpm hold-vs-stake`, `pnpm buy-vs-mine`). The mint rate drifts ~1.7% a day and the field's shape sets
  the dedup uplift, so a week-old number is wrong, not approximate.
- **Before the first live V2 round** (still outstanding): a real deploy +
  settle on a $1 stake with `MAX_PER_ROUND_USD=1`, watching the reconcile
  line; the first extra wallet's deploy (affiliate binding); and a vault
  draw trigger if the owner's crank ever lets one through (the rotor
  remaining accounts on the triggers are by analogy to deploy_public).

## 10. Running the 21-wallet fleet (tile mode + treasury)

The shape `pnpm ev-grid § C` prices best: 21 wallets, wallet i on tile i,
which is a blanket at the fleet level (identical refund / sats / strike /
RUSH flows) with every wallet earning the single-tile hashrate rate (121
raw/$ at the cap vs 101). One orchestrator, aggregate caps, one deposit
address.

1. **Create it.** Set `FLEET_SIZE=21` and `AFFILIATE_TAG=<tag>` and start
   the bot: on boot it generates any missing `keypairs/fleet/wallet-NN.json`
   (0600, never logged; the directory is gitignored) and, in mainnet mode,
   registers the tag on the primary (`set_miner_tag`) if the primary has no
   Affiliate account yet. `pnpm fleet:init 21 <tag>` does the same from the
   command line and prints the 21 public keys with their tiles. Both are
   idempotent; WALLET_PATHS stays empty.
2. **Fund it.** Send USDC and SOL to the PRIMARY (wallet 1, the first key
   printed). Nothing else needs funding by hand.
3. **The treasury does the rest.** Every `FLEET_REBALANCE_INTERVAL_MS` it
   refreshes balances, claims every wallet's unclaimed USD (the 89% refund
   coming home, fee-free), then moves USDC and SOL from the primary to the
   wallets below `FLEET_WALLET_LOW_*`, lowest runway first, up to
   `FLEET_WALLET_TARGET_*`, out of what the primary holds above its own
   target plus `FLEET_TREASURY_RESERVE_USD`; wallets above twice the target
   sweep the excess back. Top-ups are primary-signed, sweeps wallet-signed,
   all through the race sender with the kill switch respected. When the
   primary cannot cover the low wallets one Telegram alert says exactly what
   to deposit; `/fleet` shows balances, tile, runway in rounds, pending and
   last transfers. Dry mode plans and logs, sends nothing.
4. **Tile mode** (`FLEET_TILE_MODE`, default on): when the selector picks a
   full blanket, each wallet sends one single-tile transaction carrying its
   tile's share of the allocation; the selector prices the blanket's
   hashrate at one covered tile. A wallet that cannot fund its tile drops
   out for that round (its tile goes unplayed; the treasury fixes it next
   cycle); below `FLEET_TILE_MIN_COVER` covered tiles the round is skipped.
   Non-blanket selections fall back to the slice split. Every wallet binds
   to the primary's affiliate at its first deploy (10 bps of its volume
   comes back to the primary as grubstake and is deployed from there).
5. **Sizing.** `MAX_PER_ROUND_USD` is the FLEET's per-round gross; each
   tile gets a 21st of it. Per-wallet target/low marks should cover a few
   hundred rounds of that share: at $21/round fleet gross (a $1 tile each)
   the defaults ($20 target, $8 low) are ~20 rounds of pure misses per
   wallet, plenty since 89% refunds every round. Raise them with the stake.
6. **What to watch.** `/fleet` runway and the deposit alert; per-wallet
   streaks (every wallet must hold its own; a wallet that misses 3 rounds
   restarts its ramp); the skip log's `blanketEvBpsAtStreakCap` and the pot
   (`pnpm ev-grid § A`); transaction fees per wallet (2 tx/round each —
   the grace lets presence deploy every third round if fees bite).

