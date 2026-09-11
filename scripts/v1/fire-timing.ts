/**
 * Was the tile cheap when we fired, or did we only think it was?
 *
 * The model prices our chosen tile at ~68% of the board average and it settles
 * at ~102%. That is the whole input error, and there are three candidate causes
 * which need completely different fixes:
 *
 *   A. COLLISION      the tile really was cheap at fire time, and rival snipers
 *                     computing the same "emptiest tile" landed on it after us.
 *                     Fix: stop being predictable, or predict them.
 *   B. MISREAD        the tile was never cheap; ingest was missing deploys that
 *                     had already landed. Fix: the ingest path.
 *   C. UNIFORM LATE   everything filled in after us at the same rate, so our
 *                     tile's RATIO stayed put and only the total moved.
 *                     Fix: sizing, not selection — selection was fine.
 *
 * The three are separable from history alone, because every deploy carries the
 * slot it landed in. Bucket each round's deploys against OUR landing slot and
 * the board at fire time is recoverable exactly, no instrumentation required.
 *
 *   ratio_at_fire ~ 68%  and ratio_at_settle ~ 102%   → A, collision
 *   ratio_at_fire ~ 100%                              → B, we misread the board
 *   ratio_at_fire ~ ratio_at_settle, total grew       → C, sizing
 *
 * Also reports whether late inflow onto OUR tile exceeds late inflow onto the
 * average tile, which is the direct signature of A.
 *
 *   MONITOR_URL=… MONITOR_TOKEN=… pnpm fire-timing [rounds]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../../src/config.js";
import { decodeAccount, type SatrushConfig } from "../../src/adapter/idl.js";
import { roundPda, satrushConfigPda } from "../../src/adapter/pdas.js";
import { parseCpiEventData } from "../../src/ingest/events.js";
import { blanketToll, feeModelFromConfig, TILES_COUNT } from "../../src/strategy/ev.js";
import { formatEstimate, significant, type Estimate } from "../../src/strategy/facts.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const num = (v: unknown): number => Number((v as { toString(): string }).toString());
const WANT = Number(process.argv[2] ?? 60);

const MONITOR_URL = process.env["MONITOR_URL"];
const MONITOR_TOKEN = process.env["MONITOR_TOKEN"] ?? cfg.API_TOKEN;
if (!MONITOR_URL || !MONITOR_TOKEN) {
  console.error("set MONITOR_URL and MONITOR_TOKEN (or API_TOKEN in .env)");
  process.exit(1);
}

const conf = decodeAccount<SatrushConfig>(
  "SatrushConfig", (await conn.getAccountInfo(satrushConfigPda(pid), "confirmed"))!.data);
const fees = feeModelFromConfig(conf);
const NETF = 1 - fees.deployFeeBps / 1e4;
const POTF = 1 - (fees.satsVaultRoundBps / 1e4) * (fees.satsVaultClaimBps / 1e4);
/** A single-tile snipe clears only below this fraction of the board average. */
const BREAK_EVEN_RATIO = NETF * POTF;

interface DeployRow {
  round_id: number; mask: number; amount: string;
  ev_expected: number | null; status: string; fired_slot: number | null;
  landed_slot: number | null;
}
const res = await fetch(`${MONITOR_URL.replace(/\/$/, "")}/api/deploys?limit=300`, {
  headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
});
if (!res.ok) throw new Error(`monitor API ${res.status}`);
const singles = (await res.json() as DeployRow[])
  .filter((d) => d.status === "landed" && d.landed_slot !== null)
  .filter((d) => {
    let c = 0;
    for (let t = 0; t < TILES_COUNT; t++) if (d.mask & (1 << t)) c++;
    return c === 1;
  })
  .slice(0, WANT);

console.log(`${singles.length} single-tile deploys with a landing slot`);
console.log(`break-even for a single-tile snipe: below ` +
  `${(100 * BREAK_EVEN_RATIO).toFixed(1)}% of the board average\n`);

async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 400 * 2 ** i)); }
  }
  return null;
}

/** Per-tile net stake, split into what landed before our slot and after. */
async function boardSplit(roundId: number, ourSlot: number): Promise<{
  before: number[]; after: number[]; ourDeploys: number; lateDeploys: number;
} | null> {
  const sigs = (await retry(() => conn.getSignaturesForAddress(
    roundPda(roundId, pid), { limit: 1000 }, "confirmed"))) ?? [];
  const ok = sigs.filter((s) => !s.err);
  if (ok.length === 0) return null;
  const before = new Array<number>(TILES_COUNT).fill(0);
  const after = new Array<number>(TILES_COUNT).fill(0);
  let early = 0, late = 0;
  for (let i = 0; i < ok.length; i += 50) {
    const txs = (await retry(() => conn.getTransactions(
      ok.slice(i, i + 50).map((s) => s.signature),
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))) ?? [];
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
          if (!e || e.name !== "PublicDeployCreated") continue;
          const d = e.data as Record<string, unknown>;
          if (Number(d["round_id"] ?? -1) !== roundId) continue;
          const mask = Number(d["selection_mask"] ?? 0);
          const net = num(d["total_stake_usd_amount"] ?? 0) / 1e6;
          const tiles: number[] = [];
          for (let t = 0; t < TILES_COUNT; t++) if (mask & (1 << t)) tiles.push(t);
          if (tiles.length === 0) continue;
          // STRICTLY before our slot is what we could have seen. A deploy in the
          // same slot is a coin flip we should not credit ourselves with.
          const bucket = tx.slot < ourSlot ? before : after;
          if (tx.slot < ourSlot) early++; else late++;
          for (const t of tiles) bucket[t] = (bucket[t] as number) + net / tiles.length;
        }
      }
    }
  }
  return { before, after, ourDeploys: early, lateDeploys: late };
}

interface Row {
  round: number; tile: number;
  fireRatio: number; settleRatio: number;
  lateOnOurs: number; lateOnAvg: number;
  rankAtFire: number; lateShare: number;
}
const out: Row[] = [];
for (let i = 0; i < singles.length; i += 4) {
  const batch = await Promise.all(singles.slice(i, i + 4).map(async (d) => {
    const split = await boardSplit(d.round_id, d.landed_slot as number);
    if (!split) return null;
    const tile = Math.round(Math.log2(d.mask & -d.mask));
    const totalBefore = split.before.reduce((a, b) => a + b, 0);
    const settle = split.before.map((b, t) => b + (split.after[t] as number));
    const totalSettle = settle.reduce((a, b) => a + b, 0);
    if (!(totalBefore > 0) || !(totalSettle > 0)) return null;
    const avgBefore = totalBefore / TILES_COUNT;
    const avgSettle = totalSettle / TILES_COUNT;
    const lateTotal = totalSettle - totalBefore;
    // Rank of our tile at fire time: 0 = the emptiest.
    const rank = split.before
      .map((v, t) => ({ v, t })).sort((a, b) => a.v - b.v)
      .findIndex((x) => x.t === tile);
    return {
      round: d.round_id, tile,
      fireRatio: (split.before[tile] as number) / avgBefore,
      settleRatio: (settle[tile] as number) / avgSettle,
      lateOnOurs: split.after[tile] as number,
      lateOnAvg: lateTotal / TILES_COUNT,
      rankAtFire: rank,
      lateShare: lateTotal / totalSettle,
    } satisfies Row;
  }));
  out.push(...batch.filter((x): x is Row => x !== null));
  process.stdout.write(`\r  ${Math.min(i + 4, singles.length)}/${singles.length}…`);
}
console.log("\r                                   ");
if (out.length < 5) { console.log("too few rounds reconstructed"); process.exit(0); }

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const est = (xs: number[]): Estimate => {
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1);
  return { value: 100 * m, stderr: 100 * Math.sqrt(v / xs.length), n: xs.length };
};

const fire = est(out.map((r) => r.fireRatio));
const settle = est(out.map((r) => r.settleRatio));
const lateShare = est(out.map((r) => r.lateShare));

console.log(`══ ${out.length} single-tile rounds, board split at our landing slot ══\n`);
console.log(`  our tile / board average AT FIRE     ${formatEstimate(fire, "%")}`);
console.log(`  our tile / board average AT SETTLE   ${formatEstimate(settle, "%")}`);
console.log(`  share of the board that lands AFTER us  ${formatEstimate(lateShare, "%")}`);
console.log(`  our tile's rank at fire (0 = emptiest)  ` +
  `${mean(out.map((r) => r.rankAtFire)).toFixed(1)} of ${TILES_COUNT}`);

// The direct signature of collision: late money preferring OUR tile.
const excess = out.map((r) => r.lateOnOurs - r.lateOnAvg);
const ex = est(excess.map((x, i) => x / Math.max(1e-9, out[i]!.lateOnAvg)));
console.log(`\n  late inflow on our tile vs the average tile  ${formatEstimate(ex, "%")}`);

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n══ VERDICT ══`);
const cheapAtFire = fire.value < 100 * BREAK_EVEN_RATIO;
const targeted = significant(ex, 0) && ex.value > 0;
if (!cheapAtFire) {
  console.log(`  B — MISREAD. Our tile was already at ${fire.value.toFixed(1)}% of average`);
  console.log(`  when we fired, above the ${(100 * BREAK_EVEN_RATIO).toFixed(1)}% break-even. The board we`);
  console.log(`  acted on was not the board that existed. Fix the INGEST path;`);
  console.log(`  no amount of better selection helps if the input is wrong.`);
} else if (targeted) {
  console.log(`  A — COLLISION. The tile was genuinely cheap at ${fire.value.toFixed(1)}% of average,`);
  console.log(`  and late money preferred it by ${ex.value.toFixed(1)}% over the average tile.`);
  console.log(`  Rivals are computing the same emptiest-tile answer. Fix by becoming`);
  console.log(`  unpredictable (widen K_EMPTIEST) or by predicting their pick.`);
} else {
  console.log(`  C — UNIFORM LATE FILL. The tile was cheap at fire (${fire.value.toFixed(1)}%) and late`);
  console.log(`  money did not target it (${formatEstimate(ex, "%")}). The ratio moved because`);
  console.log(`  the whole board filled, which dilutes our stake share without`);
  console.log(`  changing which tile was right. Selection is fine; SIZING against`);
  console.log(`  the predicted FINAL board is what needs fixing.`);
}
console.log(`\n  implied edge at the settle ratio: ` +
  `${(100 * (BREAK_EVEN_RATIO / (settle.value / 100) - 1)).toFixed(2)}% per deploy ` +
  `(a blanket is ${(-100 * blanketToll(fees, conf.strike_fee_bps)).toFixed(2)}%)`);
