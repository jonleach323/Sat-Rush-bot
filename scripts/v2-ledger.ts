/**
 * Is V2 +EV? Every leg, per dollar of gross volume, on one page.
 *
 * Earlier passes priced the legs separately and against different tolls:
 * "−4.4% board-only" wrote off every fee leg, "+0.9% all-in" assumed every
 * leg recycles pro-rata — and the epoch leg does not under equal prizes
 * unless the tickets are split across wallets. This composes them:
 *
 *   in:   100% of gross
 *   back: 1 − fee layer from the USD/BTC legs (refunds + own stake + sats slice)
 *         + RUSH minted on the volume, at a price
 *         + the strike leg, at its payout fraction, pro-rata in expectation
 *         + the epoch leg × the fraction the wallet set recovers (simulated)
 *         + the 1-BTC leg × our ticket share
 *         + the affiliate rebate on the protocol leg, as grubstake
 *         − transaction fees
 *   never: the protocol leg net of the rebate; the buybacks leg if any
 *
 * Expectation only. The strike (1-in-1440) and 1-BTC (one winner) legs are
 * lumpy; the vault carry (other people's exit fees) is left OUT because it is
 * unmeasured for the token vault — it can only add. Every scenario column is
 * labelled; nothing here is a forecast of the RUSH price.
 *
 *   pnpm v2-ledger [usdPerRound] [wallets]
 */
import { REWARD_MAX_STREAK, TILE_COUNT, hashrateReward } from "@satrush/client";
import {
  AFFILIATE_RATE_BPS, RUSH_LAUNCH_PRICE_USD, RUSH_MINT_PER_USD_VOLUME, STRIKE_PAYOUT_FRACTION,
  TOKEN_SPLIT_EPOCH_BPS, TOKEN_SPLIT_LOSERS_BPS, TOKEN_SPLIT_STRIKE_BPS, TOKEN_SPLIT_WINNERS_BPS,
  V2_DEPLOY_FEE_LAYER_BPS, VAULT_HASHRATE_PER_TICKET,
} from "../src/strategy/facts.js";
import { evenSplit, simulateSplitTake } from "../src/strategy/wallet-split.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const USD_PER_ROUND = Number(process.argv[2] ?? 1000);
const WALLETS = Number(process.argv[3] ?? 21);
const TX_FEE_USD = Number(process.env["TX_FEE_USD"] ?? 0.005); // ASSUMED
const GRUBSTAKE_WORTH = 0.7; // ASSUMED: cents on the dollar a recycled grubstake returns as RUSH+BTC
const pct = (x: number, d = 2): string => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}%`;
const pad = (s: string, w: number): string => s.padStart(w);
const num = (v: unknown): number => Number(v as string);

interface ApiConfig { strike_fee_bps: number; epoch_fee_bps: number; one_btc_fee_bps: number; protocol_fee_bps: number;
  buybacks_fee_bps?: number; epoch_vault_iteration_duration: number }
interface ApiBoard { round_duration: number }
interface Iter { id: number; pool_combined_usd_amount: number | null }
interface Participant { tickets: string }
const get = async <T>(p: string): Promise<T> =>
  ((await (await fetch(`${BASE}/${p}`, { signal: AbortSignal.timeout(15_000) })).json()) as { data: T }).data;

const [conf, board, hist] = await Promise.all([get<ApiConfig>("config"), get<ApiBoard>("board"), get<Iter[]>("epoch/history?limit=8")]);
const closed = hist.find((h) => h.pool_combined_usd_amount !== null)!;
const field = (await get<Participant[]>(`epoch/iterations/${closed.id}/participants?limit=500`)).map((p) => num(p.tickets)).filter((t) => t > 0);

// Fee legs: the live (V1) split scaled to the announced layer until the V2 config is read.
const v1Layer = conf.strike_fee_bps + conf.epoch_fee_bps + conf.one_btc_fee_bps + conf.protocol_fee_bps;
const isV2 = conf.buybacks_fee_bps !== undefined;
const scale = isV2 ? 1 : V2_DEPLOY_FEE_LAYER_BPS.value / v1Layer;
const leg = { strike: conf.strike_fee_bps * scale, epoch: conf.epoch_fee_bps * scale, oneBtc: conf.one_btc_fee_bps * scale,
  protocol: conf.protocol_fee_bps * scale, buybacks: conf.buybacks_fee_bps ?? 0 };
const layer = leg.strike + leg.epoch + leg.oneBtc + leg.protocol + leg.buybacks;

// Epoch recovery from the wallet-set simulation at this volume.
const rounds = Math.round(conf.epoch_vault_iteration_duration / board.round_duration);
const volume = USD_PER_ROUND * rounds;
const rawPerUsd = Number(hashrateReward(1_000_000n, REWARD_MAX_STREAK, 1, TILE_COUNT, 1_000_000n).total);
const ourTickets = Math.floor((volume * rawPerUsd) / VAULT_HASHRATE_PER_TICKET.value);
const fieldTickets = field.reduce((a, b) => a + b, 0);
const ourEpochFee = volume * (leg.epoch / 1e4);
const poolWithUs = (closed.pool_combined_usd_amount as number) + ourEpochFee;
const recovery = (k: number): { frac: number; se: number } => {
  const est = simulateSplitTake({ myWallets: evenSplit(ourTickets, k), field, trials: 3_000 });
  return { frac: (est.value * poolWithUs) / ourEpochFee, se: (est.stderr * poolWithUs) / ourEpochFee };
};
const ticketShare = ourTickets / (ourTickets + fieldTickets);
const feesPerVolume = (WALLETS * 2 * rounds * TX_FEE_USD) / volume;
const rushBackNow = (TOKEN_SPLIT_WINNERS_BPS.value + TOKEN_SPLIT_LOSERS_BPS.value) / 1e4;
const rushBackLater = (TOKEN_SPLIT_STRIKE_BPS.value + TOKEN_SPLIT_EPOCH_BPS.value) / 1e4;

console.log(`══ V2 LEDGER per $1 of gross volume · $${USD_PER_ROUND}/round · ${WALLETS} wallets · ` +
  `fee split ${isV2 ? "from the V2 config" : `scaled from V1's ${v1Layer} bps to ${layer.toFixed(0)}`} ══`);
console.log(`  field: iteration ${closed.id}, ${field.length} wallets; our ticket share ${(100 * ticketShare).toFixed(1)}%\n`);

function ledger(opts: { price: number; wallets: number; strikeRecovery: number; buybacksLeak: boolean }): { rows: [string, number, string][]; net: number } {
  const y = RUSH_MINT_PER_USD_VOLUME.value * opts.price;
  const rec = recovery(opts.wallets);
  const rows: [string, number, string][] = [
    ["USD/BTC legs back (refunds, own stake, sats slice)", 1 - layer / 1e4, "exact at a uniform board"],
    [`RUSH now (80% of mint) at $${opts.price}`, rushBackNow * y, "stated rate × scenario price"],
    [`RUSH later (strike 14% + epoch 6%) at $${opts.price}`, rushBackLater * y * (0.7 + 0.3 * rec.frac), "pro-rata in expectation; epoch part × recovery"],
    [`strike leg × ${opts.strikeRecovery} payout`, (leg.strike / 1e4) * opts.strikeRecovery, "1-in-1440, lumpy; pro-rata in expectation"],
    [`epoch leg × ${(100 * rec.frac).toFixed(0)}% recovered (${opts.wallets} wallet${opts.wallets > 1 ? "s" : ""})`, (leg.epoch / 1e4) * rec.frac, `simulated ± ${(100 * rec.se).toFixed(1)} pts`],
    [`1-BTC leg × ${(100 * ticketShare).toFixed(0)}% ticket share`, (leg.oneBtc / 1e4) * ticketShare, "one winner per ~1 BTC of inflow; lumpy"],
    ["affiliate rebate as grubstake", (leg.protocol / 1e4) * (AFFILIATE_RATE_BPS.value / 1e4) * GRUBSTAKE_WORTH, `10% of protocol leg × ${GRUBSTAKE_WORTH} ASSUMED worth`],
    ["transaction fees", -feesPerVolume, `$${TX_FEE_USD}/tx ASSUMED × 2/round × ${opts.wallets} wallets`],
    ["protocol leg (the leak)", 0, `−${(leg.protocol / 100).toFixed(2)}% already inside the layer above`],
    ["buybacks leg", opts.buybacksLeak ? -0 : 0, isV2 ? `${leg.buybacks} bps` : "unknown until the V2 config; inside the 6% if it exists"],
  ];
  const net = rows.reduce((a, r) => a + r[1], 0) - 1;
  return { rows, net };
}

const base = ledger({ price: RUSH_LAUNCH_PRICE_USD.value, wallets: WALLETS, strikeRecovery: STRIKE_PAYOUT_FRACTION.value, buybacksLeak: true });
console.log("  leg                                                    per $      note");
for (const [name, v, note] of base.rows) console.log(`  ${name.padEnd(52)} ${pad(pct(v), 8)}   ${note}`);
console.log(`  ${"".padEnd(52)} ${"".padEnd(8)}`);
console.log(`  ${"NET, expectation, before the vault carry".padEnd(52)} ${pad(pct(base.net), 8)}`);

console.log(`\n══ SENSITIVITY (net per $, expectation) ══`);
console.log("  RUSH price     1 wallet, strike 0.70   21 wallets, strike 0.70   21 wallets, strike 0.95");
for (const price of [0, 5, 7, 10, 15, 20]) {
  const a = ledger({ price, wallets: 1, strikeRecovery: 0.70, buybacksLeak: true }).net;
  const b = ledger({ price, wallets: 21, strikeRecovery: 0.70, buybacksLeak: true }).net;
  const c = ledger({ price, wallets: 21, strikeRecovery: 0.95, buybacksLeak: true }).net;
  console.log(`  ${pad(`$${price}`, 10)}     ${pad(pct(a), 20)}   ${pad(pct(b), 22)}   ${pad(pct(c), 22)}`);
}
const be = (wallets: number, strike: number): number => {
  let lo = 0, hi = 200;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (ledger({ price: mid, wallets, strikeRecovery: strike, buybacksLeak: true }).net < 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
};
console.log(`\n  break-even RUSH price: 1 wallet $${be(1, 0.7).toFixed(2)} · 21 wallets $${be(21, 0.7).toFixed(2)} (strike 0.70) · $${be(21, 0.95).toFixed(2)} (strike 0.95)`);
console.log(`\n  Left out, each can only ADD: the vault carry (claimers' 10% exit fees accrue to holders; the API`);
console.log(`  reports a sats-vault APR but our share of it is unmeasured), the strike buffer's eventual return,`);
console.log(`  and any board edge. Left out, each can only SUBTRACT: a buybacks leg carved from the 6%, Jito tips`);
console.log(`  above $${TX_FEE_USD}/tx, RUSH slippage on realisation, and the mint rate falling under the "complex algo".`);
console.log(`  Variance: the strike and 1-BTC legs together are ${((leg.strike + leg.oneBtc) / 100).toFixed(2)}% of volume paid in lumps; over one`);
console.log(`  iteration (${rounds} rounds) the strike fires ~${(rounds / 1440).toFixed(0)} times. Expect the realised figure to swing ±2 pts per iteration.`);
