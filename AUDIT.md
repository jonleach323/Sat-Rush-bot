# AUDIT — adversarial money-path review (2026-08-02)

Reviewer posture: assume the code loses money; "looks correct" is not a
finding. Every fix below has a regression test named. Acceptance evidence:

```
pnpm typecheck   → clean (tsc --noEmit, 0 errors)
pnpm test        → Test Files 26 passed (26) · Tests 226 passed (226)
pnpm sim         → 6 scenarios × 2 splits × 5 strategies, 10000 rounds each — ~22s, all sim assertions green
```

The suites added by this audit: `test/guards.test.ts`,
`test/reconcile.test.ts`, `test/chaos.test.ts`, `test/recovery.test.ts`,
plus additions to `test/bankroll.test.ts` and `test/db.test.ts`.

---

## Findings (fixed)

### F1 — Strike-boost cap divergence: bot could send MORE than authorized · HIGH (config-gated)
`selectorConfig()` boosted `maxPerRound` by `STRIKE_SIZE_BOOST` while the
`Bankroll` was constructed with the UNboosted cap. With `STRIKE_SIZE_BOOST>1`
the selector produced a larger deploy, `authorize()` silently clamped to the
unboosted cap and returned a smaller figure — which the orchestrator
**discarded**, sending the pre-signed larger amount. The daily-loss check
also used the smaller clamped figure. **Reproduced**: selector built **$15**,
bankroll authorized **$5**, $15 would ship.
Gated behind non-default `STRIKE_SIZE_BOOST` (default 1.0), hence "config-gated."
- **Fix**: `authorize()` now takes an explicit effective cap; the orchestrator
  passes `effectiveMaxPerRoundBase()` (the SAME value fed to the selector) to
  both, so the authorized amount equals what ships. The pre-send chokepoint
  (F2) additionally asserts `sent === authorized` and re-checks the daily cap
  on the ACTUAL amount.
- **Tests**: `guards.test` "strike-boost divergence … HALTS"; `bankroll.test`
  accessors; reproduction rerun as `guards.test`.

### F2 — No single pre-send invariant chokepoint · HIGH
Money-path guards were spread across the selector, bankroll, and instruction
builders, computed at different times from possibly-divergent config; the
actual bytes about to be signed were never re-validated at the last line.
- **Fix**: `src/exec/guards.ts` — `assertDeployInvariants()` runs immediately
  before `sender.fire()` and hard-throws `HaltError` on: kill engaged, latch
  not held, amount non-integer / not a ladder-quantum multiple / < min-deploy
  / > effective max-per-round / > u64, daily-cap breach on the actual amount,
  invalid mask (mirrors program 6007), priority-fee or Jito-tip outside config
  maxima. `assertFeeBearingInvariants()` guards settle/claim. Violations HALT,
  never log-and-continue.
- **Tests**: `guards.test` (valid passes; 13 distinct violations each HALT;
  daily-cap re-check; fee/tip clamp).

### F3 — One-deploy latch not atomic · MEDIUM
The latch relied on there being no `await` between `authorize()`'s
`deployedRounds.has` check and `commit()`. Correct today, but a future async
insert would silently open a double-fire window.
- **Fix**: `Bankroll.tryCommit(roundId)` — synchronous atomic check-and-set,
  true only for the first caller; used as the latch in `tryFire()`.
- **Tests**: `bankroll.test` "tryCommit is atomic".

### F4 — No reconciliation tripwire · HIGH
A surviving parse/model bug (wrong field, decimals off, payout-formula
misunderstanding) would compound losses silently, round after round.
- **Fix**: `src/strategy/reconcile.ts` `reconcileRoundOutcome()` runs after
  every settlement of ours, comparing realized `won_usd`/`won_shares` to the
  modeled parimutuel share for the ACTUAL winning tile and our ACTUAL stake.
  EXACT direction checks (paid-without-covering, covered-but-unpaid) plus a
  coarse magnitude check. Any failure calls `engageKillSwitch()`.
- **Tests**: `reconcile.test` (direction trips, magnitude trip, no-false-trip
  within tolerance, normal-loss passes).

### F5 — No wallet-drift tripwire · MEDIUM
Nothing halted on unexpected USDC leaving the wallet.
- **Fix**: `reconcileWalletDrift()` on a 30s timer — halts if on-chain USDC
  dropped by MORE than everything deployed since baseline plus tolerance (a
  drain/bug, not fee noise). Coarse and directional by design.
- **Tests**: `reconcile.test` (drain trips, inflow/normal pass).

### F6 — Kill switch was in-memory only; a restart resumed on bad data · MEDIUM
`tripKillSwitch()` set an in-memory flag. Under `systemd Restart=always`, an
integrity halt would be cleared on restart and the bot would resume trading
into the same bad state.
- **Fix**: `engageKillSwitch()` (used for every integrity halt: invariant,
  reconcile, HaltError, unhandled error) also writes the `KILL_SWITCH_FILE`;
  `killSwitchEngaged()` checks it, so the halt survives restart until a human
  clears it.
- **Tests**: file-based kill covered by `bankroll.test` "kill file on disk".

### F7 — No global error boundary · MEDIUM
An unhandled rejection/exception could crash mid-send or be swallowed.
- **Fix**: entrypoint installs `process.on("unhandledRejection")` and
  `("uncaughtException")` → `haltFromError()` → `engageKillSwitch()`;
  uncaughtException also exits so systemd restarts into a KILL-halted process.
- **Tests**: halt path (`engageKillSwitch`) exercised; the process-level
  wiring is verified by inspection (see residual R4).

### F8 — DB writes not transactional per round · LOW→MEDIUM
Per-round writes were separate autocommits; a crash mid-sequence could leave
a settlement without its pnl update.
- **Fix**: `StateDb.transaction()` (better-sqlite3 transaction); the
  settlement record + `refreshDaily` now commit atomically.
- **Tests**: `db.test` "transaction() is atomic / commits on success".

### F9 — Restart mid-round lost the latch → duplicate-deploy attempt · MEDIUM
On boot the in-memory latch was empty, so a restart during a round we had
already played could attempt a second `deploy_public` (one-shot on-chain, so
it would fail — wasting a fee and corrupting accounting).
- **Fix**: `boot()` re-arms the latch from `my_deploys` for every recorded
  round before the state machine starts.
- **Tests**: `recovery.test` (a played round cannot be re-deployed after a
  simulated restart; a fresh round still can).

---

## Chaos gauntlet — every scenario ends halted-or-skipped

| scenario | outcome | evidence |
|---|---|---|
| truncated Round account | `HaltError`, no trade | `chaos.test` |
| tile stakes decrease mid-round | `HaltError` (monotonicity) | `chaos.test`, `ingest.test` |
| 6005 on every send | classified `missed_round`, never a false `landed` | `chaos.test`, `confirm.test` |
| gRPC killed mid-round | staleness flag blocks firing; ws-rpc watchdog rebuilds | live acceptance (index stage) + `tryFire` stale guard |
| fee source returns garbage | `FeeEstimator` clamps to [MIN,MAX]; invalid → assembleTx `RangeError` | `fees.test`, `tx.test` |
| blockhash expiry mid-retry | `missed_round/blockhash_expired`, not re-fired | `confirm.test` |
| secondary RPC hangs | sends are fire-and-forget `.catch()`; primary drives confirm | `sender.test` |

---

## Residual risks (could NOT be eliminated) → containing control

A report claiming zero residual risk is a failed audit. These remain:

- **R1 — Model/predictor accuracy.** The EV engine and v1 linear occupancy
  predictor can mis-size within a direction the reconcile tripwire won't catch
  (a bet that still loses "as modeled" is not a mismatch). *Controls*: 50-round
  canary at minimum ladder (RUNBOOK §8), reconcile tripwire, daily loss cap,
  `ev_expected`-vs-realized recorded per round for review.
- **R2 — Reconcile magnitude check is coarse.** The USD/BTC payout split is
  not fully characterized (CLAUDE.md open items), so magnitude uses a generous
  tolerance; a mid-size mis-payout inside tolerance could pass, or too-tight a
  tolerance could false-trip (fails safe: a false trip only halts). *Controls*:
  exact direction checks (cannot false-trip), configurable `RECONCILE_TOLERANCE`
  set tight during canary, manual review of the first settlements.
- **R3 — Wallet-drift is coarse.** Fees, the BTC-leg, and claims are not
  precisely ledgered, so only gross drains trip. *Controls*: SOL-floor and
  slot-lag health alerts, daily loss cap, canary sizing.
- **R4 — Error-boundary wiring is not end-to-end unit-tested.** The
  `process.on` handlers are verified by inspection; the halt mechanism they
  invoke is tested. *Controls*: KILL-file persistence, `systemd Restart` into a
  halted process, preflight on restart.
- **R5 — RPC/data trust.** Helius could serve stale or wrong account data; the
  staleness/slot-lag guards catch silence, not subtly-wrong-but-fresh data.
  *Controls*: staleness + slot-lag alerts, dual-RPC race, reconcile tripwire.
- **R6 — Counterparty/protocol risk.** The owner can change fees or upgrade the
  program; the crank can go offline. *Controls*: preflight economics gate
  (>25% fee drift blocks launch), `HaltError` on any layout/decode change,
  `SELF_SETTLE`, and the $95k cold-storage firewall (the ultimate cap).
- **R7 — Non-integrity kill is not durable by design.** A Telegram `/kill`
  clears on restart; only integrity halts persist via the KILL file. *Control*:
  documented — use the KILL file (or `systemctl disable`) for a durable stop.
- **R8 — Clock/slot dependence.** Fire timing assumes a synced clock.
  *Control*: chrony in the RUNBOOK §6 checklist.
- **R9 — UTC-midnight pnl split.** A deploy at 23:59 settling at 00:01 splits
  across days, briefly loosening the daily cap. *Control*: accepted; caps are
  per-UTC-day, canary sizing bounds the exposure.

The load-bearing containment for everything above is the same three-layer
stack: **caps** (per-round + daily, re-checked at the last line) → **tripwires**
(reconcile + wallet-drift → persisted kill) → **canary + cold-storage
firewall**. No single software guarantee is trusted alone.
