/**
 * Zod-validated config, loaded from env (.env via dotenv). Keys mirror env
 * var names 1:1 — see .env.example for documentation of each.
 *
 * Run directly (`tsx src/config.ts`) to print a redacted summary and exit.
 */
import "dotenv/config";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { PROGRAM_ADDRESS } from "./adapter/idl.js";

const emptyToUndef = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const pubkeyString = z.string().refine(
  (s) => {
    try {
      new PublicKey(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a valid base58 public key" },
);

const optionalString = z.preprocess(emptyToUndef, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndef, z.string().url().optional());
const optionalPubkey = z.preprocess(emptyToUndef, pubkeyString.optional());

const boolFromEnv = (defaultValue: boolean) =>
  z.preprocess((v) => {
    const s = emptyToUndef(v);
    if (s === undefined) return undefined;
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
    return s;
  }, z.boolean().default(defaultValue));

const commaListOfUrls = z.preprocess(
  (v) =>
    typeof v === "string"
      ? v.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : v,
  z.array(z.string().url()).default([]),
);

const commaListOfUsd = z.preprocess(
  (v) =>
    typeof v === "string" && v.trim() !== ""
      ? v.split(",").map((s) => Number(s.trim()))
      : undefined,
  z.array(z.number().finite().positive()).nonempty().default([1]),
);

const schema = z
  .object({
    EXECUTION_MODE: z.preprocess(
      emptyToUndef,
      z.enum(["dry", "devnet", "mainnet"]).default("dry"),
    ),
    MAINNET_CONFIRM: optionalString,

    RPC_HTTP_URL: z.preprocess(
      emptyToUndef,
      z.string().url().default("https://api.devnet.solana.com"),
    ),
    SECONDARY_RPC_URLS: commaListOfUrls,
    GRPC_URL: optionalString,
    GRPC_TOKEN: optionalString,
    JITO_BLOCK_ENGINE_URL: optionalUrl,

    KEYPAIR_PATH: z.preprocess(
      emptyToUndef,
      z.string().default("./keypairs/operator.json"),
    ),
    PROGRAM_ID: z.preprocess(emptyToUndef, pubkeyString.default(PROGRAM_ADDRESS)),
    USD_MINT: optionalPubkey,
    BTC_MINT: optionalPubkey,

    /**
     * ANSWERED (FINDINGS.md E1): TileStake.stake is raw net USD — the
     * streak multiplier is not applied to tile stakes. "raw" is the
     * measured reality; "effective" remains only as a modeling escape
     * hatch should mainnet differ.
     */
    STAKE_SEMANTICS: z.preprocess(
      emptyToUndef,
      z.enum(["raw", "effective"]).default("raw"),
    ),
    STRATEGY: z.preprocess(
      emptyToUndef,
      z.enum(["water_filling", "k_emptiest"]).default("water_filling"),
    ),
    /** Stake sizing multiplier applied when the strike pool is above the
     * threshold. 1.0 = off until trigger mechanics are understood. */
    STRIKE_SIZE_BOOST: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(1),
    ),
    STRIKE_BOOST_THRESHOLD_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(100),
    ),
    /** Credit the expected strike jackpot (strikePool / strike_trigger_modulus)
     * into each round's EV. Sat Strike is a random ~1/1440 draw that rolls the
     * accumulated jackpot onto the winning tile — can't be timed, but its
     * expectation is real and grows with the pool, so late-cycle rounds get
     * richer and sizing responds on its own. Supersedes the crude
     * STRIKE_SIZE_BOOST threshold. On by default (it is simply more accurate EV);
     * disable only if the mainnet strike mechanic proves to differ. */
    STRIKE_EV_ENABLED: boolFromEnv(true),
    /** Kill switch: if this file exists, all sending stops immediately. */
    KILL_SWITCH_FILE: z.preprocess(emptyToUndef, z.string().default("./KILL")),

    FIRE_OFFSET_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).default(4),
    ),
    /** Adaptive fire timing: self-calibrate the offset from measured land
     * latency so the bot fires as late as safely possible (fresher board,
     * smaller reaction window) and re-tunes as the send path changes. Off =
     * always use the static FIRE_OFFSET_SLOTS. */
    ADAPTIVE_FIRE_OFFSET: boolFromEnv(true),
    /** Fraction of fires that must land in time — the adaptive offset is the
     * quantile of land latency at this probability (higher = more cushion). */
    FIRE_OFFSET_TARGET_LAND_PROB: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(1).default(0.95),
    ),
    /** Extra slots added to the latency quantile (program-cutoff safety). */
    FIRE_OFFSET_CUSHION_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).default(1),
    ),
    /** Hard min offset — never fire later than this many slots before cutoff. */
    FIRE_OFFSET_FLOOR: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).default(2),
    ),
    /** Hard max offset — never fire earlier than this. */
    FIRE_OFFSET_CEILING: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1).default(6),
    ),
    /** Landed-deploy samples required before the adaptive offset engages. */
    FIRE_OFFSET_MIN_SAMPLES: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(20),
    ),
    K_EMPTIEST: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1).max(21).default(3),
    ),
    /** Endgame convergence ∈ [0,1]: fraction of the gap to the board's mean
     * stake that thin tiles are assumed to fill by close. Corrects the
     * predictor's proportional extrapolation (which forecasts ~zero inflow onto
     * empty tiles and so overvalues sniping them). 0 = off. Calibrated from live
     * data where wins paid ~2× vs the ~3.1× needed; revisit as the sample grows. */
    ENDGAME_CONVERGENCE: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0.5),
    ),
    /** Minimum modeled edge to fire, in bps of the gross deploy. The selector
     * otherwise fires on any EV > 0, including thin edges a slightly-optimistic
     * forecast turns negative in reality. 0 = off. */
    MIN_EDGE_BPS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).max(10_000).default(1000),
    ),
    /** Fractional-Kelly bet sizing ∈ [0,1]. Caps each round's total stake at
     * this fraction of the growth-optimal Kelly bet (sized to the live wallet
     * bankroll) — bigger on fat edges, smaller on thin/high-variance ones. Only
     * ever reduces below the EV-max water-filling stake, never past the risk
     * cap. 1.0 = full Kelly (default): the growth-maximizing bet — max long-run
     * extraction, assuming the edge estimate is accurate. 0.5 = half-Kelly
     * (robust to edge-estimate error). 0 = off (pure EV-max). Values >1 are
     * rejected at load: over-betting Kelly provably lowers compounded growth. */
    KELLY_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(1),
    ),
    /** Anti-collision: fold predicted rival occupancy into the selector's
     * forecast so it routes off tiles other snipers will crowd. Off = current
     * behavior (own-observation occupancy only). */
    ANTI_COLLISION_ENABLED: boolFromEnv(false),
    /** How many recent competitor deploys to profile for anti-collision. */
    COMPETITOR_LOOKBACK: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(500),
    ),
    STAKE_LADDER_USD: commaListOfUsd,

    MAX_PER_ROUND_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(1),
    ),
    DAILY_LOSS_CAP_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(5),
    ),
    MAX_UNCLAIMED_USD_VALUE: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(50),
    ),

    PRIORITY_FEE_MIN_MICROLAMPORTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).default(1_000),
    ),
    PRIORITY_FEE_MAX_MICROLAMPORTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(1_000_000),
    ),
    DEPLOY_CU_LIMIT: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(400_000),
    ),
    JITO_TIP_ACCOUNT: optionalPubkey,
    JITO_TIP_LAMPORTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(10_000),
    ),

    STALENESS_MS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(1500),
    ),

    /** Self-settle our deployments after reveal (rent refund to the cranker). */
    SELF_SETTLE: boolFromEnv(true),
    /** Sweep gate — off until claim-fee vs hashrate tradeoffs are measured. */
    SWEEP_ENABLED: boolFromEnv(false),
    /** Fraction of unclaimed shares claimed per sweep. */
    CLAIM_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(1).default(0.5),
    ),
    /** BTC/USD estimate for valuing unclaimed shares (until a price feed). */
    BTC_USD_ESTIMATE: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(100_000),
    ),

    /** Reconciliation tripwire: modeled-vs-realized payout tolerance (fraction). */
    RECONCILE_TOLERANCE: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(5).default(0.25),
    ),
    /** Wallet-drift tripwire: unexplained USDC outflow (whole USD) that halts. */
    WALLET_DRIFT_TOLERANCE_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(5),
    ),

    /** Alert when the wallet drops below this many SOL. */
    SOL_FLOOR_SOL: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(0.02),
    ),

    // ── hashrate raffle vaults (epoch + 1-BTC) — OFF by default ───────────
    /** Master switch for the vault ticket strategy. Off = never buys tickets. */
    VAULT_STRATEGY_ENABLED: boolFromEnv(false),
    /** USD opportunity value of one hashrate point (the pickiness floor). */
    HASHRATE_VALUE_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().nonnegative().default(0),
    ),
    /** Hashrate points per vault ticket (measured on devnet = 100). */
    VAULT_HASHRATE_PER_TICKET: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(100),
    ),
    /** Max tickets to hold in a single vault iteration (risk bound). */
    VAULT_MAX_TICKETS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(100),
    ),
    /** Fraction of the wallet's claimable hashrate the vault strategy may spend. */
    VAULT_HASHRATE_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0.5),
    ),
    /** Enter the epoch draw only within this many slots of the window closing
     * (buy late, after the field's hashrate is committed). */
    VAULT_EPOCH_LATE_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(10),
    ),
    /** Enter the 1-BTC draw only once the vault is at least this full (bps of the
     * trigger threshold) — near-trigger, so the entrant field is visible. */
    VAULT_ONE_BTC_MIN_FILL_BPS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).max(10_000).default(8000),
    ),
    /** Self-crank draws (trigger + epoch winner selection) when the owner's
     * crank is absent, so our winnings become claimable. Claiming always runs;
     * this only controls the permissionless trigger/select cranking. */
    VAULT_SELF_CRANK: boolFromEnv(false),

    TELEGRAM_TOKEN: optionalString,
    TELEGRAM_CHAT_ID: optionalString,
    DB_PATH: z.preprocess(emptyToUndef, z.string().default("./data/satrush.db")),

    // ── read-only monitoring API + dashboard ──────────────────────────────
    /** Bearer token for the read-only API. API is DISABLED unless this is set. */
    API_TOKEN: optionalString,
    /** Bind host — default localhost; expose remotely via a tunnel, not 0.0.0.0. */
    API_HOST: z.preprocess(emptyToUndef, z.string().default("127.0.0.1")),
    API_PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).default(8787)),
  })
  .superRefine((cfg, ctx) => {
    // NOTE: mainnet + MAINNET_CONFIRM is NOT enforced here — read-only
    // tooling (wait:launch, preflight, config summary) must load a mainnet
    // env before arming. Enforcement lives at the send/boot layer:
    // RaceSender refuses to construct and the orchestrator refuses to
    // start (preflight mode_gate) without MAINNET_CONFIRM=yes.
    if (cfg.PRIORITY_FEE_MIN_MICROLAMPORTS > cfg.PRIORITY_FEE_MAX_MICROLAMPORTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PRIORITY_FEE_MIN_MICROLAMPORTS"],
        message: "PRIORITY_FEE_MIN must not exceed PRIORITY_FEE_MAX",
      });
    }
    if (cfg.FIRE_OFFSET_CEILING < cfg.FIRE_OFFSET_FLOOR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FIRE_OFFSET_CEILING"],
        message: "FIRE_OFFSET_CEILING must not be below FIRE_OFFSET_FLOOR",
      });
    }
    if (cfg.MAX_PER_ROUND_USD > cfg.DAILY_LOSS_CAP_USD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MAX_PER_ROUND_USD"],
        message: "MAX_PER_ROUND_USD must not exceed DAILY_LOSS_CAP_USD",
      });
    }
    for (const stake of cfg.STAKE_LADDER_USD) {
      if (stake > cfg.MAX_PER_ROUND_USD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["STAKE_LADDER_USD"],
          message: `stake ladder entry ${stake} exceeds MAX_PER_ROUND_USD (${cfg.MAX_PER_ROUND_USD})`,
        });
      }
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

// ── redacted summary (never leaks tokens or keyed RPC URLs) ─────────────────

function redactUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const u = new URL(url);
    const hasExtras = u.pathname !== "/" || u.search !== "" || u.username !== "";
    return u.origin + (hasExtras ? "/…" : "");
  } catch {
    return "<unparseable-url>";
  }
}

const setOrUnset = (v: string | undefined) => (v === undefined ? "<unset>" : "<set>");

export function summarizeConfig(cfg: Config): Record<string, unknown> {
  return {
    executionMode: cfg.EXECUTION_MODE,
    mainnetConfirmed: cfg.MAINNET_CONFIRM === "yes",
    rpcHttpUrl: redactUrl(cfg.RPC_HTTP_URL),
    secondaryRpcUrls: cfg.SECONDARY_RPC_URLS.map(redactUrl),
    grpcUrl: redactUrl(cfg.GRPC_URL),
    grpcToken: setOrUnset(cfg.GRPC_TOKEN),
    jitoBlockEngineUrl: redactUrl(cfg.JITO_BLOCK_ENGINE_URL),
    keypairPath: cfg.KEYPAIR_PATH,
    programId: cfg.PROGRAM_ID,
    usdMint: cfg.USD_MINT ?? "<resolve-from-chain>",
    btcMint: cfg.BTC_MINT ?? "<resolve-from-chain>",
    fireOffsetSlots: cfg.FIRE_OFFSET_SLOTS,
    adaptiveFireOffset: cfg.ADAPTIVE_FIRE_OFFSET,
    fireOffsetBounds: `${cfg.FIRE_OFFSET_FLOOR}..${cfg.FIRE_OFFSET_CEILING}`,
    kEmptiest: cfg.K_EMPTIEST,
    endgameConvergence: cfg.ENDGAME_CONVERGENCE,
    minEdgeBps: cfg.MIN_EDGE_BPS,
    kellyFraction: cfg.KELLY_FRACTION,
    strikeEvEnabled: cfg.STRIKE_EV_ENABLED,
    antiCollisionEnabled: cfg.ANTI_COLLISION_ENABLED,
    stakeLadderUsd: cfg.STAKE_LADDER_USD,
    maxPerRoundUsd: cfg.MAX_PER_ROUND_USD,
    dailyLossCapUsd: cfg.DAILY_LOSS_CAP_USD,
    maxUnclaimedUsdValue: cfg.MAX_UNCLAIMED_USD_VALUE,
    stalenessMs: cfg.STALENESS_MS,
    priorityFeeMicroLamports: `${cfg.PRIORITY_FEE_MIN_MICROLAMPORTS}..${cfg.PRIORITY_FEE_MAX_MICROLAMPORTS}`,
    deployCuLimit: cfg.DEPLOY_CU_LIMIT,
    jitoTipAccount: cfg.JITO_TIP_ACCOUNT ?? "<unset>",
    jitoTipLamports: cfg.JITO_TIP_LAMPORTS,
    stakeSemantics: cfg.STAKE_SEMANTICS,
    strategy: cfg.STRATEGY,
    strikeSizeBoost: cfg.STRIKE_SIZE_BOOST,
    strikeBoostThresholdUsd: cfg.STRIKE_BOOST_THRESHOLD_USD,
    killSwitchFile: cfg.KILL_SWITCH_FILE,
    selfSettle: cfg.SELF_SETTLE,
    sweepEnabled: cfg.SWEEP_ENABLED,
    claimFraction: cfg.CLAIM_FRACTION,
    solFloorSol: cfg.SOL_FLOOR_SOL,
    apiEnabled: cfg.API_TOKEN !== undefined,
    apiBind: cfg.API_TOKEN !== undefined ? `${cfg.API_HOST}:${cfg.API_PORT}` : "<disabled>",
    apiToken: setOrUnset(cfg.API_TOKEN),
    telegramToken: setOrUnset(cfg.TELEGRAM_TOKEN),
    telegramChatId: setOrUnset(cfg.TELEGRAM_CHAT_ID),
    dbPath: cfg.DB_PATH,
  };
}

// ── direct-run entrypoint: print redacted summary and exit ─────────────────

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error("config invalid:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  console.log(JSON.stringify(summarizeConfig(result.data), null, 2));
}
