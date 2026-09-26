/**
 * Zod-validated config, loaded from env (.env via dotenv). Keys mirror env
 * var names 1:1 — see .env.example for documentation of each.
 *
 * Run directly (`tsx src/config.ts`) to print a redacted summary and exit.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { EPOCH_DEDUP_UPLIFT, EPOCH_FIELD_BANKED_SHARE, EPOCH_LAST_CLOSE_POOL_USD, EPOCH_LAST_CLOSE_TICKETS, STRIKE_PAYOUT_FRACTION, STAKING_YIELD_DAILY } from "./strategy/facts.js";
import { PROGRAM_ADDRESS } from "./adapter/idl.js";

/**
 * Where the env comes from, first match wins: DOTENV_CONFIG_PATH, `.env` in
 * the working directory, then the service's `/etc/satrush/.env` — so
 * `pnpm preflight` / `pnpm grpc-probe` on the VPS read the same file the
 * systemd unit does without sourcing it by hand. Variables already in the
 * process environment always win (dotenv never overrides).
 */
export const ENV_FILE_CANDIDATES = [".env", "/etc/satrush/.env"] as const;
export function resolveEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DOTENV_CONFIG_PATH) return env.DOTENV_CONFIG_PATH;
  for (const p of ENV_FILE_CANDIDATES) if (existsSync(p)) return p;
  return null;
}
const envFile = resolveEnvFile();
if (envFile) loadDotenv({ path: envFile });

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

const commaListOfPubkeys = z.preprocess(
  (v) =>
    typeof v === "string"
      ? v.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : v,
  z.array(pubkeyString).default([]),
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
    /**
     * Which program economics the selector runs on. V2 (live on mainnet since
     * 2026-09-11) prices the 89% losing-tile refund, the 5% sats leg and the
     * RUSH mint (src/strategy/ev-v2.ts); v1 is the pre-upgrade parimutuel and
     * is WRONG against the live program — keep it for replaying V1 history.
     */
    GAME_VERSION: z.preprocess(emptyToUndef, z.enum(["v1", "v2"]).default("v2")),
    /** Public API root (no trailing slash) — RUSH oracle price + mint rate. */
    SATRUSH_API_URL: z.preprocess(
      emptyToUndef,
      z.string().url().default("https://api.satrush.io/api/v1"),
    ),
    /**
     * Independent RUSH price for the token feed's cross-check (Jupiter price
     * v3 by default; the RUSH mint is appended). The app marks RUSH from its
     * own Orca pool, so this catches a wrong marking, not a moved market.
     * Empty = no cross-check.
     */
    DEX_PRICE_URL: z.preprocess(
      (v) => (typeof v === "string" ? v : undefined),
      z.string().default("https://lite-api.jup.ag/price/v3?ids="),
    ),
    /** Reject the app's RUSH price when it differs from the DEX by more than this fraction. */
    TOKEN_PRICE_MAX_DIVERGENCE: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0.05),
    ),
    TOKEN_FEED_POLL_MS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).default(30_000),
    ),
    /** Older than this and the token leg is priced at the fallback, not the held quote. */
    TOKEN_FEED_MAX_AGE_MS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(300_000),
    ),
    /**
     * Fallbacks when the API has never answered: RUSH/USD and RUSH minted per
     * USD of gross volume. Both default 0 — a token leg nobody can price is
     * worth nothing to the EV, which is the honest prior. Never set these to
     * the launch numbers; the live rate is ~7× below the stated 1 per $500.
     */
    RUSH_USD_ESTIMATE: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().min(0).default(0),
    ),
    RUSH_MINT_PER_USD_ESTIMATE: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().min(0).max(1).default(0),
    ),
    /**
     * Credit the vault carry on the share legs: the BTC and RUSH shares a
     * deploy earns appreciate while held, because both vaults keep the 10%
     * exit fee of everyone who claims. This is the holding horizon, in days,
     * the credit is computed over (carry = daily rate × days). 0 (default) =
     * not credited: the carry is a transfer from leavers that decays, and it
     * only accrues to a wallet that never claims. The operator stated the
     * intent on 2026-09-22 ("I don't plan on claiming for a long time unless
     * claiming and staking outperforms"), so the default is a 30-day horizon;
     * /pnl compares hold vs claim every time and alerts if it flips. 0 = not
     * credited. Re-run `pnpm vault-carry` before believing the rate.
     */
    VAULT_CARRY_HORIZON_DAYS: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().min(0).max(365).default(30),
    ),
    /**
     * Cap on the daily carry rate credited, as a simple APR fraction (1.2 =
     * 120%/yr ≈ 0.33%/day, the measured pre-launch steady rate). The live
     * rate comes from the API's vault `apr` fields, which on launch day read
     * 315% and 20,848% on the back of one-off exits; the cap keeps a spike
     * from being priced as a rate.
     */
    VAULT_CARRY_APR_CAP: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().min(0).max(100).default(1.2),
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
    /** Fraction of the accumulated Strike pool that actually reaches the
     * winning tile's stakers on trigger. The rest is retained as a reserve
     * which seeds the NEXT strike, so it is real value but not value this
     * round's deploy can win.
     *
     * MEASURED n=1: round 13023 paid $1133.85 of a $1214.84 pool = 0.9333.
     * The reserve mechanic is new — the prior strike (round 10695) reserved
     * nothing and paid 100% — so treat this as provisional and re-measure. It
     * is set below 1 deliberately: the RoundRevealed event reports the true
     * strike_bonus_usd, so the realized figure can be checked against the pool,
     * and understating a jackpot is the safe direction when it feeds Kelly. */
    /** Fraction of the Sat Strike pool that reaches the winning tile on trigger.
     *
     * MEASURED under V2 (`pnpm strike-payout`, 12 strikes, zero variance):
     * 14/15 = 0.9333 on every leg, the 6.67% reserve seeded into the next
     * pot. The operator's V1 statement was "always been 70/30, the only thing
     * we have tweaked is what we do with the 30" (rolling reserve + rollover),
     * and an earlier unsourced default happened to be 0.9333 too; the deployed
     * program wins over both. Overstating it inflates the strike leg of every
     * round's EV, so the default is the measured value, never 1.0. */
    STRIKE_PAYOUT_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(1).default(STRIKE_PAYOUT_FRACTION.value),
    ),
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
      // Per LEG: a 21-leg fleet round at 0.95 expects one miss a round by design.
      z.coerce.number().gt(0).max(1).default(0.99),
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
    /** Hard max offset — never fire earlier than this. Calibrated on 400 ms
     * slots; mainnet runs ~267 ms slots (2026-09), so 6 slots is 1.6 s against
     * a measured 0.8 s send→land for a 21-leg fleet send — too little room
     * for the adaptive offset to open when a round is missed. 12 slots ≈ 3.2 s
     * on a board that is final ~40 s before cutoff costs nothing. */
    FIRE_OFFSET_CEILING: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1).default(12),
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
     * empty tiles and so overvalues sniping them). 0 = off.
     *
     * V1 calibrated 0.5 (wins paid ~2× vs the ~3.1× needed). V2 default 0:
     * `pnpm v2-timing` measured 100.0% of final gross on the table 40 s
     * before cutoff over 100 rounds, with 0.02 deploys/round after — the
     * board the bot fires into IS the final board, and any convergence
     * assumed on top of it is invented occupancy (facts.ts
     * V2_BOARD_FINAL_BEFORE_CUTOFF_S). Re-measure before raising it. */
    ENDGAME_CONVERGENCE: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0),
    ),
    /** Minimum modeled edge to fire, in bps of the gross deploy. The selector
     * otherwise fires on any EV > 0, including thin edges a slightly-optimistic
     * forecast turns negative in reality. 0 = off.
     *
     * Calibrated from live data (2026-08-06, n=98): with ENDGAME_CONVERGENCE
     * active the model's average modeled edge is ~368 bps and it realized
     * +552 bps — i.e. roughly calibrated, slightly pessimistic. The former
     * default of 1000 was set from PRE-convergence data (where the model
     * overstated edge by ~2150 bps) and blocks the very band that is now
     * profitable. 200 keeps a small margin for residual optimism without
     * gating out the tradeable range. Re-check as the post-fix sample grows:
     * realized consistently >= modeled -> lower toward 0; realized falling
     * below modeled -> raise toward the break-even crossover.
     *
     * V2 (2026-09-21): the EV-maximizing fleet blanket runs at 1–3% of gross
     * (pnpm ev-size), so the V1 floor of 200 bps skipped the unboosted
     * optimum outright. 25 bps: a margin over the model's own noise (uplift
     * ±0.10 ≈ 20 bps, mint CV 5% ≈ 9 bps) — a "positive" round inside that
     * band is a coin flip on the inputs, not an edge. The ABSOLUTE floor
     * (EDGE_HURDLE_ENABLED) sits alongside: fees and the alternative use of
     * the money. The larger of the two applies. */
    MIN_EDGE_BPS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).max(10_000).default(25),
    ),
    /** EV-MAX MODE: 0 (off). Kelly maximises log-growth, not EV — it sizes
     * BELOW the EV argmax whenever the stake is a large fraction of the
     * bankroll. Set > 0 only if growth-optimal (safer) sizing is preferred.
     * Fractional-Kelly bet sizing ∈ [0,1]. Caps each round's total stake at
     * this fraction of the growth-optimal Kelly bet (sized to the live wallet
     * bankroll) — bigger on fat edges, smaller on thin/high-variance ones. Only
     * ever reduces below the EV-max water-filling stake, never past the risk
     * cap. 1.0 = full Kelly (default): the growth-maximizing bet — max long-run
     * extraction, assuming the edge estimate is accurate. 0.5 = half-Kelly
     * (robust to edge-estimate error). 0 = off (pure EV-max). Values >1 are
     * rejected at load: over-betting Kelly provably lowers compounded growth. */
    /**
     * The economic hurdle: a round must also clear, in dollars, the
     * round-trip transaction fees of every leg the fire needs (deploy +
     * settle, at the live priority fee and SOL price) plus what the stake
     * would earn elsewhere over the round (OPPORTUNITY_YIELD_DAILY ÷ rounds
     * per day). "Buying spot and staking is +EV over this round" is exactly
     * the second term; "mining RUSH is dearer than buying it" is already the
     * sign of the EV itself, since the RUSH leg is valued at spot.
     */
    EDGE_HURDLE_ENABLED: boolFromEnv(true),
    /** Daily yield of the alternative use of a deployed dollar (default: the measured staking yield, a lower bound). */
    OPPORTUNITY_YIELD_DAILY: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(1).default(STAKING_YIELD_DAILY.value)),
    KELLY_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0),
    ),
    /** Anti-collision: fold profiled rival occupancy into the selector's
     * forecast so it routes off tiles other snipers will crowd. This is the
     * TARGETED crowding signal (which tiles specific snipers chase); it composes
     * with ENDGAME_CONVERGENCE (the blanket "cheap tiles fill toward the mean"
     * signal) — the predictor adds rival inflow first, then convergence fills any
     * residual gap to the mean, so the two are bounded, not runaway. If the bot
     * proves too conservative with both on, lower ENDGAME_CONVERGENCE first (the
     * blunter of the two). On by default (the campaign field is crowded). */
    ANTI_COLLISION_ENABLED: boolFromEnv(true),
    /** How many recent competitor deploys to profile for anti-collision. */
    COMPETITOR_LOOKBACK: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(500),
    ),
    STAKE_LADDER_USD: commaListOfUsd,

    /**
     * 0 = AUTO (default): the per-round cap is the fleet's deployable USDC,
     * refreshed every 30 s, so cash is the only thing that ever caps a
     * round; the selector's marginal EV (dilution-priced) and Kelly on the
     * bankroll do the sizing. A positive value is a hard ceiling on top.
     * Still enforced in the execution path (Bankroll.setLimits).
     */
    MAX_PER_ROUND_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().nonnegative().default(0),
    ),
    /**
     * 0 = AUTO (default): AUTO_DAILY_LOSS_FRACTION of the fleet's USDC at
     * the start of the UTC day (never below $5) — a ruin guard against a
     * broken model, not a variance guard; the reconcile tripwire and kill
     * switch cover model breakage round by round. A positive value is a
     * hard figure instead.
     */
    DAILY_LOSS_CAP_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().nonnegative().default(0),
    ),
    /** Auto daily cap as a fraction of the day's opening USDC. 1.0 = the whole bankroll: no round is ever refused for drawdown, only for running out of money; the reconcile tripwire and kill switch cover model breakage. */
    AUTO_DAILY_LOSS_FRACTION: z.preprocess(emptyToUndef, z.coerce.number().gt(0).max(1).default(1)),
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
    /** Compute-unit limit on deploy/settle/claim transactions. The priority fee
     * is paid on the LIMIT, not on usage. Measured on mainnet 2026-09-26:
     * deploys 54,772–66,766 CU, settle 71,188 CU (getTransaction on the
     * fleet's own signatures). 150,000 is 2.2× the heaviest. */
    DEPLOY_CU_LIMIT: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(150_000),
    ),
    JITO_TIP_ACCOUNT: optionalPubkey,
    /** Jito tip accounts (comma list). One is picked at random per fire to avoid
     * the write-lock hotspot of tipping a single account every round. Merged
     * with the singular JITO_TIP_ACCOUNT. */
    JITO_TIP_ACCOUNTS: commaListOfPubkeys,
    /** Base (floor) Jito tip in lamports — always tipped when Jito is configured. */
    JITO_TIP_LAMPORTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(10_000),
    ),
    /** Ceiling on the EV-scaled tip (lamports). Must be ≥ JITO_TIP_LAMPORTS. */
    JITO_TIP_MAX_LAMPORTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(1_000_000),
    ),
    /** Fraction of a round's modeled EV to bid as the Jito tip, on top of the
     * base — outbids rivals for inclusion on fat rounds, tips the floor on thin
     * ones. Clamped to JITO_TIP_MAX_LAMPORTS. 0 = flat base tip (off). A tip is
     * embedded on every fire whenever tip accounts are configured (Helius Sender
     * requires one); JITO_BLOCK_ENGINE_URL only controls the extra direct bundle. */
    JITO_TIP_EV_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0.1),
    ),
    /** COLD-START SOL/USD seed. The live oracle is authoritative (see
     * PYTH_SOL_USD_ACCOUNT) and is primed before the first decision; this is
     * only in force if that very first read fails. */
    SOL_USD_ESTIMATE: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(75),
    ),

    STALENESS_MS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(1500),
    ),
    /** Alert when the snapshot trails chain head by more than this many slots.
     * Warning only — see MAX_SNAPSHOT_LAG_SLOTS for the firing gate. */
    SLOT_LAG_ALERT_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(30),
    ),
    /** Refuse to fire when the snapshot trails chain head by more than this.
     * STALENESS_MS only catches a stream that goes QUIET; a stream that keeps
     * delivering on time but N slots behind head reads as perfectly fresh. That
     * is the dangerous case: slotsToCutoff() is computed from the lagged slot,
     * so the bot believes it has N more slots than it does and fires into an
     * already-closed round — paying priority fee and Jito tip for a 6005, on a
     * board it is mispricing anyway. Rounds are ~50 slots and healthy lag is
     * 0-2, so 10 leaves wide headroom for measurement noise while still
     * catching a real degradation. */
    MAX_SNAPSHOT_LAG_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(10),
    ),
    /** How stale a lag measurement may be before the gate ignores it (ms). The
     * gate fails OPEN past this: a missing measurement means the reference RPC
     * is unreachable, which stream staleness already covers, and blocking on it
     * would silently park the bot forever. */
    SNAPSHOT_LAG_MAX_AGE_MS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(30_000),
    ),

    /** Self-settle our deployments after reveal (rent refund to the cranker). */
    SELF_SETTLE: boolFromEnv(true),
    /** Compound loop: claim won USDC (unclaimed_usd_amount) back to the wallet
     * once it exceeds MAX_UNCLAIMED_USD_VALUE, so it re-enters the deployable
     * bankroll and Kelly sizes against it. claim_usd is fee-free (deploy fees
     * already taken), so this is pure upside — on by default. */
    CLAIM_USD_ENABLED: boolFromEnv(true),
    /** BTC-share sweep gate (claim_sats). Pays the ~10% sats_vault_claim fee, so
     * off by default — enable only when realizing BTC beats holding the shares. */
    SWEEP_ENABLED: boolFromEnv(false),
    /** Fraction of unclaimed shares claimed per sweep. */
    CLAIM_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(1).default(0.5),
    ),
    /** COLD-START BTC/USD seed. The live oracle is authoritative (see
     * PYTH_BTC_USD_ACCOUNT) and is primed before the first decision; this is
     * only in force if that very first read fails. */
    BTC_USD_ESTIMATE: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(65_000),
    ),
    /** Pyth Solana Receiver push accounts (mainnet sponsored feeds), verified
     * live. Read over the RPC we already hold — no API key, no extra
     * dependency. Set to empty to disable a feed and pin that symbol to its
     * fallback. A wrong address is safe: the update carries its own feed ID, so
     * it is rejected rather than silently mispriced. NOT the legacy v2 oracle
     * accounts — those are frozen at status 0 and never accept. */
    PYTH_BTC_USD_ACCOUNT: z.preprocess(
      emptyToUndef,
      pubkeyString.optional().default("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"),
    ),
    PYTH_SOL_USD_ACCOUNT: z.preprocess(
      emptyToUndef,
      pubkeyString.optional().default("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
    ),
    /** Max slots between an update's posted slot and chain head before it is
     * rejected as stale. The mainnet sponsored feeds heartbeat every ~60 s
     * (~150 slots), so a 150-slot gate rejected the feed at every heartbeat
     * edge (observed stale_173_slots at boot); 400 slots ≈ 160 s leaves two
     * missed heartbeats. The price feeds marks and the fee hurdle, not a
     * trade price. A stale-but-verified quote is still held over the seed. */
    PRICE_MAX_STALE_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(400),
    ),
    /** Reject a quote whose confidence/price exceeds this. */
    PRICE_MAX_CONFIDENCE_RATIO: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(1).default(0.02),
    ),
    /** Oracle refresh cadence. Prices move slowly relative to a 50-slot round;
     * 30s is well inside the staleness window with room for a missed poll. */
    PRICE_POLL_MS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(30_000),
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

    // ── hashrate raffle vaults (epoch + 1-BTC) ────────────────────────────
    /** Master switch for the vault ticket strategy. On = spends earned hashrate
     * (an otherwise-idle byproduct) on +share raffles, bounded by
     * VAULT_MAX_TICKETS / VAULT_HASHRATE_FRACTION and gated by EXECUTION_MODE
     * (dry sends nothing). VERIFY ON DEVNET before mainnet — the vault path caught
     * a 100× cost error on devnet once. Off = deploy-only, never buys tickets. */
    VAULT_STRATEGY_ENABLED: boolFromEnv(true),
    /** USD value of ONE RAW hashrate unit — the on-chain unit (100 raw = 1.00
     * display point). Dual use: the vault pickiness floor, and the deploy-EV
     * hashrate credit (applied per the program formula R = s·(m + 21/n), so it
     * scales with streak and rewards concentration). 0 = hashrate valued at
     * zero: no deploy credit, vault enters on any positive share. Leave 0 until
     * vault payouts actually price a unit — a wrong value here corrupts the edge
     * that Kelly sizes against. */
    HASHRATE_VALUE_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().nonnegative().default(0),
    ),
    /** Promo multiplier on hashrate earned during the post-Sat-Strike bonus
     * window (owner announced 2× for 4h after each Strike). 1 = feature off. */
    STRIKE_HASHRATE_MULTIPLIER: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().min(1).default(2),
    ),
    /** Length of that bonus window in minutes; any Strike inside it resets the
     * timer (we track only the most recent trigger). */
    STRIKE_BONUS_WINDOW_MINUTES: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(240),
    ),
    /** Uplift on epoch ticket EV from wallet-level dedup.
     *
     * Epoch winners are deduped by wallet: when a holder is drawn, ALL of its
     * tickets leave the pool. With the top 10 holding ~71% of tickets, whales
     * are drawn early and their blocks vanish, so a small holder's odds on
     * later draws are well above its raw ticket share. epochWinFraction()
     * models our own once-only constraint but assumes the pool is otherwise
     * static, which understates EV.
     *
     * The default is the measured fact (facts.ts EPOCH_DEDUP_UPLIFT: 3.31x on
     * the 85-wallet V2 field under equal prizes, 2026-09-11; V1's 127-wallet
     * field gave 1.45x under the rank curve). Set it only to override the
     * measurement. Re-measure with `pnpm epoch-uplift` if concentration
     * shifts; a flatter field means less uplift. 1 disables it. */
    EPOCH_DEDUP_UPLIFT: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(1).max(5).default(EPOCH_DEDUP_UPLIFT.value),
    ),
    /** Hashrate points per vault ticket (measured on devnet = 100). */
    VAULT_HASHRATE_PER_TICKET: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(100),
    ),
    /** Max tickets to hold in a single vault iteration (risk bound).
     *
     * Sized to spend the hashrate we actually hold rather than to throttle it.
     * Hashrate is a byproduct with exactly one sink, and its ticket price is
     * propped up by five wallets sitting on 82% of all unspent hashrate — if
     * any of them converts, ticket EV drops ~77% overnight. Unspent hashrate is
     * therefore a depreciating asset, and a cap below our balance just forfeits
     * value. Still a bound: it caps exposure per iteration, and the spend is
     * separately limited by VAULT_HASHRATE_FRACTION and the balance itself. */
    VAULT_MAX_TICKETS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(250),
    ),
    /** Fraction of the wallet's claimable hashrate the vault strategy may spend. */
    /** Credit a deploy with the option value of keeping the streak alive.
     *
     * Hashrate accrues at (streak + 21/n) per USD and ONE missed round resets
     * the streak to 1. Judging each round on its board EV alone therefore
     * declines cents of parimutuel toll at the cost of the accrual rate every
     * future round depends on — the failure mode that kept this bot silent for
     * 2,100 consecutive rounds. Off = the old board-only behaviour. */
    /** Extra signer keypair paths, comma-separated. Empty = single-wallet
     * (KEYPAIR_PATH only), which is the default and leaves behaviour unchanged.
     *
     * Epoch rewards dedup by wallet, so a holding spread across several wallets
     * captures more of the pool than the same holding in one. Hashrate is NOT
     * transferable — it lives in a per-authority Miner PDA — so every wallet
     * here earns its own streak and its own tickets, and the fleet therefore
     * costs N x the volume, not N x the keypairs. Measured marginal gain falls
     * off fast: 6 wallets capture ~74% of the total available, the 7th is worth
     * ~$83/iteration and the 33rd about $5.
     *
     * MAX_PER_ROUND_USD and DAILY_LOSS_CAP_USD stay AGGREGATE across the set —
     * they are split between wallets, never applied per wallet. */
    WALLET_PATHS: z.preprocess(
      (v) =>
        typeof v === "string" && v.trim() !== ""
          ? v.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      z.array(z.string()).default([]),
    ),
    /**
     * Affiliate to bind the fleet's NON-primary wallets to at their first
     * deploy (the V2 `affiliate` account of `deploy_public`). Defaults to the
     * primary wallet, i.e. the operator's own tag — the owner agreed to extra
     * wallets playing under it. The primary itself never passes one
     * (self-referral is refused on chain, error 6066). Binding happens at
     * Miner creation only, so this only matters for wallets that have never
     * deployed. Must have registered a tag (`set_miner_tag`) first.
     */
    AFFILIATE_AUTHORITY: optionalPubkey,
    /**
     * Fund a wallet's leg from its Miner grubstake (affiliate rebate / airdrop
     * USD held by the program) when it covers the amount and has not expired.
     * That money can only be realised by deploying it: the USD refund
     * recycles into the grubstake, the BTC/RUSH legs escape as shares, and
     * NO hashrate is credited on a grubstake-funded deploy. Off = deploy from
     * the wallet and let an expiring grubstake lapse.
     */
    GRUBSTAKE_DEPLOYS: boolFromEnv(true),
    /** Convert accrued affiliate points into grubstake USD on the primary's Miner (fee-free apart from the tx). */
    AFFILIATE_EXCHANGE_ENABLED: boolFromEnv(true),
    /**
     * The fleet, the easy way: `pnpm fleet:init 21` writes wallet-02…wallet-21
     * keypairs into FLEET_DIR and the bot loads them when WALLET_PATHS is empty
     * (KEYPAIR_PATH is wallet 1 and pays for cranks). FLEET_SIZE=1 = single
     * wallet. Deposits go to the PRIMARY only; the treasury distributes.
     */
    FLEET_DIR: z.preprocess(emptyToUndef, z.string().default("./keypairs/fleet")),
    FLEET_SIZE: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(64).default(21)),
    /** Affiliate tag `pnpm fleet:init` registers for the primary (3–16 chars, a-z 0-9 _ -). */
    AFFILIATE_TAG: z.preprocess(emptyToUndef, z.string().regex(/^[a-z0-9_-]{3,16}$/).optional()),
    /**
     * Tile mode: when the selector picks a full 21-tile blanket, wallet i
     * deploys ONLY tile i (i = its index in the set, wrapping past 21) instead
     * of a slice of the blanket. The fleet's money on every tile is identical
     * (refund, sats, strike and RUSH legs all flow the same way), but each
     * wallet earns the single-tile hashrate rate — 121 raw/$ at the cap
     * against a blanket's 101, a fifth more tickets for the same dollars
     * (pnpm ev-grid § C). Non-blanket selections fall back to the slice split.
     * Meaningful with 21 wallets; below that the uncovered tiles are not played.
     */
    FLEET_TILE_MODE: boolFromEnv(true),
    /** Minimum tiles a tile-mode fire must cover (wallets that cannot fund their tile drop out); below this the round is skipped. */
    FLEET_TILE_MIN_COVER: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(21).default(18)),
    /**
     * The treasury: every FLEET_REBALANCE_INTERVAL_MS the bot claims each
     * wallet's unclaimed USD (fee-free), then moves USDC and SOL from the
     * PRIMARY to the wallets below their LOW mark, lowest runway first, up to
     * TARGET, out of what the primary holds above its own target plus
     * RESERVE; wallets above 2× TARGET sweep the excess back. Dry mode plans
     * and logs only. You fund the fleet by sending USDC and SOL to the primary.
     */
    FLEET_TREASURY_ENABLED: boolFromEnv(true),
    /**
     * The USDC float is DYNAMIC: target = the observed peak per-tile leg over
     * the last FLEET_FLOAT_WINDOW_ROUNDS × FLEET_FLOAT_HEADROOM × FLEET_FLOAT_ROUNDS
     * (rounds awaiting the fee-free claim plus a run of 11% misses), floored
     * at FLEET_WALLET_TARGET_USD and capped by MAX_PER_ROUND ÷ tiles; low =
     * FLEET_LOW_FRACTION of the target (never below FLEET_WALLET_LOW_USD). So
     * the two USD numbers below are floors for an empty history, not settings.
     */
    FLEET_WALLET_TARGET_USD: z.preprocess(emptyToUndef, z.coerce.number().positive().default(20)),
    FLEET_WALLET_LOW_USD: z.preprocess(emptyToUndef, z.coerce.number().nonnegative().default(8)),
    FLEET_FLOAT_ROUNDS: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(200).default(8)),
    FLEET_FLOAT_HEADROOM: z.preprocess(emptyToUndef, z.coerce.number().min(1).max(10).default(1.5)),
    FLEET_FLOAT_WINDOW_ROUNDS: z.preprocess(emptyToUndef, z.coerce.number().int().min(100).default(3000)),
    FLEET_LOW_FRACTION: z.preprocess(emptyToUndef, z.coerce.number().gt(0).lt(1).default(0.4)),
    FLEET_WALLET_TARGET_SOL: z.preprocess(emptyToUndef, z.coerce.number().positive().default(0.02)),
    FLEET_WALLET_LOW_SOL: z.preprocess(emptyToUndef, z.coerce.number().nonnegative().default(0.008)),
    FLEET_TREASURY_RESERVE_USD: z.preprocess(emptyToUndef, z.coerce.number().nonnegative().default(0)),
    FLEET_REBALANCE_INTERVAL_MS: z.preprocess(emptyToUndef, z.coerce.number().int().min(10_000).default(60_000)),
    /** Lamports a wallet must retain to be considered fundable for a round. */
    WALLET_MIN_LAMPORTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().nonnegative().default(5_000_000),
    ),
    /** DEFAULT OFF after backtesting. Over 1,198 reconstructed rounds the same
     * selector forced to stay present every round to protect its streak ran
     * -$299/day against +$70/day for the one allowed to sit out: the hashrate a
     * marginal round earns is worth far less than the board cost of deploying
     * into a board that did not justify it. The streak reset is real, it is
     * just not worth buying at the price of the rounds needed to keep it. Turn
     * on only if the epoch channel gets materially richer than it is today. */
    /** Read the automation book instead of predicting rival inflow.
     *
     * PublicAutomation accounts carry a Static strategy's selection_mask and
     * per_round_usd_amount, and the crank executes them at round open — so a
     * funded Static automation is a deploy that WILL land, on tiles already
     * known. Measured: 201 accounts, all Static, 36 funded, committing $115.67
     * per round against a board of ~$135 gross. About 86% of the field is
     * readable rather than guessable. */
    AUTOMATION_BOOK_ENABLED: boolFromEnv(true),
    /** Share of funded automations that actually fire in a round.
     *
     * Intent is not execution — the crank must run, and funding can move
     * between our read and the round. 1.0 is the measured starting point (36
     * funded automations against ~43 deploys per round, of which ~96% are
     * automations), but it should be calibrated against what lands. Over-
     * predicting is the dangerous direction: it makes every tile look more
     * crowded than it is and suppresses deploys we should be making. */
    AUTOMATION_FIRE_RATE: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(1),
    ),
    /** Rounds between automation-book refreshes. Registrations change rarely,
     * so this is a cheap poll, not a hot path. */
    AUTOMATION_REFRESH_ROUNDS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(20),
    ),
    /** Let the hashrate a deploy earns subsidise that deploy's cost.
     *
     * OFF until epoch farming is PROVEN +EV, which it is not. The distinction
     * this gates is the one that matters:
     *
     *   - Spending hashrate we ALREADY hold on vault tickets is sunk-cost and
     *     free at the margin. That runs through VAULT_STRATEGY_ENABLED and is
     *     unaffected by this flag — keep it on.
     *   - Deploying IN ORDER TO earn hashrate is the farming strategy. That is
     *     what this credit funds, by rebating deploy cost and so making
     *     marginal rounds look playable that the board alone would decline.
     *
     * The evidence is not there. The measured +$35.81/day for farm-21 was
     * priced against a $46,553 pool from iteration 4; volume then fell ~4.7x,
     * which supports a pool nearer $12,000, and the margin was thinner than
     * that swing. The honest current range straddles zero.
     *
     * The bar for turning this on: a full iteration where the measured epoch
     * take, against the pool that actually closed, exceeds the board cost of
     * the deploys that earned it — not a projection made mid-iteration, which
     * is the specific error made twice in this branch. */
    /** Ticket count at the last COMPLETE epoch draw, from EpochDrawTriggered.
     * Anchors the field projection to something that actually happened rather
     * than to a linear extrapolation of a partly-elapsed iteration — which
     * under-projected by 41% (475,872 against an 806,582 close), because
     * ticket buying is back-loaded. Re-measure with `pnpm epoch-history`. */
    EPOCH_LAST_CLOSE_TICKETS: z.preprocess(
      emptyToUndef,
      z.coerce.number().positive().default(EPOCH_LAST_CLOSE_TICKETS.value),
    ),
    /** Pool value at that same draw, USD. Used only as the denominator of the
     * volume ratio, so only its size RELATIVE to the live pool matters. */
    EPOCH_LAST_CLOSE_POOL_USD: z.preprocess(
      emptyToUndef,
      z.coerce.number().positive().default(EPOCH_LAST_CLOSE_POOL_USD.value),
    ),
    /** Fraction of the field funded by hashrate banked before the iteration
     * started, and so insensitive to current volume. Measured idle hashrate
     * across all miners is ~3x one iteration's draw, so when volume falls the
     * field does NOT fall with it — this is the floor that stops the
     * projection assuming rivals vanish along with the pool. */
    EPOCH_FIELD_BANKED_SHARE: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(EPOCH_FIELD_BANKED_SHARE.value),
    ),
    /**
     * V2 DEFAULTS ON. Under V1 these backtested negative (a marginal round's
     * hashrate was worth less than the board toll). Under V2 the toll is
     * bounded at 11%, the epoch pays 21 equal slots, and the per-round
     * credit for the hashrate a deploy earns (streak + 21/n raw per $, priced
     * at the measured epoch ticket value with the dedup uplift) is what
     * closes the gap between the −4% round-level EV and the fleet ledger.
     * Set false to replay V1 or to judge rounds on the board alone.
     */
    HASHRATE_DEPLOY_CREDIT_ENABLED: boolFromEnv(true),
    STREAK_OPTION_VALUE_ENABLED: boolFromEnv(true),
    /** Confidence haircut on the streak option value (0–1).
     *
     * The loss is real but projected: it assumes we keep deploying at this rate
     * and that the vaults keep pricing hashrate near today's margin. The
     * haircut stops a large modelled term from steamrolling a decision about
     * real money. EV-MAX MODE: 1 — the model's estimate is credited in full;
     * lower it only to play safer than the model. */
    STREAK_OPTION_DISCOUNT: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(1),
    ),
    /**
     * The "flip" signal. While the board is −EV the bot skips rounds; the
     * selector prices the wallet's CURRENT streak, so it would never begin
     * the ~100-round ramp to the cap even when a blanket AT the cap pays.
     * When an even blanket at MAX_PER_ROUND with the streak at REWARD_MAX_STREAK
     * clears this margin (bps of gross), the skip log carries it and one
     * Telegram alert fires (re-armed once it falls back below zero). That
     * condition is "mining RUSH is cheaper than buying it" with the RUSH leg
     * at spot (`pnpm buy-vs-mine`). The margin is the ramp's own economics,
     * not caution: the climb costs ≤ $2.25 per wallet of negative EV and the
     * cap then pays for ~10k rounds, so it pays back above ~2 bps of a $21
     * fleet minimum per round; 5 bps rounds that up. 0 disables.
     */
    /**
     * Start the ramp by itself. The streak option only prices the loss of a
     * streak already held (nothing to lose at streak 1), so a wallet below
     * the cap would never begin the ~100-round climb on its own even when a
     * blanket AT the cap pays. With this on, once the flip signal clears
     * RAMP_ALERT_MIN_BPS the presence credit is floored at the toll of the
     * minimum blanket (RAMP_PRESENCE_TOLL_BPS of it), so the selector deploys
     * the minimum every round until the cap is reached. The alert still fires.
     */
    AUTO_RAMP: boolFromEnv(true),
    RAMP_PRESENCE_TOLL_BPS: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(10_000).default(300)),
    /** Hours between Telegram digests of routine events (fleet leg outcomes,
     * compound claims, ticket buys, cap-bound rounds). 0 = no scheduled digest
     * (still on demand with /digest). Incidents push immediately regardless. */
    ALERT_DIGEST_HOURS: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(168).default(6)),
    /** Escalate to one push when the fleet's landed-leg fraction over the last
     * 10 fleet rounds falls below this. */
    FLEET_LANDED_ALERT_FRACTION: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(1).default(0.8)),
    RAMP_ALERT_MIN_BPS: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).default(5),
    ),
    /** Ceiling on our share of a vault's projected final ticket count.
     *
     * Replaces the old basis for the deploy-side hashrate credit, which capped
     * it by VAULT_MAX_TICKETS — our OWN risk knob. That was circular: the model
     * concluded hashrate was near-worthless because we had configured ourselves
     * not to spend it, and so credited 0.57% of what a deploy actually earns.
     * The binding constraint is economic, not configured: past some share our
     * own tickets dilute the price we are valuing them at. EV-MAX MODE: 1 —
     * no brake; the dilution curve (HashrateValuation.dilution) prices our
     * own share exactly, so a cap here could only stop below the argmax. */
    VAULT_MAX_SHARE: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(1).default(1),
    ),
    VAULT_HASHRATE_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0.5),
    ),
    /** Absolute FLOOR for the epoch entry window, in slots. Mainnet iterations
     * run for hours, so the fraction below is what actually sets the window;
     * this floor only matters on short (devnet) iterations. The old default of
     * 10 slots (~4s) against a multi-hour iteration was narrower than the 5s
     * poll interval — the window was simply stepped over and the vault never
     * entered. */
    VAULT_EPOCH_LATE_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(600),
    ),
    /** Fraction of the epoch iteration treated as the "late" entry window.
     * Mainnet iterations are 648_000 slots — THREE DAYS, verified against the
     * public API's iteration history — so this multiplier is large and wants a
     * small value: 0.001 ≈ 648 slots ≈ 4 minutes, which is ~50 poll ticks and
     * still the last 0.1% of the cycle. Buying later is strictly better here:
     * every ticket bought after ours dilutes us, so the last safe moment
     * minimises post-purchase dilution as well as maximising information. */
    VAULT_EPOCH_LATE_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0.001),
    ),
    /** Enter the 1-BTC draw only once the vault is at least this full (bps of the
     * trigger threshold) — near-trigger, so the entrant field is visible. */
    VAULT_ONE_BTC_MIN_FILL_BPS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).max(10_000).default(8000),
    ),
    /** BTC that triggers the 1-BTC draw. The program hardcodes 1 BTC and the
     * IDL exposes no constant for it, so it lives here — a config edit is the
     * escape hatch if the game ever changes the threshold. */
    VAULT_ONE_BTC_TARGET_BTC: z.preprocess(
      emptyToUndef,
      z.coerce.number().finite().positive().default(1),
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
    if (cfg.JITO_TIP_MAX_LAMPORTS < cfg.JITO_TIP_LAMPORTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JITO_TIP_MAX_LAMPORTS"],
        message: "JITO_TIP_MAX_LAMPORTS must not be below JITO_TIP_LAMPORTS",
      });
    }
    if (cfg.FIRE_OFFSET_CEILING < cfg.FIRE_OFFSET_FLOOR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FIRE_OFFSET_CEILING"],
        message: "FIRE_OFFSET_CEILING must not be below FIRE_OFFSET_FLOOR",
      });
    }
    if (cfg.MAX_PER_ROUND_USD > 0 && cfg.DAILY_LOSS_CAP_USD > 0 && cfg.MAX_PER_ROUND_USD > cfg.DAILY_LOSS_CAP_USD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MAX_PER_ROUND_USD"],
        message: "MAX_PER_ROUND_USD must not exceed DAILY_LOSS_CAP_USD",
      });
    }
    for (const stake of cfg.STAKE_LADDER_USD) {
      if (cfg.MAX_PER_ROUND_USD > 0 && stake > cfg.MAX_PER_ROUND_USD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["STAKE_LADDER_USD"],
          message: `stake ladder entry ${stake} exceeds MAX_PER_ROUND_USD (${cfg.MAX_PER_ROUND_USD})`,
        });
      }
    }
  });

export type Config = z.infer<typeof schema>;

/** Every key the schema reads (for env migration: anything else in a .env is obsolete). */
export const CONFIG_KEYS: readonly string[] = Object.keys(
  ((schema as unknown as { innerType?: () => { shape: Record<string, unknown> } }).innerType?.() ??
    (schema as unknown as { shape: Record<string, unknown> })).shape,
);

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
    jitoTipAccounts:
      cfg.JITO_TIP_ACCOUNTS.length + (cfg.JITO_TIP_ACCOUNT ? 1 : 0) || "<unset>",
    jitoTipLamports: `${cfg.JITO_TIP_LAMPORTS}..${cfg.JITO_TIP_MAX_LAMPORTS} (EV frac ${cfg.JITO_TIP_EV_FRACTION})`,
    solUsdEstimate: cfg.SOL_USD_ESTIMATE,
    stakeSemantics: cfg.STAKE_SEMANTICS,
    gameVersion: cfg.GAME_VERSION,
    walletSet: cfg.WALLET_PATHS.length > 0 ? `${cfg.WALLET_PATHS.length} keypairs (aggregate caps)` : cfg.FLEET_SIZE > 1 ? `fleet of ${cfg.FLEET_SIZE} from ${cfg.FLEET_DIR} (tile mode ${cfg.FLEET_TILE_MODE ? "on" : "off"}, treasury ${cfg.FLEET_TREASURY_ENABLED ? "on" : "off"})` : "single wallet",
    affiliateAuthority: cfg.AFFILIATE_AUTHORITY ?? "<primary wallet>",
    satrushApiUrl: cfg.SATRUSH_API_URL,
    vaultCarry: cfg.VAULT_CARRY_HORIZON_DAYS > 0 ? `${cfg.VAULT_CARRY_HORIZON_DAYS} d horizon, APR cap ${cfg.VAULT_CARRY_APR_CAP}` : "not credited",
    tokenFeed: `poll ${cfg.TOKEN_FEED_POLL_MS}ms, max age ${cfg.TOKEN_FEED_MAX_AGE_MS}ms, fallback $${cfg.RUSH_USD_ESTIMATE} × ${cfg.RUSH_MINT_PER_USD_ESTIMATE} RUSH/$`,
    strategy: cfg.STRATEGY,
    strikeSizeBoost: cfg.STRIKE_SIZE_BOOST,
    strikeBoostThresholdUsd: cfg.STRIKE_BOOST_THRESHOLD_USD,
    killSwitchFile: cfg.KILL_SWITCH_FILE,
    selfSettle: cfg.SELF_SETTLE,
    claimUsdEnabled: cfg.CLAIM_USD_ENABLED,
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
