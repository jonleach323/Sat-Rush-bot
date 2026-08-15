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
     * 0.70, stated by the operator: "It's always been 70/30, the only thing we
     * have tweaked is what we do with the 30" (rolling reserve + straight
     * rollover; it used to send 10 into epoch). The 0.9333 this defaulted to
     * had no traceable source, and the project's own EV reference states the
     * strike pays the FULL pot — a third, also wrong, figure. Overstating it
     * inflates the strike leg of every round's EV, so the deployed program and
     * the operator win over any note. */
    STRIKE_PAYOUT_FRACTION: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(1).default(0.70),
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
     * below modeled -> raise toward the break-even crossover. */
    MIN_EDGE_BPS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(0).max(10_000).default(200),
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
     * rejected as stale (~150 slots ≈ 60s). */
    PRICE_MAX_STALE_SLOTS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().positive().default(150),
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
     * MEASURED 2026-08-15 against the live distribution (127 participants,
     * 668,088 tickets, top-10 share 71.5%) by simulating the 21 draws:
     * true EV / modelled EV = 1.49x at 144 tickets, 1.42x at 500, 1.46x at
     * 2000 — flat across our size range. 1.45 is the midpoint.
     *
     * Re-measure with `pnpm epoch-uplift` if concentration shifts; a flatter
     * field means less uplift. 1 disables it (the old conservative model). */
    EPOCH_DEDUP_UPLIFT: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(1).max(5).default(1.45),
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
    /** Settle OTHER players' deployments for the rent bounty.
     *
     * settle_deploy_public is permissionless and pays its rent to whoever
     * cranks — measured at +0.001730 SOL net per deployment, ~116 SOL/day
     * across the field — and deployment_settle_grace_duration is 0, so it is a
     * first-to-land race the moment a round resolves.
     *
     * ON. It is legitimate on its own terms — the program pays a bounty for
     * work the game needs done, and unsettled deployments never pay their
     * owners out — and the operator, whose crank currently collects it, has
     * been asked directly and has no objection. SELF_SETTLE, which only
     * reclaims our own, is separate and unaffected.
     *
     * Losing a race costs only the transaction fee, and the margin is ~99.7%
     * (0.00173 SOL against ~0.000015), so a low win rate is still strongly
     * profitable. Watch the win rate in the "rent crank resolved" log line
     * before tuning SETTLE_CRANK_MAX_PER_TX. */
    SETTLE_CRANK_ENABLED: boolFromEnv(true),
    /** Settles packed per transaction.
     *
     * A collision bound, not a protocol one: a deployment a rival closed first
     * fails its whole batch, so a lost 20-pack wastes twenty chances where four
     * 5-packs lose one. The incumbent packs 2.86; the compute budget allows far
     * more than either. */
    SETTLE_CRANK_MAX_PER_TX: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1).max(24).default(8),
    ),
    /** Rent reclaimed per settled deployment, SOL. Measured from balance
     * deltas on live settles; used only to gate a batch against its fee. */
    SETTLE_RENT_SOL_ESTIMATE: z.preprocess(
      emptyToUndef,
      z.coerce.number().positive().default(0.00173),
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
    HASHRATE_DEPLOY_CREDIT_ENABLED: boolFromEnv(false),
    STREAK_OPTION_VALUE_ENABLED: boolFromEnv(false),
    /** Confidence haircut on the streak option value (0–1).
     *
     * The loss is real but projected: it assumes we keep deploying at this rate
     * and that the vaults keep pricing hashrate near today's margin. The
     * haircut stops a large modelled term from steamrolling a decision about
     * real money. 1 = credit it in full. */
    STREAK_OPTION_DISCOUNT: z.preprocess(
      emptyToUndef,
      z.coerce.number().min(0).max(1).default(0.5),
    ),
    /** Ceiling on our share of a vault's projected final ticket count.
     *
     * Replaces the old basis for the deploy-side hashrate credit, which capped
     * it by VAULT_MAX_TICKETS — our OWN risk knob. That was circular: the model
     * concluded hashrate was near-worthless because we had configured ourselves
     * not to spend it, and so credited 0.57% of what a deploy actually earns.
     * The binding constraint is economic, not configured: past some share our
     * own tickets dilute the price we are valuing them at. */
    VAULT_MAX_SHARE: z.preprocess(
      emptyToUndef,
      z.coerce.number().gt(0).max(1).default(0.25),
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
    jitoTipAccounts:
      cfg.JITO_TIP_ACCOUNTS.length + (cfg.JITO_TIP_ACCOUNT ? 1 : 0) || "<unset>",
    jitoTipLamports: `${cfg.JITO_TIP_LAMPORTS}..${cfg.JITO_TIP_MAX_LAMPORTS} (EV frac ${cfg.JITO_TIP_EV_FRACTION})`,
    solUsdEstimate: cfg.SOL_USD_ESTIMATE,
    stakeSemantics: cfg.STAKE_SEMANTICS,
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
