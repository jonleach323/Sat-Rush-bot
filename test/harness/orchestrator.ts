/**
 * Boot an Orchestrator on fakes. Mirrors Orchestrator.boot() part for part
 * — same Bankroll, CandidateSet, RaceSender (dry), PriceFeed, WalletSet —
 * with the RPC connection, the ingest source and the chain state replaced
 * by fixtures. Tests drive slots and account writes through `source` and
 * observe the sender, the DB and the state machine.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { loadConfig, type Config } from "../../src/config.js";
import { BN } from "../../src/adapter/idl.js";
import { boardPda, minerPda, roundPda, satrushConfigPda, satsVaultPda, tokenVaultPda } from "../../src/adapter/pdas.js";
import type { InstructionContext } from "../../src/adapter/instructions.js";
import { CandidateSet } from "../../src/exec/candidates.js";
import { FeeEstimator } from "../../src/exec/fees.js";
import { RaceSender } from "../../src/exec/sender.js";
import { WalletSet } from "../../src/exec/wallets.js";
import { GameState } from "../../src/ingest/snapshot.js";
import { PriceFeed } from "../../src/ingest/prices.js";
import { Orchestrator, deriveLimits } from "../../src/index.js";
import { logger } from "../../src/logger.js";
import { Bankroll } from "../../src/strategy/bankroll.js";
import { feeModelFromConfig } from "../../src/strategy/ev.js";
import { StateDb } from "../../src/state/db.js";
import { Pnl } from "../../src/state/pnl.js";
import { usdToBase } from "../../src/units.js";
import { chaseStakes, encode, makeBoard, makeConfig, makeRound, makeSatsVault, makeTokenVault } from "./fixtures.js";
import { FakeConnection, FakeSource } from "./fakes.js";

export interface HarnessOptions {
  env?: Record<string, string>;
  fleetSize?: number;
  /** Per-tile rival stakes (base units as numbers) on the opening round. */
  stakes?: number[];
  roundId?: number;
  startSlot?: number;
  endSlot?: number;
  /** USDC on the primary / each extra wallet (base units). */
  primaryUsdc?: bigint;
  extraUsdc?: bigint;
}

export interface Harness {
  orch: Orchestrator;
  cfg: Config;
  source: FakeSource;
  conn: FakeConnection;
  sender: RaceSender;
  db: StateDb;
  state: GameState;
  wallets: WalletSet;
  programId: PublicKey;
  dir: string;
  killFile: string;
  /** Emit slots up to and including `to`. */
  slotsTo(to: number): void;
  /** Write a Round account with these stakes at `slot`. */
  roundUpdate(stakes: number[], slot: number): void;
  /** Let pending promises settle. */
  settle(ms?: number): Promise<void>;
  /** The orchestrator's private state, for assertions. */
  internals(): { botState: string; roundId: number | null };
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function bootHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "satrush-harness-"));
  const killFile = join(dir, "KILL");
  const fleetSize = opts.fleetSize ?? 3;
  const env: NodeJS.ProcessEnv = {
    EXECUTION_MODE: "dry",
    GAME_VERSION: "v1",
    KEYPAIR_PATH: join(dir, "operator.json"),
    FLEET_DIR: join(dir, "fleet"),
    FLEET_SIZE: String(fleetSize),
    DB_PATH: ":memory:",
    RPC_HTTP_URL: "http://127.0.0.1:1",
    RPC_WS_URL: "ws://127.0.0.1:1",
    KILL_SWITCH_FILE: killFile,
    PYTH_BTC_USD_ACCOUNT: "",
    PYTH_SOL_USD_ACCOUNT: "",
    PRICE_POLL_MS: "3600000",
    TOKEN_FEED_POLL_MS: "0",
    LOG_LEVEL: "silent",
    ...opts.env,
  };
  const cfg = loadConfig(env);
  logger.level = "silent";
  const programId = new PublicKey(cfg.PROGRAM_ID);

  WalletSet.ensurePrimary(cfg.KEYPAIR_PATH);
  if (fleetSize > 1) WalletSet.ensureFleet({ dir: cfg.FLEET_DIR, size: fleetSize });
  const wallets = WalletSet.load([], cfg.KEYPAIR_PATH, { dir: cfg.FLEET_DIR, size: fleetSize });
  const payer = wallets.primary().keypair;

  const config = makeConfig();
  const board = makeBoard({ round_id: opts.roundId ?? 100, start_slot: bn(opts.startSlot ?? 1_000), end_slot: bn(opts.endSlot ?? 1_230) });
  const round = makeRound(board.round_id, opts.stakes ?? chaseStakes());
  const conn = new FakeConnection(programId);
  conn.slot = opts.startSlot ?? 1_000;
  const [configBuf, boardBuf, roundBuf, svBuf, tvBuf] = await Promise.all([
    encode.config(config), encode.board(board), encode.round(round), encode.satsVault(makeSatsVault()), encode.tokenVault(makeTokenVault()),
  ]);
  conn.setAccount(satrushConfigPda(programId), configBuf);
  conn.setAccount(boardPda(programId), boardBuf);
  conn.setAccount(roundPda(board.round_id, programId), roundBuf);
  conn.setAccount(satsVaultPda(programId), svBuf);
  conn.setAccount(tokenVaultPda(programId), tvBuf);
  for (const [i, w] of wallets.all().entries()) {
    conn.lamports.set(w.keypair.publicKey.toBase58(), 100_000_000);
    conn.usdc.set(getAssociatedTokenAddressSync(config.usd_mint, w.keypair.publicKey).toBase58(), i === 0 ? (opts.primaryUsdc ?? usdToBase(1_000)) : (opts.extraUsdc ?? usdToBase(50)));
  }

  const state = new GameState(wallets.pubkeys().map((w) => minerPda(w, programId)));
  state.applyAccount(satrushConfigPda(programId), configBuf);
  state.applyAccount(boardPda(programId), boardBuf);
  state.applyAccount(satsVaultPda(programId), svBuf);
  state.applyAccount(tokenVaultPda(programId), tvBuf);
  state.applySlot(conn.slot);
  state.applyAccount(roundPda(board.round_id, programId), roundBuf, conn.slot);

  const db = new StateDb(cfg.DB_PATH);
  const fees = feeModelFromConfig(config);
  const pnl = new Pnl(db, { deployFeeBps: () => fees.deployFeeBps });
  const ixCtx: InstructionContext = { usdMint: config.usd_mint, btcMint: config.btc_mint, tokenMint: config.token_mint };
  await wallets.refreshBalances(conn.asConnection(), config.usd_mint);
  const limits = deriveLimits(cfg, wallets.totals().usdcBase, null);
  const bankroll = new Bankroll(
    { ladder: cfg.STAKE_LADDER_USD.map(usdToBase), maxPerRound: limits.maxPerRound, dailyLossCap: limits.dailyLossCap, minDeploy: BigInt(config.min_deploy_usd_amount.toString()), killSwitchFile: cfg.KILL_SWITCH_FILE, lossFractionAtRisk: 1 },
    { realizedLossToday: () => pnl.realizedLossToday() },
  );
  const feeEstimator = new FeeEstimator({ minMicroLamports: cfg.PRIORITY_FEE_MIN_MICROLAMPORTS, maxMicroLamports: cfg.PRIORITY_FEE_MAX_MICROLAMPORTS });
  await feeEstimator.refreshFromRpc(conn.asConnection());
  const prices = new PriceFeed({ connection: conn.asConnection(), accounts: {}, fallback: { btc: cfg.BTC_USD_ESTIMATE, sol: cfg.SOL_USD_ESTIMATE }, pollMs: 0 });
  await prices.start();
  const candidates = new CandidateSet({
    connection: conn.asConnection(),
    payer,
    ...(wallets.size > 1
      ? { wallets, fundingFloor: { minDeployBase: BigInt(config.min_deploy_usd_amount.toString()), minLamports: cfg.WALLET_MIN_LAMPORTS }, tileMode: cfg.FLEET_TILE_MODE, tileMinCover: cfg.FLEET_TILE_MIN_COVER }
      : {}),
    ixCtx,
    feeEstimator,
    computeUnitLimit: cfg.DEPLOY_CU_LIMIT,
  });
  const sender = new RaceSender({ mode: cfg.EXECUTION_MODE, connections: [conn.asConnection()], logger, mainnetConfirmed: false });
  const source = new FakeSource(cfg.STALENESS_MS);

  const orch = Orchestrator.forTest({ cfg, connection: conn.asConnection(), state, source, db, pnl, bankroll, candidates, sender, feeEstimator, payer, ixCtx, fees, prices, tokenFeed: null, wallets });
  orch.start();

  let lastSlot = conn.slot;
  return {
    orch, cfg, source, conn, sender, db, state, wallets, programId, dir, killFile,
    slotsTo(to) {
      for (let s = lastSlot + 1; s <= to; s++) {
        conn.slot = s;
        source.slot(s);
      }
      lastSlot = Math.max(lastSlot, to);
    },
    roundUpdate(stakes, slot) {
      const buf = accountsEncodeRoundSync(board.round_id, stakes);
      source.account(roundPda(board.round_id, programId), buf, slot, programId);
    },
    settle: (ms = 30) => sleep(ms),
    internals: () => ({ botState: (orch as unknown as { botState: string }).botState, roundId: (orch as unknown as { roundId: number | null }).roundId }),
    close: () => orch.close("harness"),
  };
}

const bn = (n: number) => new BN(n);

// Round encoding is async in the coder; tests need it synchronous to emit in a
// tight burst, so pre-encoded buffers are cached per stake vector.
const roundCache = new Map<string, Buffer>();
export async function primeRound(roundId: number, stakes: number[]): Promise<void> {
  roundCache.set(`${roundId}:${stakes.join(",")}`, await encode.round(makeRound(roundId, stakes)));
}
function accountsEncodeRoundSync(roundId: number, stakes: number[]): Buffer {
  const buf = roundCache.get(`${roundId}:${stakes.join(",")}`);
  if (!buf) throw new Error("harness: primeRound(roundId, stakes) first");
  return buf;
}

export function writeKill(h: Harness, reason = "operator hold\n"): void {
  writeFileSync(h.killFile, reason);
}
