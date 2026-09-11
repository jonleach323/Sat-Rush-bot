/**
 * Live round watcher — the ingest layer's acceptance harness.
 * Prints a one-line round summary on every occupancy change and logs every
 * decoded program event. Uses Yellowstone gRPC when GRPC_URL is set,
 * otherwise falls back to websocket RPC subscriptions.
 *
 *   pnpm exec tsx scripts/watch.ts
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "../src/adapter/idl.js";
import { loadConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { minerPda, satsVaultPda } from "../src/adapter/pdas.js";
import { HaltError } from "../src/ingest/decode.js";
import { parseTransactionEvents } from "../src/ingest/events.js";
import { YellowstoneIngest } from "../src/ingest/grpc.js";
import { bootstrapGameState } from "../src/ingest/snapshot.js";
import type { IngestSource } from "../src/ingest/types.js";
import { WsRpcIngest } from "../src/ingest/wsrpc.js";

const cfg = loadConfig();
const programId = new PublicKey(cfg.PROGRAM_ID);

// Optional identity: without a keypair we simply skip the miner stream.
let minerAuthority: PublicKey | undefined;
try {
  const raw = JSON.parse(readFileSync(cfg.KEYPAIR_PATH, "utf8")) as number[];
  minerAuthority = Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey;
} catch {
  logger.warn({ keypairPath: cfg.KEYPAIR_PATH }, "no keypair — watching without a miner stream");
}

const connection = new Connection(cfg.RPC_HTTP_URL, "processed");
const state = await bootstrapGameState(connection, { minerAuthority, programId });

logger.info(
  {
    roundId: state.board?.round_id,
    roundDuration: state.board?.round_duration,
    strikePoolUsd: state.strikePoolUsd().toString(),
    config: state.satrushConfig
      ? {
          usdMint: state.satrushConfig.usd_mint.toBase58(),
          btcMint: state.satrushConfig.btc_mint.toBase58(),
          minDeployUsd: state.satrushConfig.min_deploy_usd_amount.toString(),
          strikeFeeBps: state.satrushConfig.strike_fee_bps,
          epochFeeBps: state.satrushConfig.epoch_fee_bps,
          oneBtcFeeBps: state.satrushConfig.one_btc_fee_bps,
          satsVaultRoundFeeBps: state.satrushConfig.sats_vault_round_fee_bps,
          satsVaultClaimFeeBps: state.satrushConfig.vault_exit_fee_bps,
          protocolFeeBps: state.satrushConfig.protocol_fee_bps,
          unclaimedHashrateBps: state.satrushConfig.unclaimed_hashrate_bps,
        }
      : null,
  },
  "bootstrapped from HTTP RPC",
);

const watchAccounts = [satsVaultPda(programId)];
if (minerAuthority) watchAccounts.push(minerPda(minerAuthority, programId));

const source: IngestSource = cfg.GRPC_URL
  ? new YellowstoneIngest({
      endpoint: cfg.GRPC_URL,
      xToken: cfg.GRPC_TOKEN,
      programId,
      watchAccounts,
      stalenessMs: cfg.STALENESS_MS,
    })
  : new WsRpcIngest({
      httpUrl: cfg.RPC_HTTP_URL,
      programId,
      watchAccounts,
      stalenessMs: cfg.STALENESS_MS,
    });
logger.info(
  { source: cfg.GRPC_URL ? "yellowstone-grpc" : "ws-rpc-fallback" },
  "starting ingest",
);

// ── one-line round summaries on occupancy change ────────────────────────────

const usd = (base: bigint) => {
  const s = (Number(base) / 1e6).toFixed(2);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
};

function roundStateName(): string {
  const round = state.currentRound();
  if (!round) return "?";
  return Object.keys(round.state)[0] ?? "?";
}

let lastSignature = "";

function printIfChanged(): void {
  const round = state.currentRound();
  if (!round || !state.board) return;
  const stakes = state.visibleStakes();
  const signature = [
    round.id,
    roundStateName(),
    round.miners_count,
    stakes.join("|"),
  ].join("~");
  if (signature === lastSignature) return;
  lastSignature = signature;

  const hhmmss = new Date().toISOString().slice(11, 23);
  console.log(
    `[${hhmmss}] round=${round.id} state=${roundStateName()} ` +
      `slotsToCutoff=${state.slotsToCutoff() ?? "disarmed"} miners=${round.miners_count} ` +
      `stakes=[${stakes.map(usd).join(",")}]`,
  );
}

// ── event logging ────────────────────────────────────────────────────────────

function plain(value: unknown): unknown {
  if (value instanceof BN) return (value as BN).toString();
  if (value instanceof PublicKey) return (value as PublicKey).toBase58();
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]),
    );
  }
  return value;
}

// ── wire it up ───────────────────────────────────────────────────────────────

function halt(err: unknown): never {
  if (err instanceof HaltError) {
    logger.fatal({ context: err.context }, `HALT: ${err.message}`);
  } else {
    logger.fatal({ err: String(err) }, "HALT: unexpected ingest failure");
  }
  process.exit(1);
}

source.on("slot", (u) => state.applySlot(u.slot));

source.on("account", (u) => {
  try {
    const applied = state.applyAccount(u.pubkey, u.data);
    if (applied?.kind === "Round" || applied?.kind === "Board") printIfChanged();
  } catch (err) {
    halt(err);
  }
});

source.on("txLogs", (u) => {
  if (u.failed) return;
  for (const event of parseTransactionEvents(u)) {
    logger.info(
      { slot: event.slot, sig: event.signature, data: plain(event.data) },
      `event ${event.name}`,
    );
  }
});

source.on("status", (s) => {
  if (s.connected) logger.info({ detail: s.detail }, "ingest connected");
  else logger.warn({ detail: s.detail }, "ingest disconnected");
});

let wasStale = false;
setInterval(() => {
  const isStale = source.stale();
  if (isStale !== wasStale) {
    wasStale = isStale;
    if (isStale) {
      logger.warn(
        { slotAgeMs: Math.round(source.lastUpdateAgeMs("slots")) },
        "ingest STALE — critical stream quiet past STALENESS_MS",
      );
    } else {
      logger.info("ingest fresh again");
    }
  }
}, 500).unref();

await source.start();
printIfChanged();

process.on("SIGINT", () => {
  void source.stop().finally(() => process.exit(0));
});
