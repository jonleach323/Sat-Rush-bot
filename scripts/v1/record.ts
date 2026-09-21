/**
 * State-layer acceptance runner: the watcher pipeline recording into SQLite
 * (rounds, occupancy snapshots, competitor deploys, my deploys, settlements,
 * pnl_daily) with the health monitor attached.
 *
 * AUTO_DEPLOY=1 additionally plays minimum-size rounds through the REAL
 * exec path (selector → bankroll → pre-built candidates → race sender) so
 * an idle devnet board produces activity. Spend is bounded by the bankroll:
 * MAX_PER_ROUND_USD per round, DAILY_LOSS_CAP_USD total.
 *
 *   EXECUTION_MODE=devnet AUTO_DEPLOY=1 RECORD_SECONDS=240 \
 *     STRATEGY=k_emptiest pnpm exec tsx scripts/record.ts
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../../src/config.js";
import { logger } from "../../src/logger.js";
import { minerPda, satsVaultPda } from "../../src/adapter/pdas.js";
import { HaltError } from "../../src/ingest/decode.js";
import { isKnownEvent, parseTransactionEvents } from "../../src/ingest/events.js";
import { YellowstoneIngest } from "../../src/ingest/grpc.js";
import { bootstrapGameState } from "../../src/ingest/snapshot.js";
import type { IngestSource } from "../../src/ingest/types.js";
import { WsRpcIngest } from "../../src/ingest/wsrpc.js";
import { feeModelFromConfig, type EvContext } from "../../src/strategy/ev.js";
import { predictFinalOccupancy } from "../../src/strategy/predict.js";
import type { SelectorConfig } from "../../src/strategy/selector.js";
import { Bankroll } from "../../src/strategy/bankroll.js";
import { CandidateSet } from "../../src/exec/candidates.js";
import { FeeEstimator } from "../../src/exec/fees.js";
import { RaceSender } from "../../src/exec/sender.js";
import { loadKeypair } from "../../src/exec/tx.js";
import { StateDb } from "../../src/state/db.js";
import { Pnl, utcDate } from "../../src/state/pnl.js";
import { HealthMonitor } from "../../src/ops/health.js";
import { usdToBase } from "../../src/units.js";
import type { PublicDeployCreated, PublicDeploySettled, RoundRevealed } from "../../src/adapter/idl.js";

const cfg = loadConfig();
const autoDeploy = process.env["AUTO_DEPLOY"] === "1" && cfg.EXECUTION_MODE !== "mainnet";
const recordSeconds = Number(process.env["RECORD_SECONDS"] ?? 180);
const programId = new PublicKey(cfg.PROGRAM_ID);
const connection = new Connection(cfg.RPC_HTTP_URL, "processed");

const db = new StateDb(cfg.DB_PATH);
const pnl = new Pnl(db);

let payer: Keypair | null = null;
try {
  payer = loadKeypair(cfg.KEYPAIR_PATH);
} catch {
  logger.warn("no keypair — recording only, no deploys");
}
void readFileSync; // (loadKeypair covers file IO)

const state = await bootstrapGameState(connection, {
  minerAuthority: payer?.publicKey,
  programId,
});
if (!state.satrushConfig) throw new Error("no on-chain config");
const fees = feeModelFromConfig(state.satrushConfig);
const ixCtx = {
  usdMint: state.satrushConfig.usd_mint,
  btcMint: state.satrushConfig.btc_mint,
  tokenMint: state.satrushConfig.token_mint,
};

const bankroll = new Bankroll(
  {
    ladder: cfg.STAKE_LADDER_USD.map(usdToBase),
    maxPerRound: usdToBase(cfg.MAX_PER_ROUND_USD),
    dailyLossCap: usdToBase(cfg.DAILY_LOSS_CAP_USD),
    minDeploy: BigInt(state.satrushConfig.min_deploy_usd_amount.toString()),
    killSwitchFile: cfg.KILL_SWITCH_FILE,
  },
  { realizedLossToday: () => pnl.realizedLossToday() },
);
const feeEstimator = new FeeEstimator({
  minMicroLamports: cfg.PRIORITY_FEE_MIN_MICROLAMPORTS,
  maxMicroLamports: cfg.PRIORITY_FEE_MAX_MICROLAMPORTS,
});
await feeEstimator.refreshFromRpc(connection);
const candidates = payer
  ? new CandidateSet({
      connection,
      payer,
      ixCtx,
      feeEstimator,
      computeUnitLimit: cfg.DEPLOY_CU_LIMIT,
    })
  : null;
const sender = new RaceSender({
  mode: cfg.EXECUTION_MODE,
  connections: [connection, ...cfg.SECONDARY_RPC_URLS.map((u) => new Connection(u, "processed"))],
  jitoUrl: cfg.JITO_BLOCK_ENGINE_URL,
  logger,
});

const watch = [satsVaultPda(programId)];
if (payer) watch.push(minerPda(payer.publicKey, programId));
const source: IngestSource = cfg.GRPC_URL
  ? new YellowstoneIngest({
      endpoint: cfg.GRPC_URL,
      xToken: cfg.GRPC_TOKEN,
      programId,
      watchAccounts: watch,
      stalenessMs: cfg.STALENESS_MS,
    })
  : new WsRpcIngest({
      httpUrl: cfg.RPC_HTTP_URL,
      programId,
      watchAccounts: watch,
      stalenessMs: cfg.STALENESS_MS,
    });

const selectorCfg: SelectorConfig = {
  strategy: cfg.STRATEGY,
  ladder: cfg.STAKE_LADDER_USD.map(usdToBase),
  maxPerRound: usdToBase(cfg.MAX_PER_ROUND_USD),
  minDeploy: BigInt(state.satrushConfig.min_deploy_usd_amount.toString()),
  kEmptiest: cfg.K_EMPTIEST,
};

function evContext(): EvContext {
  const board = state.board;
  const elapsed =
    board && state.currentSlot > 0 && state.slotsToCutoff() !== null
      ? state.currentSlot - Number(board.start_slot.toString())
      : 0;
  const prediction = predictFinalOccupancy({
    visibleStakes: state.visibleStakes(),
    hiddenPoolEstimate: state.hiddenPoolEstimate,
    elapsedSlots: Math.max(0, elapsed),
    remainingSlots: state.slotsToCutoff() ?? 0,
  });
  return {
    predictedStakes: prediction.stakes,
    fees,
    multiplier: 1,
    semantics: cfg.STAKE_SEMANTICS,
  };
}

// ── recording ────────────────────────────────────────────────────────────────

// The board rotates before the reveal event arrives — cache each round's
// armed slot window as we see it so the rounds table keeps its timing.
const roundSlotWindows = new Map<number, { start: number; end: number }>();
const U64_MAX = 0xffff_ffff_ffff_ffffn;

function cacheRoundWindow(): void {
  const board = state.board;
  if (!board) return;
  const end = BigInt(board.end_slot.toString());
  if (end === U64_MAX) return; // disarmed
  roundSlotWindows.set(board.round_id, {
    start: Number(board.start_slot.toString()),
    end: Number(end),
  });
  for (const id of roundSlotWindows.keys()) {
    if (id < board.round_id - 8) roundSlotWindows.delete(id);
  }
}

function recordRoundFromState(roundId: number, reveal?: RoundRevealed): void {
  const round = state.round(roundId);
  const window = roundSlotWindows.get(roundId);
  db.recordRound({
    id: roundId,
    startSlot: window?.start ?? null,
    endSlot: window?.end ?? null,
    winningTile: reveal ? reveal.winning_tile : (round?.winning_tile ?? null),
    deployedUsd: BigInt(round?.deployed_usd_amount.toString() ?? "0"),
    winningTileUsd: BigInt(round?.deployed_usd_on_winning_tile_amount.toString() ?? "0"),
    minersCount: round?.miners_count ?? 0,
    strikeTriggered: reveal?.is_strike_triggered ?? false,
    feesJson: reveal
      ? JSON.stringify({
          epoch: reveal.epoch_fee_usd_amount.toString(),
          oneBtc: reveal.one_btc_fee_usd_amount.toString(),
          protocol: reveal.protocol_fee_usd_amount.toString(),
          strikeBonusUsd: reveal.strike_bonus_usd.toString(),
        })
      : "{}",
  });
}

source.on("slot", (u) => {
  state.applySlot(u.slot);
  if (autoDeploy) void maybeDeploy();
});

source.on("account", (u) => {
  try {
    const applied = state.applyAccount(u.pubkey, u.data);
    if (applied?.kind === "Board") cacheRoundWindow();
    if (applied?.kind === "Round" && applied.roundId !== undefined) {
      const round = state.round(applied.roundId);
      if (round) {
        db.recordOccupancySnapshot(
          applied.roundId,
          u.slot,
          round.public_tile_stakes.map((t) => BigInt(t.stake.toString())),
          cfg.GRPC_URL ? "grpc" : "wsrpc",
        );
      }
      if (autoDeploy) void refreshCandidates(applied.roundId);
    }
  } catch (err) {
    if (err instanceof HaltError) {
      bankroll.tripKillSwitch(`HaltError: ${err.message}`);
      logger.fatal({ context: err.context }, `HALT: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
});

source.on("txLogs", (u) => {
  if (u.failed) return;
  for (const event of parseTransactionEvents(u)) {
    if (!isKnownEvent(event) && event.name !== "RoundRevealed") continue;
    if (event.name === "PublicDeployCreated") {
      const data = event.data as PublicDeployCreated;
      if (payer && data.authority.equals(payer.publicKey)) {
        db.markDeployLandedByRound(data.round_id, event.slot);
      } else {
        db.recordCompetitorDeploy({
          roundId: data.round_id,
          authority: data.authority.toBase58(),
          mask: data.selection_mask,
          amount: BigInt(data.deployed_usd_amount.toString()),
          totalStake: BigInt(data.total_stake_usd_amount.toString()),
          isAutomation: data.is_automation,
          reload: data.reload,
          slot: event.slot,
          sig: event.signature,
        });
      }
      logger.info(
        { round: data.round_id, authority: data.authority.toBase58().slice(0, 8) },
        "deploy recorded",
      );
    } else if (event.name === "RoundRevealed") {
      const data = event.data as RoundRevealed;
      recordRoundFromState(data.round_id, data);
      logger.info({ round: data.round_id, tile: data.winning_tile }, "round recorded");
    } else if (event.name === "PublicDeploySettled") {
      const data = event.data as PublicDeploySettled;
      if (payer && data.authority.equals(payer.publicKey)) {
        db.recordSettlement({
          roundId: data.round_id,
          winningStake: BigInt(data.winning_stake.toString()),
          wonUsd: BigInt(data.won_usd_amount.toString()),
          wonShares: BigInt(data.won_shares_amount.toString()),
          hashrateEarned: BigInt(data.hashrate_earned.toString()),
          sig: event.signature,
        });
        pnl.refreshDaily();
        logger.info(
          { round: data.round_id, wonUsd: data.won_usd_amount.toString() },
          "settlement recorded",
        );
      }
    }
  }
});

// ── auto-deploy (real exec path, bankroll-gated) ────────────────────────────

let firing = false;

async function refreshCandidates(roundId: number): Promise<void> {
  if (!candidates || !state.board || roundId !== state.board.round_id) return;
  try {
    await candidates.refresh(roundId, evContext(), selectorCfg);
  } catch (err) {
    logger.warn({ err: String(err) }, "candidate refresh failed");
  }
}

async function maybeDeploy(): Promise<void> {
  if (!candidates || !payer || firing || !state.board) return;
  const roundId = state.board.round_id;
  if (bankroll.hasDeployed(roundId)) return;
  const round = state.round(roundId);
  if (round && !("Active" in round.state)) return;

  const cutoff = state.slotsToCutoff();
  // Fire when inside the offset window — or immediately on a disarmed round
  // (our deploy is what arms the clock).
  const shouldFire = cutoff === null || (cutoff > 0 && cutoff <= cfg.FIRE_OFFSET_SLOTS);
  if (!shouldFire) return;

  firing = true;
  try {
    let candidate = candidates.best(roundId);
    if (!candidate) {
      await refreshCandidates(roundId);
      candidate = candidates.best(roundId);
    }
    if (!candidate) return;

    const auth = bankroll.authorize(roundId, candidate.selection.totalGross);
    if (!auth.ok) {
      logger.info({ roundId, reason: auth.reason, detail: auth.detail }, "deploy blocked");
      return;
    }
    bankroll.commit(roundId); // latch BEFORE send
    db.recordMyDeploy({
      roundId,
      mask: candidate.selection.mask,
      amount: candidate.selection.totalGross,
      evExpected: candidate.selection.ev,
      firedSlot: state.currentSlot,
      sig: candidate.signature,
      status: cfg.EXECUTION_MODE === "dry" ? "dry" : "fired",
    });
    logger.info(
      {
        roundId,
        mask: candidate.selection.mask,
        tiles: candidate.selection.tiles,
        amount: candidate.selection.totalGross.toString(),
        cutoff,
      },
      "FIRING deploy",
    );
    const result = await sender.fire(
      {
        signature: candidate.signature,
        serialized: candidate.serialized,
        lastValidBlockHeight: candidate.lastValidBlockHeight,
        meta: { roundId, mask: candidate.selection.mask },
      },
      { isPastCutoff: () => (state.slotsToCutoff() ?? 1) <= -10 },
    );
    if (result.outcome === "landed") {
      db.updateMyDeployStatus(candidate.signature, "landed", result.landedSlot);
    } else if (result.outcome === "missed_round") {
      db.updateMyDeployStatus(candidate.signature, "missed");
    } else if (result.outcome !== "dry") {
      db.updateMyDeployStatus(candidate.signature, "failed");
    }
    pnl.refreshDaily();
  } finally {
    firing = false;
  }
}

// ── health monitor (alerts to log; telegram attaches when token is set) ─────

const health = new HealthMonitor(
  {
    ingestStale: () => source.stale(),
    ingestSlotAgeMs: () => source.lastUpdateAgeMs("slots"),
    snapshotSlot: () => state.currentSlot,
    rpcSlot: () => connection.getSlot("processed"),
    solBalanceLamports: () =>
      payer ? connection.getBalance(payer.publicKey, "processed") : Promise.resolve(1e9),
    dbLastWriteError: () => db.lastWriteError(),
    alert: (m) => void logger.warn({ health: true }, m),
  },
  { solFloorLamports: Math.round(cfg.SOL_FLOOR_SOL * 1e9) },
);
health.start(10_000);

// ── run window + report ──────────────────────────────────────────────────────

logger.info(
  { mode: cfg.EXECUTION_MODE, autoDeploy, recordSeconds, db: cfg.DB_PATH },
  "recording started",
);
await source.start();

await new Promise((r) => setTimeout(r, recordSeconds * 1000));
await source.stop();
health.stop();

console.log("\n════════ SQLITE STATE AFTER RUN ════════");
console.log("table counts:", db.tableCounts());
const show = (label: string, sql: string) => {
  console.log(`\n-- ${label}`);
  for (const row of db.query<Record<string, unknown>>(sql)) console.log(JSON.stringify(row));
};
show("rounds", "SELECT * FROM rounds ORDER BY id DESC LIMIT 6");
show(
  "occupancy_snapshots (latest 5)",
  "SELECT round_id, slot, source, substr(stakes_json,1,80) AS stakes FROM occupancy_snapshots ORDER BY id DESC LIMIT 5",
);
show("competitor_deploys", "SELECT * FROM competitor_deploys ORDER BY id DESC LIMIT 5");
show("my_deploys", "SELECT * FROM my_deploys ORDER BY id DESC LIMIT 5");
show("settlements", "SELECT * FROM settlements ORDER BY id DESC LIMIT 5");
show("pnl_daily", `SELECT * FROM pnl_daily WHERE date = '${utcDate()}'`);
db.close();
process.exit(0);
