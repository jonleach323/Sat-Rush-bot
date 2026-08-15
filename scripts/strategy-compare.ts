/**
 * Head-to-head strategy backtest on RECONSTRUCTED boards, all costs included.
 *
 * Every strategy claim in this repo so far has been argued from one channel in
 * isolation — the board toll here, the epoch pool there — and never scored
 * against the others on the same rounds with the same fee model. This does
 * that, on real historical boards, so the comparison is decided by data rather
 * than by whichever channel was most recently analysed.
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
import { loadConfig } from "../src/config.js";
import { decodeAccount, type Board, type SatrushConfig } from "../src/adapter/idl.js";
import { parseCpiEventData } from "../src/ingest/events.js";
import { boardPda, satrushConfigPda } from "../src/adapter/pdas.js";
import { PriceFeed } from "../src/ingest/prices.js";
import { EPOCH_REWARD_CURVE_BPS } from "../src/strategy/vault.js";
import { evOfAllocation, feeModelFromConfig, TILES_COUNT, type EvContext } from "../src/strategy/ev.js";
import { selectAllocation } from "../src/strategy/selector.js";

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
const bpda = boardPda(pid);
const sigs: { sig: string; slot: number }[] = [];
let before: string | undefined;
const wantSlots = ROUNDS_WANTED * board.round_duration;
const headSlot = await conn.getSlot("confirmed");
while (sigs.length < 60_000) {
  const page = await conn.getSignaturesForAddress(
    bpda, { limit: 1000, ...(before ? { before } : {}) }, "confirmed",
  );
  if (page.length === 0) break;
  for (const s of page) if (!s.err) sigs.push({ sig: s.signature, slot: s.slot });
  const last = page[page.length - 1];
  if (!last) break;
  before = last.signature;
  if (headSlot - last.slot > wantSlots) break;
  if (page.length < 1000) break;
}
console.log(`${sigs.length.toLocaleString()} board signatures; decoding…`);

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
if (usable.length === 0) { console.log("no usable rounds"); process.exit(0); }

// ── cost model ───────────────────────────────────────────────────────────────
const CU_PRICE = 10_000; // micro-lamports/CU; observed floor-ish on this program
const LAM_DEPLOY = 5_000 + (CU_PRICE * cfg.DEPLOY_CU_LIMIT) / 1e6 + cfg.JITO_TIP_LAMPORTS;
const LAM_SETTLE = cfg.SELF_SETTLE ? 5_000 : 0;
const feeUsdPerRound = ((LAM_DEPLOY + LAM_SETTLE) / 1e9) * SOL;

// ── hashrate → epoch value, from the measured field ──────────────────────────
const req = createRequire(import.meta.url);
const measured: number[] = JSON.parse(
  req("node:fs").readFileSync("data/epoch-iteration-4.json", "utf8"),
).blocks;
const fieldTotal = measured.reduce((a: number, b: number) => a + b, 0);
const POOL = 46_553;
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

const SIZES = { snipe: 25_000_000n, blanket: 21_000_000n, farm: 1_000_000n }; // base units
const results: Record<string, { pnl: number; deploys: number; volume: number }> = {
  snipe: { pnl: 0, deploys: 0, volume: 0 },
  blanket: { pnl: 0, deploys: 0, volume: 0 },
  farm: { pnl: 0, deploys: 0, volume: 0 },
};
let farmRaw = 0;

for (const [, r] of usable) {
  const winner = r.winner as number;
  const ctx = ctxFor(r.stakes);

  // 1. SNIPE — the live selector, gated by MIN_EDGE_BPS.
  const pick = selectAllocation(ctx, {
    strategy: "water_filling", maxPerRound: SIZES.snipe, minDeploy: BigInt(num(conf.min_deploy_usd_amount)),
    ladder: [1_000_000n], minEdgeBps: cfg.MIN_EDGE_BPS, kEmptiest: cfg.K_EMPTIEST,
  });
  if (pick.kind === "deploy") {
    const gross = Number(pick.totalGross);
    results.snipe!.pnl += realised(r.stakes, pick.allocation, winner) - gross - feeUsdPerRound * 1e6;
    results.snipe!.deploys++; results.snipe!.volume += gross;
  }

  // 2. BLANKET — every round, all 21 tiles, even split.
  const per = SIZES.blanket / 21n;
  const bAlloc = new Array<bigint>(TILES_COUNT).fill(per);
  results.blanket!.pnl += realised(r.stakes, bAlloc, winner) - Number(SIZES.blanket) - feeUsdPerRound * 1e6;
  results.blanket!.deploys++; results.blanket!.volume += Number(SIZES.blanket);

  // 3. FARM — minimum size every round, blanket, valued for the hashrate it earns.
  const fPer = SIZES.farm / 21n;
  const fAlloc = new Array<bigint>(TILES_COUNT).fill(fPer);
  results.farm!.pnl += realised(r.stakes, fAlloc, winner) - Number(SIZES.farm) - feeUsdPerRound * 1e6;
  results.farm!.deploys++; results.farm!.volume += Number(SIZES.farm);
  farmRaw += (Number(SIZES.farm) / 1e6) * 101 * 0.65; // streak 100, blanket, liquid
  void evOfAllocation;
}

const perDay = 1440 / usable.length;
console.log(`\nbacktest over ${usable.length} rounds (${(usable.length / 1440).toFixed(2)} days)`);
console.log(`SOL $${SOL.toFixed(2)}   fee/round/wallet $${feeUsdPerRound.toFixed(5)} ` +
  `(${LAM_DEPLOY.toLocaleString()} + ${LAM_SETTLE.toLocaleString()} lamports)\n`);
console.log("  strategy    deploys   volume        board P&L     fees      net/day");
for (const [name, r] of Object.entries(results)) {
  const feeTotal = r.deploys * feeUsdPerRound;
  console.log(
    `  ${name.padEnd(10)}  ${String(r.deploys).padStart(7)}   ` +
      `$${(r.volume / 1e6).toFixed(0).padStart(8)}   ${("$" + (r.pnl / 1e6).toFixed(2)).padStart(11)}   ` +
      `${("$" + feeTotal.toFixed(2)).padStart(7)}   ` +
      `${((r.pnl / 1e6) * perDay >= 0 ? "+" : "") + "$" + ((r.pnl / 1e6) * perDay).toFixed(2)}`,
  );
}

// Farm's epoch credit, scaled to a full iteration.
const rawPerIteration = (farmRaw / usable.length) * 4320;
const ticketsPerIteration = Math.floor(rawPerIteration / 100);
const epochTake = epochEv(ticketsPerIteration);
const farmBoardPerIteration = (results.farm!.pnl / 1e6 / usable.length) * 4320;
console.log(`\n  farm, full epoch accounting (4,320-round iteration):`);
console.log(`    tickets earned   ${ticketsPerIteration.toLocaleString()}`);
console.log(`    epoch take       $${epochTake.toFixed(2)}`);
console.log(`    board + fees     $${farmBoardPerIteration.toFixed(2)}`);
console.log(`    NET              ${(epochTake + farmBoardPerIteration >= 0 ? "+" : "")}$${(epochTake + farmBoardPerIteration).toFixed(2)} per iteration ` +
  `= $${((epochTake + farmBoardPerIteration) / 3).toFixed(2)}/day`);
