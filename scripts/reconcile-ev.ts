/**
 * Did the deploys we actually fired earn what the model said they would?
 *
 * `ev_expected` is recorded at fire time from the EV model; `PublicDeploySettled`
 * records what the chain actually paid. Nothing has ever compared them in bulk,
 * and the aggregate is alarming on its face: 200 recorded deploys totalling $525
 * carry $131.94 of expected EV — a 25% edge on a parimutuel whose blanket toll
 * is 7.05%. Either the bot is finding enormous mispricings, or the model is
 * over-crediting and the fire decision is built on it.
 *
 * Realized value counts BOTH legs. won_usd_amount alone understates every round,
 * because roughly 12% of the pot is paid in sats-vault shares — the same
 * omission that makes the daily P&L read as a loss when it is not. Shares are
 * valued at the live vault ratio, net of the claim fee, since that is what we
 * could actually realise.
 *
 * Deploys come from the monitoring API (the only place ev_expected is kept);
 * settlements come from chain, read off each PublicDeployment PDA — that PDA is
 * unique to (authority, round), so any PublicDeploySettled in its history is
 * ours and no filtering guesswork is involved.
 *
 *   MONITOR_URL=https://… MONITOR_TOKEN=… pnpm reconcile-ev [limit]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";
import {
  decodeAccount, type SatrushConfig, type SatsVault,
} from "../src/adapter/idl.js";
import { publicDeploymentPda, roundPda, satrushConfigPda, satsVaultPda } from "../src/adapter/pdas.js";
import { parseCpiEventData } from "../src/ingest/events.js";
import { PriceFeed } from "../src/ingest/prices.js";
import { blanketToll, feeModelFromConfig, TILES_COUNT } from "../src/strategy/ev.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const num = (v: unknown): number => Number((v as { toString(): string }).toString());
const LIMIT = Number(process.argv[2] ?? 200);

const MONITOR_URL = process.env["MONITOR_URL"];
const MONITOR_TOKEN = process.env["MONITOR_TOKEN"] ?? cfg.API_TOKEN;
if (!MONITOR_URL || !MONITOR_TOKEN) {
  console.error("set MONITOR_URL and MONITOR_TOKEN (or API_TOKEN in .env)");
  process.exit(1);
}

interface DeployRow {
  round_id: number; mask: number; amount: string;
  ev_expected: number | null; status: string; created_at: string;
}
const res = await fetch(`${MONITOR_URL.replace(/\/$/, "")}/api/deploys?limit=${LIMIT}`, {
  headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
});
if (!res.ok) throw new Error(`monitor API ${res.status}`);
const deploys = (await res.json() as DeployRow[]).filter((d) => d.status === "landed");
console.log(`${deploys.length} landed deploys, rounds ` +
  `${Math.min(...deploys.map((d) => d.round_id))}..${Math.max(...deploys.map((d) => d.round_id))}`);

// Whose deploys are these? The settle event carries the authority, so we learn
// it from the data rather than assuming the local keypair matches production.
const [confI, svI] = await Promise.all([
  conn.getAccountInfo(satrushConfigPda(pid), "confirmed"),
  conn.getAccountInfo(satsVaultPda(pid), "confirmed"),
]);
const conf = decodeAccount<SatrushConfig>("SatrushConfig", confI!.data);
const sv = decodeAccount<SatsVault>("SatsVault", svI!.data);
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

// USD a single share is worth to us: vault BTC per share, priced, net of the
// claim fee — the realisable value, not the headline.
const totalShares = num(sv.btc_shares);
const shareUsd = totalShares > 0
  ? (num(sv.btc_amount) / totalShares / 1e8) * prices.btcUsd() *
    (1 - conf.sats_vault_claim_fee_bps / 1e4)
  : 0;
console.log(`share value ${shareUsd.toExponential(3)} USD net of the ` +
  `${conf.sats_vault_claim_fee_bps / 100}% claim fee\n`);

const AUTHORITY = new PublicKey(
  process.env["OPERATOR_WALLET"] ?? "8EHb675bVwz3nrAUssQfdKx8665WjkU5wZcykvqtii5J",
);

interface Settled {
  wonUsd: number; wonShares: number; winningStake: number; hashrate: number;
}
async function settlementFor(roundId: number): Promise<Settled | null> {
  const pda = publicDeploymentPda(AUTHORITY, roundId, pid);
  const sigs = await conn.getSignaturesForAddress(pda, { limit: 20 }, "confirmed");
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
  if (ok.length === 0) return null;
  const txs = await conn.getTransactions(ok, {
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
        if (!e || e.name !== "PublicDeploySettled") continue;
        const d = e.data as Record<string, unknown>;
        if ((d["authority"] as PublicKey | undefined)?.toBase58() !== AUTHORITY.toBase58()) continue;
        if (Number(d["round_id"] ?? -1) !== roundId) continue;
        return {
          wonUsd: num(d["won_usd_amount"]),
          wonShares: num(d["won_shares_amount"]),
          winningStake: num(d["winning_stake"]),
          hashrate: num(d["hashrate_earned"]),
        };
      }
    }
  }
  return null;
}

// Round accounts are rent-reclaimed within a few rounds, so there is nothing to
// read there for anything but the last handful — boards get rebuilt from events
// further down instead. Retry transient RPC failures rather than aborting a
// ten-minute scan on one 500.
interface Row extends DeployRow { settled: Settled | null }
async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch {
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  return null;
}
const rows: Row[] = [];
for (let i = 0; i < deploys.length; i += 8) {
  const out = await Promise.all(deploys.slice(i, i + 8).map(async (d) => ({
    ...d, settled: await withRetry(() => settlementFor(d.round_id)),
  })));
  rows.push(...out);
  process.stdout.write(`\r  ${Math.min(i + 8, deploys.length)}/${deploys.length}…`);
}
console.log("\r                              ");

const scored = rows.filter((r) => r.settled !== null);
const unsettled = rows.length - scored.length;
if (unsettled > 0) {
  console.log(`${unsettled} deploys have no settlement on chain yet — excluded, ` +
    `their rent and winnings are still unclaimed.\n`);
}
if (scored.length === 0) { console.log("nothing to score"); process.exit(0); }

let deployed = 0, wonUsd = 0, wonSharesUsd = 0, evSum = 0;
let winners = 0;
const perRound: { id: number; tiles: number; amt: number; ev: number; real: number }[] = [];
for (const r of scored) {
  const s = r.settled as Settled;
  const amt = Number(r.amount) / 1e6;
  const ev = (r.ev_expected ?? 0) / 1e6;
  const usd = s.wonUsd / 1e6;
  const sh = s.wonShares * shareUsd;
  const real = usd + sh - amt;
  deployed += amt; wonUsd += usd; wonSharesUsd += sh; evSum += ev;
  if (s.wonUsd > 0) winners++;
  let tiles = 0;
  for (let t = 0; t < TILES_COUNT; t++) if (r.mask & (1 << t)) tiles++;
  perRound.push({ id: r.round_id, tiles, amt, ev, real });
}

const realized = wonUsd + wonSharesUsd - deployed;

// ── how much of this is signal? ─────────────────────────────────────────────
// A single-tile deploy pays roughly 21x at p = 1/21, so per-bet SD is about 4x
// the stake and the sample mean converges glacially. Reporting a realized
// percentage without this is how a -25% draw from a -11% distribution gets
// written up as a finding. Compute the standard error and refuse to call the
// result anything until it clears it.
const singleBets = perRound.filter((p) => p.tiles === 1);
const P_WIN = 1 / TILES_COUNT;
// Payoff multiple on a win, from the observed tile-vs-average ratio.
const payoffMult = (1 - fees.deployFeeBps / 1e4) *
  (1 - (fees.satsVaultRoundBps / 1e4) * (fees.satsVaultClaimBps / 1e4)) * TILES_COUNT;
const sdPerDollar = Math.sqrt(P_WIN * (1 - P_WIN)) * payoffMult;
const sumSq = singleBets.reduce((a, b) => a + b.amt * b.amt, 0);
const stdErr = sdPerDollar * Math.sqrt(sumSq);
const toll = blanketToll(fees, conf.strike_fee_bps);
console.log(`scored ${scored.length} settled deploys`);
console.log(`  deployed          $${deployed.toFixed(2)}`);
console.log(`  won USD           $${wonUsd.toFixed(2)}`);
console.log(`  won shares        $${wonSharesUsd.toFixed(2)}  (net of claim fee)`);
console.log(`  ─────────────────────────────`);
console.log(`  REALIZED          ${(realized >= 0 ? "+" : "-")}$${Math.abs(realized).toFixed(2)}` +
  `   = ${(100 * realized / deployed).toFixed(2)}% of volume`);
console.log(`  MODEL SAID        +$${evSum.toFixed(2)}   = ${(100 * evSum / deployed).toFixed(2)}% of volume`);
console.log(`  gap               ${(realized - evSum >= 0 ? "+" : "-")}$${Math.abs(realized - evSum).toFixed(2)}`);
console.log(`\n  a blanket over the same volume: -$${(toll * deployed).toFixed(2)} ` +
  `(-${(100 * toll).toFixed(2)}%) — that is the bar, not zero`);
console.log(`  rounds where we held the winning tile: ${winners}/${scored.length} ` +
  `(${(100 * winners / scored.length).toFixed(1)}%, chance is ${(100 / TILES_COUNT).toFixed(2)}%)`);

if (singleBets.length > 0 && stdErr > 0) {
  const singleReal = singleBets.reduce((a, b) => a + b.real, 0);
  const singleVol = singleBets.reduce((a, b) => a + b.amt, 0);
  const zBlanket = (singleReal - -toll * singleVol) / stdErr;
  console.log(`\n  IS THIS SIGNAL? ${singleBets.length} single-tile bets, $${singleVol.toFixed(2)} volume`);
  console.log(`    per-bet SD is ${sdPerDollar.toFixed(2)}x the stake (pays ~${payoffMult.toFixed(1)}x at p=1/${TILES_COUNT})`);
  console.log(`    standard error on the total: +/-$${stdErr.toFixed(2)}`);
  console.log(`    realized $${singleReal.toFixed(2)} vs a blanket's $${(-toll * singleVol).toFixed(2)} → z = ${zBlanket.toFixed(2)}`);
  console.log(`    ${Math.abs(zBlanket) < 2
    ? "NOT SIGNIFICANT — this sample cannot distinguish the two. Do not draw a"
    : "significant at 2 sigma — the difference is real, but check the"}`);
  console.log(`    ${Math.abs(zBlanket) < 2
    ? "conclusion about edge from realized P&L here; use the prediction error below."
    : "prediction error below for the mechanism."}`);
  const need = Math.ceil(Math.pow((2 * sdPerDollar) / Math.max(1e-9, Math.abs(realized / deployed)), 2));
  console.log(`    bets needed to resolve an effect this size at 2 sigma: ~${need.toLocaleString()}`);
}

// ── what did the model have to BELIEVE? ─────────────────────────────────────
// The EV function itself is exact (verified against closed form), so a wrong
// ev_expected means wrong predictedStakes. Round accounts are rent-reclaimed
// within a few rounds, so the board has to be rebuilt from PublicDeployCreated
// on a sample. For a single-tile deploy the EV equation inverts cleanly, so
// back-solve the tile stake the model must have seen and compare it with what
// the tile actually held. That separates "the model is broken" from "the model
// was fed a board that never existed".
const SAMPLE = Number(process.env["SAMPLE_ROUNDS"] ?? 30);
const singles = scored.filter((r) => {
  let n = 0;
  for (let t = 0; t < TILES_COUNT; t++) if (r.mask & (1 << t)) n++;
  return n === 1 && (r.ev_expected ?? 0) !== 0;
}).slice(0, SAMPLE);

async function rebuildBoard(roundId: number): Promise<number[] | null> {
  const sigs = (await withRetry(() =>
    conn.getSignaturesForAddress(roundPda(roundId, pid), { limit: 1000 }, "confirmed"))) ?? [];
  const ok = sigs.filter((x) => !x.err).map((x) => x.signature);
  if (ok.length === 0) return null;
  const stakes = new Array<number>(TILES_COUNT).fill(0);
  for (let i = 0; i < ok.length; i += 50) {
    const txs = (await withRetry(() => conn.getTransactions(ok.slice(i, i + 50), {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
    }))) ?? [];
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
          for (const t of tiles) stakes[t] = (stakes[t] as number) + net / tiles.length;
        }
      }
    }
  }
  return stakes.some((x) => x > 0) ? stakes : null;
}

if (singles.length > 0) {
  console.log(`\n  rebuilding ${singles.length} boards from events to back-solve the model…`);
  const NETF = 1 - fees.deployFeeBps / 1e4;
  const POTF = 1 - (fees.satsVaultRoundBps / 1e4) * (fees.satsVaultClaimBps / 1e4);
  let believedSum = 0, actualSum = 0, avgSum = 0, n = 0;
  for (let i = 0; i < singles.length; i += 4) {
    const out = await Promise.all(singles.slice(i, i + 4).map(async (r) => ({
      r, stakes: await rebuildBoard(r.round_id),
    })));
    for (const { r, stakes } of out) {
      if (!stakes) continue;
      const tile = Math.round(Math.log2(r.mask & -r.mask));
      const total = stakes.reduce((a, b) => a + b, 0);
      if (!(total > 0)) continue;
      const gross = Number(r.amount) / 1e6;
      const ev = (r.ev_expected ?? 0) / 1e6;
      const net = gross * NETF;
      // EV = pot*net/((S+net)*21) - gross  →  solve for S.
      const payout = (ev + gross) * TILES_COUNT;
      const pot = (total + net) * POTF;
      const believed = payout > 0 ? (pot * net) / payout - net : NaN;
      if (!Number.isFinite(believed)) continue;
      believedSum += Math.max(0, believed);
      actualSum += stakes[tile] as number;
      avgSum += total / TILES_COUNT;
      n++;
    }
    process.stdout.write(`\r    ${Math.min(i + 4, singles.length)}/${singles.length}…`);
  }
  console.log("\r                                   ");
  if (n > 0) {
    const bel = believedSum / n, act = actualSum / n, avg = avgSum / n;
    console.log(`  over ${n} rebuilt single-tile rounds:`);
    console.log(`    stake the model priced our tile at   $${bel.toFixed(3)}  ` +
      `(${(100 * bel / avg).toFixed(1)}% of average)`);
    console.log(`    stake the tile ACTUALLY finished at  $${act.toFixed(3)}  ` +
      `(${(100 * act / avg).toFixed(1)}% of average)`);
    console.log(`    board average tile                   $${avg.toFixed(3)}`);
    // This is the LOW-VARIANCE measurement and the one to trust: it is a ratio
    // of stakes, not a draw from a 1-in-21 lottery, so 25 rounds is plenty.
    const trueEdge = (NETF * POTF) / (act / avg) - 1;
    console.log(`\n    A single-tile snipe clears only below ` +
      `${(100 * NETF * POTF).toFixed(1)}% of average. The model priced tiles it`);
    console.log(`    believed were nearly empty; they finished at the board average.`);
    console.log(`    That is a PREDICTION failure, not an arithmetic one.`);
    console.log(`\n    Implied TRUE edge at ${(100 * act / avg).toFixed(1)}% of average: ` +
      `${(100 * trueEdge).toFixed(2)}% per deploy`);
    console.log(`    versus a blanket at ${(-100 * toll).toFixed(2)}%. Trust this over the realized`);
    console.log(`    percentage above — a stake ratio converges, a 1-in-21 payout does not.`);
  }
}

// Wide masks are near-blankets and cannot carry a real edge; if the model
// credits them anyway, that is where the error lives.
console.log(`\n  by mask width:`);
console.log(`    tiles   deploys    volume     model EV      realized     model - real`);
for (const [lo, hi, label] of [[1, 1, "1"], [2, 5, "2-5"], [6, 12, "6-12"],
  [13, 20, "13-20"], [21, 21, "21"]] as [number, number, string][]) {
  const g = perRound.filter((p) => p.tiles >= lo && p.tiles <= hi);
  if (g.length === 0) continue;
  const v = g.reduce((a, b) => a + b.amt, 0);
  const e = g.reduce((a, b) => a + b.ev, 0);
  const rl = g.reduce((a, b) => a + b.real, 0);
  console.log(`    ${label.padStart(5)}   ${String(g.length).padStart(7)}   ` +
    `$${v.toFixed(2).padStart(7)}   ${("+$" + e.toFixed(2)).padStart(9)}   ` +
    `${((rl >= 0 ? "+$" : "-$") + Math.abs(rl).toFixed(2)).padStart(10)}   ` +
    `${((e - rl >= 0 ? "+$" : "-$") + Math.abs(e - rl).toFixed(2)).padStart(12)}`);
}
