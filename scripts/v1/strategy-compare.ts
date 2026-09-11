/**
 * Head-to-head strategy backtest on RECONSTRUCTED boards, all costs included.
 *
 * Every strategy claim in this repo so far has been argued from one channel in
 * isolation — the board toll here, the epoch pool there — and never scored
 * against the others on the same rounds with the same fee model. This does
 * that, on real historical boards, so the comparison is decided by data rather
 * than by whichever channel was most recently analysed.
 *
 * VALIDATED: replaying a round's deploy events and summing gross reproduces
 * Round.deployed_usd_amount x 1.250 on every round checked, i.e. exactly
 * 1/0.8 — the account records the 8000 bps pot leg, the event records gross.
 * Two consequences: the replay is complete (a constant ratio means nothing is
 * being dropped), and any volume figure taken from Round.deployed_usd_amount
 * and called "gross" is 25% low.
 *
 * Boards are rebuilt from PublicDeployCreated, which carries selection_mask and
 * total_stake_usd_amount; the program splits a deploy evenly across its masked
 * tiles, so replaying the events reconstructs the exact final per-tile stakes.
 * RoundRevealed supplies the winning tile, so payouts are settled against what
 * actually happened rather than against a 1/21 expectation.
 *
 * KNOWN OMISSION: realised() credits the pot and the sats leg but NOT the strike
 * bonus, which pays back ~274 bps of gross to whoever holds the winning tile.
 * Every deploying strategy below is therefore ~2.7% of volume worse than
 * reality; the ranking is unaffected because it hits all of them equally.
 *
 * Costs charged to every strategy, per deploying wallet per round:
 *   - 5,000 lamport signature
 *   - priority fee = cu_price x DEPLOY_CU_LIMIT
 *   - Jito tip (base; the EV-scaled part is added per round from modelled EV)
 *   - a second 5,000 lamport signature when SELF_SETTLE is on
 *
 *   pnpm strategy-compare [rounds]
 */
import { createRequire } from "node:module";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../../src/config.js";
import { decodeAccount, type Board, type SatrushConfig } from "../../src/adapter/idl.js";
import { parseCpiEventData } from "../../src/ingest/events.js";
import { boardPda, satrushConfigPda } from "../../src/adapter/pdas.js";
import { PriceFeed } from "../../src/ingest/prices.js";
import { EPOCH_REWARD_CURVE_BPS } from "../../src/strategy/vault.js";
import { evOfAllocation, feeModelFromConfig, STRIKE_PAYOUT_FRACTION, TILES_COUNT, type EvContext } from "../../src/strategy/ev.js";
import { selectAllocation } from "../../src/strategy/selector.js";
import { readEpochField, resampleField } from "../../src/ingest/epoch-field.js";
import { UNCLAIMED_HASHRATE_UPLIFT } from "../../src/strategy/facts.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const num = (v: unknown): number => Number((v as { toString(): string }).toString());
const ROUNDS_WANTED = Number(process.argv[2] ?? 250);

const confInfo = await conn.getAccountInfo(satrushConfigPda(pid), "confirmed");
const boardInfo = await conn.getAccountInfo(boardPda(pid), "confirmed");
if (!confInfo || !boardInfo) throw new Error("core accounts unavailable");
const conf = decodeAccount<SatrushConfig>("SatrushConfig", confInfo.data);
const board = decodeAccount<Board>("Board", boardInfo.data);
const fees = feeModelFromConfig(conf);

const prices = new PriceFeed({
  connection: conn,
  accounts: {
    btc: cfg.PYTH_BTC_USD_ACCOUNT ? new PublicKey(cfg.PYTH_BTC_USD_ACCOUNT) : undefined,
    sol: cfg.PYTH_SOL_USD_ACCOUNT ? new PublicKey(cfg.PYTH_SOL_USD_ACCOUNT) : undefined,
  },
  fallback: { btc: cfg.BTC_USD_ESTIMATE, sol: cfg.SOL_USD_ESTIMATE },
  log: () => {},
});
await prices.refresh();
const SOL = prices.solUsd();

// ── reconstruct boards from deploy events ────────────────────────────────────
// Deploys write the ROUND PDA, not the Board — scanning board signatures drops
// roughly a third of them and reconstructs a board that never existed. Walk the
// round PDAs directly instead: one signature query per round, complete by
// construction.
const { roundPda } = await import("../../src/adapter/pdas.js");
const headRound = board.round_id;
const roundIds: number[] = [];
for (let i = 1; i <= ROUNDS_WANTED; i++) if (headRound - i > 0) roundIds.push(headRound - i);

const sigs: { sig: string; slot: number }[] = [];
for (let i = 0; i < roundIds.length; i += 8) {
  await Promise.all(
    roundIds.slice(i, i + 8).map(async (id) => {
      let before: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await conn.getSignaturesForAddress(
          roundPda(id, pid), { limit: 1000, ...(before ? { before } : {}) }, "confirmed",
        );
        if (res.length === 0) break;
        for (const x of res) if (!x.err) sigs.push({ sig: x.signature, slot: x.slot });
        if (res.length < 1000) break;
        before = res[res.length - 1]?.signature;
      }
    }),
  );
}
console.log(`${sigs.length.toLocaleString()} round signatures over ${roundIds.length} rounds; decoding…`);

interface Round { stakes: number[]; gross: number; winner: number | null }
const rounds = new Map<number, Round>();
const get = (id: number): Round => {
  let r = rounds.get(id);
  if (!r) { r = { stakes: new Array<number>(TILES_COUNT).fill(0), gross: 0, winner: null }; rounds.set(id, r); }
  return r;
};

for (let i = 0; i < sigs.length; i += 50) {
  const txs = await conn.getTransactions(sigs.slice(i, i + 50).map((s) => s.sig), {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  });
  for (const tx of txs) {
    if (!tx) continue;
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
    });
    for (const inner of tx.meta?.innerInstructions ?? []) {
      for (const ix of inner.instructions) {
        if (keys.get(ix.programIdIndex)?.toBase58() !== pid.toBase58()) continue;
        let data: Uint8Array;
        try { data = bs58.decode(ix.data); } catch { continue; }
        const e = parseCpiEventData(data, tx.slot, "");
        if (!e) continue;
        const d = e.data as Record<string, unknown>;
        if (e.name === "PublicDeployCreated") {
          const id = Number(d["round_id"] ?? -1);
          const mask = Number(d["selection_mask"] ?? 0);
          const net = num(d["total_stake_usd_amount"] ?? 0);
          const gross = num(d["deployed_usd_amount"] ?? 0);
          const tiles: number[] = [];
          for (let t = 0; t < TILES_COUNT; t++) if (mask & (1 << t)) tiles.push(t);
          if (tiles.length === 0) continue;
          const r = get(id);
          const per = net / tiles.length;
          for (const t of tiles) r.stakes[t] = (r.stakes[t] ?? 0) + per;
          r.gross += gross;
        } else if (e.name === "RoundRevealed") {
          const id = Number(d["round_id"] ?? -1);
          get(id).winner = Number(d["winning_tile"] ?? -1);
        }
      }
    }
  }
  if (i % 2000 === 0 && i > 0) process.stdout.write(`\r  ${i}/${sigs.length}…`);
}

const usable = [...rounds.entries()]
  .filter(([, r]) => r.winner !== null && r.winner >= 0 && r.gross > 0)
  .sort((a, b) => a[0] - b[0]);
console.log(`\rreconstructed ${usable.length} complete rounds                     `);
// Reconstruction sanity: board size must match the ~$585/round measured off
// Round accounts. If it does not, the event replay is dropping deploys and
// every strategy number below is scored against a board that never existed.
{
  const tot = usable.map(([, r]) => r.stakes.reduce((a, b) => a + b, 0) / 1e6);
  const mean = tot.reduce((a, b) => a + b, 0) / tot.length;
  const disp = usable.map(([, r]) => {
    const s = r.stakes.filter((x) => x > 0);
    if (s.length < 21) return 0;
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    return avg > 0 ? Math.min(...s) / avg : 0;
  }).filter((x) => x > 0);
  const dmean = disp.length ? disp.reduce((a, b) => a + b, 0) / disp.length : 0;
  console.log(`  board net/round: mean $${mean.toFixed(2)} (measured off Round accounts: ~$585 gross → ~$538 net)`);
  console.log(`  emptiest tile / average tile: ${dmean.toFixed(3)} over ${disp.length} full boards`);
  console.log(`  → break-even for a perfect-information single-tile snipe needs < ${(1/(0.92*0.988)).toFixed(3)}`);
  const empties = usable.filter(([, r]) => r.stakes.some((x) => x === 0)).length;
  console.log(`  rounds with at least one EMPTY tile: ${empties}/${usable.length}`);
}
if (usable.length === 0) { console.log("no usable rounds"); process.exit(0); }

// ── cost model ───────────────────────────────────────────────────────────────
const CU_PRICE = 10_000; // micro-lamports/CU; observed floor-ish on this program
const LAM_DEPLOY = 5_000 + (CU_PRICE * cfg.DEPLOY_CU_LIMIT) / 1e6 + cfg.JITO_TIP_LAMPORTS;
const LAM_SETTLE = cfg.SELF_SETTLE ? 5_000 : 0;
const feeUsdPerRound = ((LAM_DEPLOY + LAM_SETTLE) / 1e9) * SOL;

// ── hashrate → epoch value, from the LIVE field ──────────────────────────────
//
// This used to be two constants off epoch iteration 4 — POOL = 46_553 and the
// 157-wallet block list in data/epoch-iteration-4.json — and they were carrying
// the entire farming result. Volume has since fallen ~4.7x, and the two do not
// move together (the pool tracks volume; the field tracks volume TIMES streak),
// so the staleness compounded rather than cancelled. Swapping the pool constant
// alone was worth about $78/day of phantom edge. See `pnpm farming-audit`.
//
// The field is projected to END-of-iteration on a stated entrant count, not
// frozen at whatever has entered so far: with 21 wallet-deduped winner slots,
// entrant count decides a small holder's take far more than ticket share does.
const EXPECTED_ENTRANTS = Number(process.env["EPOCH_ENTRANTS"] ?? 157);
const iterSlots = num(conf.epoch_vault_iteration_duration);
const roundsPerIteration = Math.round(iterSlots / Math.max(1, board.round_duration));
const liveField = await readEpochField({
  connection: conn, programId: pid, btcUsd: prices.btcUsd(),
  iterationSlots: iterSlots, slot: await conn.getSlot("confirmed"),
});

let measured: number[];
let POOL: number;
if (liveField.complete && liveField.progress > 0.05 && liveField.blocks.length > 0) {
  const totalFull = liveField.totalTickets / liveField.progress;
  measured = resampleField(liveField.blocks, EXPECTED_ENTRANTS, totalFull);
  // Banked so far plus the inflow the CURRENT volume rate still implies. Most
  // of the banked figure is rollover carry from earlier, busier iterations, so
  // it is a draining stock rather than a run-rate — do not read it as evidence
  // that volume recovered.
  const meanGross = usable.reduce((a, [, r]) => a + r.gross, 0) / usable.length / 1e6;
  POOL = liveField.poolUsd +
    (1 - liveField.progress) * meanGross * roundsPerIteration * (conf.epoch_fee_bps / 1e4);
  console.log(`epoch field: LIVE iteration ${liveField.iterationId} at ` +
    `${(100 * liveField.progress).toFixed(1)}% → ${Math.round(totalFull).toLocaleString()} tickets ` +
    `projected across ${EXPECTED_ENTRANTS} entrants; pool $${liveField.poolUsd.toFixed(0)} banked ` +
    `→ $${POOL.toFixed(0)} projected at $${meanGross.toFixed(2)}/round`);
} else {
  const req = createRequire(import.meta.url);
  measured = JSON.parse(
    req("node:fs").readFileSync("data/epoch-iteration-4.json", "utf8"),
  ).blocks as number[];
  POOL = 46_553;
  console.log(`epoch field: STALE fallback (iteration 4) — live pages unreadable or ` +
    `iteration too young. Treat every epoch column below as unsourced.`);
}
const fieldTotal = measured.reduce((a: number, b: number) => a + b, 0);
function epochEv(mine: number, trials = 8_000): number {
  const pool = [...measured, mine]; const me = pool.length - 1;
  const total = fieldTotal + mine; let cap = 0;
  for (let t = 0; t < trials; t++) {
    const dead = new Uint8Array(pool.length); let rem = total;
    for (let rank = 0; rank < EPOCH_REWARD_CURVE_BPS.length && rem > 0; rank++) {
      let r = Math.random() * rem, pick = -1;
      for (let i = 0; i < pool.length; i++) {
        if (dead[i]) continue; r -= pool[i] as number; if (r < 0) { pick = i; break; }
      }
      if (pick < 0) break; dead[pick] = 1; rem -= pool[pick] as number;
      if (pick === me) { cap += (EPOCH_REWARD_CURVE_BPS[rank] ?? 0) / 10_000; break; }
    }
  }
  return (cap / trials) * POOL;
}

// ── run the strategies ───────────────────────────────────────────────────────
const ctxFor = (stakes: number[]): EvContext => ({
  predictedStakes: stakes.map((s) => BigInt(Math.round(s))),
  fees, multiplier: 1, semantics: "raw",
});

/** Actual realised payout for an allocation, given the tile that won. */
function realised(stakes: number[], alloc: bigint[], winner: number): number {
  const mine = Number(alloc[winner] ?? 0n);
  if (mine <= 0) return 0;
  const net = mine * (1 - fees.deployFeeBps / 1e4);
  const others = stakes[winner] ?? 0;
  const potBase = stakes.reduce((a, b) => a + b, 0) + alloc.reduce((a, b) => a + Number(b), 0)
    * (1 - fees.deployFeeBps / 1e4);
  const pot = potBase * (1 - (fees.satsVaultRoundBps / 1e4) * (fees.satsVaultClaimBps / 1e4));
  return others + net <= 0 ? 0 : (pot * net) / (others + net);
}

// ── strategies ───────────────────────────────────────────────────────────────
//
// Every strategy is scored on the SAME rounds with the SAME cost model, and
// each one carries its own streak. That last part is the whole tension: a
// strategy that skips a round resets its counter to 1, so abstention protects
// board P&L and destroys hashrate accrual at the same time. Crediting the
// epoch channel to the farming variants only — as the first cut did — hid it.
//
// Strike is credited as a flat +274 bps of gross to deploying strategies
// (294 bps leg x the 0.70 payout fraction). An approximation: the real thing
// is a ~1/1440 jackpot to the winning tile, so it is lumpy, but its expectation
// is stake-keyed and identical for every strategy per dollar deployed.
const STRIKE_RECOVERY = (conf.strike_fee_bps / 1e4) * STRIKE_PAYOUT_FRACTION;

/** Deferred-hashrate uplift. Value and provenance live in facts.ts. The promo
 * bonus is NOT in here — it is applied per round inside `a.raw`. */
const UNCLAIMED_UPLIFT = UNCLAIMED_HASHRATE_UPLIFT.value;
const MIN_BASE = BigInt(num(conf.min_deploy_usd_amount));

interface Strategy {
  name: string;
  /** Return the allocation for this round, or null to sit out. */
  decide: (ctx: EvContext, stakes: number[], inPromo: boolean) => bigint[] | null;
}
const flat = (total: bigint, tiles: number[]): bigint[] => {
  const a = new Array<bigint>(TILES_COUNT).fill(0n);
  const per = total / BigInt(tiles.length);
  for (const t of tiles) a[t] = per;
  return a;
};
const ALL_TILES = Array.from({ length: TILES_COUNT }, (_, i) => i);
const emptiest = (stakes: number[]): number =>
  stakes.reduce((best, v, i) => (v < (stakes[best] ?? Infinity) ? i : best), 0);

const STRATEGIES: Strategy[] = [
  {
    name: "snipe",
    decide: (ctx) => {
      const pick = selectAllocation(ctx, {
        strategy: "water_filling", maxPerRound: 25_000_000n, minDeploy: MIN_BASE,
        ladder: [1_000_000n], minEdgeBps: cfg.MIN_EDGE_BPS, kEmptiest: cfg.K_EMPTIEST,
      });
      return pick.kind === "deploy" ? pick.allocation : null;
    },
  },
  {
    // Same selector, but never sits out: pads to the minimum on a skip so the
    // streak survives. Isolates exactly what abstention costs in hashrate.
    name: "snipe+present",
    decide: (ctx, stakes) => {
      const pick = selectAllocation(ctx, {
        strategy: "water_filling", maxPerRound: 25_000_000n, minDeploy: MIN_BASE,
        ladder: [1_000_000n], minEdgeBps: cfg.MIN_EDGE_BPS, kEmptiest: cfg.K_EMPTIEST,
      });
      return pick.kind === "deploy" ? pick.allocation : flat(MIN_BASE, [emptiest(stakes)]);
    },
  },
  { name: "blanket", decide: () => flat(21_000_000n, ALL_TILES) },
  { name: "farm-21", decide: () => flat(MIN_BASE, ALL_TILES) },
  // One tile earns 21 raw/$ of "skill" hashrate against the blanket's 1, so at
  // low streak it accrues far faster — at the cost of board variance.
  { name: "farm-1", decide: (_c, stakes) => flat(MIN_BASE, [emptiest(stakes)]) },
  { name: "promo-only", decide: (_c, stakes, inPromo) => (inPromo ? flat(MIN_BASE, [emptiest(stakes)]) : null) },
];

interface Acc { pnl: number; deploys: number; volume: number; raw: number; streak: number }
const acc = new Map<string, Acc>(
  STRATEGIES.map((s) => [s.name, { pnl: 0, deploys: 0, volume: 0, raw: 0, streak: 1 }]),
);

for (const [rid, r] of usable) {
  const winner = r.winner as number;
  const ctx = ctxFor(r.stakes);
  // Promo windows are ~17% of rounds; without the strike history in this window
  // we approximate with a deterministic 241-of-1440 cycle on round id.
  const inPromo = rid % 1440 < 241;

  for (const st of STRATEGIES) {
    const a = acc.get(st.name) as Acc;
    const alloc = st.decide(ctx, r.stakes, inPromo);
    if (alloc === null) { a.streak = 1; continue; }   // a missed round resets it
    const gross = alloc.reduce((x, y) => x + Number(y), 0);
    if (gross <= 0) { a.streak = 1; continue; }
    const tiles = alloc.filter((x) => x > 0n).length;
    a.pnl += realised(r.stakes, alloc, winner) + gross * STRIKE_RECOVERY - gross - feeUsdPerRound * 1e6;
    a.deploys++; a.volume += gross;
    a.raw += (gross / 1e6) * (Math.min(a.streak, 100) + TILES_COUNT / tiles) * (inPromo ? 2 : 1);
    a.streak++;
  }
}

const perDay = 1440 / usable.length;
const ITER = roundsPerIteration;
console.log(`\nbacktest over ${usable.length} rounds (${(usable.length / 1440).toFixed(2)} days)`);
console.log(`SOL $${SOL.toFixed(2)}   fee $${feeUsdPerRound.toFixed(5)}/round   ` +
  `strike credited flat at ${(STRIKE_RECOVERY * 1e4).toFixed(0)} bps\n`);
console.log("  strategy        fires   volume    board$   end streak   tickets/iter   epoch$/iter    NET $/day");
for (const st of STRATEGIES) {
  const a = acc.get(st.name) as Acc;
  const board = a.pnl / 1e6;
  const rawPerIter = (a.raw / usable.length) * ITER * UNCLAIMED_UPLIFT;
  const tickets = Math.floor(rawPerIter / 100);
  const epoch = tickets > 0 ? epochEv(tickets) : 0;
  const net = board * perDay + (epoch / 3);
  console.log(
    `  ${st.name.padEnd(14)}  ${String(a.deploys).padStart(5)}   ` +
      `$${(a.volume / 1e6).toFixed(0).padStart(6)}   ${("$" + board.toFixed(2)).padStart(9)}   ` +
      `${String(a.streak).padStart(10)}   ${tickets.toLocaleString().padStart(12)}   ` +
      `${("$" + epoch.toFixed(0)).padStart(11)}   ${(net >= 0 ? "+" : "") + "$" + net.toFixed(2)}`,
  );
}
console.log("\n  NET = board P&L scaled to a day + the epoch take the round's hashrate buys,");
console.log("  spread over the 3-day iteration. Fires shows how often each strategy acted.");
void evOfAllocation;
