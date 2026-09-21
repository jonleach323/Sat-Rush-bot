# Sat Rush fleet bot

An EV-maximizing client for Sat Rush V2 on Solana: 21 wallets, one tile each,
sized every round to the model's optimum and funded from one address.
The complete model is `SAT-RUSH-MODEL.md`; operations are `RUNBOOK.md`.

## Quickstart (three steps)

```
pnpm install
pnpm setup --mainnet --wait     # writes .env, creates the 21 keypairs, prints the deposit QR, waits for funds
pnpm dev                        # runs the bot
```

`pnpm setup` prints ONE address, the primary wallet, with Solana Pay QR codes
for USDC and SOL. Scan them with Phantom, Solflare or Backpack and send the
minimum it shows (420 USDC + 0.72 SOL for 21 wallets; more USDC funds more
rounds — the bot converts about 15% of volume into vault shares as it plays).
The bot claims, distributes and rebalances across the fleet itself, and
tells you on Telegram (`/deposit`, `/fleet`) or the dashboard when it needs
more.

Without `--mainnet` the bot runs dry: it prices every round and sends
nothing. `--mainnet` sets `EXECUTION_MODE=mainnet` and `MAINNET_CONFIRM=yes`
in `.env`, which is the only gate on real sends.

Set `RPC_HTTP_URL` (and ideally `GRPC_URL`) in `.env` to a Helius endpoint;
the public RPC works for setup but rate-limits a live bot.

## What you never set

Sizes, presence, the streak ramp, hashrate spend, the wallet floats and the
risk limits are all derived from the board and the bankroll each round (see
`RUNBOOK.md` § 10 and `CLAUDE.md`). The kill switch file and the execution
gate are the only manual controls.
