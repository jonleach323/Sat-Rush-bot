/**
 * Completed epoch iterations, recovered from transaction history.
 *
 * Account state cannot answer this. Once an iteration settles and its winners
 * claim, the EpochVaultIteration and every EpochVaultEntry are closed and
 * rent-reclaimed — on mainnet only the LIVE iteration exists on chain. So any
 * model built purely from account reads is necessarily built from a partial,
 * in-progress window and extrapolated, which is exactly the weakness worth
 * removing.
 *
 * The events survive in logs. EpochDrawTriggered carries the pool and the total
 * ticket count AT THE DRAW — no projection needed — and EpochWinnerSelected
 * carries each winner with the ticket block they held, which is the ground
 * truth for how per-wallet dedup actually resolved.
 *
 *   pnpm epoch-history [signature-limit]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";
import { parseCpiEventData } from "../src/ingest/events.js";
import { epochVaultPda } from "../src/adapter/pdas.js";

const cfg = loadConfig();
const conn = new Connection(cfg.RPC_HTTP_URL, "confirmed");
const pid = new PublicKey(cfg.PROGRAM_ID);
const usd = (n: number): string => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const num = (v: unknown): number => Number((v as { toString(): string }).toString());

const vault = epochVaultPda(pid);

// The draw that OPENED the live iteration sits at epoch_vault.last_trigger_slot,
// and each earlier draw sits one iteration_duration further back. So rather
// than paging blindly through thousands of ticket-purchase signatures, page the
// (cheap) signature list until it passes each boundary and fetch only the
// transactions that land near one.
const { decodeAccount } = await import("../src/adapter/idl.js");
const { satrushConfigPda } = await import("../src/adapter/pdas.js");
const evInfo = await conn.getAccountInfo(vault, "confirmed");
const confInfo = await conn.getAccountInfo(satrushConfigPda(pid), "confirmed");
if (!evInfo || !confInfo) throw new Error("vault or config unavailable");
const evAcc = decodeAccount<{ iteration_id: number; last_trigger_slot: { toString(): string } }>(
  "EpochVault", evInfo.data);
const confAcc = decodeAccount<{ epoch_vault_iteration_duration: { toString(): string } }>(
  "SatrushConfig", confInfo.data);
const iterDur = num(confAcc.epoch_vault_iteration_duration);
const liveStart = num(evAcc.last_trigger_slot);

// Boundary slots for the live draw and every earlier one we could still reach.
const boundaries: number[] = [];
for (let k = 0; k <= evAcc.iteration_id; k++) boundaries.push(liveStart - k * iterDur);
const oldest = boundaries[boundaries.length - 1] ?? liveStart;
console.log(`live iteration ${evAcc.iteration_id} opened at slot ${liveStart.toLocaleString()}`);
console.log(`iteration duration ${iterDur.toLocaleString()} slots`);
console.log(`looking for draws near slots: ${boundaries.map((b) => b.toLocaleString()).join(", ")}\n`);

// Page the signature list back to the oldest boundary, keeping only signatures
// whose slot sits within a window of one of those boundaries.
const WINDOW = 3_000; // slots — the crank may lag the exact boundary
const sigs: string[] = [];
let before: string | undefined;
let pages = 0;
let reached = Infinity;
while (pages < 40) {
  const page = await conn.getSignaturesForAddress(
    vault,
    { limit: 1000, ...(before ? { before } : {}) },
    "confirmed",
  );
  if (page.length === 0) break;
  pages++;
  for (const s of page) {
    if (s.err) continue;
    if (boundaries.some((b) => Math.abs(s.slot - b) <= WINDOW)) sigs.push(s.signature);
  }
  const last = page[page.length - 1];
  if (!last) break;
  reached = last.slot;
  before = last.signature;
  if (reached <= oldest - WINDOW) break;
  if (page.length < 1000) break;
}
console.log(`paged ${pages}k signatures back to slot ${reached === Infinity ? "?" : reached.toLocaleString()}` +
  ` (oldest boundary ${oldest.toLocaleString()})`);
console.log(`${sigs.length} signatures land near a draw boundary`);

interface Draw { iteration: number; tickets: number; poolUsd: number; poolBtc: number; slot: number }
interface Win { iteration: number; rank: number; winner: string; usd: number; btc: number }
const draws: Draw[] = [];
const wins: Win[] = [];
let scanned = 0;

for (let i = 0; i < sigs.length; i += 25) {
  const batch = sigs.slice(i, i + 25);
  const txs = await conn.getTransactions(batch, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  for (const tx of txs) {
    if (!tx) continue;
    scanned++;
    const found: { name: string; data: Record<string, unknown> }[] = [];
    // emit_cpi! puts the event in inner-instruction DATA, not in the log lines —
    // the program exposes an event-authority PDA, which is the tell. Scanning
    // only `Program data:` lines finds nothing and looks like missing history.
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
    });
    for (const inner of tx.meta?.innerInstructions ?? []) {
      for (const ix of inner.instructions) {
        if (keys.get(ix.programIdIndex)?.toBase58() !== pid.toBase58()) continue;
        let data: Uint8Array;
        try {
          data = bs58.decode(ix.data);
        } catch {
          continue;
        }
        const ev = parseCpiEventData(data, tx.slot, "");
        if (ev) found.push({ name: ev.name, data: ev.data as Record<string, unknown> });
      }
    }
    for (const ev of found) {
      if (ev.name === "EpochDrawTriggered") {
        const d = ev.data;
        draws.push({
          iteration: Number(d["iteration_id"] ?? d["iterationId"] ?? -1),
          tickets: num(d["total_tickets"] ?? d["totalTickets"] ?? 0),
          poolUsd: num(d["pool_usd"] ?? 0) / 1e6,
          poolBtc: num(d["pool_btc"] ?? 0) / 1e8,
          slot: tx.slot,
        });
      } else if (ev.name === "EpochWinnerSelected") {
        const d = ev.data;
        wins.push({
          iteration: Number(d["iteration_id"] ?? -1),
          rank: Number(d["rank"] ?? -1),
          winner: String(d["winner"] ?? ""),
          usd: num(d["won_usd_amount"] ?? 0) / 1e6,
          btc: num(d["won_btc_amount"] ?? 0) / 1e8,
        });
      }
    }
  }
}
console.log(`decoded ${scanned} transactions\n`);

if (draws.length === 0) {
  console.log("No EpochDrawTriggered events in range — RPC history may not reach back far enough.");
  console.log("Retry with a larger limit, or an archive RPC.");
} else {
  console.log("═══ completed draws (MEASURED, no projection) ═══");
  console.log("  iter   total tickets   pool USD      pool BTC     slot");
  for (const d of draws.sort((a, b) => a.iteration - b.iteration)) {
    console.log(
      `  ${String(d.iteration).padStart(4)}   ${d.tickets.toLocaleString().padStart(13)}   ` +
        `${usd(d.poolUsd).padStart(10)}   ${d.poolBtc.toFixed(6).padStart(10)}   ${d.slot}`,
    );
  }
}

if (wins.length > 0) {
  console.log("\n═══ winners per iteration — dedup, verified ═══");
  const byIt = new Map<number, Win[]>();
  for (const w of wins) byIt.set(w.iteration, [...(byIt.get(w.iteration) ?? []), w]);
  for (const [it, ws] of [...byIt.entries()].sort((a, b) => a[0] - b[0])) {
    const uniq = new Set(ws.map((w) => w.winner)).size;
    const paidUsd = ws.reduce((a, w) => a + w.usd, 0);
    const paidBtc = ws.reduce((a, w) => a + w.btc, 0);
    const draw = draws.find((d) => d.iteration === it);
    console.log(
      `\n  iteration ${it}: ${ws.length} winner slots, ${uniq} DISTINCT wallets` +
        `${uniq === ws.length ? "  ✅ no wallet won twice" : "  ⚠ repeat winner"}`,
    );
    if (draw) {
      console.log(`    tickets at draw ${draw.tickets.toLocaleString()}` +
        `   pool ${usd(draw.poolUsd)} + ${draw.poolBtc.toFixed(6)} BTC`);
    }
    console.log(`    paid out ${usd(paidUsd)} + ${paidBtc.toFixed(6)} BTC`);
    const top = [...ws].sort((a, b) => a.rank - b.rank).slice(0, 5);
    console.log(`    top ranks: ${top.map((w) => `#${w.rank} ${usd(w.usd)}`).join("  ")}`);
    // The reward curve, as actually paid.
    if (paidUsd > 0) {
      const shares = [...ws].sort((a, b) => a.rank - b.rank)
        .map((w) => Math.round(10_000 * w.usd / paidUsd));
      console.log(`    realised curve (bps of paid): ${shares.slice(0, 8).join(", ")}${shares.length > 8 ? " …" : ""}`);
    }
  }

  // Cross-iteration: how concentrated is the winner set?
  const all = new Map<string, number>();
  for (const w of wins) all.set(w.winner, (all.get(w.winner) ?? 0) + 1);
  const repeat = [...all.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  console.log(`\n  across ${byIt.size} iterations: ${all.size} distinct winners, ` +
    `${repeat.length} won in more than one`);
  if (repeat.length > 0) {
    console.log(`    most frequent: ${repeat.slice(0, 5).map(([k, c]) => `${k.slice(0, 6)}… x${c}`).join(", ")}`);
  }
}
