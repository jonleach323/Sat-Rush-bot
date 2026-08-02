/**
 * Orchestrator: the round state machine wiring ingest → strategy → exec →
 * state → ops.
 *
 *   BOOT → SYNCED → ROUND_OPEN → ARMED → FIRED → CONFIRMING → SETTLING →
 *   LOGGED → (next round → ROUND_OPEN)
 *
 * Strictly event-driven: every transition is caused by an ingest update
 * (slot tick, account update, transaction event). There are no polling
 * loops — the slot stream IS the tick.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type {
  PublicDeployCreated,
  PublicDeploySettled,
  RoundRevealed,
} from "./adapter/idl.js";
import {
  buildClaimSats,
  buildSettleDeployPublic,
  type InstructionContext,
} from "./adapter/instructions.js";
import { minerPda, satsVaultPda } from "./adapter/pdas.js";
import { loadConfig, type Config } from "./config.js";
import { CandidateSet } from "./exec/candidates.js";
import { FeeEstimator } from "./exec/fees.js";
import { RaceSender } from "./exec/sender.js";
import { assembleTx, loadKeypair } from "./exec/tx.js";
import { HaltError } from "./ingest/decode.js";
import { parseTransactionEvents } from "./ingest/events.js";
import { YellowstoneIngest } from "./ingest/grpc.js";
import { bootstrapGameState, type GameState } from "./ingest/snapshot.js";
import type { IngestSource } from "./ingest/types.js";
import { WsRpcIngest } from "./ingest/wsrpc.js";
import { logger } from "./logger.js";
import { HealthMonitor } from "./ops/health.js";
import { createTelegramOps, type TelegramOps } from "./ops/telegram.js";
import { StateDb } from "./state/db.js";
import { Pnl, utcDate } from "./state/pnl.js";
import { Bankroll, strikeSizeMultiplier } from "./strategy/bankroll.js";
import { feeModelFromConfig, type EvContext, type FeeModel } from "./strategy/ev.js";
import { predictFinalOccupancy } from "./strategy/predict.js";
import type { SelectorConfig } from "./strategy/selector.js";
import { usdToBase } from "./units.js";

export type BotState =
  | "BOOT"
  | "SYNCED"
  | "ROUND_OPEN"
  | "ARMED"
  | "FIRED"
  | "CONFIRMING"
  | "SETTLING"
  | "LOGGED";

const U64_MAX = 0xffff_ffff_ffff_ffffn;

export class Orchestrator {
  botState: BotState = "BOOT";
  private roundId: number | null = null;
  private paused = false;
  private fireInFlight = false;
  private skipLogged = new Set<string>();
  private wasStale = false;
  private settleFired = new Set<number>();
  private sweepInFlight = false;
  private readonly roundWindows = new Map<number, { start: number; end: number }>();

  private readonly log = logger;
  private telegram: TelegramOps | null = null;
  private readonly health: HealthMonitor;

  private constructor(
    private readonly cfg: Config,
    private readonly connection: Connection,
    private readonly state: GameState,
    private readonly source: IngestSource,
    private readonly db: StateDb,
    private readonly pnl: Pnl,
    private readonly bankroll: Bankroll,
    private readonly candidates: CandidateSet,
    private readonly sender: RaceSender,
    private readonly feeEstimator: FeeEstimator,
    private readonly payer: Keypair,
    private readonly ixCtx: InstructionContext,
    private readonly fees: FeeModel,
  ) {
    this.health = new HealthMonitor(
      {
        ingestStale: () => this.source.stale(),
        ingestSlotAgeMs: () => this.source.lastUpdateAgeMs("slots"),
        snapshotSlot: () => this.state.currentSlot,
        rpcSlot: () => this.connection.getSlot("processed"),
        solBalanceLamports: () =>
          this.connection.getBalance(this.payer.publicKey, "processed"),
        usdcBalanceBaseUnits: async () => {
          const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
          const ata = getAssociatedTokenAddressSync(
            this.ixCtx.usdMint,
            this.payer.publicKey,
          );
          const balance = await this.connection.getTokenAccountBalance(ata, "processed");
          return BigInt(balance.value.amount);
        },
        dbLastWriteError: () => this.db.lastWriteError(),
        alert: (m) => this.alert(m),
      },
      {
        solFloorLamports: Math.round(cfg.SOL_FLOOR_SOL * 1e9),
        usdcFloorBaseUnits: usdToBase(cfg.MAX_PER_ROUND_USD),
      },
    );
  }

  static async boot(cfg: Config): Promise<Orchestrator> {
    const programId = new PublicKey(cfg.PROGRAM_ID);
    const connection = new Connection(cfg.RPC_HTTP_URL, "processed");
    const payer = loadKeypair(cfg.KEYPAIR_PATH);
    const db = new StateDb(cfg.DB_PATH);
    const pnl = new Pnl(db);

    const state = await bootstrapGameState(connection, {
      minerAuthority: payer.publicKey,
      programId,
    });
    if (!state.satrushConfig) throw new Error("satrush_config missing on chain");
    const fees = feeModelFromConfig(state.satrushConfig);
    const ixCtx: InstructionContext = {
      usdMint: state.satrushConfig.usd_mint,
      btcMint: state.satrushConfig.btc_mint,
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

    const jitoTip =
      cfg.JITO_BLOCK_ENGINE_URL && cfg.JITO_TIP_ACCOUNT
        ? { account: new PublicKey(cfg.JITO_TIP_ACCOUNT), lamports: cfg.JITO_TIP_LAMPORTS }
        : undefined;
    const candidates = new CandidateSet({
      connection,
      payer,
      ixCtx,
      feeEstimator,
      computeUnitLimit: cfg.DEPLOY_CU_LIMIT,
      jitoTip,
    });
    const sender = new RaceSender({
      mode: cfg.EXECUTION_MODE,
      connections: [
        connection,
        ...cfg.SECONDARY_RPC_URLS.map((u) => new Connection(u, "processed")),
      ],
      jitoUrl: cfg.JITO_BLOCK_ENGINE_URL,
      logger,
      mainnetConfirmed: cfg.MAINNET_CONFIRM === "yes",
    });

    const watch = [satsVaultPda(programId), minerPda(payer.publicKey, programId)];
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

    return new Orchestrator(
      cfg,
      connection,
      state,
      source,
      db,
      pnl,
      bankroll,
      candidates,
      sender,
      feeEstimator,
      payer,
      ixCtx,
      fees,
    );
  }

  // ── ops plumbing ────────────────────────────────────────────────────────────

  alert(message: string): void {
    this.log.warn({ alert: true }, message);
    void this.telegram?.alert(message);
  }

  private attachTelegram(): void {
    if (!this.cfg.TELEGRAM_TOKEN || !this.cfg.TELEGRAM_CHAT_ID) {
      this.log.info("telegram not configured — alerts go to logs only");
      return;
    }
    this.telegram = createTelegramOps({
      token: this.cfg.TELEGRAM_TOKEN,
      chatId: this.cfg.TELEGRAM_CHAT_ID,
      logger: this.log,
      deps: {
        getStatus: () => this.statusReport(),
        getPnl: () => {
          const date = utcDate();
          const row = this.db.queryOne<{
            deployed: string;
            returned: string;
            net: string;
            fees_paid: string;
          }>("SELECT deployed, returned, net, fees_paid FROM pnl_daily WHERE date = ?", date);
          return {
            date,
            deployed: BigInt(row?.deployed ?? "0"),
            returned: BigInt(row?.returned ?? "0"),
            net: BigInt(row?.net ?? "0"),
            feesPaid: BigInt(row?.fees_paid ?? "0"),
          };
        },
        pause: () => {
          this.paused = true;
        },
        resume: () => {
          this.paused = false;
        },
        kill: (reason) => this.bankroll.tripKillSwitch(reason),
      },
    });
    this.telegram.start();
  }

  private statusReport() {
    const round = this.state.currentRound();
    return {
      mode: this.cfg.EXECUTION_MODE,
      roundId: this.state.board?.round_id ?? null,
      roundState: round ? (Object.keys(round.state)[0] ?? null) : null,
      slotsToCutoff: this.state.slotsToCutoff(),
      streak: this.state.miner?.current_streak_count ?? null,
      todayNet: this.pnl.todayNet(),
      unclaimedUsd: BigInt(this.state.miner?.unclaimed_usd_amount.toString() ?? "0"),
      unclaimedShares: BigInt(this.state.miner?.unclaimed_btc_shares.toString() ?? "0"),
      perRoundCapLeft: usdToBase(this.cfg.MAX_PER_ROUND_USD),
      dailyLossCapLeft:
        usdToBase(this.cfg.DAILY_LOSS_CAP_USD) - this.pnl.realizedLossToday(),
      killSwitch: this.bankroll.killSwitchEngaged(),
      paused: this.paused,
    };
  }

  // ── state machine ───────────────────────────────────────────────────────────

  private transition(to: BotState, detail: Record<string, unknown> = {}): void {
    if (to === this.botState) return;
    this.log.info({ from: this.botState, to, roundId: this.roundId, ...detail }, "STATE");
    this.botState = to;
  }

  private enterRound(roundId: number): void {
    this.roundId = roundId;
    this.skipLogged.clear();
    this.fireInFlight = false;
    this.transition("ROUND_OPEN", { cutoff: this.state.slotsToCutoff() });
    void this.refreshCandidates("round_open");
  }

  private skipOnce(key: string, detail: Record<string, unknown>): void {
    const scoped = `${this.roundId}:${key}`;
    if (this.skipLogged.has(scoped)) return;
    this.skipLogged.add(scoped);
    this.log.info({ roundId: this.roundId, reason: key, ...detail }, "fire skipped");
  }

  private async refreshCandidates(trigger: string): Promise<void> {
    if (this.roundId === null) return;
    const round = this.state.round(this.roundId);
    if (round && !("Active" in round.state)) return;
    try {
      const built = await this.candidates.refresh(
        this.roundId,
        this.evContext(),
        this.selectorConfig(),
      );
      if (built.length > 0 && (this.botState === "ROUND_OPEN" || this.botState === "ARMED")) {
        const best = built[0]!;
        this.log.debug(
          {
            trigger,
            roundId: this.roundId,
            mask: best.selection.mask,
            tiles: best.selection.tiles,
            ev: best.selection.ev,
            candidates: built.length,
          },
          "candidates refreshed",
        );
      }
    } catch (err) {
      this.log.warn({ err: String(err) }, "candidate refresh failed");
    }
  }

  private evContext(): EvContext {
    const board = this.state.board;
    const cutoff = this.state.slotsToCutoff();
    const elapsed =
      board && cutoff !== null
        ? Math.max(0, this.state.currentSlot - Number(board.start_slot.toString()))
        : 0;
    const prediction = predictFinalOccupancy({
      visibleStakes: this.state.visibleStakes(),
      hiddenPoolEstimate: this.state.hiddenPoolEstimate,
      elapsedSlots: elapsed,
      remainingSlots: cutoff ?? 0,
    });
    return {
      predictedStakes: prediction.stakes,
      fees: this.fees,
      multiplier: 1, // streak multiplier curve is open question 5 — 1 until measured
      semantics: this.cfg.STAKE_SEMANTICS,
    };
  }

  private selectorConfig(): SelectorConfig {
    const boost = strikeSizeMultiplier(this.state.strikePoolUsd(), {
      thresholdBaseUnits: usdToBase(this.cfg.STRIKE_BOOST_THRESHOLD_USD),
      boost: this.cfg.STRIKE_SIZE_BOOST,
    });
    const maxPerRound =
      (usdToBase(this.cfg.MAX_PER_ROUND_USD) * BigInt(Math.round(boost * 100))) / 100n;
    return {
      strategy: this.cfg.STRATEGY,
      ladder: this.cfg.STAKE_LADDER_USD.map(usdToBase),
      maxPerRound,
      minDeploy: BigInt(
        this.state.satrushConfig?.min_deploy_usd_amount.toString() ?? "1000000",
      ),
      kEmptiest: this.cfg.K_EMPTIEST,
    };
  }

  /** The single slot-tick check — every transition hangs off ingest events. */
  private onSlotTick(): void {
    if (this.botState === "BOOT") this.transition("SYNCED");
    const board = this.state.board;
    if (!board) return;

    // Round rotation: a new Active round re-opens the machine.
    if (board.round_id !== this.roundId) {
      const round = this.state.round(board.round_id);
      if (!round || "Active" in round.state) this.enterRound(board.round_id);
      return;
    }

    if (this.botState === "ROUND_OPEN") {
      const cutoff = this.state.slotsToCutoff();
      if (cutoff !== null && cutoff <= this.cfg.FIRE_OFFSET_SLOTS) {
        this.transition("ARMED", { cutoff });
        void this.tryFire();
      }
    } else if (this.botState === "ARMED") {
      void this.tryFire();
    }

    // staleness edge logging (recovery proof in the acceptance run)
    const stale = this.source.stale();
    if (stale !== this.wasStale) {
      this.wasStale = stale;
      if (stale) this.alert("ingest STALE — firing disabled until recovery");
      else this.log.info("ingest recovered — fresh again");
    }
  }

  private async tryFire(): Promise<void> {
    if (this.botState !== "ARMED" || this.fireInFlight || this.roundId === null) return;
    if (this.source.stale()) {
      this.skipOnce("stale_ingest", { ageMs: this.source.lastUpdateAgeMs("slots") });
      return;
    }
    if (this.paused) {
      this.skipOnce("paused", {});
      return;
    }
    const candidate = this.candidates.best(this.roundId);
    if (!candidate) {
      this.skipOnce("no_candidate", { note: "selector found no deployable allocation" });
      return;
    }
    const auth = this.bankroll.authorize(this.roundId, candidate.selection.totalGross);
    if (!auth.ok) {
      this.skipOnce(auth.reason, { detail: auth.detail });
      if (auth.reason === "daily_loss_cap_reached") {
        this.alert(`daily loss cap reached — not firing (${auth.detail ?? ""})`);
      }
      return;
    }

    this.fireInFlight = true;
    this.bankroll.commit(this.roundId); // latch BEFORE send
    const { selection } = candidate;

    // MAX EXTRACTION telemetry: the cap bound before the model did —
    // capital, not EV, limited this round's take.
    if (selection.capBound) {
      const key = `${this.roundId}:cap_bound`;
      if (!this.skipLogged.has(key)) {
        this.skipLogged.add(key);
        this.alert(
          `cap-bound round ${this.roundId}: fired $${(Number(selection.totalGross) / 1e6).toFixed(2)} at MAX_PER_ROUND with next-quantum marginal EV still +$${(selection.marginalEvAtStop / 1e6).toFixed(3)} — raising the cap/float would extract more`,
        );
      }
    }
    this.db.recordMyDeploy({
      roundId: this.roundId,
      mask: selection.mask,
      amount: selection.totalGross,
      evExpected: selection.ev,
      firedSlot: this.state.currentSlot,
      sig: candidate.signature,
      status: this.cfg.EXECUTION_MODE === "dry" ? "dry" : "fired",
    });
    this.transition("FIRED", {
      mask: selection.mask,
      tiles: selection.tiles,
      amount: selection.totalGross.toString(),
      ev: selection.ev,
      fee: candidate.feeMicroLamports,
      cutoff: this.state.slotsToCutoff(),
      dry: this.cfg.EXECUTION_MODE === "dry",
    });

    const firePromise = this.sender.fire(
      {
        signature: candidate.signature,
        serialized: candidate.serialized,
        lastValidBlockHeight: candidate.lastValidBlockHeight,
        meta: { roundId: this.roundId, mask: selection.mask },
      },
      { isPastCutoff: () => (this.state.slotsToCutoff() ?? 1) <= -10 },
    );
    this.transition("CONFIRMING");
    const roundAtFire = this.roundId;
    const result = await firePromise;

    // If the board rotated while confirming, update the DB but leave the
    // new round's state machine alone.
    if (this.roundId !== roundAtFire) {
      if (result.outcome === "landed") {
        this.db.updateMyDeployStatus(candidate.signature, "landed", result.landedSlot);
      } else if (result.outcome === "missed_round") {
        this.db.updateMyDeployStatus(candidate.signature, "missed");
      }
      this.pnl.refreshDaily();
      return;
    }

    if (result.outcome === "landed") {
      this.db.updateMyDeployStatus(candidate.signature, "landed", result.landedSlot);
      this.transition("SETTLING", { landedSlot: result.landedSlot });
    } else if (result.outcome === "dry") {
      this.transition("SETTLING", { dry: true });
    } else if (result.outcome === "missed_round") {
      this.db.updateMyDeployStatus(candidate.signature, "missed");
      this.alert(`missed round ${this.roundId}: ${result.detail ?? ""} — standing down`);
      this.transition("LOGGED", { missed: true });
    } else {
      this.db.updateMyDeployStatus(candidate.signature, "failed");
      this.alert(`deploy ${result.outcome} on round ${this.roundId}: ${result.detail ?? ""}`);
      this.transition("LOGGED", { failed: true });
    }
    this.pnl.refreshDaily();
  }

  // ── settle + sweep ──────────────────────────────────────────────────────────

  private async selfSettle(roundId: number): Promise<void> {
    if (!this.cfg.SELF_SETTLE || this.cfg.EXECUTION_MODE === "dry") return;
    if (this.settleFired.has(roundId)) return;
    const deployed = this.db.queryOne<{ status: string }>(
      "SELECT status FROM my_deploys WHERE round_id = ? AND status = 'landed'",
      roundId,
    );
    if (!deployed) return;
    this.settleFired.add(roundId);
    try {
      const ix = buildSettleDeployPublic(this.ixCtx, {
        authority: this.payer.publicKey,
        deploymentAuthority: this.payer.publicKey,
        roundId,
      });
      const { tx, lastValidBlockHeight } = await assembleTx(this.connection, {
        payer: this.payer,
        instructions: [ix],
        computeUnitLimit: this.cfg.DEPLOY_CU_LIMIT,
        priorityFeeMicroLamports: this.feeEstimator.currentMicroLamportsPerCu(),
      });
      const result = await this.sender.fire(
        {
          signature: bs58.encode(tx.signatures[0]!),
          serialized: Buffer.from(tx.serialize()),
          lastValidBlockHeight,
          meta: { kind: "self_settle", roundId },
        },
        { timeoutMs: 15_000 },
      );
      this.log.info({ roundId, outcome: result.outcome }, "self-settle resolved");
    } catch (err) {
      this.log.warn({ roundId, err: String(err) }, "self-settle failed (crank will cover)");
    }
  }

  private async maybeSweep(): Promise<void> {
    const miner = this.state.miner;
    const vault = this.state.satsVault;
    if (!miner || !vault || this.sweepInFlight) return;
    const value = this.pnl.unclaimedValue({
      miner,
      satsVault: vault,
      btcUsdPrice: this.cfg.BTC_USD_ESTIMATE,
      btcDecimals: 8, // cbBTC-style; read from mint before mainnet
    });
    if (value.totalUsd <= usdToBase(this.cfg.MAX_UNCLAIMED_USD_VALUE)) return;
    if (!this.cfg.SWEEP_ENABLED) {
      this.skipOnce("sweep_disabled", { unclaimedTotalUsd: value.totalUsd.toString() });
      return;
    }
    if (this.cfg.EXECUTION_MODE === "dry" || this.bankroll.killSwitchEngaged()) return;
    const shares =
      (value.shares * BigInt(Math.round(this.cfg.CLAIM_FRACTION * 10_000))) / 10_000n;
    if (shares <= 0n) return;
    this.sweepInFlight = true;
    try {
      const ix = buildClaimSats(this.ixCtx, { authority: this.payer.publicKey, shares });
      const { tx, lastValidBlockHeight } = await assembleTx(this.connection, {
        payer: this.payer,
        instructions: [ix],
        computeUnitLimit: this.cfg.DEPLOY_CU_LIMIT,
        priorityFeeMicroLamports: this.feeEstimator.currentMicroLamportsPerCu(),
      });
      const result = await this.sender.fire(
        {
          signature: bs58.encode(tx.signatures[0]!),
          serialized: Buffer.from(tx.serialize()),
          lastValidBlockHeight,
          meta: { kind: "claim_sats", shares: shares.toString() },
        },
        { timeoutMs: 15_000 },
      );
      this.log.info({ shares: shares.toString(), outcome: result.outcome }, "sweep resolved");
    } finally {
      this.sweepInFlight = false;
    }
  }

  // ── event wiring ────────────────────────────────────────────────────────────

  private cacheRoundWindow(): void {
    const board = this.state.board;
    if (!board) return;
    const end = BigInt(board.end_slot.toString());
    if (end === U64_MAX) return;
    this.roundWindows.set(board.round_id, {
      start: Number(board.start_slot.toString()),
      end: Number(end),
    });
    for (const id of this.roundWindows.keys()) {
      if (id < board.round_id - 8) this.roundWindows.delete(id);
    }
  }

  private onRevealed(reveal: RoundRevealed): void {
    const round = this.state.round(reveal.round_id);
    const window = this.roundWindows.get(reveal.round_id);
    this.db.recordRound({
      id: reveal.round_id,
      startSlot: window?.start ?? null,
      endSlot: window?.end ?? null,
      winningTile: reveal.winning_tile,
      deployedUsd: BigInt(round?.deployed_usd_amount.toString() ?? "0"),
      winningTileUsd: BigInt(
        round?.deployed_usd_on_winning_tile_amount.toString() ?? "0",
      ),
      minersCount: round?.miners_count ?? 0,
      strikeTriggered: reveal.is_strike_triggered,
      feesJson: JSON.stringify({
        epoch: reveal.epoch_fee_usd_amount.toString(),
        oneBtc: reveal.one_btc_fee_usd_amount.toString(),
        protocol: reveal.protocol_fee_usd_amount.toString(),
        strikeBonusUsd: reveal.strike_bonus_usd.toString(),
      }),
    });

    if (reveal.round_id === this.roundId) {
      if (this.botState === "SETTLING" || this.botState === "CONFIRMING") {
        void this.selfSettle(reveal.round_id).then(() => {
          const reconciliation = this.pnl.reconcileRound(reveal.round_id);
          this.transition("LOGGED", {
            winningTile: reveal.winning_tile,
            deployed: reconciliation.deployed.toString(),
            expectedEv: reconciliation.expectedEv,
          });
        });
      } else if (this.botState === "ROUND_OPEN" || this.botState === "ARMED") {
        // We never fired this round (skip/no candidate) — close it out.
        this.transition("LOGGED", { winningTile: reveal.winning_tile, played: false });
      }
    }
  }

  start(): void {
    this.attachTelegram();

    this.source.on("slot", (u) => {
      this.state.applySlot(u.slot);
      this.onSlotTick();
    });

    this.source.on("account", (u) => {
      try {
        const applied = this.state.applyAccount(u.pubkey, u.data);
        if (!applied) return;
        if (applied.kind === "Board") this.cacheRoundWindow();
        if (applied.kind === "Round" && applied.roundId !== undefined) {
          const round = this.state.round(applied.roundId);
          if (round) {
            this.db.recordOccupancySnapshot(
              applied.roundId,
              u.slot,
              round.public_tile_stakes.map((t) => BigInt(t.stake.toString())),
              this.cfg.GRPC_URL ? "grpc" : "wsrpc",
            );
          }
          if (applied.roundId === this.state.board?.round_id) {
            // Occupancy changed on the live round → re-run the selector.
            void this.refreshCandidates("occupancy_update").then(() => {
              if (this.botState === "ARMED") void this.tryFire();
            });
          }
        }
        if (applied.kind === "Miner" || applied.kind === "SatsVault") {
          void this.maybeSweep();
        }
      } catch (err) {
        if (err instanceof HaltError) {
          this.bankroll.tripKillSwitch(`HaltError: ${err.message}`);
          this.alert(`HALT: ${err.message} ${JSON.stringify(err.context)}`);
          this.transition("LOGGED", { halted: true });
          return; // stay alive, observing — kill switch blocks all sends
        }
        throw err;
      }
    });

    this.source.on("txLogs", (u) => {
      if (u.failed) return;
      for (const event of parseTransactionEvents(u)) {
        if (event.name === "PublicDeployCreated") {
          const data = event.data as PublicDeployCreated;
          if (data.authority.equals(this.payer.publicKey)) {
            this.db.markDeployLandedByRound(data.round_id, event.slot);
          } else {
            this.db.recordCompetitorDeploy({
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
        } else if (event.name === "RoundRevealed") {
          this.onRevealed(event.data as RoundRevealed);
        } else if (event.name === "PublicDeploySettled") {
          const data = event.data as PublicDeploySettled;
          if (data.authority.equals(this.payer.publicKey)) {
            this.db.recordSettlement({
              roundId: data.round_id,
              winningStake: BigInt(data.winning_stake.toString()),
              wonUsd: BigInt(data.won_usd_amount.toString()),
              wonShares: BigInt(data.won_shares_amount.toString()),
              hashrateEarned: BigInt(data.hashrate_earned.toString()),
              sig: event.signature,
            });
            this.pnl.refreshDaily();
            void this.maybeSweep();
          }
        }
      }
    });

    this.source.on("status", (s) => {
      if (!s.connected) this.log.warn({ detail: s.detail }, "ingest disconnected");
      else this.log.info({ detail: s.detail }, "ingest connected");
    });

    this.health.start(10_000);
    void this.source.start();
    this.log.info(
      {
        mode: this.cfg.EXECUTION_MODE,
        strategy: this.cfg.STRATEGY,
        wallet: this.payer.publicKey.toBase58(),
        roundId: this.state.board?.round_id,
      },
      "orchestrator started",
    );

    process.once("SIGINT", () => void this.shutdown("SIGINT"));
    process.once("SIGTERM", () => void this.shutdown("SIGTERM"));
  }

  /** Chaos hook for the acceptance run. */
  forceDisconnect(): void {
    this.log.warn("CHAOS: forcing ingest disconnect");
    (this.source as { simulateDisconnect?: () => void }).simulateDisconnect?.();
  }

  async shutdown(reason: string): Promise<void> {
    this.log.info({ reason }, "shutting down");
    this.candidates.clear();
    this.health.stop();
    await this.source.stop().catch(() => undefined);
    await this.telegram?.alert(`bot shutting down (${reason})`).catch(() => undefined);
    await this.telegram?.stop().catch(() => undefined);
    this.db.close();
    process.exit(0);
  }
}

// ── entrypoint ────────────────────────────────────────────────────────────────

const cfg = loadConfig();

// Mainnet refuses to start unless every fatal preflight gate passes.
if (cfg.EXECUTION_MODE === "mainnet") {
  const { formatPreflight, runPreflight } = await import("./ops/preflight.js");
  const report = await runPreflight({ cfg });
  console.log(formatPreflight(report));
  if (!report.passed) {
    logger.fatal("preflight failed — refusing to launch in mainnet mode");
    process.exit(1);
  }
}

const orchestrator = await Orchestrator.boot(cfg);
orchestrator.start();

// Acceptance chaos hook: CHAOS_DISCONNECT_AT_S=<seconds> forces an ingest
// disconnect mid-run to prove staleness detection + recovery.
const chaosAt = Number(process.env["CHAOS_DISCONNECT_AT_S"] ?? 0);
if (chaosAt > 0) {
  setTimeout(() => orchestrator.forceDisconnect(), chaosAt * 1000).unref();
}
