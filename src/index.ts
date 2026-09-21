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
import {
  Connection,
  Keypair,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
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
  PublicAutomation,
  PublicDeployCreated,
  Affiliate,
  PublicDeploySettled,
  Round,
  RoundRevealed,
} from "./adapter/idl.js";
import { decodeAccount } from "./adapter/idl.js";
import {
  buildBuyEpochTickets,
  buildBuyOneBtcTickets,
  buildDistributeEpochReward,
  buildClaimOneBtcReward,
  buildClaimSats,
  buildExchangeAffiliatePoints,
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
  tokenVaultPda,
  affiliatePda,
} from "./adapter/pdas.js";
import { VaultEngine } from "./exec/vault-engine.js";
import { VaultManager, oneBtcFillBps, type VaultReadState } from "./exec/vault-manager.js";
import { streakOptionValueUsd } from "./strategy/streak.js";
import { createHash } from "node:crypto";
import { projectField } from "./strategy/epoch-pool.js";
import {
  automationInflow,
  pendingCommitments,
  readableCommitments,
  type AutomationCommitment,
} from "./ingest/automations.js";
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
import { CandidateSet, type EvSource } from "./exec/candidates.js";
import { FeeEstimator } from "./exec/fees.js";
import { RaceSender } from "./exec/sender.js";
import { assembleTx, loadKeypair } from "./exec/tx.js";
import { writeFileSync } from "node:fs";
import { HaltError } from "./ingest/decode.js";
import { assertDeployInvariants, assertFeeBearingInvariants } from "./exec/guards.js";
import { reconcileRoundOutcome, reconcileRoundOutcomeV2, reconcileWalletDrift } from "./strategy/reconcile.js";
import { parseTransactionEvents } from "./ingest/events.js";
import { YellowstoneIngest } from "./ingest/grpc.js";
import { PriceFeed } from "./ingest/prices.js";
import { bootstrapGameState, type GameState } from "./ingest/snapshot.js";
import type { IngestSource } from "./ingest/types.js";
import { WsRpcIngest } from "./ingest/wsrpc.js";
import { logger } from "./logger.js";
import { HealthMonitor } from "./ops/health.js";
import { MonitorApi } from "./ops/api.js";
import { createMonitorData, type MonitorData, type VaultPoolsJson } from "./ops/monitor.js";
import { createTelegramOps, type TelegramOps } from "./ops/telegram.js";
import { StateDb } from "./state/db.js";
import { DEFAULT_DEPLOY_FEE_BPS, Pnl, utcDate } from "./state/pnl.js";
import { Bankroll, strikeSizeMultiplier } from "./strategy/bankroll.js";
import { feeModelFromConfig, netFactor, TILES_COUNT, v1Model, type EvContext, type FeeModel } from "./strategy/ev.js";
import { tollAtRiskFraction, v2EconomicsFromConfig, v2Model, type V2EvContext } from "./strategy/ev-v2.js";
import { EPOCH_EQUAL_CURVE_BPS } from "./strategy/vault.js";
import { STREAK_GRACE_ROUNDS, STRIKE_BOOST_WINDOW_ROUNDS, V2_LOSING_TILE_REFUND_BPS } from "./strategy/facts.js";
import { TokenFeed } from "./ingest/token-feed.js";
import { WalletSet, type WalletState } from "./exec/wallets.js";
import { predictFinalOccupancy } from "./strategy/predict.js";
import { adaptiveFireOffset } from "./strategy/fire-offset.js";
import { maskToTiles } from "./adapter/mask.js";
import { hashrateRawPerUsd, REWARD_MAX_STREAK, strikeBonusMultiplier } from "./strategy/hashrate.js";
import {
  predictRivalInflow,
  profileCompetitors,
  type CompetitorDeployRow,
  type RivalProfile,
  type RoundWindow,
} from "./strategy/competitors.js";
import type { SelectorConfig } from "./strategy/selector.js";
import { SLOT_SECONDS, usdToBase } from "./units.js";

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
  /** Armed until the ramp alert fires; re-armed when the signal drops below 0. */
  private rampAlertArmed = true;
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
  /** Per-crank failure backoff, so a bad eligibility check cannot spam sends. */
  private readonly crankBackoff = new Map<string, { failures: number; nextAttemptMs: number }>();
  private walletDriftTimer: NodeJS.Timeout | null = null;
  private vaultManager: VaultManager | null = null;
  // Per-tick caches so the (synchronous) VaultEngine deps can read fresh values
  // that the manager's async readState refreshes immediately before evaluating.
  // Keyed by wallet pubkey (base58): each fleet wallet spends its own hashrate.
  private readonly vaultHashrateCache = new Map<string, number>();
  private readonly vaultEpochEntryCache = new Map<string, { iter: number; tickets: number }>();
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
    private readonly prices: PriceFeed,
    /** RUSH price + mint rate (V2 only; null under GAME_VERSION=v1). */
    private readonly tokenFeed: TokenFeed | null,
    /** The signer fleet; `payer` is its primary. One wallet unless WALLET_PATHS is set. */
    private readonly wallets: WalletSet,
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
        slotLagThreshold: cfg.SLOT_LAG_ALERT_SLOTS,
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
      btcUsdEstimate: () => this.prices.btcUsd(),
      priceStatus: () => this.prices.status(),
      slotLag: () => {
        const s = this.health.lastSlotLag();
        const fresh = s !== null && Date.now() - s.atMs <= cfg.SNAPSHOT_LAG_MAX_AGE_MS;
        const budget = Math.min(
          cfg.MAX_SNAPSHOT_LAG_SLOTS,
          Math.max(1, this.currentFireOffset() - 1),
        );
        return {
          lagSlots: fresh ? s.lagSlots : null,
          blocking: fresh && s.lagSlots > budget,
        };
      },
      vaultEnabled: cfg.VAULT_STRATEGY_ENABLED,
      ticketPriceHashrate: cfg.VAULT_HASHRATE_PER_TICKET,
      vaultPools: () => this.vaultPoolCache,
      fireOffsetSlots: () => this.currentFireOffset(),
      shareValueUsd: () => this.satsShareValueUsd(),
      tokenShareValueUsd: () => this.tokenShareValueUsd(),
      tokenFeedStatus: () => this.tokenFeed?.status() ?? null,
      wallets: () => this.wallets.snapshot(),
      gameVersion: cfg.GAME_VERSION,
      shareCarry: () => this.shareCarry(),
      carryHorizonDays: cfg.VAULT_CARRY_HORIZON_DAYS,
      hashrateValue: () => {
        const usdPerRawUnit = this.hashrateValueUsdPerRawUnit();
        const source =
          cfg.HASHRATE_VALUE_USD > 0 ? "config" : usdPerRawUnit > 0 ? "derived" : "none";
        return { usdPerRawUnit, source };
      },
    });
  }

  static async boot(cfg: Config): Promise<Orchestrator> {
    const programId = new PublicKey(cfg.PROGRAM_ID);
    const connection = new Connection(cfg.RPC_HTTP_URL, "processed");
    // KEYPAIR_PATH is always the primary (it pays cranks and claims); WALLET_PATHS
    // adds the extra signers. Duplicates are refused inside WalletSet.load.
    const wallets = WalletSet.load(
      cfg.WALLET_PATHS.length > 0 ? [cfg.KEYPAIR_PATH, ...cfg.WALLET_PATHS] : [],
      cfg.KEYPAIR_PATH,
    );
    const payer = wallets.primary().keypair;
    const db = new StateDb(cfg.DB_PATH);

    const state = await bootstrapGameState(connection, {
      onRollback: (r) =>
        logger.warn(
          { ...r, droppedUsd: Number(r.droppedBase) / 1e6 },
          "fork rollback absorbed — board stake moved down at a newer slot",
        ),
      minerAuthority: wallets.pubkeys(),
      programId,
    });
    if (!state.satrushConfig) throw new Error("satrush_config missing on chain");
    const fees = feeModelFromConfig(state.satrushConfig);
    // Fee bps read LIVE from chain (they are updatable on-chain), so the daily
    // fee column tracks reality instead of a devnet-era constant.
    // Share marking for the daily loss figure (V2 only): a win pays in BTC and
    // RUSH vault shares, not USD, so an unmarked ledger books wins as losses.
    // Prices are wired after the feeds exist (below); until then the marker
    // values shares at the config fallbacks (token at 0).
    const marks = { btcUsd: () => cfg.BTC_USD_ESTIMATE, tokenUsd: () => 0 };
    const v2Econ =
      cfg.GAME_VERSION === "v2"
        ? v2EconomicsFromConfig(state.satrushConfig, { losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value })
        : null;
    const markShares = (satsShares: bigint, tokenShares: bigint): bigint => {
      const exit = 1 - (state.satrushConfig?.vault_exit_fee_bps ?? 0) / 10_000;
      let usd = 0;
      const sv = state.satsVault;
      if (sv && satsShares > 0n && Number(sv.btc_shares.toString()) > 0) {
        const btc = (Number(satsShares) * Number(sv.btc_amount.toString())) / Number(sv.btc_shares.toString()) / 1e8;
        usd += btc * marks.btcUsd() * exit;
      }
      const tv = state.tokenVault;
      if (tv && tokenShares > 0n && Number(tv.token_shares.toString()) > 0) {
        const rush = (Number(tokenShares) * Number(tv.token_amount.toString())) / Number(tv.token_shares.toString()) / 1e9;
        usd += rush * marks.tokenUsd() * exit;
      }
      return BigInt(Math.floor(Math.max(0, usd) * 1e6));
    };
    const pnl = new Pnl(db, {
      deployFeeBps: () =>
        state.satrushConfig
          ? feeModelFromConfig(state.satrushConfig).deployFeeBps
          : DEFAULT_DEPLOY_FEE_BPS,
      ...(v2Econ ? { markShares } : {}),
    });
    const ixCtx: InstructionContext = {
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
        // V2: the board can take at most the toll of a stake (1 − refund);
        // V1: the whole stake. MAX_PER_ROUND stays on gross in both.
        lossFractionAtRisk: v2Econ ? tollAtRiskFraction(v2Econ) : 1,
      },
      { realizedLossToday: () => pnl.realizedLossToday() },
    );
    logger.info(
      { lossFractionAtRisk: bankroll.lossFractionAtRisk, sharesMarked: v2Econ !== null },
      "daily loss cap: at-risk fraction per stake",
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
    // Live USD prices. Everything BTC-denominated (vault pools, unclaimed
    // position value, and the hashrate price derived from them) and the Jito
    // tip sizing read from here; the config constants are fallbacks only.
    const prices = new PriceFeed({
      connection,
      accounts: {
        btc: cfg.PYTH_BTC_USD_ACCOUNT ? new PublicKey(cfg.PYTH_BTC_USD_ACCOUNT) : undefined,
        sol: cfg.PYTH_SOL_USD_ACCOUNT ? new PublicKey(cfg.PYTH_SOL_USD_ACCOUNT) : undefined,
      },
      fallback: { btc: cfg.BTC_USD_ESTIMATE, sol: cfg.SOL_USD_ESTIMATE },
      maxStaleSlots: cfg.PRICE_MAX_STALE_SLOTS,
      maxConfidenceRatio: cfg.PRICE_MAX_CONFIDENCE_RATIO,
      pollMs: cfg.PRICE_POLL_MS,
      log: (obj, msg) => logger.warn(obj, msg),
    });
    // Prime before anything prices against it; start() begins the poll.
    await prices.start();
    logger.info(prices.status(), "price feed primed");

    // V2 token leg: RUSH oracle price × measured mint rate, from the public
    // API. Primed here so the first round is priced on a live yield or on
    // the (default 0) fallback — never on the announced numbers.
    let tokenFeed: TokenFeed | null = null;
    if (cfg.GAME_VERSION === "v2") {
      tokenFeed = new TokenFeed({
        apiUrl: cfg.SATRUSH_API_URL,
        fallback: { tokenUsd: cfg.RUSH_USD_ESTIMATE, mintRushPerUsd: cfg.RUSH_MINT_PER_USD_ESTIMATE },
        pollMs: cfg.TOKEN_FEED_POLL_MS,
        maxAgeMs: cfg.TOKEN_FEED_MAX_AGE_MS,
        dexPriceUrl: cfg.DEX_PRICE_URL,
        tokenMint: state.satrushConfig.token_mint.toBase58(),
        maxPriceDivergence: cfg.TOKEN_PRICE_MAX_DIVERGENCE,
        log: (obj, msg) => logger.warn(obj, msg),
      });
      await tokenFeed.start();
      logger.info(tokenFeed.status(), "token feed primed (V2 economics)");
    } else {
      logger.warn("GAME_VERSION=v1: pricing the pre-upgrade parimutuel — wrong against the live V2 program");
    }
    marks.btcUsd = () => prices.btcUsd();
    marks.tokenUsd = () => {
      const st = tokenFeed?.status();
      return st?.live ? st.tokenUsd : 0; // unpriced RUSH marks at nothing
    };

    const jitoTip =
      tipAccounts.length > 0
        ? {
            accounts: tipAccounts.map((a) => new PublicKey(a)),
            baseLamports: cfg.JITO_TIP_LAMPORTS,
            maxLamports: cfg.JITO_TIP_MAX_LAMPORTS,
            evFraction: cfg.JITO_TIP_EV_FRACTION,
            solUsd: () => prices.solUsd(),
          }
        : undefined;
    // Fleet: balances must be known before the first allocate(); the drift
    // tick keeps them fresh afterwards.
    if (wallets.size > 1) await wallets.refreshBalances(connection, ixCtx.usdMint);
    const primaryKey = payer.publicKey;
    const affiliateAuthority = cfg.AFFILIATE_AUTHORITY ? new PublicKey(cfg.AFFILIATE_AUTHORITY) : primaryKey;
    // Grubstake USD (affiliate rebate exchanged into the Miner, or an airdrop)
    // can only be realised by deploying it, so it funds a leg whenever it
    // covers the amount and has not expired — at the cost of that leg's
    // hashrate. Read from the streamed Miner at build time.
    const grubstakeFor = (w: PublicKey, amountGross: bigint): boolean => {
      if (!cfg.GRUBSTAKE_DEPLOYS) return false;
      const m = state.minerAt(minerPda(w, programId));
      if (!m) return false;
      const bal = BigInt(m.grubstake_usd_amount.toString());
      const expires = Number(m.grubstake_expiration_timestamp.toString());
      return bal >= amountGross && expires > Math.floor(Date.now() / 1000) + 120;
    };
    const candidates = new CandidateSet({
      connection,
      payer,
      grubstakeFor,
      ...(wallets.size > 1
        ? {
            wallets,
            fundingFloor: {
              minDeployBase: BigInt(state.satrushConfig.min_deploy_usd_amount.toString()),
              minLamports: cfg.WALLET_MIN_LAMPORTS,
            },
            // Bind a wallet to the affiliate only while it has no Miner yet
            // (that is the only time the program reads the slot); never the
            // affiliate itself (self-referral is refused on chain).
            affiliateFor: (w: PublicKey) =>
              w.equals(affiliateAuthority) || state.minerAt(minerPda(w, programId)) !== null
                ? undefined
                : affiliateAuthority,
          }
        : {}),
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

    const watch = [
      satsVaultPda(programId),
      tokenVaultPda(programId),
      ...wallets.pubkeys().map((w) => minerPda(w, programId)),
    ];
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
      prices,
      tokenFeed,
      wallets,
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
        getWallets: () => this.wallets.snapshot(),
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
    const feed = this.tokenFeed?.status();
    return {
      gameVersion: this.cfg.GAME_VERSION,
      markedNet: this.pnl.markedNetToday(),
      unclaimedSharesUsd: m.unclaimed.sharesUsd,
      unclaimedTokenShares: BigInt(this.state.miner?.unclaimed_token_shares.toString() ?? "0"),
      unclaimedTokenUsd: m.unclaimed.tokenSharesUsd,
      tokenYield: m.game.tokenYield,
      rushUsd: feed?.live ? feed.tokenUsd : null,
      satsVaultApr: m.game.satsVaultApr,
      carryCredited: m.game.carry,
      walletCount: this.wallets.size,
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
    // We watched this round open, so the set of who has deployed in it starts
    // empty and stays complete. That is what lets predictedRivalInflow() trust
    // it; on a restart mid-round it cannot, and predicts zero instead.
    this.noteRoundOpened(roundId);
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
    // Persisted too: a log line cannot answer "why has it not fired all day".
    if (this.roundId !== null) this.db.recordSkip(this.roundId, key, detail);
  }

  private async refreshCandidates(trigger: string): Promise<void> {
    if (this.roundId === null) return;
    const round = this.state.round(this.roundId);
    if (round && !("Active" in round.state)) return;
    try {
      const built = await this.candidates.refresh(
        this.roundId,
        this.evSource(),
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
  /**
   * Refresh the automation book. Registrations change rarely, so this polls on
   * a round cadence rather than sitting in the fire path.
   */
  private async refreshAutomationBook(): Promise<void> {
    if (!this.cfg.AUTOMATION_BOOK_ENABLED) return;
    const round = this.state.board?.round_id ?? 0;
    if (round - this.automationBookRound < this.cfg.AUTOMATION_REFRESH_ROUNDS) return;
    this.automationBookRound = round;
    try {
      const programId = new PublicKey(this.cfg.PROGRAM_ID);
      const disc = createHash("sha256").update("account:PublicAutomation").digest().subarray(0, 8);
      const accounts = await this.connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        filters: [
          { memcmp: { offset: 0, bytes: bs58.encode(disc), encoding: "base58" as const } },
        ],
      });
      const entries = accounts.map(({ pubkey, account }) => ({
        authority: pubkey,
        account: decodeAccount<PublicAutomation>("PublicAutomation", account.data),
      }));
      this.automationBook = readableCommitments(entries);
      this.log.info(
        { registered: accounts.length, funded: this.automationBook.length },
        "automation book refreshed",
      );
    } catch (err) {
      // Keep the previous book; a stale one beats falling back to a guess.
      this.log.warn({ err: String(err) }, "automation book refresh failed");
    }
  }

  /**
   * Expected rival inflow per tile.
   *
   * Prefers the READ automation book over the statistical profiles: about 86%
   * of the field is funded Static automations whose masks and amounts are
   * public, so predicting them is strictly worse than looking. Falls back to
   * the profiles when the book is empty — before the first read, or if the
   * refresh failed — because an empty book means "unknown", not "no rivals".
   */
  private predictedRivalInflow(): bigint[] {
    if (this.cfg.AUTOMATION_BOOK_ENABLED && this.automationBook.length > 0) {
      // Only automations that have not ALREADY fired this round. The board we
      // read is the Round account, which the crank has already written every
      // executed automation into, so predicting the whole book on top of it
      // double-counted 86% of the field — see pendingCommitments().
      //
      // Joining a round mid-flight (a restart) means we cannot know who has
      // fired, and the accurate prior is that they all have: the crank executes
      // at round open. Predicting zero is therefore the CORRECT call, not a
      // conservative one.
      if (!this.roundObservedFromOpen) return new Array<bigint>(TILES_COUNT).fill(0n);
      const pending = pendingCommitments(this.automationBook, this.deployedThisRound);
      return automationInflow(pending, {
        netFactor: netFactor(this.fees),
        fireRate: this.cfg.AUTOMATION_FIRE_RATE,
      });
    }
    return predictRivalInflow(this.rivalProfiles, this.state.visibleStakes());
  }

  /**
   * Authorities seen deploying in `deployedRoundId`, so the automation book can
   * be reduced to what is still to come. Reset on every rotation.
   */
  private deployedThisRound = new Set<string>();
  private deployedRoundId = -1;
  /**
   * False until we witness a round rotate, i.e. until we know we have seen the
   * round from its beginning. A restart mid-round leaves the set incomplete and
   * the difference is not detectable from the set itself.
   */
  private roundObservedFromOpen = false;

  /** Record a deploy against the round it belongs to, rotating state if needed. */
  private noteDeployer(roundId: number, authority: string): void {
    if (roundId !== this.deployedRoundId) {
      this.deployedRoundId = roundId;
      this.deployedThisRound = new Set<string>();
      // A round we first hear about through a deploy is a round we joined
      // late. Only an observed rotation clears this.
      this.roundObservedFromOpen = false;
    }
    this.deployedThisRound.add(authority);
  }

  /** Called when the board rotates to a new round we watched happen. */
  private noteRoundOpened(roundId: number): void {
    this.deployedRoundId = roundId;
    this.deployedThisRound = new Set<string>();
    this.roundObservedFromOpen = true;
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
      // Omitted entirely when the deploy-side credit is gated off, so a round
      // is judged on the board alone. Spending hashrate we already hold is a
      // separate path (VAULT_STRATEGY_ENABLED) and keeps running.
      ...(this.cfg.HASHRATE_DEPLOY_CREDIT_ENABLED
        ? {
            hashrate: {
              streak: this.state.miner?.current_streak_count ?? 1,
              valueUsdPerRawUnit: this.hashrateValueUsdPerRawUnit(),
              multiplier: this.strikeBonusMultiplier(),
              maxRawUnitsPerRound: this.monetisableRawPerRound(),
            },
          }
        : {}),
      strikeExpectedPot: this.strikeExpectedPotBase(),
      presenceCreditBase: this.presenceCreditBase(),
    };
  }

  /**
   * Vault carry credited on the share legs over VAULT_CARRY_HORIZON_DAYS: the
   * app's live `apr` per vault, capped at VAULT_CARRY_APR_CAP, converted to
   * the fraction the shares appreciate over the horizon. Null when the
   * horizon is 0 or the feed is not live — a carry nobody is marking is 0.
   */
  private shareCarry(): { sats: number; token: number } | null {
    const days = this.cfg.VAULT_CARRY_HORIZON_DAYS;
    const feed = this.tokenFeed?.status();
    if (!(days > 0) || !feed?.live) return null;
    const over = (apr: number | null): number => (Math.min(apr ?? 0, this.cfg.VAULT_CARRY_APR_CAP) / 365) * days;
    return { sats: over(feed.satsVaultApr), token: over(feed.tokenVaultApr) };
  }

  /**
   * One-line view of the model at the cap, for skip logs: the EV (bps of
   * gross) of an even blanket and of the single emptiest tile at
   * MAX_PER_ROUND. Tells the operator how far from +EV the board sits without
   * a debugger — under V2 both are typically −100 bps or so.
   */
  private evDiagnostics(): Record<string, unknown> {
    try {
      const src = this.evSource();
      const model = "model" in src ? src.model(src.predictedStakes) : v1Model(src);
      const cap = this.effectiveMaxPerRoundBase();
      if (cap <= 0n) return {};
      const blanket = new Array<bigint>(TILES_COUNT).fill(cap / BigInt(TILES_COUNT));
      const emptiest = model.predictedStakes.reduce((b, s, i, a) => (s < (a[b] ?? 0n) ? i : b), 0);
      const single = new Array<bigint>(TILES_COUNT).fill(0n);
      single[emptiest] = cap;
      const bps = (ev: number, gross: bigint) => Math.round((ev / Number(gross)) * 10_000);
      // The same single tile with the streak at its cap: the hashrate credit
      // at 121 raw/$ instead of today's. Positive here and negative above
      // means the streak ramp (~100 rounds of a minimum deploy) would pay —
      // `pnpm streak-ramp` prices it; it has not been positive yet.
      const capped = (() => {
        const base = this.v2Base();
        if (!("model" in src) || !base?.hashrate) return null;
        return v2Model({ ...base, predictedStakes: src.predictedStakes, hashrate: { ...base.hashrate, streak: REWARD_MAX_STREAK } });
      })();
      const atCap = capped ? bps(capped.ev(single), cap) : null;
      // The blanket at the cap is the "flip" signal: a blanket is parimutuel
      // (the refund, sats and strike legs come back pro rata whatever wins),
      // so its EV at the cap is the non-token toll against the RUSH yield —
      // positive means mining RUSH is cheaper than buying it (pnpm buy-vs-mine).
      const blanketAtCap = capped ? bps(capped.ev(blanket), cap - (cap % BigInt(TILES_COUNT))) : null;
      this.rampSignal(blanketAtCap);
      return {
        blanketEvBps: bps(model.ev(blanket), cap - (cap % BigInt(TILES_COUNT))),
        blanketEvBpsAtStreakCap: blanketAtCap,
        emptiestTile: emptiest,
        emptiestEvBps: bps(model.ev(single), cap),
        emptiestEvBpsAtStreakCap: atCap,
        tokenYield: this.tokenFeed?.status().live ? this.tokenFeed.status().yieldPerVolume : null,
        shareCarry: this.shareCarry(),
      };
    } catch {
      return {};
    }
  }

  /**
   * One alert when a blanket at the streak cap clears RAMP_ALERT_MIN_BPS —
   * the ramp would pay and mining RUSH beats buying it — then silence until
   * the signal has dropped below zero and cleared the margin again. The bot
   * does not start the ramp by itself: that is the operator's call
   * (`pnpm streak-ramp` prices it).
   */
  private rampSignal(blanketAtCapBps: number | null): void {
    const min = this.cfg.RAMP_ALERT_MIN_BPS;
    if (blanketAtCapBps === null || !(min > 0)) return;
    if (this.rampAlertArmed && blanketAtCapBps >= min) {
      this.rampAlertArmed = false;
      this.alert(
        `ramp pays: an even blanket at the streak cap is ${blanketAtCapBps > 0 ? "+" : ""}${blanketAtCapBps} bps of gross ` +
        `(≥ ${min} bps) — mining RUSH is now cheaper than buying it; price the ramp with pnpm streak-ramp / pnpm buy-vs-mine`,
      );
    } else if (!this.rampAlertArmed && blanketAtCapBps < 0) {
      this.rampAlertArmed = true;
    }
  }

  /**
   * What the selector prices against. V2 swaps the parimutuel for the
   * refund/sats/RUSH economics (`v2Model`) on the same occupancy prediction;
   * the model factory lets candidates rebuild it for excluded-tile variants.
   */
  /** The V2 context minus the stakes (null under V1 or before the config is read). */
  private v2Base(): Omit<V2EvContext, "predictedStakes"> | null {
    if (this.cfg.GAME_VERSION !== "v2") return null;
    const config = this.state.satrushConfig;
    if (!config) return null;
    const ctx = this.evContext();
    const econ = v2EconomicsFromConfig(config, { losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value });
    const feed = this.tokenFeed?.status();
    const tokenYieldPerVolume =
      feed && feed.live ? feed.yieldPerVolume : this.cfg.RUSH_USD_ESTIMATE * this.cfg.RUSH_MINT_PER_USD_ESTIMATE;
    return {
      econ,
      mintedTokenValueBase: 0,
      tokenYieldPerVolume,
      strikeExpectedPot: this.strikeExpectedPotBase(),
      ...(ctx.hashrate ? { hashrate: ctx.hashrate } : {}),
      presenceCreditBase: ctx.presenceCreditBase ?? 0,
      ...(this.shareCarry() ? { shareCarry: this.shareCarry()! } : {}),
    };
  }

  private evSource(): EvSource {
    const ctx = this.evContext();
    if (this.cfg.GAME_VERSION !== "v2") return ctx;
    const config = this.state.satrushConfig;
    if (!config) return ctx; // unreachable after boot (config is required to start)
    const econ = v2EconomicsFromConfig(config, {
      losingRefundBps: V2_LOSING_TILE_REFUND_BPS.value,
    });
    // The token yield is priced only while the feed is live: a stale or
    // never-answered feed falls back to the configured estimate (default 0),
    // so the selector never chases a RUSH leg nobody is currently marking.
    const feed = this.tokenFeed?.status();
    const tokenYieldPerVolume =
      feed && feed.live
        ? feed.yieldPerVolume
        : this.cfg.RUSH_USD_ESTIMATE * this.cfg.RUSH_MINT_PER_USD_ESTIMATE;
    const base: Omit<V2EvContext, "predictedStakes"> = {
      econ,
      mintedTokenValueBase: 0,
      tokenYieldPerVolume,
      strikeExpectedPot: this.strikeExpectedPotBase(),
      ...(ctx.hashrate ? { hashrate: ctx.hashrate } : {}),
      presenceCreditBase: ctx.presenceCreditBase ?? 0,
      ...(this.shareCarry() ? { shareCarry: this.shareCarry()! } : {}),
    };
    return {
      predictedStakes: ctx.predictedStakes,
      model: (predictedStakes) => v2Model({ ...base, predictedStakes }),
    };
  }

  /**
   * Fixed credit (base units) for deploying at all this round: the streak
   * option value. See strategy/streak.ts — one missed round resets the accrual
   * counter to 1, and nothing was pricing that.
   *
   * Sized against the deploy we would actually make (MAX_PER_ROUND, which is
   * what the water-filler is bounded by), and inert whenever hashrate has no
   * priced sink, so this can never conjure a credit out of an unpriceable
   * asset.
   */
  private presenceCreditBase(): number {
    if (!this.cfg.STREAK_OPTION_VALUE_ENABLED) return 0;
    const miner = this.state.miner;
    const usd = streakOptionValueUsd({
      streak: miner?.current_streak_count ?? 1,
      deployPerRoundUsd: this.cfg.MAX_PER_ROUND_USD,
      valueUsdPerRawUnit: this.hashrateValueUsdPerRawUnit(),
      liquidFraction:
        1 - (this.state.satrushConfig?.unclaimed_hashrate_bps ?? 0) / 10_000,
      discount: this.cfg.STREAK_OPTION_DISCOUNT,
      // V2: a skip inside the 2-round grace costs nothing, so the option is
      // worth nothing until the round that would actually break the streak.
      ...(this.cfg.GAME_VERSION === "v2" && miner && this.roundId !== null
        ? {
            roundId: this.roundId,
            lastMinedRoundId: miner.last_mined_round_id,
            graceRounds: STREAK_GRACE_ROUNDS.value,
          }
        : {}),
    });
    return usd > 0 ? usd * 1e6 : 0;
  }

  /** The program's 1-BTC draw trigger, in BTC base units. */
  private oneBtcTargetBase(): number {
    return Math.round(this.cfg.VAULT_ONE_BTC_TARGET_BTC * 1e8);
  }

  /**
   * Exponential backoff for permissionless cranks.
   *
   * A crank runs off a 5s poll, so any predicate that wrongly says "eligible"
   * becomes a transaction every 5 seconds until someone notices — ~17k failed
   * sends a day, which is both a real SOL burn and the kind of traffic that
   * gets an endpoint rate-limited. The eligibility bug that caused this is
   * fixed, but the blast radius shouldn't depend on the predicate being right:
   * after each failure the same crank waits twice as long, capped at 30 min,
   * and any success clears it.
   */
  private crankBlocked(key: string): boolean {
    const s = this.crankBackoff.get(key);
    return s !== undefined && Date.now() < s.nextAttemptMs;
  }

  private noteCrankOutcome(key: string, ok: boolean): void {
    if (ok) {
      this.crankBackoff.delete(key);
      return;
    }
    const failures = (this.crankBackoff.get(key)?.failures ?? 0) + 1;
    const delay = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(failures, 10));
    this.crankBackoff.set(key, { failures, nextAttemptMs: Date.now() + delay });
    if (failures === 1 || failures % 5 === 0) {
      this.log.warn({ crank: key, failures, retryInMs: delay }, "crank failing — backing off");
    }
  }

  /**
   * Raw hashrate units a single round's deploy can actually be converted into
   * vault tickets — the ceiling on what the hashrate credit may claim.
   *
   * Hashrate is only worth its market price to the extent we can spend it, and
   * spending is bounded by VAULT_MAX_TICKETS per iteration. Spread over an
   * iteration's rounds that is a couple of raw units per round on mainnet,
   * against the ~1,400 a modest deploy earns — so the uncapped credit
   * overstates by roughly two orders of magnitude. Left uncapped it tells the
   * selector to deploy the per-round maximum every round, which at any real
   * size would have us earning several times the entire field's hashrate and
   * collapsing the very price the credit is based on.
   *
   * Returns 0 when vaults are off (hashrate then has no sink at all).
   */
  /**
   * Epoch-vault economics for the deploy-side hashrate credit: how many more
   * tickets we can usefully buy this iteration, and what they are worth EACH on
   * average once our own dilution is priced in.
   *
   * Both halves used to be wrong in the same direction. The quantity was capped
   * by VAULT_MAX_TICKETS — our own risk knob — so the model concluded hashrate
   * was worthless because we had configured ourselves not to spend it, and
   * credited 0.57% of what a deploy actually earns. The price was the marginal
   * ticket at ZERO holdings, which is only the price of the first ticket; buying
   * a block at that price overstates it by ~1.7x at a 25% share, because the
   * per-wallet dedup makes the payoff concave.
   *
   * So: bound the quantity economically (VAULT_MAX_SHARE of the projected final
   * field) and price that block at its AVERAGE value, not its first ticket's.
   */
  /**
   * The epoch prize curve the ticket engine prices against: 21 equal slots
   * under V2 (one wallet can hold at most one), V1's rank curve otherwise.
   * Undefined lets the vault module default to V1.
   */
  private epochCurve(): readonly number[] | undefined {
    return this.cfg.GAME_VERSION === "v2" ? EPOCH_EQUAL_CURVE_BPS : undefined;
  }

  private epochTicketEconomics(): {
    capTickets: number;
    avgTicketUsd: number;
    roundsRemaining: number;
  } | null {
    if (!this.cfg.VAULT_STRATEGY_ENABLED) return null;
    const epoch = this.vaultPoolCache?.epoch;
    if (!epoch?.open || !(epoch.poolUsd > 0)) return null;
    const roundDuration = this.state.board?.round_duration ?? 0;
    const iterationSlots = Number(
      this.state.satrushConfig?.epoch_vault_iteration_duration?.toString() ?? 0,
    );
    if (!(roundDuration > 0) || !(iterationSlots > 0)) return null;

    // Project the field from the last COMPLETE draw, scaled by how this
    // iteration's pool is tracking against that one, with a floor for banked
    // hashrate. Extrapolating the live ticket count linearly — the previous
    // approach — under-projects badly, because buying is back-loaded: at 7%
    // elapsed it gave 475,872 against an actual close of 806,582.
    const slotsToClose = Math.max(0, epoch.slotsToClose);
    const elapsed = Math.max(1, iterationSlots - slotsToClose);
    const progress = Math.min(1, elapsed / iterationSlots);
    // Project the pool from what is banked, net of the carry. A pool is
    // seeded by the previous iteration's 10% rollover, so treating all of the
    // banked amount as this iteration's inflow over-projects the close — worst
    // early in an iteration, when the carry is most of what is there.
    const carry = 0.1 * this.cfg.EPOCH_LAST_CLOSE_POOL_USD;
    const inflowSoFar = Math.max(0, epoch.poolUsd - carry);
    const projectedPool =
      progress > 0.02 ? epoch.poolUsd + ((1 - progress) / progress) * inflowSoFar : epoch.poolUsd;
    const volumeRatio = projectedPool / this.cfg.EPOCH_LAST_CLOSE_POOL_USD;
    const bounds = projectField({
      lastCloseTickets: this.cfg.EPOCH_LAST_CLOSE_TICKETS,
      volumeRatio,
      bankedShare: this.cfg.EPOCH_FIELD_BANKED_SHARE,
    });
    // The HIGH bound is the conservative one for us: a bigger field means a
    // smaller share and a lower price. Never project the field below what is
    // already committed — rivals cannot un-buy their tickets.
    const others = Math.max(0, epoch.totalTickets - epoch.myTickets);
    const projectedField = Math.max(others, bounds.high);

    const share = this.cfg.VAULT_MAX_SHARE;
    const capTickets =
      (share / (1 - share)) * projectedField - epoch.myTickets;
    if (!(capTickets >= 1)) return null;

    const uplift = this.cfg.EPOCH_DEDUP_UPLIFT;
    const at = (mine: number): number =>
      expectedWinningsUsd(mine, projectedField, projectedPool, "epoch", uplift, this.epochCurve());
    const avgTicketUsd = (at(epoch.myTickets + capTickets) - at(epoch.myTickets)) / capTickets;
    if (!(avgTicketUsd > 0)) return null;

    const roundsRemaining = Math.max(1, slotsToClose / roundDuration);
    return { capTickets, avgTicketUsd, roundsRemaining };
  }

  /**
   * Raw hashrate units a single round's deploy can actually be converted into
   * vault tickets — the ceiling on what the hashrate credit may claim.
   *
   * Now an economic bound rather than a configured one: the tickets still
   * available under VAULT_MAX_SHARE of the projected field, spread over the
   * rounds left in the iteration. Returns 0 when vaults are off (hashrate then
   * has no sink at all) or the field is not yet legible.
   */
  /** Strike pool as of the last slot tick — the payout base, sampled before the
   * reveal consumes it. Without this the measurement above has nothing to
   * divide by, because the Board is already drained by the time we see it. */


  /** The automation book: funded Static registrations, refreshed periodically.
   * Empty until the first read, which is why the caller falls back to the
   * statistical prediction rather than treating an empty book as an empty
   * board. */
  private automationBook: AutomationCommitment[] = [];
  private automationBookRound = -1;

  private strikePoolBeforeReveal = 0n;




  private monetisableRawPerRound(): number {
    const e = this.epochTicketEconomics();
    if (!e) return 0;
    return (e.capTickets * this.cfg.VAULT_HASHRATE_PER_TICKET) / e.roundsRemaining;
  }

  /**
   * USD value of ONE sats-vault BTC share, net of the claim fee.
   *
   * The sats vault takes ~12% of every deploy and returns it as BTC shares, not
   * USDC. Settlements record won_shares, but nothing valued them, so both the
   * P&L and the realized-edge metric silently omitted the single largest
   * return leg — enough to make a profitable position read as a heavy loss.
   *
   * Net of vault_exit_fee_bps because that is what the shares are
   * actually worth to us; gross would overstate a position we can only realise
   * by paying the exit fee.
   */
  /**
   * USD value of ONE RUSH-vault share, net of the exit fee — 0 unless the
   * token feed is live, so an unpriced RUSH position never inflates a mark.
   */
  private tokenShareValueUsd(): number {
    const vault = this.state.tokenVault;
    const feed = this.tokenFeed?.status();
    if (!vault || !feed?.live) return 0;
    const shares = Number(vault.token_shares.toString());
    const tokens = Number(vault.token_amount.toString());
    if (!(shares > 0) || !(tokens > 0)) return 0;
    const exitFeeBps = this.state.satrushConfig?.vault_exit_fee_bps ?? 0;
    return (tokens / shares / 1e9) * feed.tokenUsd * (1 - exitFeeBps / 10_000);
  }

  private satsShareValueUsd(): number {
    const vault = this.state.satsVault;
    if (!vault) return 0;
    const shares = Number(vault.btc_shares.toString());
    const btc = Number(vault.btc_amount.toString());
    if (!(shares > 0) || !(btc > 0)) return 0;
    const claimFeeBps = this.state.satrushConfig?.vault_exit_fee_bps ?? 0;
    const net = 1 - claimFeeBps / 10_000;
    return (btc / shares / 1e8) * this.prices.btcUsd() * net;
  }

  /**
   * What one RAW hashrate unit is worth in USD, right now.
   *
   * Hashrate has exactly one sink: vault tickets. So its marginal value is the
   * best marginal ticket EV currently on offer, divided by the raw units a
   * ticket costs. Deriving it live instead of reading a constant is what makes
   * the deploy-side hashrate credit work at all — HASHRATE_VALUE_USD defaults
   * to 0, so every deploy has been priced as though the hashrate it earns were
   * worthless.
   *
   * Only value we could actually ACT on counts, which is stricter than "open":
   *
   * - The epoch vault resolves on a fixed ~3-day cadence and has paid out every
   *   iteration, so its marginal ticket EV is realisable value.
   * - The 1-BTC vault only draws when it fills to 1 BTC. It DOES settle — it is
   *   on iteration 2, with 0 and 1 already drawn and rent-reclaimed, cycling
   *   roughly every 6 days at measured volume (an earlier note here claimed it
   *   had never settled; that was stale). But tickets accrue the whole way, so
   *   its headline per-ticket EV still prices a claim that pays only at fill,
   *   against a field that keeps growing. It is counted only once it is near
   *   enough to trigger that we would genuinely enter it, which is exactly the
   *   VAULT_ONE_BTC_MIN_FILL_BPS gate the entry path uses.
   *
   * Taking the max over everything open would price hashrate off the vault that
   * pays least often, and this figure credits every deploy — overstating it
   * makes the bot over-deploy on a promise it cannot collect.
   *
   * An explicitly configured HASHRATE_VALUE_USD wins, so the operator can
   * always override the derivation; 0 (the default) means "derive it".
   */
  private hashrateValueUsdPerRawUnit(): number {
    if (this.cfg.HASHRATE_VALUE_USD > 0) return this.cfg.HASHRATE_VALUE_USD;
    if (!this.cfg.VAULT_STRATEGY_ENABLED) return 0;
    const pools = this.vaultPoolCache;
    if (!pools) return 0;
    // Epoch is priced at the AVERAGE value of the block we could actually buy,
    // not at the first ticket's marginal value — the payoff is concave in our
    // share, so the at-zero price is not the price of a block.
    const epochEv = this.epochTicketEconomics()?.avgTicketUsd ?? 0;
    const oneBtcEv =
      pools.oneBtc?.open && pools.oneBtc.fillBps >= this.cfg.VAULT_ONE_BTC_MIN_FILL_BPS
        ? pools.oneBtc.ticketEvUsd
        : 0;
    const perTicket = Math.max(epochEv, oneBtcEv);
    if (!(perTicket > 0)) return 0;
    return perTicket / this.cfg.VAULT_HASHRATE_PER_TICKET;
  }

  /**
   * Current post-Sat-Strike hashrate promo multiplier (1 outside the window).
   *
   * The program's rule (SDK `STRIKE_BOOST_ROUNDS` = 240): `rotate_round` stamps
   * `Round.is_hashrate_boosted` for the 240 rounds after a strike, and settle
   * applies `STRIKE_BOOST_HASHRATE_MULTIPLIER` (2). Measured in ROUNDS off the
   * board's persistent strike_last_trigger_round_id, so the window survives a
   * restart; the observed-event clock (STRIKE_BONUS_WINDOW_MINUTES) is only the
   * fallback before the board is read. The old minutes-to-rounds conversion
   * gave 156 rounds at a 92 s round — a third of the window under-credited.
   */
  private strikeBonusMultiplier(): number {
    const board = this.state.board;
    let roundsSinceStrike: number | null = null;
    let windowRounds: number | null = null;
    let windowMs = this.cfg.STRIKE_BONUS_WINDOW_MINUTES * 60_000;
    if (board) {
      const lastTrigger = board.strike_last_trigger_round_id;
      const duration = board.round_duration;
      if (lastTrigger > 0 && duration > 0) {
        roundsSinceStrike = board.round_id - lastTrigger;
        windowRounds = STRIKE_BOOST_WINDOW_ROUNDS.value;
        windowMs = windowRounds * duration * SLOT_SECONDS * 1000;
      }
    }
    return strikeBonusMultiplier({
      lastStrikeAtMs: this.lastStrikeAtMs,
      nowMs: Date.now(),
      windowMs,
      multiplier: this.cfg.STRIKE_HASHRATE_MULTIPLIER,
      roundsSinceStrike,
      windowRounds,
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
    // Not the whole pool reaches the winning tile: a reserve is retained at
    // trigger (see STRIKE_PAYOUT_FRACTION). Crediting the full pool overstates
    // the jackpot leg of every round's EV.
    let poolBase = Number(this.state.strikePoolUsd());
    if (this.cfg.GAME_VERSION === "v2" && this.state.board) {
      // V2 strike pool carries USD + BTC + RUSH legs; value the other two at
      // the live prices (the RUSH leg at 0 while the token feed is not live).
      const b = this.state.board;
      const btcUsd = (Number(b.strike_btc_amount.toString()) / 1e8) * this.prices.btcUsd();
      const feed = this.tokenFeed?.status();
      const rushUsd = feed?.live
        ? (Number(b.strike_token_amount.toString()) / 1e9) * feed.tokenUsd
        : 0;
      poolBase += (btcUsd + rushUsd) * 1e6;
    }
    return (poolBase * this.cfg.STRIKE_PAYOUT_FRACTION) / modulus;
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
    // Pull landed AND missed from the SAME window: misses are censored latency
    // observations, and dropping them is the survivorship bias that let the
    // offset sit too aggressive while missing rounds.
    const rows = this.db.query<{ status: string; lat: number | null }>(
      `SELECT status, (landed_slot - fired_slot) AS lat FROM my_deploys
       WHERE fired_slot IS NOT NULL AND status IN ('landed','missed','failed')
       ORDER BY id DESC LIMIT 200`,
    );
    const latencies = rows
      .filter((r) => r.status === "landed" && r.lat !== null)
      .map((r) => r.lat as number);
    const missCount = rows.length - latencies.length;
    const next = adaptiveFireOffset(latencies, {
      missCount,
      targetLandProb: this.cfg.FIRE_OFFSET_TARGET_LAND_PROB,
      cushionSlots: this.cfg.FIRE_OFFSET_CUSHION_SLOTS,
      floor: this.cfg.FIRE_OFFSET_FLOOR,
      ceiling: this.cfg.FIRE_OFFSET_CEILING,
      fallback: this.cfg.FIRE_OFFSET_SLOTS,
      minSamples: this.cfg.FIRE_OFFSET_MIN_SAMPLES,
    });
    if (next !== this.adaptiveOffsetSlots) {
      this.log.info(
        {
          fireOffset: next,
          prev: this.adaptiveOffsetSlots,
          landed: latencies.length,
          missed: missCount,
          missRate: rows.length > 0 ? Number((missCount / rows.length).toFixed(3)) : 0,
        },
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
    // Sample the strike pool before any reveal can drain it — this is the
    // denominator for the payout-fraction measurement in onRevealed().
    const pool = this.state.strikePoolUsd();
    if (pool > 0n) this.strikePoolBeforeReveal = pool;
    void this.refreshAutomationBook();
    if (this.botState === "BOOT") this.transition("SYNCED");
    const board = this.state.board;
    if (!board) return;

    // Round rotation: a new Active round re-opens the machine.
    if (board.round_id !== this.roundId) {
      const round = this.state.round(board.round_id);
      if (!round || "Active" in round.state) this.enterRound(board.round_id);
      return;
    }

    // Keep the pre-signed candidates warm off the SLOT tick, not just off
    // occupancy updates. On a quiet round — the field commits at open and
    // nothing moves after — no occupancy update ever arrives, so the candidate
    // built at round open is the one we fire 150 slots later. That is exactly
    // the Solana blockhash lifetime, which is how a hot candidate turns into
    // blockhash_expired at the moment it matters.
    if (
      (this.botState === "ROUND_OPEN" || this.botState === "ARMED") &&
      this.candidates.needsBlockhashRefresh()
    ) {
      void this.refreshCandidates("blockhash_aging");
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
    // Lagging-but-alive stream. stale() only catches SILENCE; a stream still
    // delivering on time from N slots behind head passes it. slotsToCutoff() is
    // derived from that lagged slot, so we would believe the round has N more
    // slots of life and fire into a closed one — paying the priority fee for a
    // 6005, off a board we are mispricing. Fails open on a missing/old
    // measurement: that means the reference RPC is unreachable, which stale()
    // already covers, and failing closed would park the bot indefinitely.
    //
    // The tolerance is tied to the FIRE OFFSET, not to a fixed constant. We
    // fire `offset` slots before the cutoff, so any lag at or above the offset
    // means the round is already over by the time we believe we are early —
    // a flat threshold wider than the offset (the config value) would wave
    // through exactly the lag that guarantees a miss.
    const lag = this.health.lastSlotLag();
    const lagBudget = Math.min(
      this.cfg.MAX_SNAPSHOT_LAG_SLOTS,
      Math.max(1, this.currentFireOffset() - 1),
    );
    if (
      lag !== null &&
      Date.now() - lag.atMs <= this.cfg.SNAPSHOT_LAG_MAX_AGE_MS &&
      lag.lagSlots > lagBudget
    ) {
      this.skipOnce("snapshot_lagging", {
        lagSlots: lag.lagSlots,
        budget: lagBudget,
        fireOffset: this.currentFireOffset(),
        measuredAgeMs: Date.now() - lag.atMs,
      });
      return;
    }
    if (this.paused) {
      this.skipOnce("paused", {});
      return;
    }
    const candidate = this.candidates.best(this.roundId);
    if (!candidate) {
      this.skipOnce("no_candidate", {
        note: "selector found no deployable allocation",
        selector: this.candidates.lastSkipReason(this.roundId) ?? "unknown",
        ...this.evDiagnostics(),
      });
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
        lossFractionAtRisk: this.bankroll.lossFractionAtRisk,
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
    // One row per leg: the fleet's deploys are separate transactions with
    // separate outcomes, and per-wallet attribution is what the streak and
    // P&L reconstruction key on. Σ leg amounts == the authorized total.
    const legTotal = candidate.legs.reduce((a, l) => a + l.amountGross, 0n);
    if (legTotal !== selection.totalGross) {
      this.haltFromError(
        new HaltError("candidate legs do not sum to the authorized amount", {
          legs: legTotal.toString(),
          authorized: selection.totalGross.toString(),
        }),
        "pre-send invariant",
      );
      this.transition("LOGGED", { haltedBeforeSend: true });
      return;
    }
    for (const leg of candidate.legs) {
      const legMiner = this.state.minerAt(minerPda(new PublicKey(leg.wallet), new PublicKey(this.cfg.PROGRAM_ID)));
      this.db.recordMyDeploy({
        roundId: this.roundId,
        mask: selection.mask,
        amount: leg.amountGross,
        evExpected: selection.ev * (Number(leg.amountGross) / Number(selection.totalGross)),
        firedSlot: this.state.currentSlot,
        sig: leg.signature,
        status: this.cfg.EXECUTION_MODE === "dry" ? "dry" : "fired",
        streak: legMiner?.current_streak_count ?? null,
        wallet: leg.wallet,
      });
    }
    this.transition("FIRED", {
      mask: selection.mask,
      tiles: selection.tiles,
      amount: selection.totalGross.toString(),
      legs: candidate.legs.length,
      ev: selection.ev,
      fee: candidate.feeMicroLamports,
      cutoff: this.state.slotsToCutoff(),
      dry: this.cfg.EXECUTION_MODE === "dry",
    });

    const isPastCutoff = () => (this.state.slotsToCutoff() ?? 1) <= -10;
    const firePromise = Promise.all(
      candidate.legs.map((leg) =>
        this.sender.fire(
          {
            signature: leg.signature,
            serialized: leg.serialized,
            lastValidBlockHeight: leg.lastValidBlockHeight,
            meta: { roundId: this.roundId, mask: selection.mask, wallet: leg.wallet },
          },
          { isPastCutoff },
        ),
      ),
    );
    this.transition("CONFIRMING");
    const roundAtFire = this.roundId;
    const results = await firePromise;
    // Per-leg statuses; the round's outcome is the best leg's (one landed
    // deploy keeps the streak and the settle path alive), with every
    // non-landed leg reported.
    results.forEach((r, i) => {
      const leg = candidate.legs[i]!;
      if (r.outcome === "landed") this.db.updateMyDeployStatus(leg.signature, "landed", r.landedSlot);
      else if (r.outcome === "missed_round") this.db.updateMyDeployStatus(leg.signature, "missed");
      else if (r.outcome !== "dry") this.db.updateMyDeployStatus(leg.signature, "failed");
    });
    const landedLegs = results.filter((r) => r.outcome === "landed");
    if (candidate.legs.length > 1 && landedLegs.length !== results.length) {
      this.alert(
        `fleet round ${roundAtFire}: ${landedLegs.length}/${results.length} legs landed (${results
          .map((r, i) => `${candidate.legs[i]!.wallet.slice(0, 6)}:${r.outcome}`)
          .join(" ")})`,
      );
    }
    const result =
      landedLegs[0] ??
      results.find((r) => r.outcome === "dry") ??
      results.find((r) => r.outcome === "missed_round") ??
      results[0]!;

    // If the board rotated while confirming, update the DB but leave the
    // new round's state machine alone.
    if (this.roundId !== roundAtFire) {
      this.pnl.refreshDaily(); // leg statuses were written above
      return;
    }

    if (result.outcome === "landed") {
      this.transition("SETTLING", { landedSlot: result.landedSlot, legs: landedLegs.length });
    } else if (result.outcome === "dry") {
      this.transition("SETTLING", { dry: true });
    } else if (result.outcome === "missed_round") {
      this.alert(`missed round ${this.roundId}: ${result.detail ?? ""} — standing down`);
      this.transition("LOGGED", { missed: true });
    } else {
      this.alert(`deploy ${result.outcome} on round ${this.roundId}: ${result.detail ?? ""}`);
      this.transition("LOGGED", { failed: true });
    }
    this.pnl.refreshDaily();
  }

  // ── settle + sweep ──────────────────────────────────────────────────────────

  private async selfSettle(roundId: number): Promise<void> {
    if (!this.cfg.SELF_SETTLE || this.cfg.EXECUTION_MODE === "dry") return;
    if (this.settleFired.has(roundId)) return;
    const landed = this.db.landedWallets(roundId);
    if (landed.length === 0) return;
    this.settleFired.add(roundId);
    // One settle per landed wallet; the primary cranks and pays for all of
    // them (settle is permissionless), so the extras never need SOL for it.
    const programId = new PublicKey(this.cfg.PROGRAM_ID);
    for (const w of landed) {
      const deployer = w ? new PublicKey(w) : this.payer.publicKey;
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
          deploymentAuthority: deployer,
          roundId,
          // V2: the affiliate leg settles to that wallet's Miner.affiliate (default → none).
          affiliate: this.state.minerAt(minerPda(deployer, programId))?.affiliate,
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
            meta: { kind: "self_settle", roundId, wallet: deployer.toBase58() },
          },
          { timeoutMs: 15_000 },
        );
        this.log.info({ roundId, wallet: deployer.toBase58(), outcome: result.outcome }, "self-settle resolved");
      } catch (err) {
        this.log.warn({ roundId, wallet: deployer.toBase58(), err: String(err) }, "self-settle failed (crank will cover)");
      }
    }
  }

  /** True for any signer of the fleet (the primary included). */
  private isOurWallet(authority: PublicKey): boolean {
    return this.wallets.byPubkey(authority.toBase58()) !== undefined;
  }

  /** Keypair for a fleet wallet by public key (the primary when unknown/null). */
  private signerFor(wallet: string | null | undefined): Keypair {
    return (wallet ? this.wallets.byPubkey(wallet)?.keypair : undefined) ?? this.payer;
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
    if (this.cfg.GAME_VERSION === "v2") {
      this.reconcileSettlementV2(data, round);
      return;
    }
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
   * V2 tripwire: the refund rule is exact per deployment, so this checks the
   * USD leg against 89% of our losing-tile gross, BTC shares only on a covered
   * winner, and a RUSH leg on every minting round. Needs our deploy row for
   * the gross and mask; without one there is nothing to check against.
   */
  private reconcileSettlementV2(data: PublicDeploySettled, round: Round): void {
    const wallet = data.authority.toBase58();
    const mine = this.db.queryOne<{ amount: string; mask: number }>(
      `SELECT amount, mask FROM my_deploys
       WHERE round_id = ? AND status IN ('fired','landed') AND (wallet = ? OR wallet IS NULL)
       ORDER BY id DESC LIMIT 1`,
      data.round_id,
      wallet,
    );
    if (!mine) {
      this.log.warn({ roundId: data.round_id }, "settled a round with no deploy row — reconcile skipped");
      return;
    }
    const tiles = maskToTiles(mine.mask);
    const winner = round.winning_tile;
    const res = reconcileRoundOutcomeV2({
      ourGrossBase: BigInt(mine.amount),
      tilesCovered: tiles.length,
      coveredWinner: winner !== null && tiles.includes(winner),
      refundBps: V2_LOSING_TILE_REFUND_BPS.value,
      realizedWonUsdBase: BigInt(data.won_usd_amount.toString()),
      realizedWonShares: BigInt(data.won_shares_amount.toString()),
      realizedWonTokenShares: BigInt(data.won_token_shares.toString()),
      roundMintedToken: BigInt(round.minted_token_amount.toString()) > 0n,
      strikeTriggered: BigInt(round.strike_bonus_usd.toString()) > 0n,
      toleranceFrac: this.cfg.RECONCILE_TOLERANCE,
      floorBase: usdToBase(0.01),
    });
    if (!res.ok) {
      this.engageKillSwitch(
        `reconcile tripwire (V2) round ${data.round_id}: ${res.reason} ` +
          `(modeled $${(Number(res.modeledUsdBase) / 1e6).toFixed(4)} vs realized $${(Number(data.won_usd_amount.toString()) / 1e6).toFixed(4)})`,
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
    const btcUsd = () => this.prices.btcUsd();
    const btcDecimals = 8; // cbBTC-style; devnet + mainnet BTC mints are 8dp (FINDINGS E6)
    const iterationDurationSlots = Number(
      this.state.satrushConfig!.epoch_vault_iteration_duration.toString(),
    );
    const oneBtcTargetBase = Math.round(
      this.cfg.VAULT_ONE_BTC_TARGET_BTC * 10 ** btcDecimals,
    );
    const num = (v: { toString(): string }) => Number(v.toString());

    // One engine per wallet: hashrate lives in each wallet's own Miner PDA and
    // cannot be pooled, so each wallet buys its own tickets with its own
    // balance (and signs its own buys). VAULT_MAX_TICKETS applies per wallet
    // — it bounds one Miner's exposure, which is what the cap was sized for.
    const engines = this.wallets.all().map((w) => {
      const key = w.keypair.publicKey.toBase58();
      return new VaultEngine({
        enabled: true, // gate is the manager itself (only started when enabled)
        dry: this.cfg.EXECUTION_MODE === "dry",
        hashrateValueUsd: this.cfg.HASHRATE_VALUE_USD,
        epochDedupUplift: this.cfg.EPOCH_DEDUP_UPLIFT,
        epochCurve: this.epochCurve(),
        ticketPriceHashrate: this.cfg.VAULT_HASHRATE_PER_TICKET,
        maxTickets: this.cfg.VAULT_MAX_TICKETS,
        hashrateFraction: this.cfg.VAULT_HASHRATE_FRACTION,
        hashrateAvailable: () => this.vaultHashrateCache.get(key) ?? 0,
        myTickets: (kind, iter) => {
          if (kind === "epoch") {
            const e = this.vaultEpochEntryCache.get(key);
            return e && e.iter === iter ? e.tickets : 0;
          }
          return this.db.vaultTicketsHeld("one_btc", iter, this.wallets.size > 1 ? key : null);
        },
        buy: (kind, iter, tickets) => this.buyVaultTickets(kind, iter, tickets, w),
        log: (obj) => this.log.info({ ...obj, wallet: key.slice(0, 6) }, "vault"),
      });
    });

    const readState = async (): Promise<VaultReadState> => {
      const slot = await this.connection.getSlot("processed");
      // Hashrate per wallet from the streamed Miner accounts (no RPC round
      // trip); a wallet with no Miner yet has none to spend.
      for (const w of this.wallets.all()) {
        const key = w.keypair.publicKey.toBase58();
        const miner = this.minerOf(w);
        this.vaultHashrateCache.set(key, miner ? num(miner.hashrate_amount) : 0);
        w.hashrate = this.vaultHashrateCache.get(key) ?? 0;
        w.streak = miner?.current_streak_count ?? w.streak;
      }

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
          const entryKeys = this.wallets
            .pubkeys()
            .map((w) => epochVaultEntryPda(ev.iteration_id, w, programId));
          const entryInfos = await this.connection.getMultipleAccountsInfo(entryKeys, "processed");
          this.wallets.all().forEach((w, i) => {
            const info = entryInfos[i];
            const tickets = info
              ? num(decodeAccount<EpochVaultEntry>("EpochVaultEntry", info.data).tickets)
              : 0;
            this.vaultEpochEntryCache.set(w.keypair.publicKey.toBase58(), { iter: ev.iteration_id, tickets });
            w.tickets = tickets;
          });
          epoch = {
            iterationId: ev.iteration_id,
            open: "Open" in it.state,
            totalTickets: num(it.total_tickets),
            poolValueUsd:
              num(ev.pool_usd_amount) / 1e6 +
              btcBaseToUsd(num(ev.pool_btc_amount), btcDecimals, btcUsd()),
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
          // The prize is the ACCRUED balance, less anything already escrowed for
          // a prior winner who hasn't claimed. reserved_btc_amount alone is that
          // escrow — 0 while a round accumulates — so using it as the prize made
          // ticket EV identically 0 and the bot never entered this vault at all.
          const prizeBtc = Math.max(0, num(obv.btc_amount) - num(obv.reserved_btc_amount));
          oneBtc = {
            iterationId: obv.iteration_id,
            open: "Open" in it.state,
            totalTickets: num(it.total_tickets),
            poolValueUsd: btcBaseToUsd(prizeBtc, btcDecimals, btcUsd()),
            prizeBtc,
            targetBtc: oneBtcTargetBase,
          };
        }
      }
      // Cache the live pool state for monitoring. These accounts are only read
      // here, so without this the dashboard can't show pool size, field size, or
      // what a ticket is currently worth — the numbers that decide entry.
      // Fleet-wide tickets in the current iteration (the dashboard's view).
      const myEpoch = epoch
        ? [...this.vaultEpochEntryCache.values()].reduce(
            (a, e) => a + (e.iter === epoch.iterationId ? e.tickets : 0),
            0,
          )
        : 0;
      const ticketEv = (
        kind: "epoch" | "one_btc",
        pool: number,
        total: number,
        mine: number,
      ): number => {
        const others = Math.max(0, total - mine);
        const up = this.cfg.EPOCH_DEDUP_UPLIFT;
        const curve = this.epochCurve();
        return (
          expectedWinningsUsd(mine + 1, others, pool, kind, up, curve) -
          expectedWinningsUsd(mine, others, pool, kind, up, curve)
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
          fillBps: oneBtcFillBps(oneBtc.prizeBtc, oneBtc.targetBtc),
          ticketEvUsd: ticketEv("one_btc", oneBtc.poolValueUsd, oneBtc.totalTickets, 0),
        },
      };
      return { slot, epoch, oneBtc };
    };

    this.vaultManager = new VaultManager({
      engines,
      readState,
      epochCurve: this.epochCurve(),
      epochLateSlots: this.cfg.VAULT_EPOCH_LATE_SLOTS,
      epochLateFraction: this.cfg.VAULT_EPOCH_LATE_FRACTION,
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
    signer: Keypair = this.payer,
  ): Promise<string> {
    const { tx, lastValidBlockHeight } = await assembleTx(this.connection, {
      payer: signer,
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
  private async ataBalanceBase(mint: PublicKey, owner: PublicKey = this.payer.publicKey): Promise<bigint> {
    try {
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const ata = getAssociatedTokenAddressSync(mint, owner);
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
    /** Wallet the proceeds land on (the 1-BTC ticket's owner); primary by default. */
    recipient: PublicKey = this.payer.publicKey,
  ): Promise<string> {
    const usdBefore = await this.ataBalanceBase(this.ixCtx.usdMint, recipient);
    const btcBefore = await this.ataBalanceBase(this.ixCtx.btcMint, recipient);
    const outcome = await this.sendVaultIx(ix, meta);
    if (outcome !== "landed") return outcome;
    try {
      const usdBase = (await this.ataBalanceBase(this.ixCtx.usdMint, recipient)) - usdBefore;
      const btcBase = (await this.ataBalanceBase(this.ixCtx.btcMint, recipient)) - btcBefore;
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
    const winningWallets = this.wallets.pubkeys().filter((w) => epochWinIndex(it.winners, w) >= 0);
    const weWon = winningWallets.length > 0;
    const action = epochAction({
      state: stateName,
      windowElapsed,
      winnersSelected: it.winners_selected,
      winnersTarget: Math.min(21, it.participants_count),
      weWon,
      selfCrank,
    });

    if (action === "trigger") {
      const key = `epoch_trigger:${iterationId}`;
      if (this.crankBlocked(key)) return;
      const outcome = await this.sendVaultIx(
        buildTriggerEpochDraw(this.ixCtx, { authority: this.payer.publicKey, iterationId }),
        { kind: "vault_epoch_trigger", iterationId },
      );
      this.noteCrankOutcome(key, outcome === "landed");
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
        const key = `epoch_select:${iterationId}`;
        if (this.crankBlocked(key)) return;
        const outcome = await this.sendVaultIx(
          buildSelectEpochWinner(this.ixCtx, { authority: this.payer.publicKey, iterationId, pageIndex }),
          { kind: "vault_epoch_select", iterationId, pageIndex },
        );
        this.noteCrankOutcome(key, outcome === "landed");
      }
    } else if (action === "claim") {
      // V2: permissionless distribute_epoch_reward(rank) credits our Miner
      // (USD → claim_usd pool, BTC → sats-vault shares, RUSH → token vault).
      // Nothing reaches the wallet ATAs, so this is a plain crank send; the
      // Miner-side accounting is picked up by the claim path.
      // Equal prizes cap a wallet at one slot; a fleet can hold several.
      let allLanded = true;
      for (const winner of winningWallets) {
        const rank = epochWinIndex(it.winners, winner);
        const outcome = await this.sendVaultIx(
          buildDistributeEpochReward(this.ixCtx, {
            authority: this.payer.publicKey,
            iterationId,
            rank,
            winnerAuthority: winner,
          }),
          { kind: "vault_epoch_distribute", iterationId, rank, wallet: winner.toBase58() },
        );
        if (outcome === "landed") {
          this.alert(`🏆 vault WIN — distributed epoch iteration ${iterationId} (rank ${rank}) to ${winner.toBase58().slice(0, 6)}…`);
        } else {
          allLanded = false;
        }
      }
      if (allLanded) this.db.markVaultClaimed("epoch", iterationId);
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
    // The draw is eligible only once the vault has ACCRUED the 1 BTC trigger.
    // This used to compare btc_amount against reserved_btc_amount — the
    // unclaimed-prize escrow, which is 0 while a round accumulates — so it read
    // as permanently triggerable and cranked a doomed trigger every poll tick.
    const prizeBtc = v
      ? Math.max(0, Number(v.btc_amount.toString()) - Number(v.reserved_btc_amount.toString()))
      : 0;
    const triggerable =
      v !== null &&
      v.iteration_id === iterationId &&
      prizeBtc >= this.oneBtcTargetBase();

    let weWon = false;
    let winningTicketAcct: PublicKey | null = null;
    let winningWallet: PublicKey = this.payer.publicKey;
    if (stateName !== "Open") {
      const winningTicket = BigInt(it.winning_ticket.toString());
      for (const { ticketPubkey, wallet } of this.db.oneBtcTickets(iterationId)) {
        const info = await this.connection.getAccountInfo(new PublicKey(ticketPubkey), "processed");
        if (!info) continue;
        const e = decodeAccount<OneBtcVaultEntry>("OneBtcVaultEntry", info.data);
        const start = BigInt(e.start_ticket_id.toString());
        const count = BigInt(e.tickets_count.toString());
        if (winningTicket >= start && winningTicket < start + count) {
          weWon = true;
          winningTicketAcct = new PublicKey(ticketPubkey);
          // The prize goes to the ticket's owner whoever cranks; the entry
          // account is the source of truth, the DB's wallet is the hint.
          winningWallet = wallet ? new PublicKey(wallet) : e.authority;
          break;
        }
      }
    }
    const action = oneBtcAction({ state: stateName, triggerable, weWon, selfCrank });

    if (action === "trigger") {
      const key = `one_btc_trigger:${iterationId}`;
      if (this.crankBlocked(key)) return;
      const outcome = await this.sendVaultIx(
        buildTriggerOneBtcDraw(this.ixCtx, { authority: this.payer.publicKey, iterationId }),
        { kind: "vault_one_btc_trigger", iterationId },
      );
      this.noteCrankOutcome(key, outcome === "landed");
    } else if (action === "claim" && winningTicketAcct) {
      const outcome = await this.sendVaultClaim(
        "one_btc",
        iterationId,
        buildClaimOneBtcReward(this.ixCtx, {
          authority: this.payer.publicKey,
          iterationId,
          ticket: winningTicketAcct,
          winner: winningWallet,
        }),
        { kind: "vault_one_btc_claim", iterationId, wallet: winningWallet.toBase58() },
        winningWallet,
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
    /** The buying wallet — tickets are paid with ITS hashrate and it signs. */
    buyer: WalletState = this.wallets.primary(),
  ): Promise<string> {
    const fee = this.feeEstimator.currentMicroLamportsPerCu();
    const signer = buyer.keypair;
    let ticketPubkey: string | null = null;
    let extraSigner: Keypair | null = null;
    let ix;
    if (kind === "one_btc") {
      const ticket = Keypair.generate();
      extraSigner = ticket;
      ticketPubkey = ticket.publicKey.toBase58();
      ix = buildBuyOneBtcTickets(this.ixCtx, {
        authority: signer.publicKey,
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
        authority: signer.publicKey,
        iterationId,
        pageIndex,
        ticketsToBuy: BigInt(tickets),
      });
    }

    const { tx, lastValidBlockHeight } = await assembleTx(this.connection, {
      payer: signer,
      instructions: [ix],
      computeUnitLimit: this.cfg.DEPLOY_CU_LIMIT,
      priorityFeeMicroLamports: fee,
    });
    if (extraSigner) tx.sign([extraSigner]);
    const signature = bs58.encode(tx.signatures[0]!);
    const wallet = signer.publicKey.toBase58();
    const result = await this.sender.fire(
      {
        signature,
        serialized: Buffer.from(tx.serialize()),
        lastValidBlockHeight,
        meta: { kind: `vault_${kind}`, iterationId, tickets, wallet },
      },
      { timeoutMs: 15_000 },
    );
    if (result.outcome === "landed" || result.outcome === "dry") {
      this.db.recordVaultTicket({ kind, iterationId, tickets, ticketPubkey, wallet, sig: signature });
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
      // Claims are authority-signed, so each wallet sweeps its own Miner.
      for (const w of this.wallets.all()) {
        await this.claimUsdCompound(w); // fee-free — the compound loop
        await this.claimSatsSweep(w); // fee-bearing (10% claim fee) — opt-in
      }
      await this.exchangeAffiliatePoints(); // the primary's rebate → grubstake USD
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * V2: the affiliate rebate the extras earn accrues as points on the
   * primary's Affiliate account; exchanging converts them into grubstake USD
   * on the primary's Miner, which `grubstakeFor` then deploys. Read by RPC on
   * the sweep cadence (the Affiliate PDA is not streamed).
   */
  private async exchangeAffiliatePoints(): Promise<void> {
    if (!this.cfg.AFFILIATE_EXCHANGE_ENABLED) return;
    const programId = new PublicKey(this.cfg.PROGRAM_ID);
    const authority = this.payer.publicKey;
    let points = 0n;
    try {
      const info = await this.connection.getAccountInfo(affiliatePda(authority, programId), "processed");
      if (!info) return; // no tag registered — nothing accrues
      points = BigInt(decodeAccount<Affiliate>("Affiliate", info.data).point_amount.toString());
    } catch {
      return;
    }
    if (points <= 0n) return;
    const outcome = await this.fireClaim(
      buildExchangeAffiliatePoints(this.ixCtx, { authority, pointsAmount: points }),
      { kind: "exchange_affiliate_points", points: points.toString() },
    );
    this.log.info({ points: points.toString(), outcome }, "affiliate points exchanged into grubstake");
  }

  /** A fleet wallet's Miner from the streamed state (null before its first deploy). */
  private minerOf(w: WalletState): Miner | null {
    return this.state.minerAt(minerPda(w.keypair.publicKey, new PublicKey(this.cfg.PROGRAM_ID)));
  }

  /** Send a single claim instruction through the race sender (shared plumbing). */
  private async fireClaim(
    ix: TransactionInstruction,
    meta: Record<string, unknown>,
    signer: Keypair = this.payer,
  ): Promise<string> {
    const fee = this.feeEstimator.currentMicroLamportsPerCu();
    assertFeeBearingInvariants({
      kind: "claim",
      priorityFeeMicroLamports: fee,
      maxPriorityFeeMicroLamports: this.cfg.PRIORITY_FEE_MAX_MICROLAMPORTS,
      killSwitchEngaged: this.bankroll.killSwitchEngaged(),
    });
    const { tx, lastValidBlockHeight } = await assembleTx(this.connection, {
      payer: signer,
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
  private async claimUsdCompound(w: WalletState): Promise<void> {
    if (!this.cfg.CLAIM_USD_ENABLED) return;
    const miner = this.minerOf(w);
    if (!miner) return;
    const authority = w.keypair.publicKey;
    const amount = BigInt(miner.unclaimed_usd_amount.toString());
    if (amount <= usdToBase(this.cfg.MAX_UNCLAIMED_USD_VALUE)) return;
    const outcome = await this.fireClaim(
      buildClaimUsd(this.ixCtx, { authority, amount }),
      { kind: "claim_usd", amount: amount.toString(), wallet: authority.toBase58() },
      w.keypair,
    );
    this.log.info({ amount: amount.toString(), wallet: authority.toBase58(), outcome }, "usd compound claim resolved");
    if (outcome === "landed") {
      this.alert(`compounded $${(Number(amount) / 1e6).toFixed(2)} USDC back to wallet ${authority.toBase58().slice(0, 6)}…`);
    }
  }

  /**
   * BTC-share sweep: redeem a fraction of unclaimed vault shares to BTC. This
   * pays the sats_vault_claim fee (~10%), so it's gated OFF by default — enable
   * only when realizing BTC is worth the fee vs holding the shares as exposure.
   */
  private async claimSatsSweep(w: WalletState): Promise<void> {
    const miner = this.minerOf(w);
    const vault = this.state.satsVault;
    if (!miner || !vault) return;
    const authority = w.keypair.publicKey;
    const value = this.pnl.unclaimedValue({
      miner,
      satsVault: vault,
      btcUsdPrice: this.prices.btcUsd(),
      btcDecimals: 8, // cbBTC-style; read from mint before mainnet
      tokenVault: this.state.tokenVault,
      tokenUsdPrice: this.tokenShareValueUsd() > 0 ? (this.tokenFeed?.status().tokenUsd ?? 0) : 0,
    });
    const sharesUsd = value.btcUsd; // BTC-share value only — claim_sats redeems these
    if (sharesUsd <= usdToBase(this.cfg.MAX_UNCLAIMED_USD_VALUE)) return;
    if (!this.cfg.SWEEP_ENABLED) {
      this.skipOnce("sweep_disabled", { unclaimedSharesUsd: sharesUsd.toString() });
      return;
    }
    const shares =
      (value.shares * BigInt(Math.round(this.cfg.CLAIM_FRACTION * 10_000))) / 10_000n;
    if (shares <= 0n) return;
    const outcome = await this.fireClaim(
      buildClaimSats(this.ixCtx, { authority, shares }),
      { kind: "claim_sats", shares: shares.toString(), wallet: authority.toBase58() },
      w.keypair,
    );
    this.log.info({ shares: shares.toString(), wallet: authority.toBase58(), outcome }, "sats sweep resolved");
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
      // MEASURE the payout fraction instead of trusting a constant. It has been
      // claimed as 0.9333 (this repo's old default, unsourced), 1.0 (the
      // project's EV reference) and 0.70 (the operator) — and the Board exposes
      // no payable/retained split, only one pool. But the pool we sampled just
      // before the reveal and the bonus the event reports are both exact, so a
      // single observed Strike settles it. One line in the log per Strike; the
      // constant should be replaced by this the first time it is seen.
      const poolBefore = Number(this.strikePoolBeforeReveal) / 1e6;
      const paid = Number(reveal.strike_bonus_usd.toString()) / 1e6;
      if (poolBefore > 0 && paid > 0) {
        this.log.warn(
          {
            roundId: reveal.round_id,
            poolBeforeUsd: poolBefore.toFixed(2),
            paidUsd: paid.toFixed(2),
            measuredFraction: (paid / poolBefore).toFixed(4),
            configuredFraction: this.cfg.STRIKE_PAYOUT_FRACTION,
          },
          "STRIKE PAYOUT FRACTION MEASURED — update STRIKE_PAYOUT_FRACTION",
        );
      }
      this.alert(
        `⚡ Sat Strike round ${reveal.round_id} — paid $${paid.toFixed(2)} of a ` +
          `$${poolBefore.toFixed(2)} pool (${(poolBefore > 0 ? paid / poolBefore : 0).toFixed(3)}× ` +
          `vs ${this.cfg.STRIKE_PAYOUT_FRACTION} configured) · ` +
          `${this.cfg.STRIKE_HASHRATE_MULTIPLIER}× hashrate for ${STRIKE_BOOST_WINDOW_ROUNDS.value} rounds`,
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
        if (applied.kind === "Miner" || applied.kind === "SatsVault" || applied.kind === "TokenVault") {
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
          this.noteDeployer(data.round_id, data.authority.toBase58());
          if (this.isOurWallet(data.authority)) {
            this.db.markDeployLandedByRound(data.round_id, event.slot, data.authority.toBase58());
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
          if (this.isOurWallet(data.authority)) {
            // Atomic per-round settlement write.
            this.db.transaction(() => {
              this.db.recordSettlement({
                roundId: data.round_id,
                winningStake: BigInt(data.winning_stake.toString()),
                wonUsd: BigInt(data.won_usd_amount.toString()),
                wonShares: BigInt(data.won_shares_amount.toString()),
                hashrateEarned: BigInt(data.hashrate_earned.toString()),
                wonTokenAmount: BigInt(data.won_token_amount.toString()),
                wonTokenShares: BigInt(data.won_token_shares.toString()),
                wallet: data.authority.toBase58(),
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
      if (this.wallets.size > 1) void this.wallets.refreshBalances(this.connection, this.ixCtx.usdMint);
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
    this.prices.stop();
    this.tokenFeed?.stop();
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
