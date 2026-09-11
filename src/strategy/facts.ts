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
 * Share of a Sat Strike bonus that reaches the winner. Replaced an invented
 * 0.9333 that flattered every deploying strategy by ~68 bps of gross.
 */
export const STRIKE_PAYOUT_FRACTION = fact(0.70, "fraction", {
  kind: "stated",
  by: "game owner",
  at: "2026-08-15",
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
export const UNCLAIMED_HASHRATE_UPLIFT = fact(1.179, "multiple", {
  kind: "measured",
  source: "unclaimed_hashrate_earned / hashrate_earned over PublicDeploySettled",
  at: "2026-08-14",
  n: 1875,
  halfLifeDays: null,
  recheck: "pnpm accrual-ev",
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
export const EPOCH_FIELD_BANKED_SHARE = fact(0.128, "fraction", {
  kind: "measured",
  source: "pnpm epoch-history: tickets bought in the first tenth of each iteration over its total, "
    + "iterations 8–13 (5.0%…23.3%); buying is back-loaded so this proxy is a floor on the banked share",
  at: "2026-09-11",
  n: 6,
  stderr: 0.033,
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
export const EPOCH_DEDUP_UPLIFT = fact(3.31, "multiple", {
  kind: "measured",
  source: "pnpm epoch-uplift: 21-draw simulation on the live V2 field (iteration 14: 85 wallets, top-1 32%, "
    + "top-10 79%) under the equal-prize curve — 3.47x at 144 tickets, 3.31x at 500, 2.59x at 2000",
  at: "2026-09-11",
  n: 85,
  stderr: 0.10,
  halfLifeDays: 3,
  recheck: "pnpm epoch-uplift",
});

/** Ticket count at the last COMPLETE epoch draw. Anchors field projection. */
export const EPOCH_LAST_CLOSE_TICKETS = fact(458_473, "tickets", {
  kind: "measured",
  source: "pnpm epoch-history: API epoch/history, iteration 13 (triggered 2026-09-09T18:02Z); "
    + "the six closes before it ranged 174k–693k",
  at: "2026-09-11",
  n: 1,
  halfLifeDays: 3,
  recheck: "pnpm epoch-history",
});

/** Pool at that same draw, USD. */
export const EPOCH_LAST_CLOSE_POOL_USD = fact(11_458, "USD", {
  kind: "measured",
  source: "pnpm epoch-history: pool_combined_usd_amount of iteration 13 at its draw (USD + BTC legs)",
  at: "2026-09-11",
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
export const RUSH_MINT_USD_YIELD = fact(0.0137, "USD of RUSH per USD of gross volume", {
  kind: "measured",
  source: "minted_token_amount × prices.token / total_gross_deployed_usd over V2 rounds 55440–55446 (spot at read)",
  at: "2026-09-11",
  n: 6,
  stderr: 0.00005,
  halfLifeDays: 1,
  recheck: "pnpm v2-strategy",
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
export const SATS_VAULT_CARRY_DAILY = fact(0.0025, "fraction of share value per day", {
  kind: "measured",
  source: "pnpm vault-carry: settlement ratio series, the two 6 h buckets before the V2 cutover " +
    "(2026-09-10 03:17–15:17 UTC, rounds 54286–54916) ran +0.057%/day and +0.276%/day; the 14.5 h to the cutover +0.33%/day. " +
    "V2 day one ran +8–9%/day on 28% of the shares exiting — churn, not a rate (FINDINGS E-v2-carry)",
  at: "2026-09-11",
  n: 22,
  stderr: 0.0012,
  halfLifeDays: 1,
  recheck: "pnpm vault-carry",
});

/**
 * The token vault carry, same mechanism on RUSH-per-share. Day one of the
 * vault: +13.2% in 8.5 h with 57% of the shares exiting (airdrop recipients
 * cashing out through the 10% fee). No steady state exists yet — this is the
 * launch rate, recorded so the ledger can show what it is worth if it held,
 * with a half-life that forces a re-measure before it is believed twice.
 */
export const TOKEN_VAULT_CARRY_DAILY = fact(0.073, "fraction of share value per day", {
  kind: "measured",
  source: "pnpm vault-carry: token settlement ratio series rounds 55124–55574 (2026-09-10/11), base drift excl. >0.5% steps",
  at: "2026-09-11",
  n: 16,
  stderr: 0.03,
  halfLifeDays: 1,
  recheck: "pnpm vault-carry",
});

/**
 * The buybacks fee leg, the part of the 6% layer the API config does not
 * expose. Measured: the treasury received 150 bps against a 100 bps protocol
 * leg in the rotate of round 55435, and round 55437's ledger lists
 * buybacks_fee_usd = 50 bps of gross exactly. Half buys and burns RUSH, half
 * funds staking rewards (BUYBACKS_TO_TOKEN_BPS / _TO_STAKING_BPS, unexported).
 */
export const V2_BUYBACKS_FEE_BPS = fact(50, "bps of gross", {
  kind: "measured",
  source: "round 55437 buybacks_fee_usd / total_gross_deployed_usd; rotate tx 3N5JbUniM9aC… treasury delta",
  at: "2026-09-11",
  n: 2,
  halfLifeDays: null,
  recheck: "curl api.satrush.io/api/v1/rounds/<id> → buybacks_fee_usd",
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
export const SLOT_SECONDS = fact(0.4, "seconds", {
  kind: "measured",
  source: "Solana mainnet target slot time",
  at: "2026-08-01",
  n: 1,
  halfLifeDays: null,
  recheck: "compare block times over a few hundred slots",
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
  SATS_VAULT_CARRY_DAILY,
  TOKEN_VAULT_CARRY_DAILY,
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
