# V1-era research scripts

Everything in this directory reasons about the PRE-UPGRADE program (the
800 bps deploy layer, the 12% sats-vault round leg, the ranked epoch curve,
winner-signed `claim_epoch_reward`). They are kept because FINDINGS.md cites
them as the evidence for the V1-era entries, and they still compile against
the V1 IDL types where those survive — but their economics are wrong for the
live V2 program and none of their conclusions should be re-run as current.

Run them as `pnpm v1:<name>`. The V2 equivalents live one level up:

| V1 script | V2 replacement |
|---|---|
| carry-check, sats-drift | `pnpm vault-carry` (both vaults, ratio series from the API) |
| full-accounting, redesign-model, v2-edge, accrual-ev | `pnpm v2-strategy`, `pnpm v2-ledger` |
| farming-verdict, farming-audit | `pnpm v2-ledger` (FARM-AND-SELL section) |
| dedup-effect, sybil-curve | `pnpm wallet-set`, `pnpm epoch-uplift` |
| strategy-compare, recompute, record, reconcile-ev, fire-timing | no V2 port yet — the replay needs V2 settlements (`GET /v1/rounds/{id}`) |
| strike-concentration | no V2 port yet |
| wait-for-mainnet | obsolete: mainnet launched 2026-08 and V2 cut over 2026-09-11 |
