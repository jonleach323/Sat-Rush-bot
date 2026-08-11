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
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type {
  EpochVault,
  EpochVaultEntry,
  EpochVaultIteration,
  EpochVaultPage,
  Miner,
  OneBtcVault,
  OneBtcVaultEntry,
  OneBtcVaultIteration,
  PublicDeployCreated,
  PublicDeploySettled,
  RoundRevealed,
} from "./adapter/idl.js";
import { decodeAccount } from "./adapter/idl.js";
import {
  buildBuyEpochTickets,
  buildBuyOneBtcTickets,
  buildClaimEpochReward,
  buildClaimOneBtcReward,
  buildClaimSats,
  buildClaimUsd,
  buildSelectEpochWinner,
  buildSettleDeployPublic,
  buildTriggerEpochDraw,
  buildTriggerOneBtcDraw,
  type InstructionContext,
} from "./adapter/instructions.js";
import {
  epochVaultEntryPda,
  epochVaultIterationPda,
  epochVaultPagePda,
  epochVaultPda,
  minerPda,
  oneBtcVaultIterationPda,
  oneBtcVaultPda,
  satsVaultPda,
} from "./adapter/pdas.js";
import { VaultEngine } from "./exec/vault-engine.js";
import { VaultManager, type VaultReadState } from "./exec/vault-manager.js";
import { btcBaseToUsd, expectedWinningsUsd, type VaultKind } from "./strategy/vault.js";
import {
  epochAction,
  epochWinIndex,
  epochWinnerPageIndex,
  oneBtcAction,
  type EpochStateName,
  type OneBtcStateName,
} from "./strategy/vault-claim.js";
import { loadConfig, type Config } from "./config.js";
import { CandidateSet } from "./exec/candidates.js";
import { FeeEstimator } from "./exec/fees.js";
import { RaceSender } from "./exec/sender.js";
import { assembleTx, loadKeypair } from "./exec/tx.js";
import { writeFileSync } from "node:fs";
import { HaltError } from "./ingest/decode.js";
import { assertDeployInvariants, assertFeeBearingInvariants } from "./exec/guards.js";
import { reconcileRoundOutcome, reconcileWalletDrift } from "./strategy/reconcile.js";
import { parseTransactionEvents } from "./ingest/events.js";
import { YellowstoneIngest } from "./ingest/grpc.js";
import { bootstrapGameState, type GameState } from "./ingest/snapshot.js";
import type { IngestSource } from "./ingest/types.js";
import { WsRpcIngest } from "./ingest/wsrpc.js";
import { logger } from "./logger.js";
import { HealthMonitor } from "./ops/health.js";
import { MonitorApi } from "./ops/api.js";
import { createMonitorData, type MonitorData, type VaultPoolsJson } from "./ops/monitor.js";
import { createTelegramOps, type TelegramOps } from "./ops/telegram.js";
import { StateDb } from "./state/db.js";
import { Pnl, utcDate } from "./state/pnl.js";
import { Bankroll, strikeSizeMultiplier } from "./strategy/bankroll.js";
import { feeModelFromConfig, type EvContext, type FeeModel } from "./strategy/ev.js";
import { predictFinalOccupancy } from "./strategy/predict.js";
import { adaptiveFireOffset } from "./strategy/fire-offset.js";
import { maskToTiles } from "./adapter/mask.js";
import { hashrateRawPerUsd, strikeBonusMultiplier } from "./strategy/hashrate.js";
import {
  predictRivalInflow,
  profileCompetitors,
  type CompetitorDeployRow,
  type RivalProfile,
  type RoundWindow,
} from "./strategy/competitors.js";
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
  private usdcBaselineBase: bigint | null = null;
  private usdcBaselineDate: string | null = null;
  /** Last on-chain USDC balance (base units), refreshed by the drift check.
   * Feeds Kelly bet sizing; null until the first successful read (Kelly off). */
  private usdcAvailableBase: bigint | null = null;
  /** Current fire offset (slots before cutoff), self-calibrated from land
   * latency; null until first computed → falls back to FIRE_OFFSET_SLOTS. */
  private adaptiveOffsetSlots: number | null = null;
  /** Cached rival profiles for anti-collision, refreshed off the hot path. */
  private rivalProfiles: RivalProfile[] = [];
  /** Wall-clock ms of the most recent Sat Strike, for the post-Strike hashrate
   * bonus window; null until one is observed this process. */
  private lastStrikeAtMs: number | null = null;
  private walletDriftTimer: NodeJS.Timeout | null = null;
  private vaultManager: VaultManager | null = null;
  // Per-tick caches so the (synchronous) VaultEngine deps can read fresh values
  // that the manager's async readState refreshes immediately before evaluating.
  private vaultHashrateCache = 0;
  private vaultEpochEntryCache: { iter: number; tickets: number } = { iter: -1, tickets: 0 };
  /** Latest on-chain vault pool state, populated by the vault manager poll.
   * Null when the vault strategy is off or before the first read. */
  private vaultPoolCache: VaultPoolsJson | null = null;
  private readonly roundWindows = new Map<number, { start: number; end: number }>();

  private readonly log = logger;
  private telegram: TelegramOps | null = null;
  private api: MonitorApi | null = null;
  private readonly health: HealthMonitor;
  private readonly monitor: MonitorData;
  private readonly startedAtMs = Date.now();

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

    this.monitor = createMonitorData({
      db: this.db,
      pnl: this.pnl,
      state: this.state,
      mode: cfg.EXECUTION_MODE,
      source: this.source,
      ingestSourceName: cfg.GRPC_URL ? "yellowstone-grpc" : "ws-rpc",
      isPaused: () => this.paused,
      killSwitchEngaged: () => this.bankroll.killSwitchEngaged(),
      maxPerRoundBase: usdToBase(cfg.MAX_PER_ROUND_USD),
      dailyLossCapBase: usdToBase(cfg.DAILY_LOSS_CAP_USD),
      myAuthority: this.payer.publicKey.toBase58(),
      solBalanceLamports: () =>
        this.connection.getBalance(this.payer.publicKey, "processed"),
      usdcBalanceBaseUnits: async () => {
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const ata = getAssociatedTokenAddressSync(this.ixCtx.usdMint, this.payer.publicKey);
        const balance = await this.connection.getTokenAccountBalance(ata, "processed");
        return BigInt(balance.value.amount);
      },
      btcUsdEstimate: cfg.BTC_USD_ESTIMATE,
      vaultEnabled: cfg.VAULT_STRATEGY_ENABLED,
      ticketPriceHashrate: cfg.VAULT_HASHRATE_PER_TICKET,
      vaultPools: () => this.vaultPoolCache,
    });
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

    // Restart recovery: re-arm the one-deploy latch for every round already
    // recorded, so a mid-round restart cannot attempt a duplicate deploy
    // (deploy_public is one-shot per round; a re-fire would waste a fee and
    // corrupt accounting). The in-memory latch is otherwise empty on boot.
    for (const r of db.query<{ round_id: number }>(
      "SELECT DISTINCT round_id FROM my_deploys WHERE status IN ('fired','landed')",
    )) {
      bankroll.commit(r.round_id);
    }

    const feeEstimator = new FeeEstimator({
      minMicroLamports: cfg.PRIORITY_FEE_MIN_MICROLAMPORTS,
      maxMicroLamports: cfg.PRIORITY_FEE_MAX_MICROLAMPORTS,
    });
    await feeEstimator.refreshFromRpc(connection);

    const tipAccounts = [
      ...new Set([
        ...cfg.JITO_TIP_ACCOUNTS,
        ...(cfg.JITO_TIP_ACCOUNT ? [cfg.JITO_TIP_ACCOUNT] : []),
      ]),
    ];
    // Embed a tip whenever tip accounts are configured — NOT gated on
    // JITO_BLOCK_ENGINE_URL. Helius Sender requires a tip in the tx even when we
    // don't send a separate direct Jito bundle (Sender routes to Jito itself).
    const jitoTip =
      tipAccounts.length > 0
        ? {
            accounts: tipAccounts.map((a) => new PublicKey(a)),
            baseLamports: cfg.JITO_TIP_LAMPORTS,
            maxLamports: cfg.JITO_TIP_MAX_LAMPORTS,
            evFraction: cfg.JITO_TIP_EV_FRACTION,
            solUsd: cfg.SOL_USD_ESTIMATE,
          }
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

  /**
   * Engage the kill switch for an INTEGRITY violation (invariant, reconcile
   * tripwire, HaltError, unhandled error). Trips the in-memory switch AND
   * writes the KILL file so the halt SURVIVES a systemd restart — an
   * in-memory trip alone would be cleared by Restart=always and the bot
   * would resume into a known-bad state. Requires a human to clear.
   */
  engageKillSwitch(reason: string): void {
    this.bankroll.tripKillSwitch(reason);
    try {
      writeFileSync(this.cfg.KILL_SWITCH_FILE, `halted: ${reason}\n`, { flag: "a" });
    } catch (err) {
      this.log.error({ err: String(err) }, "failed to persist KILL file");
    }
    this.alert(`⛔ HALTED — ${reason} (KILL file written; clear it to resume)`);
  }

  /** Last-resort error boundary target: halt safe on any unhandled failure. */
  haltFromError(err: unknown, origin: string): void {
    const msg = err instanceof HaltError ? err.message : String(err);
    this.log.fatal({ origin, err: msg }, "unhandled failure — halting");
    this.engageKillSwitch(`${origin}: ${msg}`);
  }

  /** Effective per-round cap (strike-boost aware) — the SAME value fed to the
   * selector, so the pre-send invariant can never disagree with what was
   * selected (closes the strike-boost cap divergence, AUDIT F1). */
  private effectiveMaxPerRoundBase(): bigint {
    const boost = strikeSizeMultiplier(this.state.strikePoolUsd(), {
      thresholdBaseUnits: usdToBase(this.cfg.STRIKE_BOOST_THRESHOLD_USD),
      boost: this.cfg.STRIKE_SIZE_BOOST,
    });
    return (usdToBase(this.cfg.MAX_PER_ROUND_USD) * BigInt(Math.round(boost * 100))) / 100n;
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
        getRounds: (limit) =>
          this.monitor.recentRounds(limit) as never,
        getCompetitors: (limit) =>
          this.monitor.recentCompetitors(limit) as never,
        getBoard: () => {
          const s = this.monitor.status();
          return {
            roundId: s.round.id,
            state: s.round.state,
            slotsToCutoff: s.round.slotsToCutoff,
            tileStakesUsd: s.board.tileStakesUsd,
            myTiles: s.me.tiles,
            strikePoolUsd: s.board.strikePoolUsd,
          };
        },
        getHealth: () => this.monitor.health(),
        getDeploys: (limit) => this.monitor.recentDeploys(limit) as never,
        getVault: () => this.monitor.vault(),
      },
    });
    this.telegram.start();
  }

  private async attachApi(): Promise<void> {
    if (!this.cfg.API_TOKEN) {
      this.log.info("monitoring API disabled (API_TOKEN unset)");
      return;
    }
    this.api = new MonitorApi({
      token: this.cfg.API_TOKEN,
      host: this.cfg.API_HOST,
      port: this.cfg.API_PORT,
      data: this.monitor,
      mode: this.cfg.EXECUTION_MODE,
      startedAtMs: this.startedAtMs,
      logger: this.log,
    });
    try {
      await this.api.start();
    } catch (err) {
      this.log.error({ err: String(err) }, "monitoring API failed to start");
      this.api = null;
    }
  }

  private statusReport() {
    const round = this.state.currentRound();
    const m = this.monitor.status();
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
      boardTotalUsd: m.board.totalUsd,
      strikePoolUsd: m.board.strikePoolUsd,
      myStakeUsd: m.me.stakeUsd,
      ingestFresh: m.ingest.fresh,
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

  /**
   * Rebuild the cached rival profiles from competitor history (the expensive
   * part: a lookback query + per-wallet aggregation). Profiles change slowly, so
   * this runs on the 30s cadence, NOT on the hot fire path. Empty unless
   * ANTI_COLLISION_ENABLED.
   */
  private refreshRivalProfiles(): void {
    if (!this.cfg.ANTI_COLLISION_ENABLED) {
      this.rivalProfiles = [];
      return;
    }
    const rows = this.db.query<CompetitorDeployRow>(
      "SELECT round_id, authority, mask, amount, is_automation, slot FROM competitor_deploys ORDER BY id DESC LIMIT ?",
      this.cfg.COMPETITOR_LOOKBACK,
    );
    const windows = new Map<number, RoundWindow>();
    for (const [id, w] of this.roundWindows) windows.set(id, { end: w.end });
    this.rivalProfiles = [...profileCompetitors(rows, windows).values()];
  }

  /**
   * Predicted per-tile stake rivals will add this round — fed into the occupancy
   * forecast so the selector routes off tiles other snipers will crowd
   * (anti-collision). Uses the cached profiles (refreshed off the hot path) with
   * the LIVE board, so the emptiest-tile ranking snipers chase is current. Cheap.
   */
  private predictedRivalInflow(): bigint[] {
    return predictRivalInflow(this.rivalProfiles, this.state.visibleStakes());
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
      expectedAutomationInflow: this.cfg.ANTI_COLLISION_ENABLED
        ? this.predictedRivalInflow()
        : null,
      endgameConvergence: this.cfg.ENDGAME_CONVERGENCE,
    });
    return {
      predictedStakes: prediction.stakes,
      fees: this.fees,
      multiplier: 1, // streak multiplier curve is open question 5 — 1 until measured
      semantics: this.cfg.STAKE_SEMANTICS,
      hashrate: {
        streak: this.state.miner?.current_streak_count ?? 1,
        valueUsdPerRawUnit: this.cfg.HASHRATE_VALUE_USD,
        multiplier: this.strikeBonusMultiplier(),
      },
      strikeExpectedPot: this.strikeExpectedPotBase(),
    };
  }

  /** Current post-Sat-Strike hashrate promo multiplier (1 outside the window). */
  private strikeBonusMultiplier(): number {
    return strikeBonusMultiplier({
      lastStrikeAtMs: this.lastStrikeAtMs,
      nowMs: Date.now(),
      windowMs: this.cfg.STRIKE_BONUS_WINDOW_MINUTES * 60_000,
      multiplier: this.cfg.STRIKE_HASHRATE_MULTIPLIER,
    });
  }

  /**
   * Expected strike-jackpot value this round (base units) = jackpot /
   * strike_trigger_modulus. Sat Strike is a random ~1/1440 draw (rng % modulus
   * == 0) that rolls the accumulated jackpot onto the winning tile — untimeable,
   * but its expectation is real and scales with the pending pool. 0 when
   * disabled or the modulus is unavailable.
   */
  private strikeExpectedPotBase(): number {
    if (!this.cfg.STRIKE_EV_ENABLED) return 0;
    const modulus = this.state.satrushConfig?.strike_trigger_modulus ?? 0;
    if (modulus <= 0) return 0;
    return Number(this.state.strikePoolUsd()) / modulus;
  }

  /** Slots before cutoff to fire: the self-calibrated offset if available, else
   * the static configured fallback. */
  private currentFireOffset(): number {
    return this.adaptiveOffsetSlots ?? this.cfg.FIRE_OFFSET_SLOTS;
  }

  /**
   * Recompute the adaptive fire offset from recent land latencies. Fires as late
   * as the measured send path safely allows; re-tunes as latency changes. No-op
   * (uses the static offset) when ADAPTIVE_FIRE_OFFSET is off.
   */
  private refreshFireOffset(): void {
    if (!this.cfg.ADAPTIVE_FIRE_OFFSET) {
      this.adaptiveOffsetSlots = null;
      return;
    }
    const rows = this.db.query<{ lat: number }>(
      `SELECT (landed_slot - fired_slot) AS lat FROM my_deploys
       WHERE status = 'landed' AND landed_slot IS NOT NULL AND fired_slot IS NOT NULL
       ORDER BY id DESC LIMIT 200`,
    );
    const next = adaptiveFireOffset(
      rows.map((r) => r.lat),
      {
        targetLandProb: this.cfg.FIRE_OFFSET_TARGET_LAND_PROB,
        cushionSlots: this.cfg.FIRE_OFFSET_CUSHION_SLOTS,
        floor: this.cfg.FIRE_OFFSET_FLOOR,
        ceiling: this.cfg.FIRE_OFFSET_CEILING,
        fallback: this.cfg.FIRE_OFFSET_SLOTS,
        minSamples: this.cfg.FIRE_OFFSET_MIN_SAMPLES,
      },
    );
    if (next !== this.adaptiveOffsetSlots) {
      this.log.info(
        { fireOffset: next, prev: this.adaptiveOffsetSlots, samples: rows.length },
        "adaptive fire offset updated",
      );
    }
    this.adaptiveOffsetSlots = next;
  }

  /**
   * Validate the hashrate formula against reality. We now credit hashrate in the
   * EV model straight from R = s·(m + 21/n); if mainnet actually pays something
   * else, that silently corrupts the edge Kelly sizes against. Compare realized
   * `hashrate_earned` to what the formula predicts for the same deploys (using
   * the streak snapshot and mask we recorded) and warn on material divergence.
   * Diagnostic only — it never feeds the model.
   */
  private validateHashrateFormula(): void {
    const rows = this.db.query<{
      hashrate_earned: string;
      amount: string;
      mask: number;
      streak: number | null;
    }>(
      `SELECT s.hashrate_earned, d.amount, d.mask, d.streak
       FROM settlements s JOIN my_deploys d ON d.round_id = s.round_id
       WHERE d.streak IS NOT NULL ORDER BY s.id DESC LIMIT 200`,
    );
    let actual = 0;
    let predicted = 0;
    for (const r of rows) {
      const tiles = maskToTiles(r.mask).length;
      if (tiles < 1) continue;
      actual += Number(r.hashrate_earned);
      predicted +=
        (Number(r.amount) / 1e6) * hashrateRawPerUsd(r.streak ?? 1, tiles);
    }
    if (rows.length < 20 || predicted <= 0) return; // too few samples to judge
    const ratio = actual / predicted;
    if (ratio < 0.9 || ratio > 1.1) {
      this.log.warn(
        { samples: rows.length, actual, predicted, ratio: Number(ratio.toFixed(3)) },
        "hashrate formula divergence — realized differs from R = s·(m + 21/n)",
      );
    }
  }

  private selectorConfig(): SelectorConfig {
    const maxPerRound = this.effectiveMaxPerRoundBase();
    return {
      strategy: this.cfg.STRATEGY,
      ladder: this.cfg.STAKE_LADDER_USD.map(usdToBase),
      maxPerRound,
      minDeploy: BigInt(
        this.state.satrushConfig?.min_deploy_usd_amount.toString() ?? "1000000",
      ),
      kEmptiest: this.cfg.K_EMPTIEST,
      minEdgeBps: this.cfg.MIN_EDGE_BPS,
      kellyFraction: this.cfg.KELLY_FRACTION,
      bankrollBase: this.usdcAvailableBase ?? undefined,
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
      if (cutoff !== null && cutoff <= this.currentFireOffset()) {
        this.transition("ARMED", { cutoff, fireOffset: this.currentFireOffset() });
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
    const auth = this.bankroll.authorize(
      this.roundId,
      candidate.selection.totalGross,
      this.effectiveMaxPerRoundBase(),
    );
    if (!auth.ok) {
      this.skipOnce(auth.reason, { detail: auth.detail });
      if (auth.reason === "daily_loss_cap_reached") {
        this.alert(`daily loss cap reached — not firing (${auth.detail ?? ""})`);
      }
      return;
    }

    this.fireInFlight = true;
    // Atomic check-and-set latch — first caller in the round only (defends
    // double-fire independent of the synchronous prefix).
    if (!this.bankroll.tryCommit(this.roundId)) {
      this.skipOnce("already_latched", {});
      return;
    }
    const { selection } = candidate;

    // ── PRE-SEND INVARIANT CHOKEPOINT — last line before the wire ─────────────
    // Re-verifies the ACTUAL amount/mask/fee/tip about to be signed against
    // the SAME limits, on the actual value (not a separately-clamped copy).
    // Any violation throws HaltError → we HALT and do NOT send. This is what
    // catches the strike-boost cap divergence (auth.amountGross != sent amount).
    try {
      assertDeployInvariants({
        roundId: this.roundId,
        amountBaseUnits: selection.totalGross,
        mask: selection.mask,
        quantumBase: this.bankroll.quantumBase,
        minDeployBase: this.bankroll.minDeployBase,
        maxPerRoundBase: this.effectiveMaxPerRoundBase(),
        dailyLossCapBase: this.bankroll.dailyLossCapBase,
        realizedLossTodayBase: this.bankroll.realizedLossToday(),
        priorityFeeMicroLamports: candidate.feeMicroLamports,
        maxPriorityFeeMicroLamports: this.cfg.PRIORITY_FEE_MAX_MICROLAMPORTS,
        tipLamports: candidate.tipLamports,
        maxTipLamports: this.cfg.JITO_TIP_MAX_LAMPORTS,
        latchHeld: this.bankroll.hasDeployed(this.roundId),
        killSwitchEngaged: this.bankroll.killSwitchEngaged(),
      });
      // The amount we send MUST equal what the bankroll authorized — the
      // definitive catch for any selector/bankroll cap divergence.
      if (selection.totalGross !== auth.amountGross) {
        throw new HaltError("sent amount != authorized amount", {
          sent: selection.totalGross.toString(),
          authorized: auth.amountGross.toString(),
        });
      }
    } catch (err) {
      this.haltFromError(err, "pre-send invariant");
      this.transition("LOGGED", { haltedBeforeSend: true });
      return; // DO NOT SEND
    }

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
      streak: this.state.miner?.current_streak_count ?? null,
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
      const fee = this.feeEstimator.currentMicroLamportsPerCu();
      assertFeeBearingInvariants({
        kind: "settle",
        priorityFeeMicroLamports: fee,
        maxPriorityFeeMicroLamports: this.cfg.PRIORITY_FEE_MAX_MICROLAMPORTS,
        killSwitchEngaged: this.bankroll.killSwitchEngaged(),
      });
      const ix = buildSettleDeployPublic(this.ixCtx, {
        authority: this.payer.publicKey,
        deploymentAuthority: this.payer.publicKey,
        roundId,
      });
      const { tx, lastValidBlockHeight } = await assembleTx(this.connection, {
        payer: this.payer,
        instructions: [ix],
        computeUnitLimit: this.cfg.DEPLOY_CU_LIMIT,
        priorityFeeMicroLamports: fee,
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

  /**
   * Reconciliation tripwire: compare the settled outcome against our modeled
   * payout for the actual winning tile + our actual stake. Mismatch beyond
   * tolerance (or an impossible direction, e.g. paid without covering) engages
   * the kill switch — converting a surviving model/parse bug into a halt.
   */
  private reconcileSettlement(data: PublicDeploySettled): void {
    const round = this.state.round(data.round_id);
    if (!round) return; // can't reconcile without the round account
    const res = reconcileRoundOutcome({
      ourStakeOnWinnerBase: BigInt(data.winning_stake.toString()),
      totalStakeOnWinnerBase: BigInt(round.deployed_usd_on_winning_tile_amount.toString()),
      potBase: BigInt(round.deployed_usd_amount.toString()),
      realizedWonUsdBase: BigInt(data.won_usd_amount.toString()),
      realizedWonShares: BigInt(data.won_shares_amount.toString()),
      toleranceFrac: this.cfg.RECONCILE_TOLERANCE,
      floorBase: usdToBase(0.5),
    });
    if (!res.ok) {
      this.engageKillSwitch(
        `reconcile tripwire round ${data.round_id}: ${res.reason} ` +
          `(modeled $${(Number(res.modeledUsdBase) / 1e6).toFixed(2)} vs realized $${(Number(data.won_usd_amount.toString()) / 1e6).toFixed(2)})`,
      );
    }
  }

  /**
   * Coarse wallet-drift tripwire: halts if on-chain USDC has left the wallet
   * by MORE than everything we have deployed since the baseline (plus a
   * tolerance) — i.e. an unexplained drain, not fee/BTC-leg noise. Baseline
   * captured on first successful read.
   */
  private async checkWalletDrift(): Promise<void> {
    if (this.cfg.EXECUTION_MODE === "dry") return;
    let actual: bigint;
    try {
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const ata = getAssociatedTokenAddressSync(this.ixCtx.usdMint, this.payer.publicKey);
      const bal = await this.connection.getTokenAccountBalance(ata, "processed");
      actual = BigInt(bal.value.amount);
    } catch {
      return; // transient — try next tick
    }
    // Cache for Kelly bet sizing (fresh within the 30s drift-check cadence).
    this.usdcAvailableBase = actual;
    // Re-baseline at UTC-day rollover so the baseline shares the same clock as
    // deployedToday() (which resets per UTC day). Without this, at midnight the
    // expected delta resets to ~0 while the lifetime baseline still reflects the
    // prior day's legitimate deploys — tripping a false "drift" halt.
    const today = utcDate();
    if (this.usdcBaselineBase === null || this.usdcBaselineDate !== today) {
      this.usdcBaselineBase = actual;
      this.usdcBaselineDate = today;
      return;
    }
    // Worst legitimate case: we lose everything deployed today (same UTC day as
    // the baseline above).
    const res = reconcileWalletDrift({
      expectedDeltaBase: -this.pnl.deployedToday(),
      actualDeltaBase: actual - this.usdcBaselineBase,
      toleranceBase: usdToBase(this.cfg.WALLET_DRIFT_TOLERANCE_USD),
    });
    if (!res.ok) this.engageKillSwitch(`wallet drift: ${res.reason}`);
  }

  /**
   * Wire and start the hashrate-vault manager. Reads chain state each tick,
   * refreshes the per-tick caches the (sync) engine deps read, and drives entry
   * decisions. Buys go through the same RaceSender as deploys and are gated by
   * EXECUTION_MODE (the engine runs dry in dry mode). Only called when
   * VAULT_STRATEGY_ENABLED — otherwise nothing here runs.
   */
  private startVaultManager(): void {
    const programId = new PublicKey(this.cfg.PROGRAM_ID);
    const btcUsd = this.cfg.BTC_USD_ESTIMATE;
    const btcDecimals = 8; // cbBTC-style; devnet + mainnet BTC mints are 8dp (FINDINGS E6)
    const iterationDurationSlots = Number(
      this.state.satrushConfig!.epoch_vault_iteration_duration.toString(),
    );
    const num = (v: { toString(): string }) => Number(v.toString());

    const engine = new VaultEngine({
      enabled: true, // gate is the manager itself (only started when enabled)
      dry: this.cfg.EXECUTION_MODE === "dry",
      hashrateValueUsd: this.cfg.HASHRATE_VALUE_USD,
      ticketPriceHashrate: this.cfg.VAULT_HASHRATE_PER_TICKET,
      maxTickets: this.cfg.VAULT_MAX_TICKETS,
      hashrateFraction: this.cfg.VAULT_HASHRATE_FRACTION,
      hashrateAvailable: () => this.vaultHashrateCache,
      myTickets: (kind, iter) =>
        kind === "epoch"
          ? this.vaultEpochEntryCache.iter === iter
            ? this.vaultEpochEntryCache.tickets
            : 0
          : this.db.vaultTicketsHeld("one_btc", iter),
      buy: (kind, iter, tickets) => this.buyVaultTickets(kind, iter, tickets),
      log: (obj) => this.log.info(obj, "vault"),
    });

    const readState = async (): Promise<VaultReadState> => {
      const slot = await this.connection.getSlot("processed");
      const minerInfo = await this.connection.getAccountInfo(
        minerPda(this.payer.publicKey, programId),
        "processed",
      );
      this.vaultHashrateCache = minerInfo
        ? num(decodeAccount<Miner>("Miner", minerInfo.data).hashrate_amount)
        : 0;

      let epoch: VaultReadState["epoch"] = null;
      const evInfo = await this.connection.getAccountInfo(epochVaultPda(programId), "processed");
      if (evInfo) {
        const ev = decodeAccount<EpochVault>("EpochVault", evInfo.data);
        const itInfo = await this.connection.getAccountInfo(
          epochVaultIterationPda(ev.iteration_id, programId),
          "processed",
        );
        if (itInfo) {
          const it = decodeAccount<EpochVaultIteration>("EpochVaultIteration", itInfo.data);
          const entryInfo = await this.connection.getAccountInfo(
            epochVaultEntryPda(ev.iteration_id, this.payer.publicKey, programId),
            "processed",
          );
          this.vaultEpochEntryCache = {
            iter: ev.iteration_id,
            tickets: entryInfo
              ? num(decodeAccount<EpochVaultEntry>("EpochVaultEntry", entryInfo.data).tickets)
              : 0,
          };
          epoch = {
            iterationId: ev.iteration_id,
            open: "Open" in it.state,
            totalTickets: num(it.total_tickets),
            poolValueUsd:
              num(ev.pool_usd_amount) / 1e6 +
              btcBaseToUsd(num(ev.pool_btc_amount), btcDecimals, btcUsd),
            lastTriggerSlot: num(ev.last_trigger_slot),
            iterationDurationSlots,
          };
        }
      }

      let oneBtc: VaultReadState["oneBtc"] = null;
      const obvInfo = await this.connection.getAccountInfo(oneBtcVaultPda(programId), "processed");
      if (obvInfo) {
        const obv = decodeAccount<OneBtcVault>("OneBtcVault", obvInfo.data);
        const itInfo = await this.connection.getAccountInfo(
          oneBtcVaultIterationPda(obv.iteration_id, programId),
          "processed",
        );
        if (itInfo) {
          const it = decodeAccount<OneBtcVaultIteration>("OneBtcVaultIteration", itInfo.data);
          oneBtc = {
            iterationId: obv.iteration_id,
            open: "Open" in it.state,
            totalTickets: num(it.total_tickets),
            // prize ≈ the reserve paid to the winner at the trigger
            poolValueUsd: btcBaseToUsd(num(obv.reserved_btc_amount), btcDecimals, btcUsd),
            btcAmount: num(obv.btc_amount),
            reservedBtc: num(obv.reserved_btc_amount),
          };
        }
      }
      // Cache the live pool state for monitoring. These accounts are only read
      // here, so without this the dashboard can't show pool size, field size, or
      // what a ticket is currently worth — the numbers that decide entry.
      const myEpoch =
        epoch && this.vaultEpochEntryCache.iter === epoch.iterationId
          ? this.vaultEpochEntryCache.tickets
          : 0;
      const ticketEv = (
        kind: "epoch" | "one_btc",
        pool: number,
        total: number,
        mine: number,
      ): number => {
        const others = Math.max(0, total - mine);
        return (
          expectedWinningsUsd(mine + 1, others, pool, kind) -
          expectedWinningsUsd(mine, others, pool, kind)
        );
      };
      this.vaultPoolCache = {
        slot,
        epoch: epoch && {
          iterationId: epoch.iterationId,
          open: epoch.open,
          totalTickets: epoch.totalTickets,
          myTickets: myEpoch,
          poolUsd: epoch.poolValueUsd,
          slotsToClose:
            epoch.lastTriggerSlot + iterationDurationSlots - slot,
          ticketEvUsd: ticketEv("epoch", epoch.poolValueUsd, epoch.totalTickets, myEpoch),
        },
        oneBtc: oneBtc && {
          iterationId: oneBtc.iterationId,
          open: oneBtc.open,
          totalTickets: oneBtc.totalTickets,
          prizeUsd: oneBtc.poolValueUsd,
          fillBps:
            oneBtc.reservedBtc > 0
              ? Math.round((oneBtc.btcAmount / oneBtc.reservedBtc) * 10_000)
              : 0,
          ticketEvUsd: ticketEv("one_btc", oneBtc.poolValueUsd, oneBtc.totalTickets, 0),
        },
      };
      return { slot, epoch, oneBtc };
    };

    this.vaultManager = new VaultManager({
      engine,
      readState,
      epochLateSlots: this.cfg.VAULT_EPOCH_LATE_SLOTS,
      oneBtcMinFillBps: this.cfg.VAULT_ONE_BTC_MIN_FILL_BPS,
      pollMs: 5_000,
      killSwitchEngaged: () => this.bankroll.killSwitchEngaged(),
      postTick: () => this.vaultClaimCrankTick(programId, iterationDurationSlots),
      log: (obj) => this.log.info(obj, "vault-manager"),
    });
    this.vaultManager.start();
  }

  /** Assemble + fire a single vault crank/claim ix; returns the fire outcome. */
  private async sendVaultIx(
    ix: TransactionInstruction,
    meta: Record<string, unknown>,
  ): Promise<string> {
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
        meta,
      },
      { timeoutMs: 15_000 },
    );
    this.log.info({ ...meta, outcome: result.outcome }, "vault crank/claim");
    return result.outcome;
  }

  /** Our SPL balance for a mint, in base units; 0 when the ATA doesn't exist. */
  private async ataBalanceBase(mint: PublicKey): Promise<bigint> {
    try {
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const ata = getAssociatedTokenAddressSync(mint, this.payer.publicKey);
      const bal = await this.connection.getTokenAccountBalance(ata, "confirmed");
      return BigInt(bal.value.amount);
    } catch {
      return 0n; // ATA not yet created, or a transient read failure
    }
  }

  /**
   * Send a vault CLAIM and record what it actually paid.
   *
   * The claim instructions emit no event, and both pay straight into our USDC /
   * BTC ATAs — so the only way to learn the proceeds is to diff those balances
   * across the send. Without this the vault ledger has spend but no receipts and
   * a hashrate unit can never be priced. Measurement failures are logged and
   * never block the claim itself.
   */
  private async sendVaultClaim(
    kind: "epoch" | "one_btc",
    iterationId: number,
    ix: TransactionInstruction,
    meta: Record<string, unknown>,
  ): Promise<string> {
    const usdBefore = await this.ataBalanceBase(this.ixCtx.usdMint);
    const btcBefore = await this.ataBalanceBase(this.ixCtx.btcMint);
    const outcome = await this.sendVaultIx(ix, meta);
    if (outcome !== "landed") return outcome;
    try {
      const usdBase = (await this.ataBalanceBase(this.ixCtx.usdMint)) - usdBefore;
      const btcBase = (await this.ataBalanceBase(this.ixCtx.btcMint)) - btcBefore;
      this.db.recordVaultClaim({
        kind,
        iterationId,
        // Clamp: a concurrent deploy/claim could move USDC the other way.
        usdBase: usdBase > 0n ? usdBase : 0n,
        btcBase: btcBase > 0n ? btcBase : 0n,
        sig: String(meta["sig"] ?? `${kind}:${iterationId}`),
      });
      this.log.info(
        { kind, iterationId, usdBase: usdBase.toString(), btcBase: btcBase.toString() },
        "vault claim proceeds recorded",
      );
    } catch (err) {
      this.log.warn({ err: String(err), kind, iterationId }, "vault claim proceeds unmeasured");
    }
    return outcome;
  }

  /**
   * Claim resolved winnings (and, if VAULT_SELF_CRANK, crank draws) for every
   * iteration we hold unresolved tickets in. Claiming always runs; cranking is
   * opt-in and only matters when the owner's crank is absent. Runs after entry
   * evaluation each tick. Sends respect EXECUTION_MODE via the RaceSender.
   */
  private async vaultClaimCrankTick(
    programId: PublicKey,
    iterationDurationSlots: number,
  ): Promise<void> {
    const selfCrank = this.cfg.VAULT_SELF_CRANK;
    const live = this.cfg.EXECUTION_MODE !== "dry";
    const slot = await this.connection.getSlot("processed");
    for (const { kind, iteration_id } of this.db.unclaimedVaultIterations()) {
      try {
        if (kind === "epoch") {
          await this.epochClaimCrank(programId, iteration_id, slot, iterationDurationSlots, selfCrank, live);
        } else {
          await this.oneBtcClaimCrank(programId, iteration_id, selfCrank, live);
        }
      } catch (err) {
        this.log.warn({ vault: kind, iteration_id, err: String(err) }, "vault claim/crank failed");
      }
    }
  }

  private async epochClaimCrank(
    programId: PublicKey,
    iterationId: number,
    slot: number,
    durationSlots: number,
    selfCrank: boolean,
    live: boolean,
  ): Promise<void> {
    const itInfo = await this.connection.getAccountInfo(
      epochVaultIterationPda(iterationId, programId),
      "processed",
    );
    if (!itInfo) return;
    const it = decodeAccount<EpochVaultIteration>("EpochVaultIteration", itInfo.data);
    const stateName = Object.keys(it.state)[0] as EpochStateName;
    const evInfo = await this.connection.getAccountInfo(epochVaultPda(programId), "processed");
    const ev = evInfo ? decodeAccount<EpochVault>("EpochVault", evInfo.data) : null;
    // Window only matters for the still-open current iteration.
    const windowElapsed =
      ev !== null &&
      ev.iteration_id === iterationId &&
      slot >= Number(ev.last_trigger_slot.toString()) + durationSlots;
    const weWon = epochWinIndex(it.winners, this.payer.publicKey) >= 0;
    const action = epochAction({
      state: stateName,
      windowElapsed,
      winnersSelected: it.winners_selected,
      winnersTarget: Math.min(21, it.participants_count),
      weWon,
      selfCrank,
    });

    if (action === "trigger") {
      await this.sendVaultIx(
        buildTriggerEpochDraw(this.ixCtx, { authority: this.payer.publicKey, iterationId }),
        { kind: "vault_epoch_trigger", iterationId },
      );
    } else if (action === "select") {
      const pages: { pageIndex: number; cumulativeBase: bigint; totalTickets: bigint }[] = [];
      for (let p = 0; p < it.page_count; p++) {
        const pInfo = await this.connection.getAccountInfo(
          epochVaultPagePda(iterationId, p, programId),
          "processed",
        );
        if (!pInfo) continue;
        const page = decodeAccount<EpochVaultPage>("EpochVaultPage", pInfo.data);
        pages.push({
          pageIndex: page.page_index,
          cumulativeBase: BigInt(page.cumulative_base.toString()),
          totalTickets: BigInt(page.total_tickets.toString()),
        });
      }
      const pageIndex = epochWinnerPageIndex(pages, BigInt(it.current_winning_ticket.toString()));
      if (pageIndex >= 0) {
        await this.sendVaultIx(
          buildSelectEpochWinner(this.ixCtx, { authority: this.payer.publicKey, iterationId, pageIndex }),
          { kind: "vault_epoch_select", iterationId, pageIndex },
        );
      }
    } else if (action === "claim") {
      const outcome = await this.sendVaultClaim(
        "epoch",
        iterationId,
        buildClaimEpochReward(this.ixCtx, { authority: this.payer.publicKey, iterationId }),
        { kind: "vault_epoch_claim", iterationId },
      );
      if (outcome === "landed") {
        this.db.markVaultClaimed("epoch", iterationId);
        this.alert(`🏆 vault WIN — claimed epoch iteration ${iterationId}`);
      }
    } else if (action === "done" && live) {
      this.db.markVaultClaimed("epoch", iterationId); // lost or fully resolved
    }
  }

  private async oneBtcClaimCrank(
    programId: PublicKey,
    iterationId: number,
    selfCrank: boolean,
    live: boolean,
  ): Promise<void> {
    const itInfo = await this.connection.getAccountInfo(
      oneBtcVaultIterationPda(iterationId, programId),
      "processed",
    );
    if (!itInfo) return;
    const it = decodeAccount<OneBtcVaultIteration>("OneBtcVaultIteration", itInfo.data);
    const stateName = Object.keys(it.state)[0] as OneBtcStateName;
    const vInfo = await this.connection.getAccountInfo(oneBtcVaultPda(programId), "processed");
    const v = vInfo ? decodeAccount<OneBtcVault>("OneBtcVault", vInfo.data) : null;
    const triggerable =
      v !== null &&
      v.iteration_id === iterationId &&
      Number(v.btc_amount.toString()) >= Number(v.reserved_btc_amount.toString());

    let weWon = false;
    let winningTicketAcct: PublicKey | null = null;
    if (stateName !== "Open") {
      const winningTicket = BigInt(it.winning_ticket.toString());
      for (const pkStr of this.db.oneBtcTicketPubkeys(iterationId)) {
        const info = await this.connection.getAccountInfo(new PublicKey(pkStr), "processed");
        if (!info) continue;
        const e = decodeAccount<OneBtcVaultEntry>("OneBtcVaultEntry", info.data);
        const start = BigInt(e.start_ticket_id.toString());
        const count = BigInt(e.tickets_count.toString());
        if (winningTicket >= start && winningTicket < start + count) {
          weWon = true;
          winningTicketAcct = new PublicKey(pkStr);
          break;
        }
      }
    }
    const action = oneBtcAction({ state: stateName, triggerable, weWon, selfCrank });

    if (action === "trigger") {
      await this.sendVaultIx(
        buildTriggerOneBtcDraw(this.ixCtx, { authority: this.payer.publicKey, iterationId }),
        { kind: "vault_one_btc_trigger", iterationId },
      );
    } else if (action === "claim" && winningTicketAcct) {
      const outcome = await this.sendVaultClaim(
        "one_btc",
        iterationId,
        buildClaimOneBtcReward(this.ixCtx, {
          authority: this.payer.publicKey,
          iterationId,
          ticket: winningTicketAcct,
        }),
        { kind: "vault_one_btc_claim", iterationId },
      );
      if (outcome === "landed") {
        this.db.markVaultClaimed("one_btc", iterationId);
        this.alert(`🏆 vault WIN — claimed 1-BTC iteration ${iterationId}`);
      }
    } else if (action === "done" && live) {
      this.db.markVaultClaimed("one_btc", iterationId);
    }
  }

  /**
   * Build, sign, and send a vault ticket buy through the RaceSender. For the
   * 1-BTC vault a fresh ticket keypair is generated, co-signs the tx, and its
   * pubkey is persisted so the reward can be claimed later. Returns the sig.
   */
  private async buyVaultTickets(
    kind: VaultKind,
    iterationId: number,
    tickets: number,
  ): Promise<string> {
    const fee = this.feeEstimator.currentMicroLamportsPerCu();
    let ticketPubkey: string | null = null;
    let extraSigner: Keypair | null = null;
    let ix;
    if (kind === "one_btc") {
      const ticket = Keypair.generate();
      extraSigner = ticket;
      ticketPubkey = ticket.publicKey.toBase58();
      ix = buildBuyOneBtcTickets(this.ixCtx, {
        authority: this.payer.publicKey,
        iterationId,
        ticket: ticket.publicKey,
        ticketsToBuy: BigInt(tickets),
      });
    } else {
      // page index: the iteration's current fill page (fresh read).
      const itInfo = await this.connection.getAccountInfo(
        epochVaultIterationPda(iterationId, new PublicKey(this.cfg.PROGRAM_ID)),
        "processed",
      );
      const pageIndex = itInfo
        ? decodeAccount<EpochVaultIteration>("EpochVaultIteration", itInfo.data)
            .current_page_index
        : 0;
      ix = buildBuyEpochTickets(this.ixCtx, {
        authority: this.payer.publicKey,
        iterationId,
        pageIndex,
        ticketsToBuy: BigInt(tickets),
      });
    }

    const { tx, lastValidBlockHeight } = await assembleTx(this.connection, {
      payer: this.payer,
      instructions: [ix],
      computeUnitLimit: this.cfg.DEPLOY_CU_LIMIT,
      priorityFeeMicroLamports: fee,
    });
    if (extraSigner) tx.sign([extraSigner]);
    const signature = bs58.encode(tx.signatures[0]!);
    const result = await this.sender.fire(
      {
        signature,
        serialized: Buffer.from(tx.serialize()),
        lastValidBlockHeight,
        meta: { kind: `vault_${kind}`, iterationId, tickets },
      },
      { timeoutMs: 15_000 },
    );
    if (result.outcome === "landed" || result.outcome === "dry") {
      this.db.recordVaultTicket({ kind, iterationId, tickets, ticketPubkey, sig: signature });
    }
    if (result.outcome === "landed") {
      this.alert(`⛏ vault: bought ${tickets} ${kind} tickets (iteration ${iterationId})`);
    }
    return signature;
  }

  private async maybeSweep(): Promise<void> {
    if (!this.state.miner || this.sweepInFlight) return;
    if (this.cfg.EXECUTION_MODE === "dry" || this.bankroll.killSwitchEngaged()) return;
    this.sweepInFlight = true;
    try {
      await this.claimUsdCompound(); // fee-free — the compound loop
      await this.claimSatsSweep(); // fee-bearing (10% claim fee) — opt-in
    } finally {
      this.sweepInFlight = false;
    }
  }

  /** Send a single claim instruction through the race sender (shared plumbing). */
  private async fireClaim(
    ix: TransactionInstruction,
    meta: Record<string, unknown>,
  ): Promise<string> {
    const fee = this.feeEstimator.currentMicroLamportsPerCu();
    assertFeeBearingInvariants({
      kind: "claim",
      priorityFeeMicroLamports: fee,
      maxPriorityFeeMicroLamports: this.cfg.PRIORITY_FEE_MAX_MICROLAMPORTS,
      killSwitchEngaged: this.bankroll.killSwitchEngaged(),
    });
    const { tx, lastValidBlockHeight } = await assembleTx(this.connection, {
      payer: this.payer,
      instructions: [ix],
      computeUnitLimit: this.cfg.DEPLOY_CU_LIMIT,
      priorityFeeMicroLamports: fee,
    });
    const result = await this.sender.fire(
      {
        signature: bs58.encode(tx.signatures[0]!),
        serialized: Buffer.from(tx.serialize()),
        lastValidBlockHeight,
        meta,
      },
      { timeoutMs: 15_000 },
    );
    return result.outcome;
  }

  /**
   * Compound loop: claim won USDC (miner.unclaimed_usd_amount) back to the wallet
   * so it re-enters the deployable bankroll and Kelly sizes against it next
   * round. claim_usd is a straight transfer — the deploy fees were already taken,
   * so there is no extra claim fee (unlike claim_sats) — making this pure upside.
   * Batched by MAX_UNCLAIMED_USD_VALUE so the tx fee is amortized.
   */
  private async claimUsdCompound(): Promise<void> {
    if (!this.cfg.CLAIM_USD_ENABLED) return;
    const miner = this.state.miner;
    if (!miner) return;
    const amount = BigInt(miner.unclaimed_usd_amount.toString());
    if (amount <= usdToBase(this.cfg.MAX_UNCLAIMED_USD_VALUE)) return;
    const outcome = await this.fireClaim(
      buildClaimUsd(this.ixCtx, { authority: this.payer.publicKey, amount }),
      { kind: "claim_usd", amount: amount.toString() },
    );
    this.log.info({ amount: amount.toString(), outcome }, "usd compound claim resolved");
    if (outcome === "landed") {
      this.alert(`compounded $${(Number(amount) / 1e6).toFixed(2)} USDC back to wallet`);
    }
  }

  /**
   * BTC-share sweep: redeem a fraction of unclaimed vault shares to BTC. This
   * pays the sats_vault_claim fee (~10%), so it's gated OFF by default — enable
   * only when realizing BTC is worth the fee vs holding the shares as exposure.
   */
  private async claimSatsSweep(): Promise<void> {
    const miner = this.state.miner;
    const vault = this.state.satsVault;
    if (!miner || !vault) return;
    const value = this.pnl.unclaimedValue({
      miner,
      satsVault: vault,
      btcUsdPrice: this.cfg.BTC_USD_ESTIMATE,
      btcDecimals: 8, // cbBTC-style; read from mint before mainnet
    });
    const sharesUsd = value.totalUsd - value.usd; // BTC-share value only
    if (sharesUsd <= usdToBase(this.cfg.MAX_UNCLAIMED_USD_VALUE)) return;
    if (!this.cfg.SWEEP_ENABLED) {
      this.skipOnce("sweep_disabled", { unclaimedSharesUsd: sharesUsd.toString() });
      return;
    }
    const shares =
      (value.shares * BigInt(Math.round(this.cfg.CLAIM_FRACTION * 10_000))) / 10_000n;
    if (shares <= 0n) return;
    const outcome = await this.fireClaim(
      buildClaimSats(this.ixCtx, { authority: this.payer.publicKey, shares }),
      { kind: "claim_sats", shares: shares.toString() },
    );
    this.log.info({ shares: shares.toString(), outcome }, "sats sweep resolved");
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
    // Sat Strike opens (or resets) the post-Strike hashrate bonus window. We
    // learn this from the event in the same slot it reveals — well before the
    // site banner — so the EV model can size up for the whole window.
    if (reveal.is_strike_triggered) {
      this.lastStrikeAtMs = Date.now();
      this.alert(
        `⚡ Sat Strike round ${reveal.round_id} — ${this.cfg.STRIKE_HASHRATE_MULTIPLIER}× hashrate ` +
          `for ${this.cfg.STRIKE_BONUS_WINDOW_MINUTES}min`,
      );
    }
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
    void this.attachApi();

    this.source.on("slot", (u) => {
      this.state.applySlot(u.slot);
      this.onSlotTick();
    });

    this.source.on("account", (u) => {
      try {
        // Pass the update's slot so the monotonicity guard can drop stale /
        // out-of-order replays instead of reading them as a stake decrease.
        const applied = this.state.applyAccount(u.pubkey, u.data, u.slot);
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
          // Persist the halt (KILL file) so a restart can't resume on bad data.
          this.engageKillSwitch(`HaltError: ${err.message} ${JSON.stringify(err.context)}`);
          this.transition("LOGGED", { halted: true });
          return; // stay alive, observing — kill switch blocks all sends
        }
        this.haltFromError(err, "account handler");
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
            // Atomic per-round settlement write.
            this.db.transaction(() => {
              this.db.recordSettlement({
                roundId: data.round_id,
                winningStake: BigInt(data.winning_stake.toString()),
                wonUsd: BigInt(data.won_usd_amount.toString()),
                wonShares: BigInt(data.won_shares_amount.toString()),
                hashrateEarned: BigInt(data.hashrate_earned.toString()),
                sig: event.signature,
              });
              this.pnl.refreshDaily();
            });
            this.reconcileSettlement(data);
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
    // Coarse wallet-drift tripwire, every 30s (skips itself in dry mode); the
    // same tick refreshes the measured hashrate-per-deploy for the unified EV.
    this.validateHashrateFormula();
    this.refreshFireOffset();
    this.refreshRivalProfiles();
    this.walletDriftTimer = setInterval(() => {
      void this.checkWalletDrift();
      this.validateHashrateFormula();
      this.refreshFireOffset();
      this.refreshRivalProfiles();
    }, 30_000);
    this.walletDriftTimer.unref?.();
    // Hashrate raffle vaults — only started when explicitly enabled; the deploy
    // path is otherwise entirely untouched.
    if (this.cfg.VAULT_STRATEGY_ENABLED) this.startVaultManager();
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
    if (this.walletDriftTimer) clearInterval(this.walletDriftTimer);
    this.vaultManager?.stop();
    await this.source.stop().catch(() => undefined);
    await this.telegram?.alert(`bot shutting down (${reason})`).catch(() => undefined);
    await this.api?.stop().catch(() => undefined);
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

// Last-resort error boundaries: any unhandled rejection or exception halts
// safe (kill switch + persisted KILL file) rather than crashing mid-send or
// silently swallowing. uncaughtException additionally exits so systemd
// restarts into a fresh (KILL-file-halted) process.
process.on("unhandledRejection", (reason) => {
  orchestrator.haltFromError(reason, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  orchestrator.haltFromError(err, "uncaughtException");
  setTimeout(() => process.exit(1), 500).unref();
});

// Acceptance chaos hook: CHAOS_DISCONNECT_AT_S=<seconds> forces an ingest
// disconnect mid-run to prove staleness detection + recovery.
const chaosAt = Number(process.env["CHAOS_DISCONNECT_AT_S"] ?? 0);
if (chaosAt > 0) {
  setTimeout(() => orchestrator.forceDisconnect(), chaosAt * 1000).unref();
}
