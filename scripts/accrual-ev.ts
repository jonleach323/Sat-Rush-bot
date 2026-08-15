/**
 * Full-stack EV: what a deploy dollar returns through ALL FIVE channels, not
 * just the board.
 *
 * The board-only frame ("is this board beatable?") prices a deploy against the
 * pot alone and treats the 800 bps deploy legs as rake. They are not rake. Four
 * of the five legs are redistribution, and two of them redistribute on a
 * HASHRATE key rather than a stake key:
 *
 *   protocol  142 bps  → gone (the only true rake on a deploy)
 *   strike    294 bps  → back to winning tiles, on the STAKE key
 *   epoch     232 bps  → back to ticket holders, on the HASHRATE key
 *   one_btc   132 bps  → back to ticket holders, on the HASHRATE key
 *   sats     1200 bps  → back to winning tiles as BTC shares, on the STAKE key
 *
 * You pay into the hashrate-keyed pools in proportion to your VOLUME and draw
 * out of them in proportion to your TICKETS. Hashrate per dollar is
 * (m + 21/n)·promo — up to 121x between a max-streak single-tile deploy and a
 * streak-1 blanket. So the two keys can diverge by two orders of magnitude, and
 * that divergence, not the board, is where a persistent player's edge lives.
 *
 * This script measures both sides against live chain state and prints the
 * break-even streak. Read-only.
 *
 *   pnpm accrual-ev
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import {
  decodeAccount,
  type Board,
  type EpochVault,
  type EpochVaultIteration,
  type Miner,
  type OneBtcVault,
  type OneBtcVaultIteration,
  type SatrushConfig,
  type SatsVault,
} from "../src/adapter/idl.js";
import {
  boardPda,
  roundPda,
  epochVaultIterationPda,
  epochVaultPda,
  minerPda,
  oneBtcVaultIterationPda,
  oneBtcVaultPda,
  satrushConfigPda,
  satsVaultPda,
} from "../src/adapter/pdas.js";
import { epochWinFraction } from "../src/strategy/vault.js";
import { PriceFeed } from "../src/ingest/prices.js";
import { loadKeypair } from "../src/exec/tx.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const BPS = 10_000;
const num = (v: { toString(): string }): number => Number(v.toString());
const usd = (n: number): string => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pct = (n: number): string => `${(100 * n).toFixed(2)}%`;

async function fetchDecoded<T>(name: string, key: PublicKey): Promise<T | null> {
  const info = await conn.getAccountInfo(key, "confirmed");
  return info ? decodeAccount<T>(name, info.data) : null;
}

const [conf, board, ev, obv, sv, slot] = await Promise.all([
  fetchDecoded<SatrushConfig>("SatrushConfig", satrushConfigPda(pid)),
  fetchDecoded<Board>("Board", boardPda(pid)),
  fetchDecoded<EpochVault>("EpochVault", epochVaultPda(pid)),
  fetchDecoded<OneBtcVault>("OneBtcVault", oneBtcVaultPda(pid)),
  fetchDecoded<SatsVault>("SatsVault", satsVaultPda(pid)),
  conn.getSlot("confirmed"),
]);
if (!conf || !board || !ev) throw new Error("core accounts unavailable");

const epochIt = await fetchDecoded<EpochVaultIteration>(
  "EpochVaultIteration",
  epochVaultIterationPda(ev.iteration_id, pid),
);
const oneBtcIt = obv
  ? await fetchDecoded<OneBtcVaultIteration>(
      "OneBtcVaultIteration",
      oneBtcVaultIterationPda(obv.iteration_id, pid),
    )
  : null;

// Live BTC price — the epoch pool and the 1-BTC prize are partly BTC-denominated.
const prices = new PriceFeed({
  connection: conn,
  accounts: {
    btc: cfg.PYTH_BTC_USD_ACCOUNT ? new PublicKey(cfg.PYTH_BTC_USD_ACCOUNT) : undefined,
    sol: cfg.PYTH_SOL_USD_ACCOUNT ? new PublicKey(cfg.PYTH_SOL_USD_ACCOUNT) : undefined,
  },
  fallback: { btc: cfg.BTC_USD_ESTIMATE, sol: cfg.SOL_USD_ESTIMATE },
  maxStaleSlots: cfg.PRICE_MAX_STALE_SLOTS,
  maxConfidenceRatio: cfg.PRICE_MAX_CONFIDENCE_RATIO,
  log: () => {},
});
await prices.refresh();
const btcUsd = prices.btcUsd();

// ── the five legs ────────────────────────────────────────────────────────────
const legs = {
  strike: conf.strike_fee_bps,
  epoch: conf.epoch_fee_bps,
  oneBtc: conf.one_btc_fee_bps,
  protocol: conf.protocol_fee_bps,
  sats: conf.sats_vault_round_fee_bps,
  satsClaim: conf.sats_vault_claim_fee_bps,
};
const deployLegs = legs.strike + legs.epoch + legs.oneBtc + legs.protocol;
const netFactor = 1 - deployLegs / BPS;
// The sats leg comes back to the same winners; only the claim fee on it is lost.
const satsLoss = (legs.sats / BPS) * (legs.satsClaim / BPS);
const stakeKeyReturn = netFactor * (1 - satsLoss);
const hashrateKeyBps = legs.epoch + legs.oneBtc;
const trueRakeBps = legs.protocol + Math.round(satsLoss * BPS);

console.log("═══ fee legs (live SatrushConfig) ═══");
for (const [k, v] of Object.entries(legs)) console.log(`  ${k.padEnd(10)} ${v} bps`);
console.log(`  deploy legs total ${deployLegs} bps → netFactor ${netFactor.toFixed(4)}`);
console.log(`\n  stake-keyed return per $1 (board pot + sats shares): ${stakeKeyReturn.toFixed(4)}`);
console.log(`  hashrate-keyed redistribution:  ${hashrateKeyBps} bps`);
console.log(`  strike (stake-keyed, lumpy):    ${legs.strike} bps`);
console.log(`  TRUE RAKE:                      ${trueRakeBps} bps  (${pct(trueRakeBps / BPS)})`);
console.log(`  → ${pct(1 - trueRakeBps / BPS)} of every deploy dollar flows back to players`);

// ── epoch vault: pool, field, price per ticket ───────────────────────────────
const epochPoolUsd =
  num(ev.pool_usd_amount) / 1e6 + (num(ev.pool_btc_amount) / 1e8) * btcUsd;
const epochTotalTickets = epochIt ? num(epochIt.total_tickets) : 0;
const epochParticipants = epochIt ? epochIt.participants_count : 0;
const iterationSlots = num(conf.epoch_vault_iteration_duration);
const roundsPerIteration = iterationSlots / (board.round_duration || 1);

console.log("\n═══ epoch vault (iteration " + ev.iteration_id + ") ═══");
console.log(`  pool           ${usd(epochPoolUsd)}`);
console.log(`  total tickets  ${epochTotalTickets.toLocaleString()}`);
console.log(`  participants   ${epochParticipants}`);
console.log(`  iteration      ${iterationSlots.toLocaleString()} slots ≈ ${roundsPerIteration.toFixed(0)} rounds`);
if (epochTotalTickets > 0) {
  const perTicket = epochWinFraction(1 / epochTotalTickets) * epochPoolUsd;
  console.log(`  marginal ticket EV  ${usd(perTicket)}`);
  console.log(`  → per RAW hashrate unit: ${usd(perTicket / cfg.VAULT_HASHRATE_PER_TICKET)}`);
}

// ── 1-BTC vault ──────────────────────────────────────────────────────────────
if (obv && oneBtcIt) {
  const prizeBtc = Math.max(0, num(obv.btc_amount) - num(obv.reserved_btc_amount));
  const prizeUsd = (prizeBtc / 1e8) * btcUsd;
  const tickets = num(oneBtcIt.total_tickets);
  console.log("\n═══ 1-BTC vault (iteration " + obv.iteration_id + ") ═══");
  console.log(`  prize          ${(prizeBtc / 1e8).toFixed(6)} BTC = ${usd(prizeUsd)}`);
  console.log(`  fill           ${pct(prizeBtc / (cfg.VAULT_ONE_BTC_TARGET_BTC * 1e8))}`);
  console.log(`  total tickets  ${tickets.toLocaleString()}`);
  if (tickets > 0) {
    console.log(`  marginal ticket EV  ${usd(prizeUsd / tickets)}`);
  }
}

// ── our position ─────────────────────────────────────────────────────────────
let myStreak = 1;
{
  const me = await fetchDecoded<Miner>(
    "Miner",
    minerPda(loadKeypair(cfg.KEYPAIR_PATH).publicKey, pid),
  );
  if (me) {
    myStreak = me.current_streak_count;
    console.log("\n═══ our miner ═══");
    console.log(`  streak            ${me.current_streak_count}`);
    console.log(`  hashrate          ${(num(me.hashrate_amount) / 100).toFixed(2)} points`);
    console.log(`  unclaimed HR      ${(num(me.unclaimed_hashrate) / 100).toFixed(2)} points`);
    console.log(`  unclaimed USD     ${usd(num(me.unclaimed_usd_amount) / 1e6)}`);
    console.log(`  unclaimed shares  ${num(me.unclaimed_btc_shares).toLocaleString()}`);
  }
}

// ── the decision: full-stack return per deploy dollar ────────────────────────
//
// Per $1 gross deployed on n tiles at streak m with promo P:
//   stake-keyed  : stakeKeyReturn (assumes we are small vs the tile, uniform board)
//   hashrate     : R = (m + 21/n)·P raw units, of which (1 - unclaimed_bps) is
//                  liquid now; each raw unit is worth `perRaw` via the vaults.
// The stake-keyed term already nets out the epoch/one_btc/protocol legs, so the
// hashrate term is pure addition on top.
const perRaw =
  epochTotalTickets > 0
    ? (epochWinFraction(1 / epochTotalTickets) * epochPoolUsd) / cfg.VAULT_HASHRATE_PER_TICKET
    : 0;
const liquidFrac = 1 - conf.unclaimed_hashrate_bps / BPS;

// ── the blanket identity ─────────────────────────────────────────────────────
//
// Covering all 21 tiles evenly makes the board return EXACTLY size-neutral: on
// a uniform board the pot share equals the stake share whichever tile wins, so
// E = stakeKeyReturn · d for any d, with ZERO variance. That is usually quoted
// as the curse that caps the game ("you cannot beat a blanket"). Read the other
// way it is the enabling fact for accrual farming: the board becomes a toll
// booth with a FIXED, size-independent price, and what it sells is hashrate.
// The strike leg is ALSO stake-keyed: 294 bps in, paid back to winning tiles
// pro-rata. A blanket holds its stake share of every tile, so it recovers its
// own contribution in expectation (less the fraction retained at trigger, which
// rolls over rather than leaking). Counting strike as pure cost — as the first
// cut of this script did — overstates the toll by ~274 bps, nearly a third of it.
const strikeRecovery = (legs.strike / BPS) * cfg.STRIKE_PAYOUT_FRACTION;
const tollPerDollar = 1 - stakeKeyReturn - strikeRecovery;
// Hashrate per dollar at full streak, blanketing. The skill term (21/n) is only
// +21 at n=1 vs +1 at n=21 — decisive at streak 1, nearly irrelevant at streak
// 100 (121 vs 101, a 17% gap). So a maxed streak buys the right to spread wide
// and shed all dilution risk for almost nothing.
const kBlanket = 100 + 21 / 21;
const liquidRawPerDollar = kBlanket * liquidFrac;
console.log("\n═══ the board as a hashrate vending machine ═══");
console.log(`  stake-keyed return ${pct(stakeKeyReturn)} + strike recovery ${pct(strikeRecovery)}`);
console.log(`  blanket toll (size-independent, zero variance): ${pct(tollPerDollar)} of gross`);
console.log(`  raw hashrate per $ at streak 100, n=21:         ${kBlanket.toFixed(0)} (${liquidRawPerDollar.toFixed(1)} liquid)`);
console.log(`  → cost per liquid raw unit:  ${usd(tollPerDollar / liquidRawPerDollar)}`);
console.log(`  → cost per epoch TICKET:     ${usd((tollPerDollar / liquidRawPerDollar) * cfg.VAULT_HASHRATE_PER_TICKET)}`);
console.log(`  at streak 1 instead:         ${usd((tollPerDollar / ((1 + 1) * liquidFrac)) * cfg.VAULT_HASHRATE_PER_TICKET)} per ticket (${((100 + 1) / (1 + 1)).toFixed(0)}x worse)`);

// ── optimal persistent size ──────────────────────────────────────────────────
//
// Sweep deploy-per-round. Three things move together and none can be dropped:
//   1. our tickets grow linearly with volume;
//   2. the epoch pool grows too — 232 bps of OUR OWN volume feeds it;
//   3. our share of the pool is CONCAVE (wallet dedup: one wallet wins once).
// (2) is why this is not a pure dilution story and (3) is why it still has an
// interior optimum. Pricing the marginal ticket at today's average — what the
// naive table does — ignores both and overstates the answer by orders of magnitude.
// How far through the iteration are we? Everything above is a PARTIAL count if
// the window is young, and the optimum scales with the full-iteration pool.
const elapsedSlots = slot - num(ev.last_trigger_slot);
const progress = iterationSlots > 0 ? Math.min(1, Math.max(0, elapsedSlots / iterationSlots)) : 1;

// Volume is MEASURED off recent Round accounts, not inferred from the pool.
// Inferring it from a 7%-elapsed pool gave $1.86M/day and implied the 1-BTC
// vault would fill in 3 days — flatly contradicted by it sitting at 2% after
// weeks. Read the rounds instead. (Most are settled and rent-reclaimed, so the
// readable sample is small and recent; it is still a direct observation.)
const headRound = board.round_id;
const sampleIds: number[] = [];
for (let i = 1; i <= 120; i++) if (headRound - i > 0) sampleIds.push(headRound - i);
const roundUsd: number[] = [];
for (let i = 0; i < sampleIds.length; i += 100) {
  const chunk = sampleIds.slice(i, i + 100);
  const infos = await conn.getMultipleAccountsInfo(
    chunk.map((id) => roundPda(id, pid)),
    "confirmed",
  );
  for (const info of infos) {
    if (!info) continue;
    const r = decodeAccount<{ deployed_usd_amount: { toString(): string } }>("Round", info.data);
    const v = num(r.deployed_usd_amount) / 1e6;
    if (v > 0) roundUsd.push(v);
  }
}
const meanRoundUsd = roundUsd.length
  ? roundUsd.reduce((a, b) => a + b, 0) / roundUsd.length
  : 0;
const volumePerIteration = meanRoundUsd * roundsPerIteration;
const epochInflow = volumePerIteration * (legs.epoch / BPS);
// Pool at close = what is banked now + the inflow still to come. The carry
// implied by the difference is the 10% rollover, which is why the pool is
// already non-trivial at 7% elapsed.
const projectedPool = epochPoolUsd + (1 - progress) * epochInflow;
const carry = Math.max(0, epochPoolUsd - progress * epochInflow);
// Field tickets must be extrapolated on the SAME basis as the pool, or the
// optimum is nonsense: leaving them at today's partial count while inflating
// the pool is what produced the "$25/round → +$41k" answer on the first pass.
const projectedFieldTickets = progress > 0.02 ? epochTotalTickets / progress : epochTotalTickets;
const fieldRawPerDollar =
  progress * volumePerIteration > 0
    ? (epochTotalTickets * cfg.VAULT_HASHRATE_PER_TICKET) / (progress * volumePerIteration)
    : 0;

console.log("\n═══ optimal persistent size (epoch channel) ═══");
console.log(`  iteration progress   ${pct(progress)} (${elapsedSlots.toLocaleString()} / ${iterationSlots.toLocaleString()} slots)`);
console.log(`  MEASURED volume      ${usd(meanRoundUsd)}/round over ${roundUsd.length} readable rounds`);
console.log(`                       = ${usd(volumePerIteration)}/iteration (${usd(meanRoundUsd * 1440)}/day)`);
console.log(`  epoch inflow         ${usd(epochInflow)}/iteration @ ${legs.epoch} bps`);
console.log(`  pool now ${usd(epochPoolUsd)} = carry ${usd(carry)} + ${pct(progress)} of inflow`);
console.log(`  → pool at close      ${usd(projectedPool)}`);
console.log(`  field tickets        ${epochTotalTickets.toLocaleString()} now → ~${Math.round(projectedFieldTickets).toLocaleString()} at close (${epochParticipants} wallets)`);
console.log(`  field hashrate rate  ${fieldRawPerDollar.toFixed(1)} raw/$ vs our ${liquidRawPerDollar.toFixed(1)} at streak 100`);
console.log(`  → our edge ratio ρ = ${(liquidRawPerDollar / Math.max(0.01, fieldRawPerDollar)).toFixed(2)}x\n`);
console.log("   $/round   $/iteration    our tickets   share   epoch take    toll     net");
let best = { perRound: 0, net: -Infinity, share: 0 };
for (const perRound of [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500]) {
  const volume = perRound * roundsPerIteration;
  const myTickets = (volume * kBlanket * liquidFrac) / cfg.VAULT_HASHRATE_PER_TICKET;
  // Our own epoch fees swell the pool we are drawing from.
  const pool = projectedPool + volume * (legs.epoch / BPS);
  const share = myTickets / (myTickets + projectedFieldTickets);
  const take = epochWinFraction(share, cfg.EPOCH_DEDUP_UPLIFT) * pool;
  const toll = volume * tollPerDollar;
  const net = take - toll;
  if (net > best.net) best = { perRound, net, share };
  console.log(
    `  ${("$" + perRound).padStart(7)}   ${usd(volume).padStart(11)}   ` +
      `${Math.round(myTickets).toLocaleString().padStart(11)}   ${pct(share).padStart(6)}   ` +
      `${usd(take).padStart(9)}   ${usd(toll).padStart(8)}   ${(net >= 0 ? "+" : "") + usd(net)}`,
  );
}
console.log(`\n  best: ${usd(best.perRound)}/round → ${(best.net >= 0 ? "+" : "") + usd(best.net)} per 3-day iteration ` +
  `(${usd(best.net / 3)}/day) at ${pct(best.share)} ticket share`);

// ── is the 1-BTC vault's headline ticket price real? ─────────────────────────
//
// Its marginal ticket looks far richer than epoch's, but that number divides
// TODAY's small prize by TODAY's small ticket count — and you cannot collect
// until the vault fills to a whole BTC. Both the prize AND the field grow in
// the meantime, so the honest comparison is at the draw, not now.
if (obv && oneBtcIt) {
  const prizeBtc = Math.max(0, num(obv.btc_amount) - num(obv.reserved_btc_amount));
  const targetBtc = cfg.VAULT_ONE_BTC_TARGET_BTC * 1e8;
  const accrualUsdPerDay = meanRoundUsd * 1440 * (legs.oneBtc / BPS);
  const remainingUsd = ((targetBtc - prizeBtc) / 1e8) * btcUsd;
  const daysToFill = accrualUsdPerDay > 0 ? remainingUsd / accrualUsdPerDay : Infinity;
  const tickets = num(oneBtcIt.total_tickets);
  // Field ticket growth, extrapolated at the observed rate over the fill horizon.
  const ticketsAtFill = tickets * (1 + daysToFill / Math.max(1, progress * 3));
  console.log("\n═══ 1-BTC vault: headline price vs. price at the draw ═══");
  console.log(`  accrual ${usd(accrualUsdPerDay)}/day → fills in ~${daysToFill.toFixed(0)} days`);
  console.log(`  headline marginal ticket today:  ${usd((prizeBtc / 1e8) * btcUsd / Math.max(1, tickets))}`);
  console.log(`  prize at fill: ${usd(btcUsd)} vs ~${Math.round(ticketsAtFill).toLocaleString()} tickets`);
  console.log(`  → marginal ticket at the draw:   ${usd(btcUsd / Math.max(1, ticketsAtFill))} (undiscounted)`);
  console.log(`  the ${cfg.VAULT_ONE_BTC_MIN_FILL_BPS} bps fill gate is therefore doing real work —`);
  console.log(`  it keeps a ~${(daysToFill / 365).toFixed(1)}-year-dated claim out of per-round EV.`);
}

// What the live model credits, for contrast.
const monetisable =
  (cfg.VAULT_MAX_TICKETS * cfg.VAULT_HASHRATE_PER_TICKET) / roundsPerIteration;
const earnedAtBest = best.perRound * kBlanket;
console.log(`\n═══ what the live model credits ═══`);
console.log(`  monetisableRawPerRound cap = ${monetisable.toFixed(2)} raw`);
console.log(`  optimal deploy earns ${earnedAtBest.toFixed(0)} raw/round`);
console.log(`  → credited fraction: ${pct(Math.min(1, monetisable / earnedAtBest))}  (the rest is priced at zero)`);
console.log(`  our streak: ${myStreak} — every missed round resets it to 1`);
