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
     * Open question 1 (CLAUDE.md): is TileStake.stake raw USD or
     * streak-multiplied effective stake? Strategy math must stay correct
     * under either answer — this flag picks the interpretation. Devnet
     * findings so far point to raw net USD; revisit after experiments.
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
    /** Kill switch: if this file exists, all sending stops immediately. */
    KILL_SWITCH_FILE: z.preprocess(emptyToUndef, z.string().default("./KILL")),

    FIRE_OFFSET_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).default(4),
    ),
    K_EMPTIEST: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1).max(21).default(3),
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

    TELEGRAM_TOKEN: optionalString,
    TELEGRAM_CHAT_ID: optionalString,
    DB_PATH: z.preprocess(emptyToUndef, z.string().default("./data/satrush.db")),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.EXECUTION_MODE === "mainnet" && cfg.MAINNET_CONFIRM !== "yes") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MAINNET_CONFIRM"],
        message: "EXECUTION_MODE=mainnet requires MAINNET_CONFIRM=yes",
      });
    }
    if (cfg.PRIORITY_FEE_MIN_MICROLAMPORTS > cfg.PRIORITY_FEE_MAX_MICROLAMPORTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PRIORITY_FEE_MIN_MICROLAMPORTS"],
        message: "PRIORITY_FEE_MIN must not exceed PRIORITY_FEE_MAX",
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
    kEmptiest: cfg.K_EMPTIEST,
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
