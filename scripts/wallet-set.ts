/**
 * How many wallets, and what each one is worth — the V2 epoch draw with our
 * tickets split, against the last closed field.
 *
 * Under V2 all 21 epoch winners take the same slot and a wallet is drawn at
 * most once, so one wallet's take is capped at 1/21 of the payout however
 * many tickets it holds. A holder who dominates the tickets — which any
 * meaningful volume does against today's field — only collects the pool it
 * funds by holding across several wallets. The owner has approved extra
 * wallets under the operator's own affiliate tag, so this sizes it:
 *
 *   - the field: the last CLOSED iteration's participants (the live one is
 *     partial and has run 16 → 90 entrants over an iteration);
 *   - our tickets: a volume scenario × rounds per iteration × 121 raw/$
 *     (single tile at the streak cap) ÷ 100 raw per ticket;
 *   - for k wallets, the simulated take ± se, and the k-th wallet's marginal
 *     value against its cost in transaction fees;
 *   - the ≤21-participant regime the live iteration is in right now;
 *   - the affiliate rebate on the same volume.
 *
 *   pnpm wallet-set [ourUsdPerRound]     (TX_FEE_USD, SOL not needed)
 */
import { REWARD_MAX_STREAK, TILE_COUNT, hashrateReward } from "@satrush/client";
import {
  AFFILIATE_RATE_BPS,
  RUSH_LAUNCH_PRICE_USD,
  RUSH_MINT_PER_USD_VOLUME,
  VAULT_HASHRATE_PER_TICKET,
} from "../src/strategy/facts.js";
import { evenSplit, everyoneDrawn, simulateSplitTake } from "../src/strategy/wallet-split.js";
import { EPOCH_EQUAL_CURVE_BPS, EPOCH_PAYOUT_FRACTION, EPOCH_REWARD_CURVE_BPS } from "../src/strategy/vault.js";

const BASE = process.env["SATRUSH_API"] ?? "https://api.satrush.io/api/v1";
const OUR_USD_PER_ROUND = Number(process.argv[2] ?? 100);
/** ASSUMED: all-in cost of one transaction (base + priority fee), USD. Two per round per wallet. */
const TX_FEE_USD = Number(process.env["TX_FEE_USD"] ?? 0.005);
const usd = (x: number): string => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(0)}`;
const pct = (x: number, d = 1): string => `${(100 * x).toFixed(d)}%`;
const pad = (s: string, w: number): string => s.padStart(w);
const num = (v: unknown): number => Number(v as string);

interface ApiConfig { epoch_vault_iteration_duration: number; protocol_fee_bps: number; epoch_fee_bps: number }
interface ApiBoard {
  round_duration: number;
  epoch_vault: { iteration_id: number; active_pool_combined_usd_amount: number;
    current_iteration?: { participants_count: number; total_tickets: string } | null };
}
interface Iter { id: number; total_participants: number; total_tickets: string; pool_combined_usd_amount: number | null }
interface Participant { authority: string; tickets: string }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return ((await r.json()) as { data: T }).data;
}

const [conf, board, hist] = await Promise.all([
  get<ApiConfig>("config"), get<ApiBoard>("board"), get<Iter[]>("epoch/history?limit=8"),
]);
const closed = hist.find((h) => h.pool_combined_usd_amount !== null);
if (!closed) throw new Error("no closed iteration in history");
const field = (await get<Participant[]>(`epoch/iterations/${closed.id}/participants?limit=500`))
  .map((p) => num(p.tickets)).filter((t) => t > 0);
const POOL = closed.pool_combined_usd_amount as number;
const roundsPerIteration = Math.round(conf.epoch_vault_iteration_duration / board.round_duration);
const rawPerUsd = Number(hashrateReward(1_000_000n, REWARD_MAX_STREAK, 1, TILE_COUNT, 1_000_000n).total);
const ourVolume = OUR_USD_PER_ROUND * roundsPerIteration;
const ourTickets = Math.floor((ourVolume * rawPerUsd) / VAULT_HASHRATE_PER_TICKET.value);
const fieldTotal = field.reduce((a, b) => a + b, 0);
const slotUsd = (POOL * EPOCH_PAYOUT_FRACTION) / EPOCH_EQUAL_CURVE_BPS.length;
// The pool we would be drawing from includes our OWN epoch leg — the field's
// closed pool understates it, and most of what a dominant holder "takes" is
// its own money coming back. Epoch leg scaled to the announced 6% layer until
// the V2 config is read.
const epochBps = conf.epoch_fee_bps * (600 / 800);
const ourEpochFee = ourVolume * (epochBps / 1e4);
const POOL_WITH_US = POOL + ourEpochFee;
const slotWithUs = (POOL_WITH_US * EPOCH_PAYOUT_FRACTION) / EPOCH_EQUAL_CURVE_BPS.length;

console.log(`══ WALLET SET ·  field = iteration ${closed.id} (${field.length} participants, ` +
  `${fieldTotal.toLocaleString()} tickets, ${usd(POOL)} pool) ══`);
console.log(`  ${roundsPerIteration} rounds per iteration · one flat slot = ${usd(slotUsd)} (90% payout / 21)`);
console.log(`  our own epoch leg on this volume: ${usd(ourEpochFee)} (${epochBps.toFixed(0)} bps) → pool with us in it ` +
  `${usd(POOL_WITH_US)}, a slot ${usd(slotWithUs)}`);
console.log(`  our scenario: $${OUR_USD_PER_ROUND}/round → ${usd(ourVolume)} per iteration → ` +
  `${ourTickets.toLocaleString()} tickets at ${rawPerUsd} raw/$ (single tile, streak cap) = ` +
  `${pct(ourTickets / (ourTickets + fieldTotal))} of all tickets`);
console.log(`  (a blanket earns ${Number(hashrateReward(1_000_000n, REWARD_MAX_STREAK, TILE_COUNT, TILE_COUNT, 1_000_000n).total)} raw/$; ` +
  `the per-wallet single tile is what buys the extra ${pct(rawPerUsd / 101 - 1, 1)})\n`);

// ── the k-wallet table ──────────────────────────────────────────────────────
const feePerWalletIter = 2 * roundsPerIteration * TX_FEE_USD;
console.log("  wallets   take of pool (V2 flat)        $/iteration     marginal $   fees/wallet   net marginal   of our own leg");
let prev = 0;
let lastK = 0;
let best = 1;
for (const k of [1, 2, 3, 5, 8, 13, 21, 34]) {
  const est = simulateSplitTake({ myWallets: evenSplit(ourTickets, k), field, trials: 3_000 });
  const dollars = est.value * POOL_WITH_US;
  const marginal = k === 1 ? dollars : (dollars - prev) / (k - lastK);
  const net = marginal - feePerWalletIter;
  if (k > 1 && net > 0) best = k;
  console.log(`  ${pad(String(k), 7)}   ${pad(`${pct(est.value)} ± ${pct(est.stderr, 2)}`, 26)}   ` +
    `${pad(usd(dollars), 11)}     ${pad(usd(marginal), 10)}   ${pad(usd(feePerWalletIter), 11)}   ${pad(usd(net), 12)}   ` +
    `${pad(pct(ourEpochFee > 0 ? dollars / ourEpochFee : 0, 0), 12)}`);
  prev = dollars;
  lastK = k;
}
const v1 = simulateSplitTake({ myWallets: [ourTickets], field, curve: EPOCH_REWARD_CURVE_BPS, trials: 3_000 });
console.log(`\n  one wallet under V1's rank curve would have taken ${pct(v1.value)} ± ${pct(v1.stderr, 2)} of the pool;`);
console.log(`  under V2's flat curve one wallet is capped at ${pct(EPOCH_PAYOUT_FRACTION / 21, 2)}. Splitting is not an`);
console.log(`  optimisation under V2, it is the only way a large holder collects the pool it funds.`);
console.log(`  "of our own leg" = the take against the epoch fee we paid in: with one wallet a large holder`);
console.log(`  loses nearly all of its ${epochBps.toFixed(0)} bps epoch leg; split enough ways it gets most of it back.`);
console.log(`  Fees assume $${TX_FEE_USD}/tx (ASSUMED — measure; Jito tips would raise it) × 2 tx/round × ${roundsPerIteration} rounds.`);
console.log(`  Last wallet still worth adding at this volume and field: ~${best}.`);
console.log(`  The field will grow if others do the same thing; re-run against each closed iteration.`);

// ── the ≤21 regime, live ────────────────────────────────────────────────────
const live = board.epoch_vault.current_iteration;
const participants = live?.participants_count ?? 0;
console.log(`\n══ RIGHT NOW: iteration ${board.epoch_vault.iteration_id}, ${participants} participants, ` +
  `${usd(board.epoch_vault.active_pool_combined_usd_amount)} active pool ══`);
if (everyoneDrawn(participants)) {
  const room = EPOCH_EQUAL_CURVE_BPS.length - participants;
  console.log(`  With ${participants} ≤ 21 entrants EVERY wallet is drawn and tickets do not matter: a one-ticket`);
  console.log(`  wallet takes a full slot. ${room} more wallets fit before the regime ends. The live field`);
  console.log(`  already holds one-ticket wallets, so others know. Iterations have closed at 75–90`);
  console.log(`  entrants, so by the draw this is usually gone — but a wallet that entered a slot`);
  console.log(`  early keeps its ticket-weighted chance; it just stops being a certainty.`);
} else {
  console.log(`  More than 21 entrants: the draw is ticket-weighted; see the table above.`);
}

// ── the affiliate rebate on the same volume ─────────────────────────────────
const protocolBps = conf.protocol_fee_bps * (600 / 800); // scaled to the announced layer until read from the V2 config
const rebate = ourVolume * (protocolBps / 1e4) * (AFFILIATE_RATE_BPS.value / 1e4);
console.log(`\n══ AFFILIATE REBATE (wallets bound to our tag at their first deploy) ══`);
console.log(`  ${pct(AFFILIATE_RATE_BPS.value / 1e4, 0)} of the protocol leg (~${protocolBps.toFixed(0)} bps scaled from V1's ${conf.protocol_fee_bps}) on ` +
  `${usd(ourVolume)} of referred volume = ${usd(rebate)} of grubstake per iteration`);
console.log(`  = ${pct(rebate / ourVolume, 3)} of volume. Grubstake is bonus USD: rounds only, no hashrate, losing`);
console.log(`  refunds return to it, the winning tile's leg leaves as BTC shares, and it expires. Recycled to`);
console.log(`  exhaustion it is worth roughly 60–80¢ of RUSH+BTC on the dollar (reading A of the winner leg).`);
console.log(`  At $${RUSH_LAUNCH_PRICE_USD.value} the RUSH on the same volume is ` +
  `${usd(ourVolume * RUSH_MINT_PER_USD_VOLUME.value * RUSH_LAUNCH_PRICE_USD.value)} — the rebate is a rounding term next to it.`);
console.log(`\n  Binding: the main wallet claims a tag (set_miner_tag → Affiliate PDA); each new wallet's FIRST`);
console.log(`  deploy passes that PDA as \`affiliate\` and binds for life; points accrue as its deploys settle;`);
console.log(`  exchange_affiliate_points moves them to the main miner's grubstake; deploy_public with`);
console.log(`  is_grubstake_funded=true spends it. A wallet that has already deployed can never be bound.`);
