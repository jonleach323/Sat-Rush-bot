/**
 * Every economic input, in one place, carrying where it came from.
 *
 * WHY THIS EXISTS
 *
 * Nearly every wrong number in this project has had the same shape. Not bad
 * arithmetic — `evOfAllocation` was verified exact against a closed form — but
 * a bare `number` whose provenance lived in a prose comment, copied into three
 * files, with nothing linking it back to its source and nothing noticing when
 * the source moved:
 *
 *   806_582   iteration-4 field    4 copies; live value 138,624 and climbing
 *   46_553    iteration-4 pool     2 copies; live value $12,836
 *   1.179     unclaimed uplift     3 copies; contested against a 0.246 measurement
 *   100       ticket price         measured on DEVNET, used for mainnet math
 *   0.9333    strike fraction      corrected in ev.ts; 0.0636 survived elsewhere
 *
 * At the call site `0.909` (derived from live config this second) and `1.246`
 * (invented to make a model run) are the same type and read the same. So the
 * three defects are: no provenance, no single source, no uncertainty.
 *
 * A Fact fixes the first two — it cannot be written without declaring where it
 * came from, and it lives here once. `Estimate` in this file fixes the third.
 *
 * RULES
 *  - `derived` is always preferred: read it from chain or SatrushConfig at the
 *    moment of use and it cannot go stale. Most things here should eventually
 *    become derived and disappear from this file.
 *  - `measured` must carry a sample size and a recheck command. If it has a
 *    half-life it is checked against it, and staleness is an error, not a note.
 *  - `assumed` is allowed but must state the risk, and `test/facts.test.ts`
 *    pins the full list so a new one cannot appear quietly.
 *  - A `config` value — one of OUR OWN knobs — is never an economic input.
 *    That circularity has bitten twice: the model concluded hashrate was
 *    worthless because we had configured ourselves not to spend it.
 */

import {
  HASHRATE_PER_TICKET,
  REWARD_MAX_STREAK as SDK_REWARD_MAX_STREAK,
  STREAK_GRACE_ROUNDS as SDK_STREAK_GRACE_ROUNDS,
  STRIKE_BOOST_HASHRATE_MULTIPLIER,
  STRIKE_BOOST_ROUNDS,
  TILE_COUNT,
} from "@satrush/client";

/**
 * Pinned in package.json; recorded so a fact's source is reproducible.
 *
 * 0.1.15 (published 2026-09-10, the day before the V2 cutover) is the V2 SDK:
 * it carries the migrated account layouts, the token vault, the RNG rotor,
 * the streak grace window and the fee-leg changes. Everything V2 in this
 * file is sourced from it or from the owner's V2 announcement of the same day.
 */
const SDK_VERSION = "@satrush/client@0.1.15";

export type Provenance =
  | {
      /**
       * Read straight out of the official @satrush/client. The strongest kind
       * available: it is the program's own constant, versioned with the SDK,
       * and `test/sdk-parity.test.ts` fails if the two ever diverge. Prefer
       * this over measuring something the SDK already exports.
       */
      kind: "sdk";
      /** Exported symbol it comes from. */
      symbol: string;
      version: string;
    }
  | {
      /** Computed from live chain state or SatrushConfig at use time. Cannot go stale. */
      kind: "derived";
      from: string;
    }
  | {
      kind: "measured";
      /** What was measured, and off what. */
      source: string;
      /** ISO date of the measurement. */
      at: string;
      /** Sample size. A measurement without one is an anecdote. */
      n: number;
      /** Standard error in the same unit as `value`, when known. */
      stderr?: number;
      /**
       * Days after which this must be re-measured. Null means the quantity is
       * structural and does not drift (a program constant, say). Anything that
       * tracks volume needs a short one — the pool and field constants were
       * four days stale across a 4.7x collapse and inverted the farming answer.
       */
      halfLifeDays: number | null;
      /** Command that re-measures it. */
      recheck: string;
    }
  | {
      /** The game's owner said so. Authoritative but unverifiable by us. */
      kind: "stated";
      by: string;
      at: string;
    }
  | {
      /** No source. Permitted, but the risk must be named. */
      kind: "assumed";
      why: string;
      /** What breaks, and in which direction, if this is wrong. */
      risk: string;
    };

export interface Fact<T = number> {
  readonly value: T;
  readonly unit: string;
  readonly provenance: Provenance;
}

const fact = <T>(value: T, unit: string, provenance: Provenance): Fact<T> =>
  Object.freeze({ value, unit, provenance });

// ── facts ────────────────────────────────────────────────────────────────────

/** Board tiles. */
export const TILES = fact(TILE_COUNT, "tiles", {
  kind: "sdk", symbol: "TILE_COUNT", version: SDK_VERSION,
});

/**
 * Share of the Sat Strike pot that reaches the winning tile AT TRIGGER.
 * History: an unsourced 0.9333 default was replaced by the owner's stated
 * 0.70 ("always been 70/30"; V1, 2026-08-15). Under V2 the rounds API exposes
 * the split per strike round (`strike_bonus_*` / `strike_reserve_*` /
 * `strike_seed_from_reserve_*`): every one of the 12 V2 strikes paid exactly
 * 14/15 = 93.33% on all three legs (USD, BTC, RUSH) and retained 6.67%, and
 * that reserve is SEEDED into the next pot — so the long-run payout of the
 * strike fee is ~100%, and this fraction only times it. A program constant
 * (zero variance), not a rate: no half-life.
 */
export const STRIKE_PAYOUT_FRACTION = fact(0.9333, "fraction", {
  kind: "measured",
  source: "pnpm strike-payout: rounds 54618–68617, 12 strikes 2026-09-10→20, bonus/(bonus+reserve+epoch) = 93.33% on "
    + "every strike and every leg (sd 0); reserve seeded into the next pot ($229–$374 per strike)",
  at: "2026-09-21",
  n: 12,
  stderr: 0,
  halfLifeDays: null,
  recheck: "pnpm strike-payout",
});

/**
 * Multiple on headline `hashrate_earned` once the deferred part is claimed.
 *
 * CONTESTED. PublicDeploySettled carries both `hashrate_earned` and
 * `unclaimed_hashrate_earned`; over 1,875 settles their ratio is 0.179 (median
 * 0.173), giving 1.179. A separate note claimed "measured mean 0.246" with no
 * stated sample and it cannot be reproduced. 1.179 is used because it has the
 * sample size AND is the conservative direction for anything that makes
 * farming look good.
 */
export const UNCLAIMED_HASHRATE_UPLIFT = fact(1.35, "multiple", {
  kind: "derived",
  from: "SatrushConfig.unclaimed_hashrate_bps via @satrush/client 0.1.15: PublicDeploySettled.unclaimedHashrateEarned = hashrate_earned · bps / 10_000 (3500 → 1.35), a bonus on top released pro rata by claim_sats. The 1.179 measured on V1 settles (n=1875, 2026-08-14) was the V1 program.",
});

/**
 * Hashrate points per vault ticket.
 *
 * Was a DEVNET measurement (n=2) used for every mainnet ticket count. The SDK
 * confirms it, so the cluster mismatch no longer matters.
 */
export const VAULT_HASHRATE_PER_TICKET = fact(
  Number(HASHRATE_PER_TICKET), "raw hashrate/ticket",
  { kind: "sdk", symbol: "HASHRATE_PER_TICKET", version: SDK_VERSION },
);

/**
 * Cap on the streak multiplier.
 *
 * Was ASSUMED — asserted as "the program cap" with the highest streak actually
 * observed at 28, while every farming estimate scaled linearly with it. The SDK
 * exports it, so it is now sourced. Note `hashrateReward()` does NOT apply the
 * clamp itself; the caller must, and `hashrateRawPerUsd` does.
 */
export const REWARD_MAX_STREAK = fact(SDK_REWARD_MAX_STREAK, "rounds", {
  kind: "sdk", symbol: "REWARD_MAX_STREAK", version: SDK_VERSION,
});

/** Hashrate multiplier during the post-Sat-Strike window. */
export const STRIKE_HASHRATE_MULTIPLIER = fact(
  Number(STRIKE_BOOST_HASHRATE_MULTIPLIER), "multiple",
  { kind: "sdk", symbol: "STRIKE_BOOST_HASHRATE_MULTIPLIER", version: SDK_VERSION },
);

/**
 * Rounds the strike hashrate boost covers, EXCLUSIVE of the strike round
 * itself — measured against the public API the boosted span is 241 rounds
 * inclusive, which agrees with this.
 */
export const STRIKE_BOOST_WINDOW_ROUNDS = fact(STRIKE_BOOST_ROUNDS, "rounds", {
  kind: "sdk", symbol: "STRIKE_BOOST_ROUNDS", version: SDK_VERSION,
});

/**
 * Fraction of the epoch field funded by hashrate banked before the iteration
 * opened, and so insensitive to current volume.
 */
export const EPOCH_FIELD_BANKED_SHARE = fact(0.107, "fraction", {
  kind: "measured",
  source: "pnpm epoch-history (paginated): tickets bought in the first tenth of each iteration over its total, "
    + "iterations 12–15 (3.0%…18.6%); buying is back-loaded so this proxy is a floor on the banked share",
  at: "2026-09-21",
  n: 4,
  stderr: 0.039,
  halfLifeDays: 7,
  recheck: "pnpm epoch-history",
});

/**
 * Uplift on modelled epoch EV from per-wallet dedup — winners are drawn without
 * replacement and a drawn wallet's whole block leaves the pool.
 *
 * Sensitive to CONCENTRATION, not just size, so it needs re-measuring whenever
 * the field's shape moves. The live field is 52 wallets against 21 winner
 * slots, a far more favourable regime than the 127 this was measured on.
 */
export const EPOCH_DEDUP_UPLIFT = fact(1.37, "multiple", {
  kind: "measured",
  source: "pnpm epoch-uplift (paginated field): 21-draw simulation on iteration 16 (267 wallets, 429,819 tickets, "
    + "top-1 9.0%, top-10 45.3%) under the equal-prize curve — 1.46x at 144 tickets, 1.37x at 500 and 2000. "
    + "Launch week's 3.3x was an 85-wallet field with a 32% whale; the field has tripled and flattened since",
  at: "2026-09-21",
  n: 267,
  stderr: 0.10,
  halfLifeDays: 3,
  recheck: "pnpm epoch-uplift",
});

/** Ticket count at the last COMPLETE epoch draw. Anchors field projection. */
export const EPOCH_LAST_CLOSE_TICKETS = fact(882_469, "tickets", {
  kind: "measured",
  source: "pnpm epoch-history (paginated participants): iteration 15, 369 wallets, closed 2026-09-18; "
    + "iteration 14 closed at 1,098,101 (441 wallets), 13 at 458,473 (90)",
  at: "2026-09-21",
  n: 1,
  halfLifeDays: 3,
  recheck: "pnpm epoch-history",
});

/** Pool at that same draw, USD. */
export const EPOCH_LAST_CLOSE_POOL_USD = fact(27_798, "USD", {
  kind: "measured",
  source: "pnpm epoch-history: pool_combined_usd_amount of iteration 15 at its draw (USD + BTC legs); "
    + "21 equal prizes of $1,192 = 0.9 × pool / 21, verified (iteration 14: 21 × $1,712)",
  at: "2026-09-21",
  n: 1,
  halfLifeDays: 3,
  recheck: "pnpm epoch-history",
});

// ── V2 (program upgrade of 2026-09-11) ──────────────────────────────────────
//
// Sourced from @satrush/client@0.1.15 and the owner's V2 announcement. The
// values that SatrushConfig carries (fee legs, exit fee) are read from chain
// at boot and OVERRIDE the stated numbers below; the stated copies exist so
// the model can be exercised before the upgrade lands and so `pnpm preflight`
// can compare what landed against what was announced.

/**
 * Rounds a miner may skip without losing the streak. Mirrors the program's
 * `STREAK_GRACE_ROUNDS`; the SDK's `nextStreakMultiplier` shows the exact
 * rule (a play `gap` rounds after the last one continues the streak iff
 * `1 <= gap <= STREAK_GRACE_ROUNDS + 1`). V1 had no grace: E5 measured a
 * single missed round resetting 28 → 1.
 */
export const STREAK_GRACE_ROUNDS = fact(SDK_STREAK_GRACE_ROUNDS, "rounds", {
  kind: "sdk", symbol: "STREAK_GRACE_ROUNDS", version: SDK_VERSION,
});

/**
 * USD refunded per losing-tile gross under V2. The SDK documents
 * `PublicDeploySettled.wonUsdAmount` as "losing-tile refunds (89% of gross
 * per losing tile) plus any strike USD bonus share". Stated, not measured:
 * the first V2 settlements must confirm it (`won_usd / losing gross`).
 * Together with the fee layer it fixes the sats leg: 10000 − 8900 − 600 =
 * 500 bps of gross is what the winning tile's BTC pool is funded with.
 */
export const V2_LOSING_TILE_REFUND_BPS = fact(8900, "bps of gross", {
  kind: "measured",
  source: "V2 mainnet rounds 55431/55435/55436/55437: post-swap USD = 0.89·(gross − winning-tile gross) "
    + "and swap = 0.05·gross + 0.89·winning-tile gross, both to ±$0.00002; per-deployment usd_earned "
    + "= 0.89 × gross on losing tiles (E-v2-live)",
  at: "2026-09-11",
  n: 4,
  halfLifeDays: null,
  recheck: "pnpm v2-strategy (live section)",
});

/**
 * Deploy fee layer under V2 (strike + epoch + one_btc + protocol + buybacks
 * legs), announced as "8% → 6%". V1's layer measured 800 bps (E6), so the
 * owner's "protocol fee" means the whole layer. Read from SatrushConfig at
 * boot; this is the pre-launch stated value.
 */
export const V2_DEPLOY_FEE_LAYER_BPS = fact(600, "bps of gross", {
  kind: "stated",
  by: "game owner, V2 announcement",
  at: "2026-09-10",
});

/**
 * Exit fee on vault redemptions (Sats Vault AND Token Vault), the "same 10%
 * claim tax". Read from `SatrushConfig.vaultExitFeeBps` at boot. It stays in
 * the vault, which is the carry every non-claimer earns.
 */
export const V2_VAULT_EXIT_FEE_BPS = fact(1000, "bps", {
  kind: "stated",
  by: "game owner, V2 announcement; SatrushConfig.vaultExitFeeBps doc",
  at: "2026-09-10",
});

/**
 * Split of each round's minted RUSH. The SDK's RoundRevealed doc: "the
 * winners' (64%), losers' (16%) and epoch (6%) legs are derived from
 * minted_token_amount"; the strike leg is 14% plus any player leg with no
 * claimant (an empty winning tile's winners' leg, an all-on-the-winning-tile
 * round's losers' leg). Matches the announcement exactly.
 */
export const TOKEN_SPLIT_WINNERS_BPS = fact(6400, "bps of mint", {
  kind: "stated", by: "@satrush/client@0.1.15 RoundRevealed doc; V2 announcement", at: "2026-09-10",
});
export const TOKEN_SPLIT_LOSERS_BPS = fact(1600, "bps of mint", {
  kind: "stated", by: "@satrush/client@0.1.15 RoundRevealed doc; V2 announcement", at: "2026-09-10",
});
export const TOKEN_SPLIT_STRIKE_BPS = fact(1400, "bps of mint", {
  kind: "stated", by: "@satrush/client@0.1.15 RoundRevealed doc; V2 announcement", at: "2026-09-10",
});
export const TOKEN_SPLIT_EPOCH_BPS = fact(600, "bps of mint", {
  kind: "stated", by: "@satrush/client@0.1.15 RoundRevealed doc; V2 announcement", at: "2026-09-10",
});

/**
 * RUSH launch price, USD per whole token. The owner's number for the listing;
 * the live figure is the API's `prices.token` (the mint program's oracle) and
 * overrides this the moment it loads. A launch price is a level, not a
 * forecast: everything sized off it must be re-marked to the oracle.
 */
export const RUSH_LAUNCH_PRICE_USD = fact(10, "USD/RUSH", {
  kind: "stated", by: "game owner", at: "2026-09-10",
});

/**
 * RUSH minted per USD of gross round volume at launch: "initially 1 token per
 * $500 volume". PROPORTIONAL to volume, so the yield per dollar does not
 * depend on how much anyone else deploys — there is no thin-round timing
 * edge on the token leg. The owner says a "very complex algo" replaces this
 * rate; with a 2.1M cap it can only fall. `pnpm v2-strategy` measures the
 * live rate from `Round.mintedTokenAmount / deployedGrossUsdAmount`.
 */
export const RUSH_MINT_PER_USD_VOLUME = fact(1 / 500, "RUSH per USD of gross volume", {
  kind: "stated", by: "game owner", at: "2026-09-10",
});

/**
 * What the mint program actually issues, valued at the oracle spot: minted ×
 * price / gross, measured on live V2 rounds. 1.37% of volume. Tokens per
 * dollar were 0.279 per $1,000 (1 RUSH per ~$3,600) a day after launch,
 * against the owner's "initially 1 token per $500" — a 7x fall in a day. The
 * owner also stated that an algorithm sets the volume-to-RUSH ratio and that
 * it DECREASES over time; the program has no public IDL, so the schedule's
 * shape is unknown. Within an hour the rate drifted UP ~0.09% per round while
 * spot moved both ways, so whatever it is, it is not keyed to spot and it is
 * not monotone at the round scale. Treat the yield as falling until a day of
 * readings says otherwise: a one-day half-life, re-measured every run.
 */
export const RUSH_MINT_USD_YIELD = fact(0.0173, "USD of RUSH per USD of gross volume", {
  kind: "measured",
  source: "pnpm mint-rule: 0.405 RUSH per $1k of gross (n=300 settled rounds 56580–68540, ratio CV 5%) × $42.60 spot 2026-09-21",
  at: "2026-09-21",
  n: 300,
  stderr: 0.0002,
  halfLifeDays: 1,
  recheck: "pnpm mint-rule",
});

/**
 * The mint RULE, settled: RUSH minted is PROPORTIONAL to the round's gross
 * (M = 0.0075 + 0.3626·V/1000, R² 0.996 over 300 rounds; the ratio's CV is
 * 5% against 70% for volume). A fixed-per-round mint would have made thin
 * rounds pay more per dollar and rewarded timing; it does not — thin rounds
 * pay 0.416 vs 0.386 RUSH/$1k on fat ones, a difference of 8% that the
 * upward drift over the sample explains. Timing the mint is worth nothing.
 */
export const RUSH_MINT_PER_USD = fact(0.000405, "RUSH per USD of gross", {
  kind: "measured",
  source: "pnpm mint-rule: slope 0.3626 ± 0.0014 RUSH/$1k, intercept 0.0075 RUSH; mean ratio 0.4047/$1k; "
    + "rising +0.0070 RUSH/$1k per day (+1.74%/day of the mean) over 2026-09-12→21 — the owner said the ratio "
    + "would fall; it has risen 40% since launch (0.29 → 0.40)",
  at: "2026-09-21",
  n: 300,
  stderr: 0.0000014,
  halfLifeDays: 1,
  recheck: "pnpm mint-rule",
});

/**
 * The sats vault carry: BTC-per-share drift from the 10% exit fee that every
 * `claim_sats` / coupled `claim_token` leaves behind for the holders who do not
 * claim. Measured as a RATIO series — `btc_earned / sats_shares_earned` of the
 * API's per-round settlements is the vault ratio at that settle — so it
 * converges fast. The steady rate is the quiet V1 tail before the V2 cutover:
 * 0.06–0.33%/day depending on the window (≈20–120% simple APR; the app's
 * `apr` field read 119.7% then). V2's first day ran +3.95% (28% of the
 * vault's shares exited at launch; two single-round steps of +1.4% each),
 * which is churn, not a rate. It is a transfer from leavers and decays as
 * they run out; the one-day half-life says so. BTC-denominated.
 */
export const SATS_VAULT_CARRY_DAILY = fact(0.0030, "fraction of share value per day", {
  kind: "measured",
  source: "pnpm vault-carry: settlement ratio series rounds 64580–68540 (2026-09-18→21, 2.94 d, 67 samples): "
    + "+0.301%/day with no step changes; 6 h buckets 0.05–0.73%/day. Launch week (28% of shares exiting in a day) "
    + "is over; the pre-cutover V1 tail ran 0.06–0.33%/day (FINDINGS E-v2-carry)",
  at: "2026-09-21",
  n: 67,
  stderr: 0.0007,
  halfLifeDays: 3,
  recheck: "pnpm vault-carry",
});

/**
 * The token vault carry, same mechanism on RUSH-per-share. Day one of the
 * vault: +13.2% in 8.5 h with 57% of the shares exiting (airdrop recipients
 * cashing out through the 10% fee). No steady state exists yet — this is the
 * launch rate, recorded so the ledger can show what it is worth if it held,
 * with a half-life that forces a re-measure before it is believed twice.
 */
export const TOKEN_VAULT_CARRY_DAILY = fact(0.0024, "fraction of share value per day", {
  kind: "measured",
  source: "pnpm vault-carry: token settlement ratio series rounds 64580–68540 (2026-09-18→21, 2.94 d, 67 samples): "
    + "+0.238%/day, no step changes; the airdrop exits of launch day (+35%/day, 57% of shares gone) are over",
  at: "2026-09-21",
  n: 67,
  stderr: 0.0006,
  halfLifeDays: 3,
  recheck: "pnpm vault-carry",
});

/**
 * What the staking treasury pays a staked RUSH: cbBTC from the buybacks'
 * staking share, streamed to stakers — a yield from VOLUME, unlike the vault
 * carry, which is a transfer from leavers. Lifetime average since the stream
 * opened, so a window rate, not the last day's; the app's own `apr` (54%)
 * is lower, its window unpublished.
 */
export const STAKING_YIELD_DAILY = fact(0.00224, "fraction of staked value per day", {
  kind: "measured",
  source: "pnpm staking-yield: /staking/treasury total_reward_deposited 0.0851 BTC over 10.4 d on $297k staked "
    + "(6,969 RUSH at $42.60, 221 stakers). LIFETIME average spanning two regimes: the buybacks leg that funds it "
    + "went 50 → 108 bps at round 64176 (2026-09-17), so the forward rate is likely higher than this — a lower bound",
  at: "2026-09-21",
  n: 1,
  stderr: 0.0005,
  halfLifeDays: 3,
  recheck: "pnpm staking-yield",
});

/**
 * Rival timing on V2 rounds. 93% of gross is automation firing at round
 * open, and NO deploy of any kind lands in the last 40 s of a 92 s round:
 * the board the bot sees at its fire offset is the final board. Manual
 * deploys land at the 59 s mark (median). Volume is $121/round gross,
 * down from $580 at launch; 87% of it is all-21-tile blankets.
 */
export const V2_BOARD_FINAL_BEFORE_CUTOFF_S = fact(40, "seconds", {
  kind: "measured",
  source: "pnpm v2-timing: 100 rounds 68443–68542, 4,880 deploys; 100.0% of final gross on the table 40 s before cutoff, "
    + "0.02 deploys/round after; automations at 90 s (10th–90th 87–92 s), manuals at 59 s (58–82 s)",
  at: "2026-09-21",
  n: 100,
  stderr: 0,
  halfLifeDays: 7,
  recheck: "pnpm v2-timing",
});

export const V2_AUTOMATION_GROSS_SHARE = fact(0.933, "fraction of round gross", {
  kind: "measured",
  source: "pnpm v2-timing: 100 rounds 68443–68542; blankets (all 21 tiles) carry 86.7% of gross",
  at: "2026-09-21",
  n: 100,
  stderr: 0.01,
  halfLifeDays: 7,
  recheck: "pnpm v2-timing",
});

/**
 * The buybacks fee leg, the part of the 6% layer the API config does not
 * expose. Measured: the treasury received 150 bps against a 100 bps protocol
 * leg in the rotate of round 55435, and round 55437's ledger lists
 * buybacks_fee_usd = 50 bps of gross exactly. Half buys and burns RUSH, half
 * funds staking rewards (BUYBACKS_TO_TOKEN_BPS / _TO_STAKING_BPS, unexported).
 */
export const V2_BUYBACKS_FEE_BPS = fact(108, "bps of gross", {
  kind: "measured",
  source: "on-chain SatrushConfig.buybacks_fee_bps = 108 and round 68602 buybacks_fee_usd / gross = 108.0 bps; it was 50 "
    + "(round 55437, rotate tx 3N5JbUniM9aC…) until round 64175 and 108 from 64176 (2026-09-17 21:04 UTC), when the owner "
    + "moved strike 208→240 and epoch 194→104 too. The API /config omits this leg: scripts read the chain (scripts/lib/onchain.ts)",
  at: "2026-09-21",
  n: 3,
  halfLifeDays: null,
  recheck: "curl api.satrush.io/api/v1/rounds/<id> → buybacks_fee_usd; pnpm preflight (economics gate)",
});

/**
 * The buybacks leg's split: the app's own rule text ("29% of the 1.08%
 * buybacks and staking fee buys BTC, and it is distributed to stakers in
 * proportion to their share of the pool"); the other 71% buys RUSH for
 * `buyback_burn_token`. The SDK names the constants (`BUYBACKS_TO_STAKING_BPS`,
 * `BUYBACKS_TO_TOKEN_BPS`) without exporting them; the treasury's two
 * counters (`staking_buybacks_usd_amount`, `token_buybacks_usd_amount`) are
 * the on-chain check. The staking yield is therefore 29% × 108 bps × daily
 * volume ÷ staked value — a function of VOLUME, not a rate.
 */
export const BUYBACKS_TO_STAKING_BPS = fact(2900, "bps of the buybacks leg", {
  kind: "stated",
  by: "satrush.io About page (2026-09-21): '29% of the 1.08% buybacks and staking fee buys BTC … distributed to stakers'",
  at: "2026-09-21",
});

/**
 * The mint program's rule, from the app's About page (no IDL exists):
 *   effective rate = min(tranche rate, $20 per $1k deployed ÷ max(30-day TWAP, 1-day TWAP))
 * Tranche 1 mints 1 RUSH per $500 and holds 515,813 RUSH; each later tranche
 * holds 75% of the previous tranche's tokens at 75% of its rate. The TWAP
 * term is the binding one at any price above $10 (tranche rate 2 RUSH/$1k vs
 * cap 20/price): so the RUSH leg is worth AT MOST 2% of gross volume in
 * dollars, at the TWAP price, whatever RUSH trades at. Measured live rate
 * 0.4308 RUSH/$1k at $42.95 spot = 1.85% (implied TWAP $46.4). This is why
 * "cost per mined RUSH" scales with spot and mining never crosses buying
 * on price alone: mining beats buying iff the non-token toll < 2% × spot/TWAP.
 */
export const RUSH_MINT_USD_CAP = fact(0.02, "USD of RUSH per USD of gross volume", {
  kind: "stated",
  by: "satrush.io About page (2026-09-21): 'never more than $20 of RUSH per $1,000 deployed at the higher of the two averages'",
  at: "2026-09-21",
});
export const RUSH_MINT_TRANCHE_1_TOKENS = fact(515_813, "RUSH", {
  kind: "stated",
  by: "satrush.io About page (2026-09-21): first tranche holds 515,813 RUSH at 1 per $500",
  at: "2026-09-21",
});
export const RUSH_MINT_TRANCHE_DECAY = fact(0.75, "fraction (tokens and rate per tranche)", {
  kind: "stated",
  by: "satrush.io About page (2026-09-21): 'each tranche after it holds 75% of the previous tranche's tokens and mints them at 75% of its rate'",
  at: "2026-09-21",
});

/**
 * Sat Strike odds: fires when `rng % strike_trigger_modulus == 0`. The SDK
 * doc says "seeded at 1_440"; the deployed config reads 1097 (2026-09-21), and
 * the 12 V2 strikes came one per 1,175 rounds. The orchestrator reads it from
 * the on-chain config at use time; this snapshot is for scripts and docs.
 */
export const STRIKE_TRIGGER_MODULUS = fact(1097, "rounds per expected strike", {
  kind: "derived",
  from: "SatrushConfig.strike_trigger_modulus (on-chain, read 2026-09-21; scripts/lib/onchain.ts)",
});

/**
 * Affiliate share of the protocol fee leg on referred plays, bps. The
 * announcement says "10% of Sat Rush's protocol gross profit"; the SDK's
 * `Affiliate.rateBps` is admin-set per affiliate (`set_affiliate_rate`, max
 * 10000) and is read from our Affiliate PDA once the tag is claimed. The
 * owner has approved extra wallets under the operator's own tag (2026-09-10).
 * Points land as grubstake USD on the affiliate's own miner: spendable on
 * rounds only, no hashrate, winnings return to the grubstake, and it expires.
 */
export const AFFILIATE_RATE_BPS = fact(1000, "bps of the protocol leg", {
  kind: "stated", by: "game owner, V2 announcement", at: "2026-09-10",
});

/** RUSH maximum supply. Only the announcement says so; the mint program is not in the SDK. */
export const RUSH_MAX_SUPPLY = fact(2_100_000, "RUSH", {
  kind: "stated", by: "game owner, V2 announcement", at: "2026-09-10",
});

/**
 * Epoch winners per draw, each paid the same fixed share under V2
 * (`EpochWinnerSelected.rank` "does not affect the pot share"). The 21-rank
 * curve in vault.ts is V1's; V2 uses the flat one.
 */
export const EPOCH_WINNER_SLOTS = fact(21, "winners", {
  kind: "stated", by: "@satrush/client@0.1.15 EpochWinnerSelected doc", at: "2026-09-10",
});

/** Mainnet slot time, for turning slot counts into wall clock. */
export const SLOT_SECONDS = fact(0.267, "seconds", {
  kind: "measured",
  source: "board API slot_duration_ms 266.7 (2026-09-22); 230-slot rounds observed at ~62 s wall clock. The 0.4 s written on 2026-08-01 was the protocol target, not the network — every slots→seconds conversion (fire offset, hurdle rounds/day, epoch length) was 50% long. The orchestrator measures it live from the slot stream and uses that.",
  at: "2026-09-22",
  n: 1,
  halfLifeDays: 30,
  recheck: "curl https://api.satrush.io/api/v1/board | jq .data.slot_duration_ms",
});

/** Everything above, for the staleness sweep and the provenance test. */
export const ALL_FACTS: Readonly<Record<string, Fact<number>>> = Object.freeze({
  TILES,
  STRIKE_HASHRATE_MULTIPLIER,
  STRIKE_BOOST_WINDOW_ROUNDS,
  STRIKE_PAYOUT_FRACTION,
  UNCLAIMED_HASHRATE_UPLIFT,
  VAULT_HASHRATE_PER_TICKET,
  REWARD_MAX_STREAK,
  EPOCH_FIELD_BANKED_SHARE,
  EPOCH_DEDUP_UPLIFT,
  EPOCH_LAST_CLOSE_TICKETS,
  EPOCH_LAST_CLOSE_POOL_USD,
  SLOT_SECONDS,
  STREAK_GRACE_ROUNDS,
  V2_LOSING_TILE_REFUND_BPS,
  V2_DEPLOY_FEE_LAYER_BPS,
  V2_VAULT_EXIT_FEE_BPS,
  TOKEN_SPLIT_WINNERS_BPS,
  TOKEN_SPLIT_LOSERS_BPS,
  TOKEN_SPLIT_STRIKE_BPS,
  TOKEN_SPLIT_EPOCH_BPS,
  RUSH_MAX_SUPPLY,
  AFFILIATE_RATE_BPS,
  RUSH_LAUNCH_PRICE_USD,
  RUSH_MINT_PER_USD_VOLUME,
  RUSH_MINT_USD_YIELD,
  RUSH_MINT_PER_USD,
  SATS_VAULT_CARRY_DAILY,
  TOKEN_VAULT_CARRY_DAILY,
  STAKING_YIELD_DAILY,
  BUYBACKS_TO_STAKING_BPS,
  RUSH_MINT_USD_CAP,
  RUSH_MINT_TRANCHE_1_TOKENS,
  RUSH_MINT_TRANCHE_DECAY,
  STRIKE_TRIGGER_MODULUS,
  V2_BOARD_FINAL_BEFORE_CUTOFF_S,
  V2_AUTOMATION_GROSS_SHARE,
  V2_BUYBACKS_FEE_BPS,
  EPOCH_WINNER_SLOTS,
});

// ── staleness ────────────────────────────────────────────────────────────────

export interface Staleness {
  name: string;
  ageDays: number;
  halfLifeDays: number;
  fact: Fact<number>;
}

/**
 * Measured facts past their half-life. These are not warnings to skim — the
 * two epoch constants going four days stale across a 4.7x volume collapse is
 * the single error that made farming look profitable.
 */
export function staleFacts(now = new Date()): Staleness[] {
  const out: Staleness[] = [];
  for (const [name, f] of Object.entries(ALL_FACTS)) {
    const p = f.provenance;
    if (p.kind !== "measured" || p.halfLifeDays === null) continue;
    const ageDays = (now.getTime() - new Date(p.at).getTime()) / 86_400_000;
    if (ageDays > p.halfLifeDays) {
      out.push({ name, ageDays, halfLifeDays: p.halfLifeDays, fact: f });
    }
  }
  return out.sort((a, b) => b.ageDays / b.halfLifeDays - a.ageDays / a.halfLifeDays);
}

/** Facts with no source behind them. */
export function assumedFacts(): { name: string; fact: Fact<number> }[] {
  return Object.entries(ALL_FACTS)
    .filter(([, f]) => f.provenance.kind === "assumed")
    .map(([name, f]) => ({ name, fact: f }));
}

/** One-line provenance, for logs and script headers. */
export function describe(name: string, f: Fact<number>): string {
  const p = f.provenance;
  const tag =
    p.kind === "sdk" ? `${p.symbol} from ${p.version}`
    : p.kind === "derived" ? `derived from ${p.from}`
    : p.kind === "stated" ? `stated by ${p.by} on ${p.at}`
    : p.kind === "assumed" ? `ASSUMED — ${p.why}`
    : `measured ${p.at} (n=${p.n}${p.stderr !== undefined ? `, se=${p.stderr}` : ""})`;
  return `${name} = ${f.value} ${f.unit} — ${tag}`;
}

// ── estimates ────────────────────────────────────────────────────────────────

/**
 * A number with an error bar, because a point estimate is not a result.
 *
 * This exists because a realized -25.45% over 193 single-tile deploys was
 * reported as a finding when the standard error on that sample was +/-28.6
 * points. z was -0.61. The sample could not distinguish the strategy from
 * doing nothing, and nothing in the code or the output said so.
 */
export interface Estimate {
  value: number;
  /** Standard error, same unit as `value`. */
  stderr: number;
  /** Observations behind it. */
  n: number;
}

/** Is `e` distinguishable from `against` at `sigmas` standard errors? */
export function significant(e: Estimate, against = 0, sigmas = 2): boolean {
  return e.stderr > 0 && Math.abs(e.value - against) >= sigmas * e.stderr;
}

/** Observations needed to resolve an effect the size of `e.value` at `sigmas`. */
export function samplesNeeded(e: Estimate, sigmas = 2): number {
  if (!(Math.abs(e.value) > 0) || !(e.stderr > 0) || !(e.n > 0)) return Infinity;
  // stderr scales as 1/sqrt(n), so n_needed = n * (sigmas*stderr / |value|)^2.
  return Math.ceil(e.n * Math.pow((sigmas * e.stderr) / Math.abs(e.value), 2));
}

/**
 * Render an estimate so it cannot be quoted without its error bar. Anything
 * that fails the significance test says so in the same breath as the number.
 */
export function formatEstimate(e: Estimate, unit = "", against = 0): string {
  const sig = significant(e, against);
  const need = sig ? "" : `, need ~${samplesNeeded(e).toLocaleString()}`;
  return `${e.value >= 0 ? "+" : ""}${e.value.toFixed(2)}${unit} ` +
    `± ${e.stderr.toFixed(2)}${unit} (n=${e.n}${need})` +
    `${sig ? "" : " NOT SIGNIFICANT"}`;
}
