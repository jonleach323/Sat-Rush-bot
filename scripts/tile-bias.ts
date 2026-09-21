/**
 * Is any tile systematically cheap?
 *
 * The board is uniform by construction — the winner is drawn from slot-hash
 * entropy, so every tile pays 1/21 regardless. But the STAKE on each tile is
 * chosen by players, and a large share of it comes from automations running
 * fixed masks. If those masks consistently exclude the same tiles, those tiles
 * carry less stake every round and are structurally underpriced, which is an
 * edge that needs no prediction at all: just always deploy there.
 *
 * The alternative, and the null this tests against, is that masks are varied
 * or random enough that stake spreads evenly and the only edge is round-by-
 * round noise — in which case the selector's existing water-filling is already
 * capturing everything available and there is nothing structural to add.
 *
 * Reports per-tile mean stake share against the 1/21 = 4.762% a fair board
 * gives, a chi-square on the totals, and the payoff of blindly holding the
 * cheapest tile every round.
 *
 *   pnpm tile-bias [rounds]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";
import { decodeAccount, type Board } from "../src/adapter/idl.js";
import { parseCpiEventData } from "../src/ingest/events.js";
import { boardPda, roundPda } from "../src/adapter/pdas.js";
import { TILES_COUNT } from "../src/strategy/ev.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const ROUNDS = Number(process.argv[2] ?? 400);

const board = decodeAccount<Board>("Board", (await conn.getAccountInfo(boardPda(pid), "confirmed"))!.data);
const ids: number[] = [];
for (let i = 1; i <= ROUNDS; i++) if (board.round_id - i > 0) ids.push(board.round_id - i);

const sigs: string[] = [];
for (let i = 0; i < ids.length; i += 8) {
  await Promise.all(ids.slice(i, i + 8).map(async (id) => {
    const res = await conn.getSignaturesForAddress(roundPda(id, pid), { limit: 1000 }, "confirmed");
    for (const x of res) if (!x.err) sigs.push(x.signature);
  }));
}
console.log(`${sigs.length.toLocaleString()} signatures over ${ids.length} rounds; decoding…`);

const rounds = new Map<number, { stakes: number[]; winner: number | null }>();
/** How often each tile appears in a mask, split by automation. */
const maskCount = [new Array<number>(TILES_COUNT).fill(0), new Array<number>(TILES_COUNT).fill(0)];
let autoDeploys = 0;
let manualDeploys = 0;

for (let i = 0; i < sigs.length; i += 50) {
  const txs = await conn.getTransactions(sigs.slice(i, i + 50), {
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
          const net = Number((d["total_stake_usd_amount"] as { toString(): string }).toString());
          const isAuto = Boolean(d["is_automation"]);
          const tiles: number[] = [];
          for (let t = 0; t < TILES_COUNT; t++) if (mask & (1 << t)) tiles.push(t);
          if (tiles.length === 0) continue;
          if (isAuto) autoDeploys++;
          else manualDeploys++;
          const slot = maskCount[isAuto ? 0 : 1] as number[];
          for (const t of tiles) slot[t] = (slot[t] ?? 0) + 1;
          let r = rounds.get(id);
          if (!r) { r = { stakes: new Array<number>(TILES_COUNT).fill(0), winner: null }; rounds.set(id, r); }
          const per = net / tiles.length;
          for (const t of tiles) r.stakes[t] = (r.stakes[t] ?? 0) + per;
        } else if (e.name === "RoundRevealed") {
          const id = Number(d["round_id"] ?? -1);
          let r = rounds.get(id);
          if (!r) { r = { stakes: new Array<number>(TILES_COUNT).fill(0), winner: null }; rounds.set(id, r); }
          r.winner = Number(d["winning_tile"] ?? -1);
        }
      }
    }
  }
}

const usable = [...rounds.values()].filter(
  (r) => r.winner !== null && r.winner >= 0 && r.stakes.some((s) => s > 0),
);
console.log(`${usable.length} complete rounds\n`);
if (usable.length < 30) { console.log("too few rounds to test"); process.exit(0); }

// ── per-tile share of stake ──────────────────────────────────────────────────
const shareSum = new Array<number>(TILES_COUNT).fill(0);
for (const r of usable) {
  const tot = r.stakes.reduce((a, b) => a + b, 0);
  if (tot <= 0) continue;
  for (let t = 0; t < TILES_COUNT; t++) shareSum[t] = (shareSum[t] ?? 0) + (r.stakes[t] ?? 0) / tot;
}
const shares = shareSum.map((s) => s / usable.length);
const ranked = shares.map((s, t) => ({ t, s })).sort((a, b) => a.s - b.s);

console.log("  per-tile mean share of round stake (fair = 4.762%)");
console.log("  cheapest 5:", ranked.slice(0, 5).map((x) => `t${x.t} ${(100 * x.s).toFixed(3)}%`).join("  "));
console.log("  dearest  5:", ranked.slice(-5).reverse().map((x) => `t${x.t} ${(100 * x.s).toFixed(3)}%`).join("  "));

// Chi-square on total stake, 20 df. 31.4 is the 5% critical value.
const totals = new Array<number>(TILES_COUNT).fill(0);
for (const r of usable) for (let t = 0; t < TILES_COUNT; t++) totals[t] = (totals[t] ?? 0) + (r.stakes[t] ?? 0);
const grand = totals.reduce((a, b) => a + b, 0);
const expected = grand / TILES_COUNT;
const chi2 = totals.reduce((a, o) => a + ((o - expected) ** 2) / expected, 0);
console.log(`\n  chi-square ${chi2.toFixed(1)} on 20 df (5% critical 31.4) → ` +
  (chi2 > 31.4 ? "stake is NOT evenly spread" : "consistent with even spread"));

// ── mask composition ─────────────────────────────────────────────────────────
const auto = maskCount[0] as number[];
const autoRate = auto.map((c) => (autoDeploys > 0 ? c / autoDeploys : 0));
const arRanked = autoRate.map((r, t) => ({ t, r })).sort((a, b) => a.r - b.r);
console.log(`\n  automation deploys ${autoDeploys}, manual ${manualDeploys}`);
console.log("  tiles automations cover LEAST:",
  arRanked.slice(0, 5).map((x) => `t${x.t} ${(100 * x.r).toFixed(1)}%`).join("  "));

// ── does blindly holding the structurally cheapest tile pay? ─────────────────
const cheapest = ranked[0]?.t ?? 0;
let pnl = 0;
const STAKE = 1_000_000;      // $1 gross
const NET = STAKE * 0.92;
for (const r of usable) {
  const others = r.stakes[cheapest] ?? 0;
  const pot = (r.stakes.reduce((a, b) => a + b, 0) + NET) * 0.988;
  pnl += (r.winner === cheapest ? (pot * NET) / (others + NET) : 0) - STAKE;
}
console.log(`\n  always deploying $1 on t${cheapest} (the structurally cheapest):`);
console.log(`    ${(pnl / 1e6 >= 0 ? "+" : "") + "$" + (pnl / 1e6).toFixed(2)} over ${usable.length} rounds ` +
  `= ${((100 * pnl) / (STAKE * usable.length)).toFixed(2)}% of volume`);
console.log(`    (a blanket loses ~6.4%, so beating that is the bar, not beating zero)`);
